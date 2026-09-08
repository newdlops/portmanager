import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { ContainerServiceDiscoveryAdapter, type ContainerServiceDiscoverySession } from "../../src/platform/network/container-service-discovery";
import type { ContainerRuntimeChange } from "../../src/platform/network/container-events-watcher";
import type { ComposeAttachment, ContainerRuntimeSettings, ContainerServiceCandidate } from "../../src/shared/types";

interface RefreshOptions {
  readonly background?: boolean;
  readonly force?: boolean;
  readonly networkIds?: readonly string[];
  readonly sharedRefreshAcquired?: boolean;
  readonly discoverySessions?: Map<string, Promise<ContainerServiceDiscoverySession | undefined>>;
}
interface Runner {
  ownsControlPlaneLease: boolean;
  sidebarVisible: boolean;
  backgroundContainerRefreshInFlight?: Promise<void>;
  containerServiceRefreshInFlight?: Promise<readonly ContainerServiceCandidate[]>;
  composeAttachmentReconcileInFlight?: Promise<void>;
  refreshBackgroundContainerState(): Promise<void>;
  backgroundContainerRefreshIntervalMs(): number;
  refreshContainerServices(options?: RefreshOptions): Promise<readonly ContainerServiceCandidate[]>;
  getContainerDiscoverySession(settings: ContainerRuntimeSettings, sessions?: RefreshOptions["discoverySessions"]): Promise<ContainerServiceDiscoverySession | undefined>;
  handleContainerRuntimeEvent(changes: readonly ContainerRuntimeChange[]): Promise<void>;
  setSidebarVisible(visible: boolean): void;
  reconcileComposeAttachmentPublishedPorts(options: RefreshOptions): Promise<void>;
}

/** Executes the actual service methods with counted platform boundaries, without activating VS Code. */
function extractRunner(globals: Record<string, unknown>): new () => Runner {
  const file = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const service = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "PortManagerNetworkService");
  assert.ok(service);
  const members = [
    "lastContainerServiceRefreshAtMs", "lastComposeAttachmentReconcileAtMs", "lastBackgroundContainerRefreshAtMs",
    "containerServiceRefreshInFlight", "backgroundContainerRefreshInFlight", "composeAttachmentReconcileInFlight",
    "getContainerDiscoverySession", "backgroundContainerRefreshIntervalMs", "refreshBackgroundContainerState",
    "hasBackgroundContainerDiscoveryConsumers", "refreshContainerServices", "refreshContainerServicesExclusive",
    "handleContainerRuntimeEvent", "setSidebarVisible",
  ].map((name) => {
    const member = service.members.find((node) => node.name?.getText(ast) === name);
    assert.ok(member, name);
    return member.getText(ast);
  });
  const helpers = ["isRestorableComposeAttachment", "containerRuntimeSettingsForAttachment", "containerRuntimeChangeNetworkIds"].map((name) => {
    const helper = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(helper, name);
    return helper.getText(ast);
  });
  const constants = ast.statements.filter((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    ["BACKGROUND_CONTAINER_REFRESH_INTERVAL_MS", "EVENT_DRIVEN_CONTAINER_REFRESH_INTERVAL_MS"].includes(declaration.name.getText(ast)),
  )).map((node) => node.getText(ast));
  return vm.runInNewContext(ts.transpileModule(`${constants.join("\n")}\nclass Runner { ${members.join("\n")} }\n${helpers.join("\n")}\nRunner;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { Map, Set, ...globals }) as new () => Runner;
}

function attachment(name: string, runtime: "docker" | "podman" = "docker"): ComposeAttachment {
  return {
    id: name, networkId: name, projectName: name, runtime, status: "attached", attachedAt: "2026-01-01T00:00:00Z",
    composeFiles: [`/workspace/${name}.yaml`],
    ports: [{ serviceName: "db", logicalPort: 5432, actualHostAddress: "127.0.0.1", actualHostPort: 51000, containerPort: 5432, protocol: "tcp" }],
  };
}

function setup() {
  const state = {
    now: 1000, healthyRuntime: "docker" as "docker" | "podman" | undefined,
    settings: { containerRuntime: "auto", containerImage: "unused" } as ContainerRuntimeSettings,
    namespaceRuntime: "docker", denySlot: false, actualPort: 51000,
  };
  const snapshot = {
    composeAttachments: [attachment("alpha"), attachment("beta")],
    networks: [] as { runtimeKind: string }[],
    containerServiceCandidates: [] as readonly ContainerServiceCandidate[],
  };
  const calls = {
    cli: [] as string[], repairs: [] as RefreshOptions[],
    writes: [] as { forceComposeOverrideRefresh?: boolean; networkIds?: readonly string[] }[],
    releases: 0, activity: 0,
  };
  let stamp = -Infinity;
  let locked = false;
  const Service = extractRunner({
    Date: class extends Date { static now() { return state.now; } },
    readContainerRuntimeSettings: () => state.settings,
    tryAcquireSharedBackgroundContainerRefreshSlot: (intervalMs: number) => {
      if (state.denySlot || locked || state.now - stamp < intervalMs) { return undefined; }
      locked = true;
      return () => { calls.releases++; locked = false; stamp = state.now; };
    },
  });
  const runner = Object.assign(new Service(), {
    ownsControlPlaneLease: true, sidebarVisible: true,
    registry: {
      getSnapshot: () => snapshot,
      setContainerServiceCandidates: (candidates: readonly ContainerServiceCandidate[]) => { snapshot.containerServiceCandidates = candidates; },
    },
    containerEventsWatcher: { getRuntime: () => state.healthyRuntime },
    containerRuntime: { getDescriptor: () => ({ id: state.namespaceRuntime }) },
    containerServiceDiscovery: new ContainerServiceDiscoveryAdapter({ runCommand: async (executable, args) => {
      calls.cli.push(`${executable} ${args.join(" ")}`);
      return { stderr: "", stdout: snapshot.composeAttachments.map((item) => JSON.stringify({
        ID: item.id, Names: `${item.projectName}-db`, State: "running", Ports: `127.0.0.1:${state.actualPort}->5432/tcp`,
        Labels: `com.docker.compose.project=${item.projectName},com.docker.compose.service=db,com.docker.compose.project.config_files=${item.composeFiles[0]}`,
      })).join("\n") };
    }}),
    notifyRoutingActivity: () => { calls.activity++; },
    syncContainerEventsWatcher: () => {},
    writeComposeProjectRoutingFile: async (options: { forceComposeOverrideRefresh?: boolean; networkIds?: readonly string[] }) => { calls.writes.push(options); },
  });
  runner.reconcileComposeAttachmentPublishedPorts = async (options) => {
    calls.repairs.push(options);
    for (const item of snapshot.composeAttachments.filter((item) => options.networkIds === undefined || options.networkIds.includes(item.networkId))) {
      const session = await runner.getContainerDiscoverySession({ ...state.settings, containerRuntime: item.runtime ?? "auto" }, options.discoverySessions);
      assert.ok(session);
      assert.equal(session.listLiveComposePublishedPorts(item.projectName, item.composeFiles, item.ports)[0].actualHostPort, state.actualPort);
    }
  };
  return { runner, state, snapshot, calls };
}

test("ten idle minutes with a healthy stream perform two complete snapshots for discovery and routing", async () => {
  const { runner, state, calls } = setup();
  for (let tick = 0; tick < 60; tick++) {
    await runner.refreshBackgroundContainerState();
    state.now += 10000;
  }
  assert.equal(calls.cli.length, 2, "candidate discovery and both explicit Docker attachments must share each auto snapshot");
  assert.equal(calls.repairs.length, 2, "candidate discovery must not consume the slot and starve route reconciliation");
  assert.equal(calls.releases, 2);
});

test("stream failure or uncovered runtimes keep the one-minute polling safety net", async () => {
  const { runner, state, snapshot, calls } = setup();
  state.healthyRuntime = undefined;
  for (let tick = 0; tick < 60; tick++) { await runner.refreshBackgroundContainerState(); state.now += 10000; }
  assert.equal(calls.cli.length, 10);
  state.healthyRuntime = "docker";
  assert.equal(runner.backgroundContainerRefreshIntervalMs(), 300000);
  snapshot.composeAttachments.push(attachment("other", "podman"));
  assert.equal(runner.backgroundContainerRefreshIntervalMs(), 60000);
  snapshot.composeAttachments.pop();
  snapshot.networks.push({ runtimeKind: "container" });
  state.namespaceRuntime = "podman";
  assert.equal(runner.backgroundContainerRefreshIntervalMs(), 60000);
});

test("hidden unused windows, worker windows and an occupied shared slot do not probe Docker", async () => {
  const { runner, snapshot, state, calls } = setup();
  runner.ownsControlPlaneLease = false;
  await runner.refreshBackgroundContainerState();
  runner.ownsControlPlaneLease = true;
  state.denySlot = true;
  await runner.refreshBackgroundContainerState();
  state.denySlot = false;
  runner.sidebarVisible = false;
  snapshot.composeAttachments = [];
  await runner.refreshBackgroundContainerState();
  assert.equal(calls.cli.length, 0);
  assert.equal(calls.repairs.length, 0);
});

test("lifecycle events bypass idle throttling with one fresh snapshot and only repair the affected network", async () => {
  const { runner, state, calls } = setup();
  await runner.refreshBackgroundContainerState();
  state.actualPort = 52000;
  await runner.handleContainerRuntimeEvent([{ runtime: "docker", composeProject: "alpha" }]);
  assert.equal(calls.cli.length, 2);
  assert.deepEqual(Array.from(calls.repairs[1].networkIds ?? []), ["alpha"]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.writes)), [{ forceComposeOverrideRefresh: true, networkIds: ["alpha"] }]);
  assert.equal(calls.repairs[1].background, undefined);
});

test("unrelated projects only refresh a visible candidate list and missing labels conservatively repair the runtime", async () => {
  const { runner, calls } = setup();
  runner.sidebarVisible = false;
  await runner.handleContainerRuntimeEvent([{ runtime: "docker", composeProject: "unrelated" }]);
  assert.equal(calls.cli.length, 0);
  runner.sidebarVisible = true;
  await runner.handleContainerRuntimeEvent([{ runtime: "docker", composeProject: "unrelated" }]);
  assert.equal(calls.cli.length, 1);
  assert.equal(calls.repairs.length, 0);
  assert.equal(calls.writes.length, 0);
  await runner.handleContainerRuntimeEvent([{ runtime: "docker" }]);
  assert.deepEqual(Array.from(calls.repairs[0].networkIds ?? []), ["alpha", "beta"]);
  await runner.handleContainerRuntimeEvent([{ runtime: "podman" }]);
  assert.equal(calls.repairs.length, 1, "a different runtime must not regenerate Docker projects");
});

test("frequent scoped events cannot postpone the full missed-event safety scan", async () => {
  const { runner, state, calls } = setup();
  await runner.refreshBackgroundContainerState();
  for (let minute = 1; minute <= 5; minute++) {
    state.now += 60000;
    await runner.handleContainerRuntimeEvent([{ runtime: "docker", composeProject: "alpha" }]);
    await runner.refreshBackgroundContainerState();
  }
  assert.equal(calls.repairs.filter((options) => options.background).length, 2);
  assert.equal(calls.cli.length, 7);
});

test("events wait for an older poll and take a new snapshot after it completes", async () => {
  const { runner, state, calls } = setup();
  let release!: () => void;
  runner.backgroundContainerRefreshInFlight = new Promise<void>((resolve) => { release = resolve; });
  const event = runner.handleContainerRuntimeEvent([{ runtime: "docker", composeProject: "alpha" }]);
  assert.equal(calls.cli.length, 0);
  state.actualPort = 53000;
  release();
  await event;
  assert.equal(calls.cli.length, 1);
});

test("owner loss during discovery releases the slot without starting route repair", async () => {
  const { runner, calls } = setup();
  runner.refreshContainerServices = async () => { runner.ownsControlPlaneLease = false; return []; };
  await runner.refreshBackgroundContainerState();
  assert.equal(calls.repairs.length, 0);
  assert.equal(calls.releases, 1);
});

test("orphan Compose routes are reconciled without waking Docker in a hidden unused window", async () => {
  const { runner, snapshot, calls } = setup();
  runner.sidebarVisible = false;
  snapshot.composeAttachments = [];
  Object.assign(runner, { processService: { getSnapshot: () => ({ processes: [{ source: "compose" }] }) } });
  await runner.refreshBackgroundContainerState();
  assert.equal(calls.cli.length, 0);
  assert.equal(calls.repairs.length, 1);
  assert.equal(calls.releases, 1);
});

test("clone project events target one clone while original project changes cover all descendants", async () => {
  const { runner, snapshot, calls } = setup();
  snapshot.composeAttachments = snapshot.composeAttachments.map((item) => ({
    ...item,
    mutation: {
      mode: "clone", runtime: "docker", originalProjectName: "workspace", attachedProjectName: `${item.id}-workspace`,
      composeFiles: item.composeFiles, services: ["db"], overrideFile: `/storage/${item.id}.yaml`,
      originalPorts: item.ports, hiddenPorts: item.ports,
      containerMappings: [{ serviceName: "db", originalContainerId: "original123", originalContainerName: "workspace-db",
        attachedContainerId: `${item.id}123`, attachedContainerName: `${item.id}-db` }],
    },
  }));
  await runner.handleContainerRuntimeEvent([{ runtime: "docker", composeProject: "alpha-workspace" }]);
  assert.deepEqual(Array.from(calls.repairs[0].networkIds ?? []), ["alpha"]);
  await runner.handleContainerRuntimeEvent([{ runtime: "docker", composeProject: "workspace" }]);
  assert.deepEqual(Array.from(calls.repairs[1].networkIds ?? []), ["alpha", "beta"]);
  await runner.handleContainerRuntimeEvent([{ runtime: "docker", containerId: "beta123-full-container-id" }]);
  assert.deepEqual(Array.from(calls.repairs[2].networkIds ?? []), ["beta"]);
  await runner.handleContainerRuntimeEvent([{ runtime: "docker", containerId: "unknown-container" }]);
  assert.deepEqual(Array.from(calls.repairs[3].networkIds ?? []), ["alpha", "beta"]);
});

test("reopening the sidebar forces fresh candidates within the five-minute idle window", async () => {
  const { runner, state, calls } = setup();
  await runner.refreshBackgroundContainerState();
  runner.sidebarVisible = false;
  state.actualPort = 54000;
  runner.setSidebarVisible(true);
  await runner.containerServiceRefreshInFlight;
  assert.equal(calls.cli.length, 2);
});

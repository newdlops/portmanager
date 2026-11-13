import assert from "node:assert/strict";
import test from "node:test";
import {
  ContainerServiceDiscoveryAdapter,
  type RuntimeContainerRow,
} from "../../src/platform/network/container-service-discovery";
import type { ContainerCommandResult } from "../../src/platform/network/container-runtime";
import type { ComposeContainerMutationMapping, ComposePublishedPort, ContainerRuntimeSettings } from "../../src/shared/types";

const settings: ContainerRuntimeSettings = { containerRuntime: "docker", containerImage: "unused" };
const composeFiles = ["/workspace/compose.yaml", "/storage/compose-overrides/network-workspace.ports.override.yaml"];
const original: RuntimeContainerRow = {
  ID: "original123",
  Names: "workspace-db-1",
  State: "exited",
  Status: "Exited (0) 2 minutes ago",
  Ports: "",
  Labels: "com.docker.compose.project=workspace,com.docker.compose.service=db," +
    "com.docker.compose.project.config_files=/workspace/compose.yaml,desktop.docker.io/ports/5432/tcp=:15432",
};
const clone: RuntimeContainerRow = {
  ID: "newclone987",
  Names: "network-workspace-db-1",
  State: "running",
  Status: "Up 1 minute",
  Ports: "127.0.0.1:51612->5432/tcp",
  Labels: `com.docker.compose.project=network-workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=${composeFiles.join(",")}`,
};
const ports: readonly ComposePublishedPort[] = [{
  serviceName: "db", logicalPort: 15432, actualHostAddress: "127.0.0.1", actualHostPort: 63816,
  containerPort: 5432, protocol: "tcp",
}];
const mappings: readonly ComposeContainerMutationMapping[] = [{
  serviceName: "db", originalContainerId: "original123", originalContainerName: "workspace-db-1",
  attachedContainerId: "oldclone123", attachedContainerName: "stale-clone-name",
}];

/** Runtime rows are serialized like CLI output so the adapter's actual parsing path is exercised. */
function output(...rows: readonly RuntimeContainerRow[]): ContainerCommandResult {
  return { stdout: rows.map((row) => JSON.stringify(row)).join("\n"), stderr: "" };
}

/** Holds a CLI response open to reproduce overlapping refreshes without timing-dependent sleeps. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("one snapshot preserves stopped attach candidates and clone labels without publishing stopped routes", async () => {
  const calls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (_executable, args) => {
    calls.push([...args]);
    return output(clone, original);
  }});
  const session = await adapter.createSession(settings);
  assert.ok(session);
  assert.deepEqual(calls, [["container", "ls", "-a", "--format", "{{json .}}"]]);
  assert.equal(session.listCandidates().length, 2);
  assert.equal(session.listCandidates().find((candidate) => candidate.containerId === original.ID)?.ports[0].logicalPort, 15432);
  assert.deepEqual(session.listLiveComposePublishedPorts("workspace", [composeFiles[0]], ports), []);
  assert.deepEqual(session.refreshComposePublishedPorts("workspace", [composeFiles[0]], ports), ports);
  const livePorts = session.listLiveComposePublishedPorts("network-workspace", composeFiles, ports);
  assert.equal(livePorts.length, 1);
  assert.equal(livePorts[0].logicalPort, 15432);
  assert.equal(livePorts[0].actualHostPort, 51612);
});

test("all-container snapshots distinguish lifecycle states even when stopped rows retain published ports", async () => {
  let calls = 0;
  const rows: RuntimeContainerRow[] = [
    ...["running", "paused", "restarting", "created", "exited", "dead", "removing"].map((State) => ({
      ID: State, Names: State, State, Ports: "0.0.0.0:16379->6379/tcp",
    })),
    { ID: "legacy-up", Names: "legacy-up", Status: "Up 1 minute (healthy)", Ports: "0.0.0.0:16380->6379/tcp" },
    { ID: "legacy-exited", Names: "legacy-exited", Status: "Exited (0) 1 minute ago", Ports: "0.0.0.0:16381->6379/tcp" },
  ];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async () => {
    calls += 1;
    return output(...rows);
  }});
  const candidates = await adapter.list(settings);
  assert.equal(calls, 1);
  assert.deepEqual(candidates.map((candidate) => candidate.containerId), ["running", "paused", "restarting", "legacy-up"]);
});

test("unknown state retains a live-list fallback and lets newer running endpoints win", async () => {
  const calls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (_executable, args) => {
    calls.push([...args]);
    return args.includes("-a")
      ? output({ ...clone, State: undefined, Status: undefined }, original)
      : output({ ...clone, ID: "recreated123", Ports: "127.0.0.1:51613->5432/tcp" });
  }});
  const session = await adapter.createSession(settings);
  assert.ok(session);
  assert.deepEqual(calls, [
    ["container", "ls", "-a", "--format", "{{json .}}"],
    ["container", "ls", "--format", "{{json .}}"],
  ]);
  assert.equal(session.listCandidates().length, 2);
  assert.equal(session.listLiveComposePublishedPorts("network-workspace", composeFiles, ports)[0].actualHostPort, 51613);
});

test("overlapping refresh entry points share the CLI read and the next refresh observes recreation", async () => {
  const pending = deferred<ContainerCommandResult>();
  let calls = 0;
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async () => {
    calls += 1;
    return calls === 1 ? pending.promise : output({ ...clone, Ports: "127.0.0.1:51613->5432/tcp" }, original);
  }});
  const candidates = adapter.list(settings);
  const livePorts = adapter.listLiveComposePublishedPorts({ ...settings, containerImage: "different" }, "network-workspace", composeFiles, ports);
  const recoveredPorts = adapter.recoverPortManagerClonePorts(settings, composeFiles, [{ ...ports[0], logicalPort: 63816 }]);
  assert.equal(calls, 1);
  pending.resolve(output(clone, original));
  const [listed, live, recovered] = await Promise.all([candidates, livePorts, recoveredPorts]);
  assert.equal(listed.length, 2);
  assert.equal(live[0].actualHostPort, 51612);
  assert.equal(recovered[0].logicalPort, 15432);
  assert.equal(calls, 1);

  const refreshed = await adapter.refreshComposePublishedPorts(settings, "network-workspace", composeFiles, ports);
  assert.equal(calls, 2);
  assert.equal(refreshed[0].actualHostPort, 51613);
});

test("concurrent Docker and Podman reads never share runtime state", async () => {
  const calls: string[] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (executable) => {
    calls.push(executable);
    return output({ ...clone, ID: executable });
  }});
  const [docker, podman] = await Promise.all([
    adapter.list(settings),
    adapter.list({ ...settings, containerRuntime: "podman" }),
  ]);
  assert.deepEqual(calls, ["docker", "podman"]);
  assert.equal(docker[0].id, "docker:docker");
  assert.equal(podman[0].id, "podman:podman");
});

test("overlapping unavailable-daemon reads share failure and fallback, then retry on the next refresh", async () => {
  const calls: string[] = [];
  let dockerUnavailable = true;
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (executable) => {
    calls.push(executable);
    if (executable === "docker" && dockerUnavailable) {
      throw new Error("Cannot connect to the Docker daemon");
    }
    return output(clone, original);
  }});
  const auto: ContainerRuntimeSettings = { ...settings, containerRuntime: "auto" };
  const [first, second] = await Promise.all([adapter.list(auto), adapter.list(auto)]);
  assert.deepEqual(calls, ["docker", "podman"]);
  assert.equal(first[0].runtime, "podman");
  assert.deepEqual(first, second);
  dockerUnavailable = false;
  assert.equal((await adapter.list(auto))[0].runtime, "docker");
  assert.deepEqual(calls, ["docker", "podman", "docker"]);
});

test("empty snapshots need one query and do not keep a later container invisible", async () => {
  let calls = 0;
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async () => {
    calls += 1;
    return calls === 1 ? output() : output(clone);
  }});
  assert.deepEqual(await adapter.list(settings), []);
  assert.equal(calls, 1);
  assert.equal((await adapter.list(settings)).length, 1);
  assert.equal(calls, 2);
});

test("overlapping mapping repairs share a pending inspect and all receive the resolved names", async () => {
  const pending = deferred<ContainerCommandResult>();
  const inspectCalls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (_executable, args) => {
    if (args[1] === "inspect") {
      inspectCalls.push([...args]);
      return pending.promise;
    }
    return output({ ...clone, Names: undefined }, { ...original, Names: undefined });
  }});
  const session = await adapter.createSession(settings);
  assert.ok(session);
  const repair = () => session.refreshComposeContainerMappings("workspace", "network-workspace", composeFiles, ["db"], mappings);
  const first = repair();
  const second = repair();
  assert.deepEqual(inspectCalls, [["container", "inspect", "newclone987", "original123"]]);
  pending.resolve({ stdout: JSON.stringify([
    { Id: "newclone987", Name: "/network-workspace-db-1" },
    { Id: "original123", Name: "/workspace-db-1" },
  ]), stderr: "" });
  const [firstMappings, secondMappings] = await Promise.all([first, second]);
  assert.deepEqual(firstMappings, secondMappings);
  assert.equal(firstMappings[0].attachedContainerName, "network-workspace-db-1");
  assert.equal(firstMappings[0].attachedContainerId, "newclone987");
  assert.deepEqual(await repair(), firstMappings);
  assert.equal(inspectCalls.length, 1);
});

for (const failure of ["unavailable", "missing rows"] as const) {
  test(`inspect ${failure} is retried once per snapshot instead of once per attachment`, async () => {
    let inspectCalls = 0;
    let recovered = false;
    const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (_executable, args) => {
      if (args[1] !== "inspect") {
        return output({ ...clone, Names: undefined }, original);
      }
      inspectCalls += 1;
      if (!recovered && failure === "unavailable") {
        throw new Error("No such container");
      }
      return { stdout: JSON.stringify(recovered ? [{ Id: "newclone987", Name: "/network-workspace-db-1" }] : []), stderr: "" };
    }});
    const session = await adapter.createSession(settings);
    assert.ok(session);
    const repair = () => session.refreshComposeContainerMappings("workspace", "network-workspace", composeFiles, ["db"], mappings);
    await repair();
    await repair();
    assert.equal(inspectCalls, 1);

    recovered = true;
    const next = await adapter.createSession(settings);
    assert.ok(next);
    const refreshed = await next.refreshComposeContainerMappings("workspace", "network-workspace", composeFiles, ["db"], mappings);
    assert.equal(inspectCalls, 2);
    assert.equal(refreshed[0].attachedContainerName, "network-workspace-db-1");
  });
}

const BROKEN_ID = "4fabc7f270b74707fa33d4125e8fd5aec536c29b0f783a4691e0189bd91a411e";
const SECOND_BROKEN_ID = "2df8094cb2570b2ac3427a307d2c3c3a468a2bc7e9d6b83ab51b23afa644ddaf";
const HEALTHY_ID = "5926f6160861aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const healthy: RuntimeContainerRow = {
  ID: "5926f6160861",
  Names: "fundservice-app-1",
  State: "running",
  Status: "Up 1 minute",
  Ports: "127.0.0.1:8775->8000/tcp",
  Labels: "com.docker.compose.project=fundservice,com.docker.compose.service=app",
};

/** Mimics Docker: `ls -a --format json` fails on a corrupt container unless it is excluded via id filters. */
function brokenAwareRunner(brokenIds: readonly string[], calls: string[][] = []) {
  const allIds = [HEALTHY_ID, ...brokenIds];
  return async (_executable: string, args: readonly string[]): Promise<ContainerCommandResult> => {
    calls.push([...args]);
    if (args[1] === "inspect") {
      return { stdout: `/claude-${args[4].slice(0, 4)}\texited\n`, stderr: "" };
    }
    if (args.includes("-q")) {
      return { stdout: allIds.join("\n"), stderr: "" };
    }
    const filtered = args.filter((arg) => arg.startsWith("id=")).map((arg) => arg.slice(3));
    const scanned = filtered.length > 0 ? filtered : allIds;
    const firstBroken = scanned.find((id) => brokenIds.includes(id));
    if (firstBroken !== undefined) {
      throw new Error(`docker ls failed: Error response from daemon: rw layer snapshot not found for container ${firstBroken}`);
    }
    return output(healthy);
  };
}

test("corrupt containers are reported as broken while healthy services stay discoverable", async () => {
  const calls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: brokenAwareRunner([BROKEN_ID, SECOND_BROKEN_ID], calls) });
  const session = await adapter.createSession(settings);
  assert.ok(session);

  assert.deepEqual(session.listCandidates().map((candidate) => candidate.containerName), ["fundservice-app-1"]);
  const broken = session.listBrokenContainers();
  assert.deepEqual(broken.map((container) => container.containerId).sort(), [SECOND_BROKEN_ID, BROKEN_ID].sort());
  assert.equal(broken[0].status, "exited");
  assert.match(broken[0].reason, /rw layer snapshot not found for container/);
  const retry = calls.find((args) => args.includes("--filter"));
  assert.ok(retry?.includes(`id=${HEALTHY_ID}`));
  assert.ok(!retry?.includes(`id=${BROKEN_ID}`));
});

test("listing errors unrelated to corrupt containers still fall through to the next runtime", async () => {
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async () => { throw new Error("Cannot connect to the Docker daemon"); },
  });
  assert.equal(await adapter.createSession(settings), undefined);
});

test("a healthy runtime reports no broken containers", async () => {
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: brokenAwareRunner([]) });
  const session = await adapter.createSession(settings);
  assert.ok(session);
  assert.deepEqual(session.listBrokenContainers(), []);
  assert.equal(session.listCandidates().length, 1);
});

test("removeContainer force-removes exactly the given container id", async () => {
  const calls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (_executable, args) => { calls.push([...args]); return { stdout: "", stderr: "" }; },
  });
  await adapter.removeContainer("docker", BROKEN_ID);
  assert.deepEqual(calls, [["container", "rm", "-f", BROKEN_ID]]);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { LogicalNetworkRegistry, type LogicalNetworkRegistryState } from "../../src/core/networks/logical-network-registry";
import type { ComposeAttachment } from "../../src/shared/types";

interface Runner {
  ownsControlPlaneLease: boolean;
  sharedNetworkRoutingRefreshInFlight?: Promise<void>;
  sharedNetworkComposeRefreshNetworkIds: Set<string>;
  reloadSharedNetworkState(): Promise<void>;
  refreshSharedNetworkRoutingState(): Promise<void>;
  refreshSharedNetworkRoutingStateSerially(): Promise<void>;
}

/** Runs the production document adoption and coalescer against the real registry, isolating only platform side effects. */
function extractRunner(globals: Record<string, unknown>): new () => Runner {
  const file = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const service = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "PortManagerNetworkService");
  assert.ok(service);
  const members = [
    "sharedNetworkStateRevision", "persistedNetworkStateSignature", "applyingSharedNetworkState",
    "sharedNetworkRoutingRefreshInFlight", "sharedNetworkRoutingRefreshQueued", "sharedNetworkComposeRefreshNetworkIds",
    "reloadSharedNetworkState", "refreshSharedNetworkRoutingState", "refreshSharedNetworkRoutingStateSerially",
  ].map((name) => {
    const member = service.members.find((node) => node.name?.getText(ast) === name);
    assert.ok(member, name);
    return member.getText(ast);
  });
  const helpers = ["stringifyPersistedNetworkState", "changedComposeAttachmentNetworkIds", "filterComposeAttachmentsByNetworkIds"].map((name) => {
    const helper = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(helper, name);
    return helper.getText(ast);
  });
  const compiled = ts.transpileModule(`class Runner { ${members.join("\n")} }\n${helpers.join("\n")}\nRunner;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(compiled, { Map, Set, Promise, isDeepStrictEqual, ...globals }) as new () => Runner;
}

function compose(name: string): ComposeAttachment {
  return {
    id: name, networkId: name, projectName: name, runtime: "docker", status: "attached", attachedAt: "2026-01-01T00:00:00Z",
    composeFiles: [`/workspace/${name}/compose.yaml`],
    ports: [{ serviceName: "db", logicalPort: 5432, actualHostAddress: "127.0.0.1", actualHostPort: 51000, containerPort: 5432, protocol: "tcp" }],
  };
}

function setup() {
  const initial: LogicalNetworkRegistryState = {
    networks: ["alpha", "beta", "gamma"].map((id) => ({ id, name: id, status: "running", runtimeKind: "nativeHelper", createdAt: "2026-01-01T00:00:00Z" })),
    attachments: [], exposures: [], hostAccessBindings: [], composeAttachments: [compose("alpha"), compose("beta")],
  };
  const registry = new LogicalNetworkRegistry([], initial);
  const state = { document: { revision: "initial", state: registry.getPersistedState() }, lease: true };
  const calls = {
    overrides: [] as string[][], repairs: [] as string[][], writes: 0, dns: 0, terminals: 0, reopens: 0,
    adopted: 0, forcedWrites: 0,
  };
  registry.onDidChange(() => { calls.adopted++; });
  const Service = extractRunner({ tryAcquireControlPlaneOwnerLease: () => state.lease });
  const runner = Object.assign(new Service(), {
    ownsControlPlaneLease: true,
    registry,
    sharedNetworkStateRevision: state.document.revision,
    persistedNetworkStateSignature: JSON.stringify(state.document.state),
    sharedNetworkStateStore: { load: () => state.document },
    saveNormalizedPersistedStateIfChanged: () => {},
    syncVscodeWindowProcessAttachment: () => {},
    demoteControlPlaneOwner: () => { runner.ownsControlPlaneLease = false; },
    reopenPersistedExposures: async () => { calls.reopens++; },
    writeHostAccessBindingsFile: async () => {},
    reconcileComposeOverrideFiles: async (attachments: readonly ComposeAttachment[], options: { force?: boolean }) => {
      assert.equal(options.force, true);
      calls.overrides.push(Array.from(attachments, (attachment) => attachment.networkId));
    },
    reconcileComposeAttachmentPublishedPorts: async (options: { force?: boolean; networkIds: readonly string[] }) => {
      assert.equal(options.force, true);
      calls.repairs.push(Array.from(options.networkIds));
    },
    writeComposeProjectRoutingFile: async (options?: { forceComposeOverrideRefresh?: boolean }) => {
      calls.writes++;
      if (options?.forceComposeOverrideRefresh === true) calls.forcedWrites++;
    },
    writeTerminalNetworkSelectionFile: async () => { calls.terminals++; },
    rehydrateBrowserDnsAndProxies: async () => { calls.dns++; },
    syncLogicalPortRouters: async () => {},
  });
  let revision = 0;
  const update = (change: (next: LogicalNetworkRegistryState) => LogicalNetworkRegistryState) => {
    state.document = { revision: `next-${++revision}`, state: change(structuredClone(registry.getPersistedState())) };
    return runner.reloadSharedNetworkState();
  };
  const changePort = (name: string, port: number) => (next: LogicalNetworkRegistryState) => ({
    ...next, composeAttachments: next.composeAttachments?.map((row) => row.id === name
      ? { ...row, ports: row.ports.map((item) => ({ ...item, actualHostPort: port })) } : row),
  });
  return { runner, registry, state, calls, update, changePort };
}

/** Exposes an asynchronous boundary so a burst can arrive while the previous generation is still running. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("terminal-only shared revisions keep Docker idle while terminal routes and DNS still converge", async () => {
  const { calls, update } = setup();
  for (let minute = 0; minute < 10; minute++) {
    await update((state) => ({ ...state, attachments: [{
      id: `terminal-${minute}`, networkId: "alpha", rootPid: 1000 + minute,
      mode: "logical", status: "attached", attachedAt: new Date(minute * 60000).toISOString(),
    }] }));
  }
  assert.equal(calls.adopted, 10);
  assert.equal(calls.overrides.length, 0);
  assert.equal(calls.repairs.length, 0);
  assert.equal(calls.forcedWrites, 0);
  assert.equal(calls.writes, 10, "missing routing files must still be repairable without forcing readable overrides");
  assert.equal(calls.terminals, 10);
  assert.equal(calls.dns, 10);
});

test("a changed Compose attachment validates its network once and leaves other projects alone", async () => {
  const { calls, update, changePort } = setup();
  await update(changePort("beta", 52000));
  assert.deepEqual(calls.overrides, [["beta"]]);
  assert.deepEqual(calls.repairs, [["beta"]]);
  assert.equal(calls.forcedWrites, 0, "TSV publication must not repeat the already completed forced override validation");
  assert.equal(calls.writes, 1);
});

test("Compose additions, removals and ownership moves repair every affected network", async () => {
  const { calls, update } = setup();
  await update((state) => ({ ...state, composeAttachments: [...state.composeAttachments!, compose("gamma")] }));
  await update((state) => ({ ...state, composeAttachments: state.composeAttachments?.filter((row) => row.id !== "gamma") }));
  await update((state) => ({ ...state, composeAttachments: state.composeAttachments?.map((row) => row.id === "beta" ? { ...row, networkId: "gamma" } : row) }));
  assert.deepEqual(calls.repairs, [["gamma"], ["gamma"], ["beta", "gamma"]]);
  assert.deepEqual(calls.overrides, [["gamma"], [], ["gamma"]]);
});

test("array and object property reordering do not invalidate Compose runtime state", async () => {
  const { calls, update } = setup();
  await update((state) => ({ ...state, composeAttachments: state.composeAttachments?.slice().reverse().map((row) =>
    Object.fromEntries(Object.entries(row).reverse()) as unknown as ComposeAttachment,
  ) }));
  assert.equal(calls.overrides.length, 0);
  assert.equal(calls.repairs.length, 0);
});

test("new documents apply immediately during slow work and a burst shares one trailing repair", async () => {
  const { runner, registry, calls, update, changePort } = setup();
  const gate = deferred();
  runner.reopenPersistedExposures = async () => { if (++calls.reopens === 1) await gate.promise; };
  const first = update(changePort("alpha", 52000));
  await nextTurn();
  const pending: Promise<void>[] = [];
  for (let index = 0; index < 30; index++) pending.push(update(changePort("beta", 53000 + index)));
  assert.equal(registry.getSnapshot().composeAttachments.find((row) => row.id === "beta")?.ports[0].actualHostPort, 53029);
  assert.equal(calls.reopens, 1);
  assert.equal(calls.repairs.length, 0);
  gate.resolve();
  await Promise.all([first, ...pending]);
  assert.deepEqual(calls.repairs, [["alpha"], ["beta"]]);
  assert.equal(calls.reopens, 2);
});

test("failed scopes survive for the next tick without a tight retry loop", async () => {
  const { runner, calls, update, changePort } = setup();
  runner.writeHostAccessBindingsFile = async () => { throw new Error("temporary filesystem failure"); };
  await assert.rejects(update(changePort("alpha", 52000)), /temporary filesystem failure/);
  await nextTurn();
  assert.equal(calls.reopens, 1);
  assert.deepEqual([...runner.sharedNetworkComposeRefreshNetworkIds], ["alpha"]);
  runner.writeHostAccessBindingsFile = async () => {};
  await runner.refreshSharedNetworkRoutingState();
  assert.deepEqual(calls.repairs, [["alpha"]]);
  assert.equal(runner.sharedNetworkComposeRefreshNetworkIds.size, 0);
});

test("a revision at promise settlement cannot strand the last repair", async () => {
  const { runner, calls, update, changePort } = setup();
  const drain = runner.refreshSharedNetworkRoutingStateSerially.bind(runner);
  let trailing: Promise<void> | undefined;
  runner.refreshSharedNetworkRoutingStateSerially = async () => {
    await drain();
    if (trailing === undefined) trailing = update(changePort("beta", 53000));
  };
  await update(changePort("alpha", 52000));
  await trailing;
  await nextTurn();
  await runner.sharedNetworkRoutingRefreshInFlight;
  assert.deepEqual(calls.repairs, [["alpha"], ["beta"]]);
});

test("owner loss after an awaited boundary prevents further Docker work", async () => {
  const { runner, calls, update, changePort } = setup();
  runner.reopenPersistedExposures = async () => { runner.ownsControlPlaneLease = false; };
  await update(changePort("alpha", 52000));
  assert.equal(calls.overrides.length, 0);
  assert.equal(calls.repairs.length, 0);
  assert.equal(calls.writes, 0);
});

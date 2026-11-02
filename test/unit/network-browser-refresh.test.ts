import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import { browserNetworkProxyEndpointId } from "../../src/platform/ports/browser-network-proxy";
import { BrowserDnsSyncCoordinator, type BrowserDnsSyncBatch } from "../../src/extension/browser-dns-sync-coordinator";

/** Runs current orchestration methods with counted adapters, without activating VS Code. */
function extract<T>(file: string, className: string, names: readonly string[], helpers: readonly string[] = [], globals = {}, constructorStatement?: string): new () => T {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../src/extension", file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const service = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(service);
  const members = names.map((name) => {
    const member = service.members.find((node) => node.name?.getText(ast) === name);
    assert.ok(member, name);
    return member.getText(ast);
  });
  const functions = helpers.map((name) => {
    const helper = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(helper, name);
    return helper.getText(ast);
  });
  // Isolate the actual coordinator wiring while leaving OS-heavy constructor work out.
  const setup = constructorStatement === undefined ? undefined : service.members.find(ts.isConstructorDeclaration)?.body?.statements
    .find((node) => node.getText(ast).includes(constructorStatement));
  if (constructorStatement !== undefined) assert.ok(setup, constructorStatement);
  return vm.runInNewContext(ts.transpileModule(`class Runner { ${members.join("\n")} ${setup === undefined ? "" : `initialize() { ${setup.getText(ast)} }`} }\n${functions.join("\n")}\nRunner;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, globals) as new () => T;
}

interface ClientRunner {
  connectionGeneration: number;
  disposed: boolean;
  refresh(): Promise<void>;
  request(method: string): Promise<unknown>;
  applySnapshot(snapshot: unknown): void;
}
const Client = extract<ClientRunner>("local-agent-client.ts", "LocalAgentClient",
  ["connectionGeneration", "disposed", "refreshInFlight", "refresh"]);

test("owner commands continue while unrelated Compose startup is still pending", async () => {
  let owner: { pid: number } | undefined;
  const pid = 4242;
  const calls: string[] = [];
  let release!: () => void;
  const startupGate = new Promise<void>(resolve => { release = resolve; });
  interface OwnerRunner {
    ownsControlPlaneLease: boolean;
    controlPlaneOwnerStartupInFlight?: Promise<boolean>;
    takeControlPlaneOwnership(): Promise<boolean>;
    startControlPlaneOwnerIfAvailable(): Promise<boolean>;
  }
  const Service = extract<OwnerRunner>("network-service.ts", "PortManagerNetworkService", [
    "controlPlaneOwnerStartupInFlight", "startControlPlaneOwnerIfAvailable",
    "startControlPlaneOwnerIfAvailableExclusive", "takeControlPlaneOwnership",
  ], [], {
    process: { pid }, readControlPlaneOwner: () => owner,
    writeControlPlaneOwnerLease: () => { owner = { pid }; return true; },
    tryAcquireControlPlaneOwnerLease: () => owner?.pid === pid,
    devLog: () => {}, formatError: String,
  });
  const service = Object.assign(new Service(), {
    ownsControlPlaneLease: false, localChangeEvents: { emit: () => {} },
    startControlPlaneOwnerWatchers: async () => { calls.push("watchers"); },
    startControlPlaneOwnerServices: async () => { calls.push("services"); await startupGate; },
    demoteControlPlaneOwner: () => { throw new Error("Unexpected lease loss"); },
  });
  try {
    assert.equal(await Promise.race([service.takeControlPlaneOwnership(), nextTurn().then(() => false)]), true,
      "DNS and terminal commands must not wait for Compose startup");
    assert.deepEqual(calls, ["watchers", "services"]);
    assert.equal(await Promise.race([service.startControlPlaneOwnerIfAvailable(), nextTurn().then(() => false)]), true,
      "later owner operations must also use the valid lease immediately");
    assert.deepEqual(calls, ["watchers", "services"], "the startup pass remains single-flight");
  } finally {
    release();
    await service.controlPlaneOwnerStartupInFlight;
  }
});

test("concurrent missing targets share one refresh and immediately observe the next server", async () => {
  const Service = extract<{
    resolveBrowserNetworkProxyTarget(endpoint: { networkId: string; logicalPort: number }): Promise<{ host: string; port: number }>;
  }>("network-service.ts", "PortManagerNetworkService", [
    "resolveBrowserNetworkProxyTarget", "findNetworkRoute", "findBrowserProxyFallbackListenerTarget", "findNetworkScopedListener",
  ], ["findMatchingRoute"], {
    browserNetworkProxyEndpointId, isLiveListenRoute: () => true,
    browserProxyTargetProtocolForRoute: () => ({}),
  });
  let snapshot = { routes: [] as { networkId: string; logicalPort: number; actualPort: number; host: string }[], processes: [], listeners: [] };
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = Object.assign(new Client(), {
    getSnapshot: () => snapshot,
    request: async () => { calls++; await gate; return snapshot; },
    applySnapshot: () => {},
  });
  const service = Object.assign(new Service(), {
    browserProxyExposureByEndpointId: new Map(), browserProxyComposeTargetByEndpointId: new Map(),
    findBrowserProxyRouteTarget: () => undefined, processService: client, getAgentSnapshot: () => snapshot,
  });
  const target = { networkId: "alpha", logicalPort: 3004 };
  const requests = Array.from({ length: 16 }, () => service.resolveBrowserNetworkProxyTarget(target));
  const completed = Promise.allSettled(requests);
  assert.equal(calls, 1);
  release();
  assert.ok((await completed).every((result) => result.status === "rejected"));
  assert.equal(calls, 1, "fallback must not perform another refresh");
  client.request = async () => {
    calls++;
    snapshot = { ...snapshot, routes: [
      { ...target, networkId: "other", actualPort: 50000, host: "127.0.0.1" },
      { ...target, actualPort: 50001, host: "127.0.0.1" },
    ] };
    return snapshot;
  };
  assert.equal((await service.resolveBrowserNetworkProxyTarget(target)).port, 50001);
  assert.equal(calls, 2);
  assert.equal((await service.resolveBrowserNetworkProxyTarget(target)).port, 50001);
  assert.equal(calls, 2, "available routes must not incur refresh work");
});

test("refresh failures can retry and a previous connection cannot publish or clear newer refresh work", async () => {
  const client = new Client();
  const applied: unknown[] = [];
  client.applySnapshot = (snapshot) => applied.push(snapshot);
  client.request = async () => { throw new Error("temporarily unavailable"); };
  await assert.rejects(client.refresh(), /temporarily unavailable/);
  const releases: ((value: unknown) => void)[] = [];
  client.request = () => new Promise((resolve) => releases.push(resolve));
  const old = client.refresh();
  client.connectionGeneration++;
  const fresh = client.refresh();
  releases[0]!("old");
  await old;
  const joined = client.refresh();
  assert.equal(releases.length, 2);
  releases[1]!("fresh");
  await Promise.all([fresh, joined]);
  assert.deepEqual(applied, ["fresh"]);
  const disposed = client.refresh();
  client.disposed = true;
  releases[2]!("disposed");
  await disposed;
  assert.deepEqual(applied, ["fresh"]);
});

interface CommandRunner {
  readBrowserProxyProcessCommandTexts(rows: unknown[]): Promise<ReadonlyMap<number, string>>;
  processEnvironmentProvider: { readProcessCommand(pid: number): Promise<string | undefined> };
}
const Commands = extract<CommandRunner>("network-service.ts", "PortManagerNetworkService", [
  "browserProxyProcessCommandTextCache", "browserProxyProcessCommandTextInFlight",
  "readBrowserProxyProcessCommandTexts", "pruneBrowserProxyProcessCommandTextCache",
], ["isPublicWebEntrypointProcess", "isPublicWebEntrypointText"], {
  BROWSER_PROXY_COMMAND_TEXT_CACHE_TTL_MS: 600000, BROWSER_PROXY_COMMAND_TEXT_MISS_CACHE_TTL_MS: 15000,
});

test("multiple rows and overlapping syncs share command reads while reused PIDs invalidate them", async () => {
  const runner = new Commands();
  const reads: { pid: number; resolve(command: string): void }[] = [];
  runner.processEnvironmentProvider = { readProcessCommand: (pid) => new Promise((resolve) => reads.push({ pid, resolve })) };
  const rows = Array.from({ length: 24 }, (_, index) => ({
    id: `row-${index}`, pid: 100, source: "hook", status: "running", networkId: "alpha", startedAt: "first",
    name: "node", command: "node", cwd: "/fixture", url: `http://127.0.0.1:${3000 + index}`,
  }));
  const first = runner.readBrowserProxyProcessCommandTexts(rows);
  const second = runner.readBrowserProxyProcessCommandTexts(rows);
  assert.equal(reads.length, 1);
  reads[0]!.resolve("old command");
  await Promise.all([first, second]);
  await runner.readBrowserProxyProcessCommandTexts(rows);
  assert.equal(reads.length, 1);
  const reusedRows = rows.map((row) => ({ ...row, startedAt: "replacement" }));
  const reused = runner.readBrowserProxyProcessCommandTexts(reusedRows);
  assert.equal(reads.length, 2);
  reads[1]!.resolve("new command");
  assert.equal((await reused).get(100), "new command");
  const pending = runner.readBrowserProxyProcessCommandTexts(rows);
  await runner.readBrowserProxyProcessCommandTexts([]);
  const replacement = runner.readBrowserProxyProcessCommandTexts(reusedRows);
  reads[2]!.resolve("late old command");
  await pending;
  reads[3]!.resolve("last command");
  await replacement;
  assert.equal((await runner.readBrowserProxyProcessCommandTexts(reusedRows)).get(100), "last command");
  assert.equal(reads.length, 4, "a disappeared PID lookup must not overwrite the replacement cache");
});

interface DnsRunner {
  queueBrowserDnsDaemonSync(records: string, revision?: string, statePath?: string): void;
  recordBrowserDnsSyncResult(batch: unknown, result: unknown): void;
  getBrowserDnsRuntimeState(): { running: boolean; port: number };
}
/** Runs the real service policies, replacing only daemon/queue/event boundaries. */
function dnsFixture() {
  let now = 100;
  class Clock extends Date { static override now() { return now++; } }
  const Service = extract<DnsRunner>("network-service.ts", "PortManagerNetworkService", [
    "queueBrowserDnsDaemonSync", "recordBrowserDnsSyncResult", "getBrowserDnsRuntimeState", "getBrowserDnsDaemonIncarnation",
  ], ["browserDnsSyncSignature"], { Date: Clock, browserDnsPort: () => 53153 });
  let daemon = { pid: 200, startedAt: "first", updatedAt: new Date(0).toISOString(), browserDnsRunning: true, browserDnsPort: 53153 };
  const enqueued: unknown[] = [];
  let events = 0;
  const service = Object.assign(new Service(), {
    getDaemonStatus: () => daemon, processService: {},
    browserDnsSyncCoordinator: { enqueue: (value: unknown) => enqueued.push(value) },
    localChangeEvents: { emit: () => { events++; } },
  });
  const batch = { records: "alpha=127.120.1.2", revision: "R", signature: "R\0alpha=127.120.1.2", daemonIncarnation: "200\0first" };
  const success = { applied: true, running: true, port: 53153 };
  return { service, enqueued, batch, success, getEvents: () => events, setDaemon: (patch: Partial<typeof daemon>) => { daemon = { ...daemon, ...patch }; } };
}

test("PID reuse republishes acknowledged DNS records and ignores old-incarnation diagnostics", () => {
  const f = dnsFixture();
  f.service.recordBrowserDnsSyncResult(f.batch, f.success);
  f.setDaemon({ startedAt: "replacement", browserDnsRunning: false });
  assert.equal(f.service.getBrowserDnsRuntimeState().running, false);
  f.service.queueBrowserDnsDaemonSync(f.batch.records, "R", "/state");
  assert.equal(f.enqueued.length, 1);
});

test("a newer down heartbeat invalidates DNS acknowledgement while timestamp-only health churn does not", () => {
  const f = dnsFixture();
  f.service.recordBrowserDnsSyncResult(f.batch, f.success);
  f.setDaemon({ updatedAt: "9999-01-01T00:00:00.000Z" });
  f.service.queueBrowserDnsDaemonSync(f.batch.records, "R", "/state");
  assert.equal(f.enqueued.length, 0);
  f.setDaemon({ browserDnsRunning: false });
  f.service.queueBrowserDnsDaemonSync(f.batch.records, "R", "/state");
  assert.equal(f.enqueued.length, 1);
});

test("a stale adapter completion cannot acknowledge current-incarnation DNS work", () => {
  const f = dnsFixture();
  f.setDaemon({ startedAt: "replacement", browserDnsRunning: false });
  f.service.recordBrowserDnsSyncResult(f.batch, f.success);
  assert.equal(f.service.getBrowserDnsRuntimeState().running, false);
  f.service.queueBrowserDnsDaemonSync(f.batch.records, "R", "/state");
  assert.equal(f.enqueued.length, 1);
});

test("DNS-only heartbeat changes emit events while timestamp-only updates stay quiet", () => {
  interface Runner { applySnapshot(snapshot: unknown): void; }
  const Client = extract<Runner>("local-agent-client.ts", "LocalAgentClient", ["applySnapshot"], [
    "buildClientSnapshotSignature", "compareSnapshotSignatureRows", "buildClientRouteSignatureRows", "normalizeClientRouteDirection",
  ], { annotateDaemonCompatibility: (s: unknown) => s, normalizeAgentSnapshot: (s: unknown) => s });
  let events = 0;
  const client = Object.assign(new Client(), { getAgentMainPath: () => "/agent", queueChangeEvent: () => { events++; } });
  let daemon = { pid: 200, startedAt: "first", browserDnsRunning: true, browserDnsPort: 53153, browserDnsError: "" };
  const apply = () => client.applySnapshot({ agentPid: 200, daemon, listeners: [], processes: [], routes: [] });
  apply();
  daemon = { ...daemon, browserDnsRunning: false }; apply();
  daemon = { ...daemon, browserDnsPort: 53154 }; apply();
  daemon = { ...daemon, browserDnsError: "bind failed" }; apply();
  assert.equal(events, 4);
  client.applySnapshot({ agentPid: 200, daemon: { ...daemon, updatedAt: "later" }, listeners: [], processes: [], routes: [], updatedAt: "later" });
  assert.equal(events, 4);
});

test("background DNS cannot re-enable a deliberately stopped client; explicit start can publish again", async () => {
  interface Runner {
    automaticEventReconnectEnabled: boolean;
    stopDaemon(): Promise<void>; start(): Promise<void>;
    syncBrowserDns(records: string): Promise<{ suspended?: boolean }>;
  }
  const Client = extract<Runner>("local-agent-client.ts", "LocalAgentClient", [
    "automaticEventReconnectEnabled", "connectionGeneration", "stopDaemon", "start", "syncBrowserDns",
    "enableAutomaticEventReconnect", "disableAutomaticEventReconnect",
  ], ["buildClientSnapshotSignature", "compareSnapshotSignatureRows", "buildClientRouteSignatureRows", "normalizeClientRouteDirection"], {
    createEmptySnapshot: () => ({ daemon: { pid: 0 }, listeners: [], processes: [], routes: [] }),
    AGENT_EVENT_RECONNECT_INITIAL_DELAY_MS: 100, process: { pid: 999 }, clearTimeout,
  });
  let requests = 0;
  const client = Object.assign(new Client(), {
    snapshot: { daemon: { pid: 0 } }, rejectAllPending: () => {}, queueChangeEvent: () => {},
    ensureConnected: async () => {}, loadDaemonStatusForStartup: async () => {},
    request: async () => { requests++; return { running: true, port: 53153 }; },
  });
  await client.syncBrowserDns("alpha=127.120.1.2");
  assert.equal(requests, 1, "initial startup remains enabled");
  await client.stopDaemon();
  const result = await client.syncBrowserDns("alpha=127.120.1.2");
  assert.equal(requests, 1, "background DNS must not reach the auto-starting request path");
  assert.equal(result.suspended, true);
  assert.equal(client.automaticEventReconnectEnabled, false);
  await client.start();
  await client.syncBrowserDns("alpha=127.120.1.2");
  assert.equal(requests, 2);
});

for (const outcome of ["success", "error"] as const) {
  test(`actual DNS send wiring captures attempt incarnation and fences stale ${outcome}`, async () => {
    interface Runner extends DnsRunner {
      initialize(): void;
      browserDnsSyncCoordinator: BrowserDnsSyncCoordinator;
    }
    const Service = extract<Runner>("network-service.ts", "PortManagerNetworkService", [
      "queueBrowserDnsDaemonSync", "recordBrowserDnsSyncResult", "getBrowserDnsRuntimeState", "getBrowserDnsDaemonIncarnation",
    ], ["browserDnsSyncSignature"], { Date, browserDnsPort: () => 53153, BrowserDnsSyncCoordinator, setTimeout, clearTimeout }, "new BrowserDnsSyncCoordinator");
    let daemon = { pid: 200, startedAt: "first", updatedAt: new Date(0).toISOString(), browserDnsRunning: true };
    let resolve!: (value: { running: boolean; port: number }) => void;
    let reject!: (error: Error) => void;
    const service = Object.assign(new Service(), {
      getDaemonStatus: () => daemon,
      processService: { syncBrowserDns: () => new Promise((a, b) => { resolve = a; reject = b; }) },
      localChangeEvents: { emit: () => {} },
    });
    service.initialize();
    // Enqueue-time metadata is deliberately old: only the actual send attempt counts.
    const records = "alpha=127.120.1.2";
    service.browserDnsSyncCoordinator.enqueue({ records, signature: `R\0${records}`, daemonIncarnation: "outdated" });
    daemon = { ...daemon, startedAt: "replacement" };
    service.recordBrowserDnsSyncResult({ records, signature: `R\0${records}`, daemonIncarnation: "200\0replacement" }, { running: true, port: 53153 });
    if (outcome === "success") resolve({ running: true, port: 12345 });
    else reject(new Error("old socket closed"));
    await service.browserDnsSyncCoordinator.waitForCurrentDrain();
    assert.equal(service.getBrowserDnsRuntimeState().port, 53153, "old results cannot overwrite current diagnostics");
    const enqueued: BrowserDnsSyncBatch[] = [];
    service.browserDnsSyncCoordinator.dispose();
    service.browserDnsSyncCoordinator.enqueue = (value: BrowserDnsSyncBatch) => { enqueued.push(value); };
    service.queueBrowserDnsDaemonSync(records, "R");
    assert.equal(enqueued.length, 0, "a stale error cannot clear the current acknowledgement");
  });
}


test("successful DNS recovery emits when a newer heartbeat had superseded the previous healthy result", () => {
  const f = dnsFixture();
  f.service.recordBrowserDnsSyncResult(f.batch, f.success);
  const before = f.getEvents();
  // Ahead of the first sync result but behind the next response.
  f.setDaemon({ updatedAt: new Date(101).toISOString(), browserDnsRunning: false });
  f.service.recordBrowserDnsSyncResult(f.batch, f.success);
  assert.equal(f.getEvents(), before + 1);
});

test("actual DNS send captures current provenance rather than queued provenance", async () => {
  interface Runner extends DnsRunner { initialize(): void; browserDnsSyncCoordinator: BrowserDnsSyncCoordinator; }
  const Service = extract<Runner>("network-service.ts", "PortManagerNetworkService", [
    "queueBrowserDnsDaemonSync", "recordBrowserDnsSyncResult", "getBrowserDnsRuntimeState", "getBrowserDnsDaemonIncarnation",
  ], ["browserDnsSyncSignature"], { Date, browserDnsPort: () => 53153, BrowserDnsSyncCoordinator, setTimeout, clearTimeout }, "new BrowserDnsSyncCoordinator");
  const service = Object.assign(new Service(), {
    getDaemonStatus: () => ({ pid: 200, startedAt: "current", updatedAt: new Date(0).toISOString(), browserDnsRunning: false }),
    processService: { syncBrowserDns: async () => ({ running: true, port: 53154 }) },
    localChangeEvents: { emit: () => {} },
  });
  service.initialize();
  service.browserDnsSyncCoordinator.enqueue({ records: "alpha=127.120.1.2", signature: "R\0alpha=127.120.1.2", daemonIncarnation: "200\0queued-before-restart" });
  await service.browserDnsSyncCoordinator.waitForCurrentDrain();
  assert.equal(service.getBrowserDnsRuntimeState().running, true);
  assert.equal(service.getBrowserDnsRuntimeState().port, 53154);
  service.browserDnsSyncCoordinator.dispose();
});

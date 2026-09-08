import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { browserNetworkProxyEndpointId } from "../../src/platform/ports/browser-network-proxy";

/** Runs current orchestration methods with counted adapters, without activating VS Code. */
function extract<T>(file: string, className: string, names: readonly string[], helpers: readonly string[] = [], globals = {}): new () => T {
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
  return vm.runInNewContext(ts.transpileModule(`class Runner { ${members.join("\n")} }\n${functions.join("\n")}\nRunner;`, {
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

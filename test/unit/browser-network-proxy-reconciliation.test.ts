import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import test from "node:test";
import * as vm from "node:vm";
import * as ts from "typescript";
import {
  BrowserNetworkProxyManager,
  type BrowserNetworkProxyEndpoint,
  type ActiveBrowserNetworkProxyEndpoint,
} from "../../src/platform/ports/browser-network-proxy";

/** Exercise lifecycle timing with real loopback binds; only dropped SYNs are simulated. */
function endpoint(index: number, listenPorts: readonly number[]): BrowserNetworkProxyEndpoint {
  return { id: `network-${index}:3000`, networkId: `network-${index}`, logicalPort: 3000, listenHost: "127.0.0.1", listenPorts };
}

async function listen(server = net.createServer((socket) => socket.end()), port = 0): Promise<net.Server> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

function port(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
    else resolve();
  }));
}

async function freePorts(count: number): Promise<number[]> {
  const reservations = await Promise.all(Array.from({ length: count }, () => listen()));
  const ports = reservations.map(port);
  await Promise.all(reservations.map(close));
  return ports;
}

async function waitUntil(condition: () => boolean, deadlineMs = 1500): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    assert.ok(performance.now() - started < deadlineMs, "condition did not settle before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("recovers a freed port automatically without a new routing event", async () => {
  const occupied = await listen();
  const upstream = await listen(http.createServer((_request, response) => response.end("recovered")));
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: port(upstream) }) });
  const desired = endpoint(1, [port(occupied)]);
  try {
    await proxy.sync([desired]);
    assert.equal(proxy.has(desired.id), false);
    await close(occupied);
    // No second sync/ensure: the manager itself must schedule recovery.
    await waitUntil(() => proxy.has(desired.id));
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: desired.listenPorts[0], path: "/" }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve(text));
      }).on("error", reject);
    });
    assert.equal(body, "recovered");
  } finally {
    await proxy.dispose();
    await close(occupied);
    await close(upstream);
  }
});

test("backs off consecutive bind failures without duplicate syncs extending the deadline", async (context) => {
  const occupied = await listen();
  const desired = endpoint(1, [port(occupied)]);
  const wakeups: number[] = [];
  let completed: (() => void) | undefined;
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) }, {
    onRetryDue: async () => {
      wakeups.push(Date.now());
      await proxy.sync([desired]);
      completed?.();
    },
  });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  try {
    await proxy.sync([desired]);
    for (const expectedDelay of [100, 200, 400]) {
      context.mock.timers.tick(expectedDelay - 1);
      await proxy.sync([desired]);
      const previousCount = wakeups.length;
      const done = new Promise<void>((resolve) => { completed = resolve; });
      context.mock.timers.tick(1);
      await done;
      // Allow timer finalization to rearm before advancing the next deadline.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(wakeups.length, previousCount + 1);
    }
    assert.deepEqual(wakeups, [1100, 1300, 1700]);
  } finally {
    await proxy.dispose();
    context.mock.timers.reset();
    await close(occupied);
  }
});

test("a changed candidate port does not inherit an old endpoint's bind failure", async () => {
  const occupied = await listen();
  const [available] = await freePorts(1);
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) }, { retryDelayMs: 60_000 });
  try {
    await proxy.sync([endpoint(1, [port(occupied)])]);
    assert.equal(proxy.has("network-1:3000"), false);
    await proxy.sync([endpoint(1, [available!])]);
    assert.equal(proxy.get("network-1", 3000)?.listenPort, available);
  } finally {
    await proxy.dispose();
    await close(occupied);
  }
});

test("removal, close, owner loss, and disposal cancel automatic resurrection", async () => {
  for (const action of ["remove", "close", "release", "dispose"] as const) {
    const occupied = await listen();
    const desired = endpoint(1, [port(occupied)]);
    let retryCalls = 0;
    const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) }, {
      retryDelayMs: 20,
      onRetryDue: async () => { retryCalls++; await proxy.sync([desired]); },
    });
    try {
      await proxy.sync([desired]);
      if (action === "remove") await proxy.sync([]);
      else if (action === "close") await proxy.close(desired.id);
      else if (action === "release") await proxy.releaseAll();
      else await proxy.dispose();
      await close(occupied);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(retryCalls, 0, action);
      assert.equal(proxy.has(desired.id), false, action);
    } finally {
      await proxy.dispose();
      await close(occupied);
    }
  }
});

test("eight unanswered probes share one bounded batch before a healthy port", async (context) => {
  const ports = await freePorts(10);
  const blocked = new Set(ports.slice(0, 8));
  const sockets: net.Socket[] = [];
  const netModule = require("node:net") as typeof net;
  const connect = netModule.createConnection;
  let pending = 0;
  let maxPending = 0;
  context.mock.method(netModule, "createConnection", (options: net.NetConnectOpts) => {
    if (!("port" in options) || !blocked.has(options.port)) return connect(options);
    const socket = new net.Socket();
    maxPending = Math.max(maxPending, ++pending);
    socket.once("close", () => pending--);
    sockets.push(socket);
    return socket;
  });
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) });
  try {
    const started = performance.now();
    const syncing = proxy.sync(ports.map((value, index) => endpoint(index, [value])));
    await waitUntil(() => proxy.has("network-9:3000"), 1000);
    await syncing;
    assert.ok(performance.now() - started < 1000);
    assert.equal(maxPending, 8);
    assert.equal(proxy.has("network-8:3000"), true);
    assert.equal(sockets.every((socket) => socket.destroyed), true);
  } finally {
    await proxy.dispose();
  }
});

test("closing an endpoint while its immediate attempt fails cannot schedule another retry", async (context) => {
  const [available] = await freePorts(1);
  const probe = new net.Socket();
  let probing = false;
  let retries = 0;
  const netModule = require("node:net") as typeof net;
  context.mock.method(netModule, "createConnection", () => { probing = true; return probe; });
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) }, {
    retryDelayMs: 20,
    onRetryDue: async () => { retries++; },
  });
  const desired = endpoint(1, [available!]);
  try {
    const ensuring = proxy.ensure(desired);
    await waitUntil(() => probing);
    await proxy.close(desired.id);
    probe.destroy(new Error("probe failed after endpoint removal"));
    assert.equal(await ensuring, undefined);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(retries, 0);
  } finally {
    probe.destroy();
    await proxy.dispose();
  }
});

test("different loopback aliases can prepare the same port independently", async (context) => {
  const [available] = await freePorts(1);
  const netModule = require("node:net") as typeof net;
  const connect = netModule.createConnection;
  context.mock.method(netModule, "createConnection", (options: net.NetConnectOpts) => {
    return "host" in options && options.host === "127.0.0.2" ? new net.Socket() : connect(options);
  });
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) });
  try {
    const syncing = proxy.sync([
      { ...endpoint(1, [available!]), listenHost: "127.0.0.2" },
      endpoint(2, [available!]),
    ]);
    await waitUntil(() => proxy.has("network-2:3000"), 200);
    assert.equal(proxy.has("network-1:3000"), false);
    await syncing;
  } finally {
    await proxy.dispose();
  }
});

test("overlapping fallback candidates retain order while an independent bind proceeds", async (context) => {
  const [blockedPort, firstFallback, secondFallback, independent] = await freePorts(4);
  const netModule = require("node:net") as typeof net;
  const connect = netModule.createConnection;
  context.mock.method(netModule, "createConnection", (options: net.NetConnectOpts) => {
    return "port" in options && options.port === blockedPort ? new net.Socket() : connect(options);
  });
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) }, { retryDelayMs: 60_000 });
  try {
    const syncing = proxy.sync([
      endpoint(1, [blockedPort!, firstFallback!]),
      endpoint(2, [firstFallback!, secondFallback!]),
      endpoint(3, [secondFallback!]),
      endpoint(4, [independent!]),
    ]);
    await waitUntil(() => proxy.has("network-4:3000"), 200);
    assert.equal(proxy.has("network-1:3000"), false);
    await syncing;
    assert.equal(proxy.get("network-1", 3000)?.listenPort, firstFallback);
    assert.equal(proxy.get("network-2", 3000)?.listenPort, secondFallback);
    assert.equal(proxy.has("network-3:3000"), false);
  } finally {
    await proxy.dispose();
  }
});

test("owner handoff closes every in-flight bind and does not start the next batch", async () => {
  const ports = await freePorts(10);
  const desired = ports.map((value, index) => endpoint(index, [value]));
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) });
  const mutable = proxy as unknown as { open(value: BrowserNetworkProxyEndpoint): Promise<ActiveBrowserNetworkProxyEndpoint> };
  const open = mutable.open.bind(proxy);
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  let openCalls = 0;
  mutable.open = async (value) => { openCalls++; await gate; return open(value); };
  try {
    const syncing = proxy.sync(desired);
    await waitUntil(() => openCalls === 8);
    await proxy.releaseAll();
    unblock();
    await syncing;
    assert.equal(openCalls, 8);
    assert.equal(desired.some((value) => proxy.has(value.id)), false);
    for (const value of ports) await close(await listen(undefined, value));
  } finally {
    unblock();
    await proxy.dispose();
  }
});

test("reads one TLS identity for an entire reconciliation, including fallback binds", async () => {
  const occupied = await listen();
  const ports = await freePorts(4);
  let reads = 0;
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) }, {
    tlsCredentials: { getCredentials: () => { reads++; return undefined; } },
  });
  const desired = ports.map((value, index) => endpoint(index, index === 0 ? [port(occupied), value] : [value]));
  try {
    await proxy.sync(desired);
    assert.equal(desired.every((value) => proxy.has(value.id)), true);
    assert.equal(reads, 1);
    reads = 0;
    await proxy.sync(desired);
    assert.equal(reads, 1);
    await proxy.ensure(desired[0]!);
    assert.equal(reads, 2);
  } finally {
    await proxy.dispose();
    await close(occupied);
  }
});

test("the extension coalescer drains fresh work but drops queued retries after disposal", async () => {
  // Run the actual service methods without constructing VS Code adapters or
  // touching shared owner leases. Only the expensive reconciliation is gated.
  const source = fs.readFileSync(path.resolve(__dirname, "../../../src/extension/network-service.ts"), "utf8");
  const ast = ts.createSourceFile("network-service.ts", source, ts.ScriptTarget.ES2022, true);
  const service = ast.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PortManagerNetworkService",
  );
  assert.ok(service);
  const names = new Set([
    "browserProxySyncInFlight", "browserProxyDisposed", "browserProxySyncQueued", "browserProxyAdministratorPromptQueued",
    "syncBrowserNetworkProxies", "syncBrowserNetworkProxiesQueued",
  ]);
  const members = service.members.filter((member) => member.name !== undefined && names.has(member.name.getText(ast)));
  assert.equal(members.length, names.size);
  const javascript = ts.transpileModule(`class Runner { ${members.map((member) => member.getText(ast)).join("\n")} }\nRunner;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const Runner = vm.runInNewContext(javascript) as new () => {
    browserProxyDisposed: boolean;
    browserProxySyncInFlight?: Promise<void>;
    syncBrowserNetworkProxies(options?: { allowAdministratorPrompt?: boolean }): Promise<void>;
    syncBrowserNetworkProxiesExclusive(options: { allowAdministratorPrompt?: boolean }): Promise<void>;
  };
  for (const disposed of [false, true]) {
    const runner = new Runner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const prompts: boolean[] = [];
    runner.syncBrowserNetworkProxiesExclusive = async (options) => {
      prompts.push(options.allowAdministratorPrompt === true);
      await gate;
    };
    const first = runner.syncBrowserNetworkProxies();
    const queued = runner.syncBrowserNetworkProxies({ allowAdministratorPrompt: true });
    runner.browserProxyDisposed = disposed;
    release();
    await Promise.all([first, queued]);
    assert.deepEqual(prompts, disposed ? [false] : [false, true]);
    assert.equal(runner.browserProxySyncInFlight, undefined);
    if (disposed) {
      await runner.syncBrowserNetworkProxies();
      assert.deepEqual(prompts, [false]);
    }
  }
});

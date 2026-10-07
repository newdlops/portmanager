import assert from "node:assert/strict";
import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { HostPortProxyManager } from "../../src/platform/ports/host-port-proxy";
import { BrowserNetworkProxyManager, type BrowserNetworkProxyOptions } from "../../src/platform/ports/browser-network-proxy";
import { LogicalPortRouterManager } from "../../src/platform/ports/logical-port-router";
import { ProxyNetworkResources, ProxyResourceBudget, ProxyResourceLimitError,
  type ProxyDnsLookup } from "../../src/platform/ports/proxy-network-resources";
import type { HostPortExposure } from "../../src/shared/types";

/** Independent fixture deadlines catch lost callbacks/permits instead of hanging a suite. */
async function within<T>(work: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("resource fixture timed out")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("resource fixture timed out");
    await delay(5);
  }
}

async function listen(t: TestContext, server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return (server.address() as net.AddressInfo).port;
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function connect(t: TestContext, port: number): Promise<net.Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await within(once(socket, "connect"));
  return socket;
}

async function closed(socket: net.Socket): Promise<void> {
  if (socket.closed) return;
  socket.resume();
  await within(new Promise<void>(resolve => socket.once("close", resolve)));
}

async function echo(socket: net.Socket, payload: string): Promise<void> {
  const result = within(once(socket, "data"));
  socket.write(payload);
  assert.equal((await result)[0].toString(), payload);
}

async function openHost(t: TestContext, resources: ProxyNetworkResources, targetPort: number, nativeProxyPath?: string) {
  let queries = 0;
  const port = await availablePort();
  const exposure: HostPortExposure = { id: String(port), networkId: "test", hostAddress: "127.0.0.1", hostPort: port,
    targetAddress: "127.0.0.1", targetPort, protocol: "tcp", status: "active", createdAt: new Date().toISOString() };
  const manager = new HostPortProxyManager({ resolve: () => { queries++; return { host: "127.0.0.1", port: targetPort }; } },
    { resources, nativeProxyPath });
  t.after(() => manager.dispose());
  await manager.open(exposure);
  return { manager, port, exposure, get queries() { return queries; } };
}

async function openBrowser(t: TestContext, resources: ProxyNetworkResources, targetPort: number, options: BrowserNetworkProxyOptions = {}) {
  const port = await availablePort();
  const manager = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: targetPort }) },
    { ...options, resources });
  t.after(() => manager.dispose());
  const endpoint = await manager.ensure({ id: "test:" + port, networkId: "test", logicalPort: targetPort,
    listenHost: "127.0.0.1", listenPorts: [port], publicHost: "budget.pm" });
  assert.ok(endpoint);
  await until(() => resources.budget.used.upstreams === 0);
  return { manager, port };
}

function request(t: TestContext, port: number, method = "GET") {
  let client!: http.ClientRequest;
  const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
    client = http.request({ host: "127.0.0.1", port, method, agent: false, headers: { connection: "keep-alive" } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    client.once("error", reject);
  });
  t.after(() => client.destroy());
  return { client, result };
}

test("resource admission checks every dimension atomically and returns a lease once", () => {
  const budget = new ProxyResourceBudget({ connections: 2, upstreams: 1 });
  const first = budget.acquire({ connections: 1, upstreams: 1 });
  assert.throws(() => budget.acquire({ connections: 1, upstreams: 1 }), ProxyResourceLimitError);
  assert.equal(budget.tryAcquire({ connections: 1, upstreams: 1 }), undefined);
  assert.equal(budget.used.connections, 1, "a failed multi-resource request must change no count");
  first.release(); first.release();
  assert.equal(budget.used.connections, 0);
  assert.equal(budget.used.upstreams, 0);
  assert.throws(() => new ProxyResourceBudget({ connections: -1 }), RangeError);
  assert.throws(() => new ProxyResourceBudget({ dnsJobs: Infinity }), RangeError);
  assert.throws(() => new ProxyResourceBudget({ upstreams: 0 }).acquire({ upstreams: 1 }), ProxyResourceLimitError);
});

test("synchronous host bind failure returns listener capacity before retry", async () => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ listeners: 1 }) });
  const manager = new HostPortProxyManager({ resolve: () => ({ host: "127.0.0.1", port: 1 }) }, { resources });
  const exposure: HostPortExposure = { id: "invalid-bind", networkId: "test", hostAddress: "127.0.0.1",
    hostPort: -1, targetAddress: "127.0.0.1", targetPort: 1, protocol: "tcp", status: "active",
    createdAt: new Date().toISOString() };
  try {
    await assert.rejects(manager.open(exposure), { code: "ERR_SOCKET_BAD_PORT" });
    await until(() => resources.budget.used.listeners === 0);
    await manager.open({ ...exposure, hostPort: await availablePort() });
    assert.equal(resources.budget.used.listeners, 1);
    await manager.close(exposure.id);
    await until(() => resources.budget.used.listeners === 0);
  } finally { await manager.dispose(); }
});

test("parent control output bounds bytes and preserves complete frames on resume", async () => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ controlBytes: 8 }) });
  const frames: string[] = [];
  let drain!: () => void;
  const stream = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { frames.push(chunk.toString()); drain = done; } });
  stream.on("error", () => {});
  assert.equal(resources.writeControl(stream, "FIRST\n"), true);
  assert.equal(resources.writeControl(stream, "SECOND\n"), false);
  assert.equal(resources.budget.used.controlBytes, 6);
  assert.deepEqual(frames, ["FIRST\n"]);
  drain();
  await until(() => resources.budget.used.controlBytes === 0);
  assert.equal(resources.writeControl(stream, "SECOND\n"), true);
  assert.equal(resources.writeControl(stream, "bad\nframe\n"), false);
  drain();
  await until(() => resources.budget.used.controlBytes === 0);
  assert.deepEqual(frames, ["FIRST\n", "SECOND\n"]);
  stream.destroy();
});

test("canceling shared route waiters detaches callbacks while keeping the real job permit", async () => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ routeJobs: 1 }) });
  let reject!: (error: Error) => void;
  const work = resources.runRoute(() => new Promise<never>((_resolve, no) => { reject = no; }));
  for (let index = 0; index < 1000; index++) {
    const cancellation = new AbortController();
    const wait = resources.awaitRoute(work, cancellation.signal);
    cancellation.abort();
    assert.equal(await wait, undefined);
  }
  assert.equal(resources.pendingRouteWaiters, 0);
  assert.equal(resources.budget.used.routeJobs, 1);
  reject(new Error("late shared failure"));
  await until(() => resources.budget.used.routeJobs === 0);
});

test("different proxy owners share a client budget and preserve admitted duplex sessions", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ connections: 2 }) });
  const targetPort = await listen(t, net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket)));
  const host = await openHost(t, resources, targetPort);
  const browser = await openBrowser(t, resources, targetPort);
  const first = await connect(t, host.port);
  await echo(first, "host");
  const second = await connect(t, browser.port);
  await echo(second, "\0browser");
  assert.equal(resources.budget.used.connections, 2);
  const excess = await connect(t, host.port);
  await closed(excess);
  assert.equal(host.queries, 1, "rejection must precede route work");
  await echo(first, "still host");
  await echo(second, "still browser");
  first.destroy();
  await until(() => resources.budget.used.connections === 1);
  const fresh = await connect(t, host.port);
  await echo(fresh, "fresh");
});

test("shared listener admission reclaims failed binds and real closes", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ listeners: 1 }) });
  const target = await listen(t, net.createServer(socket => socket.pipe(socket)));
  const first = await openHost(t, resources, target);
  await assert.rejects(openHost(t, resources, target), ProxyResourceLimitError);
  assert.equal(resources.budget.used.listeners, 1);
  await first.manager.dispose();
  assert.equal(resources.budget.used.listeners, 0);
  const occupied = net.createServer();
  const occupiedPort = await listen(t, occupied);
  const temporary = net.createServer();
  resources.reserveListener(temporary);
  const failed = new Promise<void>(resolve => temporary.once("error", () => resolve()));
  temporary.listen(occupiedPort, "127.0.0.1");
  await failed;
  assert.equal(resources.budget.used.listeners, 0);
  await openHost(t, resources, target);
});

test("DNS cancellations retain OS job permits, drop waiter references, and recover only on completion", { timeout: 10000 }, async t => {
  const pending: Parameters<ProxyDnsLookup>[2][] = [];
  const resources = new ProxyNetworkResources({ lookup: (_host, _options, callback) => pending.push(callback) });
  let connections = 0;
  const targetPort = await listen(t, net.createServer(socket => { connections++; socket.pipe(socket); }));
  for (let index = 0; index < 4; index++) {
    const socket = resources.connect({ host: "stalled-" + index + ".invalid", port: targetPort });
    socket.on("error", () => {});
    socket.destroy();
    await closed(socket);
  }
  assert.equal(pending.length, 4);
  assert.equal(resources.pendingDnsWaiters, 0);
  assert.equal(resources.budget.used.dnsJobs, 4, "destroy must not manufacture resolver capacity");
  for (let index = 0; index < 20; index++) {
    const refused = resources.connect({ host: "excess-" + index + ".invalid", port: targetPort });
    const error = within(once(refused, "error"));
    assert.ok((await error)[0] instanceof ProxyResourceLimitError);
    await closed(refused);
  }
  assert.equal(pending.length, 4, "new retries cannot add OS jobs behind the stalled ones");
  const numeric = resources.connect({ host: "127.0.0.1", port: targetPort });
  numeric.on("error", () => {});
  t.after(() => numeric.destroy());
  await within(once(numeric, "connect"));
  await echo(numeric, "numeric survives");
  const joined = resources.connect({ host: "stalled-0.invalid", port: targetPort });
  joined.on("error", () => {});
  t.after(() => joined.destroy());
  assert.equal(pending.length, 4);
  assert.equal(resources.pendingDnsWaiters, 1);
  for (const callback of pending.splice(0)) callback(null, [{ address: "127.0.0.1", family: 4 }]);
  await within(once(joined, "connect"));
  await echo(joined, "shared recovery");
  assert.equal(connections, 2, "late success for canceled clients must never open a target");
  assert.equal(resources.budget.used.dnsJobs, 0);
  const fresh = resources.connect({ host: "fresh.invalid", port: targetPort });
  fresh.on("error", () => {});
  t.after(() => fresh.destroy());
  assert.equal(pending.length, 1);
  pending[0](null, [{ address: "127.0.0.1", family: 4 }]);
  await within(once(fresh, "connect"));
  await echo(fresh, "fresh lookup");
});

test("DNS jobs coalesce across ports, preserve all-address fallback, and share quota with native reservations", { timeout: 10000 }, async t => {
  const callbacks: Parameters<ProxyDnsLookup>[2][] = [];
  const budget = new ProxyResourceBudget({ dnsJobs: 2 });
  const resources = new ProxyNetworkResources({ budget, nativeDnsJobsPerHelper: 1,
    lookup: (_host, options, callback) => { assert.equal(options.all, true); callbacks.push(callback); } });
  const native = resources.reserveNative(1, 1);
  t.after(() => native.release());
  const portA = await listen(t, net.createServer(socket => socket.pipe(socket)));
  const portB = await listen(t, net.createServer(socket => socket.pipe(socket)));
  const a = resources.connect({ host: "same.invalid", port: portA, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 10 });
  const b = resources.connect({ host: "same.invalid", port: portB, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 10 });
  a.on("error", () => {}); b.on("error", () => {});
  t.after(() => { a.destroy(); b.destroy(); });
  assert.equal(callbacks.length, 1);
  const refused = resources.connect({ host: "other.invalid", port: portA });
  assert.ok((await within(once(refused, "error")))[0] instanceof ProxyResourceLimitError);
  await closed(refused);
  callbacks[0](null, [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }]);
  await within(Promise.all([once(a, "connect"), once(b, "connect")]));
  await echo(a, "A"); await echo(b, "B");
  assert.equal(budget.used.dnsJobs, 1, "only native's reserved slot remains");
});

test("unsettled route work stays counted after proxy timeout and fresh traffic recovers on real completion", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ routeJobs: 1 }) });
  let finish!: (target: { host: string; port: number }) => void;
  let calls = 0;
  const targetPort = await listen(t, net.createServer(socket => socket.pipe(socket)));
  const port = await availablePort();
  const manager = new HostPortProxyManager({ resolve: () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } }, { resources, resolveTimeoutMs: 30 });
  t.after(() => manager.dispose());
  await manager.open({ id: "route", networkId: "test", hostAddress: "127.0.0.1", hostPort: port,
    targetAddress: "127.0.0.1", targetPort, protocol: "tcp", status: "active", createdAt: "test" });
  await closed(await connect(t, port));
  assert.equal(resources.budget.used.routeJobs, 1);
  await closed(await connect(t, port));
  assert.equal(calls, 1);
  finish({ host: "127.0.0.1", port: targetPort });
  await until(() => resources.budget.used.routeJobs === 0);
  const fresh = await connect(t, port);
  await until(() => calls === 2);
  finish({ host: "127.0.0.1", port: targetPort });
  await echo(fresh, "new route");
});

test("HTTP active admission is shared across origins and never delivers the overloaded POST", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ httpRequests: 1 }) });
  let held!: http.ServerResponse, posts = 0;
  const a = await listen(t, http.createServer((_request, response) => { held = response; response.writeHead(200); response.write("held"); }));
  const b = await listen(t, http.createServer((_request, response) => { posts++; response.end("B"); }));
  const proxyA = await openBrowser(t, resources, a);
  const proxyB = await openBrowser(t, resources, b);
  const active = request(t, proxyA.port);
  active.result.catch(() => {});
  active.client.end();
  await until(() => held !== undefined);
  const excess = request(t, proxyB.port, "POST");
  excess.client.end("do not send");
  assert.equal((await within(excess.result)).status, 503);
  assert.equal(posts, 0);
  assert.equal(resources.budget.used.httpRequests, 1);
  held.end("done");
  await within(active.result);
  await until(() => resources.budget.used.httpRequests === 0);
  const fresh = request(t, proxyB.port, "POST");
  fresh.client.end("fresh");
  assert.deepEqual(await within(fresh.result), { status: 200, body: "B" });
  assert.equal(posts, 1);
});

test("HTTP waiting admission is shared across pools and cancellation releases it immediately", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ queuedHttpRequests: 1 }) });
  const responses: http.ServerResponse[] = [];
  let posts = 0;
  const handler = (incoming: http.IncomingMessage, response: http.ServerResponse) => {
    if (incoming.method === "POST") { posts++; response.end("unexpected"); }
    else { responses.push(response); response.write("held"); }
  };
  const a = await listen(t, http.createServer(handler));
  const b = await listen(t, http.createServer(handler));
  const proxyA = await openBrowser(t, resources, a, { maxConcurrentHttpRequests: 1 });
  const proxyB = await openBrowser(t, resources, b, { maxConcurrentHttpRequests: 1 });
  const activeA = request(t, proxyA.port), activeB = request(t, proxyB.port);
  activeA.result.catch(() => {}); activeB.result.catch(() => {});
  activeA.client.end(); activeB.client.end();
  await until(() => responses.length === 2);
  const waiting = request(t, proxyA.port, "POST");
  waiting.result.catch(() => {});
  waiting.client.end("canceled");
  await until(() => resources.budget.used.queuedHttpRequests === 1);
  const excess = request(t, proxyB.port, "POST");
  excess.client.end("do not send");
  assert.equal((await within(excess.result)).status, 503);
  waiting.client.destroy();
  await until(() => resources.budget.used.queuedHttpRequests === 0);
  for (const response of responses) response.end();
  await within(Promise.all([activeA.result, activeB.result]));
  await delay(20);
  assert.equal(posts, 0);
});

test("HTTP idle sockets share a cap and expiry while active SSE outlives that expiry", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ idleSockets: 1 }), idleSocketTtlMs: 80 });
  let sse!: http.ServerResponse;
  const ssePort = await listen(t, http.createServer((_request, response) => { sse = response; response.write("SSE"); }));
  const echoA = await listen(t, http.createServer((_request, response) => response.end("A")));
  const echoB = await listen(t, http.createServer((_request, response) => response.end("B")));
  const active = await openBrowser(t, resources, ssePort);
  const a = await openBrowser(t, resources, echoA), b = await openBrowser(t, resources, echoB);
  const stream = request(t, active.port);
  stream.result.catch(() => {}); stream.client.end();
  await until(() => sse !== undefined);
  for (const port of [a.port, b.port]) {
    const next = request(t, port); next.client.end();
    assert.equal((await within(next.result)).status, 200);
  }
  await until(() => resources.budget.used.idleSockets === 1 && resources.budget.used.upstreams === 2);
  // Expiry removes pool eligibility before asynchronous fd close returns the
  // upstream lease. Wait for both events instead of assuming the same turn.
  await until(() => resources.budget.used.idleSockets === 0 && resources.budget.used.upstreams === 1);
  assert.equal(sse.destroyed, false);
  sse.end(" done");
  assert.equal((await within(stream.result)).body, "SSE done");
});

test("native capacity reservations constrain mixed owners and return only on helper exit", {
  skip: process.platform === "win32" || !fs.existsSync(process.env.PORT_MANAGER_TEST_NATIVE_HOST_PROXY_PATH
    ?? path.resolve(__dirname, "../../../media/native/portmanager_host_exposure_proxy")), timeout: 10000,
}, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ nativeHelpers: 1, connections: 2 }),
    nativeConnectionsPerHelper: 1, nativeDnsJobsPerHelper: 1 });
  const targetPort = await listen(t, net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket)));
  const helper = process.env.PORT_MANAGER_TEST_NATIVE_HOST_PROXY_PATH
    ?? path.resolve(__dirname, "../../../media/native/portmanager_host_exposure_proxy");
  const native = await openHost(t, resources, targetPort, helper);
  const fallback = await openHost(t, resources, targetPort, helper);
  const handles = (native.manager as unknown as { listeners: Map<string, object> }).listeners;
  assert.equal(handles.get(native.exposure.id)?.constructor.name, "NativeHostPortProxyProcess");
  assert.equal(resources.budget.used.nativeHelpers, 1);
  const a = await connect(t, native.port), b = await connect(t, fallback.port);
  await echo(a, "native"); await echo(b, "node");
  const excess = await connect(t, fallback.port); await closed(excess);
  await echo(a, "still native"); await echo(b, "still node");
  await native.manager.dispose();
  await until(() => resources.budget.used.nativeHelpers === 0);
  assert.equal(resources.budget.used.dnsJobs, 0);
  assert.equal(resources.budget.used.connections, 1);
});

test("native logical router keeps its reserved capacity through listener retirement and shares it with host fallback", {
  skip: process.platform === "win32" || !fs.existsSync(process.env.PORT_MANAGER_TEST_NATIVE_ROUTER_PATH
    ?? path.resolve(__dirname, "../../../media/native/portmanager_tcp_router")), timeout: 10000,
}, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ nativeHelpers: 1, connections: 2 }),
    nativeConnectionsPerHelper: 1, nativeDnsJobsPerHelper: 1 });
  const targetPort = await listen(t, net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket)));
  const router = new LogicalPortRouterManager({ resolve: () => ({ host: "127.0.0.1", port: targetPort }) }, { resources,
    nativeRouterPath: process.env.PORT_MANAGER_TEST_NATIVE_ROUTER_PATH
      ?? path.resolve(__dirname, "../../../media/native/portmanager_tcp_router") });
  t.after(() => router.dispose());
  const port = await availablePort();
  await router.open(port);
  const handles = (router as unknown as { listeners: Map<number, object> }).listeners;
  assert.equal(handles.get(port)?.constructor.name, "NativeLogicalPortRouterPortHandle");
  const host = await openHost(t, resources, targetPort, process.env.PORT_MANAGER_TEST_NATIVE_HOST_PROXY_PATH
    ?? path.resolve(__dirname, "../../../media/native/portmanager_host_exposure_proxy"));
  const a = await connect(t, port), b = await connect(t, host.port);
  await echo(a, "router"); await echo(b, "fallback");
  const excess = await connect(t, host.port); await closed(excess);
  await router.releaseAll();
  await until(() => resources.budget.used.listeners === 1);
  assert.equal(resources.budget.used.nativeHelpers, 1, "the warm child still owns accepted streams");
  await echo(a, "retired listener still streams");
  router.dispose();
  await until(() => resources.budget.used.nativeHelpers === 0);
  await echo(b, "host remains");
});

test("logical router fallback also consumes the shared client and listener budget", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ connections: 1 }) });
  const targetPort = await listen(t, net.createServer(socket => socket.pipe(socket)));
  const host = await openHost(t, resources, targetPort);
  const router = new LogicalPortRouterManager({ resolve: () => ({ host: "127.0.0.1", port: targetPort }) }, { resources });
  t.after(() => router.dispose());
  const routerPort = await availablePort();
  await router.open(routerPort);
  const live = await connect(t, host.port); await echo(live, "live");
  const refused = await connect(t, routerPort); await closed(refused);
  await echo(live, "safe");
});

test("native CLOSE waits for shared control capacity and reopen cannot release the new listener lease", {
  skip: process.platform === "win32" || !fs.existsSync(process.env.PORT_MANAGER_TEST_NATIVE_ROUTER_PATH
    ?? path.resolve(__dirname, "../../../media/native/portmanager_tcp_router")), timeout: 10000,
}, async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ listeners: 2, controlBytes: 1024 }),
    nativeConnectionsPerHelper: 2 });
  const targetPort = await listen(t, net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket)));
  const router = new LogicalPortRouterManager({ resolve: () => ({ host: "127.0.0.1", port: targetPort }) }, { resources,
    nativeRouterPath: process.env.PORT_MANAGER_TEST_NATIVE_ROUTER_PATH
      ?? path.resolve(__dirname, "../../../media/native/portmanager_tcp_router") });
  t.after(() => router.dispose());
  const port = await availablePort();
  await router.open(port);
  const live = await connect(t, port); await echo(live, "live");
  await until(() => resources.budget.used.controlBytes === 0);
  let resume!: () => void;
  const blocked = new Writable({ write(_chunk, _encoding, done) { resume = done; } });
  t.after(() => blocked.destroy());
  assert.equal(resources.writeControl(blocked, "x".repeat(1023) + "\n"), true);
  const closing = router.close(port);
  const reopening = router.open(port);
  closing.catch(() => {}); reopening.catch(() => {});
  await echo(live, "survives control overload");
  assert.equal(resources.budget.used.listeners, 2, "sending CLOSE is not proof that the old fd was closed");
  resume();
  await within(Promise.all([closing, reopening]));
  assert.equal(resources.budget.used.listeners, 2, "old CLOSED cannot free the reopened listener's capacity");
  const fresh = await connect(t, port); await echo(fresh, "reopened");
});

test("logical router pending route cancellation returns clients without opening a late target", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources();
  let complete!: (target: { host: string; port: number }) => void;
  let accepts = 0;
  const targetPort = await listen(t, net.createServer(() => { accepts++; }));
  const router = new LogicalPortRouterManager({ resolve: () => new Promise(resolve => { complete = resolve; }) }, { resources });
  t.after(() => router.dispose());
  const port = await availablePort();
  await router.open(port);
  const client = await connect(t, port);
  await until(() => resources.pendingRouteWaiters === 1);
  client.resetAndDestroy();
  await until(() => resources.pendingRouteWaiters === 0 && resources.budget.used.connections === 0);
  assert.equal(resources.budget.used.routeJobs, 1);
  complete({ host: "127.0.0.1", port: targetPort });
  await until(() => resources.budget.used.routeJobs === 0);
  await delay(20);
  assert.equal(accepts, 0);
});

test("logical router FIN preserves a delayed response without freeing upstream capacity early", { timeout: 10000 }, async t => {
  const resources = new ProxyNetworkResources();
  const targetPort = await listen(t, net.createServer({ allowHalfOpen: true }, socket => {
    let payload = "";
    socket.on("data", data => { payload += data; });
    socket.on("end", () => { setTimeout(() => socket.end("reply:" + payload), 40); });
  }));
  const router = new LogicalPortRouterManager({ resolve: () => ({ host: "127.0.0.1", port: targetPort }) }, { resources });
  t.after(() => router.dispose());
  const port = await availablePort();
  await router.open(port);
  const client = await connect(t, port);
  let body = "";
  client.on("data", data => { body += data; });
  const end = within(once(client, "end"));
  client.end("request");
  await end;
  assert.equal(body, "reply:request");
  await until(() => resources.budget.used.connections === 0 && resources.budget.used.upstreams === 0);
});

test("double close cannot return a live native child's capacity during shutdown", {
  skip: process.platform === "win32", timeout: 10000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-budget-child-"));
  const helper = path.join(directory, "helper");
  fs.writeFileSync(helper, ["#!/usr/bin/env node", 'process.on("SIGTERM", () => {});',
    'process.stdout.write(["READY", process.argv[2], process.argv[3]].join("\\t") + "\\n");',
    "process.stdin.resume();"].join("\n"), { mode: 0o755 });
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ nativeHelpers: 1 }) });
  const host = await openHost(t, resources, 1, helper);
  t.after(async () => {
    await host.manager.dispose();
    await until(() => resources.budget.used.nativeHelpers === 0);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const handles = (host.manager as unknown as { listeners: Map<string, { close(): Promise<void> }> }).listeners;
  const handle = handles.get(host.exposure.id)!;
  const first = handle.close();
  await handle.close();
  assert.equal(resources.budget.used.nativeHelpers, 1);
  await first;
  await until(() => resources.budget.used.nativeHelpers === 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a custom asynchronous HTTP Agent keeps its upstream permit until factory completion and socket close", async t => {
  const resources = new ProxyNetworkResources({ budget: new ProxyResourceBudget({ upstreams: 1 }) });
  const agent = new http.Agent();
  let finish!: NonNullable<Parameters<http.Agent["createConnection"]>[1]>;
  agent.createConnection = (_options, callback) => { finish = callback!; return undefined; };
  resources.configureAgent(agent);
  const created: net.Socket[] = [];
  assert.equal(agent.createConnection({ host: "test.invalid", port: 1 }, (_error, socket) => created.push(socket as net.Socket)), undefined);
  assert.equal(resources.budget.used.upstreams, 1);
  assert.throws(() => resources.connect({ host: "127.0.0.1", port: 1 }), ProxyResourceLimitError);
  const socket = new net.Socket();
  t.after(() => { socket.destroy(); agent.destroy(); });
  finish(null, socket);
  assert.deepEqual(created, [socket]);
  const fdClosed = new Promise<void>(resolve => socket.once("close", resolve));
  socket.destroy();
  assert.equal(resources.budget.used.upstreams, 1, "destroy is not the fd close event");
  await fdClosed;
  assert.equal(resources.budget.used.upstreams, 0);
});

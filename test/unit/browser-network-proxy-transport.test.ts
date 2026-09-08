import assert from "node:assert/strict";
import { once } from "node:events";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  BrowserNetworkProxyManager,
  type ActiveBrowserNetworkProxyEndpoint,
  type BrowserNetworkProxyOptions,
  type BrowserNetworkProxyTarget,
  type BrowserNetworkProxyTargetResolver,
} from "../../src/platform/ports/browser-network-proxy";
import { BrowserNetworkProxyTransport } from "../../src/platform/ports/browser-network-proxy-transport";
import { buildEndpointMetadata } from "../../src/platform/ports/browser-network-proxy-http";

const endpoint: ActiveBrowserNetworkProxyEndpoint = {
  id: "network-a:3004", networkId: "network-a", logicalPort: 3004,
  listenHost: "127.0.0.1", listenPorts: [], listenPort: 3004, publicHost: "alpha.pm",
};
const HTTP_REQUEST = "GET / HTTP/1.1\r\nHost: alpha.pm\r\nConnection: close\r\n\r\n";
const UPGRADE_REQUEST = "GET /ws HTTP/1.1\r\nHost: alpha.pm\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";

/** Keep fixtures bounded independently of the implementation's own deadlines. */
async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("fixture exceeded its deadline")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function listen(context: TestContext, server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as net.AddressInfo).port;
}

async function openProxy(context: TestContext, resolver: BrowserNetworkProxyTargetResolver, options: BrowserNetworkProxyOptions = {}) {
  const reservation = net.createServer();
  const port = await listen(context, reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const proxy = new BrowserNetworkProxyManager(resolver, options);
  context.after(() => proxy.dispose());
  assert.ok(await proxy.ensure({ ...endpoint, listenPorts: [port] }));
  return { proxy, port };
}

function request(port: number, path = "/", method = "GET") {
  let client!: http.ClientRequest;
  const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
    client = http.request({ host: "127.0.0.1", port, path, method, agent: false, headers: { connection: "keep-alive" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    client.once("error", reject);
  });
  return { client, result };
}

async function connect(context: TestContext, port: number): Promise<net.Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  context.after(() => { socket.destroy(); });
  await within(once(socket, "connect"));
  return socket;
}

function waitForText(socket: net.Socket, expected: string): Promise<string> {
  return within(new Promise((resolve, reject) => {
    let text = "";
    const cleanup = () => { socket.off("data", data); socket.off("close", closed); };
    const data = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes(expected)) { cleanup(); resolve(text); }
    };
    const closed = () => { cleanup(); reject(new Error(`socket closed before ${expected}: ${text}`)); };
    socket.on("data", data);
    socket.once("close", closed);
  }));
}

for (const settlement of ["resolve", "reject"] as const) {
  test(`HTTP route timeout returns 504 and ignores late ${settlement} without delivering a POST`, async (context) => {
    let connections = 0;
    const backend = http.createServer((_request, response) => response.end("unexpected"));
    backend.on("connection", () => { connections++; });
    const backendPort = await listen(context, backend);
    const route = deferred<BrowserNetworkProxyTarget>();
    const { port } = await openProxy(context, { resolve: () => route.promise }, { resolveTimeoutMs: 40 });
    const { client, result } = request(port, "/write", "POST");
    context.after(() => client.destroy());
    client.end("do-not-replay");
    assert.equal((await within(result)).status, 504);
    if (settlement === "resolve") route.resolve({ host: "127.0.0.1", port: backendPort });
    else route.reject(new Error("late lookup failure"));
    await delay(30);
    assert.equal(connections, 0);
  });
}

test("HTTP resolver failures and invalid targets produce a complete 502 response", async (context) => {
  for (const resolve of [() => Promise.reject(), () => ({ host: "127.0.0.1", port: -1 })]) {
    const { port } = await openProxy(context, { resolve }, { resolveTimeoutMs: 40 });
    const { client, result } = request(port);
    context.after(() => client.destroy());
    client.end();
    assert.equal((await within(result)).status, 502);
  }
});

test("owner release drops pending HTTP, upgrade, and raw routes before late resolution", async (context) => {
  let connections = 0;
  const backend = net.createServer((socket) => socket.resume());
  backend.on("connection", () => { connections++; });
  const backendPort = await listen(context, backend);
  const routes: ReturnType<typeof deferred<BrowserNetworkProxyTarget>>[] = [];
  const entered = deferred<void>();
  const { proxy, port } = await openProxy(context, { resolve: () => {
    const route = deferred<BrowserNetworkProxyTarget>();
    routes.push(route);
    if (routes.length === 3) entered.resolve();
    return route.promise;
  } });
  for (const payload of [HTTP_REQUEST, UPGRADE_REQUEST, "\0raw"]) {
    const socket = await connect(context, port);
    socket.write(payload);
  }
  await within(entered.promise);
  await proxy.releaseAll();
  for (const route of routes) route.resolve({ host: "127.0.0.1", port: backendPort });
  await delay(30);
  assert.equal(connections, 0, "late work must not survive the old owner's listeners");
});

for (const kind of ["raw", "upgrade"] as const) {
  test(`${kind} cancellation releases its resolver wait before the resolver settles`, async () => {
    const route = deferred<BrowserNetworkProxyTarget>();
    const client = new net.Socket();
    const transport = new BrowserNetworkProxyTransport({ resolve: () => route.promise }, { resolveTimeoutMs: 10_000 });
    const work = kind === "raw" ? transport.rawForward(endpoint, client, new Set())
      : transport.forwardUpgrade(endpoint, buildEndpointMetadata(endpoint), new http.IncomingMessage(client), client, Buffer.alloc(0), new Set());
    client.destroy();
    await within(work, 250);
    route.reject(new Error("shared refresh ended later"));
  });

  test(`${kind} unanswered TCP setup is destroyed at the connection deadline`, async (context) => {
    // A socket that never emits connect represents dropped SYNs deterministically;
    // TLS setup below is additionally exercised over real loopback sockets.
    const stalled = new net.Socket();
    Object.defineProperty(stalled, "connecting", { value: true });
    context.mock.method(require("node:net") as typeof net, "createConnection", () => stalled);
    const client = new net.Socket();
    const sockets = new Set<net.Socket>();
    context.after(() => { client.destroy(); stalled.destroy(); });
    const transport = new BrowserNetworkProxyTransport({ resolve: () => ({ host: "127.0.0.1", port: 3004 }) }, { connectTimeoutMs: 40 });
    const closed = once(client, "close");
    if (kind === "raw") await transport.rawForward(endpoint, client, sockets);
    else await transport.forwardUpgrade(endpoint, buildEndpointMetadata(endpoint), new http.IncomingMessage(client), client, Buffer.alloc(0), sockets);
    await within(closed);
    assert.ok(stalled.destroyed);
    await delay(0);
    assert.equal(sockets.size, 0);
  });
}

test("HTTP and upgrade TLS handshakes time out and the next fresh route succeeds", async (context) => {
  let openSockets = 0;
  let hellos = 0;
  const stalled = net.createServer((socket) => {
    openSockets++;
    socket.on("data", () => { hellos++; });
    socket.once("close", () => { openSockets--; });
  });
  const stalledPort = await listen(context, stalled);
  const healthyPort = await listen(context, http.createServer((_request, response) => response.end("recovered")));
  let target: BrowserNetworkProxyTarget = { host: "127.0.0.1", port: stalledPort, protocol: "https" };
  const { port } = await openProxy(context, { resolve: () => target }, { connectTimeoutMs: 80 });
  const { client, result } = request(port);
  context.after(() => client.destroy());
  client.end();
  assert.equal((await within(result)).status, 504);
  const websocket = await connect(context, port);
  const closed = once(websocket, "close");
  websocket.write(UPGRADE_REQUEST);
  await within(closed);
  const deadline = Date.now() + 1000;
  while (openSockets > 0 && Date.now() < deadline) await delay(5);
  assert.ok(hellos >= 2, "TCP connected and sent ClientHello before the TLS deadline");
  assert.equal(openSockets, 0);
  target = { host: "127.0.0.1", port: healthyPort };
  const recovery = request(port);
  context.after(() => recovery.client.destroy());
  recovery.client.end();
  assert.deepEqual(await within(recovery.result), { status: 200, body: "recovered" });
});

test("slow HTTP responses and uploads outlive setup deadlines on reused sockets", async (context) => {
  let connections = 0;
  const firstUpload = deferred<void>();
  const backend = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk; firstUpload.resolve(); });
    request.on("end", () => { setTimeout(() => response.end(body || "slow response"), 150); });
  });
  backend.on("connection", () => { connections++; });
  const backendPort = await listen(context, backend);
  const { port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) }, { connectTimeoutMs: 40, resolveTimeoutMs: 40 });
  const first = request(port);
  context.after(() => first.client.destroy());
  first.client.end();
  assert.deepEqual(await within(first.result), { status: 200, body: "slow response" });
  const second = request(port, "/upload", "POST");
  context.after(() => second.client.destroy());
  second.client.write("first-");
  await within(firstUpload.promise);
  await delay(150);
  second.client.end("last");
  assert.deepEqual(await within(second.result), { status: 200, body: "first-last" });
  assert.equal(connections, 1, "connection deadline cleanup must preserve the pool");
});

test("reused HTTPS sockets do not wait for a second secureConnect event", async (context) => {
  let connections = 0;
  const backend = https.createServer(TLS_IDENTITY, (_request, response) => {
    setTimeout(() => response.end("secure slow response"), 150);
  });
  backend.on("secureConnection", () => { connections++; });
  const backendPort = await listen(context, backend);
  const { port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort, protocol: "https" }) }, { connectTimeoutMs: 60 });
  for (let index = 0; index < 2; index++) {
    const { client, result } = request(port);
    context.after(() => client.destroy());
    client.end();
    assert.deepEqual(await within(result), { status: 200, body: "secure slow response" });
  }
  assert.equal(connections, 1);
});

test("an HTTPS request queued behind a busy socket gets a fresh setup decision after reuse", async (context) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  context.after(() => release.resolve());
  let requests = 0;
  let connections = 0;
  const backend = https.createServer(TLS_IDENTITY, (_request, response) => {
    requests++;
    if (requests === 1) { entered.resolve(); void release.promise.then(() => response.end("first")); }
    else setTimeout(() => response.end("second"), 150);
  });
  backend.on("secureConnection", () => { connections++; });
  const backendPort = await listen(context, backend);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
  const httpAgent = new http.Agent({ keepAlive: true });
  context.after(() => { agent.destroy(); httpAgent.destroy(); });
  const transport = new BrowserNetworkProxyTransport({ resolve: () => ({ host: "127.0.0.1", port: backendPort, protocol: "https" }) }, { connectTimeoutMs: 60 });
  const frontend = http.createServer((request, response) => {
    void transport.forwardHttp(endpoint, buildEndpointMetadata(endpoint), httpAgent, agent, request, response);
  });
  const port = await listen(context, frontend);
  const first = request(port);
  context.after(() => first.client.destroy());
  first.client.end();
  await within(entered.promise);
  const second = request(port);
  context.after(() => second.client.destroy());
  second.client.end();
  await delay(120);
  assert.equal(requests, 1, "the occupied pool must keep the second request queued");
  assert.ok(Object.values(agent.requests).every((queue) => (queue?.length ?? 0) === 0), "admission must precede ClientRequest creation");
  release.resolve();
  assert.deepEqual(await within(first.result), { status: 200, body: "first" });
  assert.deepEqual(await within(second.result), { status: 200, body: "second" });
  assert.equal(connections, 1);
});

test("idle SSE, WebSocket and raw streams continue beyond connection setup budgets", async (context) => {
  const backend = net.createServer((socket) => {
    socket.once("data", (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      if (text.includes("GET /events ")) {
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n6\r\nfirst\n\r\n");
        setTimeout(() => socket.write("5\r\nlast\n\r\n"), 150);
      } else {
        if (/upgrade: websocket/i.test(text)) socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
        else socket.write(chunk);
        socket.pipe(socket);
      }
    });
  });
  const backendPort = await listen(context, backend);
  const { port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) }, { connectTimeoutMs: 40 });
  const events = await connect(context, port);
  const eventData = waitForText(events, "last\n");
  events.write(HTTP_REQUEST.replace("GET / ", "GET /events "));
  await eventData;
  for (const message of [UPGRADE_REQUEST, "\0raw-first"]) {
    const socket = await connect(context, port);
    const ready = waitForText(socket, message === UPGRADE_REQUEST ? "101 Switching Protocols" : "raw-first");
    socket.write(message);
    await ready;
    await delay(150);
    const echo = waitForText(socket, "still-live");
    socket.write("still-live");
    await echo;
  }
});

test("every fragmented HTTP method retains Host and response origin rewriting", async (context) => {
  const requests: { method: string | undefined; host: string | undefined }[] = [];
  const backend = http.createServer((request, response) => {
    requests.push({ method: request.method, host: request.headers.host });
    response.writeHead(200, { "content-type": "text/html", "connection": "close", "x-seen-host": request.headers.host });
    response.end("http://localhost:3004/path");
  });
  const backendPort = await listen(context, backend);
  const { port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) });
  for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "TRACE"]) {
    const socket = await connect(context, port);
    const received = waitForText(socket, method === "HEAD" ? "x-seen-host: localhost:3004" : `http://alpha.pm:${port}/`);
    for (const byte of method) { socket.write(byte); await delay(5); }
    socket.write(" / HTTP/1.1\r\nHost: alpha.pm\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    await received;
  }
  assert.equal(requests.length, 8);
  assert.ok(requests.every((request) => request.host === "localhost:3004"));
});

test("ambiguous and divergent raw prefixes keep every byte and cancellation drops their sniff timer", async (context) => {
  let resolutions = 0;
  const backendPort = await listen(context, net.createServer((socket) => socket.pipe(socket)));
  const { port } = await openProxy(context, { resolve: () => {
    resolutions++; return { host: "127.0.0.1", port: backendPort };
  } }, { sniffTimeoutMs: 40 });
  for (const payload of ["G", "GE", "GETX", "OPTIONS?"]) {
    const socket = await connect(context, port);
    const echoed = waitForText(socket, payload);
    socket.write(payload.slice(0, 1));
    await delay(5);
    socket.write(payload.slice(1));
    assert.equal(await echoed, payload);
    socket.destroy();
  }
  const canceled = await connect(context, port);
  canceled.write("G");
  await delay(5);
  canceled.resetAndDestroy();
  await delay(80);
  assert.equal(resolutions, 4, "an abandoned partial method must not open an upstream after its timer fires");
});

test("server-first greetings arrive without client bytes and preserve duplex traffic", async (context) => {
  const backendPort = await listen(context, net.createServer((socket) => {
    socket.write("READY\r\n");
    socket.pipe(socket);
  }));
  const { port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) }, { serverGreetingDelayMs: 20 });
  const socket = await connect(context, port);
  assert.equal(await waitForText(socket, "READY\r\n"), "READY\r\n");
  const echo = waitForText(socket, "client reply");
  socket.write("client reply");
  assert.equal(await echo, "client reply");
});

for (const protocol of ["http", "https"] as const) {
  test(`a delayed ${protocol} client cancels its greeting probe and still rewrites origins`, async (context) => {
    const probeAccepted = deferred<void>();
    const probeClosed = deferred<void>();
    let connections = 0;
    const backend = http.createServer((request, response) => {
      assert.equal(request.headers.host, "localhost:3004");
      response.writeHead(200, { "content-type": "text/html" });
      response.end("http://localhost:3004/rewritten");
    });
    backend.on("connection", (socket) => {
      if (++connections === 1) { probeAccepted.resolve(); socket.once("close", () => probeClosed.resolve()); }
    });
    const backendPort = await listen(context, backend);
    const { proxy, port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) }, {
      serverGreetingDelayMs: 20, tlsCredentials: { getCredentials: () => TLS_IDENTITY },
    });
    await proxy.ensure({ ...endpoint, publicProtocol: protocol, listenPorts: [port] });
    const raw = await connect(context, port);
    await within(probeAccepted.promise);
    const socket = protocol === "https" ? tls.connect({ socket: raw, rejectUnauthorized: false }) : raw;
    socket.on("error", () => {});
    context.after(() => socket.destroy());
    if (protocol === "https") await within(once(socket, "secureConnect"));
    const rewritten = waitForText(socket, `${protocol}://alpha.pm:${port}/rewritten`);
    socket.write(HTTP_REQUEST);
    await rewritten;
    await within(probeClosed.promise);
    assert.equal(connections, 2, "one canceled probe and one actual HTTP request");
  });
}

test("canceling an idle greeting lookup consumes late results without opening a backend", async (context) => {
  const route = deferred<BrowserNetworkProxyTarget>();
  const resolving = deferred<void>();
  let connections = 0;
  const backendPort = await listen(context, net.createServer(() => { connections++; }));
  const { proxy, port } = await openProxy(context, { resolve: () => { resolving.resolve(); return route.promise; } }, { serverGreetingDelayMs: 20 });
  await connect(context, port);
  await within(resolving.promise);
  await proxy.releaseAll();
  route.resolve({ host: "127.0.0.1", port: backendPort });
  await delay(40);
  assert.equal(connections, 0);
});

test("bounded admission removes canceled POSTs immediately and rejects overflow without upstream delivery", async (context) => {
  const held = deferred<void>();
  const release = deferred<void>();
  const received: string[] = [];
  context.after(() => release.resolve());
  const backendPort = await listen(context, http.createServer((request, response) => {
    received.push(request.url!);
    if (request.url === "/hold") { held.resolve(); void release.promise.then(() => response.end("held")); }
    else response.end("accepted");
  }));
  const { port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) }, {
    maxConcurrentHttpRequests: 1, maxQueuedHttpRequests: 1, queueTimeoutMs: 1500,
  });
  const first = request(port, "/hold"); first.client.end(); context.after(() => first.client.destroy());
  await within(held.promise);
  for (let index = 0; index < 4; index++) {
    const canceled = request(port, `/canceled-${index}`, "POST");
    const outcome = canceled.result.catch(() => undefined);
    canceled.client.end("must not be replayed");
    await delay(20);
    const overflow = request(port, "/overflow"); overflow.client.end();
    context.after(() => overflow.client.destroy());
    assert.equal((await within(overflow.result)).status, 503);
    canceled.client.destroy();
    await within(outcome);
    await delay(20);
  }
  const last = request(port, "/last"); last.client.end(); context.after(() => last.client.destroy());
  await delay(30);
  assert.deepEqual(received, ["/hold"]);
  release.resolve();
  assert.equal((await within(first.result)).status, 200);
  assert.deepEqual(await within(last.result), { status: 200, body: "accepted" });
  assert.deepEqual(received, ["/hold", "/last"]);
});

test("HTTP admission expires while SSE stays alive and different targets remain independent", async (context) => {
  const streamReady = deferred<void>();
  let stream: http.ServerResponse | undefined;
  let writes = 0;
  const backendPort = await listen(context, http.createServer((request, response) => {
    if (request.url === "/events") {
      stream = response;
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: ready\n\n");
    } else { writes++; response.end("written"); }
  }));
  const secondPort = await listen(context, http.createServer((_request, response) => response.end("independent")));
  let targetPort = backendPort;
  const { port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: targetPort }) }, {
    maxConcurrentHttpRequests: 1, queueTimeoutMs: 60, connectTimeoutMs: 30,
  });
  const events = http.get({ host: "127.0.0.1", port, path: "/events", agent: false }, (response) => {
    response.on("data", () => streamReady.resolve()); response.on("error", () => {});
  });
  events.on("error", () => {}); context.after(() => events.destroy());
  await within(streamReady.promise);
  const queued = request(port, "/write", "POST"); queued.client.end("do not deliver"); context.after(() => queued.client.destroy());
  assert.equal((await within(queued.result)).status, 504);
  assert.equal(writes, 0);
  assert.equal(stream?.destroyed, false, "queue timeout must not terminate the active SSE stream");
  targetPort = secondPort;
  const independent = request(port); independent.client.end(); context.after(() => independent.client.destroy());
  assert.deepEqual(await within(independent.result), { status: 200, body: "independent" });
  stream!.end();
  targetPort = backendPort;
  const recovered = request(port, "/after"); recovered.client.end(); context.after(() => recovered.client.destroy());
  assert.equal((await within(recovered.result)).status, 200);
  assert.equal(writes, 1, "expired POSTs must never be replayed when capacity returns");
});

test("owner release cancels queued HTTP requests without delivering them on a later permit", async (context) => {
  const held = deferred<void>();
  const received: string[] = [];
  const backendPort = await listen(context, http.createServer((request) => { received.push(request.url!); held.resolve(); }));
  const { proxy, port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) }, { maxConcurrentHttpRequests: 1 });
  const first = request(port, "/hold"); const firstResult = first.result.catch(() => undefined); first.client.end();
  context.after(() => first.client.destroy());
  await within(held.promise);
  const queued = request(port, "/queued"); const queuedResult = queued.result.catch(() => undefined); queued.client.end();
  context.after(() => queued.client.destroy());
  await delay(25);
  await proxy.releaseAll();
  await within(Promise.all([firstResult, queuedResult]));
  await delay(25);
  assert.deepEqual(received, ["/hold"]);
});


for (const protocol of ["http", "https"] as const) {
  test(`queued POST rechecks its route and moves to the current ${protocol} origin exactly once`, async (context) => {
    const held = deferred<http.ServerResponse>();
    const received: string[] = [];
    const oldPort = await listen(context, http.createServer((incoming, response) => {
      received.push("old:" + incoming.url); held.resolve(response);
    }));
    const handle: http.RequestListener = (incoming, response) => {
      let body = "";
      incoming.on("data", chunk => { body += chunk.toString(); });
      incoming.on("end", () => { received.push("new:" + incoming.url + ":" + body); response.end("new-server"); });
    };
    const newPort = await listen(context, protocol === "https" ? https.createServer(TLS_IDENTITY, handle) : http.createServer(handle));
    let target: BrowserNetworkProxyTarget = { host: "127.0.0.1", port: oldPort };
    let resolutions = 0;
    const queuedLookup = deferred<void>();
    const { port } = await openProxy(context, { resolve: () => {
      if (++resolutions === 2) queuedLookup.resolve();
      return target;
    } }, { maxConcurrentHttpRequests: 1 });
    const first = request(port, "/hold"); first.client.end(); context.after(() => first.client.destroy());
    const hold = await within(held.promise);
    const queued = request(port, "/write", "POST"); queued.client.end("one-write"); context.after(() => queued.client.destroy());
    await within(queuedLookup.promise);
    await delay(20);
    target = { host: "127.0.0.1", port: newPort, protocol };
    hold.end("released");
    assert.deepEqual(await within(queued.result), { status: 200, body: "new-server" });
    await within(first.result);
    assert.deepEqual(received, ["old:/hold", "new:/write:one-write"]);
    assert.equal(resolutions, 3);
  });
}

test("moving a queued request between busy origins keeps the original deadline", async (context) => {
  const heldA = deferred<http.ServerResponse>(), heldB = deferred<http.ServerResponse>();
  const received: string[] = [];
  const a = await listen(context, http.createServer((incoming, response) => { received.push("a:" + incoming.url); heldA.resolve(response); }));
  const b = await listen(context, http.createServer((incoming, response) => { received.push("b:" + incoming.url); heldB.resolve(response); }));
  let target = a, calls = 0;
  const queuedLookup = deferred<void>(), movedLookup = deferred<void>();
  const { port } = await openProxy(context, { resolve: () => {
    calls++;
    if (calls === 2) queuedLookup.resolve();
    if (calls === 4) movedLookup.resolve();
    return { host: "127.0.0.1", port: target };
  } }, { maxConcurrentHttpRequests: 1, queueTimeoutMs: 300 });
  const first = request(port, "/hold-a"); first.client.end(); context.after(() => first.client.destroy());
  const holdA = await within(heldA.promise);
  const queued = request(port, "/write", "POST"); queued.client.end("never-send"); context.after(() => queued.client.destroy());
  await within(queuedLookup.promise);
  const started = performance.now();
  target = b;
  const second = request(port, "/hold-b"); second.client.end(); context.after(() => second.client.destroy());
  const holdB = await within(heldB.promise);
  await delay(180);
  holdA.end("a");
  await within(movedLookup.promise);
  assert.equal((await within(queued.result)).status, 504);
  assert.ok(performance.now() - started < 430, "migration must not restart the 300ms budget");
  assert.deepEqual(received, ["a:/hold-a", "b:/hold-b"]);
  holdB.end("b");
  await within(Promise.all([first.result, second.result]));
});

test("a stalled route recheck expires and a canceled recheck never sends the POST", async (context) => {
  for (const cancel of [false, true]) {
    const held = deferred<http.ServerResponse>(), rechecking = deferred<void>();
    const lookup = deferred<BrowserNetworkProxyTarget>();
    const received: string[] = [];
    const backendPort = await listen(context, http.createServer((incoming, response) => {
      received.push(incoming.url!);
      if (incoming.url === "/hold") held.resolve(response); else response.end("unexpected");
    }));
    let calls = 0;
    const { proxy, port } = await openProxy(context, { resolve: () => {
      if (++calls === 3) { rechecking.resolve(); return lookup.promise; }
      return { host: "127.0.0.1", port: backendPort };
    } }, { maxConcurrentHttpRequests: 1, queueTimeoutMs: 150 });
    const first = request(port, "/hold"); first.client.end(); context.after(() => first.client.destroy());
    const hold = await within(held.promise);
    const queued = request(port, "/write", "POST"); queued.client.end("never-send"); context.after(() => queued.client.destroy());
    const outcome = queued.result.catch(() => undefined);
    await delay(30);
    hold.end("release");
    await within(rechecking.promise);
    if (cancel) {
      const listeners = (proxy as unknown as { listeners: Map<string, { sockets: Set<net.Socket> }> }).listeners;
      const frontend = [...listeners.get(endpoint.id)!.sockets].find(socket => socket.remotePort === queued.client.socket?.localPort)!;
      const closed = once(frontend, "close");
      queued.client.destroy();
      await within(closed, 100);
    }
    const result = await within(outcome);
    if (!cancel) assert.equal(result?.status, 504);
    lookup.resolve({ host: "127.0.0.1", port: backendPort });
    await delay(25);
    assert.deepEqual(received, ["/hold"]);
    await within(first.result);
    const recovered = request(port, "/recovered"); recovered.client.end(); context.after(() => recovered.client.destroy());
    assert.equal((await within(recovered.result)).status, 200, "recheck cancellation releases its permit");
  }
});

test("empty server-first EOF closes idle clients and releases every proxy socket", async (context) => {
  const backendPort = await listen(context, net.createServer(socket => socket.end()));
  const { proxy, port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) }, { serverGreetingDelayMs: 20 });
  const clients = await Promise.all(Array.from({ length: 12 }, () => connect(context, port)));
  await within(Promise.all(clients.map(socket => { socket.resume(); return once(socket, "close"); })));
  // Allow both peers' close callbacks to remove their ownership entries.
  await delay(20);
  const listeners = (proxy as unknown as { listeners: Map<string, { sockets: Set<net.Socket> }> }).listeners;
  assert.equal(listeners.get(endpoint.id)?.sockets.size, 0);
});

for (const payload of ["raw-query", "G", "GE"]) {
  test(`raw FIN preserves the prefix ${JSON.stringify(payload)} and drains a large delayed response`, async (context) => {
    const answer = Buffer.alloc(512 * 1024, 120);
    const backendPort = await listen(context, net.createServer({ allowHalfOpen: true }, socket => {
      let body = "";
      socket.on("data", chunk => { body += chunk.toString(); });
      socket.on("end", () => {
        assert.equal(body, payload);
        setTimeout(() => socket.end(Buffer.concat([Buffer.from(body + ":"), answer])), 25);
      });
    }));
    const { port } = await openProxy(context, { resolve: async () => {
      await delay(20); return { host: "127.0.0.1", port: backendPort };
    } });
    const client = await connect(context, port);
    const chunks: Buffer[] = [];
    client.on("data", chunk => chunks.push(chunk));
    const closed = once(client, "close");
    client.end(payload);
    await within(closed);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from(payload + ":"), answer]));
  });
}

test("a backend greeting plus FIN still allows the client to send its final reply", async (context) => {
  const reply = deferred<string>();
  const backendPort = await listen(context, net.createServer({ allowHalfOpen: true }, socket => {
    socket.end("READY\r\n");
    let body = "";
    socket.on("data", chunk => { body += chunk.toString(); });
    socket.on("end", () => reply.resolve(body));
  }));
  const { port } = await openProxy(context, { resolve: () => ({ host: "127.0.0.1", port: backendPort }) }, { serverGreetingDelayMs: 20 });
  const client = await connect(context, port);
  client.allowHalfOpen = true;
  let greeting = "";
  client.on("data", chunk => { greeting += chunk.toString(); });
  await within(once(client, "end"));
  assert.equal(greeting, "READY\r\n");
  const closed = once(client, "close");
  client.end("final-reply");
  assert.equal(await within(reply.promise), "final-reply");
  await within(closed);
});
// Disposable identity shared with the existing proxy tests; certificate validation
// is deliberately disabled for local development upstreams in production too.
const TLS_IDENTITY = {
  key: ["-----BEGIN EC PRIVATE KEY-----", "MHcCAQEEIDZb4xEoHQfbkJepy/ZcuiGP2yZT2sJvIvrUXmGWZrswoAoGCCqGSM49",
    "AwEHoUQDQgAElxFcMvH6ntfaQEbFPllq5UbHlszHDkY9HytoA6QMvdRY5SDw0kRY", "2CA+HZlSVGvyKTSDI2KXlILCDRzp9r39sw==", "-----END EC PRIVATE KEY-----"].join("\n"),
  cert: ["-----BEGIN CERTIFICATE-----", "MIIBPTCB46ADAgECAgkAwldsxvU6r/IwCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJ",
    "bG9jYWxob3N0MB4XDTI2MDcwMTExMDkwMVoXDTI2MDcwMjExMDkwMVowFDESMBAG", "A1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAElxFcMvH6",
    "ntfaQEbFPllq5UbHlszHDkY9HytoA6QMvdRY5SDw0kRY2CA+HZlSVGvyKTSDI2KX", "lILCDRzp9r39s6MeMBwwGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqG",
    "SM49BAMCA0kAMEYCIQDcaODSRujrhUdKGuUamG0d2/E5ZPqRQhGKFc2aoEN0BgIh", "AJ2jn5A6mS9hO3n71Qg38NpLWD9pG8kjc9ItMwZmb/8f", "-----END CERTIFICATE-----"].join("\n"),
};

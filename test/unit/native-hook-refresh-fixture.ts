import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";

/**
 * Drive one real preloaded client across route generations. The parent owns all
 * backends, files and sockets; the client retains open streams between commands
 * so a fresh process cannot hide stale per-process cache state.
 */
export async function exerciseHookedRouteRefresh(
  context: TestContext,
  directory: string,
  duringRefresh: () => Promise<void>,
  restartDns: () => Promise<void>,
): Promise<void> {
  const projectRoot = path.resolve(__dirname, "../../..");
  const library = process.env.PORT_MANAGER_TEST_NATIVE_HOOK_PATH ?? path.join(projectRoot, "media", "native", process.platform === "darwin"
    ? "libportmanager_hook.dylib" : "libportmanager_hook.so");
  assert.ok(fs.existsSync(library), "the integration test requires the actual built hook");
  const sockets = new Set<net.Socket>();
  const servers: net.Server[] = [];
  const streams: http.ServerResponse[] = [];
  let foreignConnections = 0;
  let client: ChildProcess | undefined;
  context.after(async () => {
    if (client !== undefined && client.exitCode === null) {
      const exited = new Promise<void>((resolve) => client!.once("exit", () => resolve()));
      client.kill("SIGKILL");
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  /** Keep sockets observable so fixture failure cannot leave close() waiting. */
  async function listen(server: net.Server): Promise<number> {
    servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return (server.address() as net.AddressInfo).port;
  }

  /** A raw protocol and two HTTP streams distinguish old and replacement peers. */
  async function backend(label: string): Promise<readonly [number, number]> {
    const tcpPort = await listen(net.createServer((socket) => {
      socket.write(`${label}\n`);
      socket.on("data", (chunk) => socket.write(`${label}:${chunk}`));
    }));
    const httpPort = await listen(http.createServer((request, response) => {
      if (request.url === "/probe") {
        response.end(`${label}\n`);
        return;
      }
      response.writeHead(200, { "content-type": request.url === "/events" ? "text/event-stream" : "text/plain" });
      response.write(`${label}:${request.url}\n`);
      if (label === "old") streams.push(response);
    }));
    return [tcpPort, httpPort];
  }

  const oldPorts = await backend("old");
  const newPorts = await backend("new");
  const sentinelPort = await listen(net.createServer((socket) => {
    foreignConnections += 1;
    socket.end("foreign-network-leak\n");
  }));
  // Reserve unused logical coordinates until every backend is allocated, then
  // close them. Fixed-protocol policy makes a missing scoped route fail closed.
  const reservations = [net.createServer(), net.createServer(), net.createServer()];
  const logicalPorts = await Promise.all(reservations.map(listen));
  await Promise.all(reservations.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  const networkId = "refresh-client-network";
  const routesPath = path.join(directory, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
  const expiry = Date.now() + 1_200;

  /** Foreign rows precede matching rows to detect accidental index scope leaks. */
  function document(ports: readonly number[], expiresAtMs: number): string {
    const foreign = logicalPorts.map((logicalPort) => ({
      logicalPort, actualPort: sentinelPort, networkId: "foreign-network", host: "127.0.0.1", routeDirection: "listen",
    }));
    const current = ports.map((actualPort, index) => ({
      logicalPort: logicalPorts[index], actualPort, networkId, host: "127.0.0.1", routeDirection: "listen",
    }));
    return JSON.stringify({ expiresAtMs, routes: [...foreign, ...current] }).padEnd(4096, " ");
  }
  fs.writeFileSync(routesPath, document(oldPorts, expiry));
  const originalStat = fs.statSync(routesPath);
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("PORT_MANAGER_") && !key.startsWith("NEWDLOPS_PM_") && !key.startsWith("DYLD_") && key !== "LD_PRELOAD"));
  client = spawn(process.execPath, ["-e", clientScript, JSON.stringify(logicalPorts)], {
    cwd: directory,
    env: {
      ...cleanEnvironment,
      [process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"]: library,
      PORT_MANAGER_DYLD_INSERT_LIBRARIES: process.platform === "darwin" ? library : "",
      PORT_MANAGER_LD_PRELOAD: process.platform === "linux" ? library : "",
      PORT_MANAGER_HOOK: "1",
      PORT_MANAGER_DEV_LOG: path.join(directory, "client-dev.log"),
      PORT_MANAGER_NETWORK_ID: networkId,
      PORT_MANAGER_ROUTES_FILE: routesPath,
      PORT_MANAGER_GLOBAL_ROUTES_FILE: routesPath,
      PORT_MANAGER_HOST_ACCESS_FILE: path.join(directory, "missing-host-access"),
      PORT_MANAGER_AGENT_SOCKET: path.join(directory, "missing-hook-agent.sock"),
      PORT_MANAGER_FIXED_PROTOCOL_PORTS: logicalPorts.join(","),
      PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  client.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  let sequence = 0;
  /** IPC commands serialize actions without restarting the hooked process. */
  async function command(action: string, marker?: string): Promise<unknown> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`hook client ${action} timed out: ${stderr}`)), 5_000);
      const onExit = () => finish(new Error(`hook client exited during ${action}: ${stderr}`));
      const onMessage = (message: any) => {
        if (message.id === id) finish(message.error === undefined ? undefined : new Error(message.error), message.result);
      };
      function finish(error?: Error, result?: unknown): void {
        clearTimeout(timer);
        client!.off("exit", onExit);
        client!.off("message", onMessage);
        if (error !== undefined) {
          const logPath = path.join(directory, "client-dev.log");
          if (fs.existsSync(logPath)) context.diagnostic(fs.readFileSync(logPath, "utf8"));
          reject(error);
        } else resolve(result);
      }
      client!.on("exit", onExit);
      client!.on("message", onMessage);
      client!.send({ id, action, marker });
    });
  }
  const pid = client.pid;
  assert.deepEqual(await command("open"), ["old\n", "old:/stream\n", "old:/events\n"]);
  assert.deepEqual(await command("probe"), ["old\n", "old\n", "ECONNREFUSED"]);

  /** New bytes prove each old stream is usable, beyond merely not being closed. */
  async function active(marker: string): Promise<void> {
    assert.equal(streams.length, 2);
    for (const response of streams) response.write(`${marker}\n`);
    const received = await command("active", marker) as string[];
    assert.equal(received.length, 3);
    for (let index = 0; index < received.length; index++) {
      assert.ok(received[index].startsWith(["old\n", "old:/stream\n", "old:/events\n"][index]));
      assert.ok(received[index].endsWith(`${index === 0 ? "old:" : ""}${marker}\n`));
    }
    assert.equal(client!.pid, pid);
  }

  const refreshResults = await Promise.allSettled([
    duringRefresh(),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiry - Date.now() + 80)));
      assert.deepEqual(await command("probe"), ["ECONNREFUSED", "ECONNREFUSED", "ECONNREFUSED"]);
      await active("after-expiry");
      const replacement = `${routesPath}.next`;
      fs.writeFileSync(replacement, document(newPorts, Date.now() + 60_000));
      fs.utimesSync(replacement, originalStat.atime, originalStat.mtime);
      fs.renameSync(replacement, routesPath);
      assert.equal(fs.statSync(routesPath).size, originalStat.size);
      assert.ok(Math.abs(fs.statSync(routesPath).mtimeMs - originalStat.mtimeMs) < 1);
      assert.deepEqual(await command("probe"), ["new\n", "new\n", "ECONNREFUSED"]);
      await active("after-rewrite");
    })(),
  ]);
  for (const result of refreshResults) if (result.status === "rejected") throw result.reason;
  await restartDns();
  assert.deepEqual(await command("probe"), ["new\n", "new\n", "ECONNREFUSED"]);
  await active("after-daemon-restart");
  assert.equal(foreignConnections, 0);
  assert.equal(stderr, "");
  context.diagnostic(`one hooked client pid=${pid}; explicit expiry refused new connects; atomic replacement selected new backends; old TCP/HTTP/SSE delivered bytes after expiry, rewrite and daemon restart; foreign accepts=0`);
}

// This program is intentionally a client of public Node socket APIs. It neither
// includes the hook source nor calls private cache helpers.
const clientScript = String.raw`
const net = require('node:net');
const http = require('node:http');
const ports = JSON.parse(process.argv[1]);
const retained = [];
function keep(stream) {
  const state = { stream, text: '' };
  stream.setEncoding('utf8');
  stream.on('data', chunk => { state.text += chunk; });
  stream.on('error', error => { state.error = error.code || error.message; });
  retained.push(state);
  return state;
}
function contains(state, text) {
  if (state.text.includes(text)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.stream.off('data', check); reject(new Error('stream missing ' + JSON.stringify(text) + ' actual=' + JSON.stringify(state.text) + ' error=' + state.error)); }, 2000);
    function check() {
      if (state.text.includes(text)) { clearTimeout(timer); state.stream.off('data', check); resolve(); }
    }
    state.stream.on('data', check);
  });
}
function raw(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setEncoding('utf8');
    socket.once('data', chunk => { socket.destroy(); resolve(chunk); });
    socket.once('error', error => resolve(error.code));
  });
}
function probeHttp() {
  return new Promise(resolve => {
    http.get({ host: '127.0.0.1', port: ports[1], path: '/probe', agent: false }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve(text));
    }).on('error', error => resolve(error.code));
  });
}
async function open() {
  const tcp = keep(net.createConnection({ host: '127.0.0.1', port: ports[0] }));
  await contains(tcp, 'old\n');
  for (const pathname of ['/stream', '/events']) {
    const state = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: ports[1], path: pathname, agent: false }, response => resolve(keep(response))).on('error', reject);
    });
    await contains(state, 'old:' + pathname + '\n');
  }
  return retained.map(state => state.text);
}
process.on('message', async ({ id, action, marker }) => {
  try {
    let result;
    if (action === 'open') result = await open();
    if (action === 'probe') result = await Promise.all([raw(ports[0]), probeHttp(), raw(ports[2])]);
    if (action === 'active') {
      retained[0].stream.write(marker + '\n');
      await Promise.all(retained.map(state => contains(state, marker + '\n')));
      if (retained.some(state => state.stream.destroyed)) throw new Error('active stream closed');
      result = retained.map(state => state.text);
    }
    process.send({ id, result });
  } catch (error) { process.send({ id, error: error.stack }); }
});
`;

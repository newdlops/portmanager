import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  HostPortProxyManager,
  type HostPortProxyOptions,
  type HostPortProxyTarget,
} from "../../src/platform/ports/host-port-proxy";
import type { HostPortExposure } from "../../src/shared/types";

const nativePath = process.env.PORT_MANAGER_TEST_NATIVE_HOST_PROXY_PATH
  ?? path.resolve(__dirname, "../../../media/native/portmanager_host_exposure_proxy");
const modes = [
  { name: "node", options: {} as HostPortProxyOptions, skip: false },
  { name: "native", options: { nativeProxyPath: nativePath }, skip: !fs.existsSync(nativePath) || process.platform === "win32" },
];

/** Real sockets exercise FIN/reset, buffer pressure, and admission on both data planes. */
async function fixture(t: TestContext, options: HostPortProxyOptions,
  handler: (socket: net.Socket) => void = socket => socket.pipe(socket),
  resolve?: (exposure: HostPortExposure) => HostPortProxyTarget | Promise<HostPortProxyTarget>) {
  const targetSockets = new Set<net.Socket>();
  const clients = new Set<net.Socket>();
  let acceptedTargets = 0;
  const target = net.createServer({ allowHalfOpen: true }, socket => {
    acceptedTargets++;
    targetSockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => targetSockets.delete(socket));
    handler(socket);
  });
  await listen(target, 0);
  const targetPort = portOf(target);
  const probe = net.createServer();
  await listen(probe, 0);
  const hostPort = portOf(probe);
  await close(probe);
  const exposure: HostPortExposure = {
    id: "lifecycle-" + hostPort, networkId: "fixture", hostAddress: "127.0.0.1", hostPort,
    targetAddress: "127.0.0.1", targetPort, protocol: "tcp", status: "active", createdAt: new Date().toISOString(),
  };
  const manager = new HostPortProxyManager({ resolve: resolve ?? (row => ({ host: row.targetAddress, port: row.targetPort })) }, options);
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await manager.dispose();
    for (const socket of targetSockets) socket.destroy();
    await close(target);
  });
  return {
    manager, exposure, targetSockets, get acceptedTargets() { return acceptedTargets; },
    async open() {
      await manager.open(exposure);
      if (options.nativeProxyPath !== undefined) {
        // A broken helper must fail this test, rather than silently exercising
        // the manager's fallback under a "native" test label.
        const handles = (manager as unknown as { listeners: Map<string, object> }).listeners;
        assert.equal(handles.get(exposure.id)?.constructor.name, "NativeHostPortProxyProcess");
      }
    },
    async client() {
      const socket = net.createConnection({ host: "127.0.0.1", port: hostPort, allowHalfOpen: true });
      clients.add(socket);
      socket.on("error", () => {});
      await once(socket, "connect");
      return socket;
    },
  };
}

for (const mode of modes) {
  test(mode.name + " proxy drains large writes and preserves a delayed response after client FIN",
    { skip: mode.skip, timeout: 10_000 }, async t => {
      const upload = Buffer.alloc(1024 * 1024, 0x41);
      const reply = Buffer.alloc(2 * 1024 * 1024, 0x62);
      let received = Buffer.alloc(0);
      const f = await fixture(t, { ...mode.options, connectTimeoutMs: 100 }, socket => {
        socket.pause();
        const timer = setTimeout(() => socket.resume(), 150);
        socket.once("close", () => clearTimeout(timer));
        const chunks: Buffer[] = [];
        socket.on("data", chunk => chunks.push(chunk));
        socket.on("end", () => {
          received = Buffer.concat(chunks);
          // The connected stream must outlive the much shorter setup deadline.
          const responseTimer = setTimeout(() => socket.end(reply), 150);
          socket.once("close", () => clearTimeout(responseTimer));
        });
      });
      await f.open();
      const client = await f.client();
      const response = collect(client);
      client.pause();
      client.end(upload);
      await delay(250);
      client.resume();
      assert.deepEqual(await response, reply);
      assert.deepEqual(received, upload);
    });

  test(mode.name + " proxy preserves client writes after an upstream FIN",
    { skip: mode.skip, timeout: 10_000 }, async t => {
      const reply = Buffer.alloc(256 * 1024, 0x63);
      const upload = Buffer.alloc(512 * 1024, 0x64);
      let received: Buffer | undefined;
      const f = await fixture(t, mode.options, socket => {
        const chunks: Buffer[] = [];
        socket.on("data", chunk => chunks.push(chunk));
        socket.on("end", () => { received = Buffer.concat(chunks); });
        socket.end(reply);
      });
      await f.open();
      const client = await f.client();
      assert.deepEqual(await collect(client), reply);
      client.end(upload);
      await until(() => received !== undefined);
      assert.deepEqual(received, upload);
    });

  test(mode.name + " proxy shares a lookup beyond the fulfilled cache TTL",
    { skip: mode.skip, timeout: 10_000 }, async t => {
      let resolveCalls = 0;
      let finish: (() => void) | undefined;
      const f = await fixture(t, { ...mode.options, targetCacheTtlMs: 10 }, undefined, exposure => {
        resolveCalls++;
        return new Promise(resolve => { finish = () => resolve({ host: exposure.targetAddress, port: exposure.targetPort }); });
      });
      await f.open();
      const first = await f.client();
      const firstResponse = collect(first);
      first.end("first");
      await until(() => resolveCalls === 1);
      await delay(40);
      const second = await f.client();
      const secondResponse = collect(second);
      second.end("second");
      await delay(40);
      assert.equal(resolveCalls, 1);
      finish!();
      assert.equal((await firstResponse).toString(), "first");
      assert.equal((await secondResponse).toString(), "second");
    });

  test(mode.name + " target cache expires despite a backward wall clock jump",
    { skip: mode.skip, timeout: 10_000 }, async t => {
      let monotonic = 1000, wall = 100000, calls = 0;
      t.mock.method(performance, "now", () => monotonic);
      t.mock.method(Date, "now", () => wall);
      const f = await fixture(t, { ...mode.options, targetCacheTtlMs: 10 }, undefined, exposure => {
        calls++;
        return { host: exposure.targetAddress, port: exposure.targetPort };
      });
      await f.open();
      const first = await f.client();
      const firstResponse = collect(first);
      first.end("first");
      assert.equal((await firstResponse).toString(), "first");
      wall -= 60000;
      monotonic += 11;
      const second = await f.client();
      const secondResponse = collect(second);
      second.end("second");
      assert.equal((await secondResponse).toString(), "second");
      assert.equal(calls, 2, "fulfilled target reuse must end on elapsed time");
    });

  test(mode.name + " proxy rejects overload before lookup and recovers a released permit",
    { skip: mode.skip, timeout: 10_000 }, async t => {
      let resolveCalls = 0;
      const f = await fixture(t, { ...mode.options, maxConnectionsPerListener: 2 }, socket => {
        socket.on("end", () => socket.end());
        socket.resume();
      }, exposure => { resolveCalls++; return { host: exposure.targetAddress, port: exposure.targetPort }; });
      await f.open();
      const first = await f.client();
      await f.client();
      await until(() => f.acceptedTargets === 2);
      const excess = await f.client();
      await closed(excess);
      assert.equal(resolveCalls, 1, "the two admitted clients share their target lookup");
      assert.equal(f.acceptedTargets, 2);
      first.end();
      first.resume();
      await closed(first);
      await until(() => f.targetSockets.size === 1);
      // The target closes before the helper's final fd cleanup returns its permit.
      await delay(25);
      await f.client();
      await until(() => f.acceptedTargets === 3);
    });

  test(mode.name + " proxy never opens a target for a reset client after delayed lookup",
    { skip: mode.skip, timeout: 10_000 }, async t => {
      let finish: (() => void) | undefined;
      const f = await fixture(t, mode.options, undefined, exposure => new Promise(resolve => {
        finish = () => resolve({ host: exposure.targetAddress, port: exposure.targetPort });
      }));
      await f.open();
      const client = await f.client();
      await until(() => finish !== undefined);
      client.resetAndDestroy();
      await closed(client);
      await delay(40);
      finish!();
      await delay(100);
      assert.equal(f.acceptedTargets, 0);
    });

  test(mode.name + " proxy bounds target waits and discards late results",
    { skip: mode.skip, timeout: 10_000 }, async t => {
      let calls = 0;
      let late: (() => void) | undefined;
      const f = await fixture(t, { ...mode.options, resolveTimeoutMs: 60 }, undefined, exposure => {
        calls++;
        if (calls > 1) return { host: exposure.targetAddress, port: exposure.targetPort };
        return new Promise(resolve => { late = () => resolve({ host: exposure.targetAddress, port: exposure.targetPort }); });
      });
      await f.open();
      const first = await f.client();
      const started = performance.now();
      first.resume();
      await closed(first);
      assert.ok(performance.now() - started < 1000);
      const second = await f.client();
      const response = collect(second);
      second.end("fresh");
      assert.equal((await response).toString(), "fresh");
      late!();
      await delay(100);
      assert.equal(calls, 2);
      assert.equal(f.acceptedTargets, 1);
    });

  test(mode.name + " proxy coalesces concurrent opens and fences disposal during bind",
    { skip: mode.skip, timeout: 10_000 }, async t => {
      const f = await fixture(t, mode.options);
      await Promise.all([f.open(), f.open()]);
      const client = await f.client();
      const response = collect(client);
      client.end("one listener");
      assert.equal((await response).toString(), "one listener");
      await f.manager.close(f.exposure.id);
      const opening = f.manager.open(f.exposure);
      const disposing = f.manager.dispose();
      await assert.rejects(opening, /canceled/);
      await disposing;
      await assert.rejects(f.client(), /ECONNREFUSED/);
    });
}

test("native proxy reclaims a reset client while the target applies write backpressure",
  { skip: modes[1].skip, timeout: 10_000 }, async t => {
    const f = await fixture(t, { ...modes[1].options, maxConnectionsPerListener: 1 }, socket => socket.pause());
    await f.open();
    const first = await f.client();
    first.write(Buffer.alloc(8 * 1024 * 1024, 0x65));
    await until(() => f.acceptedTargets === 1);
    await delay(100);
    first.resetAndDestroy();
    await closed(first);
    // No response or FIN from the stalled target may be required to return
    // the helper's permit; the old two-copy-thread implementation joined forever.
    const deadline = performance.now() + 2500;
    while (f.acceptedTargets < 2) {
      assert.ok(performance.now() < deadline, "reset must return the admission permit");
      const candidate = await f.client();
      candidate.once("end", () => candidate.end());
      candidate.resume();
      await delay(25);
      if (f.acceptedTargets < 2) candidate.destroy();
    }
  });

test("node proxy rejects a lookup completed after its deadline before an overdue timer can run",
  { timeout: 10_000 }, async t => {
    const f = await fixture(t, { resolveTimeoutMs: 20 }, undefined, exposure => {
      const until = performance.now() + 50;
      while (performance.now() < until) { /* Simulate unrelated synchronous host work. */ }
      return { host: exposure.targetAddress, port: exposure.targetPort };
    });
    await f.open();
    const client = await f.client();
    await closed(client);
    assert.equal(f.acceptedTargets, 0);
  });

test("node proxy rejects late TCP readiness before an overdue setup timer can run",
  { timeout: 10_000 }, async t => {
    let clock = 0;
    t.mock.method(performance, "now", () => clock);
    const f = await fixture(t, { connectTimeoutMs: 10_000 });
    await f.open();
    const stalled = new net.Socket();
    Object.defineProperty(stalled, "connecting", { value: true });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const original = net.createConnection;
    t.mock.method(require("node:net") as typeof net, "createConnection", (options: net.NetConnectOpts) => {
      if ("port" in options && options.port === f.exposure.targetPort) {
        entered();
        return stalled;
      }
      return original(options);
    });
    t.after(() => stalled.destroy());
    const client = await f.client();
    await ready;
    clock = 10_001;
    stalled.emit("connect");
    assert.ok(stalled.destroyed, "late readiness must discard its upstream before piping bytes");
    await closed(client);
  });

test("native host proxy strips inherited preload and scope while retaining its resource policy",
  { skip: process.platform === "win32", timeout: 15_000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-host-env-"));
    const capturedPath = path.join(directory, "environment.json");
    const helper = path.join(directory, "proxy.js");
    fs.writeFileSync(helper, [
      "#!/usr/bin/env node",
      'require("node:fs").writeFileSync(process.env.PM_CAPTURE_ENV, JSON.stringify(process.env));',
      'process.stdout.write(["READY", process.argv[2], process.argv[3]].join("\\t") + "\\n");',
      'process.stdin.resume();',
    ].join("\n"), { mode: 0o755 });
    const overrides: NodeJS.ProcessEnv = {
      PM_CAPTURE_ENV: capturedPath, PORT_MANAGER_HOOK: "1", PORT_MANAGER_NETWORK_ID: "network-a",
      PORT_MANAGER_DYLD_INSERT_LIBRARIES: "/missing/libportmanager_hook.dylib",
      DYLD_INSERT_LIBRARIES: "/missing/libportmanager_hook.dylib", LD_PRELOAD: "/missing/libportmanager_hook.so",
      BASH_ENV: "/missing/bash-env",
    };
    const before = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    t.after(() => {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const f = await fixture(t, { nativeProxyPath: helper, nativeStartupTimeoutMs: 10_000,
      maxConnectionsPerListener: 3, connectTimeoutMs: 150, resolveTimeoutMs: 250 });
    await f.open();
    const captured = JSON.parse(fs.readFileSync(capturedPath, "utf8")) as NodeJS.ProcessEnv;
    assert.equal(captured.PORT_MANAGER_HOOK_DISABLED, "1");
    for (const key of ["PORT_MANAGER_HOOK", "PORT_MANAGER_NETWORK_ID", "PORT_MANAGER_DYLD_INSERT_LIBRARIES",
      "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "BASH_ENV"]) assert.equal(captured[key], undefined, key);
    assert.equal(captured.PORT_MANAGER_PROXY_MAX_CONNECTIONS, "3");
    assert.equal(captured.PORT_MANAGER_PROXY_CONNECT_TIMEOUT_MS, "150");
    assert.equal(captured.PORT_MANAGER_PROXY_ROUTE_TIMEOUT_MS, "250");
    assert.equal(captured.PM_CAPTURE_ENV, capturedPath);
    // Stop the helper before removing the environment-capture directory.
    await f.manager.dispose();
  });

async function until(check: () => boolean, timeoutMs = 2500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    assert.ok(performance.now() < deadline, "proxy fixture exceeded its deadline");
    await delay(5);
  }
}

function collect(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function closed(socket: net.Socket): Promise<void> {
  if (socket.closed) return;
  // These clients deliberately allow half-close. A refusal/timeout arrives
  // as FIN, so acknowledge it rather than waiting with our write half open.
  socket.once("end", () => socket.end());
  socket.resume();
  await once(socket, "close");
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

function portOf(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

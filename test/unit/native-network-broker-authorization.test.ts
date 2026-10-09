import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { ensureAgentControllerToken } from "../../src/agent/agent-authorization";

const run = promisify(execFile);
interface Frame { id: string; method: string; authorization: string; payload: { pid: number; birth: number; networkId: string } }

/** A private disposable controller can delay/reject individual real peer scopes.
 * FD counts and wire results witness that pending authorization performs no TCP. */
test("broker scope approval bounds pending work, rejects forged replies and closes every controller FD", {
  skip: process.platform !== "darwin", timeout: 35_000,
}, async context => {
  const source = path.resolve(__dirname, "../../.."), root = fs.mkdtempSync("/private/tmp/pm-nb-auth-");
  const security = path.join(root, ".portmanager/security"), directory = path.join(security, "sockets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(security, "agent-control/controller.key"), token = ensureAgentControllerToken(tokenPath);
  const brokerPath = path.join(root, "broker"), fixture = path.join(root, "client"), agentSocket = path.join(directory, "agent.sock");
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", ...[
    "native/network-broker/portmanager_network_broker.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c",
  ].map(file => path.join(source, file)), "-o", brokerPath]);
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", path.join(source, "test/unit/native-network-broker-fixture.c"), "-o", fixture]);
  const children: ChildProcess[] = [], controls = new Set<net.Socket>(), controllerSockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();
  let broker: ChildProcess | undefined, startupDenied = true, mode = "deny", pending = 0;
  const reply = (frame: Frame) => ({ type: "response", id: frame.id, method: frame.method, ok: true, payload: frame.payload });
  const controller = net.createServer(socket => {
    controllerSockets.add(socket); socket.on("error", () => {}); socket.once("close", () => controllerSockets.delete(socket));
    let input = "", handled = false;
    socket.on("data", bytes => {
      input += bytes.toString(); if (handled || !input.includes("\n")) return; handled = true;
      const frame = JSON.parse(input.split("\n")[0]) as Frame;
      assert.equal(frame.authorization, token); assert.equal(frame.method, "registerProcessScope");
      assert.equal(frame.payload.networkId, "network-a"); assert.ok(frame.payload.birth > 0);
      if (startupDenied) { socket.end(JSON.stringify({ ...reply(frame), payload: { ...frame.payload, networkId: "network-b" } }) + "\n"); return; }
      if (frame.payload.pid === broker?.pid) { socket.end(JSON.stringify(reply(frame)) + "\n"); return; }
      const selected = mode;
      if (selected === "hold" || selected === "trickle") {
        pending++; socket.once("close", () => pending--);
        if (selected === "trickle") {
          socket.write('{"type":');
          const timer = setInterval(() => socket.write(" "), 1000); timers.add(timer);
          socket.once("close", () => { clearInterval(timer); timers.delete(timer); });
        }
        return;
      }
      if (selected === "fragment") {
        const response = JSON.stringify(reply(frame)) + "\n";
        socket.write(response.slice(0, 11));
        const timer = setTimeout(() => { timers.delete(timer); socket.end(response.slice(11)); }, 30); timers.add(timer); return;
      }
      let response: object = { ...reply(frame), ok: false };
      if (selected === "wrong-id") response = { ...reply(frame), id: "other-request" };
      if (selected === "wrong-birth") response = { ...reply(frame), payload: { ...frame.payload, birth: frame.payload.birth + 1 } };
      if (selected === "nested") response = { type: "response", id: frame.id, method: frame.method, payload: { ...frame.payload, ok: true } };
      if (selected === "oversize") { socket.end("x".repeat(2200)); return; }
      if (selected === "nul") { socket.end(JSON.stringify(reply(frame)) + "\0\n"); return; }
      if (selected === "number-prefix") { socket.end((JSON.stringify(reply(frame)) + "\n").replace(`"pid":${frame.payload.pid}`, `"pid":${frame.payload.pid}garbage`)); return; }
      if (selected === "unfinished") { socket.end(JSON.stringify(reply(frame)).slice(0, -1) + "\n"); return; }
      socket.end(JSON.stringify(response) + "\n");
    });
  });
  context.after(async () => {
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    for (const socket of [...controls, ...controllerSockets]) socket.destroy();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const ended = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([ended, delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await ended; }
    }
    if (controller.listening) await new Promise<void>(resolve => controller.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  controller.listen(agentSocket); await once(controller, "listening");
  const args = (endpoint: string) => ["--socket", endpoint, "--network-id", "network-a", "--loopback-host", "127.0.0.1",
    "--agent-socket", agentSocket, "--controller-token-file", tokenPath];
  const rejectedPath = path.join(directory, "rejected.sock");
  await assert.rejects(run(brokerPath, args(rejectedPath), { timeout: 3000 }), error => (error as { code?: number }).code === 1);
  assert.equal(fs.existsSync(rejectedPath), false, "no workload endpoint may be published before the broker's own scope is acknowledged");
  startupDenied = false;
  const socketPath = path.join(directory, "a.sock");
  broker = spawn(brokerPath, args(socketPath), { stdio: ["ignore", "pipe", "pipe"] }); children.push(broker);
  assert.match((await once(broker.stdout!, "data"))[0].toString(), /ready/);
  const descriptorCount = () => Number(execFileSync(fixture, ["descriptor-count", String(broker!.pid)], { encoding: "utf8" }).trim());
  const baseline = descriptorCount(); assert.equal(baseline, 4);
  async function until(predicate: () => boolean, message: string, milliseconds = 2000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) { assert.ok(Date.now() < deadline, message); await delay(10); }
  }
  async function open() {
    const socket = net.createConnection(socketPath); controls.add(socket); socket.on("error", () => {});
    socket.once("close", () => controls.delete(socket)); await once(socket, "connect");
    const request = Buffer.alloc(160); request.writeUInt32LE(0x504d4e42); request.writeUInt16LE(1, 4); request.writeUInt16LE(1, 6);
    request.writeInt32LE(2, 12); request.writeInt32LE(1, 16); socket.write(request); return socket;
  }
  for (const rejected of ["deny", "wrong-id", "wrong-birth", "nested", "oversize", "nul", "number-prefix", "unfinished"]) {
    mode = rejected; const socket = await open(); let bytes = Buffer.alloc(0);
    socket.on("data", chunk => bytes = Buffer.concat([bytes, chunk]));
    await Promise.race([once(socket, "close"), delay(3000).then(() => { throw new Error(`${rejected} reply did not finish`); })]);
    assert.equal(bytes.length, 148); assert.equal(bytes.readInt32LE(8), -1); assert.notEqual(bytes.readInt32LE(12), 0);
    await until(() => descriptorCount() === baseline, `${rejected} retained a controller/TCP FD`);
  }
  mode = "fragment";
  assert.equal((await run(fixture, ["socket", socketPath], { timeout: 3000 })).stdout.trim(), "allowed");
  await until(() => descriptorCount() === baseline, "fragmented valid reply retained an FD");

  for (const halfClose of [false, true]) {
    mode = "hold"; const socket = await open(); await until(() => pending === 1, "peer registration never became pending");
    assert.equal(descriptorCount(), baseline + 2, "pending socket creation may own only the control and controller FDs");
    const closed = once(socket, "close"); if (halfClose) socket.end(); else socket.destroy(); await closed;
    await until(() => pending === 0 && descriptorCount() === baseline, "cancellation must close both control and authorization FDs");
  }

  mode = "hold"; const held = await open(); await until(() => pending === 1, "held request missing");
  mode = "deny"; const started = Date.now(), responsive = await open();
  responsive.resume();
  await once(responsive, "close"); assert.ok(Date.now() - started < 1000, "a silent controller response must not block other clients");
  held.destroy(); await until(() => pending === 0 && descriptorCount() === baseline, "concurrent clients retained FDs");

  mode = "hold";
  const batch = await Promise.all(Array.from({ length: 64 }, () => open()));
  await until(() => pending === 64, "all bounded authorization slots must be exercised");
  assert.equal(descriptorCount(), baseline + 128, "64 pending requests have exactly two owned FDs apiece");
  const excess = await open(); await once(excess, "close");
  assert.ok(descriptorCount() <= baseline + 128, "admission above the slot limit must not allocate a controller FD");
  for (const socket of batch) socket.destroy();
  await until(() => pending === 0 && descriptorCount() === baseline, "bounded batch did not drain");

  mode = "trickle"; const slowStarted = Date.now(), slow = await open();
  await until(() => pending === 1, "trickle must reach the controller phase");
  await Promise.race([once(slow, "close"), delay(11_000).then(() => { throw new Error("partial controller reply restarted the deadline"); })]);
  assert.ok(Date.now() - slowStarted >= 7500 && Date.now() - slowStarted < 10_000);
  await until(() => pending === 0 && descriptorCount() === baseline, "deadline must release controller FD and slot");
  mode = "hold"; await open(); await until(() => pending === 1, "shutdown request did not become pending");
  const exited = once(broker, "exit"), stopStarted = Date.now(); broker.kill("SIGTERM");
  await Promise.race([exited, delay(1000).then(() => { throw new Error("pending authorization blocked broker shutdown"); })]);
  assert.ok(Date.now() - stopStarted < 1000);
  await until(() => pending === 0, "shutdown retained a controller connection");
});

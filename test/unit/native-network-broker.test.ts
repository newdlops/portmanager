import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { buildMacosNetworkSandboxProfile } from "../../src/platform/process/macos-network-sandbox";
import { networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

const run = promisify(execFile);

/** EOF and child failures must produce evidence rather than an infinite data wait. */
async function readReply(socket: net.Socket, label: string): Promise<Buffer> {
  return Promise.race([
    once(socket, "data").then(result => result[0] as Buffer),
    once(socket, "end").then(() => { throw new Error(`${label}: ended before reply`); }),
    delay(5000, undefined, { ref: false }).then(() => { throw new Error(`${label}: reply timeout`); }),
  ]);
}

test("fixed-scope broker performs TCP operations for a kernel-restricted process", { skip: process.platform !== "darwin", timeout: 30_000 }, async context => {
  const source = path.resolve(__dirname, "../../..");
  const root = fs.mkdtempSync("/private/tmp/pm-nb-");
  let stage = "compile";
  context.after(() => context.diagnostic(`stage=${stage}; broker=${fs.existsSync(path.join(root, "broker.log")) ? fs.readFileSync(path.join(root, "broker.log"), "utf8") : "unavailable"}`));
  const directory = path.join(root, ".portmanager/security/sockets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = path.join(directory, "a.sock");
  const brokerPath = path.join(root, "broker"), fixturePath = path.join(root, "client");
  const hookPath = path.join(root, "hook.dylib");
  const log = path.join(root, "broker.log");
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", path.join(source, "native/network-broker/portmanager_network_broker.c"),
    path.join(source, "native/shared/pm_dev_log.c"), "-o", brokerPath]);
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", path.join(source, "test/unit/native-network-broker-fixture.c"), "-o", fixturePath]);
  execFileSync("cc", ["-Wall", "-Wextra", "-O2", "-dynamiclib", path.join(source, "native/hook/portmanager_hook.c"),
    path.join(source, "native/shared/pm_dev_log.c"), "-o", hookPath]);
  // Use the existing host loopback as this synthetic realm. Policy decisions
  // against other aliases do not require adding or changing real lo0 aliases.
  const broker = spawn(brokerPath, ["--socket", socketPath, "--network-id", "network-a", "--loopback-host", "127.0.0.1"],
    { env: { ...process.env, PORT_MANAGER_DEV_LOG: log }, stdio: ["ignore", "pipe", "pipe"] });
  const children = [broker];
  context.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), delay(1500)]); }
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.match((await once(broker.stdout!, "data"))[0].toString(), /ready/);
  const namespace = networkNamespacePaths(root, "network-a");
  fs.mkdirSync(namespace.filesDirectory, { recursive: true, mode: 0o700 });
  const profile = buildMacosNetworkSandboxProfile({ networkId: "network-a", namespaceDirectories: [namespace.directory],
    sharedWorkspaceDirectories: [root], agentSocketPath: socketPath });
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1", PORT_MANAGER_NETWORK_ID: "network-b" };
  delete environment.DYLD_INSERT_LIBRARIES;
  delete environment.LD_PRELOAD;
  const server = net.createServer(socket => {
    socket.once("data", bytes => { assert.equal(bytes.toString(), "fixture"); socket.end("ok"); });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as net.AddressInfo).port;
  const connected = await run("/usr/bin/sandbox-exec", ["-p", profile, fixturePath, "connect", socketPath, "127.0.0.1", String(port)], { env: environment, timeout: 5000 });
  assert.equal(connected.stdout.trim(), "allowed");
  stage = "C nonblocking client";
  const nonblocking = await run("/usr/bin/sandbox-exec", ["-p", profile, fixturePath, "connect-nonblocking", socketPath,
    "127.0.0.1", String(port)], { env: environment, timeout: 5000 });
  assert.equal(nonblocking.stdout.trim(), "allowed");
  const socket = await run("/usr/bin/sandbox-exec", ["-p", profile, fixturePath, "socket", socketPath], { env: environment, timeout: 5000 });
  assert.equal(socket.stdout.trim(), "allowed");
  for (const args of [["connect", socketPath, "127.1.9.8", String(port)], ["unknown-op", socketPath]]) {
    await assert.rejects(run("/usr/bin/sandbox-exec", ["-p", profile, fixturePath, ...args], { env: environment, timeout: 5000 }),
      error => (error as { code?: number }).code === 1);
  }
  const bound = spawn("/usr/bin/sandbox-exec", ["-p", profile, fixturePath, "server", socketPath], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const boundExit = once(bound, "exit");
  children.push(bound);
  let output = "";
  bound.stdout!.on("data", chunk => { output += chunk.toString(); });
  const ready = (await once(bound.stdout!, "data"))[0].toString();
  const match = /^ready (127\.0\.0\.1) (\d+)/.exec(ready);
  assert.ok(match, ready);
  const client = net.createConnection(Number(match[2]), match[1]);
  context.after(() => client.destroy());
  try { await once(client, "connect"); }
  catch (error) {
    const ended = await Promise.race([boundExit, delay(1500).then(() => ["still running"])]);
    throw new Error(`${String(error)}; exit=${ended}; fixture=${output}; broker=${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "no log"}`);
  }
  stage = "C server data";
  const reply = readReply(client, "C server"); client.write("fixture");
  try { assert.equal((await reply).toString(), "ok"); }
  catch (error) {
    const ended = await Promise.race([boundExit, delay(1500).then(() => ["still running"])]);
    throw new Error(`${String(error)}; exit=${ended}; fixture=${output}; broker=${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "no log"}`);
  }
  stage = "C server exit";
  assert.equal((await boundExit)[0], 0);
  const hookEnvironment: NodeJS.ProcessEnv = { ...environment, DYLD_INSERT_LIBRARIES: hookPath, PORT_MANAGER_NETWORK_BROKER_SOCKET: socketPath };
  const nodeClient = "const n=require('net');const s=n.connect(Number(process.argv[1]),'127.0.0.1',()=>s.write('fixture'));" +
    "s.on('data',b=>{if(b.toString()!=='ok')process.exitCode=2;else process.stdout.write('runtime-ok');s.end()});" +
    "s.on('error',e=>{console.error(e.code);process.exitCode=3});";
  let node;
  stage = "Node client";
  try { node = await run("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/env", `DYLD_INSERT_LIBRARIES=${hookPath}`,
    process.execPath, "-e", nodeClient, String(port)], { env: hookEnvironment, timeout: 5000 }); }
  catch (error) { throw new Error(`${String(error)}; broker=${fs.readFileSync(log, "utf8")}`); }
  assert.equal(node.stdout, "runtime-ok", "installed Node must use the broker even with cooperative hooks disabled");
  stage = "Python client";
  const pythonPath = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", env: environment }).trim();
  const python = await run("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/env", `DYLD_INSERT_LIBRARIES=${hookPath}`,
    pythonPath, "-c", "import socket,sys; s=socket.create_connection(('127.0.0.1',int(sys.argv[1]))); s.sendall(b'fixture'); assert s.recv(32)==b'ok'; s.close(); print('runtime-ok')",
    String(port)], { env: hookEnvironment, timeout: 5000 });
  assert.equal(python.stdout.trim(), "runtime-ok", "installed Python must keep socket API semantics under kernel policy");
  const nodeServer = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/env", `DYLD_INSERT_LIBRARIES=${hookPath}`, process.execPath, "-e",
    "const n=require('net');const s=n.createServer(c=>c.once('data',b=>{c.end('ok');s.close()}));" +
    "s.on('connection',c=>{c.on('error',e=>console.error('accepted',e.code));c.on('end',()=>console.error('accepted end'));});" +
    "s.on('error',e=>{console.error(e.code);process.exitCode=3});s.listen(0,()=>console.log(JSON.stringify(s.address())));"],
    { env: hookEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  const nodeExit = once(nodeServer, "exit");
  children.push(nodeServer);
  let nodeDiagnostics = "";
  stage = "Node server ready";
  nodeServer.stderr!.on("data", chunk => { nodeDiagnostics += chunk.toString(); });
  const nodeReady = await Promise.race([
    once(nodeServer.stdout!, "data").then(result => result[0].toString()),
    nodeExit.then(() => { throw new Error(`Node exited before ready: ${nodeDiagnostics}; broker=${fs.readFileSync(log, "utf8")}`); }),
    delay(5000, undefined, { ref: false }).then(() => { throw new Error(`Node startup timeout: ${nodeDiagnostics}; broker=${fs.readFileSync(log, "utf8")}`); }),
  ]);
  const nodeAddress = JSON.parse(nodeReady) as { port: number };
  const nodeConnection = net.createConnection(nodeAddress.port, "127.0.0.1");
  context.after(() => nodeConnection.destroy());
  try {
    stage = "Node server data";
    await once(nodeConnection, "connect");
    const nodeReply = readReply(nodeConnection, "Node server"); nodeConnection.write("fixture");
    assert.equal((await nodeReply).toString(), "ok");
  } catch (error) {
    const ended = await Promise.race([nodeExit, delay(1500).then(() => ["still running"])]);
    throw new Error(`${String(error)}; Node exit=${ended}; diagnostics=${nodeDiagnostics}; broker=${fs.readFileSync(log, "utf8")}`);
  }
  stage = "Node server exit";
  assert.equal((await nodeExit)[0], 0, "Node's default IPv6 listener and accept must remain usable");
  stage = "complete";
  assert.equal(broker.exitCode, null);
});

test("broker bounds malformed requests, cancellation and slow clients without retaining FDs", { skip: process.platform !== "darwin", timeout: 25_000 }, async context => {
  const source = path.resolve(__dirname, "../../..");
  const root = fs.mkdtempSync("/private/tmp/pm-nb-life-");
  const directory = path.join(root, ".portmanager/security/sockets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = path.join(directory, "a.sock");
  const brokerPath = path.join(root, "broker"), fixturePath = path.join(root, "client");
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", path.join(source, "native/network-broker/portmanager_network_broker.c"),
    path.join(source, "native/shared/pm_dev_log.c"), "-o", brokerPath]);
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", path.join(source, "test/unit/native-network-broker-fixture.c"), "-o", fixturePath]);
  const inheritedPath = path.join(root, "synthetic-private-parent-file");
  fs.writeFileSync(inheritedPath, "fixture", { mode: 0o600 });
  const inherited = fs.openSync(inheritedPath, "r");
  const broker = spawn(brokerPath, ["--socket", socketPath, "--network-id", "network-a", "--loopback-host", "127.0.0.1"],
    { env: { ...process.env, PORT_MANAGER_DEV_LOG: path.join(root, "broker.log") }, stdio: ["ignore", "pipe", "pipe", inherited] });
  fs.closeSync(inherited);
  const exit = once(broker, "exit");
  const clients: net.Socket[] = [];
  const children = [broker];
  context.after(async () => {
    context.diagnostic(fs.existsSync(path.join(root, "broker.log")) ? fs.readFileSync(path.join(root, "broker.log"), "utf8") : "broker log unavailable");
    for (const client of clients) client.destroy();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const ended = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([ended, delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await ended; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.match((await once(broker.stdout!, "data"))[0].toString(), /ready/);
  const descriptorCount = () => Number(execFileSync(fixturePath, ["descriptor-count", String(broker.pid)], { encoding: "utf8" }).trim());
  const baseline = descriptorCount();
  assert.equal(baseline, 4, "broker must close the deliberately inherited private FD before admitting clients");
  async function until(predicate: () => boolean, message: string, milliseconds = 2000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, message);
      await delay(10);
    }
  }
  for (let index = 0; index < 8; index++) {
    for (const mode of ["duplicate-rights", "truncated-rights", ...(index === 0 ? ["many-rights"] : []), "invalid-fd"]) {
      let reply;
      try { reply = await run(fixturePath, [mode, socketPath], { timeout: 4000 }); }
      catch (error) { throw new Error(`${String(error)}; stdout=${(error as { stdout?: string }).stdout}`); }
      assert.match(reply.stdout.trim(), /allowed$/, mode);
      assert.equal(descriptorCount(), baseline, `${mode} must release all received rights`);
    }
  }
  await until(() => descriptorCount() === baseline, "rejected rights must all close");
  for (const mode of ["cancel-accept", "cancel-accept-halfclose"]) {
    let reply;
    try { reply = await run(fixturePath, [mode, socketPath], { timeout: 4000 }); }
    catch (error) { throw new Error(`${String(error)}; stdout=${(error as { stdout?: string }).stdout}`); }
    assert.equal(reply.stdout.trim(), "allowed", mode);
  }
  await until(() => descriptorCount() === baseline, "cancelled and completed operations must restore FDs");

  let closed = 0;
  for (let batch = 0; batch < 6; batch++) {
    await Promise.all(Array.from({ length: 16 }, async () => {
      const client = net.createConnection(socketPath); clients.push(client);
      client.on("error", () => {}); client.on("close", () => closed++);
      await once(client, "connect");
    }));
    await delay(20);
  }
  await until(() => closed >= 32, "clients over the 64-slot limit must be rejected");
  assert.ok(descriptorCount() <= baseline + 64, "control sockets must stay within the fixed FD budget");
  for (const client of clients) client.destroy();
  await until(() => descriptorCount() === baseline, "disconnect must release incomplete requests promptly");

  const slow = net.createConnection(socketPath); clients.push(slow);
  slow.on("error", () => {});
  const slowClosed = once(slow, "close");
  await once(slow, "connect");
  const started = Date.now();
  slow.write(Buffer.from([0x42]));
  // Additional fragments must not restart the absolute admission deadline.
  const trickle = setInterval(() => slow.write(Buffer.from([0])), 1000);
  context.after(() => clearInterval(trickle));
  await Promise.race([slowClosed, delay(11_000).then(() => { throw new Error("partial request did not expire"); })]);
  clearInterval(trickle);
  assert.ok(Date.now() - started >= 7500, "test must witness the broker deadline rather than an immediate reset");
  await until(() => descriptorCount() === baseline, "deadline must release every owned FD");
  assert.equal(broker.exitCode, null);
  const holding = spawn(fixturePath, ["hold-socket", socketPath], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(holding);
  const holdingExit = once(holding, "exit");
  assert.match((await once(holding.stdout!, "data"))[0].toString(), /^ready/);
  await until(() => descriptorCount() === baseline + 2, "unacknowledged transfer must retain exactly its control and returned FD");
  broker.kill("SIGTERM");
  assert.equal((await exit)[0], 0);
  assert.equal((await holdingExit)[0], 0, "broker shutdown must close the unacknowledged sending copy");
  assert.equal(fs.existsSync(socketPath), false, "shutdown removes only its owned endpoint");
});

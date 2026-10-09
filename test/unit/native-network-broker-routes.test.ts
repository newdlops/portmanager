import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { buildMacosNetworkSandboxProfile } from "../../src/platform/process/macos-network-sandbox";
import { networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

const run = promisify(execFile);

/** Real TCP endpoints prove policy updates route only the approved logical port.
 * The broker is a standalone fixture: controller PID lifecycle has separate tests. */
test("fixed broker uses complete private route snapshots for Host Access and Compose without granting direct host access", {
  skip: process.platform !== "darwin", timeout: 45_000,
}, async context => {
  const source = path.resolve(__dirname, "../../.."), root = fs.mkdtempSync("/private/tmp/pm-nb-routes-");
  const security = path.join(root, ".portmanager/security"), sockets = path.join(security, "sockets"), routes = path.join(security, "broker-routes");
  for (const directory of [sockets, routes]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const brokerPath = path.join(root, "broker"), fixture = path.join(root, "client"), hook = path.join(root, "hook.dylib");
  const policy = path.join(routes, "a.jsonl"), socketPath = path.join(sockets, "a.sock");
  const children: ChildProcess[] = [], servers: net.Server[] = [], connections = new Set<net.Socket>();
  context.after(async () => {
    for (const socket of connections) socket.destroy();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const ended = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([ended, delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await ended; }
    }
    for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", ...[
    "native/network-broker/portmanager_network_broker.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c",
  ].map(file => path.join(source, file)), "-o", brokerPath]);
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", path.join(source, "test/unit/native-network-broker-fixture.c"), "-o", fixture]);
  execFileSync("cc", ["-O2", "-dynamiclib", path.join(source, "native/hook/portmanager_hook.c"), path.join(source, "native/shared/pm_dev_log.c"), "-o", hook]);
  const hostAddress = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === "IPv4" && !item.internal)?.address;
  assert.ok(hostAddress, "host-access proof requires this Mac's actual non-loopback IPv4 interface");
  const accepted = [0, 0];
  for (let index = 0; index < 2; index++) {
    const server = net.createServer(socket => {
      accepted[index]++; connections.add(socket); socket.on("error", () => {}); socket.once("close", () => connections.delete(socket));
      socket.once("data", bytes => { assert.equal(bytes.toString(), "fixture"); socket.end("ok"); });
    }); servers.push(server); server.listen(0, "0.0.0.0"); await once(server, "listening");
  }
  const ports = servers.map(server => (server.address() as net.AddressInfo).port);
  const reservation = net.createServer(); servers.push(reservation); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const logicalPort = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const header = JSON.stringify({ version: 1, networkId: "network-a" }) + "\n";
  const row = (targetPort = ports[0], logical = logicalPort) => ({ logicalPort: logical, targetHost: hostAddress, targetPort });
  let sequence = 0;
  function publish(text: string, mode = 0o600) {
    const temporary = path.join(routes, `next-${sequence++}.jsonl`); fs.writeFileSync(temporary, text, { mode }); fs.renameSync(temporary, policy);
  }
  const document = (rows: object[]) => header + rows.map(value => JSON.stringify(value) + "\n").join("");
  const valid = document([row()]); publish(valid);
  const brokerArgs = (endpoint = socketPath) => ["--socket", endpoint, "--network-id", "network-a", "--loopback-host", "127.0.0.1", "--routes", policy];
  const broker = spawn(brokerPath, brokerArgs(), { stdio: ["ignore", "pipe", "pipe"] }); children.push(broker);
  assert.match((await once(broker.stdout!, "data"))[0].toString(), /ready/);
  const own = networkNamespacePaths(root, "network-a"); fs.mkdirSync(own.filesDirectory, { recursive: true, mode: 0o700 });
  const profile = buildMacosNetworkSandboxProfile({ networkId: "network-a", namespaceDirectories: [own.directory], sharedWorkspaceDirectories: [root], agentSocketPath: socketPath });
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1", PORT_MANAGER_NETWORK_ID: "network-b" };
  delete environment.DYLD_INSERT_LIBRARIES; delete environment.LD_PRELOAD;
  const connect = (host = "127.0.0.1", port = logicalPort) => run("/usr/bin/sandbox-exec", ["-p", profile, fixture, "connect", socketPath, host, String(port)], { env: environment, timeout: 4000 });
  const refused = (error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    return (failure.code === 1 || failure.code === 3) && /^failed errno=\d+ phase=operation/.test(failure.stdout ?? "");
  };
  const descriptorCount = () => Number(execFileSync(fixture, ["descriptor-count", String(broker.pid)], { encoding: "utf8" }).trim());
  const baseline = descriptorCount(); assert.equal(baseline, 4);
  assert.equal((await connect()).stdout.trim(), "allowed"); assert.deepEqual(accepted, [1, 0]);
  await assert.rejects(connect(hostAddress, ports[0]), error => (error as { code?: number }).code === 1);
  assert.deepEqual(accepted, [1, 0], "an explicit mapping may not authorize a direct request to the host interface");
  const nodeClient = `
    const fs=require('fs'),net=require('net');
    for(const action of [()=>fs.readFileSync(${JSON.stringify(policy)}),()=>fs.writeFileSync(${JSON.stringify(policy)},'forged')]) {
      let denied=false;try{action()}catch(error){denied=['EPERM','EACCES'].includes(error.code)}
      if(!denied)throw Error('guest accessed controller route policy');
    }
    const socket=net.connect(${logicalPort},'::1',()=>socket.write('fixture'));
    socket.on('error',error=>{console.error(error.code);process.exitCode=1});
    socket.on('data',bytes=>{if(bytes.toString()!=='ok')process.exitCode=2;else console.log('allowed');socket.end();});
  `;
  assert.equal((await run("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/env", `DYLD_INSERT_LIBRARIES=${hook}`,
    `PORT_MANAGER_NETWORK_BROKER_SOCKET=${socketPath}`, process.execPath, "-e", nodeClient], { env: environment, timeout: 4000 })).stdout.trim(), "allowed");
  assert.deepEqual(accepted, [2, 0], "IPv6 localhost must map a trusted IPv4 target through a mapped address");
  publish(document([row(ports[1]) ]));
  assert.equal((await connect()).stdout.trim(), "allowed"); assert.deepEqual(accepted, [2, 1], "new connects must read the complete replacement snapshot");
  const bind = `const net=require('net');const s=net.createServer();s.on('error',e=>{console.error(e.code);process.exitCode=1});s.listen(${logicalPort},'127.0.0.1',()=>{console.log(JSON.stringify(s.address()));s.close()});`;
  const bound = await run("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/env", `DYLD_INSERT_LIBRARIES=${hook}`,
    `PORT_MANAGER_NETWORK_BROKER_SOCKET=${socketPath}`, process.execPath, "-e", bind], { env: environment, timeout: 4000 });
  assert.deepEqual(JSON.parse(bound.stdout), { address: "127.0.0.1", family: "IPv4", port: logicalPort }, "bind must stay on the network's own alias/port regardless of connect mapping");
  let ipv6Accepted = 0;
  const ipv6 = net.createServer(socket => {
    ipv6Accepted++; connections.add(socket); socket.on("error", () => {}); socket.once("close", () => connections.delete(socket));
    socket.once("data", bytes => { assert.equal(bytes.toString(), "fixture"); socket.end("ok"); });
  }); servers.push(ipv6); ipv6.listen(0, "::1"); await once(ipv6, "listening");
  publish(document([{ ...row((ipv6.address() as net.AddressInfo).port), targetHost: "::1" }]));
  await assert.rejects(connect(), refused); assert.equal(ipv6Accepted, 0, "IPv4 sockets must reject a target they cannot represent");
  assert.equal((await run("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/env", `DYLD_INSERT_LIBRARIES=${hook}`,
    `PORT_MANAGER_NETWORK_BROKER_SOCKET=${socketPath}`, process.execPath, "-e", nodeClient], { env: environment, timeout: 4000 })).stdout.trim(), "allowed");
  assert.equal(ipv6Accepted, 1, "an IPv6 socket must connect to an approved numeric IPv6 target");
  publish(header);
  await assert.rejects(connect(), refused);
  const invalid = [
    valid.replace('"network-a"', '"network-b"'), document([row(), row()]), document([{ ...row(), targetHost: "localhost" }]),
    document([{ ...row(), targetHost: "0.0.0.0" }]), document([{ ...row(), targetPort: 0 }]), valid.slice(0, -1), valid + "\0",
    valid.replace(`"logicalPort":${logicalPort}`, `"logicalPort":${logicalPort}e1`),
    valid.replace('"version":1', '"version":1,"version":2'), "x".repeat(65537),
    document(Array.from({ length: 513 }, (_, index) => row(ports[0], index + 1))),
  ];
  for (const text of invalid) {
    publish(text); await assert.rejects(connect(), refused);
    assert.equal(descriptorCount(), baseline, "invalid policy must release its file and directory FDs");
  }
  publish(valid, 0o644); await assert.rejects(connect(), refused);
  publish(valid); const hardlink = path.join(routes, "linked.jsonl"); fs.linkSync(policy, hardlink);
  await assert.rejects(connect(), refused); fs.unlinkSync(hardlink);
  const other = path.join(root, "outside.jsonl"); fs.writeFileSync(other, valid, { mode: 0o600 }); fs.unlinkSync(policy); fs.symlinkSync(other, policy);
  await assert.rejects(connect(), refused);
  fs.unlinkSync(policy); await assert.rejects(connect(), refused);
  publish(valid); fs.chmodSync(routes, 0o755); await assert.rejects(connect(), refused); fs.chmodSync(routes, 0o700);
  const saved = path.join(security, "saved-routes"); fs.renameSync(routes, saved); fs.symlinkSync(saved, routes);
  await assert.rejects(connect(), refused); fs.unlinkSync(routes); fs.renameSync(saved, routes);
  assert.deepEqual(accepted, [2, 1], "malformed, absent or redirected policy may never reach a TCP target");
  publish(valid); assert.equal((await connect()).stdout.trim(), "allowed"); assert.deepEqual(accepted, [3, 1]);
  assert.equal(descriptorCount(), baseline); assert.equal(broker.exitCode, null);
  publish(invalid[0]); const rejectedSocket = path.join(sockets, "rejected.sock");
  await assert.rejects(run(brokerPath, brokerArgs(rejectedSocket), { timeout: 3000 }), error => (error as { code?: number }).code === 1);
  assert.equal(fs.existsSync(rejectedSocket), false, "invalid configured policy must prevent endpoint publication at startup");
});

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildMacosNetworkSandboxProfile } from "../../src/platform/process/macos-network-sandbox";
import { networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";
import { ensureAgentControllerToken, ensureAgentNetworkToken, getAgentNetworkTokenPath, readAgentControllerToken } from "../../src/agent/agent-authorization";

const run = promisify(execFile);

test("macOS kernel policy rejects raw cross-network access with the hook disabled", {
  skip: process.platform !== "darwin",
}, async context => {
  // Unix sun_path is only 104 bytes on macOS; keep the protected broker path short.
  const root = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "pm-sbx-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = networkNamespacePaths(root, "network-a");
  const other = networkNamespacePaths(root, "network-b");
  fs.mkdirSync(own.filesDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(other.filesDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(own.envFilePath, "synthetic-a\n", { mode: 0o600 });
  fs.writeFileSync(other.envFilePath, "synthetic-b\n", { mode: 0o600 });
  const controllerPath = path.join(root, ".portmanager", "security", "agent-control", "fixture.key");
  const controllerToken = ensureAgentControllerToken(controllerPath);
  ensureAgentNetworkToken("fixture", "network-a", controllerPath);
  ensureAgentNetworkToken("fixture", "network-b", controllerPath);
  const sharedSource = path.join(root, "shared-source.txt");
  fs.writeFileSync(sharedSource, "host source stays unchanged\n");
  const executable = path.join(root, "raw-probe");
  execFileSync("cc", [path.resolve(__dirname, "../../../test/unit/macos-network-sandbox-fixture.c"), "-o", executable], { timeout: 30_000 });
  const victim = spawn(executable, ["hold"], { env: { PATH: "/usr/bin:/bin", PM_AUDIT_SYNTHETIC_SECRET: "fake-other-network-value" }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(async () => { if (victim.exitCode === null && victim.signalCode === null) { victim.kill("SIGTERM"); await once(victim, "exit"); } });
  await once(victim.stdout!, "data");
  const unrestricted = await run(executable, ["process-env", String(victim.pid)], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 });
  assert.equal(unrestricted.stdout.trim(), "allowed", "the unsandboxed baseline must actually see the synthetic environment marker");
  const servers: net.Server[] = [];
  context.after(async () => { for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); });
  async function listen(address: number | string): Promise<net.Server> {
    const server = net.createServer(socket => { socket.on("data", () => socket.end()); socket.on("error", () => {}); });
    servers.push(server);
    if (typeof address === "number") server.listen(address, "127.0.0.1");
    else server.listen(address);
    await once(server, "listening");
    return server;
  }
  const ownTcp = await listen(0);
  const otherTcp = await listen(0);
  const ownPort = (ownTcp.address() as net.AddressInfo).port;
  const otherPort = (otherTcp.address() as net.AddressInfo).port;
  const socketDirectory = path.join(root, ".portmanager", "security", "sockets");
  fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  const ownSocket = path.join(socketDirectory, "a.sock");
  const otherSocket = path.join(socketDirectory, "b.sock");
  const brokerExecutable = path.join(root, "broker");
  execFileSync("cc", [path.resolve(__dirname, "../../../test/unit/macos-socket-broker-fixture.c"), "-o", brokerExecutable], { timeout: 30_000 });
  const broker = spawn(brokerExecutable, [ownSocket, String(ownPort)], { stdio: ["ignore", "pipe", "pipe"] });
  context.after(async () => { if (broker.exitCode === null && broker.signalCode === null) { broker.kill("SIGTERM"); await once(broker, "exit"); } });
  await once(broker.stdout!, "data");
  await listen(otherSocket);
  const profile = buildMacosNetworkSandboxProfile({ networkId: "network-a", namespaceDirectories: [own.directory],
    sharedWorkspaceDirectories: [root], agentSocketPath: ownSocket });
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1", PORT_MANAGER_NETWORK_ID: "network-b" };
  delete environment.DYLD_INSERT_LIBRARIES;
  delete environment.LD_PRELOAD;
  async function probe(allowed: boolean, ...args: string[]): Promise<void> {
    let failure: (Error & { code?: number; stdout?: string; stderr?: string }) | undefined;
    try { const result = await run("/usr/bin/sandbox-exec", ["-p", profile, executable, ...args], { env: environment, timeout: 5000 });
      assert.equal(result.stdout.trim(), "allowed"); }
    catch (error) { failure = error as typeof failure; }
    if (allowed) assert.equal(failure, undefined, failure?.stderr);
    else { assert.equal(failure?.code, 1, failure?.stderr); assert.match(failure?.stdout ?? "", /denied errno=(1|13)/); }
  }
  await probe(true, "read", sharedSource);
  await probe(true, "read", own.envFilePath);
  await probe(true, "write", path.join(own.filesDirectory, "state.pid"));
  await probe(true, "brokered-tcp", ownSocket);
  await probe(true, "unix", "/var/run/mDNSResponder");
  await probe(true, "socket-only");
  await probe(true, "child-signal");
  await probe(true, "priority", "0");
  await probe(false, "tcp", "127.0.0.1", String(ownPort));
  await probe(false, "read", other.envFilePath);
  await probe(false, "read", controllerPath);
  await probe(false, "write", controllerPath);
  await probe(false, "read", getAgentNetworkTokenPath(controllerPath, "network-a"));
  await probe(false, "read", getAgentNetworkTokenPath(controllerPath, "network-b"));
  await probe(false, "link", controllerPath, path.join(own.filesDirectory, "controller.key"));
  await probe(false, "write", other.envFilePath);
  await probe(true, "write", sharedSource);
  await probe(false, "tcp", "127.0.0.1", String(otherPort));
  await probe(false, "unix", otherSocket);
  await probe(false, "unlink", ownSocket);
  await probe(false, "link", other.envFilePath, path.join(own.filesDirectory, "hardlink.env"));
  await probe(false, "signal", String(process.pid));
  const otherProfile = buildMacosNetworkSandboxProfile({ networkId: "network-b", namespaceDirectories: [other.directory],
    sharedWorkspaceDirectories: [root] });
  const otherVictim = spawn("/usr/bin/sandbox-exec", ["-p", otherProfile, executable, "hold"], {
    env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(async () => {
    if (otherVictim.exitCode === null && otherVictim.signalCode === null) { otherVictim.kill("SIGTERM"); await once(otherVictim, "exit"); }
  });
  await once(otherVictim.stdout!, "data");
  await probe(false, "signal", String(otherVictim.pid));
  await probe(false, "priority", String(otherVictim.pid));
  await probe(false, "process-env", String(victim.pid));
  const symlink = path.join(own.filesDirectory, "other.env");
  fs.symlinkSync(other.envFilePath, symlink);
  await probe(false, "read", symlink);
  const controllerLink = path.join(own.filesDirectory, "controller-link.key");
  fs.symlinkSync(controllerPath, controllerLink);
  await probe(false, "read", controllerLink);
  assert.equal(readAgentControllerToken(controllerPath), controllerToken, "kernel rejection must preserve the private key");
  assert.equal(fs.readFileSync(other.envFilePath, "utf8"), "synthetic-b\n");
  assert.equal(fs.readFileSync(sharedSource, "utf8"), "fixture", "shared source writes remain explicitly permitted");
  const node = await run("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", "process.stdout.write('runtime-ok')"], { env: environment, timeout: 5000 });
  assert.equal(node.stdout, "runtime-ok", "the installed host Node runtime must work inside the policy");
  const unconnectedSocket = path.join(socketDirectory, "u.sock");
  const unconnectedBroker = spawn(brokerExecutable, [unconnectedSocket, "unconnected"], { stdio: ["ignore", "pipe", "pipe"] });
  context.after(async () => {
    if (unconnectedBroker.exitCode === null && unconnectedBroker.signalCode === null) {
      unconnectedBroker.kill("SIGTERM"); await once(unconnectedBroker, "exit");
    }
  });
  await once(unconnectedBroker.stdout!, "data");
  const unconnectedProfile = buildMacosNetworkSandboxProfile({ networkId: "network-a", namespaceDirectories: [own.directory],
    sharedWorkspaceDirectories: [root], agentSocketPath: unconnectedSocket });
  await assert.rejects(run("/usr/bin/sandbox-exec", ["-p", unconnectedProfile, executable, "brokered-connect",
    unconnectedSocket, "127.0.0.1", String(otherPort)], { env: environment, timeout: 5000 }),
    error => (error as { code?: number; stdout?: string }).code === 1 && /denied errno=(1|13)/.test((error as { stdout?: string }).stdout ?? ""),
    "a broker-created unconnected FD must not widen the caller's raw connect authority");
});

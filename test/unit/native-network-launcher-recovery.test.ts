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
import { buildMacosNetworkSandboxProfile } from "../../src/platform/process/macos-network-sandbox";
import { networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

const run = promisify(execFile);
interface Identity { pid: number; birth: number }

/** A killed supervisor cannot publish completion. Recovery must prove the same
 * kernel membership and reclaim every survivor before returning a receipt. */
test("private ownership and completion records recover abrupt supervisor death without trusting PID disappearance", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, async context => {
  const source = path.resolve(__dirname, "../../.."), root = fs.mkdtempSync("/private/tmp/pm-recover-");
  const runtime = path.join(root, ".portmanager/runtime"), security = path.join(root, ".portmanager/security");
  for (const directory of [runtime, "profiles", "sockets", "sessions"].map(name => name === runtime ? name : path.join(security, name))) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const launcher = path.join(runtime, "launch"), broker = path.join(runtime, "broker"), hook = path.join(runtime, "hook.dylib");
  const fixture = path.join(root, "fixture"), identity = path.join(root, "identity"), tokenPath = path.join(security, "agent-control/controller.key");
  const token = ensureAgentControllerToken(tokenPath), children: ChildProcess[] = [], sockets = new Set<net.Socket>();
  const controlPath = path.join(security, "sockets/controller.sock");
  const controller = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", bytes => {
      input += bytes.toString(); if (!input.includes("\n")) return;
      const frame = JSON.parse(input.split("\n")[0]); assert.equal(frame.authorization, token);
      if (frame.payload.networkId === "pending") return; // Deterministic death before the private exec ACK.
      socket.end(JSON.stringify({ type: "response", id: frame.id, method: frame.method, ok: true, payload: frame.payload }) + "\n");
    });
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, delay(4000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    if (controller.listening) await new Promise<void>(resolve => controller.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const compile = (files: string[], output: string, extra: string[] = []) => execFileSync("cc", ["-O2", "-Wall", "-Wextra", "-Werror", ...extra,
    ...files.map(file => path.join(source, file)), "-o", output], { timeout: 30_000 });
  compile(["native/network-launcher/portmanager_network_launch.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c"], launcher);
  compile(["native/network-broker/portmanager_network_broker.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c"], broker);
  compile(["native/hook/portmanager_hook.c", "native/shared/pm_dev_log.c"], hook, ["-dynamiclib", "-Wno-unused-function"]);
  compile(["test/unit/native-network-launcher-cleanup-fixture.c"], fixture);
  compile(["native/process-lookup/portmanager_process_lookup.c"], identity);
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1" };
  delete environment.DYLD_INSERT_LIBRARIES; delete environment.LD_PRELOAD; delete environment.BASH_ENV; delete environment.ENV;
  controller.listen(controlPath); await once(controller, "listening");
  assert.equal((await run(launcher, ["--lifecycle-version"], { env: environment })).stdout.trim(), "1");
  const prepare = async (networkId: string) => {
    const endpoint = path.join(security, `sockets/${networkId}.sock`), policy = path.join(security, `profiles/${networkId}.sb`);
    const own = networkNamespacePaths(root, networkId); fs.mkdirSync(own.filesDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(policy, buildMacosNetworkSandboxProfile({ networkId, namespaceDirectories: [own.directory], sharedWorkspaceDirectories: [root], agentSocketPath: endpoint }), { mode: 0o600 });
    const helper = spawn(broker, ["--socket", endpoint, "--network-id", networkId, "--loopback-host", "127.0.0.1"], { env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(helper);
    await once(helper.stdout!, "data"); return { networkId, endpoint, policy };
  };
  const a = await prepare("a"), b = await prepare("b");
  const args = (scope: typeof a, ready: string, command: string[]) => ["--profile", scope.policy, "--broker", scope.endpoint, "--hook", hook,
    "--network-id", scope.networkId, "--agent-socket", controlPath, "--controller-token-file", tokenPath, "--ready-file", ready, "--", ...command];
  const alive = (expected: Identity) => {
    try { const now = JSON.parse(execFileSync(identity, ["identity", String(expected.pid)], { env: environment, encoding: "utf8", timeout: 2000 })) as Identity;
      return now.pid === expected.pid && now.birth === expected.birth;
    } catch { return false; }
  };
  async function until(predicate: () => boolean, message: string) {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < deadline, message); await delay(10); }
  }
  const otherReady = path.join(security, "sessions/other.json");
  const other = spawn(launcher, args(b, otherReady, [fixture, "hold"]), { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(other);
  await until(() => fs.existsSync(otherReady), "reference namespace did not start");
  const otherIdentity = JSON.parse(fs.readFileSync(otherReady, "utf8")) as Identity;
  const ready = path.join(security, "sessions/crash.json"), ownerPath = ready + ".owner", cleanedPath = ready + ".cleaned";
  const report = path.join(root, "orphan.js"), ticks = path.join(root, "ticks.js");
  const crashed = spawn(launcher, args(a, ready, [fixture, "orphan", report, ticks, "linger"]), { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(crashed);
  await until(() => fs.existsSync(ready) && fs.existsSync(report), "crash workload did not start");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  const rootIdentity = JSON.parse(fs.readFileSync(ready, "utf8")) as Identity, orphan = JSON.parse(fs.readFileSync(report, "utf8")) as Identity;
  assert.equal(fs.statSync(ownerPath).mode & 0o777, 0o600); assert.equal(fs.statSync(ownerPath).nlink, 1);
  assert.equal(owner.supervisorPid, crashed.pid); assert.equal(owner.pid, rootIdentity.pid); assert.equal(owner.birth, rootIdentity.birth);
  assert.equal(fs.existsSync(cleanedPath), false);
  await assert.rejects(run(launcher, ["--recover-owner", ownerPath], { env: environment, timeout: 3000 }), error => (error as { code?: number }).code === 125);
  assert.equal(alive(rootIdentity), true); assert.equal(alive(orphan), true, "live supervisor blocks parallel recovery");
  const exited = once(crashed, "exit"); crashed.kill("SIGKILL"); await exited;
  assert.equal(fs.existsSync(cleanedPath), false, "supervisor disappearance can never fabricate completion");
  assert.equal(alive(rootIdentity), true); assert.equal(alive(orphan), true);
  const invalid = path.join(security, "sessions/invalid.owner"); fs.writeFileSync(invalid, JSON.stringify({ ...owner, markerIno: owner.markerIno + 1 }), { mode: 0o600 });
  await assert.rejects(run(launcher, ["--recover-owner", invalid], { env: environment, timeout: 3000 }), error => (error as { code?: number }).code === 125);
  assert.equal(alive(rootIdentity), true); assert.equal(alive(orphan), true, "wrong marker identity must not signal workloads");
  const linked = path.join(security, "sessions/linked.owner"); fs.symlinkSync(ownerPath, linked);
  await assert.rejects(run(launcher, ["--recover-owner", linked], { env: environment, timeout: 3000 }), error => (error as { code?: number }).code === 125);
  fs.writeFileSync(cleanedPath, JSON.stringify({ ...owner, networkId: "b", cleaned: true }) + "\n", { mode: 0o600 });
  await assert.rejects(run(launcher, ["--recover-owner", ownerPath], { env: environment, timeout: 3000 }), error => (error as { code?: number }).code === 125);
  assert.equal(alive(rootIdentity), true); assert.equal(alive(orphan), true, "a mismatched receipt cannot prove completion or start recovery");
  fs.unlinkSync(cleanedPath);
  const recovered = await run(launcher, ["--recover-owner", ownerPath], { env: environment, timeout: 12_000 });
  assert.deepEqual(JSON.parse(recovered.stdout), { cleaned: true, version: 1 });
  assert.equal(alive(rootIdentity), false); assert.equal(alive(orphan), false); assert.equal(alive(otherIdentity), true);
  const complete = JSON.parse(fs.readFileSync(cleanedPath, "utf8")); assert.deepEqual(complete, { ...owner, cleaned: true });
  assert.equal(fs.statSync(cleanedPath).mode & 0o777, 0o600); assert.equal(fs.existsSync(owner.markerPath), false);
  const size = fs.statSync(ticks).size; await delay(150); assert.equal(fs.statSync(ticks).size, size);
  assert.deepEqual(JSON.parse((await run(launcher, ["--recover-owner", ownerPath], { env: environment, timeout: 3000 })).stdout), { cleaned: true, version: 1 });
  const normalExit = once(other, "exit"); other.kill("SIGTERM"); await normalExit;
  const normalOwner = JSON.parse(fs.readFileSync(otherReady + ".owner", "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(otherReady + ".cleaned", "utf8")), { ...normalOwner, cleaned: true });

  const pending = await prepare("pending"), pendingReady = path.join(security, "sessions/pending.json");
  const neverRun = path.join(root, "never-run.js");
  const beforeAck = spawn(launcher, args(pending, pendingReady, ["/bin/sh", "-c", 'echo forbidden > "$1"', "sh", neverRun]),
    { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(beforeAck);
  await until(() => fs.existsSync(pendingReady + ".owner"), "pre-ACK owner record was not published");
  assert.equal(fs.existsSync(pendingReady), false); assert.equal(fs.existsSync(neverRun), false);
  const interrupted = once(beforeAck, "exit"); beforeAck.kill("SIGKILL"); await interrupted;
  assert.equal(fs.existsSync(pendingReady + ".cleaned"), false);
  assert.deepEqual(JSON.parse((await run(launcher, ["--recover-owner", pendingReady + ".owner"], { env: environment, timeout: 12_000 })).stdout), { cleaned: true, version: 1 });
  const pendingOwner = JSON.parse(fs.readFileSync(pendingReady + ".owner", "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingReady + ".cleaned", "utf8")), { ...pendingOwner, cleaned: true });
  assert.equal(fs.existsSync(neverRun), false, "abrupt death during approval cannot execute application code");
});

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { ensureAgentControllerToken, ensureAgentNetworkToken } from "../../src/agent/agent-authorization";
import { buildMacosNetworkSandboxProfile } from "../../src/platform/process/macos-network-sandbox";
import { networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

const run = promisify(execFile);
interface Scope { pid: number; birth: number; networkId: string }
interface Reply { ok: boolean; payload?: unknown; error?: string }

/** Real isolated agent plus deliberately delayed/forged replies: no product daemon is used. */
test("guarded exec waits for controller PID/birth registration and never widens inherited scope", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, async context => {
  const source = path.resolve(__dirname, "../../..");
  const root = fs.mkdtempSync("/private/tmp/pm-launch-auth-");
  const children: ChildProcess[] = [], orphaned: Array<{ pid: number; birth: number }> = [];
  const sockets = new Set<net.Socket>(), servers: net.Server[] = [];
  const runtime = path.join(root, ".portmanager/runtime"), security = path.join(root, ".portmanager/security");
  for (const directory of [runtime, path.join(security, "profiles"), path.join(security, "sockets"), path.join(security, "agent-control")]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const launcher = path.join(runtime, "launch"), broker = path.join(runtime, "broker"), hook = path.join(runtime, "hook.dylib");
  const agent = path.join(runtime, "agent"), identity = path.join(runtime, "identity");
  const compile = (inputs: string[], output: string, extra: string[] = []) => execFileSync("cc", ["-O2", ...extra,
    ...inputs.map(input => path.join(source, input)), "-o", output], { timeout: 30_000 });
  compile(["native/network-launcher/portmanager_network_launch.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c"], launcher, ["-Wall", "-Wextra", "-Werror"]);
  compile(["native/network-broker/portmanager_network_broker.c", "native/shared/pm_dev_log.c"], broker, ["-Wall", "-Wextra", "-Werror"]);
  compile(["native/hook/portmanager_hook.c", "native/shared/pm_dev_log.c"], hook, ["-dynamiclib"]);
  compile(["native/process-lookup/portmanager_process_lookup.c"], identity, ["-Wall", "-Wextra", "-Werror"]);
  compile(["portmanager_agent.c", "portmanager_agent_probe.c", "portmanager_agent_state.c", "portmanager_agent_json.c",
    "portmanager_agent_dns.c", "portmanager_agent_scan.c", "portmanager_agent_output.c", "portmanager_agent_publication.c"].map(file => `native/agent/${file}`)
    .concat(["native/shared/pm_peer_process.c", "native/shared/pm_dev_log.c"]), agent, ["-pthread"]);
  const inspect = (pid: number) => {
    const result = JSON.parse(execFileSync(identity, ["identity", String(pid)], { encoding: "utf8", timeout: 2000 })) as Pick<Scope, "pid" | "birth">;
    assert.equal(result.pid, pid); assert.ok(Number.isSafeInteger(result.birth) && result.birth > 0);
    return { pid: result.pid, birth: result.birth };
  };
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1", PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "1" };
  delete environment.DYLD_INSERT_LIBRARIES; delete environment.LD_PRELOAD; delete environment.BASH_ENV; delete environment.ENV;
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([exited, delay(3000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    for (const child of orphaned) {
      try { if (inspect(child.pid).birth === child.birth) process.kill(child.pid, "SIGKILL"); } catch {}
    }
    for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tokenPath = path.join(security, "agent-control/controller.key"), token = ensureAgentControllerToken(tokenPath);
  const tokenA = ensureAgentNetworkToken("fixture", "network-a", tokenPath), tokenB = ensureAgentNetworkToken("fixture", "network-b", tokenPath);
  const agentSocket = path.join(security, "sockets/agent.sock"), brokerSocket = path.join(security, "sockets/a.sock");
  const nativeAgent = spawn(agent, ["--socket", agentSocket, "--route-table", path.join(security, "routes.json"), "--dns-port", "0", "--controller-token-file", tokenPath],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] }); children.push(nativeAgent);
  const nativeBroker = spawn(broker, ["--socket", brokerSocket, "--network-id", "network-a", "--loopback-host", "127.0.0.1"],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(nativeBroker);
  await once(nativeBroker.stdout!, "data");
  const startupDeadline = Date.now() + 5000;
  while (!fs.existsSync(agentSocket)) { assert.ok(Date.now() < startupDeadline, "fixture agent did not start"); await delay(10); }
  async function request(method: string, payload: unknown, authorization = token, authorizationNetworkId?: string): Promise<Reply> {
    const socket = net.createConnection(agentSocket); sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("fixture controller response timed out")); }, 5000);
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => socket.write(JSON.stringify({ id: "scope-fixture", method, payload, authorization, authorizationNetworkId }) + "\n"));
      let response = "";
      socket.on("data", bytes => {
        response += bytes.toString();
        if (response.length > 4096) { clearTimeout(timer); socket.destroy(); reject(new Error("unexpected fixture response size")); return; }
        if (!response.includes("\n")) return;
        clearTimeout(timer); socket.destroy(); resolve(JSON.parse(response.split("\n")[0]) as Reply);
      });
    });
  }
  assert.equal(((await request("daemonStatus", {})).payload as { authenticatesProcessScopes?: boolean }).authenticatesProcessScopes, true);
  const own = networkNamespacePaths(root, "network-a"); fs.mkdirSync(own.filesDirectory, { recursive: true, mode: 0o700 });
  const profilePath = path.join(security, "profiles/a.sb");
  fs.writeFileSync(profilePath, buildMacosNetworkSandboxProfile({ networkId: "network-a", namespaceDirectories: [own.directory], sharedWorkspaceDirectories: [root], agentSocketPath: brokerSocket }), { mode: 0o600 });
  const args = (controlSocket: string, command: string[]) => ["--profile", profilePath, "--broker", brokerSocket, "--hook", hook,
    "--network-id", "network-a", "--agent-socket", controlSocket, "--controller-token-file", tokenPath, "--announce-ready", "--", ...command];
  const marker = path.join(root, "program-entered.js"), state = path.join(root, "nested/state.pid");
  const delayedSocket = path.join(security, "sockets/delayed.sock");
  let offered: Scope | undefined, release: (() => Promise<void>) | undefined;
  const delayed = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", bytes => {
      input += bytes.toString();
      if (!input.includes("\n")) return;
      const frame = JSON.parse(input.split("\n")[0]) as { payload: Scope; authorization: string };
      assert.equal(frame.authorization, token); offered = frame.payload;
      release = async () => {
        const accepted = await request("registerProcessScope", frame.payload);
        assert.equal(accepted.ok, true);
        socket.end(JSON.stringify({ ...accepted, type: "response", id: "launch-scope", method: "registerProcessScope" }) + "\n");
      };
    });
  }); servers.push(delayed); delayed.listen(delayedSocket); await once(delayed, "listening");
  const guarded = spawn(launcher, args(delayedSocket, [process.execPath, "-e", `
    const fs=require('fs'),cp=require('child_process');
    fs.writeFileSync(${JSON.stringify(marker)},'entered');
    fs.writeFileSync(${JSON.stringify(state)},'own-state');
    const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),30000)'],{detached:true,stdio:'ignore',env:{...process.env,PORT_MANAGER_NETWORK_ID:'network-b'}});
    console.log('DESC_PID='+child.pid); child.unref(); setInterval(()=>{},1000);
  `]), { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(guarded);
  let output = "", errors = "";
  guarded.stdout!.on("data", bytes => output += bytes.toString());
  guarded.stderr!.on("data", bytes => errors += bytes.toString());
  const offerDeadline = Date.now() + 5000;
  while (!release || !offered) { assert.ok(Date.now() < offerDeadline); await delay(10); }
  const offeredIdentity = inspect(offered.pid); assert.equal(offered.birth, offeredIdentity.birth);
  await delay(150);
  assert.equal(fs.existsSync(marker), false, "guard must not run the program while controller registration is pending");
  assert.equal(output, "", "no readiness may be announced before controller acknowledgement");
  await release();
  const runDeadline = Date.now() + 5000;
  while (!/DESC_PID=\d+/.test(output) || !output.includes("ready pid=")) {
    assert.equal(guarded.exitCode, null, `guard exited; stdout=${output}; stderr=${errors}`);
    assert.ok(Date.now() < runDeadline, `stdout=${output}; stderr=${errors}`); await delay(10);
  }
  assert.equal(fs.readFileSync(marker, "utf8"), "entered");
  assert.equal(fs.readFileSync(path.join(own.filesDirectory, "nested/state.pid"), "utf8"), "own-state", "kernel execution must preserve automatic nested state splitting");
  assert.deepEqual((await request("resolveProcessScope", offeredIdentity)).payload, offered);
  assert.equal((await request("registerProcessScope", { ...offered, networkId: "network-b" })).ok, false);
  assert.equal((await request("resolveProcessScope", { ...offeredIdentity, birth: offeredIdentity.birth + 1 })).ok, false);
  for (const method of ["registerProcessScope", "resolveProcessScope"]) {
    assert.equal((await request(method, offered, "")).ok, false);
    assert.equal((await request(method, offered, tokenA, "network-a")).ok, false);
    assert.equal((await request(method, offered, tokenB, "network-b")).ok, false);
  }
  const descendantPid = Number(/DESC_PID=(\d+)/.exec(output)![1]);
  const descendantIdentity = inspect(descendantPid); orphaned.push(descendantIdentity);
  assert.deepEqual((await request("resolveProcessScope", descendantIdentity)).payload, { ...descendantIdentity, networkId: "network-a" }, "forged child env must lose to actual controller ancestry");
  assert.equal((await request("registerExistingProcess", { pid: descendantPid, networkId: "network-b", requestedPort: 31001, actualPort: 31001, source: "registered", host: "127.0.0.1" })).ok, false,
    "controller route recovery cannot overwrite an authenticated child with its forged env network");
  const exit = once(guarded, "exit"); guarded.kill("SIGTERM"); await exit;
  assert.deepEqual((await request("resolveProcessScope", descendantIdentity)).payload, { ...descendantIdentity, networkId: "network-a" }, "an observed detached descendant retains its birth-bound scope after root exit");
  assert.equal((await request("resolveProcessScope", offeredIdentity)).ok, false, "an exited root identity cannot be replayed");

  for (const name of ["forged", "denied", "silent", "timeout"]) {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const fakePath = path.join(security, `sockets/${name}.sock`);
    let captured = false;
    const fake = net.createServer(socket => {
      sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
      socket.once("data", bytes => {
        captured = true;
        if (name === "forged") socket.end('{"type":"response","id":"wrong","method":"registerProcessScope","ok":true,"payload":{"pid":1,"birth":1,"networkId":"network-a"}}\n');
        if (name === "denied") {
          const frame = JSON.parse(bytes.toString().split("\n")[0]) as { payload: Scope };
          socket.end(JSON.stringify({ type: "response", id: "launch-scope", method: "registerProcessScope", ok: false, payload: frame.payload }) + "\n");
        }
      });
    }); servers.push(fake); fake.listen(fakePath); await once(fake, "listening");
    if (name === "forged" || name === "denied" || name === "timeout") {
      const started = Date.now();
      await assert.rejects(run(launcher, args(fakePath, ["/usr/bin/touch", marker]), { cwd: root, env: environment, timeout: 12_000 }), error =>
        (error as { code?: number; stdout?: string }).code === 125 && !/ready pid=/.test((error as { stdout?: string }).stdout ?? ""));
      if (name === "timeout") assert.ok(Date.now() - started >= 7000 && Date.now() - started < 11_000, "controller wait must use the original bounded startup deadline");
    } else {
      const waiting = spawn(launcher, args(fakePath, ["/usr/bin/touch", marker]), { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(waiting);
      const exited = once(waiting, "exit"); let waitingOutput = ""; waiting.stdout!.on("data", bytes => waitingOutput += bytes.toString());
      const deadline = Date.now() + 5000;
      while (!captured) { assert.ok(Date.now() < deadline); await delay(10); }
      const stopped = Date.now(); waiting.kill("SIGTERM");
      const stoppedResult = await Promise.race([exited, delay(1000, undefined, { ref: false }).then(() => { throw new Error("startup cancellation did not stop promptly"); })]);
      assert.equal(stoppedResult[0], 125); assert.ok(Date.now() - stopped < 1000); assert.equal(waitingOutput, "");
    }
    assert.equal(fs.existsSync(marker), false, `${name} authorization must not execute target`);
  }
});

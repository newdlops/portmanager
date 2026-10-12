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
  skip: process.platform !== "darwin", timeout: 90_000,
}, async context => {
  const source = path.resolve(__dirname, "../../..");
  const root = fs.mkdtempSync("/private/tmp/pm-launch-auth-");
  const children: ChildProcess[] = [], orphaned: Array<{ pid: number; birth: number }> = [];
  const sockets = new Set<net.Socket>(), servers: net.Server[] = [];
  const runtime = path.join(root, ".portmanager/runtime"), security = path.join(root, ".portmanager/security");
  for (const directory of [runtime, path.join(security, "profiles"), path.join(security, "sockets"), path.join(security, "agent-control"), path.join(security, "sessions")]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const launcher = path.join(runtime, "launch"), broker = path.join(runtime, "broker"), hook = path.join(runtime, "hook.dylib");
  const agent = path.join(runtime, "agent"), identity = path.join(runtime, "identity");
  const compile = (inputs: string[], output: string, extra: string[] = []) => execFileSync("cc", ["-O2", ...extra,
    ...inputs.map(input => path.join(source, input)), "-o", output], { timeout: 30_000 });
  compile(["native/network-launcher/portmanager_network_launch.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c"], launcher, ["-Wall", "-Wextra", "-Werror"]);
  compile(["native/network-broker/portmanager_network_broker.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c"], broker, ["-Wall", "-Wextra", "-Werror"]);
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
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1", PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "0" };
  delete environment.DYLD_INSERT_LIBRARIES; delete environment.LD_PRELOAD; delete environment.BASH_ENV; delete environment.ENV;
  const poison = path.join(root, "poison-bin"), poisonMarker = path.join(root, "poisoned-tool.js");
  fs.mkdirSync(poison, { mode: 0o700 });
  for (const tool of ["lsof", "ps"]) fs.writeFileSync(path.join(poison, tool),
    `#!/bin/sh\n/usr/bin/touch '${poisonMarker}'\nexit 1\n`, { mode: 0o700 });
  environment.PATH = `${poison}:${environment.PATH}`;
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
  // Witness that the deliberately shadowed tools really run without the
  // daemon's trusted child environment, then clear only this fixture marker.
  await run("/bin/sh", ["-c", "lsof; ps; exit 0"], { env: environment, timeout: 10_000 });
  assert.equal(fs.existsSync(poisonMarker), true); fs.unlinkSync(poisonMarker);
  const tokenPath = path.join(security, "agent-control/controller.key"), token = ensureAgentControllerToken(tokenPath);
  const tokenA = ensureAgentNetworkToken("fixture", "network-a", tokenPath), tokenB = ensureAgentNetworkToken("fixture", "network-b", tokenPath);
  const agentSocket = path.join(security, "sockets/agent.sock"), brokerSocket = path.join(security, "sockets/a.sock");
  const nativeAgent = spawn(agent, ["--socket", agentSocket, "--route-table", path.join(security, "routes.json"), "--dns-port", "0", "--controller-token-file", tokenPath, "--trusted-tools"],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] }); children.push(nativeAgent);
  await waitForAgent(nativeAgent, agentSocket);
  const nativeBroker = spawn(broker, ["--socket", brokerSocket, "--network-id", "network-a", "--loopback-host", "127.0.0.1",
    "--agent-socket", agentSocket, "--controller-token-file", tokenPath],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(nativeBroker);
  await once(nativeBroker.stdout!, "data");
  async function request(method: string, payload: unknown, authorization = token, authorizationNetworkId?: string, endpoint = agentSocket): Promise<Reply> {
    const socket = net.createConnection(endpoint); sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("fixture controller response timed out")); }, 5000);
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => socket.write(JSON.stringify({ id: "scope-fixture", method, payload, authorization, authorizationNetworkId }) + "\n"));
      let response = "";
      socket.on("data", bytes => {
        response += bytes.toString();
        if (response.length > (method === "repairRoutingState" ? 4 * 1024 * 1024 : 4096)) { clearTimeout(timer); socket.destroy(); reject(new Error("unexpected fixture response size")); return; }
        if (!response.includes("\n")) return;
        clearTimeout(timer); socket.destroy(); resolve(JSON.parse(response.split("\n")[0]) as Reply);
      });
    });
  }
  /** A socket pathname precedes listen(); probe the isolated daemon instead of racing bind(). */
  async function waitForAgent(child: ChildProcess, endpoint: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      assert.equal(child.exitCode, null, "fixture agent exited before readiness");
      assert.equal(child.signalCode, null, "fixture agent was killed before readiness");
      assert.ok(Date.now() < deadline, "fixture agent did not start");
      try {
        assert.equal((await request("daemonStatus", {}, token, undefined, endpoint)).ok, true);
        return;
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await delay(10);
      }
    }
  }
  const brokerIdentity = inspect(nativeBroker.pid!);
  assert.deepEqual((await request("resolveProcessScope", brokerIdentity)).payload, { ...brokerIdentity, networkId: "network-a" },
    "the broker itself must be attributed before sockets can be observed prior to FD handoff");
  assert.equal(((await request("daemonStatus", {})).payload as { authenticatesProcessScopes?: boolean }).authenticatesProcessScopes, true);
  assert.equal(((await request("daemonStatus", {})).payload as { trustedQueryTools?: boolean }).trustedQueryTools, true);
  const legacySocket = path.join(security, "sockets/legacy.sock");
  const legacy = spawn(agent, ["--socket", legacySocket, "--route-table", path.join(security, "legacy-routes.json"), "--dns-port", "0", "--controller-token-file", tokenPath],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] }); children.push(legacy);
  await waitForAgent(legacy, legacySocket);
  assert.equal(((await request("daemonStatus", {}, token, undefined, legacySocket)).payload as { authenticatesProcessScopes?: boolean }).authenticatesProcessScopes, false);
  assert.equal((await request("registerProcessScope", { ...inspect(process.pid), networkId: "network-a" }, token, undefined, legacySocket)).ok, false,
    "an agent using mutable project PATH must never approve guarded execution");
  const own = networkNamespacePaths(root, "network-a"); fs.mkdirSync(own.filesDirectory, { recursive: true, mode: 0o700 });
  const profilePath = path.join(security, "profiles/a.sb");
  fs.writeFileSync(profilePath, buildMacosNetworkSandboxProfile({ networkId: "network-a", namespaceDirectories: [own.directory], sharedWorkspaceDirectories: [root], agentSocketPath: brokerSocket }), { mode: 0o600 });
  const args = (controlSocket: string, command: string[], readyFile?: string) => ["--profile", profilePath, "--broker", brokerSocket, "--hook", hook,
    "--network-id", "network-a", "--agent-socket", controlSocket, "--controller-token-file", tokenPath, "--announce-ready",
    ...(readyFile ? ["--ready-file", readyFile] : []), "--", ...command];
  const readyFile = path.join(security, "sessions/guarded.json");
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
        socket.end(JSON.stringify({ ...accepted, type: "response", id: "scope-register", method: "registerProcessScope" }) + "\n");
      };
    });
  }); servers.push(delayed); delayed.listen(delayedSocket); await once(delayed, "listening");
  const guarded = spawn(launcher, args(delayedSocket, [process.execPath, "-e", `
    const fs=require('fs'),cp=require('child_process'),net=require('net');
    fs.writeFileSync(${JSON.stringify(marker)},'entered');
    fs.writeFileSync(${JSON.stringify(state)},'own-state');
    for(const action of [()=>fs.readFileSync(${JSON.stringify(readyFile)}),()=>fs.writeFileSync(${JSON.stringify(readyFile)},'forged')]) {
      let denied=false;try{action()}catch(error){denied=['EPERM','EACCES'].includes(error.code)}
      if(!denied)throw Error('workload accessed private readiness file');
    }
    process.env.PORT_MANAGER_NETWORK_ID='network-b'; process.env.PORT_MANAGER_HOOK_DISABLED='1';
    process.env.PORT='1'; process.env.PORT_MANAGER_NETWORK_LOOPBACK_HOST='127.255.255.254';
    net.createServer().listen(0,'127.0.0.1',function(){console.log('LISTEN_PORT='+this.address().port)});
    const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),30000)'],{detached:true,stdio:'ignore',env:{...process.env,PORT_MANAGER_NETWORK_ID:'network-b'}});
    console.log('DESC_PID='+child.pid); child.unref(); setInterval(()=>{},1000);
  `], readyFile), { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(guarded);
  let output = "", errors = "";
  guarded.stdout!.on("data", bytes => output += bytes.toString());
  guarded.stderr!.on("data", bytes => errors += bytes.toString());
  const offerDeadline = Date.now() + 5000;
  while (!release || !offered) { assert.ok(Date.now() < offerDeadline); await delay(10); }
  const offeredIdentity = inspect(offered.pid); assert.equal(offered.birth, offeredIdentity.birth);
  await delay(150);
  assert.equal(fs.existsSync(marker), false, "guard must not run the program while controller registration is pending");
  assert.equal(output, "", "no readiness may be announced before controller acknowledgement");
  assert.equal(fs.existsSync(readyFile), false, "private readiness cannot be published before registration and exec");
  assert.equal(fs.existsSync(readyFile + ".owner"), true, "private ownership must precede the exec acknowledgement");
  assert.equal(fs.existsSync(readyFile + ".cleaned"), false);
  await release();
  const runDeadline = Date.now() + 5000;
  while (!/DESC_PID=\d+/.test(output) || !/LISTEN_PORT=\d+/.test(output) || !output.includes("ready pid=")) {
    assert.equal(guarded.exitCode, null, `guard exited; stdout=${output}; stderr=${errors}`);
    assert.ok(Date.now() < runDeadline, `stdout=${output}; stderr=${errors}`); await delay(10);
  }
  assert.equal(fs.readFileSync(marker, "utf8"), "entered");
  assert.deepEqual(JSON.parse(fs.readFileSync(readyFile, "utf8")), { supervisorPid: guarded.pid, supervisorBirth: inspect(guarded.pid!).birth, ...offered });
  const readyStat = fs.statSync(readyFile); assert.equal(readyStat.mode & 0o777, 0o600); assert.equal(readyStat.nlink, 1);
  assert.equal(fs.readFileSync(path.join(own.filesDirectory, "nested/state.pid"), "utf8"), "own-state", "kernel execution must preserve automatic nested state splitting");
  assert.deepEqual((await request("resolveProcessScope", offeredIdentity)).payload, offered);
  const actualPort = Number(/LISTEN_PORT=(\d+)/.exec(output)![1]);
  const repaired = await request("repairRoutingState", {});
  assert.equal(repaired.ok, true, repaired.error);
  const routes = (repaired.payload as { routes: Array<{ networkId?: string; actualPort: number; logicalPort: number }> }).routes;
  const recovered = routes.find(route => route.actualPort === actualPort);
  assert.ok(recovered, `missing scoped listener ${actualPort}`);
  assert.equal(recovered.networkId, "network-a", "native repair must use pre-exec controller identity, never the forged network-b env");
  assert.equal(recovered.logicalPort, actualPort, "broker same-port recovery must ignore the forged PORT hint");
  assert.equal(fs.existsSync(poisonMarker), false, "trusted lsof/ps must not execute shadowed project tools");
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
  assert.equal(fs.existsSync(readyFile), false, "supervisor must remove its own readiness inode on exit");
  const ownerRecord = JSON.parse(fs.readFileSync(readyFile + ".owner", "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(readyFile + ".cleaned", "utf8")), { ...ownerRecord, cleaned: true });
  assert.equal((await request("resolveProcessScope", descendantIdentity)).ok, false, "terminal shutdown must finish its detached descendant before returning");
  assert.equal((await request("resolveProcessScope", offeredIdentity)).ok, false, "an exited root identity cannot be replayed");

  // This child deliberately becomes an orphan before it performs any TCP work.
  // Its intermediate parent exits while the registered workload root stays
  // alive. Ancestry alone cannot recover it after reparenting to PID 1.
  const orphanReady = path.join(root, "orphan-ready.js"), triggers = [1, 2].map(index => path.join(root, `orphan-go-${index}.js`));
  const results = [1, 2].map(index => path.join(root, `orphan-result-${index}.js`));
  const echo = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    socket.once("data", bytes => { assert.equal(bytes.toString(), "fixture"); socket.end("ok"); });
  }); servers.push(echo); echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const echoPort = (echo.address() as net.AddressInfo).port;
  const orphanCode = `
    const fs=require('fs'),net=require('net'); let attempt=0,busy=false;
    const triggers=${JSON.stringify(triggers)},results=${JSON.stringify(results)};
    setInterval(()=>{
      if(process.ppid!==1)return;
      fs.writeFileSync(${JSON.stringify(orphanReady)},'orphan');
      if(busy||attempt>=triggers.length||!fs.existsSync(triggers[attempt]))return;
      busy=true;
      const socket=net.connect(${echoPort},'127.0.0.1',()=>socket.write('fixture'));
      socket.on('error',error=>{fs.writeFileSync(results[attempt],error.code);attempt++;busy=false;});
      socket.on('data',bytes=>{fs.writeFileSync(results[attempt],bytes);attempt++;busy=false;socket.end();});
    },20);
  `;
  const orphanPidFile = path.join(root, "orphan-pid.js");
  const intermediateCode = `
    const cp=require('child_process'),fs=require('fs');
    const child=cp.spawn(process.execPath,['-e',${JSON.stringify(orphanCode)}],{detached:true,stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(orphanPidFile)},String(child.pid));child.unref();setTimeout(()=>process.exit(0),50);
  `;
  const shortParent = spawn(launcher, args(agentSocket, [process.execPath, "-e", `
    const cp=require('child_process');
    const child=cp.spawn(process.execPath,['-e',${JSON.stringify(intermediateCode)}],{detached:true,stdio:'ignore',
      env:{...process.env,PORT_MANAGER_NETWORK_ID:'network-b',PORT_MANAGER_HOOK_DISABLED:'1'}});
    child.unref();setInterval(()=>{},1000);
  `]), { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(shortParent);
  let shortOutput = ""; shortParent.stdout!.on("data", bytes => shortOutput += bytes.toString());
  const shortExit = once(shortParent, "exit");
  async function until(predicate: () => boolean, message: string, milliseconds = 5000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) { assert.ok(Date.now() < deadline, message); await delay(10); }
  }
  await until(() => fs.existsSync(orphanPidFile), "orphan fixture did not start");
  const earlyOrphan = inspect(Number(fs.readFileSync(orphanPidFile, "utf8"))); orphaned.push(earlyOrphan);
  await until(() => fs.existsSync(orphanReady), "child must be orphaned before scope observation");
  assert.equal((await request("resolveProcessScope", earlyOrphan)).payload, null,
    "no previously observed ancestry may accidentally satisfy the orphan test");
  fs.writeFileSync(triggers[0], "go");
  await until(() => fs.existsSync(results[0]), "orphan TCP request did not finish");
  assert.equal(fs.readFileSync(results[0], "utf8"), "ok");
  assert.deepEqual((await request("resolveProcessScope", earlyOrphan)).payload, { ...earlyOrphan, networkId: "network-a" },
    "the fixed broker must register the actual orphan PID/birth before opening TCP");

  const idleReadyFile = path.join(security, "sessions/idle.json");
  const idle = spawn(launcher, args(agentSocket, [process.execPath, "-e", "setInterval(()=>{},1000)"], idleReadyFile),
    { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(idle);
  let idleOutput = ""; idle.stdout!.on("data", bytes => idleOutput += bytes.toString());
  await until(() => /ready pid=\d+ birth=\d+/.test(idleOutput), "idle guarded process did not start");
  const idleMatch = /ready pid=(\d+) birth=(\d+)/.exec(idleOutput)!;
  const idleIdentity = { pid: Number(idleMatch[1]), birth: Number(idleMatch[2]) };
  const agentExit = once(nativeAgent, "exit"); nativeAgent.kill("SIGTERM"); await agentExit;
  await delay(150);
  const replacement = spawn(agent, ["--socket", agentSocket, "--route-table", path.join(security, "routes.json"), "--dns-port", "0",
    "--controller-token-file", tokenPath, "--trusted-tools"], { env: environment, stdio: ["ignore", "ignore", "pipe"] }); children.push(replacement);
  await until(() => fs.existsSync(agentSocket), "replacement controller did not start");
  assert.equal((await request("resolveProcessScope", brokerIdentity)).payload, null);
  assert.equal((await request("resolveProcessScope", earlyOrphan)).payload, null);
  const refreshDeadline = Date.now() + 5000;
  while ((await request("resolveProcessScope", idleIdentity)).payload === null) {
    assert.ok(Date.now() < refreshDeadline, "supervisor must re-register an idle child after controller replacement"); await delay(20);
  }
  assert.deepEqual((await request("resolveProcessScope", idleIdentity)).payload, { ...idleIdentity, networkId: "network-a" });
  assert.equal(idle.exitCode, null, "kernel-guarded idle program must survive controller replacement");
  fs.writeFileSync(triggers[1], "go");
  await until(() => fs.existsSync(results[1]), "broker request after replacement did not finish");
  assert.equal(fs.readFileSync(results[1], "utf8"), "ok");
  for (const identity of [earlyOrphan, brokerIdentity]) {
    assert.deepEqual((await request("resolveProcessScope", identity)).payload, { ...identity, networkId: "network-a" });
  }
  shortParent.kill("SIGTERM"); await shortExit;
  assert.equal((await request("resolveProcessScope", earlyOrphan)).ok, false, "the unobserved-ancestry orphan must also be reclaimed before supervisor exit");
  fs.renameSync(idleReadyFile, path.join(security, "sessions/retained-idle.json"));
  fs.writeFileSync(idleReadyFile, "replacement", { mode: 0o600 });
  const idleExit = once(idle, "exit"); idle.kill("SIGTERM"); await idleExit;
  assert.equal(fs.readFileSync(idleReadyFile, "utf8"), "replacement", "cleanup must preserve a replacement record with a different inode");

  const publicParent = path.join(security, "sessions/public"); fs.mkdirSync(publicParent, { mode: 0o755 });
  const redirected = path.join(security, "sessions/redirected"); fs.symlinkSync(path.join(security, "sessions"), redirected);
  const existingRecord = path.join(security, "sessions/existing.json"); fs.writeFileSync(existingRecord, "preserve", { mode: 0o600 });
  for (const invalid of [existingRecord, path.join(publicParent, "public.json"), path.join(redirected, "redirect.json"), path.join(root, "outside.json")]) {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    await assert.rejects(run(launcher, args(agentSocket, ["/usr/bin/touch", marker], invalid), { cwd: root, env: environment, timeout: 3000 }),
      error => (error as { code?: number; stdout?: string }).code === 125 && !/ready pid=/.test((error as { stdout?: string }).stdout ?? ""));
    assert.equal(fs.existsSync(marker), false, "an invalid readiness destination must be rejected before workload exec");
  }
  assert.equal(fs.readFileSync(existingRecord, "utf8"), "preserve");

  const refreshSocketPath = path.join(security, "sockets/refresh-silent.sock");
  let refreshCount = 0, refreshPending = false, refreshClosed = false;
  const silentRefresh = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    socket.once("data", async bytes => {
      const frame = JSON.parse(bytes.toString().split("\n")[0]) as { payload: Scope };
      if (refreshCount++ === 0) {
        const accepted = await request("registerProcessScope", frame.payload); assert.equal(accepted.ok, true);
        socket.end(JSON.stringify({ ...accepted, type: "response", id: "scope-register", method: "registerProcessScope" }) + "\n");
      } else { refreshPending = true; socket.once("close", () => refreshClosed = true); }
    });
  }); servers.push(silentRefresh); silentRefresh.listen(refreshSocketPath); await once(silentRefresh, "listening");
  const refreshing = spawn(launcher, args(refreshSocketPath, [process.execPath, "-e", "setInterval(()=>{},1000)"]),
    { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(refreshing);
  await until(() => refreshPending, "supervisor must use a bounded asynchronous renewal after startup");
  const refreshingExit = once(refreshing, "exit"), refreshStop = Date.now(); refreshing.kill("SIGTERM");
  await until(() => refreshClosed, "stop must promptly close pending controller FD before descendant census", 1000);
  assert.ok(Date.now() - refreshStop < 1000);
  await Promise.race([refreshingExit, delay(5000).then(() => { throw new Error("descendant cleanup did not finish after refresh cancellation"); })]);

  for (const name of ["forged", "denied", "silent", "timeout"]) {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const fakePath = path.join(security, `sockets/${name}.sock`);
    let captured = false, capturedAt: number | undefined;
    const fake = net.createServer(socket => {
      sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
      socket.once("data", bytes => {
        captured = true; capturedAt ??= Date.now();
        if (name === "forged") socket.end('{"type":"response","id":"wrong","method":"registerProcessScope","ok":true,"payload":{"pid":1,"birth":1,"networkId":"network-a"}}\n');
        if (name === "denied") {
          const frame = JSON.parse(bytes.toString().split("\n")[0]) as { payload: Scope };
          socket.end(JSON.stringify({ type: "response", id: "scope-register", method: "registerProcessScope", ok: false, payload: frame.payload }) + "\n");
        }
      });
    }); servers.push(fake); fake.listen(fakePath); await once(fake, "listening");
    if (name === "forged" || name === "denied" || name === "timeout") {
      const started = Date.now();
      await assert.rejects(run(launcher, args(fakePath, ["/usr/bin/touch", marker]), { cwd: root, env: environment, timeout: 12_000 }), error =>
        (error as { code?: number; stdout?: string }).code === 125 && !/ready pid=/.test((error as { stdout?: string }).stdout ?? ""));
      if (name === "timeout") {
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 7000 && elapsed < 11_000,
          `controller wait must use the original bounded startup deadline (elapsed=${elapsed}ms, requestDelay=${capturedAt === undefined ? "missing" : capturedAt - started}ms)`);
      }
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

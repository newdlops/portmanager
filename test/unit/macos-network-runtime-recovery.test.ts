import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ensureAgentControllerToken } from "../../src/agent/agent-authorization";
import type { AuthenticatedProcessScope } from "../../src/agent/protocol";
import { ProxyNetworkResources } from "../../src/platform/ports/proxy-network-resources";
import { MacosNetworkRuntime } from "../../src/platform/process/macos-network-runtime";
import { NativeProcessLookupProvider } from "../../src/platform/process/native-process-lookup";
import { buildNodeRuntimeEnvironment } from "../../src/platform/process/node-runtime";

/** A failed recovery retains the live workload's reservation. Fixing its
 * private record must permit another attempt without disturbing another realm. */
test("guarded owner retries an exited failed recovery and releases only its proven-clean scope", {
  skip: process.platform !== "darwin", timeout: 45_000,
}, async context => {
  const artifactDirectory = path.resolve(__dirname, "../../../media/native");
  const root = fs.mkdtempSync("/private/tmp/pm-owner-retry-"), workspace = path.join(root, "project");
  const state = path.join(root, ".portmanager"), security = path.join(state, "security");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(security, "agent-control"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(security, "sockets"), { recursive: true, mode: 0o700 });
  const tokenPath = path.join(security, "agent-control/controller.key"), token = ensureAgentControllerToken(tokenPath);
  const socketPath = path.join(security, "sockets/agent.sock"), environment = buildNodeRuntimeEnvironment();
  const agent = spawn(path.join(artifactDirectory, "portmanager_agent"), ["--socket", socketPath,
    "--route-table", path.join(security, "routes.json"), "--controller-token-file", tokenPath,
    "--trusted-tools", "--dns-port", "0"], { env: environment, stdio: "ignore" });
  const resources = new ProxyNetworkResources(), terminals: ChildProcess[] = [];
  const lookup = new NativeProcessLookupProvider({ helperPath: path.join(artifactDirectory, "portmanager_process_lookup") });
  const survivors: { pid: number; birth: number }[] = [];
  async function request<T>(method: string, payload: unknown = {}): Promise<T> {
    const socket = net.createConnection(socketPath);
    return new Promise<T>((resolve, reject) => {
      let input = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Recovery fixture controller timed out.")); }, 3000);
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => socket.write(JSON.stringify({ id: "owner-retry", method, payload, authorization: token }) + "\n"));
      socket.on("data", bytes => {
        input += bytes.toString(); if (!input.includes("\n")) return;
        clearTimeout(timer); socket.destroy();
        const reply = JSON.parse(input.split("\n")[0]);
        if (reply.ok) resolve(reply.payload as T); else reject(new Error(reply.error));
      });
    });
  }
  const runtime = new MacosNetworkRuntime({ artifactDirectory, stateDirectory: state, resources,
    agentSocketPath: socketPath, controllerTokenFilePath: tokenPath,
    ensureController: async () => { assert.equal((await request<{ authenticatesProcessScopes: boolean }>("daemonStatus")).authenticatesProcessScopes, true); },
    resolveScope: identity => request<AuthenticatedProcessScope | null>("resolveProcessScope", identity),
    readIdentity: pid => lookup.readProcessIdentity(pid), signalProcess: (identity, signal) => lookup.signalProcess(identity, signal) });
  let obstruction: string | undefined;
  const priorZdotdir = process.env.ZDOTDIR;
  process.env.ZDOTDIR = path.join(root, "empty-profiles"); fs.mkdirSync(process.env.ZDOTDIR, { mode: 0o700 });
  context.after(async () => {
    if (obstruction !== undefined) fs.rmSync(obstruction, { recursive: true, force: true });
    await runtime.dispose();
    // Failure cleanup targets only identities created and captured by this fixture.
    for (const expected of survivors) await lookup.signalProcess(expected, "SIGKILL");
    for (const child of terminals) if (child.exitCode === null && child.signalCode === null) {
      const identity = await lookup.readProcessIdentity(child.pid!);
      if (identity !== undefined) await lookup.signalProcess(identity, "SIGKILL");
    }
    if (agent.exitCode === null && agent.signalCode === null) { const ended = once(agent, "exit"); agent.kill("SIGTERM"); await ended; }
    if (priorZdotdir === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = priorZdotdir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function until(predicate: () => boolean, message: string) {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { assert.ok(Date.now() < deadline, message); await delay(20); }
  }
  await until(() => fs.existsSync(socketPath), "Controller did not start.");
  async function start(networkId: string) {
    const launch = await runtime.prepareShell({ id: networkId, name: networkId, loopbackHost: "127.0.0.1",
      workspaceDirectories: [workspace], routes: [] }, workspace, "/bin/zsh");
    const terminal = spawn(launch.shellPath, [...launch.shellArgs], { cwd: workspace, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    terminals.push(terminal); terminal.stdout!.on("data", () => {}); terminal.stderr!.on("data", () => {});
    await runtime.adoptSupervisor(launch.id, terminal.pid!);
    const identity = await runtime.waitReady(launch.id); survivors.push(identity);
    return { launch, terminal, identity };
  }
  const b = await start("retry-b"), baseline = { ...resources.budget.used };
  const a = await start("retry-a"), reserved = { ...resources.budget.used };
  const witness = path.join(workspace, "detached-child.json");
  const program = `const c=require('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{...process.env}});require('node:fs').writeFileSync(${JSON.stringify(witness)},JSON.stringify({pid:c.pid}));c.unref();`;
  a.terminal.stdin!.write(`${quote(process.execPath)} -e ${quote(program)}\n`);
  await until(() => fs.existsSync(witness), "Detached workload did not start.");
  const orphan = await lookup.readProcessIdentity(JSON.parse(fs.readFileSync(witness, "utf8")).pid);
  assert.ok(orphan); survivors.push(orphan);
  obstruction = path.join(security, "sessions", a.launch.id, "ready.json.cleaned");
  fs.writeFileSync(obstruction, JSON.stringify({ cleaned: false }) + "\n", { mode: 0o600 });
  const parent = await lookup.readProcessIdentity(a.terminal.pid!); assert.ok(parent);
  const crashed = once(a.terminal, "exit"); assert.equal(await lookup.signalProcess(parent, "SIGKILL"), true); await crashed;
  await assert.rejects(runtime.closeShell(a.launch.id), /recovery helper has not completed/);
  assert.deepEqual(resources.budget.used, reserved, "Failed recovery must keep all reservations.");
  assert.equal(runtime.activeShells.length, 2);
  // The shell may exit on PTY/stdio EOF when its parent disappears; its
  // detached child is the survivor whose cleanup still requires proof.
  assert.deepEqual(await lookup.readProcessIdentity(orphan.pid), orphan);
  assert.deepEqual(await lookup.readProcessIdentity(b.identity.pid), { pid: b.identity.pid, birth: b.identity.birth });
  fs.unlinkSync(obstruction); obstruction = undefined;
  await runtime.closeShell(a.launch.id);
  assert.equal(await lookup.readProcessIdentity(a.identity.pid), undefined);
  assert.equal(await lookup.readProcessIdentity(orphan.pid), undefined);
  assert.deepEqual(await lookup.readProcessIdentity(b.identity.pid), { pid: b.identity.pid, birth: b.identity.birth });
  assert.deepEqual(resources.budget.used, baseline, "Retry may release only the recovered realm.");
  assert.deepEqual(runtime.activeShells.map(shell => shell.id), [b.launch.id]);
  await runtime.closeShell(b.launch.id);
  assert.ok(Object.values(resources.budget.used).every(value => value === 0));
});

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

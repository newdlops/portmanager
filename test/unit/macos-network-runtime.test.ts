import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ensureAgentControllerToken } from "../../src/agent/agent-authorization";
import { ProxyNetworkResources } from "../../src/platform/ports/proxy-network-resources";
import { MacosNetworkRuntime } from "../../src/platform/process/macos-network-runtime";
import { NativeProcessLookupProvider } from "../../src/platform/process/native-process-lookup";
import { buildNodeRuntimeEnvironment } from "../../src/platform/process/node-runtime";
import type { AuthenticatedProcessScope } from "../../src/agent/protocol";

/** Production owner, broker, launcher, real kernel and installed Node cooperate. */
test("guarded runtime preserves host TCP access, trusted readiness and returns every reservation", {
  skip: process.platform !== "darwin", timeout: 30_000,
}, async context => {
  const source = path.resolve(__dirname, "../../..");
  const artifactDirectory = path.join(source, "media/native");
  const root = fs.mkdtempSync("/private/tmp/pm-runtime-");
  const workspace = path.join(root, "project");
  const state = path.join(root, ".portmanager");
  const security = path.join(state, "security");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(security, "agent-control"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(security, "sockets"), { recursive: true, mode: 0o700 });
  const tokenPath = path.join(security, "agent-control/controller.key");
  const token = ensureAgentControllerToken(tokenPath);
  const socketPath = path.join(security, "sockets/agent.sock");
  const environment = buildNodeRuntimeEnvironment();
  const agent = spawn(path.join(artifactDirectory, "portmanager_agent"), ["--socket", socketPath,
    "--route-table", path.join(security, "routes.json"), "--controller-token-file", tokenPath,
    "--trusted-tools", "--dns-port", "0"], { env: environment, stdio: "ignore" });
  let terminal: ChildProcess | undefined;
  const resources = new ProxyNetworkResources();
  const lookup = new NativeProcessLookupProvider({ helperPath: path.join(artifactDirectory, "portmanager_process_lookup") });
  async function request<T>(method: string, payload: unknown = {}): Promise<T> {
    const socket = net.createConnection(socketPath);
    return new Promise<T>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("fixture controller timed out")); }, 3000);
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => socket.write(JSON.stringify({ id: "runtime-fixture", method, payload, authorization: token }) + "\n"));
      socket.on("data", bytes => {
        buffer += bytes.toString();
        if (!buffer.includes("\n")) return;
        clearTimeout(timer); socket.destroy();
        const response = JSON.parse(buffer.split("\n")[0]);
        if (!response.ok) reject(new Error(response.error)); else resolve(response.payload as T);
      });
    });
  }
  const runtime = new MacosNetworkRuntime({ artifactDirectory, stateDirectory: state, resources,
    agentSocketPath: socketPath, controllerTokenFilePath: tokenPath,
    ensureController: async () => {
      const status = await request<{ authenticatesProcessScopes: boolean }>("daemonStatus");
      assert.equal(status.authenticatesProcessScopes, true);
    }, resolveScope: identity => request<AuthenticatedProcessScope | null>("resolveProcessScope", identity),
    readIdentity: pid => lookup.readProcessIdentity(pid) });
  const echo = net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket));
  const echoClients = new Set<net.Socket>();
  echo.on("connection", socket => { echoClients.add(socket); socket.on("error", () => {}); socket.once("close", () => echoClients.delete(socket)); });
  await new Promise<void>(resolve => echo.listen(0, "127.0.0.1", resolve));
  const echoPort = (echo.address() as net.AddressInfo).port;
  context.after(async () => {
    await runtime.dispose();
    if (terminal !== undefined && terminal.exitCode === null && terminal.signalCode === null) terminal.kill("SIGKILL");
    for (const socket of echoClients) socket.destroy();
    await new Promise<void>(resolve => echo.close(() => resolve()));
    if (agent.exitCode === null && agent.signalCode === null) { const exited = once(agent, "exit"); agent.kill("SIGTERM"); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(socketPath)) { assert.ok(Date.now() < deadline); await delay(10); }
  const priorZdotdir = process.env.ZDOTDIR;
  process.env.ZDOTDIR = path.join(root, "empty-profiles");
  fs.mkdirSync(process.env.ZDOTDIR, { mode: 0o700 });
  let launch;
  try {
    launch = await runtime.prepareShell({ id: "runtime-a", name: "Runtime A", loopbackHost: "127.0.0.1",
      workspaceDirectories: [workspace], routes: [{ port: 4567, targetHost: "127.0.0.1", targetPort: echoPort }] }, workspace, "/bin/zsh");
  } finally { if (priorZdotdir === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = priorZdotdir; }
  assert.equal(resources.budget.used.nativeHelpers, 2);
  assert.equal(resources.budget.used.nativeScopeJobs, 65);
  terminal = spawn(launch.shellPath, [...launch.shellArgs], { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  terminal.stdout!.on("data", bytes => { output += bytes.toString(); });
  terminal.stderr!.on("data", bytes => { errors += bytes.toString(); });
  await runtime.adoptSupervisor(launch.id, terminal.pid!);
  const identity = await runtime.waitReady(launch.id);
  assert.equal(identity.networkId, "runtime-a");
  assert.notEqual(identity.pid, terminal.pid);
  const program = `const net=require('node:net');const s=net.connect(4567,'127.0.0.1');let value='';s.on('connect',()=>s.end('runtime-echo'));s.on('data',b=>value+=b);s.on('end',()=>{if(value!=='runtime-echo')process.exit(2);require('node:fs').writeFileSync('runtime-success.json',JSON.stringify({value,networkId:process.env.PORT_MANAGER_NETWORK_ID}))});s.on('error',()=>process.exit(3));`;
  terminal.stdin!.write(`${quote(process.execPath)} -e ${quote(program)}\n`);
  const responseDeadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(workspace, "runtime-success.json"))) {
    assert.equal(terminal.exitCode, null, `terminal exited: ${errors}`);
    assert.ok(Date.now() < responseDeadline, `guarded client failed: ${errors}`);
    await delay(10);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, "runtime-success.json"), "utf8")), { value: "runtime-echo", networkId: "runtime-a" });
  await runtime.closeShell(launch.id);
  assert.deepEqual(Object.values(resources.budget.used), Object.values(resources.budget.used).map(() => 0));
  assert.equal(runtime.activeShells.length, 0);
});

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

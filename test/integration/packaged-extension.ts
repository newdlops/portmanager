import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import type { PortManagerExtensionApi } from "../../src/extension/activate";
import type { AgentDaemonStatus } from "../../src/shared/types";
import type { PortManagerNetworkService } from "../../src/extension/network-service";
import { runResourceSoak } from "./proxy-resource-soak";
import { preparePackagedTerminalLifecycle } from "./packaged-terminal-lifecycle";
import { isolatePrivilegedCommands } from "./packaged-isolation";

/**
 * Runs inside the real extension host against a VSIX installed in a fresh CI
 * profile. Native unit tests cover routing; this catches omitted package files,
 * activation failures, fallback runtimes, and a daemon from the wrong build.
 */
export async function run(): Promise<void> {
  const originalHomeEnvironment = process.env.HOME;
  const isolatedLocal = process.env.PM_TEST_EXECUTION_ENVIRONMENT === "isolated-local";
  assert.ok(process.env.CI === "true" || isolatedLocal, "Packaged activation requires CI or explicit local isolation.");
  if (isolatedLocal) {
    const privateHome = process.env.PM_TEST_PRIVATE_HOME!;
    assert.ok(path.isAbsolute(privateHome) && fs.realpathSync(privateHome).startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`));
    assert.equal(fs.lstatSync(privateHome).mode & 0o077, 0);
    // Storage indirection is installed before loading or activating any product
    // module. HOME, ordinary GC and every installed module byte stay unchanged.
    os.homedir = () => privateHome;
  }
  const extension = vscode.extensions.getExtension<PortManagerExtensionApi>("newdlops.portmanager");
  assert.ok(extension, "Installed extension is not discoverable.");
  assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.PM_TEST_EXTENSION_PATH!));
  assert.equal(extension.packageJSON.version, process.env.PM_TEST_EXTENSION_VERSION);
  const soakSeconds = Number(process.env.PM_TEST_RESOURCE_SOAK_SECONDS ?? 0);
  let networkService: PortManagerNetworkService | undefined;
  let serviceStarted: Promise<void> | undefined;
  const children = require("node:child_process") as typeof import("node:child_process");
  const originalSpawn = children.spawn;
  const ownedAgents = new Set<ChildProcess>();
  const commandIsolation = isolatedLocal ? isolatePrivilegedCommands() : undefined;
  if (isolatedLocal) children.spawn = ((...args: unknown[]) => {
    const executable = args[0];
    if (executable === path.join(extension.extensionPath, "media/native/portmanager_agent")) {
      const argv = args[1] as string[];
      const socket = argv[argv.indexOf("--socket") + 1];
      assert.ok(path.resolve(socket).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), "Fixture may only start a private daemon.");
      assert.ok(!argv.includes("--dns-port"));
      args[1] = [...argv, "--dns-port", "0"];
      const child = Reflect.apply(originalSpawn, children, args) as ChildProcess;
      ownedAgents.add(child);
      const recordPath = process.env.PM_TEST_PRIVATE_AGENT_RECORD;
      if (recordPath && child.pid) {
        const identity = JSON.parse(execFileSync(path.join(extension.extensionPath, "media/native/portmanager_process_lookup"),
          ["identity", String(child.pid)], { encoding: "utf8", timeout: 3000 }));
        assert.equal(identity.pid, child.pid);
        fs.writeFileSync(recordPath, JSON.stringify({ ...identity, socketPath: socket,
          tokenFilePath: argv[argv.indexOf("--controller-token-file") + 1], extensionPath: extension.extensionPath }), { mode: 0o600 });
      }
      return child;
    }
    return Reflect.apply(originalSpawn, children, args);
  }) as typeof children.spawn;
  // Observe the existing activation seam in the installed module. No testing
  // backdoor or additional public extension API is added to the product.
  const networkModule = require(path.join(extension.extensionPath, "out", "src", "extension", "network-service")) as typeof import("../../src/extension/network-service");
  const originalStart = networkModule.PortManagerNetworkService.prototype.start;
  if (soakSeconds > 0) networkModule.PortManagerNetworkService.prototype.start = function () {
    networkService = this;
    serviceStarted = originalStart.call(this);
    return serviceStarted;
  };
  let terminals: Awaited<ReturnType<typeof preparePackagedTerminalLifecycle>> | undefined;
  try {
  let api: PortManagerExtensionApi;
  try { api = await readyWithin(extension.activate(), "extension activation"); }
  finally { networkModule.PortManagerNetworkService.prototype.start = originalStart; }
  assert.equal(extension.isActive, true);
  assert.ok(Array.isArray(api.listLogicalNetworks()));
  assert.equal(typeof api.getTerminalDetachScript(), "string");
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of ["initializeWorktree", "createLogicalNetwork", "refreshTerminals", "addHostPortExposure"]) {
    assert.ok(commands.has(`portManager.${command}`), `Missing command: ${command}`);
  }

  // Activation starts the daemon in the background, so await readiness instead
  // of treating the synchronous activate() result as proof of runtime health.
  let status: AgentDaemonStatus | undefined;
  let lastError: unknown;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      status = await request<AgentDaemonStatus>("daemonStatus");
      if (status.browserDnsRunning) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(status, `Native daemon did not start: ${String(lastError)}`);
  assert.equal(status.version, extension.packageJSON.version);
  assert.ok(status.agentMainPath, "Daemon must report its package entrypoint.");
  assert.ok(fs.realpathSync(status.agentMainPath).startsWith(`${fs.realpathSync(extension.extensionPath)}${path.sep}`), "Daemon must belong to the installed VSIX.");
  const daemonCommand = execFileSync("ps", ["-p", String(status.pid), "-o", "args="], { encoding: "utf8", timeout: 3_000 }).trim();
  assert.ok(daemonCommand.includes("/media/native/portmanager_agent"), "Activation must use the native runtime.");
  assert.equal(status.browserDnsRunning, true, status.browserDnsError);
  assert.equal(await request<boolean>("flushRouteTables"), true);
  console.log(JSON.stringify({ extension: extension.id, version: status.version, platform: process.platform,
    arch: process.arch, browserDnsRunning: status.browserDnsRunning, agentMainPath: status.agentMainPath }));
  if (soakSeconds > 0) {
    assert.ok(networkService, "The soak must observe this installed extension's actual network service.");
    await readyWithin(serviceStarted!, "network service startup");
    if (isolatedLocal && process.platform === "darwin") terminals = await preparePackagedTerminalLifecycle(networkService,
      extension.extensionPath, `${process.env.PM_TEST_RESOURCE_SOAK_REPORT!}.terminals.json`);
    await runResourceSoak({ moduleRoot: extension.extensionPath, service: networkService, seconds: soakSeconds,
      reportPath: process.env.PM_TEST_RESOURCE_SOAK_REPORT!, exerciseTerminals: terminals?.exercise });
  }
  } finally {
    networkModule.PortManagerNetworkService.prototype.start = originalStart;
    try {
      await terminals?.close();
      await networkService?.disposeAsync();
      (networkService as unknown as { processService?: { dispose(): void } } | undefined)?.processService?.dispose();
      if (isolatedLocal && [...ownedAgents].some(child => child.exitCode === null && child.signalCode === null)) {
        const exited = [...ownedAgents].filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, "exit"));
        assert.equal(await request<boolean>("shutdownDaemon"), true);
        await readyWithin(Promise.all(exited), "owned daemon shutdown");
      }
      if (isolatedLocal) fs.writeFileSync(`${process.env.PM_TEST_RESOURCE_SOAK_REPORT!}.isolation.json`, JSON.stringify({
        privateHome: os.homedir(), privateSocket: path.join(os.tmpdir(), `newdlops-portmanager-agent-${process.getuid!()}.sock`),
        ownedDaemonPids: [...ownedAgents].map(child => child.pid),
        ownedDaemonsExited: [...ownedAgents].every(child => child.exitCode !== null || child.signalCode !== null),
      homeEnvironmentUnchanged: process.env.HOME === originalHomeEnvironment,
        blockedGlobalMutationCommands: commandIsolation?.blocked,
      }, null, 2));
    } finally { children.spawn = originalSpawn; commandIsolation?.restore(); }
  }
}

/** A readiness hang must end before the soak duration begins. */
async function readyWithin<T>(work: PromiseLike<T>, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Packaged ${operation} exceeded 30s.`)), 30_000);
  })]); } finally { clearTimeout(timer); }
}

/** Keeps each readiness probe bounded and ignores asynchronous snapshots. */
function request<T>(method: string): Promise<T> {
  const socketPath = path.join(os.tmpdir(), `newdlops-portmanager-agent-${process.getuid!()}.sock`);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = `packaged-${method}`;
    let buffer = "";
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), 3_000);
    const finish = (error?: Error, payload?: T): void => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(payload!);
    };
    socket.once("error", finish);
    socket.once("connect", () => {
      const auth = require(path.join(process.env.PM_TEST_EXTENSION_PATH!, "out", "src", "agent", "agent-authorization")) as typeof import("../../src/agent/agent-authorization");
      const authorization = auth.readAgentControllerToken(auth.getAgentControllerTokenPath(socketPath));
      socket.write(`${JSON.stringify({ id, method, authorization })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024 * 1024) return finish(new Error("Unexpectedly large daemon response"));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === id) return finish(response.ok ? undefined : new Error(response.error), response.payload);
        } catch (error) {
          return finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  });
}

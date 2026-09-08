import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import type { PortManagerExtensionApi } from "../../src/extension/activate";
import type { AgentDaemonStatus } from "../../src/shared/types";

/**
 * Runs inside the real extension host against a VSIX installed in a fresh CI
 * profile. Native unit tests cover routing; this catches omitted package files,
 * activation failures, fallback runtimes, and a daemon from the wrong build.
 */
export async function run(): Promise<void> {
  assert.equal(process.env.CI, "true");
  const extension = vscode.extensions.getExtension<PortManagerExtensionApi>("newdlops.portmanager");
  assert.ok(extension, "Installed extension is not discoverable.");
  assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.PM_TEST_EXTENSION_PATH!));
  assert.equal(extension.packageJSON.version, process.env.PM_TEST_EXTENSION_VERSION);
  const api = await extension.activate();
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
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method })}\n`));
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

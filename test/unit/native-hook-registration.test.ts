import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Regression coverage for bind-time process registration.
 *
 * A successful bind must only wait until its complete registration frame is in
 * the Unix socket. The agent owns applying that queued frame even when an
 * expensive listener scan delays its response.
 */

const projectRoot = path.resolve(__dirname, "../../..");
const hookLibraryPath = getNativeHookLibraryPath();

test("native registration is send-only while allocation and release remain roundtrips", () => {
  const hookSource = fs.readFileSync(path.join(projectRoot, "native", "hook", "portmanager_hook.c"), "utf8");
  const agentSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.c"), "utf8");
  const registerStart = hookSource.indexOf("static void pm_register_process");
  const registerEnd = hookSource.indexOf("static void pm_release_allocation", registerStart);
  const releaseStart = registerEnd;
  const releaseEnd = hookSource.indexOf("static int pm_release_process_route", releaseStart);
  const clientLoopStart = agentSource.indexOf("revents = poll_fds[index + 1].revents;");
  const clientLoopEnd = agentSource.indexOf("if (handled_io)", clientLoopStart);
  const clientLoop = agentSource.slice(clientLoopStart, clientLoopEnd);
  const eventLoopStart = agentSource.indexOf("static void pm_event_loop");
  const eventLoop = agentSource.slice(eventLoopStart);

  assert.notEqual(registerStart, -1);
  assert.equal(hookSource.slice(registerStart, registerEnd).includes("pm_send_simple_payload_only"), true);
  assert.equal(hookSource.slice(releaseStart, releaseEnd).includes("pm_send_simple_payload("), true);
  assert.equal(hookSource.includes("pm_agent_send_only(request)"), true);
  assert.equal(hookSource.includes("#define PM_AGENT_SEND_TIMEOUT_MS 250"), true);
  assert.equal(hookSource.includes('PORT_MANAGER_AGENT_SEND_TIMEOUT_MS'), true);
  assert.notEqual(clientLoopStart, -1);
  assert.equal(clientLoop.indexOf("if (revents & POLLIN)") < clientLoop.indexOf("POLLERR | POLLHUP | POLLNVAL"), true);
  assert.notEqual(eventLoopStart, -1);
  assert.equal(eventLoop.indexOf("pm_state_flush_route_tables(state)") < eventLoop.indexOf("pm_broadcast_snapshot("), true);
});

if (hookLibraryPath === undefined || !fs.existsSync(hookLibraryPath)) {
  test("native hook queues registration without waiting for a response", { skip: "native hook library is not built" }, () => undefined);
} else {
  test("native hook queues registration without waiting for a response", async (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-register-"));
    const socketPath = path.join(tempDirectory, "agent.sock");
    const openAgentSockets = new Set<net.Socket>();
    let resolveRegistration: ((request: AgentRequest) => void) | undefined;
    const registration = new Promise<AgentRequest>((resolve) => {
      resolveRegistration = resolve;
    });
    const fakeAgent = net.createServer((socket) => {
      openAgentSockets.add(socket);
      socket.on("close", () => openAgentSockets.delete(socket));
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) {
            return;
          }
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const request = JSON.parse(line) as AgentRequest;
          if (request.method === "registerExistingProcess") {
            resolveRegistration?.(request);
            resolveRegistration = undefined;
          }
          // Deliberately never reply. Before the fix, bind() stayed inside the
          // response read until the agent timeout elapsed.
        }
      });
    });
    await listenOnUnixSocket(fakeAgent, socketPath);
    const logicalPort = await reserveUnusedTcpPort();

    let child: ChildProcess | undefined;
    context.after(async () => {
      if (child !== undefined && child.exitCode === null) {
        child.kill("SIGKILL");
      }
      for (const socket of openAgentSockets) {
        socket.destroy();
      }
      await closeServer(fakeAgent);
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    });

    child = spawnHookedBinder({
      hookPath: hookLibraryPath,
      logicalPort,
      socketPath,
      routeTablePath: path.join(tempDirectory, "routes.json"),
    });

    const ready = await waitForReadyLine(child, 2_500);
    assert.ok(ready.elapsedMs < 1_000, `bind waited ${ready.elapsedMs}ms for a response that never arrived`);
    assert.equal(ready.address.address, "127.0.0.1");
    const request = await withTimeout(registration, 2_500, "Timed out waiting for the queued registration frame.");
    const payload = request.payload as RegistrationPayload;

    assert.equal(request.method, "registerExistingProcess");
    assert.equal(payload.requestedPort, logicalPort);
    assert.equal(payload.actualPort, logicalPort);
    assert.equal(payload.host, "127.0.0.1");
    assert.equal(payload.networkId, "network-send-only-regression");
  });

  test("native hook bounds send-only registration when the optional agent is absent", async (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-register-missing-"));
    const logicalPort = await reserveUnusedTcpPort();
    const child = spawnHookedBinder({
      hookPath: hookLibraryPath,
      logicalPort,
      socketPath: path.join(tempDirectory, "missing-agent.sock"),
      routeTablePath: path.join(tempDirectory, "routes.json"),
      sendTimeoutMs: 100,
    });

    context.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    });

    const ready = await waitForReadyLine(child, 2_500);
    assert.ok(ready.elapsedMs < 1_000, `missing optional agent blocked bind for ${ready.elapsedMs}ms`);
    assert.equal(ready.address.port, logicalPort);
  });
}

interface AgentRequest {
  readonly method: string;
  readonly payload?: unknown;
}

interface RegistrationPayload {
  readonly requestedPort: number;
  readonly actualPort: number;
  readonly host: string;
  readonly networkId: string;
}

interface ReadyMessage {
  readonly elapsedMs: number;
  readonly address: {
    readonly address: string;
    readonly port: number;
  };
}

interface HookedBinderOptions {
  readonly hookPath: string;
  readonly logicalPort: number;
  readonly socketPath: string;
  readonly routeTablePath: string;
  readonly sendTimeoutMs?: number;
}

function getNativeHookLibraryPath(): string | undefined {
  if (process.platform === "darwin") {
    return path.join(projectRoot, "media", "native", "libportmanager_hook.dylib");
  }
  if (process.platform === "linux") {
    return path.join(projectRoot, "media", "native", "libportmanager_hook.so");
  }
  return undefined;
}

function spawnHookedBinder(options: HookedBinderOptions): ChildProcess {
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
  const script = [
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    "const startedAt = Date.now();",
    "const server = net.createServer();",
    `server.listen({ host: "127.0.0.1", port: ${options.logicalPort} }, () => {`,
    "  const address = server.address();",
    '  fs.writeSync(1, `${JSON.stringify({ elapsedMs: Date.now() - startedAt, address })}\\n`);',
    "});",
    "setTimeout(() => process.exit(91), 10000);",
  ].join("\n");

  return spawn(process.execPath, ["-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      [preloadVariable]: options.hookPath,
      PORT_MANAGER_DYLD_INSERT_LIBRARIES: process.platform === "darwin" ? options.hookPath : "",
      PORT_MANAGER_LD_PRELOAD: process.platform === "linux" ? options.hookPath : "",
      PORT_MANAGER_HOOK: "1",
      PORT_MANAGER_HOOK_DISABLED: "",
      PORT_MANAGER_AGENT_SOCKET: options.socketPath,
      PORT_MANAGER_AGENT_TIMEOUT_MS: "5000",
      PORT_MANAGER_AGENT_ROUNDTRIP_TIMEOUT_MS: "5000",
      PORT_MANAGER_AGENT_SEND_TIMEOUT_MS: options.sendTimeoutMs === undefined ? "" : String(options.sendTimeoutMs),
      PORT_MANAGER_NETWORK_ID: "network-send-only-regression",
      PORT_MANAGER_NETWORK_NAME: "",
      PORT_MANAGER_NETWORK_IS_GLOBAL: "1",
      PORT_MANAGER_NETWORK_ENV_APPLIED: "network-send-only-regression",
      PORT_MANAGER_NETWORK_LOOPBACK_HOST: "127.77.88.99",
      PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "127.77.88.99",
      PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE: "loopback-address-only",
      PORT_MANAGER_PRESERVE_LISTEN_PORTS: String(options.logicalPort),
      PORT_MANAGER_FILE_SUBSTITUTION: "0",
      PORT_MANAGER_ESCAPED_SERVER_RESPAWN: "0",
      PORT_MANAGER_ROUTES_FILE: options.routeTablePath,
      PORT_MANAGER_GLOBAL_ROUTES_FILE: options.routeTablePath,
      BASH_ENV: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function listenOnUnixSocket(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function reserveUnusedTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to reserve a TCP port for the registration fixture.");
  }
  await closeServer(server);
  return address.port;
}

async function waitForReadyLine(child: ChildProcess, timeoutMs: number): Promise<ReadyMessage> {
  return await new Promise<ReadyMessage>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for bind callback; stderr=${stderr}`));
    }, timeoutMs);
    const settle = (callback: () => void): void => {
      clearTimeout(timer);
      callback();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        const line = stdout.slice(0, newline);
        settle(() => resolve(JSON.parse(line) as ReadyMessage));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code, signal) => {
      settle(() => reject(new Error(`Hooked bind process exited before readiness: code=${code} signal=${signal}; stderr=${stderr}`)));
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

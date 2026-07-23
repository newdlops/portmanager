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
  // UI fan-out is memory-authoritative and intentionally precedes deferred
  // route-file publication during hook I/O bursts.
  assert.equal(eventLoop.indexOf("pm_broadcast_snapshot(") < eventLoop.indexOf("pm_state_flush_route_tables(state)"), true);
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

  test("user-network ephemeral listeners remain reachable on raw localhost", async (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-ephemeral-"));
    const socketPath = path.join(tempDirectory, "agent.sock");
    const openAgentSockets = new Set<net.Socket>();
    const observedMethods: string[] = [];
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

          const request = JSON.parse(buffer.slice(0, newline)) as AgentRequest;
          buffer = buffer.slice(newline + 1);
          observedMethods.push(request.method);
          if (request.method === "registerExistingProcess") {
            resolveRegistration?.(request);
            resolveRegistration = undefined;
          }
        }
      });
    });
    await listenOnUnixSocket(fakeAgent, socketPath);

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
      logicalPort: 0,
      socketPath,
      routeTablePath: path.join(tempDirectory, "routes.json"),
      env: {
        PORT_MANAGER_NETWORK_ID: "network-ephemeral",
        PORT_MANAGER_NETWORK_NAME: "ephemeral",
        PORT_MANAGER_NETWORK_IS_GLOBAL: "",
        PORT_MANAGER_NETWORK_ENV_APPLIED: "network-ephemeral",
        PORT_MANAGER_NETWORK_LOOPBACK_HOST: "127.77.88.99",
        PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "127.77.88.99",
        PORT_MANAGER_PRESERVE_LISTEN_PORTS: "",
      },
    });

    const ready = await waitForReadyLine(child, 2_500);
    assert.equal(ready.address.address, "127.0.0.1");
    assert.ok(ready.address.port > 0);

    // Electron helpers and other hookless companions receive this endpoint over
    // IPC, so the raw host coordinate itself—not only a hooked route—must work.
    await connectToRawLocalhost(ready.address.port);

    const request = await withTimeout(registration, 2_500, "Timed out waiting for ephemeral bind registration.");
    const payload = request.payload as RegistrationPayload;
    assert.deepEqual(observedMethods, ["registerExistingProcess"]);
    assert.equal(payload.requestedPort, ready.address.port);
    assert.equal(payload.actualPort, ready.address.port);
    assert.equal(payload.host, "127.0.0.1");
    assert.equal(payload.networkId, "network-ephemeral");
  });

  test("fixed-port servers hand resolved loopback URLs to immediately spawned hookless children", async (context) => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-child-url-"));
    const socketPath = path.join(tempDirectory, "agent.sock");
    const routeTablePath = path.join(tempDirectory, "routes.json");
    const openAgentSockets = new Set<net.Socket>();
    const actualPort = await reserveUnusedTcpPort();
    let logicalPort = await reserveUnusedTcpPort();
    while (logicalPort === actualPort) {
      logicalPort = await reserveUnusedTcpPort();
    }
    let allocationRequest: AgentRequest | undefined;

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

          const request = JSON.parse(buffer.slice(0, newline)) as AgentRequest;
          buffer = buffer.slice(newline + 1);
          if (request.method === "allocateRoute") {
            allocationRequest = request;
            socket.end(
              `${JSON.stringify({
                type: "response",
                id: request.id,
                ok: true,
                payload: {
                  allocationId: "allocation-child-url",
                  requestedPort: logicalPort,
                  actualPort,
                  host: "127.0.0.1",
                  routed: true,
                  logicalRoutesFile: routeTablePath,
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              })}\n`,
            );
          }
        }
      });
    });
    await listenOnUnixSocket(fakeAgent, socketPath);

    const child = spawnHookedBinder({
      hookPath: hookLibraryPath,
      logicalPort,
      socketPath,
      routeTablePath,
      probeChildLoopbackUrl: true,
      env: {
        // Force the regular allocation path without relying on a machine-wide
        // lo0 alias. The parent still remembers the authoritative endpoint
        // synchronously before its listen callback launches the child.
        PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE: "",
        PORT_MANAGER_NETWORK_LOOPBACK_HOST: "",
        PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "",
        PORT_MANAGER_PRESERVE_LISTEN_PORTS: "",
      },
    });

    context.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      for (const socket of openAgentSockets) {
        socket.destroy();
      }
      await closeServer(fakeAgent);
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    });

    const ready = await waitForReadyLine(child, 2_500);
    const allocationPayload = allocationRequest?.payload as {
      readonly requestedPort: number;
      readonly routeDirection: string;
    };

    assert.equal(allocationPayload.requestedPort, logicalPort);
    assert.equal(allocationPayload.routeDirection, "listen");
    assert.equal(ready.address.port, logicalPort, "the hooked parent keeps seeing its logical port");
    assert.equal(ready.childExitCode, 0);
    assert.equal(ready.childStderr, "");
    assert.equal(ready.childUrl, `http://127.0.0.1:${actualPort}/renderer`);
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

  test(
    "global network relocates when its macOS loopback alias is unavailable",
    { skip: process.platform !== "darwin" ? "macOS lo0 aliases are explicit addresses" : false },
    async (context) => {
      const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-global-alias-"));
      const socketPath = path.join(tempDirectory, "agent.sock");
      const routeTablePath = path.join(tempDirectory, "routes.json");
      const openAgentSockets = new Set<net.Socket>();
      const actualPort = await reserveUnusedTcpPort();
      let logicalPort = await reserveUnusedTcpPort();
      while (logicalPort === actualPort) {
        logicalPort = await reserveUnusedTcpPort();
      }

      let resolveRegistration: ((request: AgentRequest) => void) | undefined;
      const registration = new Promise<AgentRequest>((resolve) => {
        resolveRegistration = resolve;
      });
      const allocationRequests: AgentRequest[] = [];
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

            const request = JSON.parse(buffer.slice(0, newline)) as AgentRequest;
            buffer = buffer.slice(newline + 1);
            if (request.method === "allocateRoute") {
              allocationRequests.push(request);
              socket.end(
                `${JSON.stringify({
                  type: "response",
                  id: request.id,
                  ok: true,
                  payload: {
                    allocationId: "allocation-global-alias-fallback",
                    requestedPort: logicalPort,
                    actualPort,
                    host: "127.0.0.1",
                    routed: true,
                    logicalRoutesFile: routeTablePath,
                    expiresAt: "2026-07-22T23:59:59Z",
                  },
                })}\n`,
              );
              continue;
            }

            if (request.method === "registerExistingProcess") {
              resolveRegistration?.(request);
              resolveRegistration = undefined;
              socket.end();
            }
          }
        });
      });
      await listenOnUnixSocket(fakeAgent, socketPath);

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
        host: "::1",
        logicalPort,
        socketPath,
        routeTablePath,
        env: {
          PORT_MANAGER_NETWORK_ID: "network-global",
          PORT_MANAGER_NETWORK_ENV_APPLIED: "network-global",
          PORT_MANAGER_NETWORK_LOOPBACK_HOST: "127.254.253.252",
          PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "127.254.253.252",
          PORT_MANAGER_PRESERVE_LISTEN_PORTS: "",
          PORT_MANAGER_ROUTING_MODE: "hashed",
        },
      });

      const ready = await waitForReadyLine(child, 2_500);
      const request = await withTimeout(registration, 2_500, "Timed out waiting for relocated bind registration.");
      const allocationPayload = allocationRequests[0]?.payload as {
        readonly host: string;
        readonly requestedPort: number;
        readonly routeDirection: string;
      };
      const registrationPayload = request.payload as RegistrationPayload;

      assert.equal(ready.address.address, "::ffff:127.0.0.1");
      assert.equal(ready.address.port, logicalPort, "getsockname must preserve the requested Vite port");
      assert.equal(allocationRequests.length, 1);
      assert.equal(allocationPayload.host, "127.0.0.1");
      assert.equal(allocationPayload.requestedPort, logicalPort);
      assert.equal(allocationPayload.routeDirection, "listen");
      assert.equal(registrationPayload.actualPort, actualPort);
      assert.equal(registrationPayload.host, "127.0.0.1");
      assert.equal(registrationPayload.networkId, "network-global");
    },
  );
}

interface AgentRequest {
  readonly id: string;
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
  readonly childUrl?: string;
  readonly childExitCode?: number | null;
  readonly childStderr?: string;
}

interface HookedBinderOptions {
  readonly hookPath: string;
  readonly host?: string;
  readonly logicalPort: number;
  readonly socketPath: string;
  readonly routeTablePath: string;
  readonly sendTimeoutMs?: number;
  readonly probeChildLoopbackUrl?: boolean;
  readonly env?: NodeJS.ProcessEnv;
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
  const childProbeLines = options.probeChildLoopbackUrl === true
    ? [
        "  const childEnvironment = { ...process.env };",
        '  delete childEnvironment.DYLD_INSERT_LIBRARIES;',
        '  delete childEnvironment.LD_PRELOAD;',
        '  childEnvironment.PORT_MANAGER_PRELOAD_REPAIR = "0";',
        `  childEnvironment.PORT_MANAGER_TEST_CHILD_URL = ${JSON.stringify(`http://localhost:${options.logicalPort}/renderer`)};`,
        `  const childProbe = require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(
          'process.stdout.write(process.env.PORT_MANAGER_TEST_CHILD_URL || "");',
        )}], { env: childEnvironment, encoding: "utf8" });`,
        "  const childUrl = childProbe.stdout;",
        "  const childExitCode = childProbe.status;",
        "  const childStderr = childProbe.stderr;",
      ]
    : [
        "  const childUrl = undefined;",
        "  const childExitCode = undefined;",
        "  const childStderr = undefined;",
      ];
  const script = [
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    "const startedAt = Date.now();",
    "const server = net.createServer();",
    `server.listen({ host: ${JSON.stringify(options.host ?? "127.0.0.1")}, port: ${options.logicalPort} }, () => {`,
    "  const address = server.address();",
    ...childProbeLines,
    '  fs.writeSync(1, `${JSON.stringify({ elapsedMs: Date.now() - startedAt, address, childUrl, childExitCode, childStderr })}\\n`);',
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
      ...options.env,
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

async function connectToRawLocalhost(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
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

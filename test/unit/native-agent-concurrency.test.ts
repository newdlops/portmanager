import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { getRouteTablePathForLogicalPort } from "../../src/agent/route-table";

/**
 * Black-box concurrency coverage for the native daemon.
 *
 * The hook opens short-lived sockets that expect a response frame as the first
 * useful message. A long-lived extension socket receives async snapshots at the
 * same time. This test keeps both patterns active while many route allocations
 * arrive together, which catches response/event interleaving and backlog issues.
 */

const projectRoot = path.resolve(__dirname, "../../..");
const nativeAgentPath = path.join(projectRoot, "media", "native", "portmanager_agent");

if (!fs.existsSync(nativeAgentPath)) {
  test("native agent serves concurrent hook-like clients while extension client receives events", { skip: "native agent binary is not built" }, () => undefined);
} else {
  test("native agent serves concurrent hook-like clients while extension client receives events", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }
    const { socketPath } = fixture;
    const extensionClient = await openExtensionClient(socketPath);
    context.after(() => extensionClient.destroy());

    const allocationCount = 64;
    const allocations = await Promise.all(
      Array.from({ length: allocationCount }, (_, index) =>
        requestOnce<{
          readonly allocationId: string;
          readonly requestedPort: number;
          readonly actualPort: number;
        }>(socketPath, {
          id: `hook-${process.pid}-${index}`,
          method: "allocateRoute",
          payload: {
            name: "stress-listener",
            command: "stress-listener",
            cwd: projectRoot,
            requestedPort: 8100 + index,
            host: "127.0.0.1",
            networkId: "network-native-stress",
            routeDirection: "listen",
            scanRange: 128,
            scanDirection: "up",
            routingMode: "hashed",
            virtualPortRangeStart: 58000,
            virtualPortRangeEnd: 59000,
          },
        }),
      ),
    );

    assert.equal(allocations.length, allocationCount);
    assert.equal(new Set(allocations.map((allocation) => allocation.actualPort)).size, allocationCount);
  });

  test("native agent removes endpoint route files after pending allocation release", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const logicalPort = 8204;
    const networkId = "network-native-release";
    const routeEntryPath = getRouteTablePathForLogicalPort(logicalPort, networkId, fixture.routeTablePath);
    const allocation = await requestOnce<{
      readonly allocationId: string;
      readonly requestedPort: number;
      readonly actualPort: number;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-release`,
      method: "allocateRoute",
      payload: {
        name: "release-listener",
        command: "release-listener",
        cwd: projectRoot,
        requestedPort: logicalPort,
        host: "127.0.0.1",
        networkId,
        routeDirection: "listen",
        scanRange: 16,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    await waitForFile(routeEntryPath);
    assert.equal(readRouteTable(routeEntryPath).routes.length, 1);

    const released = await requestOnce<boolean>(fixture.socketPath, {
      id: `hook-${process.pid}-release-done`,
      method: "releaseRouteAllocation",
      payload: { allocationId: allocation.allocationId },
    });

    assert.equal(released, true);
    await waitForFileMissing(routeEntryPath);
  });

  test("native agent reuses sender-first reservations for later listeners", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const logicalPort = 8404;
    const networkId = "network-native-send-first";
    const routeEntryPath = getRouteTablePathForLogicalPort(logicalPort, networkId, fixture.routeTablePath);
    const senderAllocation = await requestOnce<{
      readonly allocationId: string;
      readonly requestedPort: number;
      readonly actualPort: number;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-send-first-sender`,
      method: "allocateRoute",
      payload: {
        name: "wait-on",
        command: "wait-on http-get://localhost:8404/healthz",
        cwd: projectRoot,
        requestedPort: logicalPort,
        host: "::1",
        networkId,
        routeDirection: "send",
        scanRange: 20,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    await waitForFile(routeEntryPath);
    const pendingRoute = readRouteTable(routeEntryPath).routes[0] as {
      readonly actualPort?: number;
      readonly routeDirection?: string;
    };
    assert.equal(pendingRoute.actualPort, senderAllocation.actualPort);
    assert.equal(pendingRoute.routeDirection, "send");

    const receiverAllocation = await requestOnce<{
      readonly allocationId: string;
      readonly requestedPort: number;
      readonly actualPort: number;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-send-first-listener`,
      method: "allocateRoute",
      payload: {
        name: "python3",
        command: "python manage.py runserver 8404",
        cwd: projectRoot,
        requestedPort: logicalPort,
        host: "127.0.0.1",
        networkId,
        routeDirection: "listen",
        scanRange: 20,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    assert.equal(receiverAllocation.allocationId, senderAllocation.allocationId);
    assert.equal(receiverAllocation.actualPort, senderAllocation.actualPort);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-send-first-register`,
      method: "registerExistingProcess",
      payload: {
        pid: process.pid,
        name: "python3",
        command: "python manage.py runserver 8404",
        cwd: projectRoot,
        requestedPort: logicalPort,
        actualPort: senderAllocation.actualPort,
        host: "127.0.0.1",
        networkId,
        allocationId: "",
        source: "hooked",
      },
    });

    const promotedRoute = readRouteTable(routeEntryPath).routes[0] as {
      readonly actualPort?: number;
      readonly host?: string;
      readonly routeDirection?: string;
      readonly source?: string;
    };
    assert.equal(promotedRoute.actualPort, senderAllocation.actualPort);
    assert.equal(promotedRoute.host, "127.0.0.1");
    assert.equal(promotedRoute.routeDirection, "listen");
    assert.equal(promotedRoute.source, "hooked");

    const released = await requestOnce<boolean>(fixture.socketPath, {
      id: `hook-${process.pid}-send-first-release`,
      method: "releaseRouteAllocation",
      payload: { allocationId: senderAllocation.allocationId },
    });
    assert.equal(released, false);
  });

  test("native agent sends to an existing same-port listener instead of shadow routing", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const server = await openTcpServer();
    context.after(async () => {
      await closeTcpServer(server);
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to read test server address.");
    }

    const networkId = "network-native-same-port-listener";
    const routeEntryPath = getRouteTablePathForLogicalPort(address.port, networkId, fixture.routeTablePath);
    await delay(100);

    const allocation = await requestOnce<{
      readonly allocationId: string;
      readonly requestedPort: number;
      readonly actualPort: number;
      readonly routed: boolean;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-same-port-listener`,
      method: "allocateRoute",
      payload: {
        name: "wait-on",
        command: `wait-on http-get://localhost:${address.port}/healthz`,
        cwd: projectRoot,
        requestedPort: address.port,
        host: "127.0.0.1",
        networkId,
        routeDirection: "send",
        scanRange: 20,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    assert.equal(allocation.allocationId, "");
    assert.equal(allocation.actualPort, address.port);
    assert.equal(allocation.routed, false);
    assert.equal(fs.existsSync(routeEntryPath), false);
  });

  test("native agent removes hooked route files after the listener disappears", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const logicalPort = 8304;
    const actualPort = await reserveUnusedTcpPort();
    const networkId = "network-native-stale-listener";
    const routeEntryPath = getRouteTablePathForLogicalPort(logicalPort, networkId, fixture.routeTablePath);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-stale-register`,
      method: "registerExistingProcess",
      payload: {
        pid: 987654,
        name: "python3",
        command: "python manage.py runserver 8304",
        cwd: projectRoot,
        requestedPort: logicalPort,
        actualPort,
        host: "127.0.0.1",
        networkId,
        source: "hooked",
      },
    });

    await waitForFile(routeEntryPath);
    assert.equal(readRouteTable(routeEntryPath).routes.length, 1);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-stale-first-refresh`,
      method: "refreshSnapshot",
    });
    assert.equal(readRouteTable(routeEntryPath).routes.length, 1);

    await delay(2_200);
    const snapshot = await requestOnce<{ readonly routes: readonly unknown[] }>(fixture.socketPath, {
      id: `hook-${process.pid}-stale-second-refresh`,
      method: "refreshSnapshot",
    });

    assert.deepEqual(snapshot.routes, []);
    await waitForFileMissing(routeEntryPath);
  });
}

interface NativeAgentFixture {
  readonly socketPath: string;
  readonly routeTablePath: string;
}

interface RouteTable {
  readonly routes: readonly unknown[];
}

interface AgentRequest {
  readonly id: string;
  readonly method: string;
  readonly payload?: unknown;
}

interface AgentResponse<T> {
  readonly type: "response";
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: T;
  readonly error?: string;
}

async function startNativeAgent(context: TestContext): Promise<NativeAgentFixture | undefined> {
  const testDirectory = path.join(projectRoot, ".tmp", "native-agent-tests");
  fs.mkdirSync(testDirectory, { recursive: true });
  const socketPath = path.join(testDirectory, `agent-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
  const routeTablePath = path.join(testDirectory, `routes-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const stderrChunks: Buffer[] = [];
  const agent = spawn(nativeAgentPath, [
    "--socket",
    socketPath,
    "--route-table",
    routeTablePath,
    "--agent-main",
    path.join(projectRoot, "out", "src", "agent", "agent-main.js"),
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  agent.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  context.after(async () => {
    await stopAgent(agent);
    await fs.promises.rm(socketPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(routeTablePath, { force: true }).catch(() => undefined);
    await removeRouteTableSiblings(routeTablePath);
  });

  try {
    await waitForAgent(socketPath);
  } catch (error) {
    if (stderrChunks.some((chunk) => chunk.toString("utf8").includes("Operation not permitted"))) {
      context.skip("native agent cannot bind Unix sockets in this sandbox");
      return undefined;
    }

    throw error;
  }

  return { socketPath, routeTablePath };
}

async function waitForAgent(socketPath: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const socket = await connectSocket(socketPath);
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for native agent.");
}

async function openExtensionClient(socketPath: string): Promise<net.Socket> {
  const socket = await connectSocket(socketPath);
  const requestId = `extension-${process.pid}-events`;
  let buffer = "";

  socket.setEncoding("utf8");
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for extension snapshot response."));
    }, 10_000);

    socket.on("data", (chunk) => {
      buffer += chunk;

      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as Partial<AgentResponse<unknown>>;

        if (message.type !== "response" || message.id !== requestId) {
          continue;
        }

        clearTimeout(timer);
        if (!message.ok) {
          reject(new Error(message.error ?? "Native agent snapshot request failed."));
          return;
        }

        resolve();
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  socket.write(`${JSON.stringify({ id: requestId, method: "refreshSnapshot" })}\n`);
  await ready;
  return socket;
}

async function requestOnce<T = unknown>(
  socketPath: string,
  request: AgentRequest,
  timeoutMs = 10_000,
): Promise<T> {
  const socket = await connectSocket(socketPath);

  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for native agent response: ${request.method}`));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;

      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as Partial<AgentResponse<T>>;

        if (message.type !== "response" || message.id !== request.id) {
          continue;
        }

        clearTimeout(timer);
        settled = true;
        socket.destroy();
        if (!message.ok) {
          reject(new Error(message.error ?? "Native agent request failed."));
          return;
        }

        resolve(message.payload as T);
      }
    });
    socket.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Native agent connection closed before response: ${request.method}`));
    });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function connectSocket(socketPath: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to native agent: ${socketPath}`));
    }, 1000);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForFile(filePath: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.promises.access(filePath);
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for file: ${filePath}`);
}

async function waitForFileMissing(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!fs.existsSync(filePath)) {
      return;
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for file removal: ${filePath}`);
}

function readRouteTable(filePath: string): RouteTable {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RouteTable;
}

async function reserveUnusedTcpPort(): Promise<number> {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to reserve an unused TCP port.");
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });

  return address.port;
}

async function openTcpServer(): Promise<net.Server> {
  const server = net.createServer((socket) => socket.end("ok"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return server;
}

async function closeTcpServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function stopAgent(agent: ChildProcess): Promise<void> {
  if (agent.exitCode !== null || agent.killed) {
    return;
  }

  agent.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1000);
    agent.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (agent.exitCode === null && !agent.killed) {
    agent.kill("SIGKILL");
  }
}

async function removeRouteTableSiblings(routeTablePath: string): Promise<void> {
  const directory = path.dirname(routeTablePath);
  const stem = path.basename(routeTablePath, path.extname(routeTablePath));
  const entries = await fs.promises.readdir(directory).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${stem}-`))
      .map((entry) => fs.promises.rm(path.join(directory, entry), { force: true }).catch(() => undefined)),
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

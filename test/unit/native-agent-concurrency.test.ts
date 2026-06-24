import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

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
    const testDirectory = path.join(projectRoot, ".tmp", "native-agent-tests");
    fs.mkdirSync(testDirectory, { recursive: true });
    const socketPath = path.join(testDirectory, `agent-${process.pid}-${Date.now()}.sock`);
    const routeTablePath = path.join(testDirectory, `routes-${process.pid}-${Date.now()}.json`);
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
        return;
      }

      throw error;
    }
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

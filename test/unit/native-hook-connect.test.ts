import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Native hook connect() regression tests.
 *
 * These tests use the built hook library instead of daemon fakes because the
 * route-table policy that matters here lives in native C. They are skipped when
 * the platform build output is unavailable.
 */

const projectRoot = path.resolve(__dirname, "../../..");
const hookLibraryPath = getNativeHookLibraryPath();

if (hookLibraryPath === undefined || !fs.existsSync(hookLibraryPath)) {
  test("native hook allows current-network same-port compose routes", { skip: "native hook library is not built for this platform" }, () => undefined);
} else {
  test("native hook allows current-network same-port compose routes", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-connect-"));
    const server = net.createServer((socket) => {
      socket.end("ok\n");
    });

    context.after(async () => {
      await closeServer(server);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    await listen(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to inspect test TCP server address.");
    }

    const networkId = "network-a";
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
    fs.writeFileSync(
      routeTablePath,
      JSON.stringify({
        updatedAt: "2026-06-25T00:00:00.000Z",
        routes: [
          {
            logicalPort: address.port,
            actualPort: address.port,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: projectRoot,
            networkId,
            processId: "managed-process-compose",
            processName: "docker:db/postgresql",
            status: "running",
            source: "compose",
          },
        ],
      }),
      "utf8",
    );

    const result = await runHookedNodeClient(address.port, routeTablePath, networkId);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
  });

  test("native hook allows detached cwd-matched compose routes", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-connect-"));
    const server = net.createServer((socket) => {
      socket.end("ok\n");
    });

    context.after(async () => {
      await closeServer(server);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    await listen(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to inspect test TCP server address.");
    }

    const networkId = "network-detached";
    const logicalPort = chooseDifferentTcpPort(address.port);
    const routeTablePath = path.join(tempDir, "newdlops-portmanager-routes-detached.json");
    fs.writeFileSync(
      routeTablePath,
      JSON.stringify({
        updatedAt: "2026-06-27T00:00:00.000Z",
        routes: [
          {
            logicalPort,
            actualPort: address.port,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: path.join(projectRoot, "docker"),
            networkId,
            processId: "managed-process-compose",
            processName: "docker:db/postgresql",
            status: "running",
            source: "compose",
          },
        ],
      }),
      "utf8",
    );

    const result = await runHookedNodeClient(logicalPort, routeTablePath, undefined);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
  });
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

async function listen(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function chooseDifferentTcpPort(actualPort: number): number {
  return actualPort < 64000 ? actualPort + 1000 : actualPort - 1000;
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function runHookedNodeClient(
  port: number,
  routeTablePath: string,
  networkId: string | undefined,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
  const script = [
    "const net = require('node:net');",
    `const socket = net.createConnection({ host: '127.0.0.1', port: ${port} });`,
    "let data = '';",
    "socket.setEncoding('utf8');",
    "socket.on('data', (chunk) => { data += chunk; });",
    "socket.on('end', () => { process.stdout.write(data); });",
    "socket.on('error', (error) => { process.stderr.write(`${error.code || error.message}\\n`); process.exit(23); });",
  ].join("\n");

  const child = spawn(process.execPath, ["-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      [preloadVariable]: hookLibraryPath,
      PORT_MANAGER_HOOK: "1",
      PORT_MANAGER_HOOK_DISABLED: "",
      PORT_MANAGER_ROUTES_FILE: routeTablePath,
      PORT_MANAGER_GLOBAL_ROUTES_FILE: routeTablePath,
      BASH_ENV: "",
      PORT_MANAGER_NETWORK_ID: networkId ?? "",
      PORT_MANAGER_ROUTE_TABLE_NETWORK_ID: "",
      PORT_MANAGER_BORROWED_NETWORK_ID: "",
      NEWDLOPS_PM_NETWORK_ID: "",
      NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

  return { exitCode, stdout, stderr };
}

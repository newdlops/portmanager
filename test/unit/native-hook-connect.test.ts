import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getRouteTablePathForComposeClaimPort } from "../../src/agent/route-table";

/**
 * Native hook connect() regression tests.
 *
 * These tests use the built hook library instead of daemon fakes because the
 * route-table policy that matters here lives in native C. They are skipped when
 * the platform build output is unavailable.
 */

const projectRoot = path.resolve(__dirname, "../../..");
const hookLibraryPath = getNativeHookLibraryPath();

test("native hook memory route cache is scoped by logical network", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("char network_id[PM_MAX_TEXT];"), true);
  assert.equal(source.includes("pthread_mutex_t pm_route_mutex"), true);
  assert.equal(source.includes("pthread_mutex_lock(&pm_route_mutex);"), true);
  assert.equal(source.includes("__sync_fetch_and_add(&pm_request_sequence, 1)"), true);
  assert.equal(source.includes("pm_network_scope_payload_for_id(route->network_id"), true);
  assert.equal(
    source.includes("pm_routes[index].logical_port == logical_port && strcmp(pm_routes[index].network_id, route_network_id) == 0"),
    true,
  );
  assert.equal(
    source.includes("pm_routes[index].actual_port == actual_port && strcmp(pm_routes[index].network_id, route_network_id) == 0"),
    true,
  );
});

test("native hook route file cache is invalidated by path size and high-resolution mtime", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const loaderStart = source.indexOf("static int pm_load_route_file_routes");
  const loaderEnd = source.indexOf("static int pm_cached_route_network_match_level", loaderStart);
  const loaderBody = source.slice(loaderStart, loaderEnd);

  assert.equal(source.includes("pm_route_file_cache_entry"), true);
  assert.equal(source.includes("PM_ROUTE_FILE_CACHE_CAPACITY"), true);
  assert.equal(source.includes('PM_ROUTE_TABLE_TTL_SECONDS_ENV "PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS"'), true);
  assert.equal(source.includes("PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS 15"), true);
  assert.equal(source.includes("pm_route_table_ttl_seconds() * 1000L"), true);
  assert.equal(source.includes("pm_route_file_stat_expired"), true);
  assert.equal(source.includes("pm_route_file_buffer_expired"), true);
  assert.equal(source.includes("pm_route_file_writer_alive"), true);
  assert.equal(source.includes("return !pm_route_file_writer_alive(buffer);"), true);
  assert.equal(source.includes("entry->size == stat_buffer->st_size"), true);
  assert.equal(source.includes("entry->mtime_sec == pm_stat_mtime_sec(stat_buffer)"), true);
  assert.equal(source.includes("entry->mtime_nsec == pm_stat_mtime_nsec(stat_buffer)"), true);
  assert.notEqual(loaderStart, -1);
  assert.equal(
    loaderBody.indexOf("pm_get_cached_route_file(path, &stat_buffer") <
      loaderBody.indexOf("pm_route_file_buffer_expired(buffer)"),
    true,
  );
  assert.equal(source.includes("pm_cached_route_matches_cwd(route, current_cwd)"), true);
  assert.equal(source.includes("pm_cached_route_network_match_level(route)"), true);
  assert.equal(source.includes("pm_remember_route(logical_port, actual_port, target_host"), false);
});

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

  test("native hook shares current-network routes across terminal working directories", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-network-share-"));
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

    const networkId = "network-shared";
    const logicalPort = chooseDifferentTcpPort(address.port);
    const ownerCwd = path.join(tempDir, "owner");
    const clientCwd = path.join(tempDir, "client");
    fs.mkdirSync(ownerCwd);
    fs.mkdirSync(clientCwd);

    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
    fs.writeFileSync(
      routeTablePath,
      JSON.stringify({
        updatedAt: "2026-06-30T00:00:00.000Z",
        routes: [
          {
            logicalPort,
            actualPort: address.port,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: ownerCwd,
            networkId,
            processId: "managed-process-hooked",
            processName: "node",
            status: "running",
            source: "hooked",
          },
        ],
      }),
      "utf8",
    );

    const result = await runHookedNodeClient(logicalPort, routeTablePath, networkId, { cwd: clientCwd });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
  });

  test("native hook rewrites IPv6 localhost clients to current-network compose routes", async (context) => {
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

    const networkId = "network-ipv6-localhost";
    const logicalPort = chooseDifferentTcpPort(address.port);
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
    fs.writeFileSync(
      routeTablePath,
      JSON.stringify({
        updatedAt: "2026-06-29T00:00:00.000Z",
        routes: [
          {
            logicalPort,
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

    const result = await runHookedNodeClient(logicalPort, routeTablePath, networkId, { host: "::1" });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
  });

  test("native hook blocks scoped compose routes when network identity is missing", async (context) => {
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

    const result = await runHookedNodeClient(logicalPort, routeTablePath, undefined, {
      env: {
        PORT_MANAGER_COMPOSE_LOGICAL_PORTS: String(logicalPort),
        PORT_MANAGER_COMPOSE_ROUTE_WAIT_MS: "50",
        PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
      },
    });

    assert.equal(result.exitCode, 23);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ECONNREFUSED\n");
  });

  test("native hook blocks foreign compose claim ports without reading the aggregate route table", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-connect-"));
    const server = net.createServer((socket) => {
      socket.end("wrong-network\n");
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

    const routeTablePath = path.join(tempDir, "newdlops-portmanager-routes-test.json");
    const claimPath = getRouteTablePathForComposeClaimPort(address.port, routeTablePath);
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-06-27T00:00:00.000Z", routes: [] }), "utf8");
    fs.writeFileSync(
      claimPath,
      JSON.stringify({
        updatedAt: "2026-06-27T00:00:00.000Z",
        routes: [
          {
            logicalPort: address.port,
            actualPort: address.port,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: projectRoot,
            networkId: "network-a",
            processId: "managed-process-compose",
            processName: "docker:db/postgresql",
            status: "running",
            source: "compose",
          },
        ],
      }),
      "utf8",
    );

    const result = await runHookedNodeClient(address.port, routeTablePath, "network-b", {
      env: {
        PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
        PORT_MANAGER_AGENT_TIMEOUT_MS: "50",
      },
    });

    assert.equal(result.exitCode, 23);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ECONNREFUSED\n");
  });

  test("native hook waits for compose-owned logical route publication", async (context) => {
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

    const networkId = "network-compose-race";
    const logicalPort = chooseDifferentTcpPort(address.port);
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-06-27T00:00:00.000Z", routes: [] }), "utf8");

    const resultPromise = runHookedNodeClient(logicalPort, routeTablePath, networkId, {
      env: {
        PORT_MANAGER_COMPOSE_LOGICAL_PORTS: String(logicalPort),
        PORT_MANAGER_COMPOSE_ROUTE_WAIT_MS: "2000",
      },
    });

    setTimeout(() => {
      fs.writeFileSync(
        routeTablePath,
        JSON.stringify({
          updatedAt: "2026-06-27T00:00:01.000Z",
          routes: [
            {
              logicalPort,
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
    }, 100);

    const result = await resultPromise;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
  });

  test("native hook waits for current-network route publication without compose port env", async (context) => {
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

    const networkId = "network-connect-race";
    const logicalPort = chooseDifferentTcpPort(address.port);
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-06-29T00:00:00.000Z", routes: [] }), "utf8");

    const resultPromise = runHookedNodeClient(logicalPort, routeTablePath, networkId, {
      env: {
        PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "2000",
        PORT_MANAGER_AGENT_ROUNDTRIP_TIMEOUT_MS: "50",
      },
    });

    setTimeout(() => {
      fs.writeFileSync(
        routeTablePath,
        JSON.stringify({
          updatedAt: "2026-06-29T00:00:01.000Z",
          routes: [
            {
              logicalPort,
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
    }, 100);

    const result = await resultPromise;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
  });

  test("native hook reuses sender-first route reservations without daemon roundtrip", async (context) => {
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

    const networkId = "network-send-first-route";
    const logicalPort = await chooseUnusedTcpPort(address.port);
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
    fs.writeFileSync(
      routeTablePath,
      JSON.stringify({
        updatedAt: "2026-06-29T00:00:00.000Z",
        routes: [
          {
            logicalPort,
            actualPort: address.port,
            routeDirection: "send",
            host: "127.0.0.1",
            cwd: projectRoot,
            networkId,
            processName: "wait-on",
            status: "starting",
            source: "allocated",
          },
        ],
      }),
      "utf8",
    );

    const result = await runHookedNodeClient(logicalPort, routeTablePath, networkId, {
      env: {
        PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
        PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
        PORT_MANAGER_AGENT_ROUNDTRIP_TIMEOUT_MS: "50",
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
  });

  test("native hook waits for sender-first route publication", async (context) => {
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

    const networkId = "network-send-first-race";
    const logicalPort = await chooseUnusedTcpPort(address.port);
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-06-29T00:00:00.000Z", routes: [] }), "utf8");

    const resultPromise = runHookedNodeClient(logicalPort, routeTablePath, networkId, {
      env: {
        PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
        PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "2000",
        PORT_MANAGER_AGENT_ROUNDTRIP_TIMEOUT_MS: "50",
      },
    });

    setTimeout(() => {
      fs.writeFileSync(
        routeTablePath,
        JSON.stringify({
          updatedAt: "2026-06-29T00:00:01.000Z",
          routes: [
            {
              logicalPort,
              actualPort: address.port,
              routeDirection: "send",
              host: "127.0.0.1",
              cwd: projectRoot,
              networkId,
              processName: "wait-on",
              status: "starting",
              source: "allocated",
            },
          ],
        }),
        "utf8",
      );
    }, 100);

    const result = await resultPromise;

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
  });

  test("native hook honors allocated route host over the environment actual host", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-connect-"));
    const routeTablePath = path.join(tempDir, "routes.json");
    const agentSocketPath = path.join("/tmp", `portmanager-hook-agent-${process.pid}-${Date.now()}.sock`);
    const agentRequests: AgentRequest[] = [];
    let actualPort = 0;
    let logicalPort = 0;
    const server = net.createServer((socket) => {
      socket.end("ok\n");
    });
    const agentServer = net.createServer((socket) => {
      let requestText = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        requestText += chunk;
        const newline = requestText.indexOf("\n");
        if (newline < 0) {
          return;
        }

        const request = JSON.parse(requestText.slice(0, newline)) as AgentRequest;
        agentRequests.push(request);
        socket.end(
          `${JSON.stringify({
            type: "response",
            id: request.id,
            ok: true,
            payload: {
              allocationId: "allocation-1",
              requestedPort: logicalPort,
              actualPort,
              host: "127.0.0.1",
              routed: true,
              logicalRoutes: [],
              logicalRoutesFile: routeTablePath,
              expiresAt: "2026-06-25T00:00:00Z",
            },
          })}\n`,
        );
      });
    });

    context.after(async () => {
      await closeServer(server);
      await closeServer(agentServer);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      await fs.promises.rm(agentSocketPath, { force: true });
    });

    await listen(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to inspect test TCP server address.");
    }

    actualPort = address.port;
    logicalPort = await chooseUnusedTcpPort(actualPort);
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-06-25T00:00:00.000Z", routes: [] }), "utf8");
    await listenOnUnixSocket(agentServer, agentSocketPath);

    const result = await runHookedNodeClient(logicalPort, routeTablePath, "network-a", {
      env: {
        PORT_MANAGER_AGENT_SOCKET: agentSocketPath,
        PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "127.81.154.127",
        PORT_MANAGER_AGENT_TIMEOUT_MS: "1000",
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok\n");
    assert.equal(result.stderr, "");
    assert.equal(agentRequests.length, 1);
    assert.equal(agentRequests[0]?.method, "allocateRoute");
    assert.equal(agentRequests[0]?.payload.host, "127.0.0.1");
    assert.equal(agentRequests[0]?.payload.actualHost, "127.81.154.127");
  });
}

interface AgentRequest {
  readonly id: string;
  readonly method: string;
  readonly payload: {
    readonly host?: string;
    readonly actualHost?: string;
  };
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

async function listenOnUnixSocket(server: net.Server, socketPath: string): Promise<void> {
  await fs.promises.rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

function chooseDifferentTcpPort(actualPort: number): number {
  return actualPort < 64000 ? actualPort + 1000 : actualPort - 1000;
}

async function chooseUnusedTcpPort(excludedPort: number): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const server = net.createServer();
    await listen(server);
    const address = server.address();
    await closeServer(server);
    if (address !== null && typeof address !== "string" && address.port !== excludedPort) {
      return address.port;
    }
  }

  return chooseDifferentTcpPort(excludedPort);
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
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly cwd?: string;
  } = {},
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
  const host = options.host ?? "127.0.0.1";
  const script = [
    "const net = require('node:net');",
    `const socket = net.createConnection({ host: ${JSON.stringify(host)}, port: ${port} });`,
    "let data = '';",
    "socket.setEncoding('utf8');",
    "socket.on('data', (chunk) => { data += chunk; });",
    "socket.on('end', () => { process.stdout.write(data); });",
    "socket.on('error', (error) => { process.stderr.write(`${error.code || error.message}\\n`); process.exit(23); });",
  ].join("\n");

  const child = spawn(process.execPath, ["-e", script], {
    cwd: options.cwd ?? projectRoot,
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
      ...options.env,
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

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  getNetworkRouteTablePath,
  getRouteTablePathForComposeClaimPort,
  getRouteTablePathForLogicalPort,
} from "../../src/agent/route-table";

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

test("native agent caches listener scans for concurrent snapshot readers", () => {
  const header = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.h"), "utf8");
  const agentSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.c"), "utf8");
  const hookSource = fs.readFileSync(path.join(projectRoot, "native", "hook", "portmanager_hook.c"), "utf8");
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");
  const snapshotStart = source.indexOf("int pm_state_snapshot");
  const snapshotEnd = source.indexOf("int pm_state_refresh_snapshot", snapshotStart);
  const snapshotBody = source.slice(snapshotStart, snapshotEnd);
  const allocationStart = source.indexOf("int pm_state_allocate_route");
  const allocationEnd = source.indexOf("static void pm_remove_pending_allocation", allocationStart);
  const allocationBody = source.slice(allocationStart, allocationEnd);

  assert.equal(header.includes("PM_LISTENER_SCAN_CACHE_SECONDS 300"), true);
  assert.equal(header.includes("endpoint security agents"), true);
  assert.equal(header.includes("pm_listener *listener_cache_items;"), true);
  assert.equal(agentSource.includes("PM_LISTENER_POLL_INTERVAL_SECONDS 300"), true);
  assert.equal(agentSource.includes("PM_LISTEN_BACKLOG 16384"), true);
  assert.equal(agentSource.includes("PM_CLIENT_BUFFER_INITIAL 2048"), true);
  assert.equal(agentSource.includes("PM_CLIENT_BUFFER_MAX 32768"), true);
  assert.equal(agentSource.includes("#include <poll.h>"), true);
  assert.equal(agentSource.includes("ready = poll("), true);
  assert.equal(hookSource.includes("PM_MAX_ROUTES 32768"), true);
  assert.equal(hookSource.includes("\\\"compactResponse\\\":1"), true);
  assert.equal(source.includes("static int pm_scan_lsof_cached"), true);
  assert.equal(source.includes("static int pm_write_route_table_file_if_changed"), true);
  assert.equal(source.includes("pm_route_table_signature_for_path"), true);
  assert.equal(source.includes("pm_state_needs_external_listener_fresh_scan(state)"), true);
  assert.equal(source.includes("pm_listener_cache_invalidate(state);"), true);
  assert.equal(snapshotBody.includes("listener_scan_fresh &&"), true);
  assert.equal(snapshotBody.includes("pm_scan_lsof_cached(state, &listeners"), true);
  assert.equal(allocationBody.includes("pm_scan_lsof_cached(state, &listeners"), true);
  assert.equal(allocationBody.includes("listener_scan_fresh &&"), true);
  assert.equal(allocationBody.includes("pm_scan_lsof(&listeners"), false);
});

test("native agent matches loopback listeners by host as well as port", () => {
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");

  assert.equal(source.includes("static int pm_endpoint_hosts_match"), true);
  assert.equal(source.includes("pm_is_non_default_loopback_host(normalized_route)"), true);
  assert.equal(source.includes("pm_find_listener_by_process_endpoint(&listeners, process)"), true);
  assert.equal(source.includes("pm_find_listener_by_process_pid_endpoint(listeners, process)"), true);
  assert.equal(source.includes("pm_find_listener_for_port_host(input->requested_port, input->host"), true);
  assert.equal(source.includes("pm_endpoint_hosts_match(listener->local_address, process->host)"), true);
  assert.equal(source.includes("pm_find_listener_by_port("), false);
});

test("native agent route tables carry TTL and refresh unchanged files", () => {
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");
  const writeStart = source.indexOf("static int pm_write_route_table_file(");
  const writeEnd = source.indexOf("static int pm_build_route_table_signature", writeStart);
  const writeBody = source.slice(writeStart, writeEnd);
  const unchangedStart = source.indexOf("static int pm_write_route_table_file_if_changed");
  const unchangedEnd = source.indexOf("static void pm_route_table_write_lock_path", unchangedStart);
  const unchangedBody = source.slice(unchangedStart, unchangedEnd);

  assert.equal(source.includes('PM_ROUTE_TABLE_TTL_SECONDS_ENV "PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS"'), true);
  assert.equal(source.includes("PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS 15"), true);
  assert.equal(source.includes("static void pm_refresh_established_route_observations"), true);
  assert.equal(source.includes('popen("lsof -nP -iTCP -sTCP:ESTABLISHED -Fn 2>/dev/null"'), true);
  assert.equal(source.includes("static int pm_route_table_file_fresh_for_reuse"), true);
  assert.notEqual(writeStart, -1);
  assert.equal(writeBody.includes('\\"expiresAtMs\\":%ld,\\"ttlMs\\":%ld'), true);
  assert.notEqual(unchangedStart, -1);
  assert.equal(unchangedBody.includes("pm_route_table_file_fresh_for_reuse(file_path)"), true);
  assert.equal(unchangedBody.includes("pm_routes_can_refresh_unchanged_table(state, routes, count)"), true);
  assert.equal(source.includes('strcmp(routes[index].status, "running") == 0'), true);
  assert.equal(unchangedBody.includes("pm_write_route_table_file(state, file_path, routes, count, sequence)"), true);
});

test("native agent recovers restarted hook routes from process environment", () => {
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");
  const header = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.h"), "utf8");
  const tsAgent = fs.readFileSync(path.join(projectRoot, "src", "agent", "port-manager-agent.ts"), "utf8");

  assert.equal(source.includes("pm_recover_untracked_hooked_listeners"), true);
  assert.equal(source.includes("pm_read_process_environment_text"), true);
  assert.equal(source.includes("pm_read_process_command_text"), true);
  assert.equal(source.includes("VITE_CLIENT_PORT"), true);
  assert.equal(source.includes("PORT_MANAGER_NETWORK_ID"), true);
  assert.equal(source.includes("NEWDLOPS_PM_NETWORK_ID"), true);
  assert.equal(source.includes("requested_port == listener->port"), true);
  assert.equal(source.includes("pm_remove_pending_endpoint(state, process->requested_port, network_id)"), true);
  assert.equal(header.includes("#define PM_ROUTE_TTL_SECONDS 300"), true);
  assert.equal(tsAgent.includes("const ROUTE_ALLOCATION_TTL_MS = 300_000;"), true);
});

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

    const allocationCount = 10_000;
    const networkId = "network-native-stress";
    const allocationResults = await Promise.allSettled(
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
            networkId,
            routeDirection: "listen",
            compactResponse: 1,
            scanRange: 20_000,
            scanDirection: "up",
            routingMode: "hashed",
            virtualPortRangeStart: 45000,
            virtualPortRangeEnd: 65000,
          },
        }, 240_000, 30_000),
      ),
    );
    const rejectedAllocations = allocationResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const allocations = allocationResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);

    assert.equal(rejectedAllocations.length, 0, rejectedAllocations.slice(0, 20).map((result) => String(result.reason)).join("\n"));
    assert.equal(allocations.length, allocationCount);
    assert.equal(new Set(allocations.map((allocation) => allocation.allocationId)).size, allocationCount);
    assert.equal(new Set(allocations.map((allocation) => allocation.actualPort)).size, allocationCount);
    assert.equal(allocations.every((allocation) => allocation.actualPort >= 45000 && allocation.actualPort <= 65000), true);
    await waitForRouteTableCount(fixture.routeTablePath, allocationCount, 120_000);
    await waitForRouteTableCount(getNetworkRouteTablePath(networkId, fixture.routeTablePath), allocationCount, 120_000);
  });

  test("native agent removes endpoint route files after pending allocation release", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const logicalPort = 8204;
    const networkId = "network-native-release";
    const networkRouteTablePath = getNetworkRouteTablePath(networkId, fixture.routeTablePath);
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
    await waitForFile(networkRouteTablePath);
    assert.equal(readRouteTable(fixture.routeTablePath).routes.length, 1);
    assert.deepEqual(readRouteTable(routeEntryPath).routes, readRouteTable(networkRouteTablePath).routes);

    const released = await requestOnce<boolean>(fixture.socketPath, {
      id: `hook-${process.pid}-release-done`,
      method: "releaseRouteAllocation",
      payload: { allocationId: allocation.allocationId },
    });

    assert.equal(released, true);
    await waitForFileMissing(routeEntryPath);
  });

  test("native agent publishes compose claim files for logical and actual ports", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const networkId = "network-native-compose-claim";
    const logicalPort = 15432;
    const actualPort = 55432;
    const logicalClaimPath = getRouteTablePathForComposeClaimPort(logicalPort, fixture.routeTablePath);
    const actualClaimPath = getRouteTablePathForComposeClaimPort(actualPort, fixture.routeTablePath);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-compose-claim`,
      method: "registerExistingProcess",
      payload: {
        pid: 0,
        name: "postgres",
        command: "docker compose up postgres",
        cwd: projectRoot,
        requestedPort: logicalPort,
        actualPort,
        host: "127.0.0.1",
        networkId,
        source: "compose",
      },
    });

    await waitForFile(logicalClaimPath);
    await waitForFile(actualClaimPath);
    assert.equal(readRouteTable(logicalClaimPath).routes.length, 1);
    assert.deepEqual(readRouteTable(actualClaimPath).routes, readRouteTable(logicalClaimPath).routes);
  });

  test("native agent keeps unscoped host listeners out of cwd-matched networks", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const networkId = "network-native-cwd-infer";
    const projectCwd = path.join(projectRoot, ".tmp", "native-agent-tests", "cwd-infer-project");
    const composeCwd = path.join(projectCwd, "docker");
    const clientCwd = path.join(projectCwd, "zuzu", "client");
    const scopedRouteEntryPath = getRouteTablePathForLogicalPort(3004, networkId, fixture.routeTablePath);
    const unscopedRouteEntryPath = getRouteTablePathForLogicalPort(3004, undefined, fixture.routeTablePath);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-cwd-infer-compose`,
      method: "registerExistingProcess",
      payload: {
        pid: 0,
        name: "postgres",
        command: "docker compose up postgres",
        cwd: composeCwd,
        requestedPort: 15432,
        actualPort: 55432,
        host: "127.0.0.1",
        networkId,
        source: "compose",
      },
    });

    /*
     * This cwd deliberately matches the scoped compose project's root. Native
     * hook requests without an explicit network id are host listeners and must
     * not be adopted by a network only because the paths overlap.
     */
    const allocation = await requestOnce<{
      readonly allocationId: string;
      readonly actualPort: number;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-cwd-infer-allocate`,
      method: "allocateRoute",
      payload: {
        name: "vite",
        command: "vite --host",
        cwd: clientCwd,
        requestedPort: 3004,
        host: "127.0.0.1",
        routeDirection: "listen",
        scanRange: 20,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-cwd-infer-register`,
      method: "registerExistingProcess",
      payload: {
        pid: process.pid,
        name: "vite",
        command: "vite --host",
        cwd: clientCwd,
        requestedPort: 3004,
        actualPort: allocation.actualPort,
        host: "127.0.0.1",
        allocationId: allocation.allocationId,
        source: "hooked",
      },
    });

    await waitForFile(unscopedRouteEntryPath);
    const route = readRouteTable(unscopedRouteEntryPath).routes[0] as {
      readonly networkId?: string;
      readonly source?: string;
    };

    assert.equal(route.networkId, undefined);
    assert.equal(route.source, "hooked");
    assert.equal(fs.existsSync(scopedRouteEntryPath), false);
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
  const baseDirectory = path.join(projectRoot, ".tmp", "native-agent-tests");
  const testDirectory = path.join(
    baseDirectory,
    `run-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
  );
  fs.mkdirSync(testDirectory, { recursive: true });
  const socketPath = path.join(testDirectory, "agent.sock");
  const routeTablePath = path.join(testDirectory, "routes.json");
  const stderrChunks: Buffer[] = [];
  const agent = spawn(nativeAgentPath, [
    "--socket",
    socketPath,
    "--route-table",
    routeTablePath,
    "--agent-main",
    path.join(projectRoot, "out", "src", "agent", "agent-main.js"),
  ], {
    env: {
      ...process.env,
      PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  agent.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  context.after(async () => {
    await stopAgent(agent);
    await fs.promises.rm(socketPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(routeTablePath, { force: true }).catch(() => undefined);
    await removeRouteTableSiblings(routeTablePath);
    await fs.promises.rm(testDirectory, { recursive: true, force: true }).catch(() => undefined);
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
  connectTimeoutMs = 1000,
): Promise<T> {
  const socket = await connectSocket(socketPath, connectTimeoutMs);

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

async function connectSocket(socketPath: string, timeoutMs = 1000): Promise<net.Socket> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await connectSocketOnce(socketPath, Math.max(100, timeoutMs - (Date.now() - startedAt)));
    } catch (error) {
      lastError = error;
      if (!isRetryableConnectError(error)) {
        throw error;
      }
      await delay(10);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Timed out connecting to native agent: ${socketPath}`);
}

function connectSocketOnce(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to native agent: ${socketPath}`));
    }, timeoutMs);

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

function isRetryableConnectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as { readonly code?: unknown }).code;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "EAGAIN" || code === "ECONNRESET";
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

async function waitForRouteTableCount(filePath: string, expectedCount: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastCount = -1;
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastCount = readRouteTable(filePath).routes.length;
      if (lastCount === expectedCount) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for route table count ${expectedCount} at ${filePath}; last count=${lastCount}; last error=${String(lastError)}`,
  );
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

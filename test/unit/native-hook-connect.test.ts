import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getRouteTablePathForComposeClaimPort, getRouteTablePathForGatewayClaimPort } from "../../src/agent/route-table";

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
  assert.equal(source.includes("PM_MAX_ROUTES"), false);
  assert.equal(source.includes("pm_route_capacity"), true);
  assert.equal(source.includes("PM_ROUTE_MAPPING_MAX_CAPACITY 65535"), true);
  assert.equal(source.includes("PM_ROUTE_ALLOCATION_TTL_MS 300000"), true);
  assert.equal(source.includes("long expires_at_ms;"), true);
  assert.equal(source.includes("pm_ensure_memory_route_capacity(pm_route_count + 1)"), true);
  assert.equal(
    source.includes("pm_routes[index].logical_port == logical_port && strcmp(pm_routes[index].network_id, route_network_id) == 0"),
    true,
  );
  assert.equal(
    source.includes("pm_routes[index].actual_port == actual_port && strcmp(pm_routes[index].network_id, route_network_id) == 0"),
    true,
  );
  assert.equal(source.includes("pm_memory_route_expired(&pm_routes[index], now_ms)"), true);
});

test("native hook route file cache is invalidated by path size and high-resolution mtime", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const loaderStart = source.indexOf("static int pm_load_route_file_routes");
  const loaderEnd = source.indexOf("static int pm_cached_route_network_match_level", loaderStart);
  const loaderBody = source.slice(loaderStart, loaderEnd);

  assert.equal(source.includes("pm_route_file_cache_entry"), true);
  assert.equal(source.includes("PM_ROUTE_FILE_CACHE_CAPACITY"), false);
  assert.equal(source.includes("PM_ROUTE_FILE_CACHE_INITIAL_CAPACITY"), true);
  assert.equal(source.includes("PM_ROUTE_FILE_CACHE_MAX_CAPACITY 65535"), true);
  assert.equal(source.includes("pm_route_file_cache_count"), true);
  assert.equal(source.includes("pm_ensure_route_file_cache_capacity"), true);
  assert.equal(source.includes('PM_ROUTE_TABLE_TTL_SECONDS_ENV "PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS"'), true);
  assert.equal(source.includes("PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS 15"), true);
  assert.equal(source.includes("pm_route_table_ttl_seconds() * 1000L"), true);
  assert.equal(source.includes("pm_route_file_stat_expired"), true);
  assert.equal(source.includes("pm_route_file_buffer_expired"), true);
  assert.equal(source.includes("pm_route_file_writer_alive"), false);
  assert.equal(source.includes("return !pm_route_file_writer_alive(buffer);"), false);
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
  assert.equal(source.includes("pm_remember_route(logical_port, actual_port, target_host"), true);
  assert.equal(source.includes("pm_remember_route(logical_port, actual_port, target_host, allocation_id, PM_ROUTE_ALLOCATION_TTL_MS)"), true);
  assert.equal(source.includes("if (!route->has_network_id) {\n    return 0;\n  }"), true);
});

test("native hook bypasses route logic when no network scope is attached", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const bindStart = source.indexOf("static int pm_bind_hook");
  const bindEnd = source.indexOf("static int pm_connect_hook", bindStart);
  const connectStart = source.indexOf("static int pm_connect_hook");
  const connectEnd = source.indexOf("static int pm_getsockname_hook", connectStart);
  const bindBody = source.slice(bindStart, bindEnd);
  const connectBody = source.slice(connectStart, connectEnd);

  assert.notEqual(bindStart, -1);
  assert.notEqual(connectStart, -1);
  assert.equal(bindBody.includes("if (!pm_has_current_network_scope())"), true);
  assert.equal(connectBody.includes("if (!pm_has_current_network_scope())"), true);
  assert.equal(bindBody.indexOf("if (!pm_has_current_network_scope())") < bindBody.indexOf("pm_loopback_address_only_mode()"), true);
  assert.equal(connectBody.indexOf("if (!pm_has_current_network_scope())") < connectBody.indexOf("pm_connect_route_table_lookup"), true);
  assert.equal(connectBody.indexOf("if (!pm_has_current_network_scope())") < connectBody.indexOf("pm_allocate_route("), true);
});

test("native hook keeps the global network scope host-real", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const hostnameStart = source.indexOf("static const char *pm_network_hostname");
  const hostnameEnd = source.indexOf("static int pm_gethostname_hook", hostnameStart);
  const dockerStart = source.indexOf("static int pm_should_block_docker_socket");
  const dockerEnd = source.indexOf("static int pm_has_current_network_scope", dockerStart);
  const argvStart = source.indexOf("static char **pm_rewrite_localhost_argv");
  const argvEnd = source.indexOf("pm_envp_network_loopback_host(envp);", argvStart);

  assert.notEqual(hostnameStart, -1);
  assert.notEqual(dockerStart, -1);
  assert.notEqual(argvStart, -1);
  // Identity, the Docker-socket guard, argv rewriting, and the per-network
  // env/file constructors all stay host-real inside the global scope.
  assert.equal(source.slice(hostnameStart, hostnameEnd).includes("pm_network_scope_is_global()"), true);
  assert.equal(source.slice(dockerStart, dockerEnd).includes("pm_network_scope_is_global()"), true);
  assert.equal(source.includes('getenv("PORT_MANAGER_NETWORK_NAME")'), true);
  assert.equal(source.includes("network_name == NULL || network_name[0] == '\\0'"), true);
  assert.equal(source.includes("static int pm_envp_network_scope_is_global(char *const envp[])"), true);
  assert.equal(
    source.slice(argvStart, argvEnd).includes("pm_envp_network_scope_is_global(envp)"),
    true,
  );
  assert.equal(source.includes("if (!pm_hook_enabled() || pm_network_scope_is_global()) {"), true);
  assert.equal(
    source.includes("if (!pm_hook_enabled() || !pm_has_current_network_scope() || pm_network_scope_is_global()) {"),
    true,
  );
});

test("native hook blocks fixed protocol localhost fallback inside a logical network", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const connectStart = source.indexOf("static int pm_connect_hook");
  const connectEnd = source.indexOf("static int pm_getsockname_hook", connectStart);
  const connectBody = source.slice(connectStart, connectEnd);
  const loopbackStart = connectBody.indexOf("if (actual_port == 0 && loopback_host != NULL)");
  const loopbackConditionEnd = connectBody.indexOf("{", loopbackStart);
  const waitStart = connectBody.indexOf("if (actual_port == 0 && pm_has_current_network_scope())", loopbackStart);
  const waitConditionEnd = connectBody.indexOf("{", waitStart);
  const fixedBlockStart = connectBody.indexOf("connect blocked fixed protocol host fallback logical=%d");
  const hostFallbackStart = connectBody.indexOf("if (actual_port <= 0)", fixedBlockStart);

  assert.notEqual(connectStart, -1);
  assert.notEqual(loopbackStart, -1);
  assert.notEqual(waitStart, -1);
  assert.notEqual(fixedBlockStart, -1);
  assert.notEqual(hostFallbackStart, -1);
  assert.equal(connectBody.slice(loopbackStart, loopbackConditionEnd).includes("!pm_is_fixed_protocol_port(logical_port)"), false);
  assert.equal(connectBody.slice(waitStart, waitConditionEnd).includes("!pm_is_fixed_protocol_port(logical_port)"), false);
  assert.equal(fixedBlockStart < hostFallbackStart, true);
  assert.equal(connectBody.includes("errno = loopback_fallback_errno != 0 ? loopback_fallback_errno : ECONNREFUSED;"), true);
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

  test("native hook leaves no-network localhost connects outside route resolution", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-connect-"));
    const server = net.createServer((socket) => {
      socket.end("leaked\n");
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

    const logicalPort = await chooseUnusedTcpPort(address.port);
    const routeTablePath = path.join(tempDir, "newdlops-portmanager-routes-detached-unscoped.json");
    fs.writeFileSync(
      routeTablePath,
      JSON.stringify({
        updatedAt: "2026-07-01T00:00:00.000Z",
        routes: [
          {
            logicalPort,
            actualPort: address.port,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: projectRoot,
            processId: "managed-process-unscoped",
            processName: "node server.js",
            status: "running",
            source: "managed",
          },
        ],
      }),
      "utf8",
    );

    const result = await runHookedNodeClient(logicalPort, routeTablePath, undefined, {
      env: {
        PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
        PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
        PORT_MANAGER_AGENT_ROUNDTRIP_TIMEOUT_MS: "50",
      },
    });

    assert.equal(result.exitCode, 23);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ECONNREFUSED\n");
  });

  test("native hook global scope does not raw-passthrough unmanaged localhost connects", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-global-raw-"));
    const server = net.createServer((socket) => {
      socket.end("host\n");
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

    const networkId = "network-global-test";
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-global-${networkId}.json`);
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-07-07T00:00:00.000Z", routes: [] }), "utf8");
    const globalEnv = {
      PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE: "loopback-address-only",
      PORT_MANAGER_NETWORK_IS_GLOBAL: "1",
      PORT_MANAGER_NETWORK_LOOPBACK_HOST: "",
      PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "",
      PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
      PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
    };

    const result = await runHookedNodeClient(address.port, routeTablePath, networkId, {
      env: globalEnv,
      timeoutMs: 500,
    });

    assert.equal(result.exitCode, 23);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "", "global localhost must not leak to the host listener");

    // The same env without the global flag is a plain network: the dial is
    // pinned to the (unaliased) network loopback and must not reach the host.
    const scoped = await runHookedNodeClient(address.port, routeTablePath, networkId, {
      env: { ...globalEnv, PORT_MANAGER_NETWORK_IS_GLOBAL: "" },
    });

    assert.equal(scoped.exitCode, 23);
    assert.equal(scoped.stdout, "");
  });

  test("native hook global scope rewrites managed localhost connects through route rows", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-global-managed-"));
    const server = net.createServer((socket) => {
      socket.end("managed\n");
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

    const networkId = "network-global-test";
    const logicalPort = chooseDifferentTcpPort(address.port);
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-global-${networkId}.json`);
    fs.writeFileSync(
      routeTablePath,
      JSON.stringify({
        updatedAt: "2026-07-07T00:00:00.000Z",
        routes: [
          {
            logicalPort,
            actualPort: address.port,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: projectRoot,
            networkId,
            processId: "managed-process-global",
            processName: "node server.js",
            status: "running",
            source: "managed",
          },
        ],
      }),
      "utf8",
    );

    const result = await runHookedNodeClient(logicalPort, routeTablePath, networkId, {
      env: {
        PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE: "loopback-address-only",
        PORT_MANAGER_NETWORK_IS_GLOBAL: "1",
        PORT_MANAGER_NETWORK_LOOPBACK_HOST: "127.1.0.1",
        PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "127.1.0.1",
        PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
        PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "managed\n");
    assert.equal(result.stderr, "");
  });

  test("native hook global scope does not raw-fallback stale managed rows", () => {
    const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
    const source = fs.readFileSync(sourcePath, "utf8");
    const connectStart = source.indexOf("static int pm_connect_hook");
    const connectEnd = source.indexOf("static int pm_getsockname_hook", connectStart);
    const connectBody = source.slice(connectStart, connectEnd);
    const globalStart = connectBody.indexOf("connect global managed logical=%d");
    const managedFailureStart = connectBody.indexOf("connect global managed failed logical=%d", globalStart);

    assert.notEqual(globalStart, -1);
    assert.notEqual(managedFailureStart, -1);
    assert.equal(connectBody.includes("connect global raw fallback logical=%d"), false);
    assert.equal(connectBody.includes("connect global raw passthrough logical=%d"), false);
    assert.equal(connectBody.includes("connect global raw passthrough (no alias) logical=%d"), false);
    assert.equal(connectBody.slice(managedFailureStart).includes("return alias_result;"), true);
  });

  test("native hook refuses scope-less dials into gateway-owned fixed-protocol dead ends", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-deadend-"));
    const server = net.createServer((socket) => {
      socket.end("host\n");
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

    const routeTablePath = path.join(tempDir, "newdlops-portmanager-routes-deadend.json");
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-07-07T00:00:00.000Z", routes: [] }), "utf8");
    const claimPath = getRouteTablePathForGatewayClaimPort(address.port, routeTablePath);
    const clientEnv = {
      PORT_MANAGER_GLOBAL_ROUTES_FILE: routeTablePath,
      PORT_MANAGER_FIXED_PROTOCOL_PORTS: String(address.port),
      PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
      PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
    };

    // A fresh gateway claim on a fixed-protocol port is a dead end for a
    // scope-less caller: the hook must refuse synchronously, never reaching
    // the listener that stands in for the gateway here.
    fs.writeFileSync(claimPath, JSON.stringify({ expiresAtMs: Date.now() + 60_000 }), "utf8");
    const refused = await runHookedNodeClient(address.port, routeTablePath, undefined, { env: clientEnv });

    assert.equal(refused.exitCode, 23);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, "ECONNREFUSED\n");

    // A stale claim means the gateway is gone; the raw coordinate belongs to
    // whatever really listens there again.
    fs.writeFileSync(claimPath, JSON.stringify({ expiresAtMs: Date.now() - 60_000 }), "utf8");
    const passedThrough = await runHookedNodeClient(address.port, routeTablePath, undefined, { env: clientEnv });

    assert.equal(passedThrough.exitCode, 0);
    assert.equal(passedThrough.stdout, "host\n");
  });

  test("native hook refuses global-scope dials into gateway-owned fixed-protocol dead ends", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-global-deadend-"));
    const server = net.createServer((socket) => {
      socket.end("host\n");
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

    const networkId = "network-global-test";
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-global-${networkId}.json`);
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-07-07T00:00:00.000Z", routes: [] }), "utf8");
    const claimPath = getRouteTablePathForGatewayClaimPort(address.port, routeTablePath);
    fs.writeFileSync(claimPath, JSON.stringify({ expiresAtMs: Date.now() + 60_000 }), "utf8");

    const result = await runHookedNodeClient(address.port, routeTablePath, networkId, {
      env: {
        PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE: "loopback-address-only",
        PORT_MANAGER_NETWORK_IS_GLOBAL: "1",
        PORT_MANAGER_NETWORK_LOOPBACK_HOST: "127.1.0.1",
        PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "127.1.0.1",
        PORT_MANAGER_GLOBAL_ROUTES_FILE: routeTablePath,
        PORT_MANAGER_FIXED_PROTOCOL_PORTS: String(address.port),
        PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
        PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
      },
    });

    assert.equal(result.exitCode, 23);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ECONNREFUSED\n");
  });

  test("native hook does not leak fixed protocol connects to host localhost", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-fixed-connect-"));
    const server = net.createServer((socket) => {
      socket.end("leaked\n");
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

    const networkId = "network-fixed-protocol";
    const routeTablePath = path.join(tempDir, `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-${networkId}.json`);
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-07-02T00:00:00.000Z", routes: [] }), "utf8");

    const result = await runHookedNodeClient(address.port, routeTablePath, networkId, {
      env: {
        PORT_MANAGER_FIXED_PROTOCOL_PORTS: String(address.port),
        PORT_MANAGER_NETWORK_LOOPBACK_HOST: "",
        PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
        PORT_MANAGER_AGENT_SOCKET: path.join(tempDir, "missing-agent.sock"),
        PORT_MANAGER_AGENT_ROUNDTRIP_TIMEOUT_MS: "50",
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

  test("native hook does not use unscoped route-file entries inside a logical network", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-connect-"));
    const server = net.createServer((socket) => {
      socket.end("leaked\n");
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

    const networkId = "network-unscoped-route-leak";
    const logicalPort = await chooseUnusedTcpPort(address.port);
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
            cwd: projectRoot,
            processId: "managed-process-unscoped",
            processName: "node server.js",
            status: "running",
            source: "managed",
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

    assert.equal(result.exitCode, 23);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ECONNREFUSED\n");
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

  test("native hook coalesces concurrent sender-first allocation requests", async (context) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-hook-send-join-"));
    const routeTablePath = path.join(
      tempDir,
      `newdlops-portmanager-routes-${process.getuid?.() ?? "user"}-network-send-join.json`,
    );
    const agentSocketPath = path.join("/tmp", `portmanager-hook-send-join-${process.pid}-${Date.now()}.sock`);
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
        setTimeout(() => {
          fs.writeFileSync(
            routeTablePath,
            JSON.stringify({
              updatedAt: "2026-06-30T00:00:01.000Z",
              routes: [
                {
                  logicalPort,
                  actualPort,
                  routeDirection: "send",
                  host: "127.0.0.1",
                  cwd: projectRoot,
                  networkId: "network-send-join",
                  processName: "wait-on",
                  status: "starting",
                  source: "allocated",
                },
              ],
            }),
            "utf8",
          );
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
                expiresAt: "2026-06-30T00:00:30Z",
              },
            })}\n`,
          );
        }, 150);
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
    fs.writeFileSync(routeTablePath, JSON.stringify({ updatedAt: "2026-06-30T00:00:00.000Z", routes: [] }), "utf8");
    await listenOnUnixSocket(agentServer, agentSocketPath);

    const clientEnv = {
      PORT_MANAGER_AGENT_SOCKET: agentSocketPath,
      PORT_MANAGER_CONNECT_ROUTE_WAIT_MS: "0",
      PORT_MANAGER_SEND_ALLOCATION_JOIN_WAIT_MS: "2000",
      PORT_MANAGER_AGENT_TIMEOUT_MS: "3000",
    };
    const results = await Promise.all([
      runHookedNodeClient(logicalPort, routeTablePath, "network-send-join", { env: clientEnv }),
      runHookedNodeClient(logicalPort, routeTablePath, "network-send-join", { env: clientEnv }),
    ]);

    assert.deepEqual(
      results.map((result) => result.exitCode),
      [0, 0],
    );
    assert.deepEqual(
      results.map((result) => result.stdout),
      ["ok\n", "ok\n"],
    );
    assert.deepEqual(
      results.map((result) => result.stderr),
      ["", ""],
    );
    const allocationRequests = agentRequests.filter((request) => request.method === "allocateRoute");
    assert.equal(allocationRequests.length, 1);
    assert.equal(allocationRequests[0]?.payload.routeDirection, "send");
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
    const allocationRequests = agentRequests.filter((request) => request.method === "allocateRoute");
    assert.equal(allocationRequests.length, 1);
    assert.equal(allocationRequests[0]?.payload.host, "127.0.0.1");
    assert.equal(allocationRequests[0]?.payload.actualHost, "127.81.154.127");
  });
}

interface AgentRequest {
  readonly id: string;
  readonly method: string;
  readonly payload: {
    readonly host?: string;
    readonly actualHost?: string;
    readonly routeDirection?: string;
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
    readonly timeoutMs?: number;
  } = {},
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
  const host = options.host ?? "127.0.0.1";
  const script = [
    "const net = require('node:net');",
    `const socket = net.createConnection({ host: ${JSON.stringify(host)}, port: ${port} });`,
    ...(options.timeoutMs === undefined
      ? []
      : [
          `socket.setTimeout(${JSON.stringify(options.timeoutMs)}, () => { process.stderr.write("TIMEOUT\\n"); socket.destroy(); process.exit(23); });`,
        ]),
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
      PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE: "",
      PORT_MANAGER_ROUTING_MODE: "",
      PORT_MANAGER_NETWORK_LOOPBACK_HOST: "",
      PORT_MANAGER_ACTUAL_LOOPBACK_HOST: "",
      PORT_MANAGER_FIXED_PROTOCOL_PORTS: "",
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

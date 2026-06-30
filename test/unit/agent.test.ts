import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { PortManagerAgent } from "../../src/agent/port-manager-agent";
import { encodeAgentMessage, NdjsonMessageBuffer } from "../../src/agent/protocol";
import {
  getNetworkRouteTablePath,
  getRouteTablePathForComposeClaimPort,
  getRouteTablePathForLogicalPort,
  routeTableRefreshMarginMs,
  ROUTE_TABLE_TTL_MS,
} from "../../src/agent/route-table";
import type {
  EstablishedTcpConnection,
  ListeningPort,
  PortAvailabilityProvider,
  ProcessLauncher,
} from "../../src/shared/types";

/**
 * Unit tests for daemon-side registration behavior.
 *
 * The native hook talks to these public agent methods over the local protocol,
 * so these tests use fake platform adapters instead of opening real sockets.
 */

const fixedUpdatedAt = "2026-06-21T10:00:00.000Z";
const fixedNow = () => new Date(fixedUpdatedAt);

test("registers native hook processes as hooked managed rows", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let listeners: readonly ListeningPort[] = [
    createListener({
      port: 58000,
      pid: 1234,
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const process = await agent.registerExistingProcess({
    pid: 1234,
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 8000,
    actualPort: 58000,
    host: "localhost",
    networkId: "network-a",
    source: "hooked",
  });

  const snapshot = await agent.listSnapshot();

  assert.equal(process.source, "hooked");
  assert.equal(snapshot.processes[0]?.source, "hooked");
  assert.equal(snapshot.processes[0]?.status, "running");
  assert.equal(snapshot.listeners[0]?.source, "managed");
  assert.deepEqual(snapshot.routes, [
    {
      logicalPort: 8000,
      actualPort: 58000,
      routeDirection: "listen",
      host: "localhost",
      cwd: "/workspace/app",
      networkId: "network-a",
      processId: process.id,
      processName: "node",
      status: "running",
      source: "hooked",
    },
  ]);
  const networkRouteTable = readRouteTable(getNetworkRouteTablePath("network-a", routeTablePath));
  assert.equal(networkRouteTable.ttlMs, ROUTE_TABLE_TTL_MS);
  assert.equal(networkRouteTable.expiresAt, new Date(Date.parse(fixedUpdatedAt) + ROUTE_TABLE_TTL_MS).toISOString());
  assert.equal(networkRouteTable.expiresAtMs, Date.parse(fixedUpdatedAt) + ROUTE_TABLE_TTL_MS);
  assert.deepEqual(networkRouteTable.routes, snapshot.routes);
  assert.deepEqual(readRouteTable(getRouteTablePathForLogicalPort(8000, "network-a", routeTablePath)).routes, snapshot.routes);

  listeners = [];
});

test("new agent generation clears previous network route files on startup", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const networkRouteTablePath = getNetworkRouteTablePath("network-a", routeTablePath);
  const routeEntryPath = getRouteTablePathForLogicalPort(8000, "network-a", routeTablePath);
  const staleRoutes = [
    {
      logicalPort: 8000,
      actualPort: 58000,
      routeDirection: "listen",
      host: "127.0.0.1",
      networkId: "network-a",
      status: "running",
      source: "hooked",
    },
  ];

  fs.mkdirSync(path.dirname(routeTablePath), { recursive: true });
  for (const filePath of [routeTablePath, networkRouteTablePath, routeEntryPath]) {
    fs.writeFileSync(filePath, `${JSON.stringify({ updatedAt: fixedUpdatedAt, routes: staleRoutes }, null, 2)}\n`);
  }

  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  assert.deepEqual(readRouteTable(routeTablePath).routes, []);
  assert.deepEqual(readRouteTable(networkRouteTablePath).routes, []);
  assert.equal(fs.existsSync(routeEntryPath), false);
});

test("newer route table generation rejects stale daemon writes", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const staleAgent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
    routeTableWriterStartedAtMs: 1_000,
    routeTableWriterId: "stale-writer",
  });
  context.after(() => staleAgent.dispose());

  await staleAgent.registerExistingProcess({
    pid: 1234,
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 8000,
    actualPort: 58000,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });

  assert.equal(readRouteTableGeneration(routeTablePath)?.writerId, "stale-writer");
  assert.equal(readRouteTable(routeTablePath).routes.length, 1);

  const freshAgent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 888,
    now: fixedNow,
    routeTablePath,
    routeTableWriterStartedAtMs: 2_000,
    routeTableWriterId: "fresh-writer",
  });
  context.after(() => freshAgent.dispose());

  assert.equal(readRouteTableGeneration(routeTablePath)?.writerId, "fresh-writer");
  assert.deepEqual(readRouteTable(routeTablePath).routes, []);

  await assert.rejects(
    () =>
      staleAgent.registerExistingProcess({
        pid: 5678,
        name: "node",
        command: "node server.js",
        cwd: "/workspace/app",
        requestedPort: 8001,
        actualPort: 58001,
        host: "127.0.0.1",
        networkId: "network-a",
        source: "hooked",
      }),
    /route table publish failed/,
  );

  assert.equal(readRouteTableGeneration(routeTablePath)?.writerId, "fresh-writer");
  assert.deepEqual(readRouteTable(routeTablePath).routes, []);
  assert.equal(fs.existsSync(getRouteTablePathForLogicalPort(8001, "network-a", routeTablePath)), false);
});

test("refreshSnapshot refreshes unchanged route tables only for established routes", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let nowMs = Date.parse(fixedUpdatedAt);
  let establishedConnections: readonly EstablishedTcpConnection[] = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    establishedConnectionProvider: {
      list: async () => establishedConnections,
    },
    agentPid: 777,
    now: () => new Date(nowMs),
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1234,
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 8000,
    actualPort: 58000,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });

  const initialRouteTable = readRouteTable(routeTablePath);
  assert.equal(initialRouteTable.expiresAtMs, nowMs + ROUTE_TABLE_TTL_MS);

  nowMs += ROUTE_TABLE_TTL_MS - routeTableRefreshMarginMs(ROUTE_TABLE_TTL_MS) + 1;
  await agent.refreshSnapshot();

  assert.equal(readRouteTable(routeTablePath).expiresAtMs, initialRouteTable.expiresAtMs);

  establishedConnections = [
    {
      localAddress: "127.0.0.1",
      localPort: 58000,
      remoteAddress: "127.0.0.1",
      remotePort: 53000,
    },
  ];
  nowMs += 1_000;
  await agent.refreshSnapshot();

  const refreshedRouteTable = readRouteTable(routeTablePath);
  assert.equal(refreshedRouteTable.ttlMs, ROUTE_TABLE_TTL_MS);
  assert.equal(refreshedRouteTable.expiresAtMs, nowMs + ROUTE_TABLE_TTL_MS);

  fs.writeFileSync(
    routeTablePath,
    `${JSON.stringify(
      {
        updatedAt: fixedUpdatedAt,
        generation: refreshedRouteTable.generation,
        routes: refreshedRouteTable.routes,
      },
      null,
      2,
    )}\n`,
  );
  nowMs += 1_000;

  await agent.refreshSnapshot();

  assert.equal(readRouteTable(routeTablePath).ttlMs, ROUTE_TABLE_TTL_MS);
});

test("keeps unscoped host listeners out of cwd-matched networks", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 0,
    name: "postgres",
    command: "docker compose up postgres",
    cwd: "/workspace/app/docker",
    requestedPort: 15432,
    actualPort: 55432,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "compose",
  });

  /*
   * The cwd is intentionally inside the same project as the scoped compose
   * route. Without an explicit network id from the terminal hook, this listener
   * is still a host listener and must remain unscoped.
   */
  const allocation = await agent.allocateRoute({
    name: "vite",
    command: "vite --host",
    cwd: "/workspace/app/zuzu/client",
    requestedPort: 3004,
    host: "127.0.0.1",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 59000,
  });

  await agent.registerExistingProcess({
    pid: 4321,
    name: "vite",
    command: "vite --host",
    cwd: "/workspace/app/zuzu/client",
    requestedPort: 3004,
    actualPort: allocation.actualPort,
    host: "127.0.0.1",
    allocationId: allocation.allocationId,
    source: "hooked",
  });

  const snapshot = await agent.listSnapshot();
  const route = snapshot.routes.find((item) => item.logicalPort === 3004);

  assert.equal(route?.networkId, undefined);
  assert.equal(readRouteTable(getRouteTablePathForLogicalPort(3004, undefined, routeTablePath)).routes.length, 1);
  assert.equal(fs.existsSync(getRouteTablePathForLogicalPort(3004, "network-a", routeTablePath)), false);
});

test("releases loopback routes without adopting another network on the same port", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let listeners: readonly ListeningPort[] = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1111,
    name: "vite",
    command: "vite --host 0.0.0.0 --port 3004",
    cwd: "/workspace/app-a",
    requestedPort: 3004,
    actualPort: 3004,
    host: "127.80.1.1",
    networkId: "network-a",
    source: "hooked",
  });
  await agent.registerExistingProcess({
    pid: 2222,
    name: "vite",
    command: "vite --host 0.0.0.0 --port 3004",
    cwd: "/workspace/app-b",
    requestedPort: 3004,
    actualPort: 3004,
    host: "127.80.1.2",
    networkId: "network-b",
    source: "hooked",
  });
  listeners = [
    createListener({
      id: "tcp:127.80.1.2:3004:2222",
      localAddress: "127.80.1.2",
      port: 3004,
      pid: 2222,
      processName: "vite",
      command: "vite --host 0.0.0.0 --port 3004",
    }),
  ];

  const released = await agent.releaseProcessRoute({
    pid: 1111,
    requestedPort: 3004,
    actualPort: 3004,
    networkId: "network-a",
  });
  const snapshot = await agent.listSnapshot();

  assert.equal(released, true);
  assert.equal(snapshot.routes.some((route) => route.networkId === "network-a"), false);
  assert.equal(snapshot.routes.some((route) => route.networkId === "network-b"), true);
  assert.equal(snapshot.processes.find((process) => process.networkId === "network-a")?.status, "stopped");
  assert.equal(snapshot.processes.find((process) => process.networkId === "network-b")?.status, "running");
});

test("recovers hooked routes from live listeners after daemon restart", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const listeners: readonly ListeningPort[] = [
    createListener({
      id: "tcp:127.0.0.1:57282:64255",
      port: 57282,
      pid: 64255,
      processName: "python3.11",
      command: "python3.11",
    }),
  ];
  let recoverCalls = 0;
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    hookRouteRecoveryProvider: {
      recoverHookRoute: async (listener) => {
        recoverCalls += 1;
        return {
          pid: listener.pid ?? 0,
          name: listener.processName ?? "python3",
          command: "python manage.py runserver 8004",
          cwd: "/workspace/app",
          requestedPort: 8004,
          actualPort: listener.port,
          host: "127.0.0.1",
          networkId: "network-a",
          source: "hooked",
        };
      },
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const snapshot = await agent.refreshSnapshot();
  const secondSnapshot = await agent.refreshSnapshot();
  const networkRouteTable = readRouteTable(getNetworkRouteTablePath("network-a", routeTablePath));
  const routeEntryTable = readRouteTable(getRouteTablePathForLogicalPort(8004, "network-a", routeTablePath));

  assert.equal(recoverCalls, 1);
  assert.equal(snapshot.processes[0]?.source, "hooked");
  assert.equal(secondSnapshot.routes.length, 1);
  assert.deepEqual(snapshot.routes, [
    {
      logicalPort: 8004,
      actualPort: 57282,
      routeDirection: "listen",
      host: "127.0.0.1",
      cwd: "/workspace/app",
      networkId: "network-a",
      processId: snapshot.processes[0]?.id,
      processName: "python3.11",
      status: "running",
      source: "hooked",
    },
  ]);
  assert.deepEqual(networkRouteTable.routes, snapshot.routes);
  assert.deepEqual(routeEntryTable.routes, snapshot.routes);
});

test("releases hooked process routes and removes endpoint files when the owner exits", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let listeners: readonly ListeningPort[] = [
    createListener({
      port: 58000,
      pid: 1234,
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1234,
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 8000,
    actualPort: 58000,
    host: "localhost",
    networkId: "network-a",
    source: "hooked",
  });

  const networkRouteTablePath = getNetworkRouteTablePath("network-a", routeTablePath);
  const routeEntryPath = getRouteTablePathForLogicalPort(8000, "network-a", routeTablePath);
  assert.equal(fs.existsSync(routeEntryPath), true);

  listeners = [];
  const released = await agent.releaseProcessRoute({
    pid: 1234,
    requestedPort: 8000,
    actualPort: 58000,
    networkId: "network-a",
  });
  const snapshot = await agent.listSnapshot();

  assert.equal(released, true);
  assert.equal(snapshot.processes[0]?.status, "stopped");
  assert.deepEqual(snapshot.routes, []);
  assert.deepEqual(readRouteTable(networkRouteTablePath).routes, []);
  assert.equal(fs.existsSync(routeEntryPath), false);
});

test("keeps hooked process routes when another PID still owns the listener", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let listeners: readonly ListeningPort[] = [
    createListener({
      port: 58000,
      pid: 1234,
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1234,
    name: "daphne-parent",
    command: "python manage.py runserver 8000",
    cwd: "/workspace/app",
    requestedPort: 8000,
    actualPort: 58000,
    host: "localhost",
    networkId: "network-a",
    source: "hooked",
  });

  listeners = [
    createListener({
      port: 58000,
      pid: 4321,
      processName: "daphne-worker",
      command: "python manage.py runserver 8000",
    }),
  ];
  const released = await agent.releaseProcessRoute({
    pid: 1234,
    requestedPort: 8000,
    actualPort: 58000,
    networkId: "network-a",
  });
  const snapshot = await agent.listSnapshot();
  const routeEntryPath = getRouteTablePathForLogicalPort(8000, "network-a", routeTablePath);

  assert.equal(released, false);
  assert.equal(snapshot.processes[0]?.status, "running");
  assert.equal(snapshot.processes[0]?.pid, 4321);
  assert.equal(snapshot.routes.length, 1);
  assert.equal(fs.existsSync(routeEntryPath), true);
});

test("preserves pending allocation network scope when a hooked register omits it", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let listeners: readonly ListeningPort[] = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const allocation = await agent.allocateRoute({
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "listen",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  listeners = [
    createListener({
      port: allocation.actualPort,
      pid: 1234,
    }),
  ];

  await agent.registerExistingProcess({
    pid: 1234,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: allocation.actualPort,
    host: "127.0.0.1",
    allocationId: allocation.allocationId,
    source: "hooked",
  });

  const snapshot = await agent.listSnapshot();

  assert.equal(snapshot.routes[0]?.networkId, "network-a");
});

test("removes expired pending allocation endpoint files", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let nowMs = Date.parse(fixedUpdatedAt);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: () => new Date(nowMs),
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http://localhost:8004/healthz",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  const networkRouteTablePath = getNetworkRouteTablePath("network-a", routeTablePath);
  const routeEntryPath = getRouteTablePathForLogicalPort(8004, "network-a", routeTablePath);
  assert.equal(fs.existsSync(routeEntryPath), true);

  nowMs += 300_001;
  const snapshot = await agent.listSnapshot();

  assert.deepEqual(snapshot.routes, []);
  assert.deepEqual(readRouteTable(networkRouteTablePath).routes, []);
  assert.equal(fs.existsSync(routeEntryPath), false);
});

test("keeps expired pending route files while the actual listener is alive", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let nowMs = Date.parse(fixedUpdatedAt);
  let listeners: readonly ListeningPort[] = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: () => new Date(nowMs),
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const allocation = await agent.allocateRoute({
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "listen",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  const networkRouteTablePath = getNetworkRouteTablePath("network-a", routeTablePath);
  const routeEntryPath = getRouteTablePathForLogicalPort(8004, "network-a", routeTablePath);
  listeners = [
    createListener({
      port: allocation.actualPort,
      pid: 4321,
      processName: "python3",
    }),
  ];

  nowMs += 30_001;
  const snapshot = await agent.listSnapshot();

  assert.equal(snapshot.routes.length, 1);
  assert.equal((snapshot.routes[0] as { actualPort?: number }).actualPort, allocation.actualPort);
  assert.equal(readRouteTable(networkRouteTablePath).routes.length, 1);
  assert.equal(fs.existsSync(routeEntryPath), true);
});

test("keeps hooked process rows during request snapshots and transient background misses", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let nowMs = Date.parse(fixedUpdatedAt);
  let listeners: readonly ListeningPort[] = [
    createListener({
      port: 58000,
      pid: 1234,
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: () => new Date(nowMs),
    routeTablePath,
    externalListenerGraceMs: 10_000,
    externalListenerMissingScanThreshold: 2,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1234,
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 8000,
    actualPort: 58000,
    host: "localhost",
    source: "hooked",
  });

  listeners = [];
  const requestSnapshot = await agent.refreshSnapshot();

  assert.equal(requestSnapshot.processes[0]?.source, "hooked");
  assert.equal(requestSnapshot.processes[0]?.status, "running");
  assert.equal(requestSnapshot.routes.length, 1);
  assert.equal(readRouteTable(routeTablePath).routes.length, 1);

  await runListenerPoll(agent);
  const firstMissSnapshot = await agent.listSnapshot();

  assert.equal(firstMissSnapshot.processes[0]?.status, "running");
  assert.equal(firstMissSnapshot.routes.length, 1);

  nowMs += 10_001;
  const lateRequestSnapshot = await agent.refreshSnapshot();

  assert.equal(lateRequestSnapshot.processes[0]?.status, "running");
  assert.equal(lateRequestSnapshot.routes.length, 1);

  await runListenerPoll(agent);
  const stoppedSnapshot = await agent.listSnapshot();

  assert.equal(stoppedSnapshot.processes[0]?.source, "hooked");
  assert.equal(stoppedSnapshot.processes[0]?.status, "stopped");
  assert.deepEqual(stoppedSnapshot.routes, []);
});

test("updates duplicate hooked registrations for the same active route", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  let listeners: readonly ListeningPort[] = [
    createListener({
      port: 58000,
      pid: 1234,
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const first = await agent.registerExistingProcess({
    pid: 1234,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: 58000,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });

  listeners = [
    createListener({
      port: 58000,
      pid: 5678,
      processName: "python3",
      command: "python manage.py runserver 8004",
    }),
  ];

  const updated = await agent.registerExistingProcess({
    pid: 5678,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: 58000,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });
  const snapshot = await agent.listSnapshot();

  assert.equal(updated.id, first.id);
  assert.equal(snapshot.processes.filter((process) => process.source === "hooked").length, 1);
  assert.equal(snapshot.processes[0]?.pid, 5678);
  assert.deepEqual(snapshot.routes, [
    {
      logicalPort: 8004,
      actualPort: 58000,
      routeDirection: "listen",
      host: "127.0.0.1",
      cwd: "/workspace/app",
      networkId: "network-a",
      processId: first.id,
      processName: "python3",
      status: "running",
      source: "hooked",
    },
  ]);
});

test("uses latest route table row for repeated logical ports in the same network", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const listeners: readonly ListeningPort[] = [
    createListener({
      port: 58000,
      pid: 1234,
    }),
    createListener({
      id: "tcp:127.0.0.1:58001:5678",
      port: 58001,
      pid: 5678,
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1234,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: 58000,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });
  const latest = await agent.registerExistingProcess({
    pid: 5678,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: 58001,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });
  const snapshot = await agent.listSnapshot();

  assert.equal(snapshot.routes.length, 1);
  assert.equal(snapshot.routes[0]?.processId, latest.id);
  assert.equal(snapshot.routes[0]?.actualPort, 58001);
});

test("reserves active registry ports while listener scans are in grace", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const listeners: readonly ListeningPort[] = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1234,
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 3000,
    actualPort: 3000,
    host: "localhost",
    source: "hooked",
  });

  const allocation = await agent.allocateRoute({
    name: "node",
    command: "node other.js",
    cwd: "/workspace/other",
    requestedPort: 3000,
    host: "localhost",
    networkId: "network-b",
    scanRange: 2,
    scanDirection: "up",
    routingMode: "nearest",
  });

  assert.equal(allocation.actualPort, 3001);
});

test("allocates external routes without blocking on OS listener scans", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => {
        throw new Error("listener scan should stay out of the bind allocation path");
      },
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const allocation = await agent.allocateRoute({
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    scanRange: 2,
    scanDirection: "up",
    routingMode: "nearest",
  });

  assert.equal(allocation.actualPort, 8004);
  assert.equal(allocation.logicalRoutes[0]?.cwd, "/workspace/app");
});

test("reuses pending route allocations for sender-first and receiver-first ordering", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const senderAllocation = await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http://localhost:8004/healthz",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "::1",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });
  const receiverAllocation = await agent.allocateRoute({
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "listen",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  assert.equal(receiverAllocation.allocationId, senderAllocation.allocationId);
  assert.equal(receiverAllocation.actualPort, senderAllocation.actualPort);
  assert.equal(receiverAllocation.logicalRoutes.length, 1);
  assert.equal(receiverAllocation.logicalRoutes[0]?.actualPort, senderAllocation.actualPort);

  const firstReceiverAllocation = await agent.allocateRoute({
    name: "python3",
    command: "python manage.py runserver 8005",
    cwd: "/workspace/app",
    requestedPort: 8005,
    host: "127.0.0.1",
    networkId: "network-b",
    routeDirection: "listen",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });
  const laterSenderAllocation = await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http://localhost:8005/healthz",
    cwd: "/workspace/app",
    requestedPort: 8005,
    host: "127.0.0.1",
    networkId: "network-b",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  assert.equal(laterSenderAllocation.allocationId, firstReceiverAllocation.allocationId);
  assert.equal(laterSenderAllocation.actualPort, firstReceiverAllocation.actualPort);
});

test("allocates new routes on actualHost without breaking same-port send detection", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const checkedHosts: string[] = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async (port, host) => {
        checkedHosts.push(host ?? "");
        return { port, available: true };
      },
    },
    listeningPortProvider: {
      list: async () => [
        createListener({
          port: 8123,
          localAddress: "127.0.0.1",
          pid: 4567,
          processName: "node",
        }),
      ],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const actualHost = "127.80.10.20";
  const listenerAllocation = await agent.allocateRoute({
    name: "vite",
    command: "vite --host",
    cwd: "/workspace/app",
    requestedPort: 3004,
    host: "127.0.0.1",
    actualHost,
    networkId: "network-a",
    routeDirection: "listen",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  assert.equal(listenerAllocation.host, actualHost);
  assert.equal(listenerAllocation.logicalRoutes[0]?.host, actualHost);
  assert.deepEqual(checkedHosts, [actualHost]);

  const senderAllocation = await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http://localhost:8123",
    cwd: "/workspace/app",
    requestedPort: 8123,
    host: "127.0.0.1",
    actualHost,
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  assert.equal(senderAllocation.actualPort, 8123);
  assert.equal(senderAllocation.host, "127.0.0.1");
  assert.deepEqual(checkedHosts, [actualHost]);
});

test("uses same-port OS listeners for sender requests before creating a shadow route", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const listeners: readonly ListeningPort[] = [
    createListener({
      port: 8004,
      localAddress: "127.0.0.1",
      pid: 4321,
      processName: "python3",
      command: "python manage.py runserver 8004",
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async () => {
        throw new Error("same-port listener fallback should skip route allocation");
      },
    },
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const allocation = await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http-get://localhost:8004/healthz",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  assert.equal(allocation.allocationId, "");
  assert.equal(allocation.actualPort, 8004);
  assert.equal(allocation.host, "127.0.0.1");
  assert.equal(allocation.routed, false);
  assert.deepEqual(allocation.logicalRoutes, []);
});

test("keeps scoped sender reservations when same-port OS listeners are bound to unrelated hosts", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const checkedHosts: Array<string | undefined> = [];
  const listeners: readonly ListeningPort[] = [
    createListener({
      port: 8004,
      localAddress: "127.0.0.2",
      pid: 4321,
      processName: "python3",
      command: "python manage.py runserver 8004",
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async (port, host) => {
        checkedHosts.push(host);
        return {
          port,
          available: true,
        };
      },
    },
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const allocation = await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http-get://localhost:8004/healthz",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    actualHost: "127.81.154.127",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  assert.notEqual(allocation.allocationId, "");
  assert.equal(allocation.actualPort, 58000);
  assert.equal(allocation.host, "127.81.154.127");
  assert.deepEqual(checkedHosts, ["127.81.154.127"]);
});

test("promotes sender-first reservations into listener routes", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const senderAllocation = await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http://localhost:8004/healthz",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "::1",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });
  const pendingRouteEntry = readRouteTable(getRouteTablePathForLogicalPort(8004, "network-a", routeTablePath));

  assert.equal((pendingRouteEntry.routes[0] as { routeDirection?: string }).routeDirection, "send");

  const receiverAllocation = await agent.allocateRoute({
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "listen",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  assert.equal(receiverAllocation.allocationId, senderAllocation.allocationId);
  assert.equal(receiverAllocation.actualPort, senderAllocation.actualPort);

  await agent.registerExistingProcess({
    pid: 1234,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: receiverAllocation.actualPort,
    host: "127.0.0.1",
    networkId: "network-a",
    allocationId: receiverAllocation.allocationId,
    source: "hooked",
  });

  const routeEntryTable = readRouteTable(getRouteTablePathForLogicalPort(8004, "network-a", routeTablePath));

  assert.equal(routeEntryTable.routes.length, 1);
  assert.equal((routeEntryTable.routes[0] as { actualPort?: number }).actualPort, senderAllocation.actualPort);
  assert.equal((routeEntryTable.routes[0] as { host?: string }).host, "127.0.0.1");
  assert.equal((routeEntryTable.routes[0] as { routeDirection?: string }).routeDirection, "listen");
  assert.equal((routeEntryTable.routes[0] as { source?: string }).source, "hooked");
});

test("reuses active receiver routes instead of creating sender-side pending routes", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const checkedPorts: number[] = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async (port) => {
        checkedPorts.push(port);
        return {
          port,
          available: port !== 58000,
        };
      },
    },
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1234,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: 58000,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });

  const allocation = await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http://localhost:8004/healthz",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });
  const routeTable = readRouteTable(getNetworkRouteTablePath("network-a", routeTablePath));
  const routeEntryTable = readRouteTable(getRouteTablePathForLogicalPort(8004, "network-a", routeTablePath));

  assert.equal(allocation.allocationId, "");
  assert.equal(allocation.actualPort, 58000);
  assert.deepEqual(checkedPorts, []);
  assert.equal(routeTable.routes.length, 1);
  assert.equal((routeTable.routes[0] as { actualPort?: number }).actualPort, 58000);
  assert.equal((routeTable.routes[0] as { source?: string }).source, "hooked");
  assert.deepEqual(routeEntryTable.routes, routeTable.routes);
});

test("reuses active compose routes before allocating host fallback routes", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const checkedPorts: number[] = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async (port) => {
        checkedPorts.push(port);
        return {
          port,
          available: true,
        };
      },
    },
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 0,
    name: "workspace:postgres/postgresql",
    command: "docker compose service workspace/postgres",
    cwd: "/workspace/app",
    requestedPort: 15432,
    actualPort: 57001,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "compose",
  });

  const allocation = await agent.allocateRoute({
    name: "psql",
    command: "psql postgresql://localhost:15432/app",
    cwd: "/workspace/app",
    requestedPort: 15432,
    host: "127.0.0.1",
    actualHost: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 57000,
    virtualPortRangeEnd: 57010,
  });
  const routeTable = readRouteTable(getNetworkRouteTablePath("network-a", routeTablePath));
  const routeEntryTable = readRouteTable(getRouteTablePathForLogicalPort(15432, "network-a", routeTablePath));
  const logicalClaimTable = readRouteTable(getRouteTablePathForComposeClaimPort(15432, routeTablePath));
  const actualClaimTable = readRouteTable(getRouteTablePathForComposeClaimPort(57001, routeTablePath));
  const globalRouteTable = readRouteTable(routeTablePath);

  assert.equal(allocation.allocationId, "");
  assert.equal(allocation.actualPort, 57001);
  assert.equal(allocation.host, "127.0.0.1");
  assert.deepEqual(checkedPorts, []);
  assert.equal(globalRouteTable.routes.length, 1);
  assert.equal((globalRouteTable.routes[0] as { source?: string }).source, "compose");
  assert.equal(routeTable.routes.length, 1);
  assert.equal((routeTable.routes[0] as { source?: string }).source, "compose");
  assert.equal((routeTable.routes[0] as { host?: string }).host, "127.0.0.1");
  assert.equal((routeTable.routes[0] as { logicalPort?: number }).logicalPort, 15432);
  assert.equal((routeTable.routes[0] as { actualPort?: number }).actualPort, 57001);
  assert.deepEqual(routeEntryTable.routes, routeTable.routes);
  assert.deepEqual(logicalClaimTable.routes, routeTable.routes);
  assert.deepEqual(actualClaimTable.routes, routeTable.routes);
});

test("does not reuse active routes from a different actual host band", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const checkedHosts: Array<string | undefined> = [];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async (port, host) => {
        checkedHosts.push(host);
        return {
          port,
          available: true,
        };
      },
    },
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 0,
    name: "workspace:postgres/postgresql",
    command: "docker compose service workspace/postgres",
    cwd: "/workspace/app",
    requestedPort: 15432,
    actualPort: 57001,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "compose",
  });

  const allocation = await agent.allocateRoute({
    name: "psql",
    command: "psql postgresql://localhost:15432/app",
    cwd: "/workspace/app",
    requestedPort: 15432,
    host: "127.0.0.1",
    actualHost: "127.81.154.127",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 57000,
    virtualPortRangeEnd: 57010,
  });

  assert.notEqual(allocation.allocationId, "");
  assert.equal(allocation.host, "127.81.154.127");
  assert.deepEqual(checkedHosts, ["127.81.154.127"]);
});

test("does not reuse active listener routes for a new listener allocation", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.registerExistingProcess({
    pid: 1234,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: 58000,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });

  const allocation = await agent.allocateRoute({
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "listen",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58001,
  });

  assert.notEqual(allocation.allocationId, "");
  assert.equal(allocation.actualPort, 58001);
});

test("removes stale pending routes when a receiver registers without an allocation id", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const senderAllocation = await agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http://localhost:8004/healthz",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "::1",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58010,
  });

  await agent.registerExistingProcess({
    pid: 1234,
    name: "python3",
    command: "python manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: senderAllocation.actualPort,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });

  const released = await agent.releaseRouteAllocation(senderAllocation.allocationId);
  const routeTable = readRouteTable(getNetworkRouteTablePath("network-a", routeTablePath));
  const routeEntryTable = readRouteTable(getRouteTablePathForLogicalPort(8004, "network-a", routeTablePath));

  assert.equal(released, false);
  assert.equal(routeTable.routes.length, 1);
  assert.equal((routeTable.routes[0] as { actualPort?: number }).actualPort, senderAllocation.actualPort);
  assert.equal((routeTable.routes[0] as { host?: string }).host, "127.0.0.1");
  assert.equal((routeTable.routes[0] as { source?: string }).source, "hooked");
  assert.deepEqual(routeEntryTable.routes, routeTable.routes);
});

test("serializes receiver registration behind in-flight sender allocation", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const checkStarted = deferred<void>();
  const releaseCheck = deferred<void>();
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async (port) => {
        checkStarted.resolve();
        await releaseCheck.promise;
        return {
          port,
          available: true,
        };
      },
    },
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const senderAllocationPromise = agent.allocateRoute({
    name: "wait-on",
    command: "wait-on http://localhost:8004/healthz",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    networkId: "network-a",
    routeDirection: "send",
    scanRange: 20,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58000,
  });

  await checkStarted.promise;

  let receiverRegistered = false;
  const receiverRegistrationPromise = agent
    .registerExistingProcess({
      pid: 1234,
      name: "python3",
      command: "python manage.py runserver 8004",
      cwd: "/workspace/app",
      requestedPort: 8004,
      actualPort: 58000,
      host: "127.0.0.1",
      networkId: "network-a",
      source: "hooked",
    })
    .then((process) => {
      receiverRegistered = true;
      return process;
    });

  await waitOneTurn();
  assert.equal(receiverRegistered, false);

  releaseCheck.resolve();
  const [senderAllocation] = await Promise.all([senderAllocationPromise, receiverRegistrationPromise]);
  const routeTable = readRouteTable(getNetworkRouteTablePath("network-a", routeTablePath));

  assert.equal(senderAllocation.actualPort, 58000);
  assert.equal(routeTable.routes.length, 1);
  assert.equal((routeTable.routes[0] as { actualPort?: number }).actualPort, 58000);
  assert.equal((routeTable.routes[0] as { source?: string }).source, "hooked");
});

test("reserves OS listener ports even when availability probing reports them free", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const listeners: readonly ListeningPort[] = [
    createListener({
      id: "tcp:127.0.0.1:3000:4321",
      port: 3000,
      pid: 4321,
      processName: "Code Helper",
      command: "Code Helper",
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.refreshSnapshot();

  const allocation = await agent.allocateRoute({
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 3000,
    host: "127.0.0.1",
    networkId: "network-a",
    scanRange: 2,
    scanDirection: "up",
    routingMode: "nearest",
  });

  assert.equal(allocation.actualPort, 3001);
});

test("allows actual ports to be reused on distinct loopback hosts", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const checkedHosts: Array<string | undefined> = [];
  const listeners: readonly ListeningPort[] = [
    createListener({
      id: "tcp:127.80.10.20:58000:4321",
      localAddress: "127.80.10.20",
      port: 58000,
      pid: 4321,
      processName: "node",
      command: "node server.js",
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async (port, host) => {
        checkedHosts.push(host);
        return {
          port,
          available: true,
        };
      },
    },
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.refreshSnapshot();

  const allocation = await agent.allocateRoute({
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 8004,
    host: "127.0.0.1",
    actualHost: "127.81.154.127",
    networkId: "network-a",
    routeDirection: "listen",
    scanRange: 0,
    scanDirection: "up",
    routingMode: "hashed",
    virtualPortRangeStart: 58000,
    virtualPortRangeEnd: 58000,
  });

  assert.equal(allocation.actualPort, 58000);
  assert.equal(allocation.host, "127.81.154.127");
  assert.deepEqual(checkedHosts, ["127.81.154.127"]);
});

test("treats wildcard listener ports as reserved for generated loopback hosts", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const checkedPorts: number[] = [];
  const listeners: readonly ListeningPort[] = [
    createListener({
      id: "tcp:0.0.0.0:58000:4321",
      localAddress: "0.0.0.0",
      port: 58000,
      pid: 4321,
      processName: "node",
      command: "node server.js",
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: {
      check: async (port) => {
        checkedPorts.push(port);
        return {
          port,
          available: true,
        };
      },
    },
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  await agent.refreshSnapshot();

  const allocation = await agent.allocateRoute({
    name: "node",
    command: "node server.js",
    cwd: "/workspace/app",
    requestedPort: 58000,
    host: "127.0.0.1",
    actualHost: "127.81.154.127",
    networkId: "network-a",
    routeDirection: "listen",
    scanRange: 1,
    scanDirection: "up",
    routingMode: "nearest",
  });

  assert.equal(allocation.actualPort, 58001);
  assert.equal(allocation.host, "127.81.154.127");
  assert.deepEqual(checkedPorts, [58001]);
});

test("coalesces concurrent listener snapshot scans", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const scanStarted = deferred<void>();
  const releaseScan = deferred<void>();
  let scanCount = 0;
  const listeners: readonly ListeningPort[] = [
    createListener({
      port: 3000,
      pid: 4321,
      processName: "node",
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => {
        scanCount += 1;
        scanStarted.resolve();
        await releaseScan.promise;
        return listeners;
      },
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const firstSnapshot = agent.refreshSnapshot();
  const secondSnapshot = agent.listSnapshot();
  const backgroundPoll = runListenerPoll(agent);

  await scanStarted.promise;
  await waitOneTurn();

  assert.equal(scanCount, 1);

  releaseScan.resolve();
  const [first, second] = await Promise.all([firstSnapshot, secondSnapshot, backgroundPoll.then(() => undefined)]);

  assert.equal(scanCount, 1);
  assert.equal(first.listeners[0]?.port, 3000);
  assert.equal(second.listeners[0]?.port, 3000);
});

test("listSnapshot does not publish route tables when route state is unchanged", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => agent.dispose());

  const initialSequence = readRouteTableWriterSequence(agent);

  await agent.listSnapshot();
  await agent.listSnapshot();

  assert.equal(readRouteTableWriterSequence(agent), initialSequence);
});

test("skips extension socket snapshot broadcasts for unchanged refresh requests", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const socketPath = path.join(os.tmpdir(), `portmanager-agent-socket-${process.pid}-${Date.now()}.sock`);
  const listeners: readonly ListeningPort[] = [
    createListener({
      id: "tcp:127.0.0.1:3000:4321",
      port: 3000,
      pid: 4321,
      processName: "node",
    }),
  ];
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => listeners,
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => {
    agent.dispose();
    fs.rmSync(socketPath, { force: true });
  });

  if (!(await listenAgentOrSkip(context, agent, socketPath))) {
    return;
  }
  const socket = await openAgentSocket(socketPath);
  const messages = collectAgentMessages(socket);
  context.after(() => socket.destroy());

  socket.write(encodeAgentMessage({ id: "extension-first-refresh", method: "refreshSnapshot" }));
  await waitForAgentMessage(messages, (message) => isResponseForRequest(message, "extension-first-refresh"));
  await waitForAgentMessage(messages, isSnapshotEvent);
  assert.equal(messages.filter(isSnapshotEvent).length, 1);

  await delay(80);
  messages.splice(0, messages.length);
  socket.write(encodeAgentMessage({ id: "extension-second-refresh", method: "refreshSnapshot" }));
  await waitForAgentMessage(messages, (message) => isResponseForRequest(message, "extension-second-refresh"));
  await delay(80);

  assert.equal(messages.filter(isSnapshotEvent).length, 0);
});

test("keeps hook sockets out of snapshot event fan-out", async (context) => {
  const routeTablePath = createRouteTablePath(context);
  const socketPath = path.join(os.tmpdir(), `portmanager-agent-hook-socket-${process.pid}-${Date.now()}.sock`);
  const agent = new PortManagerAgent({
    processLauncher: createFakeLauncher(),
    portAvailabilityProvider: createAvailablePortProvider(),
    listeningPortProvider: {
      list: async () => [
        createListener({
          id: "tcp:127.0.0.1:3000:4321",
          port: 3000,
          pid: 4321,
          processName: "node",
        }),
      ],
    },
    agentPid: 777,
    now: fixedNow,
    routeTablePath,
  });
  context.after(() => {
    agent.dispose();
    fs.rmSync(socketPath, { force: true });
  });

  if (!(await listenAgentOrSkip(context, agent, socketPath))) {
    return;
  }
  const socket = await openAgentSocket(socketPath);
  const messages = collectAgentMessages(socket);
  context.after(() => socket.destroy());

  socket.write(encodeAgentMessage({ id: "hook-refresh", method: "refreshSnapshot" }));
  await waitForAgentMessage(messages, (message) => isResponseForRequest(message, "hook-refresh"));
  await delay(80);

  assert.equal(messages.filter(isSnapshotEvent).length, 0);
});

function createFakeLauncher(): ProcessLauncher {
  return {
    launch: async () => ({ pid: 1234, command: "node server.js" }),
    stop: async () => undefined,
    onExit: () => ({ dispose: () => undefined }),
  };
}

function createAvailablePortProvider(): PortAvailabilityProvider {
  return {
    check: async (port) => ({
      port,
      available: true,
    }),
  };
}

function createListener(overrides: Partial<ListeningPort> = {}): ListeningPort {
  return {
    id: "tcp:127.0.0.1:58000:1234",
    protocol: "tcp",
    localAddress: "127.0.0.1",
    port: 58000,
    pid: 1234,
    processName: "node",
    command: "node server.js",
    source: "external",
    updatedAt: fixedUpdatedAt,
    ...overrides,
  };
}

async function runListenerPoll(agent: PortManagerAgent): Promise<void> {
  await (agent as unknown as { pollListeningPorts(): Promise<void> }).pollListeningPorts();
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T | PromiseLike<T>) => void } {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

async function waitOneTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function openAgentSocket(socketPath: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function listenAgentOrSkip(context: TestContext, agent: PortManagerAgent, socketPath: string): Promise<boolean> {
  try {
    await agent.listen(socketPath);
    return true;
  } catch (error) {
    if (isUnixSocketBindBlocked(error)) {
      context.skip("agent socket bind is not permitted in this sandbox");
      return false;
    }

    throw error;
  }
}

function collectAgentMessages(socket: net.Socket): unknown[] {
  const messages: unknown[] = [];
  const buffer = new NdjsonMessageBuffer();

  socket.on("data", (chunk) => {
    messages.push(...buffer.push(chunk));
  });

  return messages;
}

async function waitForAgentMessage(
  messages: readonly unknown[],
  predicate: (message: unknown) => boolean,
): Promise<unknown> {
  const deadlineMs = Date.now() + 1_000;

  while (Date.now() < deadlineMs) {
    const message = messages.find(predicate);
    if (message !== undefined) {
      return message;
    }

    await delay(10);
  }

  throw new Error("Timed out waiting for Port Manager agent protocol message.");
}

function isResponseForRequest(message: unknown, id: string): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "response" &&
    (message as { id?: unknown }).id === id
  );
}

function isSnapshotEvent(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "snapshot";
}

function isUnixSocketBindBlocked(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "EPERM" || (error as { code?: unknown }).code === "EACCES")
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readRouteTable(routeTablePath: string): {
  readonly expiresAt?: string;
  readonly expiresAtMs?: number;
  readonly ttlMs?: number;
  readonly generation?: unknown;
  readonly routes: readonly unknown[];
} {
  return JSON.parse(fs.readFileSync(routeTablePath, "utf8")) as {
    readonly expiresAt?: string;
    readonly expiresAtMs?: number;
    readonly ttlMs?: number;
    readonly generation?: unknown;
    readonly routes: readonly unknown[];
  };
}

function readRouteTableGeneration(routeTablePath: string): { readonly writerId?: string } | undefined {
  return (JSON.parse(fs.readFileSync(routeTablePath, "utf8")) as { generation?: { readonly writerId?: string } }).generation;
}

function readRouteTableWriterSequence(agent: PortManagerAgent): number {
  return (agent as unknown as { readonly routeTableGenerationSequence: number }).routeTableGenerationSequence;
}

function createRouteTablePath(context: TestContext): string {
  const routeTablePath = path.join(os.tmpdir(), `portmanager-agent-test-${process.pid}-${Date.now()}.json`);
  context.after(() => {
    fs.rmSync(routeTablePath, { force: true });
    const parsedPath = path.parse(routeTablePath);
    for (const fileName of fs.readdirSync(parsedPath.dir)) {
      if (fileName.startsWith(`${parsedPath.name}-`) && fileName.endsWith(parsedPath.ext)) {
        fs.rmSync(path.join(parsedPath.dir, fileName), { force: true });
      }
    }
  });

  return routeTablePath;
}

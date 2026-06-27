import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { PortManagerAgent } from "../../src/agent/port-manager-agent";
import { getNetworkRouteTablePath, getRouteTablePathForLogicalPort } from "../../src/agent/route-table";
import type { ListeningPort, PortAvailabilityProvider, ProcessLauncher } from "../../src/shared/types";

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
  assert.deepEqual(readRouteTable(getNetworkRouteTablePath("network-a", routeTablePath)).routes, snapshot.routes);
  assert.deepEqual(readRouteTable(getRouteTablePathForLogicalPort(8000, "network-a", routeTablePath)).routes, snapshot.routes);

  listeners = [];
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

  nowMs += 30_001;
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
  const globalRouteTable = readRouteTable(routeTablePath);

  assert.equal(allocation.allocationId, "");
  assert.equal(allocation.actualPort, 57001);
  assert.deepEqual(checkedPorts, []);
  assert.equal(globalRouteTable.routes.length, 1);
  assert.equal((globalRouteTable.routes[0] as { source?: string }).source, "compose");
  assert.equal(routeTable.routes.length, 1);
  assert.equal((routeTable.routes[0] as { source?: string }).source, "compose");
  assert.equal((routeTable.routes[0] as { logicalPort?: number }).logicalPort, 15432);
  assert.equal((routeTable.routes[0] as { actualPort?: number }).actualPort, 57001);
  assert.deepEqual(routeEntryTable.routes, routeTable.routes);
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

function readRouteTable(routeTablePath: string): { routes: readonly unknown[] } {
  return JSON.parse(fs.readFileSync(routeTablePath, "utf8")) as { routes: readonly unknown[] };
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

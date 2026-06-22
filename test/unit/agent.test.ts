import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { PortManagerAgent } from "../../src/agent/port-manager-agent";
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
      host: "localhost",
      networkId: "network-a",
      processId: process.id,
      processName: "node",
      status: "running",
      source: "hooked",
    },
  ]);

  listeners = [];
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
      host: "127.0.0.1",
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

function readRouteTable(routeTablePath: string): { routes: readonly unknown[] } {
  return JSON.parse(fs.readFileSync(routeTablePath, "utf8")) as { routes: readonly unknown[] };
}

function createRouteTablePath(context: TestContext): string {
  const routeTablePath = path.join(os.tmpdir(), `portmanager-agent-test-${process.pid}-${Date.now()}.json`);
  context.after(() => {
    fs.rmSync(routeTablePath, { force: true });
  });

  return routeTablePath;
}

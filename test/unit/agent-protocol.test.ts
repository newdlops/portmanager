import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentSnapshot } from "../../src/agent/port-manager-agent";
import {
  decodeAgentMessage,
  encodeAgentMessage,
  isAgentRequestMessage,
  NdjsonMessageBuffer,
} from "../../src/agent/protocol";
import type { ListeningPort, ManagedProcess } from "../../src/shared/types";

/**
 * Unit tests for agent protocol framing and snapshot merging.
 *
 * These tests avoid real sockets and child processes. The protocol buffer is
 * fed synthetic chunks, and the snapshot merge uses fixed registry/listener
 * rows to verify de-duplication of routed managed processes.
 */

const fixedUpdatedAt = "2026-06-21T09:30:00.000Z";

test("encodes and decodes one NDJSON protocol frame", () => {
  const message = {
    id: "request-1",
    method: "listSnapshot",
  } as const;

  const encoded = encodeAgentMessage(message);
  const decoded = decodeAgentMessage(encoded);

  assert.equal(encoded.endsWith("\n"), true);
  assert.deepEqual(decoded, message);
  assert.equal(isAgentRequestMessage(decoded), true);
});

test("buffers partial NDJSON chunks until a complete frame is available", () => {
  const buffer = new NdjsonMessageBuffer();
  const firstMessage = encodeAgentMessage({ id: 1, method: "listSnapshot" });
  const secondMessage = encodeAgentMessage({ id: 2, method: "refreshSnapshot" });

  assert.deepEqual(buffer.push(firstMessage.slice(0, 8)), []);

  const decodedMessages = buffer.push(`${firstMessage.slice(8)}${secondMessage}`);

  assert.equal(decodedMessages.length, 2);
  assert.deepEqual(decodedMessages[0], { id: 1, method: "listSnapshot" });
  assert.deepEqual(decodedMessages[1], { id: 2, method: "refreshSnapshot" });
});

test("recognizes external route allocation request methods", () => {
  const allocateMessage = {
    id: "request-allocate",
    method: "allocateRoute",
    payload: {
      cwd: "/workspace/app",
      requestedPort: 8000,
      host: "localhost",
      scanRange: 20,
      scanDirection: "up",
      routingMode: "hashed",
    },
  } as const;
  const releaseMessage = {
    id: "request-release",
    method: "releaseRouteAllocation",
    payload: {
      allocationId: "allocation:test",
    },
  } as const;
  const releaseProcessRouteMessage = {
    id: "request-release-process-route",
    method: "releaseProcessRoute",
    payload: {
      pid: 1234,
      allocationId: "allocation:test",
      requestedPort: 8000,
      actualPort: 58000,
      networkId: "network-a",
    },
  } as const;
  const shutdownMessage = {
    id: "request-shutdown",
    method: "shutdownDaemon",
  } as const;
  const daemonStatusMessage = {
    id: "request-daemon-status",
    method: "daemonStatus",
  } as const;

  assert.equal(isAgentRequestMessage(allocateMessage), true);
  assert.equal(isAgentRequestMessage(releaseMessage), true);
  assert.equal(isAgentRequestMessage(releaseProcessRouteMessage), true);
  assert.equal(isAgentRequestMessage(shutdownMessage), true);
  assert.equal(isAgentRequestMessage(daemonStatusMessage), true);
});

test("recognizes the explicit routing repair request", () => {
  assert.equal(isAgentRequestMessage({ id: "repair-1", method: "repairRoutingState" }), true);
  assert.equal(isAgentRequestMessage({ id: "flush-1", method: "flushRouteTables" }), true);
});

test("snapshot merge keeps managed route context and adds external listeners", () => {
  const managedProcess = createManagedProcess({
    id: "managed-1",
    pid: 42,
    requestedPort: 3000,
    actualPort: 3001,
    source: "managed",
  });
  const listeners: ListeningPort[] = [
    createListener({
      id: "tcp:127.0.0.1:3001:42",
      port: 3001,
      pid: 42,
      processName: "node",
    }),
    createListener({
      id: "tcp:0.0.0.0:5173:99",
      localAddress: "0.0.0.0",
      port: 5173,
      pid: 99,
      processName: "vite",
      command: "npm run dev",
    }),
  ];

  const snapshot = buildAgentSnapshot({
    agentPid: 777,
    registryProcesses: [managedProcess],
    listeners,
    updatedAt: fixedUpdatedAt,
    agentMainPath: "/extension/out/src/agent/agent-main.js",
    agentVersion: "0.0.test",
    defaultHost: "localhost",
    defaultCwd: "/workspace/app",
  });

  assert.equal(snapshot.agentPid, 777);
  assert.equal(snapshot.updatedAt, fixedUpdatedAt);
  assert.equal(snapshot.daemon.status, "running");
  assert.equal(snapshot.daemon.pid, 777);
  assert.equal(snapshot.daemon.agentMainPath, "/extension/out/src/agent/agent-main.js");
  assert.equal(snapshot.daemon.version, "0.0.test");
  assert.equal(snapshot.daemon.listenerCount, 2);
  assert.equal(snapshot.daemon.routeCount, 1);
  assert.equal(snapshot.processes.length, 2);
  assert.equal(snapshot.processes[0]?.id, "managed-1");
  assert.equal(snapshot.processes[0]?.requestedPort, 3000);
  assert.equal(snapshot.processes[0]?.actualPort, 3001);
  assert.equal(snapshot.processes[1]?.id, "detected:tcp:0.0.0.0:5173:99");
  assert.equal(snapshot.processes[1]?.source, "detected");
  assert.equal(snapshot.processes[1]?.url, "http://localhost:5173");
  assert.equal(snapshot.listeners[0]?.source, "managed");
  assert.equal(snapshot.listeners[1]?.source, "external");
  assert.deepEqual(snapshot.routes, [
    {
      logicalPort: 3000,
      actualPort: 3001,
      routeDirection: "listen",
      host: "localhost",
      cwd: "/workspace/app",
      processId: "managed-1",
      processName: "web",
      status: "running",
      source: "managed",
    },
  ]);
});

test("snapshot merge includes pending external route allocations", () => {
  const snapshot = buildAgentSnapshot({
    agentPid: 777,
    registryProcesses: [],
    pendingRoutes: [
      {
        logicalPort: 8000,
        actualPort: 58000,
        host: "localhost",
        processName: "external-cli",
        status: "starting",
        source: "allocated",
      },
    ],
    listeners: [],
    updatedAt: fixedUpdatedAt,
  });

  assert.equal(snapshot.daemon.routeCount, 1);
  assert.deepEqual(snapshot.routes, [
    {
      logicalPort: 8000,
      actualPort: 58000,
      routeDirection: "listen",
      host: "localhost",
      processName: "external-cli",
      status: "starting",
      source: "allocated",
    },
  ]);
});

test("snapshot merge can suppress detected listener rows", () => {
  const listener = createListener({
    id: "tcp:127.0.0.1:8080:88",
    port: 8080,
    pid: 88,
  });

  const snapshot = buildAgentSnapshot({
    agentPid: 777,
    registryProcesses: [],
    listeners: [listener],
    updatedAt: fixedUpdatedAt,
    suppressedDetectedProcessIds: new Set(["detected:tcp:127.0.0.1:8080:88"]),
  });

  assert.deepEqual(snapshot.processes, []);
  assert.equal(snapshot.listeners.length, 1);
  assert.deepEqual(snapshot.routes, []);
});

function createManagedProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
  return {
    id: "managed-1",
    pid: 42,
    name: "web",
    command: "npm run dev",
    cwd: "/workspace/app",
    requestedPort: 3000,
    actualPort: 3001,
    status: "running",
    startedAt: fixedUpdatedAt,
    url: "http://localhost:3001",
    source: "managed",
    ...overrides,
  };
}

function createListener(overrides: Partial<ListeningPort> = {}): ListeningPort {
  return {
    id: "tcp:127.0.0.1:3000:42",
    protocol: "tcp",
    localAddress: "127.0.0.1",
    port: 3000,
    pid: 42,
    processName: "node",
    command: "node server.js",
    source: "external",
    updatedAt: fixedUpdatedAt,
    ...overrides,
  };
}

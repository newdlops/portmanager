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
    defaultHost: "localhost",
    defaultCwd: "/workspace/app",
  });

  assert.equal(snapshot.agentPid, 777);
  assert.equal(snapshot.updatedAt, fixedUpdatedAt);
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
      host: "localhost",
      processId: "managed-1",
      processName: "web",
      status: "running",
      source: "managed",
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

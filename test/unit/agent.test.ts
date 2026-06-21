import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { PortManagerAgent } from "../../src/agent/port-manager-agent";
import type { ListeningPort, ProcessLauncher } from "../../src/shared/types";

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

test("marks hooked process rows stopped when their OS listener disappears", async (context) => {
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
  const snapshot = await agent.listSnapshot();

  assert.equal(snapshot.processes[0]?.source, "hooked");
  assert.equal(snapshot.processes[0]?.status, "stopped");
  assert.deepEqual(snapshot.routes, []);
});

function createFakeLauncher(): ProcessLauncher {
  return {
    launch: async () => ({ pid: 1234, command: "node server.js" }),
    stop: async () => undefined,
    onExit: () => ({ dispose: () => undefined }),
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

function createRouteTablePath(context: TestContext): string {
  const routeTablePath = path.join(os.tmpdir(), `portmanager-agent-test-${process.pid}-${Date.now()}.json`);
  context.after(() => {
    fs.rmSync(routeTablePath, { force: true });
  });

  return routeTablePath;
}

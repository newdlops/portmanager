import assert from "node:assert/strict";
import test from "node:test";

import {
  ManagedProcessRegistry,
  type ManagedProcessRegistryEvent,
  type ManagedProcessUpdate,
} from "../../src/core/process-registry";
import type { ManagedProcess } from "../../src/shared/types";

/**
 * Unit tests for the in-memory process registry.
 *
 * The registry is tested without platform process control; lifecycle changes
 * are represented as domain state transitions and emitted snapshots.
 */

const fixedStartedAt = "2026-06-21T09:00:00.000Z";
const fixedStoppedAt = "2026-06-21T09:05:00.000Z";

function createProcess(overrides: Partial<ManagedProcess> = {}): ManagedProcess {
  return {
    id: "process-1",
    pid: 101,
    name: "web",
    command: "npm run dev",
    cwd: "/workspace/app",
    requestedPort: 3000,
    actualPort: 3001,
    status: "running",
    startedAt: fixedStartedAt,
    url: "http://localhost:3001",
    ...overrides,
  };
}

test("adds and returns managed process records without sharing mutable objects", () => {
  const registry = new ManagedProcessRegistry();
  const process = createProcess();
  const events: ManagedProcessRegistryEvent[] = [];
  registry.onDidChange((event) => events.push(event));

  const added = registry.add(process);
  (process as { name: string }).name = "mutated-after-add";

  assert.equal(added.requestedPort, 3000);
  assert.equal(added.actualPort, 3001);
  assert.equal(registry.get("process-1")?.name, "web");
  assert.deepEqual(
    registry.list().map((item) => item.id),
    ["process-1"],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "added");
  assert.equal(events[0]?.process.id, "process-1");
});

test("registers external processes with generated ids and routed URLs", () => {
  const registry = new ManagedProcessRegistry({
    now: () => new Date(fixedStartedAt),
    idFactory: () => "external-1",
  });

  const registered = registry.register({
    pid: 202,
    name: "vite",
    command: "npm run dev",
    cwd: "/workspace/app",
    requestedPort: 3000,
    actualPort: 3002,
    host: "127.0.0.1",
  });

  assert.equal(registered.id, "external-1");
  assert.equal(registered.status, "running");
  assert.equal(registered.startedAt, fixedStartedAt);
  assert.equal(registered.requestedPort, 3000);
  assert.equal(registered.actualPort, 3002);
  assert.equal(registered.url, "http://127.0.0.1:3002");
});

test("updates mutable process fields while preserving the requested port", () => {
  const registry = new ManagedProcessRegistry();
  registry.add(createProcess());

  const patch = {
    actualPort: 3002,
    status: "error",
    errorMessage: "launch failed",
    requestedPort: 4000,
  } as ManagedProcessUpdate;

  const updated = registry.update("process-1", patch);

  assert.equal(updated.requestedPort, 3000);
  assert.equal(updated.actualPort, 3002);
  assert.equal(updated.status, "error");
  assert.equal(updated.errorMessage, "launch failed");
});

test("emits update events with previous process state", () => {
  const registry = new ManagedProcessRegistry();
  const events: ManagedProcessRegistryEvent[] = [];
  registry.onDidChange((event) => events.push(event));
  registry.add(createProcess());

  registry.update("process-1", { status: "starting" });

  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "updated");
  assert.equal(events[1]?.previousProcess?.status, "running");
  assert.equal(events[1]?.process.status, "starting");
});

test("marks processes as stopped without keeping a live routed URL", () => {
  const registry = new ManagedProcessRegistry({
    now: () => new Date(fixedStoppedAt),
  });
  registry.add(createProcess());

  const stopped = registry.stop("process-1");

  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.stoppedAt, fixedStoppedAt);
  assert.equal(stopped.requestedPort, 3000);
  assert.equal(stopped.actualPort, 3001);
  assert.equal(stopped.url, undefined);
});

test("removes processes and emits the post-removal snapshot", () => {
  const registry = new ManagedProcessRegistry();
  const events: ManagedProcessRegistryEvent[] = [];
  registry.onDidChange((event) => events.push(event));
  registry.add(createProcess());

  const removed = registry.remove("process-1");

  assert.equal(removed?.id, "process-1");
  assert.equal(registry.get("process-1"), undefined);
  assert.deepEqual(registry.list(), []);
  assert.equal(events.at(-1)?.type, "removed");
  assert.deepEqual(events.at(-1)?.processes, []);
});

test("throws clear errors for duplicate adds and missing updates", () => {
  const registry = new ManagedProcessRegistry();
  registry.add(createProcess());

  assert.throws(() => registry.add(createProcess()), /already registered/);
  assert.throws(() => registry.update("missing", { status: "stopped" }), /not registered/);
  assert.throws(() => registry.stop("missing"), /not registered/);
});

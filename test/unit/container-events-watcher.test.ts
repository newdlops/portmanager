import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess, spawn } from "node:child_process";

import {
  ContainerEventsWatcher,
  chunkContainsRoutingRelevantEvent,
  type ContainerRuntimeChange,
} from "../../src/platform/network/container-events-watcher";
import type { ContainerRuntimeSettings } from "../../src/shared/types";

const settings: ContainerRuntimeSettings = {
  containerRuntime: "auto",
  containerImage: "alpine:3.20",
};

class FakeEventsProcess extends EventEmitter {
  readonly stdout = new (class extends EventEmitter {
    setEncoding(): void {
      // The watcher only needs utf8 chunks; the fake emits strings directly.
    }
  })();

  exitCode: number | null = null;

  killed = false;

  killedSignals: string[] = [];

  kill(signal?: string): boolean {
    this.killed = true;
    this.killedSignals.push(signal ?? "SIGTERM");
    return true;
  }

  emitStdout(chunk: string): void {
    this.stdout.emit("data", chunk);
  }

  emitExit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

interface SpawnRecord {
  readonly executable: string;
  readonly args: readonly string[];
  readonly child: FakeEventsProcess;
}

function createFakeSpawner(options: { readonly failFor?: readonly string[] } = {}): {
  readonly spawnProcess: typeof spawn;
  readonly records: SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  const spawnProcess = ((executable: string, args: readonly string[]) => {
    if (options.failFor?.includes(executable) === true) {
      throw new Error(`spawn ${executable} ENOENT`);
    }

    const child = new FakeEventsProcess();
    records.push({ executable, args, child });
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;

  return { spawnProcess, records };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("routing-relevant event parsing accepts lifecycle actions and rejects noise", () => {
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Action":"start"}\n'), true);
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Action":"die"}\n'), true);
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"network","Action":"connect"}\n'), true);
  assert.equal(chunkContainsRoutingRelevantEvent('{"type":"container","action":"stop"}\n'), true);
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","status":"restart"}\n'), true);
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Status":"died"}\n'), true);

  // Health checks and exec probes fire constantly on busy containers and must
  // not wake the reconcile loop.
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Action":"exec_create: sh"}\n'), false);
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Action":"exec_start: sh"}\n'), false);
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Action":"health_status: healthy"}\n'), false);
  assert.equal(chunkContainsRoutingRelevantEvent("not json\n"), false);
  assert.equal(chunkContainsRoutingRelevantEvent(""), false);
});

/** Lets async watcher callbacks settle while timer progression remains deterministic. */
async function settleNotifications(): Promise<void> {
  for (let step = 0; step < 8; step++) {
    await Promise.resolve();
  }
}

test("slow event reconciliation gets one trailing batch with unique Compose projects", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { spawnProcess, records } = createFakeSpawner();
  const batches: (readonly ContainerRuntimeChange[])[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings, spawnProcess,
    onEvent: async (changes) => { batches.push(changes); if (batches.length === 1) { await pending; } },
  });
  context.after(() => watcher.dispose());
  watcher.start();
  const child = records[0].child;
  const event = (project: string) => child.emitStdout(JSON.stringify({
    Type: "container", Action: "start", Actor: { Attributes: { "com.docker.compose.project": project } },
  }) + "\n");
  event("alpha");
  context.mock.timers.tick(500);
  assert.equal(batches.length, 1);
  for (let index = 0; index < 100; index++) { event("beta"); event("gamma"); }
  context.mock.timers.tick(5000);
  assert.equal(batches.length, 1, "a slow refresh must not start overlapping Docker work");
  release();
  await settleNotifications();
  context.mock.timers.tick(500);
  await settleNotifications();
  assert.deepEqual(batches, [
    [{ runtime: "docker", composeProject: "alpha" }],
    [{ runtime: "docker", composeProject: "beta" }, { runtime: "docker", composeProject: "gamma" }],
  ]);
  assert.equal(watcher.getRuntime(), "docker");
});

test("failed callbacks preserve trailing events and dispose cancels pending work", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { spawnProcess, records } = createFakeSpawner();
  let calls = 0;
  let fail!: (reason: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings, spawnProcess,
    onEvent: () => { calls++; return calls === 1 ? pending : undefined; },
  });
  context.after(() => watcher.dispose());
  watcher.start();
  const child = records[0].child;
  child.emitStdout('{"Action":"start"}\n');
  context.mock.timers.tick(500);
  child.emitStdout('{"Action":"stop"}\n');
  fail(new Error("daemon unavailable"));
  await settleNotifications();
  context.mock.timers.tick(500);
  await settleNotifications();
  assert.equal(calls, 2);
  child.emitStdout('{"Action":"start"}\n');
  watcher.dispose();
  context.mock.timers.tick(5000);
  assert.equal(calls, 2);
  assert.equal(watcher.getRuntime(), undefined);
});

test("unlabelled events conservatively cover all projects and Podman project labels are retained", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { spawnProcess, records } = createFakeSpawner();
  const batches: (readonly ContainerRuntimeChange[])[] = [];
  const watcher = new ContainerEventsWatcher({
    readSettings: () => ({ ...settings, containerRuntime: "podman" }), spawnProcess,
    onEvent: (changes) => { batches.push(changes); },
  });
  context.after(() => watcher.dispose());
  watcher.start();
  const child = records[0].child;
  child.emitStdout('{"Status":"died","Attributes":{"io.podman.compose.project":"alpha"}}\n');
  context.mock.timers.tick(500);
  await settleNotifications();
  assert.deepEqual(batches[0], [{ runtime: "podman", composeProject: "alpha" }]);
  child.emitStdout('{"Status":"start","Attributes":{"io.podman.compose.project":"alpha"}}\n');
  child.emitStdout('{"Status":"connect"}\n');
  child.emitStdout('{"Status":"stop","Attributes":{"io.podman.compose.project":"beta"}}\n');
  context.mock.timers.tick(500);
  await settleNotifications();
  assert.deepEqual(batches[1], [{ runtime: "podman" }]);
});

test("a recovered silent event stream immediately requests a catch-up snapshot", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { spawnProcess, records } = createFakeSpawner();
  const batches: (readonly ContainerRuntimeChange[])[] = [];
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings, spawnProcess, onEvent: (changes) => { batches.push(changes); },
  });
  context.after(() => watcher.dispose());
  watcher.start();
  context.mock.timers.tick(1000);
  assert.equal(watcher.getRuntime(), "docker");
  assert.equal(batches.length, 0);
  records[0].child.emitExit(1);
  assert.equal(watcher.getRuntime(), undefined);
  context.mock.timers.tick(30000);
  assert.equal(records.length, 2);
  context.mock.timers.tick(1000);
  context.mock.timers.tick(500);
  await settleNotifications();
  assert.deepEqual(batches, [[{ runtime: "docker" }]]);
});

test("network events borrow Compose identity from container events in the same batch", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const { spawnProcess, records } = createFakeSpawner();
  const batches: (readonly ContainerRuntimeChange[])[] = [];
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings, spawnProcess, onEvent: (changes) => { batches.push(changes); },
  });
  context.after(() => watcher.dispose());
  watcher.start();
  const child = records[0].child;
  child.emitStdout('{"Type":"network","Action":"connect","Actor":{"ID":"network-id","Attributes":{"container":"container-id"}}}\n');
  child.emitStdout('{"Type":"container","Action":"start","Actor":{"ID":"container-id","Attributes":{"com.docker.compose.project":"alpha"}}}\n');
  context.mock.timers.tick(500);
  await settleNotifications();
  assert.deepEqual(batches, [[{ runtime: "docker", composeProject: "alpha" }]]);
  child.emitStdout('{"Type":"network","Action":"disconnect","Actor":{"ID":"network-id","Attributes":{"container":"container-id"}}}\n');
  context.mock.timers.tick(500);
  await settleNotifications();
  assert.deepEqual(batches[1], [{ runtime: "docker", containerId: "container-id" }]);
});

test("events watcher filters Docker events before delivery without excluding routing actions", () => {
  const { spawnProcess, records } = createFakeSpawner();
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings,
    onEvent: () => undefined,
    spawnProcess,
  });

  watcher.start();
  assert.equal(records.length, 1);
  assert.equal(records[0].executable, "docker");
  assert.deepEqual(records[0].args, [
    "events",
    "--format",
    "{{json .}}",
    "--filter",
    "type=container",
    "--filter",
    "type=network",
    ...[
      "create", "start", "restart", "stop", "kill", "die", "destroy", "remove",
      "rename", "update", "pause", "unpause", "connect", "disconnect",
    ].flatMap((action) => ["--filter", `event=${action}`]),
  ]);

  watcher.dispose();
  assert.equal(records[0].child.killed, true);
});

test("events watcher falls back to podman when docker cannot spawn", () => {
  const { spawnProcess, records } = createFakeSpawner({ failFor: ["docker"] });
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings,
    onEvent: () => undefined,
    spawnProcess,
  });

  watcher.start();
  assert.equal(records.length, 1);
  assert.equal(records[0].executable, "podman");
  assert.equal(records[0].args.some((arg) => arg.startsWith("event=")), false);
  watcher.dispose();
});

test("events watcher debounces a burst of lifecycle events into one notification", async () => {
  const { spawnProcess, records } = createFakeSpawner();
  let eventCount = 0;
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings,
    onEvent: () => {
      eventCount += 1;
    },
    spawnProcess,
  });

  watcher.start();
  const child = records[0].child;
  child.emitStdout('{"Type":"container","Action":"die"}\n');
  child.emitStdout('{"Type":"container","Action":"start"}\n');
  child.emitStdout('{"Type":"container","Action":"start"}\n');
  assert.equal(watcher.isHealthy(), true);
  assert.equal(eventCount, 0);

  await delay(1000);
  assert.equal(eventCount, 1);
  watcher.dispose();
});

test("events watcher buffers partial lines across stream chunks", async () => {
  const { spawnProcess, records } = createFakeSpawner();
  let eventCount = 0;
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings,
    onEvent: () => {
      eventCount += 1;
    },
    spawnProcess,
  });

  watcher.start();
  const child = records[0].child;
  child.emitStdout('{"Type":"container","Ac');
  child.emitStdout('tion":"start"}\n');

  await delay(1000);
  assert.equal(eventCount, 1);
  watcher.dispose();
});

test("events watcher reports unhealthy after the stream exits and ignores noise events", async () => {
  const { spawnProcess, records } = createFakeSpawner();
  let eventCount = 0;
  const watcher = new ContainerEventsWatcher({
    readSettings: () => settings,
    onEvent: () => {
      eventCount += 1;
    },
    spawnProcess,
  });

  watcher.start();
  const child = records[0].child;
  child.emitStdout('{"Type":"container","Action":"exec_create: curl localhost"}\n');
  child.emitStdout('{"Type":"container","Action":"health_status: healthy"}\n');
  assert.equal(watcher.isHealthy(), true);

  child.emitExit(1);
  assert.equal(watcher.isHealthy(), false);

  await delay(1000);
  assert.equal(eventCount, 0);
  watcher.dispose();
});

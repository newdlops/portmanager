import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess, spawn } from "node:child_process";

import {
  ContainerEventsWatcher,
  chunkContainsRoutingRelevantEvent,
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

  // Health checks and exec probes fire constantly on busy containers and must
  // not wake the reconcile loop.
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Action":"exec_create: sh"}\n'), false);
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Action":"exec_start: sh"}\n'), false);
  assert.equal(chunkContainsRoutingRelevantEvent('{"Type":"container","Action":"health_status: healthy"}\n'), false);
  assert.equal(chunkContainsRoutingRelevantEvent("not json\n"), false);
  assert.equal(chunkContainsRoutingRelevantEvent(""), false);
});

test("events watcher subscribes with json format and container/network filters", () => {
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

  await delay(600);
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

  await delay(600);
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

  await delay(600);
  assert.equal(eventCount, 0);
  watcher.dispose();
});

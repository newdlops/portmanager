import assert from "node:assert/strict";
import test from "node:test";

import { ManagedProcessRegistry } from "../../src/core/process-registry";
import { PreferredPortWatcher, type PreferredPortWatchSettings } from "../../src/core/port-watch-service";
import type { PortAvailability, PortAvailabilityProvider } from "../../src/shared/types";

/**
 * Unit coverage for the preferred-port watcher.
 *
 * The watcher is tested with a fake availability provider so the tests can
 * exercise reconciliation behavior without binding sockets or invoking lsof.
 */

class FakePortAvailabilityProvider implements PortAvailabilityProvider {
  /** Availability results keyed by port for deterministic watcher scans. */
  private readonly resultsByPort = new Map<number, PortAvailability>();

  setResult(result: PortAvailability): void {
    this.resultsByPort.set(result.port, result);
  }

  async check(port: number): Promise<PortAvailability> {
    return this.resultsByPort.get(port) ?? { port, available: true };
  }
}

const baseSettings: PreferredPortWatchSettings = {
  enabled: true,
  host: "localhost",
  ports: [3000],
  intervalMs: 3000,
  cwd: "/workspace/app",
};

test("registers externally occupied preferred ports as detected processes", async () => {
  const provider = new FakePortAvailabilityProvider();
  const registry = new ManagedProcessRegistry({
    now: () => new Date("2026-06-21T09:00:00.000Z"),
  });
  const watcher = new PreferredPortWatcher({
    availabilityProvider: provider,
    registry,
    readSettings: () => baseSettings,
    now: () => new Date("2026-06-21T09:00:00.000Z"),
  });
  const detectedPorts: number[] = [];
  watcher.onDidDetect((event) => detectedPorts.push(event.port));

  provider.setResult({
    port: 3000,
    available: false,
    owner: { pid: 1001, name: "vite", command: "npm run dev" },
  });

  await watcher.scanNow();

  const processes = registry.list();
  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.id, "detected-port-3000");
  assert.equal(processes[0]?.source, "detected");
  assert.equal(processes[0]?.pid, 1001);
  assert.equal(processes[0]?.actualPort, 3000);
  assert.equal(processes[0]?.url, "http://localhost:3000");
  assert.deepEqual(detectedPorts, [3000]);
});

test("removes detected entries when a preferred port becomes available", async () => {
  const provider = new FakePortAvailabilityProvider();
  const registry = new ManagedProcessRegistry();
  const watcher = new PreferredPortWatcher({
    availabilityProvider: provider,
    registry,
    readSettings: () => baseSettings,
  });

  provider.setResult({ port: 3000, available: false, owner: { pid: 1001, name: "vite" } });
  await watcher.scanNow();
  assert.equal(registry.list().length, 1);

  provider.setResult({ port: 3000, available: true });
  await watcher.scanNow();

  assert.deepEqual(registry.list(), []);
});

test("does not create detected rows for ports already controlled by explicit registry entries", async () => {
  const provider = new FakePortAvailabilityProvider();
  const registry = new ManagedProcessRegistry();
  const watcher = new PreferredPortWatcher({
    availabilityProvider: provider,
    registry,
    readSettings: () => baseSettings,
  });

  registry.register(
    {
      pid: 2002,
      name: "managed web",
      command: "npm run dev",
      cwd: "/workspace/app",
      requestedPort: 3000,
      actualPort: 3000,
      host: "localhost",
    },
    { source: "managed" },
  );
  provider.setResult({ port: 3000, available: false, owner: { pid: 2002, name: "node" } });

  await watcher.scanNow();

  assert.deepEqual(
    registry.list().map((process) => process.id),
    ["managed-process-1"],
  );
});

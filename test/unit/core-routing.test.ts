import assert from "node:assert/strict";
import test from "node:test";

import { PortRoutingError, PortRoutingService, buildCandidatePorts } from "../../src/core/port-routing";
import type { PortAvailability, PortAvailabilityProvider } from "../../src/shared/types";

/**
 * Unit tests for the routing policy.
 *
 * The fake provider makes port availability deterministic and records the exact
 * check sequence, letting the tests verify routing behavior without opening
 * sockets or invoking platform commands.
 */

class FakePortAvailabilityProvider implements PortAvailabilityProvider {
  /** Ports treated as occupied by another process during the test. */
  private readonly busyPorts: ReadonlySet<number>;

  /** Ordered audit of provider calls made by PortRoutingService. */
  readonly checkedPorts: number[] = [];

  constructor(busyPorts: readonly number[]) {
    this.busyPorts = new Set(busyPorts);
  }

  /**
   * Returns availability from the configured set and records the check order so
   * candidate sequencing remains visible in assertions.
   */
  async check(port: number): Promise<PortAvailability> {
    this.checkedPorts.push(port);

    return {
      port,
      available: !this.busyPorts.has(port),
      owner: this.busyPorts.has(port) ? { pid: port, name: `busy-${port}` } : undefined,
    };
  }
}

test("uses the requested port when it is available", async () => {
  const provider = new FakePortAvailabilityProvider([]);
  const service = new PortRoutingService(provider);

  const decision = await service.route({
    requestedPort: 3000,
    host: "localhost",
    scanRange: 3,
    scanDirection: "up",
  });

  assert.equal(decision.requestedPort, 3000);
  assert.equal(decision.actualPort, 3000);
  assert.equal(decision.routed, false);
  assert.deepEqual(decision.checkedCandidates, []);
  assert.deepEqual(provider.checkedPorts, [3000]);
});

test("scans upward candidates until a free port is found", async () => {
  const provider = new FakePortAvailabilityProvider([3000, 3001]);
  const service = new PortRoutingService(provider);

  const decision = await service.route({
    requestedPort: 3000,
    host: "localhost",
    scanRange: 3,
    scanDirection: "up",
  });

  assert.equal(decision.actualPort, 3002);
  assert.equal(decision.routed, true);
  assert.deepEqual(
    decision.checkedCandidates.map((candidate) => candidate.port),
    [3001, 3002],
  );
  assert.deepEqual(provider.checkedPorts, [3000, 3001, 3002]);
});

test("scans downward candidates when configured", async () => {
  const provider = new FakePortAvailabilityProvider([3000, 2999]);
  const service = new PortRoutingService(provider);

  const decision = await service.route({
    requestedPort: 3000,
    host: "localhost",
    scanRange: 3,
    scanDirection: "down",
  });

  assert.equal(decision.actualPort, 2998);
  assert.deepEqual(provider.checkedPorts, [3000, 2999, 2998]);
});

test("alternates upward then downward for both-direction scans", async () => {
  const provider = new FakePortAvailabilityProvider([3000, 3001]);
  const service = new PortRoutingService(provider);

  const decision = await service.route({
    requestedPort: 3000,
    host: "localhost",
    scanRange: 2,
    scanDirection: "both",
  });

  assert.equal(decision.actualPort, 2999);
  assert.deepEqual(provider.checkedPorts, [3000, 3001, 2999]);
});

test("throws a clear routing error when no candidate is available", async () => {
  const provider = new FakePortAvailabilityProvider([3000, 3001, 3002]);
  const service = new PortRoutingService(provider);

  await assert.rejects(
    service.route({
      requestedPort: 3000,
      host: "localhost",
      scanRange: 2,
      scanDirection: "up",
    }),
    (error: unknown) => {
      assert.ok(error instanceof PortRoutingError);
      assert.match(String(error), /No available port found/);
      assert.match(String(error), /3000/);
      assert.match(String(error), /scan range 2/);
      return true;
    },
  );

  assert.deepEqual(provider.checkedPorts, [3000, 3001, 3002]);
});

test("candidate generation skips ports outside the TCP range", () => {
  assert.deepEqual(buildCandidatePorts(1, 2, "down"), []);
  assert.deepEqual(buildCandidatePorts(65_535, 2, "up"), []);
  assert.deepEqual(buildCandidatePorts(2, 2, "both"), [3, 1, 4]);
});

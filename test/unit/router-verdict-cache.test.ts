import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { ROUTER_NON_NETWORK_VERDICT, RouterVerdictCache } from "../../src/core/networks/router-verdict-cache";

/**
 * Coverage for the logical port gateway attribution memo. A controllable clock
 * lets each test assert TTL and pid-reuse semantics deterministically.
 */

function createCache(now: () => number): RouterVerdictCache {
  return new RouterVerdictCache({
    networkTtlMs: 10_000,
    nonNetworkTtlMs: 30_000,
    maxEntries: 4,
    now,
  });
}

test("returns a stored network verdict before its TTL expires", () => {
  let clock = 1_000;
  const cache = createCache(() => clock);

  cache.store(100, "start-a", "network-a");
  clock += 9_000;

  assert.equal(cache.read(100, "start-a"), "network-a");
});

test("expires network verdicts faster than non-network verdicts", () => {
  let clock = 0;
  const cache = createCache(() => clock);

  cache.store(1, "s", "network-a");
  cache.store(2, "s", ROUTER_NON_NETWORK_VERDICT);

  clock = 10_001;
  assert.equal(cache.read(1, "s"), undefined, "network verdict should expire at 10s");
  assert.equal(cache.read(2, "s"), ROUTER_NON_NETWORK_VERDICT, "non-network verdict should still be valid");

  clock = 30_001;
  assert.equal(cache.read(2, "s"), undefined, "non-network verdict should expire at 30s");
});

test("keys verdicts by pid and start time so a reused pid does not inherit a stale verdict", () => {
  let clock = 0;
  const cache = createCache(() => clock);

  cache.store(500, "start-old", "network-a");

  assert.equal(cache.read(500, "start-new"), undefined, "reused pid with a new start time misses");
  assert.equal(cache.read(500, "start-old"), "network-a");
});

test("clear drops every verdict when attachments change", () => {
  const cache = createCache(() => 0);

  cache.store(1, "s", "network-a");
  cache.store(2, "s", ROUTER_NON_NETWORK_VERDICT);
  cache.clear();

  assert.equal(cache.read(1, "s"), undefined);
  assert.equal(cache.read(2, "s"), undefined);
  assert.equal(cache.size, 0);
});

test("prunes expired entries when the cache exceeds its capacity", () => {
  let clock = 0;
  const cache = createCache(() => clock);

  // Fill with short-lived network verdicts, then let them expire.
  for (let pid = 1; pid <= 4; pid++) {
    cache.store(pid, "s", "network-a");
  }
  clock = 10_001;

  // Storing past capacity triggers a prune that removes the expired entries.
  cache.store(99, "s", "network-b");
  assert.equal(cache.size, 1, "only the fresh verdict should remain after pruning");
  assert.equal(cache.read(99, "s"), "network-b");
});

test("bounds a burst of live identities and retains recently used verdicts", () => {
  const cache = createCache(() => 0);
  for (let pid = 1; pid <= 4; pid++) cache.store(pid, "s", `network-${pid}`);
  assert.equal(cache.read(1, "s"), "network-1");
  cache.store(5, "s", "network-5");
  assert.equal(cache.size, 4);
  assert.equal(cache.read(2, "s"), undefined);
  assert.equal(cache.read(1, "s"), "network-1");
  for (let pid = 6; pid <= 10_000; pid++) cache.store(pid, "s", "network-new");
  assert.equal(cache.size, 4);
});

test("does not memoize a PID without its birth identity", () => {
  const cache = createCache(() => 0);
  for (const startTime of [undefined, "", " "]) {
    cache.store(42, startTime, "network-a");
    assert.equal(cache.read(42, startTime), undefined);
  }
  assert.equal(cache.size, 0);
  cache.store(42, "birth-a", "network-a");
  assert.equal(cache.read(42, undefined), undefined);
  assert.equal(cache.read(42, "birth-b"), undefined);
});

test("hot reads do not renew a verdict past an attachment-sensitive TTL", () => {
  let clock = 0;
  const cache = createCache(() => clock);
  cache.store(42, "birth", "network-a");
  clock = 9_999;
  assert.equal(cache.read(42, "birth"), "network-a");
  clock++;
  assert.equal(cache.read(42, "birth"), undefined);
});

test("default attribution TTL expires despite a backward wall clock jump", t => {
  let monotonic = 1000;
  let wall = 100000;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.method(Date, "now", () => wall);
  const cache = new RouterVerdictCache({ networkTtlMs: 100, nonNetworkTtlMs: 300, maxEntries: 4 });
  cache.store(42, "birth", "network-a");
  wall -= 60000;
  monotonic += 100;
  assert.equal(cache.read(42, "birth"), undefined, "a detached client's verdict cannot outlive its TTL");
});

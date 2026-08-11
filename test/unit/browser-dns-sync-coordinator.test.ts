import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserDnsSyncCoordinator,
  type BrowserDnsSyncBatch,
  type RejectedResolution,
} from "../../src/extension/browser-dns-sync-coordinator";

const batch = (signature: string): BrowserDnsSyncBatch => ({ records: `record-${signature}`, revision: signature, signature });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(
  send: (value: BrowserDnsSyncBatch) => Promise<{ readonly applied?: boolean; readonly running: boolean; readonly port: number }>,
  resolveRejected: (value: BrowserDnsSyncBatch) => RejectedResolution = () => ({ kind: "retry" }),
) {
  const timers: { readonly delay: number; readonly callback: () => void }[] = [];
  return {
    timers,
    coordinator: new BrowserDnsSyncCoordinator({
      send,
      resolveRejected,
      onResult: () => undefined,
      onError: () => undefined,
      schedule: (delay, callback) => { timers.push({ delay, callback }); return callback; },
      cancel: () => undefined,
    }),
  };
}

test("coordinator retains the exact failed batch and backs off to its bounded cap", async () => {
  const sent: BrowserDnsSyncBatch[] = [];
  const f = fixture(async (value) => { sent.push(value); throw new Error("transient"); });
  const desired = batch("A");
  f.coordinator.enqueue(desired);
  await tick();
  for (const expectedDelay of [100, 200, 400, 800, 1600, 3200, 3200, 3200]) {
    assert.equal(f.timers.at(-1)?.delay, expectedDelay);
    f.timers.at(-1)!.callback();
    await tick();
  }
  assert.equal(sent.length, 9);
  assert.equal(sent.every((value) => value === desired), true);
  assert.deepEqual(sent[0], desired);
});

test("coordinator coalesces B then C while A is in flight", async () => {
  let release!: () => void;
  const sent: string[] = [];
  const f = fixture(async (value) => {
    sent.push(value.signature);
    await new Promise<void>((resolve) => { release = resolve; });
    return { running: true, port: 1 };
  });
  f.coordinator.enqueue(batch("A"));
  await tick();
  f.coordinator.enqueue(batch("B"));
  f.coordinator.enqueue(batch("C"));
  release();
  await tick();
  assert.deepEqual(sent, ["A", "C"]);
});

test("coordinator applies production resolver retry, replace, and drop outcomes", async () => {
  const outcomes: readonly RejectedResolution[] = [
    { kind: "retry" },
    { kind: "replace", batch: batch("B") },
    { kind: "drop" },
  ];
  const sent: string[] = [];
  let resolverIndex = 0;
  const f = fixture(
    async (value) => { sent.push(value.signature); return { applied: false, running: true, port: 1 }; },
    () => outcomes[resolverIndex++]!,
  );
  f.coordinator.enqueue(batch("A"));
  await tick();
  assert.equal(f.timers.length, 1);
  f.timers[0]!.callback();
  await tick();
  assert.deepEqual(sent, ["A", "A"]);
  assert.equal(f.timers.length, 2);
  f.timers[1]!.callback();
  await tick();
  assert.deepEqual(sent, ["A", "A", "B"]);
  assert.deepEqual(sent, ["A", "A", "B"]);
  assert.equal(f.timers.length, 2);
});

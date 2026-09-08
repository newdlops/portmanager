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
  const cancelled: unknown[] = [];
  return {
    timers,
    cancelled,
    coordinator: new BrowserDnsSyncCoordinator({
      send,
      resolveRejected,
      onResult: () => undefined,
      onError: () => undefined,
      schedule: (delay, callback) => { timers.push({ delay, callback }); return callback; },
      cancel: (timer) => { cancelled.push(timer); },
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

test("coordinator does not strand a batch queued at the drain settlement boundary", async () => {
  const sent: string[] = [];
  let coordinator!: BrowserDnsSyncCoordinator;
  coordinator = new BrowserDnsSyncCoordinator({
    send: async (value) => {
      sent.push(value.signature);
      return { running: true, port: 1 };
    },
    resolveRejected: () => ({ kind: "retry" }),
    onResult: (value) => {
      if (value.signature === "A") {
        /*
         * This microtask runs after drain() has observed an empty queue but
         * before the outer active promise settles. It reproduced the DNS table
         * remaining stale until Extension Host restart.
         */
        queueMicrotask(() => coordinator.enqueue(batch("B")));
      }
    },
    onError: () => undefined,
    schedule: (_delay, callback) => setTimeout(callback, 0),
    cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });

  coordinator.enqueue(batch("A"));
  await tick();
  await tick();

  assert.deepEqual(sent, ["A", "B"]);
});

test("coordinator retries an accepted table until the DNS responder is bound", async () => {
  const sent: string[] = [];
  const f = fixture(async (value) => {
    sent.push(value.signature);
    return sent.length === 1
      ? { applied: true, running: false, port: 1 }
      : { applied: true, running: true, port: 1 };
  });

  f.coordinator.enqueue(batch("A"));
  await tick();
  assert.equal(f.timers[0]?.delay, 100);

  f.timers[0]!.callback();
  await tick();

  assert.deepEqual(sent, ["A", "A"]);
});

test("explicit flush bypasses an existing retry delay even for the same table", async () => {
  const sent: string[] = [];
  const f = fixture(async (value) => {
    sent.push(value.signature);
    throw new Error("transient");
  });

  f.coordinator.enqueue(batch("A"));
  await tick();
  assert.equal(f.timers[0]?.delay, 100);

  f.coordinator.enqueue(batch("A"));
  await f.coordinator.flushPendingNow();

  assert.deepEqual(sent, ["A", "A"]);
  assert.deepEqual(f.cancelled, [f.timers[0]!.callback]);
  f.coordinator.dispose();
});

test("a new DNS revision bypasses the failed revision's backoff", async () => {
  const sent: string[] = [];
  const f = fixture(async (value) => {
    sent.push(value.signature);
    if (value.signature === "A") throw new Error("daemon unavailable");
    return { applied: true, running: true, port: 1 };
  });
  f.coordinator.enqueue(batch("A"));
  await f.coordinator.waitForCurrentDrain();
  const retry = f.timers[0]!;

  // A new network must be published without waiting for A's retry timer.
  f.coordinator.enqueue(batch("B"));
  await f.coordinator.waitForCurrentDrain();

  assert.deepEqual(sent, ["A", "B"]);
  assert.deepEqual(f.cancelled, [retry.callback]);
  assert.equal(f.timers.length, 1);
  f.coordinator.dispose();
});

test("duplicate DNS revisions preserve transport backoff during snapshot churn", async () => {
  const sent: string[] = [];
  const f = fixture(async (value) => { sent.push(value.signature); throw new Error("offline"); });
  f.coordinator.enqueue(batch("A"));
  await f.coordinator.waitForCurrentDrain();

  for (let index = 0; index < 20; index++) f.coordinator.enqueue(batch("A"));
  await f.coordinator.waitForCurrentDrain();
  assert.deepEqual(sent, ["A"]);
  assert.equal(f.timers.length, 1);
  assert.equal(f.cancelled.length, 0);

  f.timers[0]!.callback();
  await f.coordinator.waitForCurrentDrain();
  assert.deepEqual(sent, ["A", "A"]);
  assert.equal(f.timers[1]?.delay, 200);
  f.coordinator.dispose();
});

for (const failure of ["transport", "bind"] as const) {
  test(`a queued new revision is sent immediately after an in-flight ${failure} failure`, async () => {
    const sent: string[] = [];
    let release!: () => void;
    let pending = 0;
    let maxPending = 0;
    const f = fixture(async (value) => {
      sent.push(value.signature);
      maxPending = Math.max(maxPending, ++pending);
      try {
        if (value.signature === "A") {
          await new Promise<void>((resolve) => { release = resolve; });
          if (failure === "transport") throw new Error("disconnected");
          return { applied: true, running: false, port: 1 };
        }
        return { applied: true, running: true, port: 1 };
      } finally {
        pending--;
      }
    });

    f.coordinator.enqueue(batch("A"));
    f.coordinator.enqueue(batch("B"));
    f.coordinator.enqueue(batch("C"));
    release();
    await f.coordinator.waitForCurrentDrain();

    assert.deepEqual(sent, ["A", "C"]);
    assert.equal(maxPending, 1);
    assert.equal(f.timers.length, 0);
    f.coordinator.dispose();
  });
}

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
  assert.deepEqual(sent, ["A", "A", "B"]);
  // Fence rejection points us at a different, current document. It is ready
  // to send now; only retrying the same failed document needs a timer.
  assert.equal(f.timers.length, 1);
  f.coordinator.dispose();
});

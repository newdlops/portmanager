import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeRespawnInvocationMarker,
  encodeRespawnInvocationMarker,
  evaluateRespawnReap,
  type RespawnReapInput,
} from "../../src/core/respawn-reap";

const NET = "network-aaaaaaaa";
const OTHER = "network-bbbbbbbb";
const CONFIRM = 3000;

function base(overrides: Partial<RespawnReapInput>): RespawnReapInput {
  return {
    recordedNetworkId: NET,
    currentNetworkId: NET,
    invocationAncestorPids: [100, 200, 300],
    isAncestorAlive: () => false, // whole subtree dead by default
    allDeadSinceMs: 0,
    nowMs: CONFIRM + 1, // confirmation elapsed by default
    confirmMs: CONFIRM,
    ...overrides,
  };
}

test("reaps only when the whole subtree is confirmed dead in the recorded network", () => {
  const decision = evaluateRespawnReap(base({}));
  assert.equal(decision.reap, true);
  assert.equal(decision.reason, "reap");
});

test("never reaps across a network boundary (scope mismatch)", () => {
  // Every other signal says "reap", but the current network differs → must not kill.
  const decision = evaluateRespawnReap(base({ currentNetworkId: OTHER }));
  assert.equal(decision.reap, false);
  assert.equal(decision.reason, "scope-mismatch");
});

test("never reaps when the current network is unknown", () => {
  const decision = evaluateRespawnReap(base({ currentNetworkId: undefined }));
  assert.equal(decision.reap, false);
  assert.equal(decision.reason, "scope-mismatch");
});

test("does not reap while any launcher-subtree ancestor is still alive (run in progress)", () => {
  const decision = evaluateRespawnReap(
    base({ isAncestorAlive: (pid) => pid === 300 }), // launcher still up
  );
  assert.equal(decision.reap, false);
  assert.equal(decision.reason, "run-alive");
  assert.equal(decision.subtreeDeadNow, false);
});

test("a single transient ancestor dying is not enough — whole subtree required", () => {
  // 100 and 200 gone, 300 (launcher) alive → still running.
  const decision = evaluateRespawnReap(
    base({ isAncestorAlive: (pid) => pid === 300 }),
  );
  assert.equal(decision.reap, false);
  assert.equal(decision.reason, "run-alive");
});

test("first observation of an all-dead subtree only starts the clock (confirmation delay)", () => {
  const decision = evaluateRespawnReap(base({ allDeadSinceMs: undefined }));
  assert.equal(decision.reap, false);
  assert.equal(decision.reason, "awaiting-confirmation");
  assert.equal(decision.subtreeDeadNow, true); // caller stamps allDeadSince from this
});

test("does not reap before the confirmation delay elapses", () => {
  const decision = evaluateRespawnReap(base({ allDeadSinceMs: 1000, nowMs: 1000 + CONFIRM - 1 }));
  assert.equal(decision.reap, false);
  assert.equal(decision.reason, "awaiting-confirmation");
});

test("reaps exactly at the confirmation boundary", () => {
  const decision = evaluateRespawnReap(base({ allDeadSinceMs: 1000, nowMs: 1000 + CONFIRM }));
  assert.equal(decision.reap, true);
});

test("never reaps without recorded run processes (no evidence)", () => {
  const decision = evaluateRespawnReap(base({ invocationAncestorPids: [] }));
  assert.equal(decision.reap, false);
  assert.equal(decision.reason, "no-evidence");
});

test("marker round-trips network id and invocation pids", () => {
  const encoded = encodeRespawnInvocationMarker(NET, [100, 200, 300]);
  const decoded = decodeRespawnInvocationMarker(encoded);
  assert.deepEqual(decoded, { networkId: NET, invocationAncestorPids: [100, 200, 300] });
});

test("marker decode rejects malformed values", () => {
  assert.equal(decodeRespawnInvocationMarker(""), undefined);
  assert.equal(decodeRespawnInvocationMarker("no-separator"), undefined);
  assert.equal(decodeRespawnInvocationMarker(`${NET}~`), undefined);
  assert.equal(decodeRespawnInvocationMarker(`${NET}~0,-1,x`), undefined);
});

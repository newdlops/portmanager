import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { SharedLogicalNetworkStateStore } from "../../src/platform/network/shared-network-state-store";
import type { LogicalNetworkRegistryState } from "../../src/core/networks/logical-network-registry";

test("writes and reloads a shared logical network state document", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-shared-state-"));
  try {
    const store = new SharedLogicalNetworkStateStore({ storageDirectory: tempDir });
    const state = createState("network-1");

    const saved = store.save(state);
    const loaded = store.load();

    assert.equal(saved.version, 1);
    assert.equal(loaded?.revision, saved.revision);
    assert.deepEqual(loaded?.state, state);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loads legacy raw registry state documents", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-legacy-shared-state-"));
  try {
    const store = new SharedLogicalNetworkStateStore({ storageDirectory: tempDir });
    const state = createState("network-legacy");

    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, JSON.stringify(state), "utf8");

    const loaded = store.load();

    assert.equal(loaded?.revision, "legacy");
    assert.deepEqual(loaded?.state, state);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createState(networkId: string): LogicalNetworkRegistryState {
  return {
    networks: [
      {
        id: networkId,
        name: "A app",
        status: "running",
        runtimeKind: "nativeHelper",
        createdAt: "2026-06-24T00:00:00.000Z",
      },
    ],
    attachments: [],
    exposures: [],
    hostAccessBindings: [],
    composeAttachments: [],
  };
}

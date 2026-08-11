import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  continueWhenDaemonLifecycleReady,
  convergeDaemonLifecycle,
  type DaemonLifecyclePort,
} from "../../src/extension/daemon-lifecycle";
import { SharedLogicalNetworkStateStore } from "../../src/platform/network/shared-network-state-store";
import type { LogicalNetworkRegistryState } from "../../src/core/networks/logical-network-registry";
import type { AgentDaemonStatus } from "../../src/shared/types";

test("first owner cold start converges a stale daemon and publishes payrollp routes once", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-cold-owner-"));
  try {
    const stateStore = new SharedLogicalNetworkStateStore({ storageDirectory: tempDir });
    stateStore.save(createPayrollpState());
    assert.equal(stateStore.load()?.state.networks[0]?.name, "payrollp");

    const calls: string[] = [];
    let routePublished = false;
    let daemon = daemonStatus("disconnected", false);
    const processService: DaemonLifecyclePort = {
      getDaemonStatus: () => daemon,
      start: async () => {
        calls.push("start");
        // The singleton existed before this window, but belongs to an older build.
        daemon = daemonStatus("running", true);
      },
      restartDaemon: async (options) => {
        calls.push(`restart(refreshSnapshot:${options.refreshSnapshot})`);
        daemon = daemonStatus("running", false);
      },
      repairRoutingState: async () => {
        calls.push("repair/publication");
        routePublished = true;
      },
    };
    const restartBackoff = { untilMs: 0 };

    const result = await convergeDaemonLifecycle(processService, {
      restartBackoff,
      restartBackoffMs: 30_000,
      repairRoutingAfterTransition: true,
      nowMs: () => 10,
    });

    assert.deepEqual(calls, ["start", "restart(refreshSnapshot:false)", "repair/publication"]);
    assert.equal(result.ready, true);
    assert.equal(restartBackoff.untilMs, 0);
    assert.equal(routePublished, true, "the durable payrollp route is available before owner convergence resolves");

    // An already-current owner handoff must not replace the daemon or touch
    // the independently leased logical-router/browser-proxy listeners.
    calls.length = 0;
    const handoff = await convergeDaemonLifecycle(processService, {
      restartBackoff,
      restartBackoffMs: 30_000,
      repairRoutingAfterTransition: true,
      nowMs: () => 20,
    });
    assert.equal(handoff.transitioned, false);
    assert.deepEqual(calls, []);

    // A stale daemon inside its restart backoff is not convergence. The same
    // production gate used by owner startup must leave generated route work
    // and downstream proxy/router continuation untouched.
    daemon = daemonStatus("running", true);
    restartBackoff.untilMs = 50;
    calls.length = 0;
    routePublished = false;
    const blocked = await convergeDaemonLifecycle(processService, {
      restartBackoff,
      restartBackoffMs: 30_000,
      repairRoutingAfterTransition: true,
      nowMs: () => 20,
    });
    let downstreamRan = false;
    const continued = await continueWhenDaemonLifecycleReady(blocked, async () => {
      downstreamRan = true;
    });
    assert.equal(blocked.ready, false);
    assert.equal(continued, false);
    assert.equal(downstreamRan, false);
    assert.deepEqual(calls, []);
    assert.equal(routePublished, false, "a backoff-gated stale daemon cannot expose a newly published durable route");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function daemonStatus(status: AgentDaemonStatus["status"], restartRequired: boolean): AgentDaemonStatus {
  return {
    status,
    pid: status === "running" ? 2345 : 0,
    updatedAt: "2026-08-11T00:00:00.000Z",
    restartRequired,
    listenerCount: 0,
    routeCount: 0,
    monitoringAllListeners: true,
  };
}

function createPayrollpState(): LogicalNetworkRegistryState {
  return {
    networks: [
      {
        id: "payrollp",
        name: "payrollp",
        status: "running",
        runtimeKind: "nativeHelper",
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    ],
    attachments: [],
    exposures: [],
    hostAccessBindings: [],
    composeAttachments: [],
  };
}

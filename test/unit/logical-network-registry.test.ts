import assert from "node:assert/strict";
import test from "node:test";

import { LogicalNetworkRegistry } from "../../src/core/networks/logical-network-registry";
import type { HostPortExposure, LogicalNetwork, NetworkRuntimeDescriptor } from "../../src/shared/types";

const runtime: NetworkRuntimeDescriptor = {
  id: "proxy",
  name: "Proxy",
  kind: "proxy",
  capabilities: {
    supportsSameInternalPorts: false,
    supportsTerminalAttach: false,
    supportsHostExposure: true,
    requiresPrivilegedHelper: false,
    requiresContainerRuntime: false,
  },
};

function createNetwork(overrides: Partial<LogicalNetwork> = {}): LogicalNetwork {
  return {
    id: "network-1",
    name: "A app",
    status: "running",
    runtimeKind: "proxy",
    createdAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

function createExposure(overrides: Partial<HostPortExposure> = {}): HostPortExposure {
  return {
    id: "exposure-1",
    networkId: "network-1",
    hostAddress: "127.0.0.1",
    hostPort: 3004,
    targetAddress: "127.0.0.1",
    targetPort: 3004,
    protocol: "tcp",
    status: "active",
    createdAt: "2026-06-22T00:01:00.000Z",
    ...overrides,
  };
}

test("stores networks, terminal candidates, and exposures in snapshots", () => {
  const registry = new LogicalNetworkRegistry([runtime]);
  let eventCount = 0;
  registry.onDidChange(() => {
    eventCount += 1;
  });

  registry.addNetwork(createNetwork());
  registry.setTerminalCandidates([
    {
      pid: 101,
      name: "zsh",
      processGroupId: 101,
      terminalId: "ttys001",
      vscodeTerminal: false,
    },
  ]);
  registry.addExposure(createExposure());

  const snapshot = registry.getSnapshot();

  assert.deepEqual(
    snapshot.networks.map((network) => network.id),
    ["network-1"],
  );
  assert.deepEqual(
    snapshot.terminalCandidates.map((candidate) => candidate.pid),
    [101],
  );
  assert.deepEqual(
    snapshot.exposures.map((exposure) => exposure.id),
    ["exposure-1"],
  );
  assert.equal(snapshot.runtimes[0]?.id, "proxy");
  assert.equal(eventCount, 3);
});

test("rejects duplicate host exposures for the same address and port", () => {
  const registry = new LogicalNetworkRegistry([runtime]);
  registry.addNetwork(createNetwork());
  registry.addExposure(createExposure());

  assert.throws(
    () => registry.addExposure(createExposure({ id: "exposure-2" })),
    /Host exposure already exists/,
  );
});

test("removing a network removes dependent attachments and exposures", () => {
  const registry = new LogicalNetworkRegistry([runtime]);
  registry.addNetwork(createNetwork());
  registry.addAttachment({
    id: "attachment-1",
    networkId: "network-1",
    rootPid: 101,
    processGroupId: 101,
    status: "attached",
    attachedAt: "2026-06-22T00:02:00.000Z",
  });
  registry.addExposure(createExposure());

  const removed = registry.removeNetwork("network-1");
  const snapshot = registry.getSnapshot();

  assert.equal(removed?.id, "network-1");
  assert.deepEqual(snapshot.networks, []);
  assert.deepEqual(snapshot.attachments, []);
  assert.deepEqual(snapshot.exposures, []);
});

test("persisted state excludes transient terminal candidates", () => {
  const registry = new LogicalNetworkRegistry([runtime]);
  registry.addNetwork(createNetwork());
  registry.setTerminalCandidates([
    {
      pid: 202,
      name: "bash",
      vscodeTerminal: true,
    },
  ]);

  const persisted = registry.getPersistedState();

  assert.deepEqual(
    persisted.networks.map((network) => network.id),
    ["network-1"],
  );
  assert.equal("terminalCandidates" in persisted, false);
});

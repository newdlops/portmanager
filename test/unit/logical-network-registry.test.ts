import assert from "node:assert/strict";
import test from "node:test";

import { LogicalNetworkRegistry } from "../../src/core/networks/logical-network-registry";
import type {
  ComposeAttachment,
  ContainerServiceCandidate,
  HostAccessBinding,
  HostPortExposure,
  LogicalNetwork,
  NetworkRuntimeDescriptor,
} from "../../src/shared/types";

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

function createHostAccessBinding(overrides: Partial<HostAccessBinding> = {}): HostAccessBinding {
  return {
    id: "host-access-1",
    networkId: "network-1",
    logicalPort: 15432,
    hostAddress: "127.0.0.1",
    hostPort: 5432,
    protocol: "tcp",
    status: "active",
    createdAt: "2026-06-22T00:03:00.000Z",
    ...overrides,
  };
}

function createComposeAttachment(overrides: Partial<ComposeAttachment> = {}): ComposeAttachment {
  return {
    id: "compose-1",
    networkId: "network-1",
    projectName: "workspace",
    composeFiles: [],
    ports: [
      {
        serviceName: "postgres",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 57001,
        containerPort: 5432,
        protocol: "tcp",
        protocolName: "postgresql",
      },
    ],
    status: "attached",
    attachedAt: "2026-06-22T00:04:00.000Z",
    ...overrides,
  };
}

function createContainerServiceCandidate(overrides: Partial<ContainerServiceCandidate> = {}): ContainerServiceCandidate {
  return {
    id: "docker:abc123",
    runtime: "docker",
    containerId: "abc123",
    containerName: "workspace-postgres-1",
    composeProject: "workspace",
    composeService: "postgres",
    ports: [
      {
        serviceName: "postgres",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
        protocolName: "postgresql",
      },
    ],
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
  registry.addHostAccessBinding(createHostAccessBinding());
  registry.addComposeAttachment(createComposeAttachment());
  registry.setContainerServiceCandidates([createContainerServiceCandidate()]);

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
    snapshot.terminalWindows.map((window) => window.rootPid),
    [101],
  );
  assert.deepEqual(
    snapshot.exposures.map((exposure) => exposure.id),
    ["exposure-1"],
  );
  assert.deepEqual(
    snapshot.hostAccessBindings.map((binding) => binding.id),
    ["host-access-1"],
  );
  assert.deepEqual(
    snapshot.composeAttachments.map((attachment) => attachment.id),
    ["compose-1"],
  );
  assert.deepEqual(
    snapshot.containerServiceCandidates.map((candidate) => candidate.id),
    ["docker:abc123"],
  );
  assert.equal(snapshot.runtimes[0]?.id, "proxy");
  assert.equal(eventCount, 6);
});

test("groups noisy terminal process candidates into terminal windows", () => {
  const registry = new LogicalNetworkRegistry([runtime]);
  registry.setTerminalCandidates([
    {
      pid: 100,
      parentPid: 1,
      processGroupId: 100,
      terminalId: "ttys001",
      windowTitle: "Captain dev cluster",
      name: "zsh",
      command: "/bin/zsh -il",
      vscodeTerminal: false,
    },
    {
      pid: 101,
      parentPid: 100,
      processGroupId: 100,
      terminalId: "ttys001",
      name: "bash",
      command: "/bin/bash ./run-server",
      vscodeTerminal: false,
    },
    {
      pid: 200,
      name: "Extension Host",
      windowTitle: "API server terminal",
      command: "Extension Host",
      vscodeTerminal: true,
    },
  ]);

  const windows = registry.getSnapshot().terminalWindows;

  assert.equal(windows.length, 2);
  assert.equal(windows[0]?.id, "tty:ttys001");
  assert.equal(windows[0]?.title, "Captain dev cluster");
  assert.equal(windows[0]?.rootPid, 100);
  assert.equal(windows[0]?.candidateCount, 2);
  assert.deepEqual(windows[0]?.candidatePids, [100, 101]);
  assert.equal(windows[1]?.id, "vscode:200");
  assert.equal(windows[1]?.title, "API server terminal");
});

test("merges VS Code terminal candidates with OS rows that share a tty", () => {
  const registry = new LogicalNetworkRegistry([runtime]);
  registry.setTerminalCandidates([
    {
      pid: 200,
      parentPid: 1,
      processGroupId: 200,
      terminalId: "ttys007",
      name: "API server terminal",
      windowTitle: "API server terminal",
      command: "API server terminal",
      vscodeTerminal: true,
    },
    {
      pid: 201,
      parentPid: 200,
      processGroupId: 200,
      terminalId: "ttys007",
      name: "zsh",
      command: "/bin/zsh -il",
      vscodeTerminal: false,
    },
  ]);

  const windows = registry.getSnapshot().terminalWindows;

  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.id, "tty:ttys007");
  assert.equal(windows[0]?.source, "vscode");
  assert.equal(windows[0]?.title, "API server terminal");
  assert.deepEqual(windows[0]?.candidatePids, [200, 201]);
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

test("rejects duplicate host access bindings in the same network", () => {
  const registry = new LogicalNetworkRegistry([runtime]);
  registry.addNetwork(createNetwork());
  registry.addHostAccessBinding(createHostAccessBinding());

  assert.throws(
    () => registry.addHostAccessBinding(createHostAccessBinding({ id: "host-access-2" })),
    /Host access binding already exists/,
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
    terminalWindowId: "tty:ttys001",
    terminalTitle: "Captain dev cluster",
    mode: "logical",
    status: "attached",
    errorMessage: "Proxy runtime does not isolate traffic yet.",
    attachedAt: "2026-06-22T00:02:00.000Z",
  });
  const attachment = registry.getSnapshot().attachments[0];
  registry.addExposure(createExposure());
  registry.addHostAccessBinding(createHostAccessBinding());
  registry.addComposeAttachment(createComposeAttachment());

  const removed = registry.removeNetwork("network-1");
  const snapshot = registry.getSnapshot();

  assert.equal(attachment?.terminalTitle, "Captain dev cluster");
  assert.equal(attachment?.mode, "logical");
  assert.match(attachment?.errorMessage ?? "", /does not isolate/);
  assert.equal(removed?.id, "network-1");
  assert.deepEqual(snapshot.networks, []);
  assert.deepEqual(snapshot.attachments, []);
  assert.deepEqual(snapshot.exposures, []);
  assert.deepEqual(snapshot.hostAccessBindings, []);
  assert.deepEqual(snapshot.composeAttachments, []);
});

test("rejects duplicate compose routes in the same logical network", () => {
  const registry = new LogicalNetworkRegistry([runtime]);
  registry.addNetwork(createNetwork());
  registry.addComposeAttachment(createComposeAttachment());

  assert.throws(
    () => registry.addComposeAttachment(createComposeAttachment({ id: "compose-2", projectName: "other" })),
    /Compose route already exists/,
  );
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
  assert.equal("containerServiceCandidates" in persisted, false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ContainerNetworkRuntimeAdapter,
  type ContainerCommandRunner,
} from "../../src/platform/network/container-runtime";
import {
  ContainerServiceDiscoveryAdapter,
  parseContainerRows,
} from "../../src/platform/network/container-service-discovery";
import type { ContainerRuntimeSettings, HostPortExposure, LogicalNetwork } from "../../src/shared/types";

const settings: ContainerRuntimeSettings = {
  containerRuntime: "auto",
  containerImage: "alpine:3.20",
};

test("detects Docker as a network-namespace logical network runtime", async () => {
  const adapter = new ContainerNetworkRuntimeAdapter({
    supportsHostNetworkNamespace: true,
    runCommand: async (executable, args) => {
      assert.equal(executable, "docker");
      assert.deepEqual(args, ["info"]);
      return { stdout: "Server Version: 29.0.0", stderr: "" };
    },
  });

  const descriptor = await adapter.detect(settings);

  assert.equal(descriptor?.id, "docker");
  assert.equal(descriptor?.kind, "container");
  assert.equal(descriptor?.capabilities.supportsSameInternalPorts, true);
  assert.equal(descriptor?.capabilities.supportsTerminalAttach, true);
});

test("marks Docker namespace attach unsupported when the host cannot enter container netns", async () => {
  const adapter = new ContainerNetworkRuntimeAdapter({
    supportsHostNetworkNamespace: false,
    runCommand: async () => ({ stdout: "Server Version: 29.0.0", stderr: "" }),
  });

  const descriptor = await adapter.detect(settings);

  assert.equal(descriptor?.id, "docker");
  assert.equal(descriptor?.capabilities.supportsSameInternalPorts, false);
  assert.equal(descriptor?.capabilities.supportsTerminalAttach, false);
  assert.equal(descriptor?.capabilities.supportsHostExposure, true);
});

test("creates one global bridge network and a logical network namespace holder", async () => {
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  const adapter = new ContainerNetworkRuntimeAdapter({
    supportsHostNetworkNamespace: true,
    runCommand: createRecordingRunner(calls, {
      missingInspects: true,
    }),
  });

  await adapter.detect(settings);
  await adapter.createNetwork(createNetwork(), settings);

  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 3)),
    [
      ["info"],
      ["network", "inspect", "portmanager-global"],
      ["network", "create", "--label"],
      ["container", "inspect", "portmanager-netns-network-1"],
      ["run", "-d", "--name"],
    ],
  );
  const runCall = calls.find((call) => call.args[0] === "run");

  assert.ok(runCall);
  assert.equal(runCall.executable, "docker");
  assert.equal(runCall.args.includes("--network"), true);
  assert.equal(runCall.args.includes("portmanager-global"), true);
  assert.equal(runCall.args.includes("-v"), false);
  assert.equal(runCall.args.includes("alpine:3.20"), true);
});

test("builds an attach command that enters only the holder network namespace", async () => {
  const adapter = new ContainerNetworkRuntimeAdapter({
    supportsHostNetworkNamespace: true,
    runCommand: async (_executable, args) => {
      if (args[0] === "container" && args[1] === "inspect") {
        return { stdout: "4242\n", stderr: "" };
      }

      return { stdout: "Server Version: 29.0.0", stderr: "" };
    },
  });

  await adapter.detect(settings);

  assert.equal(
    await adapter.buildAttachCommand("network-1"),
    'nsenter --target 4242 --net --preserve-credentials -- sh -lc \'cd "$PWD" && exec "${SHELL:-/bin/sh}" -l\'',
  );
});

test("resolves host exposure targets to the container bridge address", async () => {
  const adapter = new ContainerNetworkRuntimeAdapter({
    supportsHostNetworkNamespace: true,
    runCommand: async (_executable, args) => {
      if (args[0] === "container" && args[1] === "inspect") {
        return { stdout: "172.18.0.2\n", stderr: "" };
      }

      return { stdout: "Server Version: 29.0.0", stderr: "" };
    },
  });

  await adapter.detect(settings);
  const target = await adapter.resolveExposureTarget(createExposure());

  assert.deepEqual(target, {
    host: "172.18.0.2",
    port: 3000,
  });
});

test("parses compose containers with published TCP ports as attach candidates", () => {
  const candidates = parseContainerRows("docker", [
    {
      ID: "abc123",
      Names: "workspace-postgres-1",
      Image: "postgres:16",
      Status: "Up 2 minutes",
      Ports: "127.0.0.1:15432->5432/tcp, 0.0.0.0:18080->8080/tcp, 8081/tcp",
      Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
    },
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, "docker:abc123");
  assert.equal(candidates[0]?.composeProject, "workspace");
  assert.equal(candidates[0]?.composeService, "postgres");
  assert.deepEqual(
    candidates[0]?.ports.map((port) => ({
      serviceName: port.serviceName,
      logicalPort: port.logicalPort,
      actualHostAddress: port.actualHostAddress,
      actualHostPort: port.actualHostPort,
      containerPort: port.containerPort,
      protocolName: port.protocolName,
    })),
    [
      {
        serviceName: "postgres",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocolName: "postgresql",
      },
      {
        serviceName: "postgres",
        logicalPort: 18080,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 18080,
        containerPort: 8080,
        protocolName: undefined,
      },
    ],
  );
});

test("discovers published port candidates through the configured runtime", async () => {
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      return {
        stdout: JSON.stringify({
          ID: "def456",
          Names: "redis",
          Ports: "0.0.0.0:16379->6379/tcp",
          Labels: "",
        }),
        stderr: "",
      };
    },
  });

  const candidates = await adapter.list({ containerRuntime: "docker", containerImage: "alpine:3.20" });

  assert.deepEqual(calls, [
    {
      executable: "docker",
      args: ["container", "ls", "--format", "{{json .}}"],
    },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.containerName, "redis");
  assert.equal(candidates[0]?.ports[0]?.protocolName, "redis");
});

function createRecordingRunner(
  calls: Array<{ readonly executable: string; readonly args: readonly string[] }>,
  options: { readonly missingInspects: boolean },
): ContainerCommandRunner {
  return async (executable, args) => {
    calls.push({ executable, args });

    if (options.missingInspects && args.includes("inspect")) {
      throw new Error("missing");
    }

    return { stdout: `${executable} ok`, stderr: "" };
  };
}

function createNetwork(overrides: Partial<LogicalNetwork> = {}): LogicalNetwork {
  return {
    id: "network-1",
    name: "A app",
    status: "running",
    runtimeKind: "container",
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
    targetAddress: "0.0.0.0",
    targetPort: 3000,
    protocol: "tcp",
    status: "active",
    createdAt: "2026-06-22T00:01:00.000Z",
    ...overrides,
  };
}

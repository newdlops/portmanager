import assert from "node:assert/strict";
import test from "node:test";

import {
  ContainerNetworkRuntimeAdapter,
  type ContainerCommandRunner,
} from "../../src/platform/network/container-runtime";
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

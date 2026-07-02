import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  ContainerNetworkRuntimeAdapter,
  type ContainerCommandRunner,
} from "../../src/platform/network/container-runtime";
import { ComposePublishMutator } from "../../src/platform/network/compose-publish-mutator";
import {
  buildExistingCloneMutationFromCandidate,
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
      Labels:
        "com.docker.compose.project=workspace,com.docker.compose.service=postgres,com.docker.compose.project.working_dir=/workspace,com.docker.compose.project.config_files=/workspace/compose.yaml,/workspace/compose.override.yaml",
    },
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, "docker:abc123");
  assert.equal(candidates[0]?.composeProject, "workspace");
  assert.equal(candidates[0]?.composeService, "postgres");
  assert.equal(candidates[0]?.composeWorkingDirectory, "/workspace");
  assert.deepEqual(candidates[0]?.composeConfigFiles, [
    "/workspace/compose.yaml",
    "/workspace/compose.override.yaml",
  ]);
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

test("discovers Docker Desktop compose published ports from labels", () => {
  const candidates = parseContainerRows("docker", [
    {
      ID: "desktop123",
      Names: "captain_db",
      Image: "postgres:17-alpine",
      Status: "Up 5 minutes",
      Ports: "5432/tcp",
      Labels:
        "com.docker.compose.project=docker,com.docker.compose.service=db," +
        "com.docker.compose.project.working_dir=/Users/lky/project/captain/docker," +
        "com.docker.compose.project.config_files=/Users/lky/project/captain/docker/development.yaml," +
        "desktop.docker.io/ports.scheme=v2,desktop.docker.io/ports/5432/tcp=:15432",
    },
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.composeProject, "docker");
  assert.equal(candidates[0]?.composeService, "db");
  assert.deepEqual(candidates[0]?.composeConfigFiles, ["/Users/lky/project/captain/docker/development.yaml"]);
  assert.deepEqual(candidates[0]?.ports[0], {
    serviceName: "db",
    logicalPort: 15432,
    actualHostAddress: "127.0.0.1",
    actualHostPort: 15432,
    containerPort: 5432,
    protocol: "tcp",
    protocolName: "postgresql",
  });
});

test("infers common broker and RPC protocol labels from published compose ports", () => {
  const candidates = parseContainerRows("docker", [
    {
      ID: "mq123",
      Names: "workspace-rabbitmq-1",
      Image: "rabbitmq:3-management",
      Status: "Up 2 minutes",
      Ports:
        "127.0.0.1:5671->5671/tcp, 127.0.0.1:5672->5672/tcp, 127.0.0.1:15672->15672/tcp, " +
        "127.0.0.1:1883->1883/tcp, 127.0.0.1:4222->4222/tcp, 127.0.0.1:9092->9092/tcp, " +
        "127.0.0.1:50051->50051/tcp",
      Labels:
        "com.docker.compose.project=workspace,com.docker.compose.service=rabbitmq,com.docker.compose.project.config_files=/workspace/compose.yaml",
    },
  ]);

  const portsByContainerPort = new Map(
    candidates[0]?.ports.map((port) => [port.containerPort, port.protocolName] as const),
  );

  assert.equal(portsByContainerPort.get(5671), "amqps");
  assert.equal(portsByContainerPort.get(5672), "amqp");
  assert.equal(portsByContainerPort.get(15672), "rabbitmq-management");
  assert.equal(portsByContainerPort.get(1883), "mqtt");
  assert.equal(portsByContainerPort.get(4222), "nats");
  assert.equal(portsByContainerPort.get(9092), "kafka");
  assert.equal(portsByContainerPort.get(50051), "grpc");
});

test("parses Port Manager clone logical-port labels instead of hidden host ports", () => {
  const candidates = parseContainerRows("docker", [
    {
      ID: "clone123",
      Names: "network-postgres-1",
      Image: "postgres:16",
      Status: "Up 2 minutes",
      Ports: "127.0.0.1:61421->5432/tcp",
      Labels:
        "com.docker.compose.project=network-workspace,com.docker.compose.service=postgres,com.docker.compose.project.config_files=/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml,newdlops.portmanager.compose-clone-service=1,newdlops.portmanager.logical-port.5432.tcp=15432",
    },
  ]);

  assert.equal(candidates[0]?.ports[0]?.logicalPort, 15432);
  assert.equal(candidates[0]?.ports[0]?.actualHostPort, 61421);
});

test("recovers Port Manager clone logical ports from stopped original Docker Desktop labels", () => {
  const cloneRow = {
    ID: "clone123",
    Names: "network-postgres-1",
    Image: "postgres:16",
    Status: "Up 2 minutes",
    Ports: "127.0.0.1:61421->5432/tcp",
    Labels:
      "com.docker.compose.project=network-workspace,com.docker.compose.service=postgres,com.docker.compose.project.config_files=/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
  };
  const originalRow = {
    ID: "original123",
    Names: "workspace-postgres-1",
    Image: "postgres:16",
    Status: "Exited (0)",
    Ports: "",
    Labels:
      "com.docker.compose.project=workspace,com.docker.compose.service=postgres,com.docker.compose.project.config_files=/workspace/compose.yaml,desktop.docker.io/ports.scheme=v2,desktop.docker.io/ports/5432/tcp=:15432",
  };

  const candidates = parseContainerRows("docker", [cloneRow], [cloneRow, originalRow]);

  assert.equal(candidates[0]?.ports[0]?.logicalPort, 15432);
  assert.equal(candidates[0]?.ports[0]?.actualHostPort, 61421);
});

test("recovers existing Port Manager clone metadata for non-destructive reattach", () => {
  const cloneRow = {
    ID: "clone123",
    Names: "network-workspace-postgres-1",
    Image: "postgres:16",
    Status: "Up 2 minutes",
    Ports: "127.0.0.1:61421->5432/tcp",
    Labels:
      "com.docker.compose.project=network-workspace,com.docker.compose.service=postgres,com.docker.compose.project.working_dir=/workspace,com.docker.compose.project.config_files=/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml,newdlops.portmanager.compose-clone-service=1,newdlops.portmanager.logical-port.5432.tcp=15432",
  };
  const originalRow = {
    ID: "original123",
    Names: "workspace-postgres-1",
    Image: "postgres:16",
    Status: "Exited (0)",
    Ports: "",
    Labels:
      "com.docker.compose.project=workspace,com.docker.compose.service=postgres,com.docker.compose.project.working_dir=/workspace,com.docker.compose.project.config_files=/workspace/compose.yaml,desktop.docker.io/ports.scheme=v2,desktop.docker.io/ports/5432/tcp=:15432",
  };

  const candidates = parseContainerRows("docker", [cloneRow], [cloneRow, originalRow]);
  const mutation = buildExistingCloneMutationFromCandidate(candidates[0]!);

  assert.equal(candidates[0]?.portManagerClone?.originalProjectName, "workspace");
  assert.equal(candidates[0]?.portManagerClone?.attachedProjectName, "network-workspace");
  assert.deepEqual(candidates[0]?.portManagerClone?.composeFiles, ["/workspace/compose.yaml"]);
  assert.deepEqual(candidates[0]?.portManagerClone?.containerMappings, [
    {
      serviceName: "postgres",
      originalContainerId: "original123",
      originalContainerName: "workspace-postgres-1",
      attachedContainerId: "clone123",
      attachedContainerName: "network-workspace-postgres-1",
    },
  ]);
  assert.equal(mutation?.mode, "clone");
  assert.equal(mutation?.originalProjectName, "workspace");
  assert.equal(mutation?.attachedProjectName, "network-workspace");
  assert.deepEqual(mutation?.composeFiles, ["/workspace/compose.yaml"]);
  assert.equal(mutation?.overrideFile, "/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml");
  assert.deepEqual(mutation?.services, ["postgres"]);
  assert.equal(mutation?.hiddenPorts[0]?.logicalPort, 15432);
  assert.equal(mutation?.hiddenPorts[0]?.actualHostPort, 61421);
  assert.equal(mutation?.originalPorts[0]?.logicalPort, 15432);
  assert.equal(mutation?.originalPorts[0]?.actualHostPort, 15432);
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
    {
      executable: "docker",
      args: ["container", "ls", "-a", "--format", "{{json .}}"],
    },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.containerName, "redis");
  assert.equal(candidates[0]?.ports[0]?.protocolName, "redis");
});

test("recovers persisted clone attachment logical ports from original container labels", async () => {
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (_executable, args) => {
      assert.deepEqual(args, ["container", "ls", "-a", "--format", "{{json .}}"]);
      return {
        stdout: [
          JSON.stringify({
            ID: "original123",
            Names: "workspace-postgres-1",
            Ports: "",
            Labels:
              "com.docker.compose.project=workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,desktop.docker.io/ports.scheme=v2,desktop.docker.io/ports/5432/tcp=:15432",
          }),
        ].join("\n"),
        stderr: "",
      };
    },
  });

  const ports = await adapter.recoverPortManagerClonePorts(
    { containerRuntime: "docker", containerImage: "alpine:3.20" },
    [
      "/workspace/compose.yaml",
      "/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
    ],
    [
      {
        serviceName: "db",
        logicalPort: 61421,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 61421,
        containerPort: 5432,
        protocol: "tcp",
        protocolName: "postgresql",
        processId: "managed-process-2",
      },
    ],
  );

  assert.equal(ports[0]?.logicalPort, 15432);
  assert.equal(ports[0]?.actualHostPort, 61421);
  assert.equal(ports[0]?.processId, "managed-process-2");
});

test("refreshes clone hidden host ports after compose recreates containers", async () => {
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (_executable, args) => {
      if (args.includes("-a")) {
        return {
          stdout: [
            JSON.stringify({
              ID: "clone123",
              Names: "network-workspace-postgres-1",
              Ports: "127.0.0.1:51612->5432/tcp",
              Labels:
                "com.docker.compose.project=network-workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
            }),
            JSON.stringify({
              ID: "original123",
              Names: "workspace-postgres-1",
              Ports: "",
              Labels:
                "com.docker.compose.project=workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,desktop.docker.io/ports.scheme=v2,desktop.docker.io/ports/5432/tcp=:15432",
            }),
          ].join("\n"),
          stderr: "",
        };
      }

      return {
        stdout: JSON.stringify({
          ID: "clone123",
          Names: "network-workspace-postgres-1",
          Ports: "127.0.0.1:51612->5432/tcp",
          Labels:
            "com.docker.compose.project=network-workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
        }),
        stderr: "",
      };
    },
  });

  const ports = await adapter.refreshComposePublishedPorts(
    { containerRuntime: "docker", containerImage: "alpine:3.20" },
    "network-workspace",
    [
      "/workspace/compose.yaml",
      "/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
    ],
    [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 63816,
        containerPort: 5432,
        protocol: "tcp",
        protocolName: "postgresql",
        processId: "managed-process-14",
      },
    ],
  );

  assert.equal(ports[0]?.logicalPort, 15432);
  assert.equal(ports[0]?.actualHostAddress, "127.0.0.1");
  assert.equal(ports[0]?.actualHostPort, 51612);
  assert.equal(ports[0]?.processId, "managed-process-14");
});

test("lists only live compose published ports for daemon route registration", async () => {
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (_executable, args) => {
      if (args.includes("-a")) {
        return {
          stdout: JSON.stringify({
            ID: "stopped123",
            Names: "network-workspace-postgres-1",
            Ports: "",
            Labels:
              "com.docker.compose.project=network-workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
          }),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const ports = await adapter.listLiveComposePublishedPorts(
    { containerRuntime: "docker", containerImage: "alpine:3.20" },
    "network-workspace",
    [
      "/workspace/compose.yaml",
      "/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
    ],
    [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 63816,
        containerPort: 5432,
        protocol: "tcp",
        protocolName: "postgresql",
        processId: "managed-process-14",
      },
    ],
  );

  assert.deepEqual(ports, []);
});

test("rehydrates live Port Manager clone endpoints missing from persisted attachment", async () => {
  const cloneConfigFiles =
    "/workspace/docker/development.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/production1-docker-79b2163a.ports.override.yaml";
  const rows = [
    JSON.stringify({
      ID: "rabbit123",
      Names: "production1-docker-79b2163a-rabbitmq-1",
      Ports: "127.81.154.127:50209->5672/tcp, 127.81.154.127:50208->15672/tcp",
      Labels:
        `com.docker.compose.project=production1-docker-79b2163a,com.docker.compose.service=rabbitmq,com.docker.compose.project.config_files=${cloneConfigFiles},` +
        "newdlops.portmanager.compose-clone-service=1,newdlops.portmanager.logical-port.5672.tcp=5672,newdlops.portmanager.logical-port.15672.tcp=15672",
    }),
    JSON.stringify({
      ID: "db123",
      Names: "captain_db-production1-docker-79b2163a",
      Ports: "127.81.154.127:50205->5432/tcp",
      Labels:
        `com.docker.compose.project=production1-docker-79b2163a,com.docker.compose.service=db,com.docker.compose.project.config_files=${cloneConfigFiles},` +
        "newdlops.portmanager.compose-clone-service=1,newdlops.portmanager.logical-port.5432.tcp=15432",
    }),
  ].join("\n");
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async () => ({ stdout: rows, stderr: "" }),
  });

  const ports = await adapter.listLiveComposePublishedPorts(
    { containerRuntime: "docker", containerImage: "alpine:3.20" },
    "production1-docker-79b2163a",
    ["/workspace/docker/development.yaml"],
    [
      {
        serviceName: "rabbitmq",
        logicalPort: 15672,
        actualHostAddress: "127.81.154.127",
        actualHostPort: 50208,
        containerPort: 15672,
        protocol: "tcp",
      },
    ],
  );
  const portsByServicePort = new Map(ports.map((port) => [`${port.serviceName}:${port.containerPort}`, port]));

  assert.equal(ports.length, 3);
  assert.equal(portsByServicePort.get("db:5432")?.logicalPort, 15432);
  assert.equal(portsByServicePort.get("db:5432")?.actualHostAddress, "127.81.154.127");
  assert.equal(portsByServicePort.get("db:5432")?.actualHostPort, 50205);
  assert.equal(portsByServicePort.get("rabbitmq:5672")?.logicalPort, 5672);
});

test("refreshes clone container hash mappings after compose recreates containers", async () => {
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (_executable, args) => {
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            { Id: "newclone987", Name: "/network-workspace-postgres-1" },
            { Id: "original123", Name: "/workspace-postgres-1" },
          ]),
          stderr: "",
        };
      }
      assert.deepEqual(args, ["container", "ls", "-a", "--format", "{{json .}}"]);
      return {
        stdout: [
          JSON.stringify({
            ID: "newclone987",
            Names: "network-workspace-postgres-1",
            Ports: "127.0.0.1:51612->5432/tcp",
            Labels:
              "com.docker.compose.project=network-workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
          }),
          JSON.stringify({
            ID: "original123",
            Names: "workspace-postgres-1",
            Ports: "",
            Labels:
              "com.docker.compose.project=workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml",
          }),
        ].join("\n"),
        stderr: "",
      };
    },
  });

  const mappings = await adapter.refreshComposeContainerMappings(
    { containerRuntime: "docker", containerImage: "alpine:3.20" },
    "workspace",
    "network-workspace",
    [
      "/workspace/compose.yaml",
      "/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
    ],
    ["db"],
    [
      {
        serviceName: "db",
        originalContainerId: "original123",
        originalContainerName: "workspace-postgres-1",
        attachedContainerId: "oldclone123",
        attachedContainerName: "network-workspace-postgres-1",
      },
      {
        serviceName: "",
        originalContainerId: "olderclone456",
        originalContainerName: "",
        attachedContainerId: "oldclone123",
        attachedContainerName: "network-workspace-postgres-1",
      },
    ],
  );

  assert.deepEqual(mappings, [
    {
      serviceName: "db",
      originalContainerId: "original123",
      originalContainerName: "workspace-postgres-1",
      attachedContainerId: "newclone987",
      attachedContainerName: "network-workspace-postgres-1",
    },
    {
      serviceName: "__portmanager_alias__:db",
      originalContainerId: "oldclone123",
      originalContainerName: "oldclone123",
      attachedContainerId: "newclone987",
      attachedContainerName: "network-workspace-postgres-1",
    },
    {
      serviceName: "__portmanager_alias__:db",
      originalContainerId: "olderclone456",
      originalContainerName: "olderclone456",
      attachedContainerId: "newclone987",
      attachedContainerName: "network-workspace-postgres-1",
    },
  ]);
});

test("refreshes copied clone mappings with original compose container aliases", async () => {
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (_executable, args) => {
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            { Id: "original123", Name: "/captain_db" },
            { Id: "previous456", Name: "/captain_db-migration" },
            { Id: "current789", Name: "/captain_db-worktree" },
          ]),
          stderr: "",
        };
      }

      return {
        stdout: [
          JSON.stringify({
            ID: "original123",
            Names: "captain_db",
            Ports: "",
            Labels:
              "com.docker.compose.project=docker,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml",
          }),
          JSON.stringify({
            ID: "previous456",
            Names: "captain_db-migration",
            Ports: "",
            Labels:
              "com.docker.compose.project=migration,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,/tmp/migration.ports.override.yaml",
          }),
          JSON.stringify({
            ID: "current789",
            Names: "captain_db-worktree",
            Ports: "127.0.0.1:51612->5432/tcp",
            Labels:
              "com.docker.compose.project=worktree,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,/tmp/worktree.ports.override.yaml",
          }),
        ].join("\n"),
        stderr: "",
      };
    },
  });

  const mappings = await adapter.refreshComposeContainerMappings(
    { containerRuntime: "docker", containerImage: "alpine:3.20" },
    "migration",
    "worktree",
    ["/workspace/compose.yaml"],
    ["db"],
    [
      {
        serviceName: "db",
        originalContainerId: "previous456",
        originalContainerName: "captain_db-migration",
        attachedContainerId: "current789",
        attachedContainerName: "captain_db-worktree",
      },
    ],
  );

  assert.deepEqual(mappings, [
    {
      serviceName: "db",
      originalContainerId: "previous456",
      originalContainerName: "captain_db-migration",
      attachedContainerId: "current789",
      attachedContainerName: "captain_db-worktree",
    },
    {
      serviceName: "__portmanager_alias__:db",
      originalContainerId: "original123",
      originalContainerName: "captain_db",
      attachedContainerId: "current789",
      attachedContainerName: "captain_db-worktree",
    },
  ]);
});

test("refreshes clone container mappings with inspect names when list rows omit names", async () => {
  const mutableCalls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (_executable, args) => {
      mutableCalls.push([...args]);
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            { Id: "newclone987", Name: "/network-workspace-postgres-1" },
            { Id: "original123", Name: "/workspace-postgres-1" },
          ]),
          stderr: "",
        };
      }

      return {
        stdout: [
          JSON.stringify({
            ID: "newclone987",
            Ports: "127.0.0.1:51612->5432/tcp",
            Labels:
              "com.docker.compose.project=network-workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
          }),
          JSON.stringify({
            ID: "original123",
            Ports: "",
            Labels:
              "com.docker.compose.project=workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml",
          }),
          JSON.stringify({
            ID: "unrelated999",
            Ports: "",
            Labels:
              "com.docker.compose.project=unrelated,com.docker.compose.service=cache,com.docker.compose.project.config_files=/other/compose.yaml",
          }),
        ].join("\n"),
        stderr: "",
      };
    },
  });

  const mappings = await adapter.refreshComposeContainerMappings(
    { containerRuntime: "docker", containerImage: "alpine:3.20" },
    "workspace",
    "network-workspace",
    [
      "/workspace/compose.yaml",
      "/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
    ],
    ["db"],
    [
      {
        serviceName: "db",
        originalContainerId: "original123",
        originalContainerName: "stale-original-name",
        attachedContainerId: "oldclone123",
        attachedContainerName: "stale-clone-name",
      },
    ],
  );

  assert.deepEqual(mutableCalls, [
    ["container", "ls", "-a", "--format", "{{json .}}"],
    ["container", "inspect", "newclone987", "original123"],
  ]);
  assert.deepEqual(mappings[0], {
    serviceName: "db",
    originalContainerId: "original123",
    originalContainerName: "workspace-postgres-1",
    attachedContainerId: "newclone987",
    attachedContainerName: "network-workspace-postgres-1",
  });
});

test("reuses compose discovery rows within one refresh session", async () => {
  const cloneConfigFiles =
    "/workspace/compose.yaml,/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml";
  const runningRows = [
    JSON.stringify({
      ID: "newclone987",
      Names: "network-workspace-postgres-1",
      Ports: "127.0.0.1:51612->5432/tcp",
      Labels:
        `com.docker.compose.project=network-workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=${cloneConfigFiles},` +
        "newdlops.portmanager.compose-clone-service=1,newdlops.portmanager.logical-port.5432.tcp=15432",
    }),
  ].join("\n");
  const allRows = [
    runningRows,
    JSON.stringify({
      ID: "original123",
      Names: "workspace-postgres-1",
      Ports: "",
      Labels: "com.docker.compose.project=workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=/workspace/compose.yaml",
    }),
  ].join("\n");
  const mutableCalls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({
    runCommand: async (_executable, args) => {
      mutableCalls.push([...args]);
      if (args.includes("-a")) {
        return { stdout: allRows, stderr: "" };
      }

      return { stdout: runningRows, stderr: "" };
    },
  });

  const session = await adapter.createSession({ containerRuntime: "docker", containerImage: "alpine:3.20" });
  assert.ok(session);

  const livePorts = session.listLiveComposePublishedPorts(
    "network-workspace",
    ["/workspace/compose.yaml"],
    [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 63816,
        containerPort: 5432,
        protocol: "tcp",
        protocolName: "postgresql",
      },
    ],
  );
  const mappings = await session.refreshComposeContainerMappings(
    "workspace",
    "network-workspace",
    [
      "/workspace/compose.yaml",
      "/Users/lky/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/compose-overrides/network-workspace.ports.override.yaml",
    ],
    ["db"],
    [
      {
        serviceName: "db",
        originalContainerId: "original123",
        originalContainerName: "workspace-postgres-1",
        attachedContainerId: "oldclone123",
        attachedContainerName: "network-workspace-postgres-1",
      },
    ],
  );

  assert.deepEqual(mutableCalls, [
    ["container", "ls", "--format", "{{json .}}"],
    ["container", "ls", "-a", "--format", "{{json .}}"],
  ]);
  assert.equal(livePorts[0]?.actualHostPort, 51612);
  assert.equal(livePorts[0]?.logicalPort, 15432);
  assert.equal(mappings[0]?.attachedContainerId, "newclone987");
  assert.equal(mappings[0]?.attachedContainerName, "network-workspace-postgres-1");
});

test("mutates compose services with inspect container names when list rows omit names", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-inspect-names-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n    container_name: captain_postgres\n",
    "utf8",
  );
  let containerListCount = 0;
  const inspectCalls: string[][] = [];
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        if (containerListCount === 1) {
          return {
            stdout: [
              JSON.stringify({
                ID: "original123",
                Ports: "127.0.0.1:15432->5432/tcp",
                Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
              }),
              JSON.stringify({
                ID: "stale456",
                Ports: "",
                Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
              }),
              JSON.stringify({
                ID: "unrelated789",
                Ports: "",
                Labels: "com.docker.compose.project=workspace,com.docker.compose.service=cache",
              }),
            ].join("\n"),
            stderr: "",
          };
        }

        return {
          stdout: JSON.stringify({
            ID: "hidden123",
            Ports: "127.0.0.1:57001->5432/tcp",
            Labels: "com.docker.compose.project=a-app-workspace-bc74e5f2,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        const ids = args.slice(2);
        inspectCalls.push([...ids]);
        return {
          stdout: JSON.stringify(
            ids.map((id) => ({
              Id: id,
              Name:
                id === "original123"
                  ? "/captain_postgres"
                  : id === "hidden123"
                    ? "/captain_postgres-a-app-workspace-bc74e5f2"
                    : "/stale_workspace_postgres",
              Config: {
                Labels: {
                  "com.docker.compose.service": "postgres",
                },
              },
              Mounts:
                id === "stale456"
                  ? [
                      {
                        Type: "volume",
                        Name: "stale_pgdata",
                        Source: "/var/lib/docker/volumes/stale_pgdata/_data",
                        Destination: "/var/lib/postgresql/data",
                        RW: true,
                      },
                    ]
                  : [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
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
  });

  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "postgres",
      originalContainerId: "original123",
      originalContainerName: "captain_postgres",
      attachedContainerId: "hidden123",
      attachedContainerName: "captain_postgres-a-app-workspace-bc74e5f2",
    },
  ]);
  const overrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.match(overrideText, /container_name: 'captain_postgres-a-app-workspace-bc74e5f2'/);
  assert.doesNotMatch(overrideText, /pm-captain_postgres/);
  assert.deepEqual(inspectCalls[0], ["original123", "stale456"]);
});

test("mutates compose services into a hidden network-scoped project", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const staleOverrideFile = path.join(tempDir, "a-app-workspace-bc74e5f2.ports.override.yaml");
  const initdbDir = path.join(tempDir, "initdb");
  fs.mkdirSync(initdbDir, { recursive: true });
  fs.writeFileSync(path.join(initdbDir, "restore.sql"), "select 1;\n", "utf8");
  fs.writeFileSync(
    composeFile,
    [
      "name: workspace",
      "services:",
      "  postgres:",
      "    image: postgres:16",
      "  langgraph_server:",
      "    image: langgraph:latest",
      "    container_name: captain_langgraph_server",
      "    ports:",
      "      - 9002:9002",
      "",
    ].join("\n"),
    "utf8",
  );

  const calls: Array<{
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
  }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args, options) => {
      calls.push({
        executable,
        args,
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "postgres\nlanggraph_server\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        if (containerListCount === 1) {
          return {
            stdout: JSON.stringify({
              ID: "original123",
              Names: "workspace-postgres-1",
              Ports: "127.0.0.1:15432->5432/tcp",
              Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
            }),
            stderr: "",
          };
        }

        return {
          stdout: JSON.stringify({
            ID: "hidden123",
            Names: "a-app-workspace-bc74e5f2-postgres-1",
            Ports: "127.81.154.127:57001->5432/tcp",
            Labels:
              "com.docker.compose.project=a-app-workspace-bc74e5f2,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "original123",
              Config: {
                Labels: {
                  "com.docker.compose.service": "postgres",
                },
              },
              Mounts: [
                {
                  Type: "volume",
                  Name: "workspace_pgdata",
                  Source: "/var/lib/docker/volumes/workspace_pgdata/_data",
                  Destination: "/var/lib/postgresql/data",
                  RW: true,
                },
                {
                  Type: "bind",
                  Source: initdbDir,
                  Destination: "/docker-entrypoint-initdb.d",
                  RW: false,
                },
              ],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    allowStatefulClone: true,
    runtime: "docker",
    networkName: "A app",
    hiddenHostAddress: "127.81.154.127",
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile, staleOverrideFile],
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
  });

  assert.equal(result.state.originalProjectName, "workspace");
  assert.equal(result.state.mode, "clone");
  assert.equal(result.state.attachedProjectName, "a-app-workspace-bc74e5f2");
  assert.deepEqual(result.state.composeFiles, [composeFile]);
  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "postgres",
      originalContainerId: "original123",
      originalContainerName: "workspace-postgres-1",
      attachedContainerId: "hidden123",
      attachedContainerName: "a-app-workspace-bc74e5f2-postgres-1",
    },
  ]);
  assert.equal(result.ports[0]?.logicalPort, 15432);
  assert.equal(result.ports[0]?.actualHostAddress, "127.81.154.127");
  assert.equal(result.ports[0]?.actualHostPort, 57001);
  assert.equal(result.state.clonedVolumes?.length, 2);
  const dataVolume = result.state.clonedVolumes?.find((volume) => volume.containerPath === "/var/lib/postgresql/data");
  assert.equal(dataVolume?.serviceName, "postgres");
  assert.equal(dataVolume?.sourceKind, "volume");
  assert.equal(dataVolume?.sourceName, "workspace_pgdata");
  assert.equal(dataVolume?.readOnly, false);
  assert.match(dataVolume?.targetVolumeName ?? "", /^pm-a-app-workspace-bc74e5f2-[a-f0-9]{12}-[a-f0-9]{8}$/);
  const restoreVolume = result.state.clonedVolumes?.find((volume) => volume.containerPath === "/docker-entrypoint-initdb.d");
  assert.equal(restoreVolume?.serviceName, "postgres");
  assert.equal(restoreVolume?.sourceKind, "bind");
  assert.equal(restoreVolume?.sourceName, initdbDir);
  assert.equal(restoreVolume?.readOnly, true);
  assert.match(restoreVolume?.targetVolumeName ?? "", /^pm-a-app-workspace-bc74e5f2-[a-f0-9]{12}-[a-f0-9]{8}$/);
  const overrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.match(overrideText, /container_name: !reset null/);
  assert.doesNotMatch(overrideText, /container_name: 'captain_langgraph_server'/);
  assert.doesNotMatch(overrideText, /container_name: 'a-app-workspace-bc74e5f2-postgres-1'/);
  assert.match(overrideText, /network_mode: !reset null/);
  assert.match(overrideText, /networks: !override/);
  assert.match(overrideText, /pm_isolated/);
  assert.match(overrideText, /ports: !override/);
  assert.match(overrideText, /newdlops\.portmanager\.compose-clone-service: '1'/);
  assert.match(overrideText, /'?newdlops\.portmanager\.logical-port\.5432\.tcp'?: '15432'/);
  assert.match(overrideText, /127\.81\.154\.127::5432\/tcp/);
  assert.match(overrideText, /volumes: !override/);
  assert.match(overrideText, /target: '\/var\/lib\/postgresql\/data'/);
  assert.match(overrideText, /target: '\/docker-entrypoint-initdb\.d'/);
  assert.doesNotMatch(overrideText, /type: bind/);
  assert.match(overrideText, /external: true/);
  assert.doesNotMatch(overrideText, /name: 'workspace_pgdata'/);
  assert.match(overrideText, /name: 'pm-a-app-workspace-bc74e5f2-[a-f0-9]{12}-[a-f0-9]{8}'/);
  assert.match(overrideText, /read_only: true/);
  assert.match(overrideText, /'langgraph_server':/);
  assert.match(overrideText, /profiles: !override\n      - 'pm_unattached'/);
  assert.match(overrideText, /ports: !override \[\]/);

  assert.deepEqual(calls.map((call) => call.args[0]), [
    "compose",
    "container",
    "container",
    "container",
    "compose",
    "volume",
    "run",
    "volume",
    "run",
    "compose",
    "container",
    "container",
    "container",
    "container",
  ]);
  assert.deepEqual(calls[0]?.args, ["compose", "-p", "workspace", "-f", composeFile, "config", "--services"]);
  assert.deepEqual(calls[9]?.args.slice(0, 8), [
    "compose",
    "-p",
    "a-app-workspace-bc74e5f2",
    "-f",
    composeFile,
    "-f",
    result.state.overrideFile,
    "up",
  ]);
  assert.equal(calls[6]?.args.includes("workspace_pgdata:/from:ro"), true);
  assert.equal(calls[8]?.args.includes(`${initdbDir}:/from:ro`), true);
  assert.equal(calls[0]?.cwd, tempDir);
  assert.equal(calls[4]?.cwd, tempDir);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "container" && call.args[1] === "inspect")
      .map((call) => call.timeoutMs),
    [30_000, 30_000, 30_000],
  );
});

test("compose hidden publish can preserve logical ports on network loopback hosts", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    [
      "name: workspace",
      "services:",
      "  postgres:",
      "    image: postgres:16",
      "",
    ].join("\n"),
    "utf8",
  );

  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify(
            containerListCount === 1
              ? {
                  ID: "original123",
                  Names: "workspace-postgres-1",
                  Ports: "127.0.0.1:15432->5432/tcp",
                  Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
                }
              : {
                  ID: "hidden123",
                  Names: "a-app-workspace-bc74e5f2-postgres-1",
                  Ports: "127.81.154.127:15432->5432/tcp",
                  Labels:
                    "com.docker.compose.project=a-app-workspace-bc74e5f2,com.docker.compose.service=postgres",
                },
          ),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name: id === "hidden123" ? "/a-app-workspace-bc74e5f2-postgres-1" : "/workspace-postgres-1",
              Config: {
                Labels: {
                  "com.docker.compose.service": "postgres",
                },
              },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    hiddenHostAddress: "127.81.154.127",
    preservePublishedHostPorts: true,
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
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
  });

  const overrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.match(overrideText, /'127\.81\.154\.127:15432:5432\/tcp'/);
  assert.doesNotMatch(overrideText, /127\.81\.154\.127::5432\/tcp/);
  assert.equal(result.ports[0]?.logicalPort, 15432);
  assert.equal(result.ports[0]?.actualHostAddress, "127.81.154.127");
  assert.equal(result.ports[0]?.actualHostPort, 15432);
});

test("clone attach carries running internal compose services without stopping their originals", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-internal-service-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  app:",
      "    image: app:latest",
      "    ports:",
      "      - 18000:8000",
      "  rabbitmq:",
      "    image: rabbitmq:3-management",
      "    volumes:",
      "      - rabbitmq_data:/var/lib/rabbitmq",
      "volumes:",
      "  rabbitmq_data:",
      "",
    ].join("\n"),
    "utf8",
  );

  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  let hiddenStarted = false;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "app\nrabbitmq\n", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("up")) {
        hiddenStarted = true;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && (args[1] === "ls" || args[1] === "ps")) {
        const rows = [
          {
            ID: "source-app",
            Names: "captain-app-1",
            Status: "Up 10 minutes",
            Ports: "127.0.0.1:18000->8000/tcp",
            Labels: "com.docker.compose.project=captain,com.docker.compose.service=app",
          },
          {
            ID: "source-rabbit",
            Names: "captain-rabbitmq-1",
            Status: "Up 10 minutes",
            Ports: "",
            Labels: "com.docker.compose.project=captain,com.docker.compose.service=rabbitmq",
          },
          ...(hiddenStarted
            ? [
                {
                  ID: "hidden-app",
                  Names: "alpha-captain-app-1",
                  Status: "Up 1 second",
                  Ports: "127.81.154.127:57000->8000/tcp",
                  Labels: "com.docker.compose.project=alpha-captain,com.docker.compose.service=app",
                },
                {
                  ID: "hidden-rabbit",
                  Names: "alpha-captain-rabbitmq-1",
                  Status: "Up 1 second",
                  Ports: "",
                  Labels: "com.docker.compose.project=alpha-captain,com.docker.compose.service=rabbitmq",
                },
              ]
            : []),
        ];
        return { stdout: rows.map((row) => JSON.stringify(row)).join("\n"), stderr: "" };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        const services = new Map([
          ["source-app", "app"],
          ["source-rabbit", "rabbitmq"],
          ["hidden-app", "app"],
          ["hidden-rabbit", "rabbitmq"],
        ]);
        const names = new Map([
          ["source-app", "captain-app-1"],
          ["source-rabbit", "captain-rabbitmq-1"],
          ["hidden-app", "alpha-captain-app-1"],
          ["hidden-rabbit", "alpha-captain-rabbitmq-1"],
        ]);
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name: `/${names.get(id) ?? id}`,
              Config: {
                Labels: {
                  "com.docker.compose.service": services.get(id) ?? "",
                },
              },
              Mounts:
                id === "source-rabbit"
                  ? [
                      {
                        Type: "volume",
                        Name: "captain_rabbitmq_data",
                        Source: "/var/lib/docker/volumes/captain_rabbitmq_data/_data",
                        Destination: "/var/lib/rabbitmq",
                        RW: true,
                      },
                    ]
                  : [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    allowStatefulClone: true,
    attachedProjectName: "alpha-captain",
    runtime: "docker",
    networkName: "alpha",
    hiddenHostAddress: "127.81.154.127",
    originalProjectName: "captain",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "app",
        logicalPort: 18000,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 18000,
        containerPort: 8000,
        protocol: "tcp",
      },
    ],
  });

  const composeCalls = calls.filter((call) => call.args[0] === "compose").map((call) => call.args);
  const stopCall = composeCalls.find((args) => args.includes("stop"));
  const upCall = composeCalls.find((args) => args.includes("up"));

  assert.deepEqual(stopCall?.slice(stopCall.indexOf("stop")), ["stop", "app"]);
  assert.equal(upCall?.includes("app"), true);
  assert.equal(upCall?.includes("rabbitmq"), true);
  assert.deepEqual(result.state.services, ["app", "rabbitmq"]);
  assert.deepEqual(
    result.state.containerMappings?.map((mapping) => mapping.serviceName),
    ["app", "rabbitmq"],
  );
  assert.equal(result.ports.length, 1);
  assert.equal(result.ports[0]?.serviceName, "app");
  assert.equal(result.state.clonedVolumes?.[0]?.serviceName, "rabbitmq");

  const overrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.match(overrideText, /'rabbitmq':/);
  assert.doesNotMatch(overrideText, /'rabbitmq':\n    container_name: !reset null\n    network_mode: !reset null\n    links: !reset \[\]\n    external_links: !reset \[\]\n    profiles: !override/);
  assert.match(overrideText, /target: '\/var\/lib\/rabbitmq'/);
  assert.match(overrideText, /name: 'pm-alpha-captain-[a-f0-9]{12}-[a-f0-9]{8}'/);
});

test("copy mode creates stopped langgraph_server discovered from compose ps", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-copy-stopped-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    [
      "name: workspace",
      "services:",
      "  db:",
      "    image: postgres:16",
      "  langgraph_server:",
      "    image: busybox",
      "    command: sleep 3600",
      "    ports:",
      "      - 9002:9002",
      "",
    ].join("\n"),
    "utf8",
  );

  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  let targetStarted = false;
  let targetCreated = false;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("ps") && args.includes("--all") && args.includes("--services")) {
        return { stdout: "db\nlanggraph_server\n", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("up") && args.includes("db")) {
        targetStarted = true;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("create") && args.includes("langgraph_server")) {
        targetCreated = true;
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        const includeStopped = args.includes("--all");
        const sourceRows = [
          {
            ID: "source-db",
            Names: "workspace_db_1",
            Status: "Up 10 seconds",
            Ports: "127.0.0.1:15432->5432/tcp",
            Labels: "com.docker.compose.project=workspace,com.docker.compose.service=db",
          },
          ...(includeStopped
            ? [
                {
                  ID: "source-worker",
                  Names: "workspace_langgraph_server_1",
                  Status: "Exited (0) 1 minute ago",
                  Ports: "127.0.0.1:19002->9002/tcp",
                  Labels: "com.docker.compose.project=workspace,com.docker.compose.service=langgraph_server",
                },
              ]
            : []),
        ];
        const targetRows = targetStarted
          ? [
              {
                ID: "target-db",
                Names: "copy_stack_db_1",
                Status: "Up 1 second",
                Ports: "127.0.0.1:57001->5432/tcp",
                Labels: "com.docker.compose.project=copy-stack,com.docker.compose.service=db",
              },
              ...(targetCreated && includeStopped
                ? [
                    {
                      ID: "target-worker",
                      Names: "copy_stack_langgraph_server_1",
                      Status: "Created",
                      Ports: "127.0.0.1:57002->9002/tcp",
                      Labels: "com.docker.compose.project=copy-stack,com.docker.compose.service=langgraph_server",
                    },
                  ]
                : []),
            ]
          : [];
        return { stdout: [...sourceRows, ...targetRows].map((row) => JSON.stringify(row)).join("\n"), stderr: "" };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        const containerNames = new Map([
          ["source-db", "workspace_db_1"],
          ["source-worker", "workspace_langgraph_server_1"],
          ["target-db", "copy_stack_db_1"],
          ["target-worker", "copy_stack_langgraph_server_1"],
        ]);
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name: `/${containerNames.get(id) ?? id}`,
              Config: {
                Labels: {
                  "com.docker.compose.project": id.startsWith("target") ? "copy-stack" : "workspace",
                  "com.docker.compose.service": id.includes("worker") ? "langgraph_server" : "db",
                },
              },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    mode: "copy",
    runtime: "docker",
    networkName: "B app",
    originalProjectName: "workspace",
    attachedProjectName: "copy-stack",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    copyStoppedServices: true,
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
        protocolName: "postgresql",
      },
      {
        serviceName: "langgraph_server",
        logicalPort: 9002,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 19002,
        containerPort: 9002,
        protocol: "tcp",
      },
    ],
  });

  assert.equal(result.state.mode, "copy");
  assert.deepEqual(result.state.services, ["db", "langgraph_server"]);
  assert.ok(calls.some((call) => call.args.includes("up") && call.args.includes("db")));
  assert.equal(calls.some((call) => call.args.includes("up") && call.args.includes("langgraph_server")), false);
  assert.ok(calls.some((call) => call.args.includes("create") && call.args.includes("langgraph_server")));
  assert.ok(calls.some((call) => call.args[0] === "container" && call.args[1] === "ls" && call.args.includes("--all")));
  assert.equal(calls.some((call) => call.args.includes("stop") && call.args.includes("workspace")), false);
  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "db",
      originalContainerId: "source-db",
      originalContainerName: "workspace_db_1",
      attachedContainerId: "target-db",
      attachedContainerName: "copy_stack_db_1",
    },
    {
      serviceName: "langgraph_server",
      originalContainerId: "source-worker",
      originalContainerName: "workspace_langgraph_server_1",
      attachedContainerId: "target-worker",
      attachedContainerName: "copy_stack_langgraph_server_1",
    },
  ]);
  assert.equal(result.ports[0]?.actualHostPort, 57001);
  assert.equal(result.ports[1], undefined);
});

test("copies an existing compose clone without stacking the network-scoped project name", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-existing-clone-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "a-app-workspace-bc74e5f2.ports.override.yaml");
  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  fs.writeFileSync(overrideFile, "services: {}\n", "utf8");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  let lastStartedProject = "";
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("up")) {
        lastStartedProject = args[args.indexOf("-p") + 1] ?? "";
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const composeProject = containerListCount === 1 ? "a-app-workspace-bc74e5f2" : lastStartedProject;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "source123" : "hidden123",
            Names: `${composeProject}-postgres-1`,
            Ports: `127.0.0.1:${containerListCount === 1 ? 57001 : 57002}->5432/tcp`,
            Labels: `com.docker.compose.project=${composeProject},com.docker.compose.service=postgres`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: args.includes("hidden123") ? "hidden123" : "source123",
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "a-app-workspace-bc74e5f2",
    workingDirectory: tempDir,
    composeFiles: [composeFile, overrideFile],
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
  });

  const composeProjectArgs = calls
    .filter((call) => call.args[0] === "compose")
    .map((call) => call.args[call.args.indexOf("-p") + 1]);
  assert.deepEqual(composeProjectArgs.slice(0, 2), [
    "a-app-workspace-bc74e5f2",
    "a-app-workspace-bc74e5f2",
  ]);
  assert.match(composeProjectArgs[2] ?? "", /^a-app-workspace-bc74e5f2-[a-f0-9]{8}$/);
  assert.equal(result.state.originalProjectName, "a-app-workspace-bc74e5f2");
  assert.match(result.state.attachedProjectName, /^a-app-workspace-bc74e5f2-[a-f0-9]{8}$/);
  assert.notEqual(result.state.attachedProjectName, "a-app-workspace-bc74e5f2");
  assert.equal(result.state.overrideFile, path.join(tempDir, `${result.state.attachedProjectName}.ports.override.yaml`));
  assert.deepEqual(result.state.composeFiles, [composeFile]);
  assert.deepEqual(result.state.services, ["postgres"]);
  assert.equal(result.state.originalPorts[0]?.actualHostPort, 57001);
  assert.equal(result.state.hiddenPorts[0]?.actualHostPort, 57002);
  assert.equal(result.ports[0]?.actualHostPort, 57002);
});

test("does not stack attached compose project names when clone labels omit the generated override", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-stacked-clone-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const canonicalProjectName = "a-app-captain-92c894fb";
  const stackedProjectName = "a-app-a-app-workspace-bc74e5f2-44556c4d";
  fs.writeFileSync(composeFile, "name: captain\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const composeProject = containerListCount === 1 ? stackedProjectName : canonicalProjectName;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "stacked123" : "hidden123",
            Names: `${composeProject}-postgres-1`,
            Ports: `127.0.0.1:${containerListCount === 1 ? 57001 : 57002}->5432/tcp`,
            Labels: `com.docker.compose.project=${composeProject},com.docker.compose.service=postgres`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "stacked123",
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: stackedProjectName,
    workingDirectory: tempDir,
    composeFiles: [composeFile],
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
  });

  const composeProjectArgs = calls
    .filter((call) => call.args[0] === "compose")
    .map((call) => call.args[call.args.indexOf("-p") + 1]);
  assert.equal(result.state.attachedProjectName, canonicalProjectName);
  assert.equal(result.state.overrideFile, path.join(tempDir, `${canonicalProjectName}.ports.override.yaml`));
  assert.deepEqual(composeProjectArgs, [stackedProjectName, stackedProjectName, canonicalProjectName]);
  assert.equal(composeProjectArgs.some((projectName) => projectName?.startsWith("a-app-a-app-a-app-")), false);
});

test("uses an explicit compose clone project name", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-custom-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const composeProject = containerListCount === 1 ? "workspace" : "qa-copy";
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "source123" : "hidden123",
            Names: `${composeProject}-postgres-1`,
            Ports: `127.0.0.1:${containerListCount === 1 ? 15432 : 57003}->5432/tcp`,
            Labels: `com.docker.compose.project=${composeProject},com.docker.compose.service=postgres`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    attachedProjectName: "qa-copy",
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
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
  });

  const composeProjectArgs = calls
    .filter((call) => call.args[0] === "compose")
    .map((call) => call.args[call.args.indexOf("-p") + 1]);
  assert.equal(result.state.attachedProjectName, "qa-copy");
  assert.equal(result.state.overrideFile, path.join(tempDir, "qa-copy.ports.override.yaml"));
  assert.deepEqual(composeProjectArgs, ["workspace", "workspace", "qa-copy"]);
  assert.equal(result.ports[0]?.actualHostPort, 57003);
  assert.match(fs.readFileSync(result.state.overrideFile, "utf8"), /container_name: !reset null/);
  assert.doesNotMatch(fs.readFileSync(result.state.overrideFile, "utf8"), /container_name: 'qa-copy-postgres-1'/);
});

test("rejects an explicit compose clone project name reserved by the runtime", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-custom-name-conflict-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "qa-copy.ports.override.yaml");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];

  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ps") {
        return {
          stdout: JSON.stringify({
            ID: "reserved123",
            Names: "qa-copy-postgres-1",
            Ports: "",
            Labels: "com.docker.compose.project=qa-copy,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "ls") {
        return {
          stdout: JSON.stringify({
            ID: "source123",
            Names: "workspace-postgres-1",
            Ports: "127.0.0.1:15432->5432/tcp",
            Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "source123",
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () =>
      mutator.hidePublishedPorts({
        attachedProjectName: "qa-copy",
        runtime: "docker",
        networkName: "A app",
        originalProjectName: "workspace",
        workingDirectory: tempDir,
        composeFiles: [composeFile],
        ports: [
          {
            serviceName: "postgres",
            logicalPort: 15432,
            actualHostAddress: "127.0.0.1",
            actualHostPort: 15432,
            containerPort: 5432,
            protocol: "tcp",
          },
        ],
      }),
    /Compose project name "qa-copy" is already in use by docker/,
  );

  assert.equal(calls.some((call) => call.args[0] === "compose" && call.args.includes("up")), false);
  assert.equal(fs.existsSync(overrideFile), false);
});

test("renames an attached compose clone without recopying cloned volumes", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-rename-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const oldOverrideFile = path.join(tempDir, "old-copy.ports.override.yaml");
  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n  worker:\n    image: worker:latest\n", "utf8");
  fs.writeFileSync(oldOverrideFile, "services: {}\n", "utf8");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\nworker\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const composeProject = containerListCount === 1 ? "old-copy" : "new-copy";
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "old123" : "new123",
            Names: `${composeProject}-postgres-1`,
            Ports: `127.0.0.1:${containerListCount === 1 ? 57001 : 57002}->5432/tcp`,
            Labels: `com.docker.compose.project=${composeProject},com.docker.compose.service=postgres`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts:
                id === "old123"
                  ? [
                      {
                        Type: "volume",
                        Name: "pm-old-volume",
                        Source: "/var/lib/docker/volumes/pm-old-volume/_data",
                        Destination: "/var/lib/postgresql/data",
                        RW: true,
                      },
                    ]
                  : [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.renameAttachedProject(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "workspace",
      attachedProjectName: "old-copy",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["postgres"],
      overrideFile: oldOverrideFile,
      originalPorts: [
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
      hiddenPorts: [
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
      containerMappings: [
        {
          serviceName: "postgres",
          originalContainerId: "source123",
          originalContainerName: "workspace-postgres-1",
          attachedContainerId: "old123",
          attachedContainerName: "old-copy-postgres-1",
        },
      ],
      clonedVolumeNames: ["pm-old-volume"],
    },
    "new-copy",
  );

  const composeProjectArgs = calls
    .filter((call) => call.args[0] === "compose")
    .map((call) => call.args[call.args.indexOf("-p") + 1]);
  assert.deepEqual(composeProjectArgs, ["workspace", "old-copy", "new-copy", "old-copy"]);
  assert.equal(result.state.attachedProjectName, "new-copy");
  assert.equal(result.state.overrideFile, path.join(tempDir, "new-copy.ports.override.yaml"));
  assert.equal(result.state.hiddenPorts[0]?.actualHostPort, 57002);
  assert.deepEqual(result.state.clonedVolumeNames, ["pm-old-volume"]);
  assert.equal(calls.some((call) => call.args[0] === "volume"), false);
  assert.match(fs.readFileSync(result.state.overrideFile, "utf8"), /container_name: !reset null/);
  assert.doesNotMatch(fs.readFileSync(result.state.overrideFile, "utf8"), /container_name: 'new-copy-postgres-1'/);
  assert.match(fs.readFileSync(result.state.overrideFile, "utf8"), /name: 'pm-old-volume'/);
  assert.match(fs.readFileSync(result.state.overrideFile, "utf8"), /profiles: !override\n      - 'pm_unattached'/);
});

test("rejects compose clone rename to a runtime-reserved project before stopping the clone", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-rename-conflict-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const oldOverrideFile = path.join(tempDir, "old-copy.ports.override.yaml");
  const newOverrideFile = path.join(tempDir, "new-copy.ports.override.yaml");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];

  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  fs.writeFileSync(oldOverrideFile, "services: {}\n", "utf8");
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ps") {
        return {
          stdout: JSON.stringify({
            ID: "reserved123",
            Names: "new-copy-postgres-1",
            Ports: "",
            Labels: "com.docker.compose.project=new-copy,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "ls") {
        return {
          stdout: JSON.stringify({
            ID: "old123",
            Names: "old-copy-postgres-1",
            Ports: "127.0.0.1:57001->5432/tcp",
            Labels: "com.docker.compose.project=old-copy,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "old123",
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () =>
      mutator.renameAttachedProject(
        {
          mode: "clone",
          runtime: "docker",
          originalProjectName: "workspace",
          attachedProjectName: "old-copy",
          workingDirectory: tempDir,
          composeFiles: [composeFile],
          services: ["postgres"],
          overrideFile: oldOverrideFile,
          originalPorts: [
            {
              serviceName: "postgres",
              logicalPort: 15432,
              actualHostAddress: "127.0.0.1",
              actualHostPort: 15432,
              containerPort: 5432,
              protocol: "tcp",
            },
          ],
          hiddenPorts: [
            {
              serviceName: "postgres",
              logicalPort: 15432,
              actualHostAddress: "127.0.0.1",
              actualHostPort: 57001,
              containerPort: 5432,
              protocol: "tcp",
            },
          ],
          containerMappings: [
            {
              serviceName: "postgres",
              originalContainerId: "source123",
              originalContainerName: "workspace-postgres-1",
              attachedContainerId: "old123",
              attachedContainerName: "old-copy-postgres-1",
            },
          ],
        },
        "new-copy",
      ),
    /Compose project name "new-copy" is already in use by docker/,
  );

  assert.equal(calls.some((call) => call.args[0] === "compose" && call.args.includes("stop")), false);
  assert.equal(calls.some((call) => call.args[0] === "compose" && call.args.includes("up")), false);
  assert.equal(fs.existsSync(newOverrideFile), false);
});

test("derives compose clone project name from yaml name instead of current runtime project name", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-yaml-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const currentProjectName = "runtime-overridden";
  const canonicalProjectName = "a-app-captain-92c894fb";
  fs.writeFileSync(composeFile, "name: captain\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const composeProject = containerListCount === 1 ? currentProjectName : canonicalProjectName;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "source123" : "hidden123",
            Names: `${composeProject}-postgres-1`,
            Ports: `127.0.0.1:${containerListCount === 1 ? 15432 : 57002}->5432/tcp`,
            Labels: `com.docker.compose.project=${composeProject},com.docker.compose.service=postgres`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: currentProjectName,
    workingDirectory: tempDir,
    composeFiles: [composeFile],
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
  });

  const composeProjectArgs = calls
    .filter((call) => call.args[0] === "compose")
    .map((call) => call.args[call.args.indexOf("-p") + 1]);
  assert.equal(result.state.originalProjectName, currentProjectName);
  assert.equal(result.state.attachedProjectName, canonicalProjectName);
  assert.deepEqual(composeProjectArgs, [currentProjectName, currentProjectName, canonicalProjectName]);
  assert.equal(result.ports[0]?.actualHostPort, 57002);
});

test("derives compose clone project name from project folder when yaml has no name", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-folder-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const projectDir = path.join(tempDir, "workspace");
  fs.mkdirSync(projectDir, { recursive: true });
  const composeFile = path.join(projectDir, "compose.yaml");
  const currentProjectName = "runtime-overridden";
  const canonicalProjectName = "a-app-workspace-bc74e5f2";
  fs.writeFileSync(composeFile, "services:\n  postgres:\n    image: postgres:16\n", "utf8");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const composeProject = containerListCount === 1 ? currentProjectName : canonicalProjectName;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "source123" : "hidden123",
            Names: `${composeProject}-postgres-1`,
            Ports: `127.0.0.1:${containerListCount === 1 ? 15432 : 57002}->5432/tcp`,
            Labels: `com.docker.compose.project=${composeProject},com.docker.compose.service=postgres`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: currentProjectName,
    workingDirectory: projectDir,
    composeFiles: [composeFile],
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
  });

  const composeProjectArgs = calls
    .filter((call) => call.args[0] === "compose")
    .map((call) => call.args[call.args.indexOf("-p") + 1]);
  assert.equal(result.state.originalProjectName, currentProjectName);
  assert.equal(result.state.attachedProjectName, canonicalProjectName);
  assert.equal(result.state.overrideFile, path.join(tempDir, `${canonicalProjectName}.ports.override.yaml`));
  assert.deepEqual(composeProjectArgs, [currentProjectName, currentProjectName, canonicalProjectName]);
  assert.equal(result.ports[0]?.actualHostPort, 57002);
});

test("separates generated compose clone project names by logical network identity", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-network-id-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  let containerListCount = 0;
  let lastStartedProject = "";
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("up")) {
        lastStartedProject = args[args.indexOf("-p") + 1] ?? "";
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const rows = [
          {
            ID: `source${containerListCount}`,
            Names: "workspace-postgres-1",
            Ports: "127.0.0.1:15432->5432/tcp",
            Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
          },
          ...(lastStartedProject.length > 0
            ? [
                {
                  ID: `hidden${containerListCount}`,
                  Names: `${lastStartedProject}-postgres-1`,
                  Ports: `127.0.0.1:${57000 + containerListCount}->5432/tcp`,
                  Labels: `com.docker.compose.project=${lastStartedProject},com.docker.compose.service=postgres`,
                },
              ]
            : []),
        ];
        return {
          stdout: rows.map((row) => JSON.stringify(row)).join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });
  const baseInput = {
    runtime: "docker" as const,
    networkName: "A app",
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "postgres",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp" as const,
      },
    ],
  };

  const first = await mutator.hidePublishedPorts({ ...baseInput, networkId: "network-first" });
  const second = await mutator.hidePublishedPorts({ ...baseInput, networkId: "network-second" });

  assert.match(first.state.attachedProjectName, /^a-app-workspace-[a-f0-9]{8}$/);
  assert.match(second.state.attachedProjectName, /^a-app-workspace-[a-f0-9]{8}$/);
  assert.notEqual(first.state.attachedProjectName, second.state.attachedProjectName);
});

test("suffixes generated compose clone project names when copying again into the same network", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-same-network-copy-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const existingProjectName = "a-app-workspace-c0445d38";
  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  fs.writeFileSync(path.join(tempDir, `${existingProjectName}.ports.override.yaml`), "services: {}\n", "utf8");
  let containerListCount = 0;
  let lastStartedProject = "";
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("up")) {
        lastStartedProject = args[args.indexOf("-p") + 1] ?? "";
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const isSourceList = containerListCount === 1;
        const composeProject = isSourceList ? "workspace" : lastStartedProject;
        return {
          stdout: JSON.stringify({
            ID: isSourceList ? "source123" : "hidden123",
            Names: `${composeProject}-postgres-1`,
            Ports: `127.0.0.1:${isSourceList ? 15432 : 57002}->5432/tcp`,
            Labels: `com.docker.compose.project=${composeProject},com.docker.compose.service=postgres`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    networkId: "network-a",
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "postgres",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.match(result.state.attachedProjectName, /^a-app-workspace-[a-f0-9]{8}-[a-f0-9]{8}$/);
  assert.notEqual(result.state.attachedProjectName, existingProjectName);
  assert.equal(result.state.overrideFile, path.join(tempDir, `${result.state.attachedProjectName}.ports.override.yaml`));
  assert.equal(result.ports[0]?.actualHostPort, 57002);
});

test("suffixes generated compose clone project names when the runtime project remains without an override file", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-runtime-project-collision-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const existingProjectName = "a-app-workspace-c0445d38";
  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  let lastStartedProject = "";
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("up")) {
        lastStartedProject = args[args.indexOf("-p") + 1] ?? "";
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && (args[1] === "ls" || args[1] === "ps")) {
        const projectFilter = args.find((arg) => arg.startsWith("label=com.docker.compose.project="));
        const filteredProject = projectFilter?.slice("label=com.docker.compose.project=".length);
        if (filteredProject === "workspace") {
          return {
            stdout: JSON.stringify({
              ID: "source123",
              Names: "workspace-postgres-1",
              Ports: "127.0.0.1:15432->5432/tcp",
              Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
            }),
            stderr: "",
          };
        }
        if (filteredProject === lastStartedProject) {
          return {
            stdout: JSON.stringify({
              ID: "hidden123",
              Names: `${lastStartedProject}-postgres-1`,
              Ports: "127.0.0.1:57002->5432/tcp",
              Labels: `com.docker.compose.project=${lastStartedProject},com.docker.compose.service=postgres`,
            }),
            stderr: "",
          };
        }

        return {
          stdout: JSON.stringify({
            ID: "existing-hidden123",
            Names: `${existingProjectName}-postgres-1`,
            Ports: "",
            Labels: `com.docker.compose.project=${existingProjectName},com.docker.compose.service=postgres`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    networkId: "network-a",
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "postgres",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.match(result.state.attachedProjectName, /^a-app-workspace-c0445d38-[a-f0-9]{8}$/);
  assert.notEqual(result.state.attachedProjectName, existingProjectName);
  assert.equal(result.state.overrideFile, path.join(tempDir, `${result.state.attachedProjectName}.ports.override.yaml`));
  assert.equal(result.ports[0]?.actualHostPort, 57002);
});

test("mutates compose clone container names by replacing the compose project prefix", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-name-prefix-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(composeFile, "name: captain\nservices:\n  db:\n    image: postgres:16\n", "utf8");
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "original123" : "hidden123",
            Names: containerListCount === 1 ? "captain_db-1" : "a-app-captain-92c894fb_db-1",
            Ports: containerListCount === 1 ? "127.0.0.1:15432->5432/tcp" : "127.0.0.1:57001->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=captain,com.docker.compose.service=db"
                : "com.docker.compose.project=a-app-captain-92c894fb,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "original123",
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "captain",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.equal(result.state.attachedProjectName, "a-app-captain-92c894fb");
  assert.equal(result.ports[0]?.logicalPort, 15432);
  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "db",
      originalContainerId: "original123",
      originalContainerName: "captain_db-1",
      attachedContainerId: "hidden123",
      attachedContainerName: "a-app-captain-92c894fb_db-1",
    },
  ]);
  const generatedOverrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.match(generatedOverrideText, /container_name: !reset null/);
  assert.doesNotMatch(generatedOverrideText, /container_name: 'a-app-captain-92c894fb_db-1'/);
});

test("keeps explicit project-prefixed container names as the clone name source", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-explicit-project-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    "name: captain\nservices:\n  db:\n    image: postgres:16\n    container_name: captain_db\n",
    "utf8",
  );
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "original123" : "hidden123",
            Names: containerListCount === 1 ? "captain_db" : "captain_db-a-app-captain-92c894fb",
            Ports: containerListCount === 1 ? "127.0.0.1:15432->5432/tcp" : "127.0.0.1:57001->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=captain,com.docker.compose.service=db"
                : "com.docker.compose.project=a-app-captain-92c894fb,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "original123",
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "captain",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "db",
      originalContainerId: "original123",
      originalContainerName: "captain_db",
      attachedContainerId: "hidden123",
      attachedContainerName: "captain_db-a-app-captain-92c894fb",
    },
  ]);
  const overrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.match(overrideText, /container_name: 'captain_db-a-app-captain-92c894fb'/);
  assert.doesNotMatch(overrideText, /container_name: 'a-app-captain-92c894fb_db'/);
});

test("suffixes repeated compose clone container names when the original SOT container still exists", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-repeat-explicit-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    "name: captain\nservices:\n  db:\n    image: postgres:16\n    container_name: captain_db\n",
    "utf8",
  );
  const calls: Array<{ readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      calls.push({ args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "oldclone123" : "newclone123",
            Names: containerListCount === 1 ? "captain_db-old-copy" : "captain_db-new-copy",
            Ports: containerListCount === 1 ? "127.0.0.1:57001->5432/tcp" : "127.0.0.1:57002->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=old-copy,com.docker.compose.service=db"
                : "com.docker.compose.project=new-copy,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name:
                id === "captain_db"
                  ? "/captain_db"
                  : id === "oldclone123"
                    ? "/captain_db-old-copy"
                    : id === "newclone123"
                      ? "/captain_db-new-copy"
                      : `/${id}`,
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    attachedProjectName: "new-copy",
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "old-copy",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 57001,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "db",
      originalContainerId: "oldclone123",
      originalContainerName: "captain_db-old-copy",
      attachedContainerId: "newclone123",
      attachedContainerName: "captain_db-new-copy",
    },
  ]);
  assert.equal(calls.some((call) => call.args.join(" ") === "container inspect captain_db"), true);
  assert.match(fs.readFileSync(result.state.overrideFile, "utf8"), /container_name: 'captain_db-new-copy'/);
});

test("carries previous compose clone container mappings into a copied clone", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-copy-lineage-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    "name: captain\nservices:\n  db:\n    image: postgres:16\n    container_name: captain_db\n",
    "utf8",
  );
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "oldclone123" : "newclone123",
            Names: containerListCount === 1 ? "captain_db-old-copy" : "captain_db-new-copy",
            Ports: containerListCount === 1 ? "127.0.0.1:57001->5432/tcp" : "127.0.0.1:57002->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=old-copy,com.docker.compose.service=db"
                : "com.docker.compose.project=new-copy,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name:
                id === "captain_db"
                  ? "/captain_db"
                  : id === "oldclone123"
                    ? "/captain_db-old-copy"
                    : id === "newclone123"
                      ? "/captain_db-new-copy"
                      : `/${id}`,
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    attachedProjectName: "new-copy",
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "old-copy",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    sourceContainerMappings: [
      {
        serviceName: "db",
        originalContainerId: "original123",
        originalContainerName: "captain_db",
        attachedContainerId: "oldclone123",
        attachedContainerName: "captain_db-old-copy",
      },
    ],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 57001,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "db",
      originalContainerId: "oldclone123",
      originalContainerName: "captain_db-old-copy",
      attachedContainerId: "newclone123",
      attachedContainerName: "captain_db-new-copy",
    },
    {
      serviceName: "__portmanager_alias__:db",
      originalContainerId: "original123",
      originalContainerName: "captain_db",
      attachedContainerId: "newclone123",
      attachedContainerName: "captain_db-new-copy",
    },
  ]);
});

test("increments clone container names when the project suffix candidate is already reserved", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-repeat-candidate-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    "name: captain\nservices:\n  db:\n    image: postgres:16\n    container_name: captain_db\n",
    "utf8",
  );
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "oldclone123" : "newclone123",
            Names: containerListCount === 1 ? "captain_db-new-copy" : "captain_db-new-copy-2",
            Ports: containerListCount === 1 ? "127.0.0.1:57001->5432/tcp" : "127.0.0.1:57002->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=old-copy,com.docker.compose.service=db"
                : "com.docker.compose.project=new-copy,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name:
                id === "captain_db"
                  ? "/captain_db"
                  : id === "oldclone123"
                    ? "/captain_db-new-copy"
                    : id === "newclone123"
                      ? "/captain_db-new-copy-2"
                      : `/${id}`,
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    attachedProjectName: "new-copy",
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "old-copy",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 57001,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "db",
      originalContainerId: "oldclone123",
      originalContainerName: "captain_db-new-copy",
      attachedContainerId: "newclone123",
      attachedContainerName: "captain_db-new-copy-2",
    },
  ]);
  assert.match(fs.readFileSync(result.state.overrideFile, "utf8"), /container_name: 'captain_db-new-copy-2'/);
});

test("fails closed when runtime name reservations cannot be read for compose clone", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-reservation-fail-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    "name: captain\nservices:\n  db:\n    image: postgres:16\n    container_name: captain_db\n",
    "utf8",
  );
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        return {
          stdout: JSON.stringify({
            ID: "source123",
            Names: "captain_db",
            Ports: "127.0.0.1:57001->5432/tcp",
            Labels: "com.docker.compose.project=captain,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name: "/captain_db",
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "ps") {
        throw new Error("docker list failed");
      }

      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    mutator.hidePublishedPorts({
      attachedProjectName: "new-copy",
      runtime: "docker",
      networkName: "A app",
      originalProjectName: "captain",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      ports: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 57001,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
    }),
    /docker list failed/,
  );
  assert.equal(fs.readdirSync(tempDir).some((fileName) => fileName.endsWith(".ports.override.yaml")), false);
});

test("increments clone container names reserved by other runtime containers", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-runtime-reserved-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    "name: captain\nservices:\n  db:\n    image: postgres:16\n    container_name: captain_db\n",
    "utf8",
  );
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ps") {
        return {
          stdout: [
            JSON.stringify({ ID: "reserved1", Names: "captain_db" }),
            JSON.stringify({ ID: "reserved2", Names: "captain_db-new-copy" }),
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "source123" : "newclone123",
            Names: containerListCount === 1 ? "docker-db-1" : "captain_db-new-copy-2",
            Ports: containerListCount === 1 ? "127.0.0.1:57001->5432/tcp" : "127.0.0.1:57002->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=docker,com.docker.compose.service=db"
                : "com.docker.compose.project=new-copy,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name:
                id === "source123"
                  ? "/docker-db-1"
                  : id === "newclone123"
                    ? "/captain_db-new-copy-2"
                    : `/${id}`,
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    attachedProjectName: "new-copy",
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "docker",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 57001,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "db",
      originalContainerId: "source123",
      originalContainerName: "docker-db-1",
      attachedContainerId: "newclone123",
      attachedContainerName: "captain_db-new-copy-2",
    },
  ]);
  assert.match(fs.readFileSync(result.state.overrideFile, "utf8"), /container_name: 'captain_db-new-copy-2'/);
});

test("rewrites unselected compose container names when the clone override is reused", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-unselected-container-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "  chrome:",
      "    image: chromium:latest",
      "    container_name: captain_chrome",
      "",
    ].join("\n"),
    "utf8",
  );
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\nchrome\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ps") {
        return {
          stdout: [
            JSON.stringify({ ID: "reserved1", Names: "captain_db" }),
            JSON.stringify({ ID: "reserved2", Names: "captain_chrome" }),
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "source123" : "clone123",
            Names: containerListCount === 1 ? "captain_db" : "captain_db-new-copy",
            Ports: containerListCount === 1 ? "127.0.0.1:15432->5432/tcp" : "127.0.0.1:57002->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=captain,com.docker.compose.service=db"
                : "com.docker.compose.project=new-copy,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Name: id === "source123" ? "/captain_db" : id === "clone123" ? "/captain_db-new-copy" : `/${id}`,
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    attachedProjectName: "new-copy",
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "captain",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  const overrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.match(overrideText, /'db':\n    container_name: 'captain_db-new-copy'/);
  assert.match(overrideText, /'chrome':\n    container_name: !reset null/);
  assert.doesNotMatch(overrideText, /container_name: 'captain_chrome/);
});

test("suffixes explicit compose container names that look generated when the SOT name is reserved", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-explicit-generated-looking-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(
    composeFile,
    "name: captain\nservices:\n  db:\n    image: postgres:16\n    container_name: captain_db-1\n",
    "utf8",
  );
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "original123" : "hidden123",
            Names: containerListCount === 1 ? "captain_db-1" : "captain_db-1-a-app-captain-92c894fb",
            Ports: containerListCount === 1 ? "127.0.0.1:15432->5432/tcp" : "127.0.0.1:57001->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=captain,com.docker.compose.service=db"
                : "com.docker.compose.project=a-app-captain-92c894fb,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "original123",
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "captain",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  assert.deepEqual(result.state.containerMappings, [
    {
      serviceName: "db",
      originalContainerId: "original123",
      originalContainerName: "captain_db-1",
      attachedContainerId: "hidden123",
      attachedContainerName: "captain_db-1-a-app-captain-92c894fb",
    },
  ]);
  assert.match(fs.readFileSync(result.state.overrideFile, "utf8"), /container_name: 'captain_db-1-a-app-captain-92c894fb'/);
});

test("rejects compose mutation when Docker keeps the logical host port published", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-mutator-leak-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");

  const calls: Array<{ readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      calls.push({ args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "original123" : "hidden123",
            Names: containerListCount === 1 ? "workspace-postgres-1" : "a-app-workspace-bc74e5f2-postgres-1",
            Ports: "127.0.0.1:15432->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=workspace,com.docker.compose.service=postgres"
                : "com.docker.compose.project=a-app-workspace-bc74e5f2,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "original123",
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    mutator.hidePublishedPorts({
      runtime: "docker",
      networkName: "A app",
      originalProjectName: "workspace",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      ports: [
        {
          serviceName: "postgres",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
    }),
    /kept Docker-published host port on a visible logical\/original port/,
  );

  assert.deepEqual(
    calls.filter((call) => call.args[0] === "compose").map((call) => call.args.at(-2)),
    ["config", "stop", "--no-deps", "down", "-d"],
  );
});

test("skips stale compose service labels while mutating current services", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-stale-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(composeFile, "name: workspace\nservices:\n  postgres:\n    image: postgres:16\n", "utf8");
  const calls: Array<{ readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      calls.push({ args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "original123" : "hidden123",
            Names: containerListCount === 1 ? "workspace-postgres-1" : "a-app-workspace-bc74e5f2-postgres-1",
            Ports: containerListCount === 1 ? "127.0.0.1:15432->5432/tcp" : "127.0.0.1:57001->5432/tcp",
            Labels:
              containerListCount === 1
                ? "com.docker.compose.project=workspace,com.docker.compose.service=postgres"
                : "com.docker.compose.project=a-app-workspace-bc74e5f2,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "original123",
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "postgres",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
      {
        serviceName: "fake_ai_server",
        logicalPort: 18000,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 18000,
        containerPort: 8000,
        protocol: "tcp",
      },
    ],
  });

  assert.deepEqual(result.ports.map((port) => port.serviceName), ["postgres"]);
  assert.equal(calls.some((call) => call.args.includes("fake_ai_server")), false);
  assert.equal(calls.some((call) => call.args.includes("postgres")), true);
});

test("mutates compose services in-place without resetting container names", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-in-place-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  fs.writeFileSync(composeFile, "services:\n  postgres:\n    image: postgres:16\n", "utf8");
  const calls: Array<{ readonly args: readonly string[] }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      calls.push({ args });
      if (args[0] === "compose" && args.includes("config")) {
        return { stdout: "postgres\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        return {
          stdout: JSON.stringify({
            ID: containerListCount === 1 ? "original123" : "hidden123",
            Names: "captain_postgres",
            Ports: containerListCount === 1 ? "127.0.0.1:15432->5432/tcp" : "127.0.0.1:57001->5432/tcp",
            Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "original123",
              Config: { Labels: { "com.docker.compose.service": "postgres" } },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    mode: "in-place",
    runtime: "docker",
    networkName: "A app",
    originalProjectName: "workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "postgres",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  const overrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.equal(result.state.mode, "in-place");
  assert.equal(result.state.attachedProjectName, "workspace");
  assert.equal(result.ports[0]?.logicalPort, 15432);
  assert.equal(result.ports[0]?.actualHostPort, 57001);
  assert.equal(overrideText.includes("container_name: !reset null"), false);
  assert.equal(overrideText.includes("networks: !override"), false);
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 8)),
    [
      ["compose", "-p", "workspace", "-f", composeFile, "config", "--services"],
      [
        "container",
        "ls",
        "--no-trunc",
        "--filter",
        "label=com.docker.compose.project=workspace",
        "--format",
        "{{json .}}",
      ],
      ["container", "inspect", "original123"],
      ["compose", "-p", "workspace", "-f", composeFile, "-f", result.state.overrideFile, "up"],
      [
        "container",
        "ls",
        "--no-trunc",
        "--filter",
        "label=com.docker.compose.project=workspace",
        "--format",
        "{{json .}}",
      ],
      ["container", "inspect", "hidden123"],
    ],
  );
});

test("restores original compose services before removing the hidden project", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-restore-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "hidden.override.yaml");
  fs.writeFileSync(composeFile, "services:\n  postgres:\n    image: postgres:16\n", "utf8");
  fs.writeFileSync(overrideFile, "services: {}\n", "utf8");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restorePublishedPorts({
    mode: "clone",
    runtime: "docker",
    originalProjectName: "workspace",
    attachedProjectName: "a-app-workspace-bc74e5f2",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    services: ["postgres"],
    overrideFile,
    originalPorts: [],
    hiddenPorts: [],
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      [
        "compose",
        "-p",
        "a-app-workspace-bc74e5f2",
        "-f",
        composeFile,
        "-f",
        overrideFile,
        "stop",
        "postgres",
      ],
      [
        "compose",
        "-p",
        "workspace",
        "-f",
        composeFile,
        "up",
        "-d",
        "postgres",
      ],
      [
        "compose",
        "-p",
        "a-app-workspace-bc74e5f2",
        "-f",
        composeFile,
        "-f",
        overrideFile,
        "down",
        "--remove-orphans",
      ],
    ],
  );
  assert.equal(fs.existsSync(overrideFile), false);
});

test("recreates missing compose clone override from persisted mutation state", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-restore-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "network-workspace.ports.override.yaml");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];

  fs.writeFileSync(
    composeFile,
    [
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "  langgraph_server:",
      "    image: langchain/langgraph-api:latest",
      "    container_name: captain_langgraph_server",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\nlanggraph_server\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride({
    mode: "clone",
    runtime: "docker",
    originalProjectName: "workspace",
    attachedProjectName: "network-workspace",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    services: ["db"],
    overrideFile,
    originalPorts: [
      {
        serviceName: "db",
        logicalPort: 5432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 5432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
    hiddenPorts: [
      {
        serviceName: "db",
        logicalPort: 5432,
        actualHostAddress: "127.81.154.127",
        actualHostPort: 57002,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
    containerMappings: [
      {
        serviceName: "db",
        originalContainerId: "source-db",
        originalContainerName: "captain_db",
        attachedContainerId: "clone-db",
        attachedContainerName: "captain_db-network",
      },
    ],
  });

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "compose").map((call) => call.args),
    [["compose", "-p", "workspace", "-f", composeFile, "config", "--services"]],
  );
  assert.match(overrideText, /'db':\n    container_name: 'captain_db-network'/);
  assert.match(overrideText, /127\.81\.154\.127::5432\/tcp/);
  assert.match(overrideText, /'langgraph_server':\n    container_name: !reset null/);
  assert.match(overrideText, /profiles: !override\n      - 'pm_unattached'/);
});

test("recreates compose override with current loopback publish model", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-loopback-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "network-workspace.ports.override.yaml");

  fs.writeFileSync(
    composeFile,
    [
      "services:",
      "  db:",
      "    image: postgres:16",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "workspace",
      attachedProjectName: "network-workspace",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["db"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57002,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
    },
    { force: true, preservePublishedHostPorts: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.match(overrideText, /'127\.81\.154\.127:15432:5432\/tcp'/);
  assert.doesNotMatch(overrideText, /127\.81\.154\.127::5432\/tcp/);
});

test("recovers compose clone overrides into the current storage directory", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-canonical-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storageDir = path.join(tempDir, "current", "compose-overrides");
  const oldStorageDir = path.join(tempDir, "old", "compose-overrides");
  const composeFile = path.join(tempDir, "compose.yaml");
  const oldOverrideFile = path.join(oldStorageDir, "network-workspace.ports.override.yaml");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];

  fs.mkdirSync(oldStorageDir, { recursive: true });
  fs.writeFileSync(
    composeFile,
    [
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: storageDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const overrideFile = await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "workspace",
      attachedProjectName: "network-workspace",
      workingDirectory: tempDir,
      composeFiles: [composeFile, oldOverrideFile],
      services: ["db"],
      overrideFile: oldOverrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 5432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 5432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 5432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57002,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
    },
    { force: true, recoverToStorageDirectory: true },
  );

  assert.equal(overrideFile, path.join(storageDir, "network-workspace.ports.override.yaml"));
  assert.equal(fs.existsSync(overrideFile), true);
  assert.equal(fs.existsSync(oldOverrideFile), false);
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "compose").map((call) => call.args),
    [["compose", "-p", "workspace", "-f", composeFile, "config", "--services"]],
  );
});

test("force-recreates stale compose clone overrides without original container names", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-force-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  chrome:",
      "    image: selenium/standalone-chrome:latest",
      "    container_name: captain_chrome",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(overrideFile, "services:\n  chrome:\n    container_name: 'captain_chrome'\n", "utf8");

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "chrome\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "captain",
      attachedProjectName: "captain_chrome-production1-docker-79b2163a",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["chrome"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "chrome",
          logicalPort: 15900,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15900,
          containerPort: 5900,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "chrome",
          logicalPort: 15900,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57059,
          containerPort: 5900,
          protocol: "tcp",
        },
      ],
      containerMappings: [
        {
          serviceName: "chrome",
          originalContainerId: "original-chrome",
          originalContainerName: "captain_chrome",
          attachedContainerId: "clone-chrome",
          attachedContainerName: "captain_chrome",
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "compose").map((call) => call.args),
    [["compose", "-p", "captain", "-f", composeFile, "config", "--services"]],
  );
  assert.match(overrideText, /'chrome':\n    container_name: !reset null/);
  assert.doesNotMatch(overrideText, /container_name: 'captain_chrome'/);
  assert.match(overrideText, /127\.81\.154\.127::5900\/tcp/);
});

test("restored compose clone overrides do not write container hashes as names", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-hash-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");
  const leakedHash = "c4f68ffea4b60637e7884f0cafdda83cd4efea76b4fb425906664b3bd77eb326";

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "captain",
      attachedProjectName: "production1-captain-79b2163a",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["db"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57032,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      containerMappings: [
        {
          serviceName: "db",
          originalContainerId: "source-db",
          originalContainerName: "captain_db",
          attachedContainerId: leakedHash,
          attachedContainerName: leakedHash,
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.match(overrideText, /'db':\n    container_name: !reset null/);
  assert.doesNotMatch(overrideText, new RegExp(leakedHash));
});

test("clone override resets source container names even when compose config omits a service", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-sot-service-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  let hiddenProjectName = "";
  let containerListCount = 0;

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "  document_converter:",
      "    image: gotenberg/gotenberg:8",
      "    container_name: captain_document_converter",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "compose" && args.includes("up")) {
        hiddenProjectName = args[args.indexOf("-p") + 1] ?? "";
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        containerListCount += 1;
        const isSourceList = containerListCount === 1;
        const projectName = isSourceList ? "captain" : hiddenProjectName;
        return {
          stdout: JSON.stringify({
            ID: isSourceList ? "source-db" : "clone-db",
            Names: isSourceList ? "captain_db" : `captain_db-${projectName}`,
            Ports: `127.0.0.1:${isSourceList ? 15432 : 57032}->5432/tcp`,
            Labels: `com.docker.compose.project=${projectName},com.docker.compose.service=db`,
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify(
            args.slice(2).map((id) => ({
              Id: id,
              Config: { Labels: { "com.docker.compose.service": "db" } },
              Mounts: [],
            })),
          ),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  const result = await mutator.hidePublishedPorts({
    runtime: "docker",
    networkName: "production1",
    networkId: "network-production1",
    originalProjectName: "captain",
    workingDirectory: tempDir,
    composeFiles: [composeFile],
    ports: [
      {
        serviceName: "db",
        logicalPort: 15432,
        actualHostAddress: "127.0.0.1",
        actualHostPort: 15432,
        containerPort: 5432,
        protocol: "tcp",
      },
    ],
  });

  const overrideText = fs.readFileSync(result.state.overrideFile, "utf8");
  assert.match(overrideText, /'db':\n    container_name: 'captain_db-production1-captain-[a-f0-9]{8}'/);
  assert.match(overrideText, /'document_converter':\n    container_name: !reset null/);
  assert.match(overrideText, /profiles: !override\n      - 'pm_unattached'/);
  assert.doesNotMatch(overrideText, /container_name: 'captain_document_converter'/);
});

test("restore override resets source container names even when compose config omits a service", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-restore-sot-service-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "  document_converter:",
      "    image: gotenberg/gotenberg:8",
      "    container_name: captain_document_converter",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "captain",
      attachedProjectName: "production1-captain-79b2163a",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["db"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57032,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      containerMappings: [
        {
          serviceName: "db",
          originalContainerId: "source-db",
          originalContainerName: "captain_db",
          attachedContainerId: "clone-db",
          attachedContainerName: "captain_db-production1-captain-79b2163a",
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.match(overrideText, /'db':\n    container_name: 'captain_db-production1-captain-79b2163a'/);
  assert.match(overrideText, /'document_converter':\n    container_name: !reset null/);
  assert.match(overrideText, /profiles: !override\n      - 'pm_unattached'/);
  assert.doesNotMatch(overrideText, /container_name: 'captain_document_converter'/);
});

test("restore override trusts live generated clone names without persisting stale explicit names", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-live-generated-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls" && args.includes("label=com.docker.compose.project=production1-captain-79b2163a")) {
        return {
          stdout: JSON.stringify({
            ID: "live-db",
            Names: "production1-captain-79b2163a-db-1",
            Ports: "127.81.154.127:57032->5432/tcp",
            Labels: "com.docker.compose.project=production1-captain-79b2163a,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify([
            {
              Id: "live-db",
              Name: "/production1-captain-79b2163a-db-1",
              Config: {
                Labels: {
                  "com.docker.compose.project": "production1-captain-79b2163a",
                  "com.docker.compose.service": "db",
                },
              },
              Mounts: [],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "captain",
      attachedProjectName: "production1-captain-79b2163a",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["db"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57032,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      containerMappings: [
        {
          serviceName: "db",
          originalContainerId: "source-db",
          originalContainerName: "captain_db",
          attachedContainerId: "stale-db",
          attachedContainerName: "captain_db-production1-captain-79b2163a",
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.match(overrideText, /'db':\n    container_name: !reset null/);
  assert.doesNotMatch(overrideText, /container_name: 'captain_db-production1-captain-79b2163a'/);
});

test("restore override suffixes persisted clone names reserved by another container", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-reserved-name-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls" && args.includes("--filter")) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ps") {
        return {
          stdout: JSON.stringify({
            ID: "other-db",
            Names: "captain_db-production1-captain-79b2163a",
            Labels: "com.docker.compose.project=other-project,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "captain",
      attachedProjectName: "production1-captain-79b2163a",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["db"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57032,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      containerMappings: [
        {
          serviceName: "db",
          originalContainerId: "source-db",
          originalContainerName: "captain_db",
          attachedContainerId: "stale-db",
          attachedContainerName: "captain_db-production1-captain-79b2163a",
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.match(overrideText, /'db':\n    container_name: 'captain_db-production1-captain-79b2163a-2'/);
  assert.doesNotMatch(overrideText, /container_name: 'captain_db-production1-captain-79b2163a'\n/);
});

test("restore override treats globally reserved same-project names as live hidden containers", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-global-owner-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ps") {
        return {
          stdout: JSON.stringify({
            ID: "current-db",
            Names: "captain_db-production1-captain-79b2163a",
            Labels: "com.docker.compose.project=production1-captain-79b2163a,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "captain",
      attachedProjectName: "production1-captain-79b2163a",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["db"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57032,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      containerMappings: [
        {
          serviceName: "db",
          originalContainerId: "source-db",
          originalContainerName: "captain_db",
          attachedContainerId: "current-db",
          attachedContainerName: "captain_db-production1-captain-79b2163a",
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.match(overrideText, /'db':\n    container_name: 'captain_db-production1-captain-79b2163a'/);
  assert.doesNotMatch(overrideText, /container_name: 'captain_db-production1-captain-79b2163a-2'/);
});

test("restore override recovers clone mounts from live hidden containers when mappings are missing", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-live-mounts-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");
  const initdbDir = path.join(tempDir, "initdb");
  const clonedVolumeName = "pm-production1-captain-79b2163a-43b87f9de6aa-a1b2c3d4";

  fs.mkdirSync(initdbDir);
  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (
        args[0] === "container" &&
        args[1] === "ls" &&
        args.includes("label=com.docker.compose.project=production1-captain-79b2163a")
      ) {
        return {
          stdout: JSON.stringify({
            ID: "clone-db",
            Names: "production1-captain-79b2163a-db-1",
            Ports: "127.81.154.127:57032->5432/tcp",
            Labels:
              "com.docker.compose.project=production1-captain-79b2163a,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect" && args.includes("clone-db")) {
        return {
          stdout: JSON.stringify([
            {
              Id: "clone-db",
              Name: "/production1-captain-79b2163a-db-1",
              Config: {
                Labels: {
                  "com.docker.compose.project": "production1-captain-79b2163a",
                  "com.docker.compose.service": "db",
                },
              },
              Mounts: [
                {
                  Type: "volume",
                  Name: clonedVolumeName,
                  Source: `/var/lib/docker/volumes/${clonedVolumeName}/_data`,
                  Destination: "/var/lib/postgresql/data",
                  RW: true,
                },
                {
                  Type: "bind",
                  Source: initdbDir,
                  Destination: "/docker-entrypoint-initdb.d",
                  RW: false,
                },
              ],
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "ps") {
        return { stdout: "", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "captain",
      attachedProjectName: "production1-captain-79b2163a",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["db"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57032,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.match(overrideText, /volumes: !override/);
  assert.match(overrideText, /target: '\/var\/lib\/postgresql\/data'/);
  assert.match(overrideText, new RegExp(`name: '${clonedVolumeName}'`));
  assert.match(overrideText, /type: bind/);
  assert.match(overrideText, /target: '\/docker-entrypoint-initdb\.d'/);
  assert.match(overrideText, /read_only: true/);
});

test("restore override keeps persisted clone volumes while merging live passthrough mounts", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-merge-mounts-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");
  const configDir = path.join(tempDir, "config");
  const persistedVolumeName = "pm-production1-captain-79b2163a-43b87f9de6aa-durable1";

  fs.mkdirSync(configDir);
  fs.writeFileSync(composeFile, "services:\n  db:\n    image: postgres:16\n", "utf8");

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (
        args[0] === "container" &&
        args[1] === "ls" &&
        args.includes("label=com.docker.compose.project=production1-captain-79b2163a")
      ) {
        return {
          stdout: JSON.stringify({
            ID: "clone-db",
            Names: "production1-captain-79b2163a-db-1",
            Labels:
              "com.docker.compose.project=production1-captain-79b2163a,com.docker.compose.service=db",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect" && args.includes("clone-db")) {
        return {
          stdout: JSON.stringify([
            {
              Id: "clone-db",
              Config: {
                Labels: {
                  "com.docker.compose.project": "production1-captain-79b2163a",
                  "com.docker.compose.service": "db",
                },
              },
              Mounts: [
                {
                  Type: "volume",
                  Name: "captain_pgdata",
                  Source: "/var/lib/docker/volumes/captain_pgdata/_data",
                  Destination: "/var/lib/postgresql/data",
                  RW: true,
                },
                {
                  Type: "bind",
                  Source: configDir,
                  Destination: "/etc/postgres/conf.d",
                  RW: false,
                },
              ],
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "ps") {
        return { stdout: "", stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "clone",
      runtime: "docker",
      originalProjectName: "captain",
      attachedProjectName: "production1-captain-79b2163a",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["db"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "db",
          logicalPort: 15432,
          actualHostAddress: "127.81.154.127",
          actualHostPort: 57032,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      clonedVolumes: [
        {
          serviceName: "db",
          sourceKind: "volume",
          sourceName: "captain_pgdata",
          targetVolumeName: persistedVolumeName,
          containerPath: "/var/lib/postgresql/data",
          readOnly: false,
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.match(overrideText, new RegExp(`name: '${persistedVolumeName}'`));
  assert.doesNotMatch(overrideText, /name: 'captain_pgdata'/);
  assert.match(overrideText, /type: bind/);
  assert.match(overrideText, /target: '\/etc\/postgres\/conf\.d'/);
});

test("restore override recovers attach as-is mounts from the live project", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-in-place-mounts-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "workspace.ports.override.yaml");

  fs.writeFileSync(composeFile, "services:\n  postgres:\n    image: postgres:16\n", "utf8");

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        throw new Error("compose config unavailable");
      }
      if (args[0] === "container" && args[1] === "ls" && args.includes("label=com.docker.compose.project=workspace")) {
        return {
          stdout: JSON.stringify({
            ID: "postgres-live",
            Names: "workspace-postgres-1",
            Ports: "127.0.0.1:57001->5432/tcp",
            Labels: "com.docker.compose.project=workspace,com.docker.compose.service=postgres",
          }),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "inspect" && args.includes("postgres-live")) {
        return {
          stdout: JSON.stringify([
            {
              Id: "postgres-live",
              Config: {
                Labels: {
                  "com.docker.compose.project": "workspace",
                  "com.docker.compose.service": "postgres",
                },
              },
              Mounts: [
                {
                  Type: "volume",
                  Name: "workspace_pgdata",
                  Source: "/var/lib/docker/volumes/workspace_pgdata/_data",
                  Destination: "/var/lib/postgresql/data",
                  RW: true,
                },
              ],
            },
          ]),
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    },
  });

  await mutator.restoreHiddenPortsOverride(
    {
      mode: "in-place",
      runtime: "docker",
      originalProjectName: "workspace",
      attachedProjectName: "workspace",
      workingDirectory: tempDir,
      composeFiles: [composeFile],
      services: ["postgres"],
      overrideFile,
      originalPorts: [
        {
          serviceName: "postgres",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 15432,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
      hiddenPorts: [
        {
          serviceName: "postgres",
          logicalPort: 15432,
          actualHostAddress: "127.0.0.1",
          actualHostPort: 57001,
          containerPort: 5432,
          protocol: "tcp",
        },
      ],
    },
    { force: true },
  );

  const overrideText = fs.readFileSync(overrideFile, "utf8");
  assert.equal(overrideText.includes("container_name: !reset null"), false);
  assert.match(overrideText, /volumes: !override/);
  assert.match(overrideText, /target: '\/var\/lib\/postgresql\/data'/);
  assert.match(overrideText, /name: 'workspace_pgdata'/);
});

test("restore override fails closed before writing persisted names without reservations", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-reservation-fail-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "production1-captain.ports.override.yaml");

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "    container_name: captain_db",
      "",
    ].join("\n"),
    "utf8",
  );

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        return { stdout: "db\n", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ls") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "container" && args[1] === "ps") {
        throw new Error("docker unavailable");
      }

      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () =>
      mutator.restoreHiddenPortsOverride(
        {
          mode: "clone",
          runtime: "docker",
          originalProjectName: "captain",
          attachedProjectName: "production1-captain-79b2163a",
          workingDirectory: tempDir,
          composeFiles: [composeFile],
          services: ["db"],
          overrideFile,
          originalPorts: [
            {
              serviceName: "db",
              logicalPort: 15432,
              actualHostAddress: "127.0.0.1",
              actualHostPort: 15432,
              containerPort: 5432,
              protocol: "tcp",
            },
          ],
          hiddenPorts: [
            {
              serviceName: "db",
              logicalPort: 15432,
              actualHostAddress: "127.81.154.127",
              actualHostPort: 57032,
              containerPort: 5432,
              protocol: "tcp",
            },
          ],
          containerMappings: [
            {
              serviceName: "db",
              originalContainerId: "source-db",
              originalContainerName: "captain_db",
              attachedContainerId: "stale-db",
              attachedContainerName: "captain_db-production1-captain-79b2163a",
            },
          ],
        },
        { force: true },
      ),
    /failed to verify runtime container name reservations/,
  );
  assert.equal(fs.existsSync(overrideFile), false);
});

test("fails closed when hidden compose override restore cannot list all services", async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-fail-"));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const composeFile = path.join(tempDir, "compose.yaml");
  const overrideFile = path.join(tempDir, "network-captain.ports.override.yaml");
  const staleOverride = "services:\n  db:\n    container_name: 'captain_db'\n";

  fs.writeFileSync(
    composeFile,
    [
      "name: captain",
      "services:",
      "  db:",
      "    image: postgres:16",
      "  chrome:",
      "    image: chromium:latest",
      "    container_name: captain_chrome",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(overrideFile, staleOverride, "utf8");

  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (_executable, args) => {
      if (args[0] === "compose" && args.includes("config") && args.includes("--services")) {
        throw new Error("compose config failed");
      }

      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    () =>
      mutator.restoreHiddenPortsOverride(
        {
          mode: "clone",
          runtime: "docker",
          originalProjectName: "captain",
          attachedProjectName: "network-captain",
          workingDirectory: tempDir,
          composeFiles: [composeFile],
          services: ["db"],
          overrideFile,
          originalPorts: [
            {
              serviceName: "db",
              logicalPort: 15432,
              actualHostAddress: "127.0.0.1",
              actualHostPort: 15432,
              containerPort: 5432,
              protocol: "tcp",
            },
          ],
          hiddenPorts: [
            {
              serviceName: "db",
              logicalPort: 15432,
              actualHostAddress: "127.81.154.127",
              actualHostPort: 57032,
              containerPort: 5432,
              protocol: "tcp",
            },
          ],
        },
        { force: true },
      ),
    /Cannot recreate generated Compose override.*compose config failed/,
  );
  assert.equal(fs.readFileSync(overrideFile, "utf8"), staleOverride);
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

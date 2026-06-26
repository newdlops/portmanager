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
  }> = [];
  let containerListCount = 0;
  const mutator = new ComposePublishMutator({
    storageDirectory: tempDir,
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
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
            Ports: "127.0.0.1:57001->5432/tcp",
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
  assert.match(overrideText, /container_name: 'captain_langgraph_server'/);
  assert.doesNotMatch(overrideText, /container_name: 'a-app-workspace-bc74e5f2-postgres-1'/);
  assert.match(overrideText, /network_mode: !reset null/);
  assert.match(overrideText, /networks: !override/);
  assert.match(overrideText, /pm_isolated/);
  assert.match(overrideText, /ports: !override/);
  assert.match(overrideText, /newdlops\.portmanager\.compose-clone-service: '1'/);
  assert.match(overrideText, /'?newdlops\.portmanager\.logical-port\.5432\.tcp'?: '15432'/);
  assert.match(overrideText, /127\.0\.0\.1::5432\/tcp/);
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
  assert.match(overrideText, /'chrome':\n    container_name: 'captain_chrome-new-copy'/);
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
      ["container", "ls", "--no-trunc", "--format", "{{json .}}"],
      ["container", "inspect", "original123"],
      ["compose", "-p", "workspace", "-f", composeFile, "-f", result.state.overrideFile, "up"],
      ["container", "ls", "--no-trunc", "--format", "{{json .}}"],
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

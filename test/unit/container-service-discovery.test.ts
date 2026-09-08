import assert from "node:assert/strict";
import test from "node:test";
import {
  ContainerServiceDiscoveryAdapter,
  type RuntimeContainerRow,
} from "../../src/platform/network/container-service-discovery";
import type { ContainerCommandResult } from "../../src/platform/network/container-runtime";
import type { ComposeContainerMutationMapping, ComposePublishedPort, ContainerRuntimeSettings } from "../../src/shared/types";

const settings: ContainerRuntimeSettings = { containerRuntime: "docker", containerImage: "unused" };
const composeFiles = ["/workspace/compose.yaml", "/storage/compose-overrides/network-workspace.ports.override.yaml"];
const original: RuntimeContainerRow = {
  ID: "original123",
  Names: "workspace-db-1",
  State: "exited",
  Status: "Exited (0) 2 minutes ago",
  Ports: "",
  Labels: "com.docker.compose.project=workspace,com.docker.compose.service=db," +
    "com.docker.compose.project.config_files=/workspace/compose.yaml,desktop.docker.io/ports/5432/tcp=:15432",
};
const clone: RuntimeContainerRow = {
  ID: "newclone987",
  Names: "network-workspace-db-1",
  State: "running",
  Status: "Up 1 minute",
  Ports: "127.0.0.1:51612->5432/tcp",
  Labels: `com.docker.compose.project=network-workspace,com.docker.compose.service=db,com.docker.compose.project.config_files=${composeFiles.join(",")}`,
};
const ports: readonly ComposePublishedPort[] = [{
  serviceName: "db", logicalPort: 15432, actualHostAddress: "127.0.0.1", actualHostPort: 63816,
  containerPort: 5432, protocol: "tcp",
}];
const mappings: readonly ComposeContainerMutationMapping[] = [{
  serviceName: "db", originalContainerId: "original123", originalContainerName: "workspace-db-1",
  attachedContainerId: "oldclone123", attachedContainerName: "stale-clone-name",
}];

/** Runtime rows are serialized like CLI output so the adapter's actual parsing path is exercised. */
function output(...rows: readonly RuntimeContainerRow[]): ContainerCommandResult {
  return { stdout: rows.map((row) => JSON.stringify(row)).join("\n"), stderr: "" };
}

/** Holds a CLI response open to reproduce overlapping refreshes without timing-dependent sleeps. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("one snapshot preserves stopped attach candidates and clone labels without publishing stopped routes", async () => {
  const calls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (_executable, args) => {
    calls.push([...args]);
    return output(clone, original);
  }});
  const session = await adapter.createSession(settings);
  assert.ok(session);
  assert.deepEqual(calls, [["container", "ls", "-a", "--format", "{{json .}}"]]);
  assert.equal(session.listCandidates().length, 2);
  assert.equal(session.listCandidates().find((candidate) => candidate.containerId === original.ID)?.ports[0].logicalPort, 15432);
  assert.deepEqual(session.listLiveComposePublishedPorts("workspace", [composeFiles[0]], ports), []);
  assert.deepEqual(session.refreshComposePublishedPorts("workspace", [composeFiles[0]], ports), ports);
  const livePorts = session.listLiveComposePublishedPorts("network-workspace", composeFiles, ports);
  assert.equal(livePorts.length, 1);
  assert.equal(livePorts[0].logicalPort, 15432);
  assert.equal(livePorts[0].actualHostPort, 51612);
});

test("all-container snapshots distinguish lifecycle states even when stopped rows retain published ports", async () => {
  let calls = 0;
  const rows: RuntimeContainerRow[] = [
    ...["running", "paused", "restarting", "created", "exited", "dead", "removing"].map((State) => ({
      ID: State, Names: State, State, Ports: "0.0.0.0:16379->6379/tcp",
    })),
    { ID: "legacy-up", Names: "legacy-up", Status: "Up 1 minute (healthy)", Ports: "0.0.0.0:16380->6379/tcp" },
    { ID: "legacy-exited", Names: "legacy-exited", Status: "Exited (0) 1 minute ago", Ports: "0.0.0.0:16381->6379/tcp" },
  ];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async () => {
    calls += 1;
    return output(...rows);
  }});
  const candidates = await adapter.list(settings);
  assert.equal(calls, 1);
  assert.deepEqual(candidates.map((candidate) => candidate.containerId), ["running", "paused", "restarting", "legacy-up"]);
});

test("unknown state retains a live-list fallback and lets newer running endpoints win", async () => {
  const calls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (_executable, args) => {
    calls.push([...args]);
    return args.includes("-a")
      ? output({ ...clone, State: undefined, Status: undefined }, original)
      : output({ ...clone, ID: "recreated123", Ports: "127.0.0.1:51613->5432/tcp" });
  }});
  const session = await adapter.createSession(settings);
  assert.ok(session);
  assert.deepEqual(calls, [
    ["container", "ls", "-a", "--format", "{{json .}}"],
    ["container", "ls", "--format", "{{json .}}"],
  ]);
  assert.equal(session.listCandidates().length, 2);
  assert.equal(session.listLiveComposePublishedPorts("network-workspace", composeFiles, ports)[0].actualHostPort, 51613);
});

test("overlapping refresh entry points share the CLI read and the next refresh observes recreation", async () => {
  const pending = deferred<ContainerCommandResult>();
  let calls = 0;
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async () => {
    calls += 1;
    return calls === 1 ? pending.promise : output({ ...clone, Ports: "127.0.0.1:51613->5432/tcp" }, original);
  }});
  const candidates = adapter.list(settings);
  const livePorts = adapter.listLiveComposePublishedPorts({ ...settings, containerImage: "different" }, "network-workspace", composeFiles, ports);
  const recoveredPorts = adapter.recoverPortManagerClonePorts(settings, composeFiles, [{ ...ports[0], logicalPort: 63816 }]);
  assert.equal(calls, 1);
  pending.resolve(output(clone, original));
  const [listed, live, recovered] = await Promise.all([candidates, livePorts, recoveredPorts]);
  assert.equal(listed.length, 2);
  assert.equal(live[0].actualHostPort, 51612);
  assert.equal(recovered[0].logicalPort, 15432);
  assert.equal(calls, 1);

  const refreshed = await adapter.refreshComposePublishedPorts(settings, "network-workspace", composeFiles, ports);
  assert.equal(calls, 2);
  assert.equal(refreshed[0].actualHostPort, 51613);
});

test("concurrent Docker and Podman reads never share runtime state", async () => {
  const calls: string[] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (executable) => {
    calls.push(executable);
    return output({ ...clone, ID: executable });
  }});
  const [docker, podman] = await Promise.all([
    adapter.list(settings),
    adapter.list({ ...settings, containerRuntime: "podman" }),
  ]);
  assert.deepEqual(calls, ["docker", "podman"]);
  assert.equal(docker[0].id, "docker:docker");
  assert.equal(podman[0].id, "podman:podman");
});

test("overlapping unavailable-daemon reads share failure and fallback, then retry on the next refresh", async () => {
  const calls: string[] = [];
  let dockerUnavailable = true;
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (executable) => {
    calls.push(executable);
    if (executable === "docker" && dockerUnavailable) {
      throw new Error("Cannot connect to the Docker daemon");
    }
    return output(clone, original);
  }});
  const auto: ContainerRuntimeSettings = { ...settings, containerRuntime: "auto" };
  const [first, second] = await Promise.all([adapter.list(auto), adapter.list(auto)]);
  assert.deepEqual(calls, ["docker", "podman"]);
  assert.equal(first[0].runtime, "podman");
  assert.deepEqual(first, second);
  dockerUnavailable = false;
  assert.equal((await adapter.list(auto))[0].runtime, "docker");
  assert.deepEqual(calls, ["docker", "podman", "docker"]);
});

test("empty snapshots need one query and do not keep a later container invisible", async () => {
  let calls = 0;
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async () => {
    calls += 1;
    return calls === 1 ? output() : output(clone);
  }});
  assert.deepEqual(await adapter.list(settings), []);
  assert.equal(calls, 1);
  assert.equal((await adapter.list(settings)).length, 1);
  assert.equal(calls, 2);
});

test("overlapping mapping repairs share a pending inspect and all receive the resolved names", async () => {
  const pending = deferred<ContainerCommandResult>();
  const inspectCalls: string[][] = [];
  const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (_executable, args) => {
    if (args[1] === "inspect") {
      inspectCalls.push([...args]);
      return pending.promise;
    }
    return output({ ...clone, Names: undefined }, { ...original, Names: undefined });
  }});
  const session = await adapter.createSession(settings);
  assert.ok(session);
  const repair = () => session.refreshComposeContainerMappings("workspace", "network-workspace", composeFiles, ["db"], mappings);
  const first = repair();
  const second = repair();
  assert.deepEqual(inspectCalls, [["container", "inspect", "newclone987", "original123"]]);
  pending.resolve({ stdout: JSON.stringify([
    { Id: "newclone987", Name: "/network-workspace-db-1" },
    { Id: "original123", Name: "/workspace-db-1" },
  ]), stderr: "" });
  const [firstMappings, secondMappings] = await Promise.all([first, second]);
  assert.deepEqual(firstMappings, secondMappings);
  assert.equal(firstMappings[0].attachedContainerName, "network-workspace-db-1");
  assert.equal(firstMappings[0].attachedContainerId, "newclone987");
  assert.deepEqual(await repair(), firstMappings);
  assert.equal(inspectCalls.length, 1);
});

for (const failure of ["unavailable", "missing rows"] as const) {
  test(`inspect ${failure} is retried once per snapshot instead of once per attachment`, async () => {
    let inspectCalls = 0;
    let recovered = false;
    const adapter = new ContainerServiceDiscoveryAdapter({ runCommand: async (_executable, args) => {
      if (args[1] !== "inspect") {
        return output({ ...clone, Names: undefined }, original);
      }
      inspectCalls += 1;
      if (!recovered && failure === "unavailable") {
        throw new Error("No such container");
      }
      return { stdout: JSON.stringify(recovered ? [{ Id: "newclone987", Name: "/network-workspace-db-1" }] : []), stderr: "" };
    }});
    const session = await adapter.createSession(settings);
    assert.ok(session);
    const repair = () => session.refreshComposeContainerMappings("workspace", "network-workspace", composeFiles, ["db"], mappings);
    await repair();
    await repair();
    assert.equal(inspectCalls, 1);

    recovered = true;
    const next = await adapter.createSession(settings);
    assert.ok(next);
    const refreshed = await next.refreshComposeContainerMappings("workspace", "network-workspace", composeFiles, ["db"], mappings);
    assert.equal(inspectCalls, 2);
    assert.equal(refreshed[0].attachedContainerName, "network-workspace-db-1");
  });
}

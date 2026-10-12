import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GuardedRoutePolicyCache } from "../../src/core/networks/logical-route-selection";
import { buildMacosNetworkSandboxProfile } from "../../src/platform/process/macos-network-sandbox";
import { networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";
import type { NetworkRuntimeScope, NetworkShellLaunch } from "../../src/platform/process/macos-network-runtime";

const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
const messages: string[] = [];
let nextMenuChoice: { networkId?: string; action?: string } | undefined;
const executedCommands: string[] = [];
let profileConfiguration: { get<T>(key: string): T | undefined; update(key: string, value: unknown, target: unknown): Promise<void> } | undefined;
const vscodeFixture = {
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    workspaceFolders: [{ uri: { scheme: "file", fsPath: "/another-window" } }],
    getConfiguration: (section?: string) => section === "terminal.integrated" && profileConfiguration !== undefined
      ? profileConfiguration : { get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined },
  },
  window: {
    registerTerminalProfileProvider: () => ({ dispose() {} }),
    showInformationMessage: async (message: string) => { messages.push(message); },
    showWarningMessage: async () => undefined,
    showQuickPick: async (items: { networkId?: string; action?: string }[]) => nextMenuChoice === undefined ? undefined
      : items.find(item => nextMenuChoice?.networkId !== undefined ? item.networkId === nextMenuChoice.networkId : item.action === nextMenuChoice?.action),
  },
  commands: {
    executeCommand: async (id: string) => { executedCommands.push(id); },
    registerCommand: (id: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.set(id, handler);
      return { dispose() {} };
    },
  },
  TreeItem: class TreeItem {},
  ThemeIcon: class ThemeIcon {},
  ThemeColor: class ThemeColor {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};

/** Load the actual orchestration with VS Code as the only replaced boundary. */
function loadExtension<T>(name: string): T {
  const loader = require("node:module") as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const original = loader._load;
  loader._load = (request, parent, isMain) => request === "vscode" ? vscodeFixture : original(request, parent, isMain);
  try { return require(path.resolve(__dirname, "../../src/extension", name + ".js")) as T; }
  finally { loader._load = original; }
}

/** Roll back only PM's owned default; preserve a user's subsequent choice. */
test("host terminal restoration removes only the default profile installed by PM", async context => {
  const { PortManagerNetworkService } = loadExtension<typeof import("../../src/extension/network-service")>("network-service");
  context.after(() => { profileConfiguration = undefined; });
  for (const [current, saved, expected] of [
    ["Port Manager: Logical Network", { value: "zsh" }, "zsh"],
    ["Port Manager: Logical Network", undefined, undefined],
    ["fish", { value: "zsh" }, "fish"],
  ] as const) {
    let profile: string | undefined = current;
    const cleared: unknown[] = [];
    profileConfiguration = { get: <T>() => profile as T, update: async (key, value, target) => {
      assert.equal(key, "defaultProfile.osx"); assert.equal(target, 2); profile = value as string | undefined;
    } };
    const service = Object.assign(Object.create(PortManagerNetworkService.prototype), {
      context: { workspaceState: { get: () => saved, update: async (_key: string, value: unknown) => { cleared.push(value); } } },
    }) as { restoreHostDefaultTerminalProfile(): Promise<void> };
    await service.restoreHostDefaultTerminalProfile();
    assert.equal(profile, expected);
    assert.deepEqual(cleared, saved === undefined ? [] : [undefined]);
  }
});

/** Multiple extension generations can leave host-only PM shims on PATH. Use
 * actual kernel denial so an unreadable wrapper cannot masquerade as a tool. */
test("guarded package and runtime resolution skips protected inherited PM shims", {
  skip: process.platform !== "darwin", timeout: 15_000,
}, context => {
  const { prepareRuntimeShimLauncherDirectory, buildRuntimeShimPath } = loadExtension<typeof import("../../src/extension/terminal-hook-environment")>("terminal-hook-environment");
  const root = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "pm-shim-scope-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = networkNamespacePaths(root, "shim-network");
  fs.mkdirSync(own.directory, { recursive: true });
  const inherited = path.join(root, ".portmanager", "runtime-shims");
  const realTools = path.join(root, "real-tools");
  fs.mkdirSync(inherited, { recursive: true });
  fs.mkdirSync(realTools);
  fs.writeFileSync(path.join(inherited, ".portmanager-shim-stamp"), "old-generation\n");
  const nativeLauncher = path.resolve(__dirname, "../../../media/native/portmanager_asdf_shim");
  const active = prepareRuntimeShimLauncherDirectory(path.join(root, "current-extension"), nativeLauncher)!;
  // A copied older launcher has a different inode from the current alias.
  fs.copyFileSync(nativeLauncher, path.join(inherited, "node"));
  fs.chmodSync(path.join(inherited, "node"), 0o700);
  const alias = path.join(root, "inherited-alias");
  fs.symlinkSync(inherited, alias);
  const inheritedPath = [inherited, realTools, active, alias, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  assert.equal(buildRuntimeShimPath(active, inheritedPath), [active, realTools, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    "bootstrap must preserve real tool order while dropping both the old directory and its alias");
  for (const command of ["uv", "pnpm", "vite"]) {
    fs.writeFileSync(path.join(inherited, command), "#!/bin/sh\nprintf '__WRONG_HOST_SHIM__\\n'\nexit 91\n", { mode: 0o700 });
    fs.writeFileSync(path.join(realTools, command), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), hook: process.env.PORT_MANAGER_HOOK, disabled: process.env.PORT_MANAGER_HOOK_DISABLED, shim: process.env.PORT_MANAGER_RUNTIME_SHIM_DIR }));\n', { mode: 0o700 });
  }
  const profile = buildMacosNetworkSandboxProfile({ networkId: "shim-network", namespaceDirectories: [own.directory], sharedWorkspaceDirectories: [root] });
  const env = { PATH: [active, inherited, alias, realTools, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    PORT_MANAGER_RUNTIME_SHIM_DIR: active, PORT_MANAGER_GUARDED_SESSION_ID: "fixture-session",
    PORT_MANAGER_HOOK: "1", PORT_MANAGER_HOOK_DISABLED: "0" };
  const denied = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", path.join(inherited, "uv")], { env, encoding: "utf8" });
  assert.notEqual(denied.status, 0, "the inherited host shim must stay protected");
  assert.match(denied.stderr, /Operation not permitted|Permission denied/);
  for (const command of ["uv", "pnpm", "vite"]) {
    const args = command === "vite" ? ["--version"] : ["install", "--offline"];
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, path.join(active, command), ...args], { cwd: root, env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.equal(result.stderr, "", `${command} must not attempt to read the protected shim`);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.args, args);
    assert.equal(output.hook, "1", "guarded dependency commands must retain broker routing");
    assert.equal(output.disabled, "0");
    assert.equal(output.shim, active);
  }
  const node = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, path.join(active, "node"), "-e", "process.stdout.write('real-node')"], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(node.status, 0, node.stderr);
  assert.equal(node.stdout, "real-node");
  const uname = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/uname", "-a"], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(uname.status, 0, uname.stderr);
  assert.match(uname.stdout, /^Darwin /, "host runtimes must be able to initialize their public OS information");
  const certificate = path.join(root, "fixture-cert.pem");
  execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(root, "fixture-key.pem"),
    "-out", certificate, "-subj", "/CN=pm-toolchain-fixture", "-days", "1"], { stdio: "ignore", timeout: 5000 });
  const trust = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/security", "verify-cert", "-L", "-c", certificate,
    "-r", certificate, "-p", "basic"], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(trust.status, 0, trust.stderr || trust.stdout);
  for (const command of ["uv", "pnpm"]) {
    const cooperativeEnv: NodeJS.ProcessEnv = { ...env };
    delete cooperativeEnv.PORT_MANAGER_GUARDED_SESSION_ID;
    const result = spawnSync(path.join(active, command), ["install", "--offline"], { cwd: root, env: cooperativeEnv, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hook, "0", "cooperative terminals retain their existing clean dependency-manager behavior");
    assert.equal(output.disabled, "1");
    assert.equal(output.shim, undefined);
  }
});

test("guarded preparation uses approved routes even while legacy Docker recovery is stalled", {
  skip: process.platform !== "darwin", timeout: 3000,
}, async context => {
  const { PortManagerNetworkService } = loadExtension<typeof import("../../src/extension/network-service")>("network-service");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-startup-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const network = { id: "network-payroll", name: "payrollp", runtimeKind: "nativeHelper" };
  const routes = [
    { port: 5432, targetHost: "127.0.0.1", targetPort: 55432 },
    { port: 8000, targetHost: "127.0.0.1", targetPort: 58000 },
  ];
  const calls: string[] = [];
  let scope: NetworkRuntimeScope | undefined;
  const service = Object.assign(Object.create(PortManagerNetworkService.prototype), {
    context: { globalStorageUri: { fsPath: root }, asAbsolutePath: (relative: string) => path.join(root, "unpacked", relative) },
    registry: {
      getNetwork: (id: string) => id === network.id ? network : undefined,
      getSnapshot: () => ({
        networks: [network], runtimes: [{ kind: "nativeHelper" }],
        hostAccessBindings: [{ networkId: network.id, status: "active", protocol: "tcp", logicalPort: 5432,
          hostAddress: "127.0.0.1", hostPort: 55432 }],
        composeAttachments: [
          { networkId: network.id, status: "attached", ports: [{ protocol: "tcp", logicalPort: 8000,
            actualHostAddress: "127.0.0.1", actualHostPort: 58000 }] },
          { networkId: "other-network", status: "attached", ports: [{ protocol: "tcp", logicalPort: 9000,
            actualHostAddress: "127.0.0.1", actualHostPort: 59000 }] },
        ],
      }),
    },
    processService: { getSnapshot: () => ({ routes: [] }) },
    guardedRoutePolicies: new GuardedRoutePolicyCache(),
    ensureTerminalRoutingHostReadyForNetwork: async () => { calls.push("host-ready"); },
    ensureNetworkComposeRoutingArtifacts: () => {
      calls.push("docker-recovery");
      return new Promise<void>(() => {});
    },
    getGuardedRuntime: () => ({ prepareShell: async (selected: NetworkRuntimeScope, cwd: string) => {
      calls.push("prepare"); scope = selected;
      return { id: "launch", networkId: selected.id, cwd, shellPath: "/launcher", shellArgs: [], env: {} };
    } }),
  }) as { prepareGuardedShell(id: string, cwd: string): Promise<NetworkShellLaunch> };

  const launch = await service.prepareGuardedShell(network.id, root);
  assert.equal(launch.networkId, network.id);
  assert.deepEqual(calls, ["host-ready", "prepare"]);
  assert.deepEqual(scope?.routes, routes, "Host Access and Compose authority still reaches the fixed-network broker");
  assert.ok(scope?.workspaceDirectories.includes(root), "external cwd is shared independently of the controller workspace");
  assert.ok(scope?.bootstrapEnvironment?.PORT_MANAGER_RUNTIME_SHIM_DIR.includes(`${path.sep}guarded-runtime${path.sep}`),
    "older live windows must not overwrite this owner's guarded shim templates");
  await assert.rejects(service.prepareGuardedShell("removed-network", root), /Unknown logical network/);
  assert.deepEqual(calls, ["host-ready", "prepare"], "invalid networks never reach the runtime");
});

test("guarded VS Code pm menu retains its shell on cancel and exposes diagnostics and trusted network selection", async context => {
  const { PortManagerNetworkService } = loadExtension<typeof import("../../src/extension/network-service")>("network-service");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-profile-menu-")));
  context.after(() => { nextMenuChoice = undefined; fs.rmSync(root, { recursive: true, force: true }); });
  const terminal = {};
  const owner = { launch: { id: "scope-menu", networkId: "network-a", cwd: root, env: { ZDOTDIR: root } }, ready: Promise.resolve() };
  const actions: string[] = [];
  const service = Object.assign(Object.create(PortManagerNetworkService.prototype), {
    guardedTerminals: new Map([[terminal, owner]]),
    registry: { getSnapshot: () => ({ networks: [{ id: "network-a", name: "알파 A" }, { id: "network-b", name: "Beta B" }] }) },
    replaceGuardedTerminal: async (selected: object, networkId: string) => { assert.equal(selected, terminal); actions.push(networkId); },
    detachGuardedVscodeTerminal: async () => { actions.push("detach"); },
  }) as { showGuardedTerminalMenu(id: string): Promise<void> };
  nextMenuChoice = undefined;
  await service.showGuardedTerminalMenu("scope-menu");
  assert.deepEqual(actions, []);
  nextMenuChoice = { action: "routes" };
  await service.showGuardedTerminalMenu("scope-menu");
  assert.equal(fs.readFileSync(path.join(root, "menu.command"), "utf8"), "routes\n");
  assert.deepEqual(actions, []);
  nextMenuChoice = { networkId: "network-b" };
  await service.showGuardedTerminalMenu("scope-menu");
  assert.deepEqual(actions, ["network-b"]);
  nextMenuChoice = { action: "repair" };
  await service.showGuardedTerminalMenu("scope-menu");
  assert.equal(executedCommands.at(-1), "portManager.fixStaleRouting");
});

test("creating the macOS pm command does not wait for daemon or legacy Compose recovery", {
  skip: process.platform !== "darwin", timeout: 3000,
}, async () => {
  const { PortManagerNetworkService } = loadExtension<typeof import("../../src/extension/network-service")>("network-service");
  const calls: string[] = [];
  const stalled = () => new Promise<void>(() => {});
  const service = Object.assign(Object.create(PortManagerNetworkService.prototype), {
    registry: { getNetwork: () => ({ runtimeKind: "nativeHelper" }), getSnapshot: () => ({ runtimes: [{ kind: "nativeHelper" }] }) },
    processService: { start: stalled }, ensureNetworkComposeRoutingArtifacts: stalled,
    ensureExternalTerminalControl: async () => { calls.push("controller"); },
    shouldRunLogicalPortGatewayDaemon: () => false,
    buildTerminalRoutingScript: () => ". /tmp/pm-host-fixture.sh",
  }) as { createTerminalRoutingScript(id: string): Promise<string> };
  assert.equal(await service.createTerminalRoutingScript("payrollp"), ". /tmp/pm-host-fixture.sh");
  assert.deepEqual(calls, [], "normal pm must neither create a protected controller nor wait for Docker recovery");
});

test("Start Daemon responds from a worker without waiting for owner recovery", { timeout: 3000 }, async () => {
  const { PortManagerCommandController } = loadExtension<typeof import("../../src/extension/commands")>("commands");
  const calls: string[] = [];
  let allowOwnerAttempt = false;
  const controller = new PortManagerCommandController({
    processService: {
      start: async () => { calls.push("start"); },
      getSnapshot: () => ({ daemon: { status: "running", pid: 1234, listenerCount: 7, routeCount: 2 } }),
    } as never,
    networkService: {
      getSnapshot: () => ({ controlPlane: { role: "worker" } }),
      takeControlPlaneOwnership: async () => {
        assert.ok(allowOwnerAttempt, "Start Daemon must not enter the stalled owner startup path");
        calls.push("owner"); return false;
      },
    } as never,
    treeProvider: { refresh: () => { calls.push("refresh"); } } as never,
  });
  controller.register({ subscriptions: [] } as never);
  try {
    await handlers.get("portManager.startDaemon")!();
    assert.deepEqual(calls, ["start", "refresh"]);
    assert.match(messages.at(-1)!, /daemon running: pid 1234/);
    allowOwnerAttempt = true;
    await handlers.get("portManager.restartDaemon")!();
    await handlers.get("portManager.stopDaemon")!();
    assert.deepEqual(calls, ["start", "refresh", "owner", "owner"], "destructive daemon actions retain their owner gate");
  } finally { controller.dispose(); }
});

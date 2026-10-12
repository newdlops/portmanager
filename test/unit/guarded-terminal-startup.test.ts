import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GuardedRoutePolicyCache } from "../../src/core/networks/logical-route-selection";
import type { NetworkRuntimeScope, NetworkShellLaunch } from "../../src/platform/process/macos-network-runtime";

const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
const messages: string[] = [];
let nextMenuChoice: { networkId?: string; action?: string } | undefined;
const executedCommands: string[] = [];
const vscodeFixture = {
  workspace: {
    workspaceFolders: [{ uri: { scheme: "file", fsPath: "/another-window" } }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined }),
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
    buildGuardedExternalCommand: (networkId: string) => `pm-fixture ${networkId}`,
  }) as { createTerminalRoutingScript(id: string): Promise<string> };
  assert.equal(await service.createTerminalRoutingScript("payrollp"), "pm-fixture payrollp");
  assert.deepEqual(calls, ["controller"]);
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

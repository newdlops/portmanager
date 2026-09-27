import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { formatSidebarCounts, formatSidebarSummary, summarizeSidebarIssues } from "../../src/ui/sidebar/sidebar-presentation";
import type { AgentDaemonStatus } from "../../src/shared/types";
import type { AgentSnapshot, LogicalNetwork, NetworkSnapshot } from "../../src/shared/types";

/** Loads the compiled tree with the minimal VS Code item primitives needed for fixture-level UI output tests. */
function loadSidebarTreeForFixtureTests(): typeof import("../../src/ui/sidebar/port-manager-tree") {
  const moduleLoader = require("node:module") as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  class TreeItem {
    constructor(readonly label: string, readonly collapsibleState: number) {}
  }
  class MarkdownString {
    isTrusted: boolean | undefined;
    value: string;
    constructor(value: string = "") {
      this.value = value;
    }
    appendMarkdown(value: string): void {
      this.value += value;
    }
  }

  moduleLoader._load = (request, parent, isMain) =>
    request === "vscode"
      ? {
          TreeItem,
          MarkdownString,
          ThemeIcon: class ThemeIcon {},
          ThemeColor: class ThemeColor {},
          DataTransferItem: class DataTransferItem {
            constructor(readonly value: unknown) {}
          },
          TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
          EventEmitter: class EventEmitter {
            readonly event = () => undefined;
            fire(): void {}
            dispose(): void {}
          },
        }
      : originalLoad(request, parent, isMain);

  try {
    return require(path.resolve(__dirname, "../../src/ui/sidebar/port-manager-tree.js")) as typeof import("../../src/ui/sidebar/port-manager-tree");
  } finally {
    moduleLoader._load = originalLoad;
  }
}

test("sidebar compact summaries use deterministic singular and plural grammar", () => {
  assert.equal(formatSidebarSummary("Ready"), "Ready");
  assert.equal(formatSidebarSummary("Ready", [{ count: 0, singular: "route" }]), "Ready");
  assert.equal(formatSidebarSummary("Ready", [{ count: 1, singular: "route" }]), "Ready · 1 route");
  assert.equal(
    formatSidebarSummary("Ready", [
      { count: 2, singular: "route" },
      { count: 3, singular: "host access", plural: "host access entries" },
    ]),
    "Ready · 2 routes · 3 host access entries",
  );
  assert.equal(formatSidebarCounts([{ count: 0, singular: "route" }]), "");
  assert.equal(
    formatSidebarCounts([
      { count: 2, singular: "route" },
      { count: 1, singular: "terminal" },
    ]),
    "2 routes · 1 terminal",
  );
});

test("sidebar issue badge counts only failures, never transitional daemon states", () => {
  const snapshot = {
    networks: [{ status: "error" }, { status: "running" }],
    attachments: [{ status: "error" }, { status: "attached" }],
    composeAttachments: [{ status: "attached" }],
    exposures: [{ status: "error" }, { status: "opening" }],
    hostAccessBindings: [{ status: "active" }],
  } as unknown as NetworkSnapshot;
  const agentSnapshot = { routes: [{ status: "error" }, { status: "starting" }] } as unknown as AgentSnapshot;
  const daemon = { status: "running", restartRequired: true } as AgentDaemonStatus;

  assert.deepEqual(summarizeSidebarIssues(snapshot, agentSnapshot, daemon), {
    count: 5,
    tooltip: "Port Manager: daemon restart required, 1 network error, 1 terminal error, 1 host binding error, 1 route error",
  });

  const healthy = {
    networks: [], attachments: [], composeAttachments: [], exposures: [], hostAccessBindings: [],
  } as unknown as NetworkSnapshot;
  for (const status of ["starting", "disconnected", "running"] as const) {
    assert.deepEqual(
      summarizeSidebarIssues(healthy, { routes: [] } as unknown as AgentSnapshot, { status } as AgentDaemonStatus),
      { count: 0, tooltip: "" },
    );
  }
});

test("sidebar root has the required stable scan order", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const source = fs.readFileSync(sourcePath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    contributes?: { menus?: { "view/item/context"?: Array<{ when?: string }> } };
  };
  const rootStart = source.indexOf("if (element === undefined) {");
  const rootEnd = source.indexOf("if (element instanceof LogicalNetworkTreeItem)", rootStart);
  const rootBody = source.slice(rootStart, rootEnd);

  // Networks sit directly at the root, between onboarding shortcuts and the collapsed sections.
  assert.equal(rootBody.indexOf("buildOnboardingActionItems") < rootBody.indexOf("new LogicalNetworkTreeItem"), true);
  assert.equal(rootBody.indexOf("new LogicalNetworkTreeItem") < rootBody.indexOf("buildStaleRouteScopeItems"), true);
  assert.equal(rootBody.indexOf("buildStaleRouteScopeItems") < rootBody.indexOf('"Services"'), true);
  assert.equal(rootBody.indexOf('"Services"') < rootBody.indexOf('"System"'), true);
  assert.equal(rootBody.includes('"Overview"'), false);
  assert.equal(rootBody.includes('"Networks"'), false);
  assert.equal(rootBody.includes('"Terminal Windows"'), false);
  assert.equal(rootBody.includes('"Host Port Exposures"'), false);
  assert.equal(rootBody.includes('"Runtime Adapter"'), false);
  const menuWhen = (manifest.contributes?.menus?.["view/item/context"] ?? []).map((item) => item.when ?? "").join("\n");
  assert.equal(menuWhen.includes("viewItem == section.networks"), false);
  assert.equal(menuWhen.includes("viewItem == section.containers"), true);
  assert.equal(menuWhen.includes("viewItem == section.daemon"), true);
});

test("diagnostics exposes stale routing repair and recent activity", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const source = fs.readFileSync(sourcePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{ command: string; title: string }>;
      menus?: { "view/item/context"?: Array<{ command: string; when?: string }> };
    };
  };
  const menuItems = manifest.contributes?.menus?.["view/item/context"] ?? [];

  assert.equal(networkServiceSource.includes("async fixStaleRouting(): Promise<StaleRoutingRepairSummary>"), true);
  assert.equal(networkServiceSource.includes("await this.convergeDaemonAndRoutingState();"), true);
  assert.equal(commandsSource.includes('"portManager.fixStaleRouting"'), true);
  assert.equal(commandsSource.includes("this.dependencies.networkService.fixStaleRouting()"), true);
  assert.equal(commandsSource.includes('"portManager.clearGlobalStorageFiles"'), true);
  assert.equal(commandsSource.includes("this.dependencies.networkService.clearGlobalStorageFiles()"), true);
  assert.equal(source.includes('"Fix Stale Routing"'), true);
  assert.equal(source.includes('"Repair Local DNS"'), true);
  assert.equal(source.includes('"Clear Global Storage Files"'), true);
  assert.equal(source.includes("class RoutingTimelineGroupTreeItem"), false);
  assert.equal(source.includes('"No activity"'), true);
  assert.equal(source.includes("buildRoutingTimelineRows(snapshot, agentSnapshot)"), true);
  assert.equal(source.includes('"Control Owner"'), true);
  assert.equal(source.includes("buildControlPlaneTooltip(snapshot.controlPlane)"), true);
  assert.equal(source.includes('command: "portManager.openOwnerUi"'), true);
  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.fixStaleRouting"), true);
  assert.equal(
    manifest.contributes?.commands?.some((item) => item.command === "portManager.fixStaleRouting"),
    true,
  );
  assert.equal(
    manifest.contributes?.commands?.some((item) => item.command === "portManager.repairLocalDns"),
    true,
  );
  assert.equal(
    manifest.contributes?.commands?.some((item) => item.command === "portManager.clearGlobalStorageFiles"),
    true,
  );
  assert.equal(
    menuItems.some((item) => item.command === "portManager.fixStaleRouting" && item.when?.includes("section.daemon")),
    true,
  );
  assert.equal(
    menuItems.some((item) => item.command === "portManager.repairLocalDns" && item.when?.includes("section.daemon")),
    true,
  );
  assert.equal(
    menuItems.some((item) => item.command === "portManager.clearGlobalStorageFiles" && item.when?.includes("section.daemon")),
    true,
  );
});

test("non-owner windows show ownership transfer guidance while keeping actions actionable", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const activatePath = path.resolve(__dirname, "../../../src/extension/activate.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const typesPath = path.resolve(__dirname, "../../../src/shared/types.ts");
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const source = fs.readFileSync(sourcePath, "utf8");
  const activateSource = fs.readFileSync(activatePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const typesSource = fs.readFileSync(typesPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    activationEvents?: string[];
    contributes?: {
      menus?: {
        "view/title"?: Array<{ command: string; when?: string }>;
        "view/item/context"?: Array<{ command: string; when?: string; group?: string }>;
      };
    };
  };
  const viewTitleItems = manifest.contributes?.menus?.["view/title"] ?? [];
  const menuItems = manifest.contributes?.menus?.["view/item/context"] ?? [];
  const visibleOwnerPromotingCommands = [
    "portManager.removeLogicalNetwork",
    "portManager.attachContainerToNetwork",
    "portManager.refreshContainerServices",
    "portManager.refreshTerminals",
    "portManager.detachComposeAttachment",
    "portManager.detachTerminalFromNetwork",
  ];
  // These used to be sidebar action rows visible in every window; the network
  // context menu replaced them, so none of its entries may hide behind the owner gate.
  const networkMenuCommands = [
    "portManager.openNetworkTerminal",
    "portManager.attachActiveTerminalToNetwork",
    "portManager.attachTerminalToNetwork",
    "portManager.attachVscodeWindowTerminalsToNetwork",
    "portManager.attachContainerToNetwork",
    "portManager.copyTerminalRoutingScript",
    "portManager.addHostPortExposure",
    "portManager.addHostAccessBinding",
    "portManager.addComposePublishedPort",
    "portManager.attachProcessToNetwork",
    "portManager.saveBindingPreset",
    "portManager.applyBindingPreset",
    "portManager.clearNetworkCache",
    "portManager.removeLogicalNetwork",
  ];

  assert.equal(typesSource.includes('export type ControlPlaneRole = "owner" | "worker" | "unowned";'), true);
  assert.equal(typesSource.includes("export interface ControlPlaneStatus"), true);
  assert.equal(typesSource.includes("readonly ownerFocusPid?: number;"), true);
  assert.equal(typesSource.includes("readonly ownerTitle?: string;"), true);
  assert.equal(typesSource.includes("readonly ownerWorkspaceUri?: string;"), true);
  assert.equal(typesSource.includes("readonly controlPlane?: ControlPlaneStatus;"), true);
  assert.equal(networkServiceSource.includes("getControlPlaneStatus(): ControlPlaneStatus"), true);
  assert.equal(networkServiceSource.includes("controlPlane: this.getControlPlaneStatus()"), true);
  assert.equal(networkServiceSource.includes("ownerTitle: owner?.title"), true);
  assert.equal(networkServiceSource.includes("ownerWorkspaceUri: owner?.workspaceUri"), true);
  assert.equal(networkServiceSource.includes("title: buildCurrentVsCodeWindowTitle()"), true);
  assert.equal(networkServiceSource.includes("workspaceUri: buildCurrentVsCodeProjectUri()"), true);
  assert.equal(networkServiceSource.includes("function buildCurrentVsCodeWindowTitle()"), true);
  assert.equal(networkServiceSource.includes("function buildCurrentVsCodeProjectUri()"), true);
  assert.equal(networkServiceSource.includes("focusControlPlaneOwnerWindow(): Promise<boolean>"), true);
  assert.equal(networkServiceSource.includes("openControlPlaneOwnerWorkspace(controlPlane.ownerWorkspaceUri)"), true);
  assert.equal(networkServiceSource.includes('vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.parse(ownerWorkspaceUri), true)'), true);
  assert.equal(networkServiceSource.includes("requestControlPlaneOwnerUiFocus"), false);
  assert.equal(networkServiceSource.includes("CONTROL_PLANE_OWNER_UI_REQUEST_PATH"), false);
  assert.equal(networkServiceSource.includes("watchOwnerUiFocusRequests"), false);
  assert.equal(networkServiceSource.includes("openOwnerUiFromFocusRequest"), false);
  assert.equal(activateSource.includes('"portManager.isControlPlaneOwner"'), true);
  assert.equal(activateSource.includes('snapshot.controlPlane?.role === "owner"'), true);
  assert.equal(source.includes("buildOwnerActionAvailability(snapshot.controlPlane)"), true);
  assert.equal(source.includes('this.contextValue = availability.enabled ? "action" : "action.disabled";'), true);
  assert.equal(source.includes('this.description = description;'), true);
  assert.equal(source.includes("Owner-scoped commands stay actionable because their command wrapper acquires ownership."), true);
  assert.equal(source.includes("function buildOwnerTakeoverCommand"), false);
  assert.equal(source.includes("formatOwnerOnlyActionReason(controlPlane)"), true);
  assert.equal(source.includes("buildOwnerUiActionRows(snapshot.controlPlane)"), true);
  assert.equal(source.includes("formatOwnerWindowTitle(controlPlane)"), true);
  assert.equal(source.includes('new VscodeWindowTerminalBindingTreeItem(windowTerminalBinding, element.network, ownerAction)'), false);
  // The owner button transfers control-plane ownership to the current window
  // (takeControlPlaneOwnership) rather than navigating to the elected owner.
  assert.equal(source.includes('"Make This Window Owner"'), true);
  assert.equal(commandsSource.includes('label: "$(lock) Owner actions disabled"'), true);
  assert.equal(commandsSource.includes('label: "$(window) Make This Window Owner"'), true);
  assert.equal(commandsSource.includes('action: "ownerUi" as const'), true);
  assert.equal(commandsSource.includes('"portManager.openOwnerUi"'), true);
  assert.equal(commandsSource.includes("this.dependencies.networkService.takeControlPlaneOwnership()"), true);
  assert.equal(commandsSource.includes("ensureControlPlaneOwnerForCommand"), true);
  assert.equal(commandsSource.includes("requiresControlPlaneOwner: true"), true);
  assert.equal(commandsSource.includes('"setContext", "portManager.isControlPlaneOwner", true'), true);
  assert.equal(commandsSource.includes("switchControlOwnerToThisWindow"), true);
  assert.equal(commandsSource.includes("is now the control owner"), true);
  assert.equal(commandsSource.includes("switched control ownership to this window"), true);
  assert.equal(networkServiceSource.includes("async takeControlPlaneOwnership(): Promise<boolean>"), true);
  assert.equal(commandsSource.includes("requestControlPlaneOwnerUiFocus()"), false);
  assert.equal(commandsSource.includes('action: "ownerOnly" as const'), true);
  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.openOwnerUi"), true);

  for (const command of visibleOwnerPromotingCommands) {
    const contextItems = menuItems.filter((item) => item.command === command);
    assert.equal(contextItems.length > 0, true, `${command} must have context menu entries`);
    assert.equal(
      contextItems.some((item) => !item.when?.includes("portManager.isControlPlaneOwner")),
      true,
      `${command} context menu entries must stay visible so the command can acquire ownership`,
    );
  }

  const networkMenuItems = menuItems.filter(
    (item) => (item.when ?? "").includes("viewItem == logicalNetwork") && !(item.group ?? "").startsWith("inline"),
  );
  assert.deepEqual(networkMenuItems.map((item) => item.command), networkMenuCommands);
  for (const item of networkMenuItems) {
    assert.equal(
      item.when?.includes("portManager.isControlPlaneOwner"),
      false,
      `${item.command} network menu entry must stay visible so the command can acquire ownership`,
    );
  }

  assert.equal(
    menuItems
      .filter((item) => item.command === "portManager.attachVscodeWindowTerminalsToNetwork")
      .some((item) => (item.when ?? "").includes("viewItem == logicalNetwork") && !(item.when ?? "").includes("portManager.isControlPlaneOwner")),
    true,
  );
  assert.equal(
    menuItems
      .filter((item) => item.command === "portManager.detachVscodeWindowTerminalsFromNetwork")
      .some((item) => (item.when ?? "").includes("vscodeWindowTerminalBinding") && !(item.when ?? "").includes("portManager.isControlPlaneOwner")),
    true,
  );

  assert.equal(
    viewTitleItems
      .filter((item) => item.command === "portManager.createLogicalNetwork" || item.command === "portManager.refresh")
      .every((item) => !item.when?.includes("portManager.isControlPlaneOwner")),
    true,
  );
  assert.equal(
    viewTitleItems.some(
      (item) =>
        item.command === "portManager.openOwnerUi" && item.when?.includes("!portManager.isControlPlaneOwner"),
    ),
    true,
  );
});

test("sidebar marks the current network and lists route destinations", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");

  assert.equal(source.includes('"Overview"'), false);
  assert.equal(source.includes('"This window"'), true);
  assert.equal(source.includes("class NetworkRoutingGroupTreeItem"), true);
  assert.equal(source.includes("class NetworkRouteConnectionTreeItem"), true);
  assert.equal(source.includes("getRouteRows(network.id).length"), true);
  assert.equal(source.includes("Compact active/current context projection"), true);
  assert.equal(source.includes("Current VS Code Terminal Network"), true);
  assert.equal(networkServiceSource.includes("getAgentSnapshot(): AgentSnapshot"), true);
});

test("current routing projection excludes inactive lifecycle rows", () => {
  const sidebar = loadSidebarTreeForFixtureTests();
  const networks = [
    { id: "terminal", name: "Terminal network", status: "running", runtimeKind: "proxy", createdAt: "2026-07-29T00:00:00.000Z" },
    { id: "route", name: "Route network", status: "running", runtimeKind: "proxy", createdAt: "2026-07-29T00:00:00.000Z" },
    { id: "host", name: "Host network", status: "running", runtimeKind: "proxy", createdAt: "2026-07-29T00:00:00.000Z" },
    { id: "exposure", name: "Exposure network", status: "running", runtimeKind: "proxy", createdAt: "2026-07-29T00:00:00.000Z" },
    { id: "compose", name: "Compose network", status: "running", runtimeKind: "proxy", createdAt: "2026-07-29T00:00:00.000Z" },
  ] as const satisfies readonly LogicalNetwork[];
  const snapshot = {
    networks,
    attachments: [
      { id: "attached", networkId: "terminal", status: "attached" },
      { id: "detached", networkId: "inactive-terminal", status: "detached" },
      { id: "failed", networkId: "inactive-terminal-error", status: "error" },
    ],
    hostAccessBindings: [
      { id: "active-host", networkId: "host", status: "active" },
      { id: "failed-host", networkId: "inactive-host-error", status: "error" },
    ],
    exposures: [
      { id: "active-exposure", networkId: "exposure", status: "active" },
      { id: "stopped-exposure", networkId: "inactive-exposure", status: "stopped" },
      { id: "failed-exposure", networkId: "inactive-exposure-error", status: "error" },
    ],
    composeAttachments: [
      { id: "attached-compose", networkId: "compose", status: "attached" },
      { id: "detached-compose", networkId: "inactive-compose", status: "detached" },
      { id: "failed-compose", networkId: "inactive-compose-error", status: "error" },
    ],
  } as unknown as NetworkSnapshot;
  const agentSnapshot = {
    routes: [
      { networkId: "route", status: "running" },
      { networkId: "inactive-route", status: "stopped" },
      { networkId: "inactive-route-error", status: "error" },
    ],
  } as unknown as AgentSnapshot;
  const projection = sidebar.projectCurrentRouting(snapshot, agentSnapshot);

  assert.deepEqual(projection.networkIds, ["terminal", "route", "host", "exposure", "compose"]);
  assert.equal(projection.attachedTerminalCount, 1);
});

test("routes whose network row is gone surface as stale root scopes", () => {
  const sidebar = loadSidebarTreeForFixtureTests();
  const provider = new sidebar.PortManagerTreeProvider({
    getSnapshot: () => ({
      networks: [],
      attachments: [],
      exposures: [],
      hostAccessBindings: [],
      composeAttachments: [],
      terminalWindows: [],
      terminalCandidates: [],
      containerServiceCandidates: [],
      runtimes: [],
      vscodeWindowTerminalBinding: undefined,
      controlPlane: { role: "owner", currentPid: 7 },
    }) as unknown as NetworkSnapshot,
    getDaemonStatus: () => ({ status: "running", pid: 0, listenerCount: 0, routeCount: 0, updatedAt: "now" }) as never,
    getAgentSnapshot: () => ({
      routes: [
        { networkId: "deadbeef-removed", logicalPort: 3000, actualPort: 3000, host: "127.9.9.9", status: "running", source: "hooked", processName: "node" },
      ],
    }) as unknown as AgentSnapshot,
    getBrowserDnsResolverStatus: () => ({ supported: false, records: [] }) as never,
    onDidChange: () => ({ dispose(): void {} }),
  });
  const roots = provider.getChildren() as Array<{ label: string; description: string; contextValue: string }>;
  const stale = roots.find((item) => item.contextValue === "networkRoutingGroup");

  assert.equal(stale?.label, "Unknown network deadbeef");
  assert.equal(stale?.description, "Stale · 1 route");
  const routes = provider.getChildren(stale as never) as Array<{ label: string; description: string }>;
  assert.deepEqual(routes.map((item) => [item.label, item.description]), [["3000 → 127.9.9.9:3000", "node"]]);
});

test("network descriptions lead with state and preserve singular counts", () => {
  const sidebar = loadSidebarTreeForFixtureTests();
  const network = {
    id: "ready-network",
    name: "Ready network",
    status: "running",
    runtimeKind: "proxy",
    createdAt: "2026-07-29T00:00:00.000Z",
  } as LogicalNetwork;
  const item = new sidebar.LogicalNetworkTreeItem(
    network,
    [{ networkId: network.id }] as never,
    [{ networkId: network.id }] as never,
    [],
    [],
    1,
  );

  // Host bindings are already counted as routes, so the row keeps two counts.
  assert.equal(item.description, "Active · 1 route · 1 terminal");
  assert.equal(item.description?.includes("running"), false);
  assert.equal((item as unknown as { collapsibleState: number }).collapsibleState, 1);

  const current = new sidebar.LogicalNetworkTreeItem(network, [], [], [], [], 2, true);
  assert.equal(current.description, "This window · 2 routes");
  assert.equal((current as unknown as { collapsibleState: number }).collapsibleState, 2);

  // An empty network has nothing to expand, so it renders without a twistie.
  const idle = new sidebar.LogicalNetworkTreeItem(network, [], [], [], [], 0);
  assert.equal(idle.description, "Idle");
  assert.equal((idle as unknown as { collapsibleState: number }).collapsibleState, 0);

  const failed = new sidebar.LogicalNetworkTreeItem({ ...network, status: "error" }, [], [], [], [], 0, true);
  assert.equal(failed.description, "Error");
});

test("tree refreshes share one render generation and defer platform diagnostics", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("const TREE_REFRESH_DEBOUNCE_MS = 16;"), true);
  assert.equal(source.includes("interface TreeRenderGeneration"), true);
  assert.equal(source.includes("private renderGeneration: TreeRenderGeneration | undefined;"), true);
  assert.equal(source.includes("readonly routeRowsByNetworkId: Map<string, readonly NetworkRouteConnection[]>;"), true);
  assert.equal(source.includes("generation.routeRowsByNetworkId.get(networkId)"), true);
  assert.equal(source.includes("generation.routeRowsByNetworkId.set(networkId, rows)"), true);

  const refreshStart = source.indexOf("refresh(): void {");
  const refreshEnd = source.indexOf("private getRenderGeneration", refreshStart);
  const refreshBody = source.slice(refreshStart, refreshEnd);
  assert.equal(
    refreshBody.indexOf("this.renderGeneration = undefined;") <
      refreshBody.indexOf("if (this.refreshTimer !== undefined)"),
    true,
    "source changes must invalidate cached render inputs even while a repaint is already queued",
  );

  const childrenStart = source.indexOf("getChildren(element?: PortManagerTreeItem)");
  const rootStart = source.indexOf("if (element === undefined)", childrenStart);
  const childrenPreamble = source.slice(childrenStart, rootStart);
  assert.equal(childrenPreamble.includes("getBrowserDnsResolverStatus"), false);

  const daemonCaseStart = source.indexOf('case "system":', childrenStart);
  const daemonCaseBody = source.slice(daemonCaseStart, source.indexOf("dispose(): void", daemonCaseStart));
  assert.equal(daemonCaseBody.includes("this.getBrowserDnsStatus(generation)"), true);
});

test("networks list leaves directly while system categories stay presentation-only groups", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  // Network commands moved to inline buttons and the context menu, so no action rows or wrappers remain.
  assert.equal(source.includes("class NetworkActionGroupTreeItem"), false);
  assert.equal(source.includes('"Connect actions"'), false);
  assert.equal(source.includes('"Manage actions"'), false);
  assert.equal(source.includes('"Port mappings"'), false);
  assert.equal(source.includes('"network.connections"'), false);
  assert.equal(source.includes('"Health"'), true);
  assert.equal(source.includes('"Browser access & DNS"'), true);
  assert.equal(source.includes('"Runtime & terminal discovery"'), true);
  assert.equal(source.includes('"Recent activity"'), true);
  assert.equal(source.includes('"Maintenance"'), true);
  assert.equal(source.includes('"Initialize This Worktree"'), true);
  assert.equal(source.includes('super(label, vscode.TreeItemCollapsibleState.Collapsed);'), true);
  const groupStart = source.indexOf("class SidebarGroupTreeItem");
  const groupEnd = source.indexOf("class TreeSectionItem", groupStart);
  assert.notEqual(groupEnd, -1);
  const groupSource = source.slice(groupStart, groupEnd);
  assert.equal(groupSource.includes('this.contextValue = `sidebarGroup.${kind}`;'), true);
  assert.equal(groupSource.includes("this.command"), false);
  assert.equal(groupSource.includes("handleDrag"), false);
});

test("root rows list networks directly and keep presentation groups out of drag and drop", async () => {
  const sidebar = loadSidebarTreeForFixtureTests();
  const network = {
    id: "network-a",
    name: "Network A",
    status: "running",
    runtimeKind: "proxy",
    createdAt: "2026-07-30T00:00:00.000Z",
  } as LogicalNetwork;
  const networkB = { ...network, id: "network-b", name: "Network B" };
  const provider = new sidebar.PortManagerTreeProvider({
    getSnapshot: () => ({
      networks: [network, networkB],
      attachments: [],
      exposures: [],
      hostAccessBindings: [],
      composeAttachments: [],
      terminalWindows: [],
      terminalCandidates: [],
      containerServiceCandidates: [],
      runtimes: [],
      controlPlane: { role: "owner", currentPid: 7 },
    }) as unknown as NetworkSnapshot,
    getDaemonStatus: () => ({ status: "running", pid: 0, listenerCount: 0, routeCount: 0, updatedAt: "now" }) as never,
    getAgentSnapshot: () => ({ routes: [] }) as unknown as AgentSnapshot,
    getBrowserDnsResolverStatus: () => ({ supported: false, records: [] }) as never,
    onDidChange: () => ({ dispose(): void {} }),
  });
  const roots = provider.getChildren() as Array<{ id?: string; label: string; description: string; contextValue: string; collapsibleState: number; tooltip: { value: string } }>;
  // No window default yet, so Initialize leads; networks exist, so the isolated-worktree
  // shortcut stays in the view toolbar only.
  assert.deepEqual(roots.map((item) => item.label), ["Initialize This Worktree", "Network A", "Network B", "Services", "System"]);
  assert.deepEqual(roots.map((item) => item.contextValue), ["action", "logicalNetwork", "logicalNetwork", "section.containers", "section.daemon"]);
  assert.deepEqual(roots.slice(1).map((item) => item.id), ["network-a", "network-b", "section:containers", "section:daemon"]);
  assert.deepEqual(roots.slice(1, 3).map((item) => [item.description, item.collapsibleState]), [["Idle", 0], ["Idle", 0]]);
  assert.equal(roots.slice(3).every((item) => item.collapsibleState === 1), true);
  assert.equal(roots[4].tooltip.value, "System\n\nRunning");

  const systemGroups = provider.getChildren(roots[4] as never) as Array<{ label: string; collapsibleState: number }>;
  assert.deepEqual(systemGroups.map((item) => item.label), [
    "Health",
    "Browser access & DNS",
    "Runtime & terminal discovery",
    "Recent activity",
    "Maintenance",
  ]);
  assert.equal(systemGroups.every((item) => item.collapsibleState === 1), true);
  const activityRows = provider.getChildren(systemGroups[3] as never) as Array<{ label: string }>;
  assert.deepEqual(activityRows.map((item) => item.label), ["No activity"]);

  const transferred = new Map<string, { value: unknown }>();
  const dragTransfer = {
    set(type: string, item: { value: unknown }): void {
      transferred.set(type, item);
    },
  };
  provider.handleDrag([systemGroups[0] as never], dragTransfer as never, {} as never);
  assert.equal(transferred.size, 0);

  const terminalWindow = {
    id: "terminal-window-a",
    title: "Terminal A",
    source: "vscode",
    rootPid: 123,
    candidatePids: [123],
    candidateCount: 1,
  } as const;
  provider.handleDrag(
    [new sidebar.TerminalWindowTreeItem(terminalWindow)],
    dragTransfer as never,
    {} as never,
  );
  assert.equal(
    transferred.get("application/vnd.newdlops.portmanager.terminal-window")?.value,
    terminalWindow.id,
  );

  await provider.handleDrop(
    systemGroups[0] as never,
    {
      get(): never {
        throw new Error("presentation-only groups must not read a drop payload");
      },
    } as never,
    {} as never,
  );
});

test("network children list ports first, then connections, without duplicate host mappings", () => {
  const sidebar = loadSidebarTreeForFixtureTests();
  const network = {
    id: "network-with-connections",
    name: "Connected network",
    status: "running",
    runtimeKind: "proxy",
    createdAt: "2026-07-30T00:00:00.000Z",
  } as LogicalNetwork;
  const terminalAttachment = {
    id: "terminal-attachment-a",
    networkId: network.id,
    rootPid: 321,
    terminalTitle: "Attached terminal",
    mode: "isolated",
    status: "attached",
    attachedAt: "2026-07-30T01:00:00.000Z",
  } as const;
  const composeAttachment = {
    id: "compose-attachment-a",
    networkId: network.id,
    projectName: "attached-project",
    composeFiles: [],
    ports: [],
    status: "attached",
    attachedAt: "2026-07-30T02:00:00.000Z",
  } as const;
  const exposure = {
    id: "exposure-a",
    networkId: network.id,
    hostAddress: "127.0.0.1",
    hostPort: 8080,
    targetAddress: "127.93.1.2",
    targetPort: 3000,
    protocol: "tcp",
    status: "active",
    createdAt: "2026-07-30T00:30:00.000Z",
  } as const;
  const hostAccess = {
    id: "host-access-a",
    networkId: network.id,
    logicalPort: 6379,
    hostAddress: "127.0.0.1",
    hostPort: 6379,
    protocol: "tcp",
    status: "active",
    createdAt: "2026-07-30T00:40:00.000Z",
  } as const;
  const windowBinding = {
    id: "window-binding",
    networkId: network.id,
    status: "attached",
    injectedTerminalCount: 1,
    attachedAt: "2026-07-30T00:10:00.000Z",
  } as const;
  const provider = new sidebar.PortManagerTreeProvider({
    getSnapshot: () => ({
      networks: [network],
      attachments: [terminalAttachment],
      exposures: [exposure],
      hostAccessBindings: [hostAccess],
      composeAttachments: [composeAttachment],
      vscodeWindowTerminalBinding: windowBinding,
      terminalWindows: [],
      terminalCandidates: [],
      containerServiceCandidates: [],
      runtimes: [],
      controlPlane: { role: "owner", currentPid: 7, ownerActive: true },
      updatedAt: "2026-07-30T02:00:00.000Z",
    }) as unknown as NetworkSnapshot,
    getDaemonStatus: () => ({ status: "running", pid: 0, listenerCount: 0, routeCount: 0, updatedAt: "now" }) as never,
    getAgentSnapshot: () => ({
      routes: [
        { networkId: network.id, logicalPort: 3000, actualPort: 3000, host: "127.93.1.2", status: "running", source: "hooked", processName: "node" },
        { networkId: network.id, logicalPort: 5432, actualPort: 5432, host: "127.93.1.2", status: "stopped", source: "hooked", processName: "worker", routeDirection: "send" },
      ],
      updatedAt: "2026-07-30T00:00:00.000Z",
    }) as unknown as AgentSnapshot,
    getBrowserDnsResolverStatus: () => ({ supported: false, records: [] }) as never,
    onDidChange: () => ({ dispose(): void {} }),
  });
  const roots = provider.getChildren();
  // The window already has a default network, so no onboarding row precedes it.
  const networkItem = roots[0] as unknown as { label: string; description: string; collapsibleState: number };
  assert.equal(networkItem.label, network.name);
  assert.equal(networkItem.description, "This window · 4 routes · 1 terminal");
  assert.equal(networkItem.collapsibleState, 2);

  const children = provider.getChildren(roots[0]) as Array<{
    label: string;
    description: string;
    contextValue: string;
    command?: unknown;
  }>;
  assert.deepEqual(
    children.map((item) => [item.contextValue, item.label, item.description]),
    [
      ["hostExposureActive", "127.0.0.1:8080 → 3000", "host binding"],
      ["networkRouteConnection", "3000 → 127.93.1.2:3000", "node"],
      ["networkRouteConnection", "5432 → 127.93.1.2:5432", "worker · sender · stopped"],
      ["hostAccessBinding", "6379 → 127.0.0.1:6379", "host access"],
      ["vscodeWindowTerminalBinding", "VS Code terminals", "window default"],
      ["terminalAttachment", "Attached terminal", "terminal"],
      ["composeAttachment", "attached-project", "compose · 0 ports"],
    ],
  );
  // Selecting the window default row must not silently detach the window's routing.
  assert.equal(children[4].command, undefined);

  const systemGroups = provider.getChildren(roots[roots.length - 1]);
  const activityRows = provider.getChildren(systemGroups[3]) as Array<{ label: string }>;
  assert.deepEqual(activityRows.map((item) => item.label), [
    "attached-project",
    "Attached terminal",
    "network:6379 host access",
    "127.0.0.1:8080 exposed",
    "VS Code terminal default",
    "Daemon routes updated",
  ]);
});

test("fully expanded tree never repeats an item id", () => {
  // VS Code rejects a duplicate id anywhere in one tree, not just among siblings,
  // so rows rendered in two branches (the window default) need distinct ids.
  const sidebar = loadSidebarTreeForFixtureTests();
  const network = { id: "net", name: "Net", status: "running", runtimeKind: "proxy", createdAt: "now" } as LogicalNetwork;
  const provider = new sidebar.PortManagerTreeProvider({
    getSnapshot: () => ({
      networks: [network],
      vscodeWindowTerminalBinding: { id: "binding", networkId: network.id, status: "attached", injectedTerminalCount: 1, attachedAt: "now" },
      attachments: [{ id: "attachment", networkId: network.id, rootPid: 9, status: "attached", attachedAt: "now" }],
      exposures: [{ id: "exposure", networkId: network.id, hostAddress: "127.0.0.1", hostPort: 8080, targetAddress: "127.9.0.1", targetPort: 3000, protocol: "tcp", status: "active", createdAt: "now" }],
      hostAccessBindings: [],
      composeAttachments: [],
      terminalWindows: [{ id: "window", title: "zsh", source: "vscode", rootPid: 9, candidatePids: [9], candidateCount: 1 }],
      terminalCandidates: [{ pid: 9, name: "zsh", vscodeTerminal: true }],
      containerServiceCandidates: [],
      runtimes: [],
      controlPlane: { role: "owner", currentPid: 7 },
    }) as unknown as NetworkSnapshot,
    getDaemonStatus: () => ({ status: "running", pid: 1, listenerCount: 0, routeCount: 1, updatedAt: "now" }) as never,
    getAgentSnapshot: () => ({
      routes: [{ networkId: network.id, logicalPort: 3000, actualPort: 3000, host: "127.9.0.1", status: "running", source: "hooked" }],
      updatedAt: "now",
    }) as unknown as AgentSnapshot,
    getBrowserDnsResolverStatus: () => ({ supported: false, records: [] }) as never,
    onDidChange: () => ({ dispose(): void {} }),
  });
  const ids: string[] = [];
  const visit = (items: ReturnType<typeof provider.getChildren>): void => {
    for (const item of items) {
      const node = item as unknown as { id?: string; collapsibleState: number };
      if (node.id !== undefined) {
        ids.push(node.id);
      }
      if (node.collapsibleState !== 0) {
        visit(provider.getChildren(item));
      }
    }
  };
  visit(provider.getChildren());

  assert.equal(ids.includes("binding"), true);
  assert.equal(ids.includes("system:binding"), true);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
});

test("sidebar empty summaries and daemon fallback tooltips remain explicit", () => {
  const sidebar = loadSidebarTreeForFixtureTests();
  const snapshot = {
    networks: [], attachments: [], exposures: [], hostAccessBindings: [], composeAttachments: [],
    terminalWindows: [], terminalCandidates: [], containerServiceCandidates: [], runtimes: [],
    controlPlane: { role: "worker", ownerPid: 42, currentPid: 7 },
  } as unknown as NetworkSnapshot;
  const daemon = { status: "running", pid: 0, listenerCount: 0, routeCount: 0, updatedAt: "now" };
  const agentSnapshot = { routes: [] } as unknown as AgentSnapshot;
  const createProvider = (browserDns: unknown) => new sidebar.PortManagerTreeProvider({
    getSnapshot: () => snapshot,
    getDaemonStatus: () => daemon as never,
    getAgentSnapshot: () => agentSnapshot,
    getBrowserDnsResolverStatus: () => browserDns as never,
    onDidChange: () => ({ dispose(): void {} }),
  });
  const provider = createProvider({ supported: false, records: [] });
  const roots = provider.getChildren() as Array<{ label: string; description: string; command?: { command: string } }>;
  // With no networks the root doubles as an empty state: both setup paths lead.
  assert.deepEqual(roots.map((item) => item.label), ["Initialize This Worktree", "Create Isolated Worktree", "Services", "System"]);
  assert.deepEqual(roots.slice(0, 2).map((item) => item.command?.command), [
    "portManager.initializeWorktree",
    "portManager.createIsolatedWorktree",
  ]);
  assert.equal(roots[2].description, "No services");
  assert.equal(roots[3].description, "Running · worker window");

  const systemGroups = provider.getChildren(roots[3] as never) as Array<{ label: string; description: string }>;
  assert.deepEqual(
    systemGroups.map((item) => item.description),
    ["Running", "Unsupported", "No terminals or runtimes", "No activity", "3 actions"],
  );
  const healthRows = provider.getChildren(systemGroups[0] as never) as Array<{ label: string; tooltip: { value: string } }>;
  assert.deepEqual(
    healthRows.map((item) => item.label),
    [
      "Control Owner",
      "Make This Window Owner",
      "This Window PID",
      "Status",
      "Version",
      "PID",
      "Listeners",
      "Routes",
      "Agent Main",
      "Expected Agent",
      "Route Table File",
      "Updated",
    ],
  );
  const status = healthRows.find((item) => item.label === "Status");
  assert.equal(status?.tooltip.value, "Status\n\nrunning");
  const browserRows = provider.getChildren(systemGroups[1] as never) as Array<{ label: string }>;
  assert.deepEqual(browserRows.map((item) => item.label), ["Browser DNS"]);
  const activityRows = provider.getChildren(systemGroups[3] as never) as Array<{ tooltip: { value: string } }>;
  assert.equal(activityRows[0].tooltip.value, "No activity\n\nAttach a terminal or service");
  const runtimeRows = provider.getChildren(systemGroups[2] as never) as Array<{ tooltip: { value: string } }>;
  assert.equal(runtimeRows[0].tooltip.value, "No terminal isolation runtime\n\nLocal proxy cannot attach terminal ports");
  const maintenanceRows = provider.getChildren(systemGroups[4] as never) as Array<{ command: { command: string } }>;
  assert.deepEqual(
    maintenanceRows.map((item) => item.command.command),
    ["portManager.installShellHook", "portManager.fixStaleRouting", "portManager.clearGlobalStorageFiles"],
  );

  const supportedProvider = createProvider({
    supported: true,
    dnsRunning: true,
    dnsPort: 53153,
    records: [],
    installedCount: 0,
    missingCount: 0,
    tlsStaleCount: 0,
    tlsTrustState: "trusted",
    tlsTrustDetail: "Trusted by macOS Keychain.",
  });
  const supportedRoots = supportedProvider.getChildren();
  const supportedSystemGroups = supportedProvider.getChildren(supportedRoots[3]);
  const supportedBrowserRows = supportedProvider.getChildren(supportedSystemGroups[1]) as Array<{
    label: string;
    command?: { command: string };
  }>;
  assert.deepEqual(
    supportedBrowserRows.map((item) => item.label),
    ["Browser DNS", "TLS Trust", "Repair Local DNS", "Install Browser DNS", "Clean Browser DNS"],
  );
  assert.deepEqual(
    supportedBrowserRows.map((item) => item.command?.command),
    [
      undefined,
      undefined,
      "portManager.repairLocalDns",
      "portManager.installBrowserDnsResolvers",
      "portManager.cleanupBrowserDnsResolvers",
    ],
  );
});

test("tree action arguments resolve wrapped logical networks", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");

  assert.equal(source.includes("const wrappedNetwork = getWrappedLogicalNetwork(argument);"), true);
  assert.equal(source.includes("function getWrappedLogicalNetwork(argument: unknown): LogicalNetwork | undefined"), true);
  assert.equal(source.includes('!("network" in argument)'), true);
  assert.equal(commandsSource.includes("const containerService = getContainerServiceCandidateFromCommandArgument(candidate.containerService);"), true);
  assert.equal(commandsSource.includes("const network = getLogicalNetworkFromCommandArgument(candidate.network);"), true);
  assert.equal(commandsSource.includes("function isComposeAttachModeValue(value: unknown): value is ComposeAttachMode"), true);

  // Network context-menu entries receive the row itself; it must unwrap like `{ network }`.
  const sidebar = loadSidebarTreeForFixtureTests();
  const network = { id: "n", name: "N", status: "running", runtimeKind: "proxy", createdAt: "now" } as LogicalNetwork;
  assert.equal(sidebar.getLogicalNetworkFromCommandArgument(new sidebar.LogicalNetworkTreeItem(network, [])), network);
  assert.equal(sidebar.getLogicalNetworkFromCommandArgument({ network }), network);
});

test("compose attachment copy command is wired through package and sidebar", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const source = fs.readFileSync(sourcePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    activationEvents?: string[];
    contributes?: {
      commands?: Array<{ command: string; title: string; icon?: string }>;
      menus?: { "view/item/context"?: Array<{ command: string; when?: string; group?: string }> };
    };
  };
  const command = manifest.contributes?.commands?.find((item) => item.command === "portManager.copyComposeAttachment");
  const menuItems = manifest.contributes?.menus?.["view/item/context"] ?? [];

  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.copyComposeAttachment"), true);
  // `category` already renders the "Port Manager:" prefix in the Command Palette.
  assert.equal(command?.title, "Copy Compose Attachment");
  assert.equal(command?.icon, "$(copy)");
  assert.equal(
    menuItems.some(
      (item) =>
        item.command === "portManager.copyComposeAttachment" &&
        item.when === "view == portManager.processes && viewItem == composeAttachment",
    ),
    true,
  );
  assert.equal(
    menuItems.some(
      (item) =>
        item.command === "portManager.copyComposeAttachment" &&
        item.group === "inline@1" &&
        !item.when?.includes("portManager.isControlPlaneOwner"),
    ),
    true,
  );
  assert.equal(source.includes('contextValue = "composeAttachment"'), true);
  assert.equal(commandsSource.includes('"portManager.copyComposeAttachment"'), true);
  assert.equal(commandsSource.includes("this.dependencies.networkService.copyComposeAttachment"), true);
  assert.equal(networkServiceSource.includes("async copyComposeAttachment(input: ComposeAttachmentCopyInput)"), true);
  assert.equal(networkServiceSource.includes('mode: "copy"'), true);
  assert.equal(networkServiceSource.includes("copyStoppedServices: true"), true);
});

test("compose attachment rows expose original compose folders", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const sharedTypesPath = path.resolve(__dirname, "../../../src/shared/types.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const sharedTypesSource = fs.readFileSync(sharedTypesPath, "utf8");

  assert.equal(sharedTypesSource.includes("readonly workingDirectory?: string;"), true);
  assert.equal(source.includes("formatComposeAttachmentDescription(attachment)"), true);
  assert.equal(source.includes("Original Folder"), true);
  assert.equal(source.includes("Compose Files"), true);
  assert.equal(source.includes("ServiceDetailTreeItem"), true);
  assert.equal(source.includes("ServiceDetailGroupTreeItem"), true);
  assert.equal(source.includes("ComposeAttachmentPortTreeItem"), true);
  assert.equal(source.includes("buildComposeAttachmentDetailRows(element.attachment)"), true);
  assert.equal(source.includes("buildComposeProjectCandidateDetailRows(element.aggregateCandidate)"), true);
  assert.equal(source.includes("buildContainerCandidateDetailRows(element.candidate)"), true);
  assert.equal(source.includes("buildComposeFilesDetailGroup"), true);
  assert.equal(source.includes("vscode.TreeItemCollapsibleState.Collapsed);"), true);
  assert.equal(source.includes("attachment.workingDirectory"), true);
  assert.equal(source.includes("formatContainerServiceCandidateDescription(candidate)"), true);
  assert.equal(source.includes("formatComposeProjectCandidateDescription(this.aggregateCandidate"), true);
  assert.equal(source.includes("composeCandidateWorkingDirectory(candidate)"), true);
  assert.equal(source.includes("candidate.portManagerClone?.composeFiles ?? candidate.composeConfigFiles"), true);
  assert.equal(commandsSource.includes("formatContainerServiceCandidateDescription(item)"), true);
  assert.equal(commandsSource.includes("formatContainerServiceCandidateDetail(item)"), true);
  assert.equal(commandsSource.includes("const contextDetail = formatComposeAttachContextDetail(candidate);"), true);
  assert.equal(commandsSource.includes("joinQuickPickDetails(["), true);
  assert.equal(commandsSource.includes("candidate.portManagerClone?.composeFiles ?? candidate.composeConfigFiles"), true);
  assert.equal(commandsSource.includes("formatComposeFilesDetail(composeCandidateSourceFiles(candidate))"), true);
  assert.equal(commandsSource.includes("resolveComposeWorkingDirectory(candidate.composeWorkingDirectory, composeFiles)"), true);
  assert.equal(networkServiceSource.includes("workingDirectory: mutation.workingDirectory ?? attachment.workingDirectory"), true);
  assert.equal(networkServiceSource.includes("const workingDirectory = normalizeOptionalString(input.cwd);"), true);
});

test("terminal rows expose reveal commands for injected external windows", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes('command: "portManager.revealTerminalWindow"'), true);
  assert.equal(source.includes('title: "Reveal Terminal"'), true);
  assert.equal(source.includes("arguments: [window]"), true);
  assert.equal(source.includes("arguments: [attachment]"), true);
});

test("view title toolbar exposes only primary actions", () => {
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    contributes?: { menus?: { "view/title"?: Array<{ command: string; when?: string; group?: string }> } };
  };
  const viewTitleItems = manifest.contributes?.menus?.["view/title"] ?? [];
  const primaryCommands = viewTitleItems
    .filter((item) => item.group?.startsWith("navigation"))
    .map((item) => item.command);

  assert.deepEqual(primaryCommands, [
    "portManager.createIsolatedWorktree",
    "portManager.refresh",
    "portManager.openOwnerUi",
    "portManager.openSettings",
  ]);
  // Raw network creation lost its Networks section home and lives in the toolbar overflow.
  assert.deepEqual(
    viewTitleItems.filter((item) => !item.group?.startsWith("navigation")).map((item) => item.command),
    ["portManager.createLogicalNetwork"],
  );
  assert.equal(
    viewTitleItems.some(
      (item) =>
        item.command === "portManager.openOwnerUi" && item.when?.includes("!portManager.isControlPlaneOwner"),
    ),
    true,
  );
});

test("network menu exposes open and attach-active terminal shortcuts", () => {
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    contributes?: { menus?: { "view/item/context"?: Array<{ command: string; when?: string; group?: string }> } };
  };
  const networkItems = (manifest.contributes?.menus?.["view/item/context"] ?? []).filter((item) =>
    item.when?.includes("viewItem == logicalNetwork"),
  );

  assert.deepEqual(
    networkItems.filter((item) => item.group?.startsWith("inline")),
    [
      {
        command: "portManager.openNetworkTerminal",
        when: "view == portManager.processes && viewItem == logicalNetwork",
        group: "inline@1",
      },
      {
        command: "portManager.attachActiveTerminalToNetwork",
        when: "view == portManager.processes && viewItem == logicalNetwork",
        group: "inline@2",
      },
    ],
  );
});

test("terminal context menu supports active attach and reveal", () => {
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    contributes?: { menus?: { "view/item/context"?: Array<{ command: string; when?: string }> } };
    activationEvents?: string[];
  };
  const menuItems = manifest.contributes?.menus?.["view/item/context"] ?? [];
  const commands = menuItems.map((item) => item.command);

  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.attachActiveTerminalToNetwork"), true);
  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.revealTerminalWindow"), true);
  assert.equal(commands.includes("portManager.attachActiveTerminalToNetwork"), true);
  assert.equal(commands.includes("portManager.revealTerminalWindow"), true);
  assert.equal(
    menuItems.some((item) => item.command === "portManager.revealTerminalWindow" && item.when?.includes("terminalAttachment")),
    true,
  );
});

test("status bar exposes current routing quick menu", () => {
  const activatePath = path.resolve(__dirname, "../../../src/extension/activate.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const activateSource = fs.readFileSync(activatePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    contributes?: {
      commands?: Array<{ command: string }>;
      menus?: { "view/item/context"?: Array<{ command: string; when?: string }> };
    };
    activationEvents?: string[];
  };
  const menuItems = manifest.contributes?.menus?.["view/item/context"] ?? [];

  assert.equal(activateSource.includes("createStatusBarItem"), true);
  assert.equal(activateSource.includes('"portManager.showStatusMenu"'), true);
  assert.equal(activateSource.includes('"portManager.isControlPlaneOwner"'), true);
  assert.equal(activateSource.includes("vscodeWindowTerminalBinding"), true);
  assert.equal(activateSource.includes("attachedTerminals"), true);
  assert.equal(commandsSource.includes('"$(target) Current Routing"'), true);
  assert.equal(commandsSource.includes('"$(vm) Switch VS Code Terminal Network"'), true);
  assert.equal(commandsSource.includes('"$(debug-disconnect) Detach"'), true);
  assert.equal(commandsSource.includes('"$(refresh) Refresh"'), true);
  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.showStatusMenu"), true);
  assert.equal(
    manifest.contributes?.commands?.some((item) => item.command === "portManager.showStatusMenu"),
    true,
  );
  assert.equal(
    menuItems.some(
      (item) =>
        item.command === "portManager.attachVscodeWindowTerminalsToNetwork" &&
        item.when?.includes("vscodeWindowTerminalBinding"),
    ),
    true,
  );
});

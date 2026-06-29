import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

test("sidebar root stays focused on networks, services, and diagnostics", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const rootStart = source.indexOf("if (element === undefined) {");
  const rootEnd = source.indexOf("if (element instanceof LogicalNetworkTreeItem)", rootStart);
  const rootBody = source.slice(rootStart, rootEnd);

  assert.equal(rootBody.includes('"Current Routing"'), true);
  assert.equal(rootBody.includes('"Logical Networks"'), true);
  assert.equal(rootBody.includes('"Discovered Services"'), true);
  assert.equal(rootBody.includes('"Diagnostics"'), true);
  assert.equal(rootBody.includes('"Terminal Windows"'), false);
  assert.equal(rootBody.includes('"Host Port Exposures"'), false);
  assert.equal(rootBody.includes('"Runtime Adapter"'), false);
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
  assert.equal(source.includes('"Clear Global Storage Files"'), true);
  assert.equal(source.includes("class RoutingTimelineGroupTreeItem"), true);
  assert.equal(source.includes('"Recent Routing Activity"'), true);
  assert.equal(source.includes("buildRoutingTimelineRows(snapshot, agentSnapshot)"), true);
  assert.equal(source.includes('"Control Owner"'), true);
  assert.equal(source.includes("buildControlPlaneTooltip(snapshot.controlPlane)"), true);
  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.fixStaleRouting"), true);
  assert.equal(
    manifest.contributes?.commands?.some((item) => item.command === "portManager.fixStaleRouting"),
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
    menuItems.some((item) => item.command === "portManager.clearGlobalStorageFiles" && item.when?.includes("section.daemon")),
    true,
  );
});

test("non-owner windows show owner status and disable owner actions", () => {
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
    contributes?: {
      menus?: {
        "view/title"?: Array<{ command: string; when?: string }>;
        "view/item/context"?: Array<{ command: string; when?: string }>;
      };
    };
  };
  const viewTitleItems = manifest.contributes?.menus?.["view/title"] ?? [];
  const menuItems = manifest.contributes?.menus?.["view/item/context"] ?? [];
  const ownerOnlyCommands = [
    "portManager.createLogicalNetwork",
    "portManager.attachActiveTerminalToNetwork",
    "portManager.attachContainerToNetwork",
    "portManager.refreshContainerServices",
    "portManager.attachVscodeWindowTerminalsToNetwork",
    "portManager.restartDaemon",
    "portManager.fixStaleRouting",
    "portManager.clearGlobalStorageFiles",
    "portManager.stopProcess",
  ];

  assert.equal(typesSource.includes('export type ControlPlaneRole = "owner" | "worker" | "unowned";'), true);
  assert.equal(typesSource.includes("export interface ControlPlaneStatus"), true);
  assert.equal(typesSource.includes("readonly controlPlane?: ControlPlaneStatus;"), true);
  assert.equal(networkServiceSource.includes("getControlPlaneStatus(): ControlPlaneStatus"), true);
  assert.equal(networkServiceSource.includes("controlPlane: this.getControlPlaneStatus()"), true);
  assert.equal(activateSource.includes('"portManager.isControlPlaneOwner"'), true);
  assert.equal(activateSource.includes('snapshot.controlPlane?.role === "owner"'), true);
  assert.equal(source.includes("buildOwnerActionAvailability(snapshot.controlPlane)"), true);
  assert.equal(source.includes('this.contextValue = availability.enabled ? "action" : "action.disabled";'), true);
  assert.equal(source.includes("availability.enabled ? undefined : new vscode.ThemeColor(\"disabledForeground\")"), true);
  assert.equal(source.includes("if (availability.enabled) {"), true);
  assert.equal(source.includes("formatOwnerOnlyActionReason(controlPlane)"), true);
  assert.equal(commandsSource.includes('label: "$(lock) Owner actions disabled"'), true);
  assert.equal(commandsSource.includes('action: "ownerOnly" as const'), true);

  for (const command of ownerOnlyCommands) {
    const contextItems = menuItems.filter((item) => item.command === command);
    assert.equal(contextItems.length > 0, true, `${command} must have context menu entries`);
    assert.equal(
      contextItems.every((item) => item.when?.includes("portManager.isControlPlaneOwner")),
      true,
      `${command} context menu entries must require owner context`,
    );
  }

  assert.equal(
    viewTitleItems
      .filter((item) => item.command === "portManager.createLogicalNetwork" || item.command === "portManager.refresh")
      .every((item) => item.when?.includes("portManager.isControlPlaneOwner")),
    true,
  );
});

test("sidebar shows current network and route destinations", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");

  assert.equal(source.includes('"Current Routing"'), true);
  assert.equal(source.includes("class NetworkRoutingGroupTreeItem"), true);
  assert.equal(source.includes("class NetworkRouteConnectionTreeItem"), true);
  assert.equal(source.includes("formatCurrentRoutingSummary(snapshot, agentSnapshot)"), true);
  assert.equal(source.includes("buildNetworkRouteConnectionRows(network.id, snapshot, agentSnapshot).length"), true);
  assert.equal(source.includes("Current VS Code Terminal Network"), true);
  assert.equal(networkServiceSource.includes("getAgentSnapshot(): AgentSnapshot"), true);
});

test("network rows show state first and keep actions grouped", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("class NetworkActionGroupTreeItem"), true);
  assert.equal(source.includes('"Quick Actions"'), true);
  assert.equal(source.includes('"Advanced"'), true);
  assert.equal(source.includes('"Attach Active Terminal"'), true);
  assert.equal(source.includes('"Attach Terminal"'), true);
  assert.equal(source.includes('"Use Quick Actions"'), true);
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
  assert.equal(command?.title, "Port Manager: Copy Compose Attachment");
  assert.equal(command?.icon, "$(copy)");
  assert.equal(
    menuItems.some(
      (item) =>
        item.command === "portManager.copyComposeAttachment" &&
        item.when === "view == portManager.processes && viewItem == composeAttachment",
    ),
    true,
  );
  assert.equal(source.includes("networkComposeAttachments.length > 0"), true);
  assert.equal(source.includes('"Copy Compose Attachment"'), true);
  assert.equal(source.includes('"portManager.copyComposeAttachment"'), true);
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
    contributes?: { menus?: { "view/title"?: Array<{ command: string }> } };
  };
  const viewTitleCommands = manifest.contributes?.menus?.["view/title"]?.map((item) => item.command) ?? [];

  assert.deepEqual(viewTitleCommands, [
    "portManager.createLogicalNetwork",
    "portManager.refresh",
    "portManager.openSettings",
  ]);
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

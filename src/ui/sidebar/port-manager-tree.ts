import * as vscode from "vscode";
import type {
  AgentDaemonStatus,
  AgentSnapshot,
  DisposableLike,
  ListeningPort,
  LogicalPortRoute,
  ManagedProcess,
  ProcessStatus,
} from "../../shared/types";

/**
 * Sidebar adapter for the managed process registry.
 *
 * The tree provider intentionally depends on a small source interface instead
 * of the concrete registry so UI rendering can remain independent from core
 * storage details.
 */

export interface ManagedProcessTreeSource {
  /** Returns the latest complete daemon snapshot. */
  getSnapshot(): AgentSnapshot;
  /** Returns the latest registry snapshot in display order. */
  list(): readonly ManagedProcess[];
  /** Notifies the tree when registry contents or process statuses change. */
  onDidChange(listener: () => void): DisposableLike;
}

type TreeSectionKind = "networks" | "terminals" | "exposures" | "runtime";

type PortManagerTreeItem =
  | TreeSectionItem
  | ActionTreeItem
  | PlannedFeatureTreeItem
  | DaemonStatusTreeItem
  | RouteTreeItem
  | ManagedProcessTreeItem
  | ListenerTreeItem
  | EmptyTreeItem;

/**
 * Renders managed processes as VS Code tree items and refreshes on registry
 * events. Command handlers receive ManagedProcessTreeItem instances from
 * context menus and can extract the backing process with `getProcessFromItem`.
 */
export class PortManagerTreeProvider implements vscode.TreeDataProvider<PortManagerTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<PortManagerTreeItem | undefined>();

  /** VS Code subscribes to this event to know when it should ask for new rows. */
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  /**
   * The registry subscription is held so activation disposal can release it
   * together with the tree provider.
   */
  private readonly sourceSubscription: DisposableLike;

  constructor(private readonly source: ManagedProcessTreeSource) {
    this.sourceSubscription = this.source.onDidChange(() => this.refresh());
  }

  /** Triggers a full tree refresh after process state changes or manual refresh. */
  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  /** Returns the already constructed TreeItem object. */
  getTreeItem(element: PortManagerTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Converts the daemon snapshot into grouped tree rows. VS Code tree groups
   * now act as accordions for the logical network model. Legacy daemon,
   * route, managed-process, and listener rows remain implemented below for
   * compatibility, but they are intentionally not surfaced from the root.
   */
  getChildren(element?: PortManagerTreeItem): PortManagerTreeItem[] {
    if (element === undefined) {
      return [
        new TreeSectionItem("networks", "Logical Networks", "network scoped app ports", "vm"),
        new TreeSectionItem("terminals", "Terminal Sessions", "attach process groups", "terminal"),
        new TreeSectionItem("exposures", "Host Port Exposures", "host to network ports", "ports-view-icon"),
        new TreeSectionItem("runtime", "Runtime Adapter", "container, native, or proxy", "circuit-board"),
      ];
    }

    if (!(element instanceof TreeSectionItem)) {
      return [];
    }

    switch (element.kind) {
      case "networks":
        return [
          new PlannedFeatureTreeItem("A app network", "internal 3004/8004, expose 3004", "vm-active"),
          new PlannedFeatureTreeItem("B app network", "internal 3004/8004, expose 3005", "vm-outline"),
        ];
      case "terminals":
        return [
          new PlannedFeatureTreeItem("Discover OS terminals", "VS Code and external shells", "search"),
          new PlannedFeatureTreeItem("Attach selected terminal", "children inherit network context", "debug-console"),
        ];
      case "exposures":
        return [
          new PlannedFeatureTreeItem("localhost:3004", "A network -> 3004", "link-external"),
          new PlannedFeatureTreeItem("localhost:3005", "B network -> 3004", "link-external"),
        ];
      case "runtime":
        return [
          new PlannedFeatureTreeItem("NetworkRuntimeAdapter", "required for same internal ports", "circuit-board"),
          new PlannedFeatureTreeItem("Adapter candidates", "container, OS native, proxy", "extensions"),
        ];
    }
  }

  /** Releases VS Code and registry event resources during deactivation. */
  dispose(): void {
    this.sourceSubscription.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

/** One clickable command row in the Actions accordion. */
class ActionTreeItem extends vscode.TreeItem {
  readonly contextValue = "action";

  constructor(label: string, command: string, icon: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = {
      command,
      title: label,
    };
  }
}

/** Collapsible root row used as a VS Code tree accordion section. */
class TreeSectionItem extends vscode.TreeItem {
  constructor(
    readonly kind: TreeSectionKind,
    label: string,
    description: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `section:${kind}`;
    this.contextValue = `section.${kind}`;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Planned logical-network row shown while the new runtime model is built. */
class PlannedFeatureTreeItem extends vscode.TreeItem {
  readonly contextValue = "plannedNetworkFeature";

  constructor(label: string, description: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Builds multirow sidebar command access so the header toolbar stays compact. */
function buildActionChildren(): PortManagerTreeItem[] {
  return [
    new ActionTreeItem("Start Daemon", "portManager.startDaemon", "server-process"),
    new ActionTreeItem("Stop Daemon", "portManager.stopDaemon", "debug-disconnect"),
    new ActionTreeItem("Daemon Status", "portManager.showDaemonStatus", "pulse"),
    new ActionTreeItem("Start Managed Process", "portManager.startManagedProcess", "run"),
    new ActionTreeItem("Add Existing Process", "portManager.addExistingProcess", "add"),
    new ActionTreeItem("Refresh", "portManager.refresh", "refresh"),
    new ActionTreeItem("Install Shell Hook", "portManager.installShellHook", "plug"),
    new ActionTreeItem("Install External CLI", "portManager.installExternalCli", "terminal"),
    new ActionTreeItem("Stop All Processes", "portManager.stopAllProcesses", "debug-stop"),
    new ActionTreeItem("Open Settings", "portManager.openSettings", "settings-gear"),
  ];
}

/** Static daemon detail row. */
class DaemonStatusTreeItem extends vscode.TreeItem {
  readonly contextValue = "daemonStatus";

  constructor(label: string, description: string, icon: string = "info") {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** One logical routing table row. */
class RouteTreeItem extends vscode.TreeItem {
  readonly contextValue = "route";

  constructor(readonly route: LogicalPortRoute) {
    super(`${route.logicalPort} -> ${route.actualPort}`, vscode.TreeItemCollapsibleState.None);
    this.description = route.processName ?? route.source;
    this.tooltip = buildRouteTooltip(route);
    this.iconPath = new vscode.ThemeIcon("symbol-interface", new vscode.ThemeColor("charts.purple"));
  }
}

/**
 * Tree item that carries the backing ManagedProcess for command handlers.
 * The label favors the process name, while description keeps the port mapping
 * visible for quick scanning.
 */
export class ManagedProcessTreeItem extends vscode.TreeItem {
  constructor(readonly process: ManagedProcess) {
    super(process.name, vscode.TreeItemCollapsibleState.None);

    this.id = process.id;
    this.contextValue = buildContextValue(process);
    this.description = buildDescription(process);
    this.tooltip = buildTooltip(process);
    this.iconPath = new vscode.ThemeIcon(iconForStatus(process.status), colorForStatus(process.status));
  }
}

/** One raw OS listening-port row reported by the daemon. */
class ListenerTreeItem extends vscode.TreeItem {
  readonly contextValue = "listener";

  constructor(readonly listener: ListeningPort) {
    const owner = listener.processName ?? (listener.pid === undefined ? "unknown" : `pid ${listener.pid}`);
    super(`${listener.localAddress}:${listener.port}`, vscode.TreeItemCollapsibleState.None);
    this.description = owner;
    this.tooltip = buildListenerTooltip(listener);
    this.iconPath = new vscode.ThemeIcon(
      listener.source === "managed" ? "plug" : "radio-tower",
      listener.source === "managed" ? new vscode.ThemeColor("testing.iconPassed") : undefined,
    );
  }
}

/** Placeholder row shown when no processes are registered. */
class EmptyTreeItem extends vscode.TreeItem {
  readonly contextValue = "empty";

  constructor(label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon("debug-start");
  }
}

/** Builds child rows for the daemon accordion section. */
function buildDaemonChildren(daemon: AgentDaemonStatus): PortManagerTreeItem[] {
  const children: PortManagerTreeItem[] = [
    new DaemonStatusTreeItem("Status", daemon.status, daemon.status === "running" ? "pass" : "warning"),
    new DaemonStatusTreeItem("PID", daemon.pid > 0 ? String(daemon.pid) : "n/a", "server-process"),
    new DaemonStatusTreeItem("Listeners", String(daemon.listenerCount), "radio-tower"),
    new DaemonStatusTreeItem("Routes", String(daemon.routeCount), "references"),
    new DaemonStatusTreeItem("Route Table File", daemon.routeTablePath ?? "n/a", "json"),
    new DaemonStatusTreeItem("Updated", daemon.updatedAt, "clock"),
  ];

  if (daemon.errorMessage) {
    children.push(new DaemonStatusTreeItem("Warning", daemon.errorMessage, "warning"));
  }

  return children;
}

/** One-line daemon summary for the root section. */
function formatDaemonSummary(daemon: AgentDaemonStatus): string {
  return daemon.pid > 0 ? `${daemon.status} pid ${daemon.pid}` : daemon.status;
}

/** Counts non-detected process rows for the managed process section label. */
function countManagedProcesses(snapshot: AgentSnapshot): number {
  return snapshot.processes.filter((process) => process.source !== "detected").length;
}

/**
 * Command handlers may be called from tree context menus, command palette, or
 * tests. This helper accepts both tree items and raw ManagedProcess objects.
 */
export function getProcessFromCommandArgument(argument: unknown): ManagedProcess | undefined {
  if (argument instanceof ManagedProcessTreeItem) {
    return argument.process;
  }

  if (isManagedProcess(argument)) {
    return argument;
  }

  return undefined;
}

/** Builds compact `requested -> actual` mapping text for the sidebar row. */
function buildDescription(process: ManagedProcess): string {
  if (process.status !== "running") {
    return process.status;
  }

  const routeText =
    process.requestedPort === process.actualPort
      ? String(process.actualPort)
      : `${process.requestedPort} -> ${process.actualPort}`;

  const sourceText = sourceLabel(process);

  return `${routeText} ${sourceText}`;
}

/** Labels process origin without changing the managed-section behavior. */
function sourceLabel(process: ManagedProcess): string {
  switch (process.source) {
    case "detected":
      return "external";
    case "hooked":
      return "hooked";
    case "registered":
      return "registered";
    case "allocated":
      return "allocated";
    case "managed":
    case undefined:
      return process.status;
  }
}

/**
 * Builds a Markdown tooltip with command and lifecycle details. The tooltip is
 * plain enough to work across themes while giving operators useful context.
 */
function buildTooltip(process: ManagedProcess): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(process.name)}**\n\n`);
  tooltip.appendMarkdown(`- PID: \`${process.pid}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${process.status}\`\n`);
  tooltip.appendMarkdown(`- Source: \`${process.source ?? "managed"}\`\n`);
  tooltip.appendMarkdown(`- Requested Port: \`${process.requestedPort}\`\n`);
  tooltip.appendMarkdown(`- Actual Port: \`${process.actualPort}\`\n`);
  tooltip.appendMarkdown(`- URL: \`${process.status === "running" ? process.url ?? "n/a" : "n/a"}\`\n`);
  tooltip.appendMarkdown(`- CWD: \`${escapeMarkdown(process.cwd)}\`\n`);
  tooltip.appendMarkdown(`- Command: \`${escapeMarkdown(process.command)}\`\n`);

  if (process.errorMessage) {
    tooltip.appendMarkdown(`\nError: \`${escapeMarkdown(process.errorMessage)}\``);
  }

  return tooltip;
}

/** Builds tooltip details for one logical route row. */
function buildRouteTooltip(route: LogicalPortRoute): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**Logical Route**\n\n`);
  tooltip.appendMarkdown(`- Logical Port: \`${route.logicalPort}\`\n`);
  tooltip.appendMarkdown(`- Actual Port: \`${route.actualPort}\`\n`);
  tooltip.appendMarkdown(`- Host: \`${escapeMarkdown(route.host)}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${route.status}\`\n`);
  tooltip.appendMarkdown(`- Source: \`${route.source}\`\n`);

  if (route.processName) {
    tooltip.appendMarkdown(`- Process: \`${escapeMarkdown(route.processName)}\`\n`);
  }

  if (route.processId) {
    tooltip.appendMarkdown(`- Process ID: \`${escapeMarkdown(route.processId)}\`\n`);
  }

  return tooltip;
}

/** Builds tooltip details for one raw OS listener row. */
function buildListenerTooltip(listener: ListeningPort): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**OS Listener**\n\n`);
  tooltip.appendMarkdown(`- Address: \`${escapeMarkdown(listener.localAddress)}\`\n`);
  tooltip.appendMarkdown(`- Port: \`${listener.port}\`\n`);
  tooltip.appendMarkdown(`- Protocol: \`${listener.protocol}\`\n`);
  tooltip.appendMarkdown(`- Source: \`${listener.source}\`\n`);
  tooltip.appendMarkdown(`- PID: \`${listener.pid ?? "n/a"}\`\n`);
  tooltip.appendMarkdown(`- Process: \`${escapeMarkdown(listener.processName ?? "n/a")}\`\n`);
  tooltip.appendMarkdown(`- Command: \`${escapeMarkdown(listener.command ?? "n/a")}\`\n`);
  tooltip.appendMarkdown(`- Updated: \`${listener.updatedAt}\`\n`);

  return tooltip;
}

/** Assigns context menu groups by source and lifecycle state. */
function buildContextValue(process: ManagedProcess): string {
  if (process.source === "detected") {
    return "detectedProcess";
  }

  switch (process.status) {
    case "running":
      return "managedProcessRunning";
    case "starting":
      return "managedProcessStarting";
    case "stopped":
      return "managedProcessStopped";
    case "error":
      return "managedProcessError";
  }
}

/** Maps lifecycle status to a familiar VS Code product icon. */
function iconForStatus(status: ProcessStatus): string {
  switch (status) {
    case "starting":
      return "sync~spin";
    case "running":
      return "debug-start";
    case "stopped":
      return "debug-stop";
    case "error":
      return "error";
  }
}

/** Uses VS Code theme colors so the tree remains native in light and dark UI. */
function colorForStatus(status: ProcessStatus): vscode.ThemeColor | undefined {
  switch (status) {
    case "running":
      return new vscode.ThemeColor("testing.iconPassed");
    case "error":
      return new vscode.ThemeColor("testing.iconFailed");
    case "stopped":
      return new vscode.ThemeColor("disabledForeground");
    case "starting":
      return new vscode.ThemeColor("charts.yellow");
  }
}

/** Escapes markdown metacharacters used in process names and command strings. */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!])/g, "\\$1");
}

/** Structural guard for command arguments coming from non-tree entry points. */
function isManagedProcess(value: unknown): value is ManagedProcess {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ManagedProcess>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.pid === "number" &&
    typeof candidate.name === "string" &&
    typeof candidate.requestedPort === "number" &&
    typeof candidate.actualPort === "number"
  );
}

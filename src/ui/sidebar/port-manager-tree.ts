import * as vscode from "vscode";
import { formatSidebarCounts, formatSidebarSummary, summarizeSidebarIssues } from "./sidebar-presentation";
import type {
  AgentDaemonStatus,
  AgentSnapshot,
  BrowserDnsResolverStatus,
  ComposeAttachment,
  ComposePublishedPort,
  ControlPlaneStatus,
  ContainerServiceCandidate,
  DisposableLike,
  HostAccessBinding,
  HostPortExposure,
  LogicalNetwork,
  ListeningPort,
  LogicalPortRoute,
  ManagedProcess,
  NetworkRuntimeDescriptor,
  NetworkSnapshot,
  ProcessStatus,
  TerminalAttachment,
  TerminalCandidate,
  TerminalWindow,
  VscodeWindowTerminalBinding,
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

export interface PortManagerNetworkTreeSource {
  /** Returns the latest logical-network snapshot. */
  getSnapshot(): NetworkSnapshot;
  /** Returns daemon lifecycle and version status for management rows. */
  getDaemonStatus(): AgentDaemonStatus;
  /** Returns daemon routes and process rows used by routing status displays. */
  getAgentSnapshot(): AgentSnapshot;
  /** Returns browser DNS alias resolver status for diagnostics rows. */
  getBrowserDnsResolverStatus(): BrowserDnsResolverStatus;
  /** Notifies the tree when networks, terminals, or exposures change. */
  onDidChange(listener: () => void): DisposableLike;
}

type TreeSectionKind = "services" | "system";
type SidebarGroupKind =
  | "system.health"
  | "system.browserDns"
  | "system.runtime"
  | "system.activity"
  | "system.maintenance";
const TERMINAL_WINDOW_MIME = "application/vnd.newdlops.portmanager.terminal-window";
const TREE_REFRESH_DEBOUNCE_MS = 16;

interface NetworkRouteConnection {
  /** Stable row id across refreshes so VS Code can preserve expansion and focus. */
  readonly id: string;
  /** User-facing endpoint mapping such as "3000 -> 127.0.0.1:52281". */
  readonly label: string;
  /** Compact route owner/status text shown in the tree description column. */
  readonly description: string;
  /** Logical port used for stable sorting before fallback labels. */
  readonly logicalPort: number;
  /** Route source family used for icon selection and diagnostics. */
  readonly kind: "daemon" | "compose" | "hostAccess" | "hostExposure";
  /**
   * Backing host binding/exposure id for host-mapping rows. Network children
   * swap those rows for the actionable binding leaf so its menus stay attached.
   */
  readonly sourceId?: string;
  /** Tooltip explains why this row exists and what owns it. */
  readonly tooltip: vscode.MarkdownString;
  /** VS Code product icon id. */
  readonly icon: string;
  /** Optional theme color for warning/error states. */
  readonly color?: vscode.ThemeColor;
}

interface RoutingTimelineEntry {
  /** Stable row id so recent activity rows do not flicker across refreshes. */
  readonly id: string;
  /** User-facing event label. */
  readonly label: string;
  /** Compact event context shown in the description column. */
  readonly description: string;
  /** ISO timestamp for sorting and tooltip detail. */
  readonly updatedAt: string;
  /** VS Code product icon id. */
  readonly icon: string;
  /** Optional warning/error color. */
  readonly color?: vscode.ThemeColor;
  /** Tooltip with the owning network and event timestamp. */
  readonly tooltip: vscode.MarkdownString;
}

interface ActionAvailability {
  /** Owner-scoped commands stay actionable because their command wrapper acquires ownership. */
  readonly enabled: boolean;
}

/**
 * Stable inputs shared by every getChildren call in one VS Code repaint.
 *
 * VS Code asks for the root and each expanded section separately. Capturing the
 * source once prevents those calls from rebuilding snapshots and route rows for
 * the same state generation. A source event invalidates the generation before
 * the repaint is queued, so no stale rows survive the debounce window.
 */
interface TreeRenderGeneration {
  readonly snapshot: NetworkSnapshot;
  readonly agentSnapshot: AgentSnapshot;
  readonly daemon: AgentDaemonStatus;
  readonly ownerAction: ActionAvailability;
  readonly routeRowsByNetworkId: Map<string, readonly NetworkRouteConnection[]>;
  /** Expensive platform diagnostics stay lazy until Diagnostics is expanded. */
  browserDns?: BrowserDnsResolverStatus;
}

type NetworkRouteRowsResolver = (networkId: string) => readonly NetworkRouteConnection[];

type PortManagerTreeItem =
  | TreeSectionItem
  | NetworkRoutingGroupTreeItem
  | NetworkRouteConnectionTreeItem
  | RoutingTimelineTreeItem
  | SidebarGroupTreeItem
  | ActionTreeItem
  | PlannedFeatureTreeItem
  | LogicalNetworkTreeItem
  | TerminalWindowTreeItem
  | TerminalCandidateTreeItem
  | ComposeProjectCandidateTreeItem
  | ContainerServiceCandidateTreeItem
  | ContainerPublishedPortTreeItem
  | ServiceDetailTreeItem
  | ServiceDetailGroupTreeItem
  | VscodeWindowTerminalBindingTreeItem
  | TerminalAttachmentTreeItem
  | ComposeAttachmentTreeItem
  | ComposeAttachmentPortTreeItem
  | HostPortExposureTreeItem
  | HostAccessBindingTreeItem
  | RuntimeAdapterTreeItem
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
export class PortManagerTreeProvider
  implements vscode.TreeDataProvider<PortManagerTreeItem>, vscode.TreeDragAndDropController<PortManagerTreeItem>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<PortManagerTreeItem | undefined>();

  /** VS Code subscribes to this event to know when it should ask for new rows. */
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  /** MIME types accepted from sidebar drag gestures. */
  readonly dragMimeTypes = [TERMINAL_WINDOW_MIME];

  /** MIME types accepted when dropping onto logical network rows. */
  readonly dropMimeTypes = [TERMINAL_WINDOW_MIME];

  /**
   * The registry subscription is held so activation disposal can release it
   * together with the tree provider.
   */
  private readonly sourceSubscription: DisposableLike;

  /** Timer used to collapse rapid network/process updates into one tree repaint. */
  private refreshTimer: NodeJS.Timeout | undefined;

  /** Snapshot/index cache shared by every expanded branch in the current repaint. */
  private renderGeneration: TreeRenderGeneration | undefined;

  /**
   * Tree view whose activity-bar badge mirrors the issue count. Bound once by
   * activation; stays undefined in fixture tests that drive rows directly.
   */
  private view: Pick<vscode.TreeView<PortManagerTreeItem>, "badge"> | undefined;

  /** Last badge text written, so unchanged repaints skip the VS Code UI bridge. */
  private renderedBadgeKey: string | undefined;

  constructor(private readonly source: PortManagerNetworkTreeSource) {
    this.sourceSubscription = this.source.onDidChange(() => this.refresh());
  }

  /**
   * Connects the created tree view so problems stay visible on the activity
   * bar icon even while the sidebar is collapsed or hidden.
   */
  bindView(view: Pick<vscode.TreeView<PortManagerTreeItem>, "badge">): void {
    this.view = view;
    this.updateViewBadge();
  }

  /** Triggers a full tree refresh after process state changes or manual refresh. */
  refresh(): void {
    // Invalidate immediately even when a repaint timer already exists. VS Code
    // may ask for children before that timer fires, and those reads must observe
    // the newest source state rather than a cache from the previous generation.
    this.renderGeneration = undefined;
    if (this.refreshTimer !== undefined) {
      return;
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.onDidChangeTreeDataEmitter.fire(undefined);
      this.updateViewBadge();
    }, TREE_REFRESH_DEBOUNCE_MS);
    this.refreshTimer.unref();
  }

  /**
   * Recomputes the issue badge from the same render generation the rows use,
   * so a visible sidebar pays for the snapshot once per repaint.
   */
  private updateViewBadge(): void {
    if (this.view === undefined) {
      return;
    }

    const { snapshot, agentSnapshot, daemon } = this.getRenderGeneration();
    const issues = summarizeSidebarIssues(snapshot, agentSnapshot, daemon);
    const badgeKey = issues.count === 0 ? "" : `${issues.count}\n${issues.tooltip}`;
    if (badgeKey === this.renderedBadgeKey) {
      return;
    }

    this.renderedBadgeKey = badgeKey;
    this.view.badge = issues.count === 0 ? undefined : { value: issues.count, tooltip: issues.tooltip };
  }

  /** Captures all cheap render inputs once for the current tree generation. */
  private getRenderGeneration(): TreeRenderGeneration {
    if (this.renderGeneration !== undefined) {
      return this.renderGeneration;
    }

    const snapshot = this.source.getSnapshot();
    this.renderGeneration = {
      snapshot,
      agentSnapshot: this.source.getAgentSnapshot(),
      daemon: this.source.getDaemonStatus(),
      ownerAction: buildOwnerActionAvailability(snapshot.controlPlane),
      routeRowsByNetworkId: new Map(),
    };
    return this.renderGeneration;
  }

  /** Builds normalized route rows at most once per network and render generation. */
  private getNetworkRouteRows(
    generation: TreeRenderGeneration,
    networkId: string,
  ): readonly NetworkRouteConnection[] {
    const cached = generation.routeRowsByNetworkId.get(networkId);
    if (cached !== undefined) {
      return cached;
    }

    const rows = buildNetworkRouteConnectionRows(networkId, generation.snapshot, generation.agentSnapshot);
    generation.routeRowsByNetworkId.set(networkId, rows);
    return rows;
  }

  /** Reads synchronous platform diagnostics only when their collapsed section opens. */
  private getBrowserDnsStatus(generation: TreeRenderGeneration): BrowserDnsResolverStatus {
    generation.browserDns ??= this.source.getBrowserDnsResolverStatus();
    return generation.browserDns;
  }

  /** Returns the already constructed TreeItem object. */
  getTreeItem(element: PortManagerTreeItem): vscode.TreeItem {
    return element;
  }

  /** Stores one dragged terminal window id in the VS Code data-transfer payload. */
  handleDrag(
    source: readonly PortManagerTreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const terminalItem = source.find((item): item is TerminalWindowTreeItem => item instanceof TerminalWindowTreeItem);

    if (terminalItem === undefined) {
      return;
    }

    dataTransfer.set(TERMINAL_WINDOW_MIME, new vscode.DataTransferItem(terminalItem.window.id));
  }

  /** Attaches a dragged terminal window to the logical network it is dropped on. */
  async handleDrop(
    target: PortManagerTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    if (!(target instanceof LogicalNetworkTreeItem)) {
      return;
    }

    const controlPlane = this.source.getSnapshot().controlPlane;
    if (!isControlPlaneOwner(controlPlane)) {
      void vscode.window.showWarningMessage(formatOwnerOnlyActionReason(controlPlane));
      return;
    }

    const transferItem = dataTransfer.get(TERMINAL_WINDOW_MIME);
    const terminalWindowId = typeof transferItem?.value === "string" ? transferItem.value : undefined;

    if (terminalWindowId === undefined) {
      return;
    }

    const terminalWindow = this.source
      .getSnapshot()
      .terminalWindows.find((candidate) => candidate.id === terminalWindowId);

    if (terminalWindow === undefined) {
      void vscode.window.showWarningMessage("The dragged terminal window is no longer available.");
      return;
    }

    await vscode.commands.executeCommand("portManager.attachTerminalToNetwork", {
      terminalWindow,
      network: target.network,
    });
  }

  /**
   * Converts the daemon snapshot into tree rows. Logical networks sit directly
   * at the root so their state scans without opening a section, and each one
   * expands straight into its routed ports and connections. Network commands
   * live in inline buttons and the network context menu rather than action
   * rows. Services and System stay collapsed below the networks. Legacy daemon,
   * route, managed-process, and listener rows remain implemented below for
   * compatibility, but they are intentionally not surfaced from the root.
   */
  getChildren(element?: PortManagerTreeItem): PortManagerTreeItem[] {
    const generation = this.getRenderGeneration();
    const { snapshot, agentSnapshot, daemon, ownerAction } = generation;
    const getRouteRows: NetworkRouteRowsResolver = (networkId) =>
      this.getNetworkRouteRows(generation, networkId);

    if (element === undefined) {
      return [
        ...buildOnboardingActionItems(snapshot, ownerAction),
        ...snapshot.networks.map((network) =>
          new LogicalNetworkTreeItem(
            network,
            snapshot.attachments,
            snapshot.exposures,
            snapshot.hostAccessBindings,
            snapshot.composeAttachments,
            getRouteRows(network.id).length,
            snapshot.vscodeWindowTerminalBinding?.networkId === network.id,
          ),
        ),
        ...buildStaleRouteScopeItems(snapshot, agentSnapshot),
        new TreeSectionItem(
          "services",
          "Services",
          formatContainerSectionDescription(snapshot.containerServiceCandidates),
          "server-environment",
        ),
        new TreeSectionItem(
          "system",
          "System",
          formatDiagnosticsSummary(daemon, snapshot),
          daemon.restartRequired || daemon.status === "error" ? "warning" : "pulse",
        ),
      ];
    }

    if (element instanceof LogicalNetworkTreeItem) {
      return buildNetworkChildItems(element.network, snapshot, getRouteRows(element.network.id));
    }

    if (element instanceof NetworkRoutingGroupTreeItem) {
      return element.routeRows.length > 0
        ? element.routeRows.map((route) => new NetworkRouteConnectionTreeItem(route))
        : [new EmptyTreeItem("No active routes", "Start or attach a service")];
    }

    if (element instanceof SidebarGroupTreeItem) {
      return [...element.children];
    }

    if (element instanceof TerminalWindowTreeItem) {
      const candidateSet = new Set(element.window.candidatePids);
      return snapshot.terminalCandidates
        .filter((candidate) => candidateSet.has(candidate.pid))
        .map((candidate) => new TerminalCandidateTreeItem(candidate));
    }

    if (element instanceof ComposeProjectCandidateTreeItem) {
      return [
        ...buildComposeProjectCandidateDetailRows(element.aggregateCandidate),
        ...element.candidates.map((candidate) => new ContainerServiceCandidateTreeItem(candidate, ownerAction)),
      ];
    }

    if (element instanceof ContainerServiceCandidateTreeItem) {
      return [
        ...buildContainerCandidateDetailRows(element.candidate),
        ...element.candidate.ports.map((port) => new ContainerPublishedPortTreeItem(element.candidate, port)),
      ];
    }

    if (element instanceof ComposeAttachmentTreeItem) {
      return [
        ...buildComposeAttachmentDetailRows(element.attachment),
        ...element.attachment.ports.map((port) => new ComposeAttachmentPortTreeItem(element.attachment, port)),
      ];
    }

    if (element instanceof ServiceDetailGroupTreeItem) {
      return [...element.children];
    }

    if (!(element instanceof TreeSectionItem)) {
      return [];
    }

    switch (element.kind) {
      case "services":
        return snapshot.containerServiceCandidates.length > 0
          ? buildContainerServiceTreeItems(snapshot.containerServiceCandidates, ownerAction)
          : [new EmptyTreeItem("No published services", "Start compose services")];
      case "system": {
        const browserDns = this.getBrowserDnsStatus(generation);
        return buildSystemGroupItems(daemon, snapshot, agentSnapshot, browserDns, ownerAction);
      }
    }
  }

  /** Releases VS Code and registry event resources during deactivation. */
  dispose(): void {
    this.sourceSubscription.dispose();
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.renderGeneration = undefined;
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

/** One clickable command row: root onboarding shortcuts and System health, DNS, and maintenance actions. */
class ActionTreeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(
    label: string,
    command: string,
    icon: string,
    description?: string,
    argument?: unknown,
    availability: ActionAvailability = { enabled: true },
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = availability.enabled ? "action" : "action.disabled";
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);

    this.command = {
      command,
      title: label,
      arguments: argument === undefined ? [] : [argument],
    };
    this.tooltip = new vscode.MarkdownString(description === undefined ? label : `${label}\n\n${description}`);
  }
}

/**
 * Collapsible route group for a route scope that has no network row, such as
 * routes left behind by a removed network. Known networks list routes inline.
 */
class NetworkRoutingGroupTreeItem extends vscode.TreeItem {
  readonly contextValue = "networkRoutingGroup";

  constructor(
    readonly network: Pick<LogicalNetwork, "id" | "name">,
    label: string,
    description: string,
    readonly routeRows: readonly NetworkRouteConnection[],
    idPrefix: string,
    icon: string = "references",
    color?: vscode.ThemeColor,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `${idPrefix}:routes:${network.id}`;
    this.description = description;
    this.tooltip = buildNetworkRoutingGroupTooltip(network, description, routeRows);
    this.iconPath = new vscode.ThemeIcon(icon, color);
  }
}

/** One visible logical route endpoint mapping. */
class NetworkRouteConnectionTreeItem extends vscode.TreeItem {
  readonly contextValue = "networkRouteConnection";

  constructor(readonly route: NetworkRouteConnection) {
    super(route.label, vscode.TreeItemCollapsibleState.None);
    this.id = route.id;
    this.description = route.description;
    this.tooltip = route.tooltip;
    this.iconPath = new vscode.ThemeIcon(route.icon, route.color);
  }
}

/** One recent network attach, binding, compose, or daemon route refresh row. */
class RoutingTimelineTreeItem extends vscode.TreeItem {
  readonly contextValue = "routingTimeline";

  constructor(readonly row: RoutingTimelineEntry) {
    super(row.label, vscode.TreeItemCollapsibleState.None);
    this.id = row.id;
    this.description = row.description;
    this.tooltip = row.tooltip;
    this.iconPath = new vscode.ThemeIcon(row.icon, row.color);
  }
}

/**
 * Inert category wrapper that keeps the dense System branch scannable.
 * Its children are prebuilt leaf items so commands, context values, and drag
 * identity stay exactly with their original leaf implementations.
 */
class SidebarGroupTreeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(
    readonly kind: SidebarGroupKind,
    label: string,
    description: string,
    icon: string,
    readonly children: readonly PortManagerTreeItem[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `sidebar-group:${kind}`;
    this.contextValue = `sidebarGroup.${kind}`;
    this.description = description;
    this.tooltip = new vscode.MarkdownString(`${label}\n\n${description}`);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Collapsed root section listed below the networks. */
class TreeSectionItem extends vscode.TreeItem {
  constructor(
    readonly kind: TreeSectionKind,
    label: string,
    description: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    // Labels/kinds evolved for scanability, but menu `when` clauses and saved
    // expansion state still key off these long-lived section identities.
    const legacyIdentity: Record<TreeSectionKind, "containers" | "daemon"> = {
      services: "containers",
      system: "daemon",
    };
    this.id = `section:${legacyIdentity[kind]}`;
    this.contextValue = `section.${legacyIdentity[kind]}`;
    this.description = description;
    this.tooltip = new vscode.MarkdownString(`${label}\n\n${description}`);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Planned logical-network row shown while the new runtime model is built. */
class PlannedFeatureTreeItem extends vscode.TreeItem {
  readonly contextValue = "plannedNetworkFeature";

  constructor(label: string, description: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = new vscode.MarkdownString(`${label}\n\n${description}`);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/**
 * Root Logical Network row backed by real service state. The description leads
 * with a text state so it never depends on the icon color, and the row only
 * shows an expander when routes or connections exist to list beneath it.
 */
export class LogicalNetworkTreeItem extends vscode.TreeItem {
  readonly contextValue = "logicalNetwork";

  constructor(
    readonly network: LogicalNetwork,
    attachments: readonly TerminalAttachment[],
    exposures: readonly HostPortExposure[] = [],
    hostAccessBindings: readonly HostAccessBinding[] = [],
    composeAttachments: readonly ComposeAttachment[] = [],
    routeCount = 0,
    isCurrentWindowNetwork = false,
  ) {
    const attachmentCount = attachments.filter((attachment) => attachment.networkId === network.id).length;
    const exposureCount = exposures.filter((exposure) => exposure.networkId === network.id).length;
    const hostAccessCount = hostAccessBindings.filter((binding) => binding.networkId === network.id).length;
    const composeCount = composeAttachments.filter((attachment) => attachment.networkId === network.id).length;
    // Mirrors buildNetworkChildItems: the window binding row counts as a child too.
    const hasChildren =
      isCurrentWindowNetwork || routeCount + attachmentCount + exposureCount + hostAccessCount + composeCount > 0;
    super(
      network.name,
      !hasChildren
        ? vscode.TreeItemCollapsibleState.None
        : isCurrentWindowNetwork
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = network.id;
    this.description = buildNetworkDescription(
      network,
      attachmentCount,
      exposureCount,
      hostAccessCount,
      composeCount,
      routeCount,
      isCurrentWindowNetwork,
    );
    this.tooltip = buildNetworkTooltip(
      network,
      attachmentCount,
      exposureCount,
      hostAccessCount,
      composeCount,
      routeCount,
      isCurrentWindowNetwork,
    );
    this.iconPath = buildNetworkIcon(network, hasChildren);
  }
}

/** Compose published service ports that currently shadow host fallback ports. */
export class ComposeAttachmentTreeItem extends vscode.TreeItem {
  readonly contextValue = "composeAttachment";

  constructor(readonly attachment: ComposeAttachment) {
    super(attachment.mutation?.attachedProjectName ?? attachment.projectName, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = attachment.id;
    this.description = formatComposeAttachmentDescription(attachment);
    this.tooltip = buildComposeAttachmentTooltip(attachment);
    this.iconPath = new vscode.ThemeIcon(
      attachment.status === "attached" ? "database" : "warning",
      attachment.status === "error" ? new vscode.ThemeColor("testing.iconFailed") : undefined,
    );
  }
}

/** Terminal candidate row discovered from VS Code or the OS process table. */
export class TerminalWindowTreeItem extends vscode.TreeItem {
  readonly contextValue = "terminalWindow";

  constructor(readonly window: TerminalWindow) {
    super(window.title, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = window.id;
    this.description = `${window.candidateCount} processes, root ${window.rootPid}`;
    this.tooltip = buildTerminalWindowTooltip(window);
    this.iconPath = new vscode.ThemeIcon(window.source === "vscode" ? "terminal" : "window");
    this.command = {
      command: "portManager.revealTerminalWindow",
      title: "Reveal Terminal",
      arguments: [window],
    };
  }
}

/** Process-level detail row nested under a terminal window. */
export class TerminalCandidateTreeItem extends vscode.TreeItem {
  readonly contextValue = "terminalCandidate";

  constructor(readonly candidate: TerminalCandidate) {
    super(candidate.name, vscode.TreeItemCollapsibleState.None);
    this.id = `terminal:${candidate.pid}`;
    this.description = `pid ${candidate.pid}${candidate.vscodeTerminal ? ", VS Code" : ""}`;
    this.tooltip = buildTerminalTooltip(candidate);
    this.iconPath = new vscode.ThemeIcon(candidate.vscodeTerminal ? "terminal" : "debug-console");
  }
}

/** Compose project row that owns one or more service/container candidates. */
export class ComposeProjectCandidateTreeItem extends vscode.TreeItem {
  readonly contextValue: string;
  readonly aggregateCandidate: ContainerServiceCandidate;

  constructor(
    readonly projectName: string,
    readonly runtime: ContainerServiceCandidate["runtime"],
    readonly candidates: readonly ContainerServiceCandidate[],
    availability: ActionAvailability = { enabled: true },
  ) {
    const ports = candidates.flatMap((candidate) => [...candidate.ports]);

    super(projectName, vscode.TreeItemCollapsibleState.Collapsed);
    this.aggregateCandidate = buildAggregateComposeProjectCandidate(projectName, runtime, candidates);
    this.id = this.aggregateCandidate.id;
    this.contextValue = availability.enabled ? "composeProjectCandidate" : "composeProjectCandidate.disabled";
    this.description = formatComposeProjectCandidateDescription(this.aggregateCandidate, candidates.length, ports.length);
    this.tooltip = buildComposeProjectCandidateTooltip(projectName, runtime, candidates);
    this.iconPath = new vscode.ThemeIcon("server-environment");
    this.command = {
      command: "portManager.attachContainerToNetwork",
      title: "Attach Compose Project to Network",
      arguments: [{ containerService: this.aggregateCandidate }],
    };
  }
}

/** Docker/Podman container or compose service with host-published ports. */
export class ContainerServiceCandidateTreeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(readonly candidate: ContainerServiceCandidate, availability: ActionAvailability = { enabled: true }) {
    super(formatContainerServiceTreeLabel(candidate), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = candidate.id;
    this.contextValue = availability.enabled ? "containerServiceCandidate" : "containerServiceCandidate.disabled";
    this.description = formatContainerServiceCandidateDescription(candidate);
    this.tooltip = buildContainerServiceTooltip(candidate);
    this.iconPath = new vscode.ThemeIcon(candidate.composeProject ? "server-environment" : "server-process");
    this.command = {
      command: "portManager.attachContainerToNetwork",
      title: "Attach Service to Network",
      arguments: [{ containerService: candidate }],
    };
  }
}

/** One host-published container port under a discovered container candidate. */
export class ContainerPublishedPortTreeItem extends vscode.TreeItem {
  readonly contextValue = "containerPublishedPort";

  constructor(
    readonly candidate: ContainerServiceCandidate,
    readonly port: ContainerServiceCandidate["ports"][number],
  ) {
    super(formatComposePort(port), vscode.TreeItemCollapsibleState.None);
    this.id = `${candidate.id}:${port.actualHostAddress}:${port.actualHostPort}:${port.containerPort}`;
    this.description =
      port.actualHostPort === port.logicalPort
        ? `${port.protocolName ?? port.protocol}`
        : `via ${port.actualHostAddress}:${port.actualHostPort}`;
    this.tooltip = buildContainerPortTooltip(candidate, port);
    this.iconPath = new vscode.ThemeIcon("plug");
  }
}

/** Attached compose route endpoint nested under the owning compose attachment. */
export class ComposeAttachmentPortTreeItem extends vscode.TreeItem {
  readonly contextValue = "composeAttachmentPort";

  constructor(
    readonly attachment: ComposeAttachment,
    readonly port: ComposePublishedPort,
  ) {
    super(formatComposePort(port), vscode.TreeItemCollapsibleState.None);
    this.id = `${attachment.id}:port:${port.serviceName}:${port.logicalPort}:${port.containerPort}`;
    this.description =
      port.actualHostPort === port.logicalPort
        ? `${port.serviceName}`
        : `${port.serviceName} via ${port.actualHostAddress}:${port.actualHostPort}`;
    this.tooltip = buildComposeRouteTooltip(attachment, port);
    this.iconPath = new vscode.ThemeIcon("plug");
  }
}

/** Read-only detail row used to keep long service metadata out of parent descriptions. */
export class ServiceDetailTreeItem extends vscode.TreeItem {
  readonly contextValue = "serviceDetail";

  constructor(
    readonly detailId: string,
    readonly detailLabel: string,
    readonly detailValue: string,
    icon = "symbol-property",
  ) {
    super(`${detailLabel}: ${detailValue}`, vscode.TreeItemCollapsibleState.None);
    this.id = detailId;
    this.tooltip = buildServiceDetailTooltip(detailLabel, detailValue);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Collapsible group for repeated detail rows such as compose files or cloned containers. */
export class ServiceDetailGroupTreeItem extends vscode.TreeItem {
  readonly contextValue = "serviceDetailGroup";

  constructor(
    readonly detailId: string,
    label: string,
    readonly children: readonly ServiceDetailTreeItem[],
    icon = "list-tree",
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = detailId;
    this.description = `${children.length} ${children.length === 1 ? "item" : "items"}`;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Terminal attachment row retained for future nested views and commands. */
export class TerminalAttachmentTreeItem extends vscode.TreeItem {
  readonly contextValue = "terminalAttachment";

  constructor(readonly attachment: TerminalAttachment) {
    super(attachment.terminalTitle ?? `PID ${attachment.rootPid}`, vscode.TreeItemCollapsibleState.None);
    this.id = attachment.id;
    this.description = formatTerminalAttachmentDescription(attachment);
    this.tooltip = buildTerminalAttachmentTooltip(attachment);
    this.iconPath = new vscode.ThemeIcon(
      attachment.mode === "logical" ? "warning" : attachment.status === "error" ? "error" : "terminal",
      attachment.mode === "logical"
        ? new vscode.ThemeColor("charts.yellow")
        : attachment.status === "error"
          ? new vscode.ThemeColor("testing.iconFailed")
          : undefined,
    );
    this.command = {
      command: "portManager.revealTerminalWindow",
      title: "Reveal Terminal",
      arguments: [attachment],
    };
  }
}

/**
 * Current VS Code window-wide terminal network default. Selecting the row is
 * inert; detaching lives in its context menu so a stray click under the network
 * cannot drop the window's routing.
 *
 * The row renders twice (under its network and in System's runtime list), and
 * VS Code rejects duplicate ids anywhere in one tree, so the System copy gets
 * its own id. Under the network row the name would only repeat the parent label.
 */
export class VscodeWindowTerminalBindingTreeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(
    readonly binding: VscodeWindowTerminalBinding,
    network: LogicalNetwork | undefined,
    availability: ActionAvailability = { enabled: true },
    placement: "network" | "system" = "system",
  ) {
    super("VS Code terminals", vscode.TreeItemCollapsibleState.None);
    this.id = placement === "system" ? `system:${binding.id}` : binding.id;
    this.contextValue = availability.enabled ? "vscodeWindowTerminalBinding" : "vscodeWindowTerminalBinding.disabled";
    const state = binding.status === "attached" ? "window default" : binding.status;
    this.description = placement === "system" ? `${state} · ${network?.name ?? binding.networkId}` : state;
    this.tooltip = buildVscodeWindowTerminalBindingTooltip(binding, network);
    this.iconPath = new vscode.ThemeIcon(
      binding.status === "attached" ? "terminal" : "warning",
      binding.status === "error" ? new vscode.ThemeColor("testing.iconFailed") : undefined,
    );
  }
}

/** Host exposure row backed by an active or failed local listener/proxy. */
export class HostPortExposureTreeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(
    readonly exposure: HostPortExposure,
    networks: readonly LogicalNetwork[],
  ) {
    super(`${exposure.hostAddress}:${exposure.hostPort} → ${exposure.targetPort}`, vscode.TreeItemCollapsibleState.None);
    const network = networks.find((item) => item.id === exposure.networkId);
    this.id = exposure.id;
    this.contextValue = exposure.status === "active" ? "hostExposureActive" : "hostExposure";
    this.description = formatRouteDescription(["host binding"], exposure.status, "active");
    this.tooltip = buildExposureTooltip(exposure, network);
    this.iconPath = new vscode.ThemeIcon(
      exposure.status === "active" ? "link-external" : "warning",
      exposure.status === "error" ? new vscode.ThemeColor("testing.iconFailed") : undefined,
    );
  }
}

/** Network-to-host binding row used by attached terminal processes. */
export class HostAccessBindingTreeItem extends vscode.TreeItem {
  readonly contextValue = "hostAccessBinding";

  constructor(readonly binding: HostAccessBinding) {
    super(`${binding.logicalPort} → ${binding.hostAddress}:${binding.hostPort}`, vscode.TreeItemCollapsibleState.None);
    this.id = binding.id;
    this.description = formatRouteDescription(["host access"], binding.status, "active");
    this.tooltip = buildHostAccessBindingTooltip(binding);
    this.iconPath = new vscode.ThemeIcon(
      binding.status === "active" ? "arrow-swap" : "warning",
      binding.status === "error" ? new vscode.ThemeColor("testing.iconFailed") : undefined,
    );
  }
}

/** Runtime adapter capability row. */
class RuntimeAdapterTreeItem extends vscode.TreeItem {
  readonly contextValue = "runtimeAdapter";

  constructor(readonly runtime: NetworkRuntimeDescriptor) {
    super(runtime.name, vscode.TreeItemCollapsibleState.None);
    const samePorts = runtime.capabilities.supportsSameInternalPorts ? "same ports" : "no isolation";
    const attach = runtime.capabilities.supportsTerminalAttach ? "attach" : "no attach";
    this.description = `${runtime.kind}, ${samePorts}, ${attach}`;
    this.tooltip = buildRuntimeTooltip(runtime);
    this.iconPath = new vscode.ThemeIcon(runtime.kind === "proxy" ? "radio-tower" : "circuit-board");
  }
}

/** Builds multirow sidebar command access so the header toolbar stays compact. */
function buildActionChildren(ownerAction: ActionAvailability = { enabled: true }): PortManagerTreeItem[] {
  return [
    new ActionTreeItem("Start Daemon", "portManager.startDaemon", "server-process", undefined, undefined, ownerAction),
    new ActionTreeItem("Restart Daemon", "portManager.restartDaemon", "debug-restart", undefined, undefined, ownerAction),
    new ActionTreeItem("Stop Daemon", "portManager.stopDaemon", "debug-disconnect", undefined, undefined, ownerAction),
    new ActionTreeItem("Daemon Status", "portManager.showDaemonStatus", "pulse"),
    new ActionTreeItem("Start Managed Process", "portManager.startManagedProcess", "run", undefined, undefined, ownerAction),
    new ActionTreeItem("Add Existing Process", "portManager.addExistingProcess", "add", undefined, undefined, ownerAction),
    new ActionTreeItem("Refresh", "portManager.refresh", "refresh", undefined, undefined, ownerAction),
    new ActionTreeItem(
      "Install or Repair pm Integration",
      "portManager.installShellHook",
      "terminal",
      "Make pm available in new shells",
      undefined,
      ownerAction,
    ),
    new ActionTreeItem("Install External CLI", "portManager.installExternalCli", "terminal", undefined, undefined, ownerAction),
    new ActionTreeItem("Stop All Processes", "portManager.stopAllProcesses", "debug-stop", undefined, undefined, ownerAction),
    new ActionTreeItem("Open Settings", "portManager.openSettings", "settings-gear"),
  ];
}

/** Static daemon detail row. */
class DaemonStatusTreeItem extends vscode.TreeItem {
  readonly contextValue = "daemonStatus";

  constructor(
    label: string,
    description: string,
    icon: string = "info",
    tooltip?: vscode.MarkdownString,
    command?: vscode.Command,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip ?? new vscode.MarkdownString(`${label}\n\n${description}`);
    this.command = command;
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
    this.tooltip = new vscode.MarkdownString(`${label}\n\n${description}`);
    this.iconPath = new vscode.ThemeIcon("debug-start");
  }
}

/** Builds the collapsed, presentation-only System categories without changing diagnostic leaves. */
function buildSystemGroupItems(
  daemon: AgentDaemonStatus,
  snapshot: NetworkSnapshot,
  agentSnapshot: AgentSnapshot,
  browserDns: BrowserDnsResolverStatus,
  ownerAction: ActionAvailability,
): PortManagerTreeItem[] {
  const healthRows: PortManagerTreeItem[] = [
    new DaemonStatusTreeItem(
      "Control Owner",
      formatControlPlaneRoleDescription(snapshot.controlPlane),
      snapshot.controlPlane?.role === "owner" ? "workspace-trusted" : "workspace-untrusted",
      buildControlPlaneTooltip(snapshot.controlPlane),
      {
        command: "portManager.openOwnerUi",
        title: "Make This Window Owner",
      },
    ),
    ...buildOwnerUiActionRows(snapshot.controlPlane),
    new DaemonStatusTreeItem("This Window PID", String(snapshot.controlPlane?.currentPid ?? process.pid), "window"),
    new DaemonStatusTreeItem("Status", daemon.status, daemon.status === "running" ? "pass" : "warning"),
    new DaemonStatusTreeItem(
      "Version",
      formatDaemonVersionDescription(daemon),
      daemon.restartRequired ? "warning" : "verified",
    ),
    new DaemonStatusTreeItem("PID", daemon.pid > 0 ? String(daemon.pid) : "n/a", "server-process"),
    new DaemonStatusTreeItem("Listeners", String(daemon.listenerCount), "radio-tower"),
    new DaemonStatusTreeItem("Routes", String(daemon.routeCount), "references"),
    new DaemonStatusTreeItem("Agent Main", daemon.agentMainPath ?? "n/a", "file-code"),
    new DaemonStatusTreeItem("Expected Agent", daemon.expectedAgentMainPath ?? "n/a", "file-code"),
    new DaemonStatusTreeItem("Route Table File", daemon.routeTablePath ?? "n/a", "json"),
    new DaemonStatusTreeItem("Updated", daemon.updatedAt, "clock"),
  ];

  if (daemon.errorMessage) {
    healthRows.push(new DaemonStatusTreeItem("Warning", daemon.errorMessage, "warning"));
  }

  const runtimeRows: PortManagerTreeItem[] = [
    ...(snapshot.vscodeWindowTerminalBinding !== undefined
      ? [
          new VscodeWindowTerminalBindingTreeItem(
            snapshot.vscodeWindowTerminalBinding,
            snapshot.networks.find((network) => network.id === snapshot.vscodeWindowTerminalBinding?.networkId),
          ),
        ]
      : []),
    ...snapshot.terminalWindows.map((window) => new TerminalWindowTreeItem(window)),
    ...(snapshot.runtimes.some(isContainerLevelRuntime)
      ? []
      : [
          new PlannedFeatureTreeItem(
            "No terminal isolation runtime",
            "Local proxy cannot attach terminal ports",
            "warning",
          ),
        ]),
    ...snapshot.runtimes.map((runtime) => new RuntimeAdapterTreeItem(runtime)),
  ];
  const browserRows = buildBrowserDnsDiagnosticRows(browserDns, ownerAction);
  const activityEntries = buildRoutingTimelineRows(snapshot, agentSnapshot);
  const activityRows: PortManagerTreeItem[] = activityEntries.length > 0
    ? activityEntries.map((row) => new RoutingTimelineTreeItem(row))
    : [new EmptyTreeItem("No activity", "Attach a terminal or service")];
  const maintenanceRows: PortManagerTreeItem[] = [
    new ActionTreeItem(
      "Install or Repair pm Integration",
      "portManager.installShellHook",
      "terminal",
      "Make pm available in new shells",
    ),
    new ActionTreeItem(
      "Fix Stale Routing",
      "portManager.fixStaleRouting",
      "debug-rerun",
      "Converge daemon and routes",
      undefined,
      ownerAction,
    ),
    new ActionTreeItem(
      "Clear Global Storage Files",
      "portManager.clearGlobalStorageFiles",
      "clear-all",
      "Remove extension storage files",
      undefined,
      ownerAction,
    ),
  ];

  return [
    new SidebarGroupTreeItem("system.health", "Health", formatDaemonState(daemon), "pulse", healthRows),
    new SidebarGroupTreeItem("system.browserDns", "Browser access & DNS", formatBrowserDnsSummary(browserDns), "globe", browserRows),
    new SidebarGroupTreeItem("system.runtime", "Runtime & terminal discovery", formatRuntimeDiscoverySummary(snapshot), "terminal", runtimeRows),
    new SidebarGroupTreeItem("system.activity", "Recent activity", activityEntries.length === 0 ? "No activity" : formatSidebarCounts([{ count: activityEntries.length, singular: "event" }]), "history", activityRows),
    new SidebarGroupTreeItem("system.maintenance", "Maintenance", formatSidebarCounts([{ count: maintenanceRows.length, singular: "action" }]), "tools", maintenanceRows),
  ];
}

function buildOwnerUiActionRows(controlPlane: ControlPlaneStatus | undefined): PortManagerTreeItem[] {
  if (isControlPlaneOwner(controlPlane)) {
    return [];
  }

  return [
    new ActionTreeItem(
      "Make This Window Owner",
      "portManager.openOwnerUi",
      "window",
      formatOpenOwnerUiDescription(controlPlane),
    ),
  ];
}

function formatOpenOwnerUiDescription(controlPlane: ControlPlaneStatus | undefined): string {
  if (controlPlane?.role === "worker") {
    return `take ownership from ${formatOwnerWindowTitle(controlPlane)}, pid ${controlPlane.ownerPid ?? "unknown"}`;
  }

  if (controlPlane?.role === "unowned") {
    return "claim ownership for this window";
  }

  return "make this window the owner";
}

function formatOwnerWindowTitle(controlPlane: ControlPlaneStatus | undefined): string {
  return controlPlane?.ownerTitle?.trim() || "owner window";
}

function buildControlPlaneTooltip(controlPlane: ControlPlaneStatus | undefined): vscode.MarkdownString {
  const lines = [
    `Role: ${controlPlane?.role ?? "unknown"}`,
    `This window PID: ${controlPlane?.currentPid ?? process.pid}`,
    `Owner PID: ${controlPlane?.ownerPid ?? "n/a"}`,
    `Owner window: ${controlPlane?.ownerTitle ?? "n/a"}`,
    `Owner active: ${controlPlane?.ownerActive === true ? "yes" : "no"}`,
    `Updated: ${controlPlane?.ownerUpdatedAt ?? "n/a"}`,
    `Lease expires: ${controlPlane?.leaseExpiresAt ?? "n/a"}`,
  ];

  return new vscode.MarkdownString(lines.join("\n\n"));
}

function buildBrowserDnsDiagnosticRows(
  browserDns: BrowserDnsResolverStatus,
  ownerAction: ActionAvailability,
): PortManagerTreeItem[] {
  if (!browserDns.supported) {
    return [new DaemonStatusTreeItem("Browser DNS", "unsupported", "circle-slash")];
  }

  const staleSuffix = browserDns.tlsStaleCount > 0 ? `, ${browserDns.tlsStaleCount} TLS stale` : "";
  const description =
    browserDns.records.length === 0
      ? "no aliases"
      : `${browserDns.installedCount}/${browserDns.records.length} installed${staleSuffix}`;
  const icon = browserDns.missingCount === 0 && browserDns.tlsStaleCount === 0 ? "globe" : "warning";

  return [
    new DaemonStatusTreeItem("Browser DNS", `${description}, port ${browserDns.dnsPort}`, icon),
    new DaemonStatusTreeItem(
      "TLS Trust",
      browserDns.tlsTrustState,
      browserDns.tlsTrustState === "trusted"
        ? "verified"
        : browserDns.tlsTrustState === "checking"
          ? "loading~spin"
          : "warning",
      browserDns.tlsTrustDetail === undefined
        ? undefined
        : new vscode.MarkdownString(`TLS trust: ${browserDns.tlsTrustState}\n\n${browserDns.tlsTrustDetail}`),
    ),
    new ActionTreeItem(
      "Repair Local DNS",
      "portManager.repairLocalDns",
      "tools",
      browserDns.missingCount > 0
        ? `Reapply ${browserDns.missingCount} incomplete alias${browserDns.missingCount === 1 ? "" : "es"}`
        : "Reapply resolver, loopback aliases, and hosts",
      undefined,
      ownerAction,
    ),
    ...browserDns.records.flatMap((record) => buildBrowserDnsRecordRows(record, ownerAction)),
    new ActionTreeItem(
      "Install Browser DNS",
      "portManager.installBrowserDnsResolvers",
      "cloud-upload",
      "Create aliases",
      undefined,
      ownerAction,
    ),
    ...(browserDns.records.length === 0
      ? []
      : [
          new ActionTreeItem(
            "Renew TLS Certificate",
            "portManager.renewBrowserTlsCertificate",
            "shield",
            browserDns.tlsValidTo === undefined
              ? "Reissue dev certificate"
              : `Valid until ${formatBrowserTlsValidTo(browserDns.tlsValidTo)}`,
            undefined,
            ownerAction,
          ),
        ]),
    new ActionTreeItem(
      "Clean Browser DNS",
      "portManager.cleanupBrowserDnsResolvers",
      "trash",
      "Remove aliases",
      undefined,
      ownerAction,
    ),
  ];
}

function formatBrowserTlsValidTo(validTo: string): string {
  const parsed = Date.parse(validTo);
  return Number.isNaN(parsed) ? validTo : new Date(parsed).toISOString().slice(0, 10);
}

function buildBrowserDnsRecordRows(
  record: BrowserDnsResolverStatus["records"][number],
  ownerAction: ActionAvailability,
): PortManagerTreeItem[] {
  const resolverStatus = record.resolverConfigured ? "resolver ok" : "missing resolver";
  const aliasStatus = record.loopbackAliasConfigured ? "loopback ok" : "missing loopback";
  const hostsStatus = record.hostsConfigured ? "hosts ok" : "missing hosts";
  const tlsStatus = record.tlsStatusDetail ?? (record.tlsConfigured ? "TLS ok" : "missing TLS");
  const configured = record.configured
    ? record.tlsStale
      ? `configured, ${tlsStatus}`
      : "configured"
    : `${resolverStatus}, ${aliasStatus}, ${hostsStatus}, ${tlsStatus}`;
  const aliasTooltip = new vscode.MarkdownString(
    [
      `Network: ${record.networkName}`,
      `Alias: ${record.hostname}`,
      `Secure alias: ${record.secureHostname}`,
      `Loopback: ${record.address}`,
      `Resolver: ${resolverStatus}`,
      `Loopback alias: ${aliasStatus}`,
      `Hosts entry: ${hostsStatus}`,
      `Dev TLS: ${tlsStatus}`,
    ].join("\n\n"),
  );
  const rows: PortManagerTreeItem[] = [
    new DaemonStatusTreeItem(
      `DNS ${record.hostname}`,
      `${record.address}, ${configured}`,
      record.configured && !record.tlsStale ? "globe" : "warning",
      aliasTooltip,
    ),
  ];

  // A stale or broken alias gets its own repair action so one network can be
  // fixed without re-running the whole install flow by hand.
  if (record.tlsStale || !record.configured) {
    rows.push(
      new ActionTreeItem(
        `Repair ${record.hostname}`,
        "portManager.repairBrowserDnsRecord",
        "shield",
        record.tlsStale ? tlsStatus : "Reinstall alias",
        { networkId: record.networkId },
        ownerAction,
      ),
    );
  }

  if (record.routes.length === 0) {
    rows.push(new DaemonStatusTreeItem(`DNS ${record.hostname}:ports`, "no running browser routes", "circle-slash"));
    return rows;
  }

  for (const route of record.routes) {
    const upstream =
      route.upstreamHost === undefined || route.upstreamPort === undefined
        ? "route missing"
        : `${route.upstreamHost}:${route.upstreamPort}`;
    const proxy = `${route.proxyHost}:${route.proxyPort}${route.proxyActive ? "" : " pending"}`;
    const routeTooltip = new vscode.MarkdownString(
      [
        `URL: ${route.url}`,
        `Logical port: ${route.logicalPort}`,
        `Proxy: ${proxy}`,
        `Upstream: ${upstream}`,
        `Process: ${route.processName}`,
      ].join("\n\n"),
    );

    rows.push(
      new DaemonStatusTreeItem(
        `DNS ${record.hostname}:${route.proxyPort}`,
        `${proxy} -> ${upstream}`,
        route.proxyActive && route.upstreamHost !== undefined ? "link" : "warning",
        routeTooltip,
      ),
    );
  }

  return rows;
}

/** Builds a compact route/attachment history from durable timestamps and daemon refreshes. */
function buildRoutingTimelineRows(
  snapshot: NetworkSnapshot,
  agentSnapshot: AgentSnapshot,
): readonly RoutingTimelineEntry[] {
  const rows: RoutingTimelineEntry[] = [];

  if (snapshot.vscodeWindowTerminalBinding !== undefined) {
    const binding = snapshot.vscodeWindowTerminalBinding;
    const network = snapshot.networks.find((item) => item.id === binding.networkId);
    rows.push(
      createRoutingTimelineRow({
        id: `timeline:vscode-window:${binding.id}`,
        label: "VS Code terminal default",
        description: `${network?.name ?? binding.networkId}, ${binding.status}`,
        updatedAt: binding.attachedAt,
        icon: binding.status === "error" ? "warning" : "terminal",
        networkId: binding.networkId,
        networkName: network?.name,
      }),
    );
  }

  for (const attachment of snapshot.attachments) {
    const network = snapshot.networks.find((item) => item.id === attachment.networkId);
    rows.push(
      createRoutingTimelineRow({
        id: `timeline:terminal:${attachment.id}`,
        label: attachment.terminalTitle ?? `Terminal PID ${attachment.rootPid}`,
        description: `${network?.name ?? attachment.networkId}, ${attachment.status}`,
        updatedAt: attachment.attachedAt,
        icon: attachment.status === "error" ? "warning" : "plug",
        networkId: attachment.networkId,
        networkName: network?.name,
      }),
    );
  }

  for (const attachment of snapshot.composeAttachments) {
    const network = snapshot.networks.find((item) => item.id === attachment.networkId);
    rows.push(
      createRoutingTimelineRow({
        id: `timeline:compose:${attachment.id}`,
        label: attachment.mutation?.attachedProjectName ?? attachment.projectName,
        description: `${network?.name ?? attachment.networkId}, ${formatRouteCount(attachment.ports.length)}`,
        updatedAt: attachment.attachedAt,
        icon: attachment.status === "error" ? "warning" : "server-environment",
        networkId: attachment.networkId,
        networkName: network?.name,
      }),
    );
  }

  for (const exposure of snapshot.exposures) {
    const network = snapshot.networks.find((item) => item.id === exposure.networkId);
    rows.push(
      createRoutingTimelineRow({
        id: `timeline:host-exposure:${exposure.id}`,
        label: `${exposure.hostAddress}:${exposure.hostPort} exposed`,
        description: `${network?.name ?? exposure.networkId}, ${exposure.status}`,
        updatedAt: exposure.createdAt,
        icon: exposure.status === "error" ? "warning" : "link-external",
        networkId: exposure.networkId,
        networkName: network?.name,
      }),
    );
  }

  for (const binding of snapshot.hostAccessBindings) {
    const network = snapshot.networks.find((item) => item.id === binding.networkId);
    rows.push(
      createRoutingTimelineRow({
        id: `timeline:host-access:${binding.id}`,
        label: `network:${binding.logicalPort} host access`,
        description: `${network?.name ?? binding.networkId}, ${binding.status}`,
        updatedAt: binding.createdAt,
        icon: binding.status === "error" ? "warning" : "arrow-swap",
        networkId: binding.networkId,
        networkName: network?.name,
      }),
    );
  }

  if (agentSnapshot.routes.length > 0) {
    rows.push(
      createRoutingTimelineRow({
        id: "timeline:daemon-routes",
        label: "Daemon routes updated",
        description: `${formatRouteCount(agentSnapshot.routes.length)} active`,
        updatedAt: agentSnapshot.updatedAt,
        icon: "references",
      }),
    );
  }

  return rows
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, 8);
}

function formatRouteCount(count: number): string {
  return `${count} route${count === 1 ? "" : "s"}`;
}

function createRoutingTimelineRow(input: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly icon: string;
  readonly networkId?: string;
  readonly networkName?: string;
}): RoutingTimelineEntry {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(input.label)}**\n\n`);
  tooltip.appendMarkdown(`- Context: \`${escapeMarkdown(input.description)}\`\n`);
  if (input.networkId !== undefined) {
    tooltip.appendMarkdown(`- Network: \`${escapeMarkdown(input.networkName ?? input.networkId)}\`\n`);
    tooltip.appendMarkdown(`- Network ID: \`${escapeMarkdown(input.networkId)}\`\n`);
  }
  tooltip.appendMarkdown(`- Updated: \`${escapeMarkdown(input.updatedAt)}\`\n`);

  return {
    id: input.id,
    label: input.label,
    description: input.description,
    updatedAt: input.updatedAt,
    icon: input.icon,
    ...(input.icon === "warning" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
    tooltip,
  };
}

/** One-line daemon summary for the root section. */
function formatDaemonSummary(daemon: AgentDaemonStatus): string {
  const version = daemon.restartRequired ? "stale" : (daemon.versionStatus ?? "unknown");
  return daemon.pid > 0 ? `${daemon.status} pid ${daemon.pid}, ${version}` : daemon.status;
}

/** Shows the daemon build and the client expectation in the diagnostics group. */
function formatDaemonVersionDescription(daemon: AgentDaemonStatus): string {
  const version = daemon.version ?? "unknown";
  const status = daemon.versionStatus ?? "unknown";
  const expected = daemon.expectedVersion !== undefined ? `, expected ${daemon.expectedVersion}` : "";
  return `${version} ${status}${expected}`;
}

function isControlPlaneOwner(controlPlane: ControlPlaneStatus | undefined): boolean {
  return controlPlane?.role === "owner";
}

/**
 * Every window keeps owner-scoped actions enabled: the command wrapper takes
 * control-plane ownership before running, so non-owner windows never dead-end.
 */
function buildOwnerActionAvailability(_controlPlane: ControlPlaneStatus | undefined): ActionAvailability {
  return { enabled: true };
}

function formatOwnerOnlyActionReason(controlPlane: ControlPlaneStatus | undefined): string {
  if (controlPlane?.role === "worker") {
    return `Owner window only, owner pid ${controlPlane.ownerPid ?? "unknown"}`;
  }

  if (controlPlane?.role === "unowned") {
    return "Owner window only, no owner elected yet";
  }

  return "Owner window only";
}

function formatControlPlaneRoleDescription(controlPlane: ControlPlaneStatus | undefined): string {
  if (controlPlane?.role === "owner") {
    return `owner pid ${controlPlane.currentPid}`;
  }

  if (controlPlane?.role === "worker") {
    return `worker, owner pid ${controlPlane.ownerPid ?? "unknown"}`;
  }

  if (controlPlane?.role === "unowned") {
    return "no owner";
  }

  return "owner unknown";
}

/**
 * One-line System summary: daemon health first, then this window's role only
 * when it is not the owner. PIDs and discovery counts live in the Health and
 * Runtime groups so the collapsed row stays readable.
 */
function formatDiagnosticsSummary(daemon: AgentDaemonStatus, snapshot: NetworkSnapshot): string {
  const role =
    snapshot.controlPlane?.role === "worker"
      ? "worker window"
      : snapshot.controlPlane?.role === "unowned"
        ? "no owner"
        : undefined;
  return role === undefined ? formatDaemonState(daemon) : `${formatDaemonState(daemon)} · ${role}`;
}

/** Daemon health as sentence-case text; a stale build outranks the lifecycle state. */
function formatDaemonState(daemon: AgentDaemonStatus): string {
  return daemon.restartRequired ? "Daemon stale" : capitalizeForSidebar(daemon.status);
}

/** Uses text, rather than icon color, to make sidebar state legible at a glance. */
function capitalizeForSidebar(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

/** Summarizes DNS readiness with meaningful resolver, alias, and certificate state. */
function formatBrowserDnsSummary(browserDns: BrowserDnsResolverStatus): string {
  if (!browserDns.supported) {
    return "Unsupported";
  }

  const state = browserDns.records.length === 0
    ? "No aliases"
    : !browserDns.dnsRunning
      ? "DNS stopped"
      : browserDns.tlsTrustState === "checking"
        ? "Checking TLS"
        : browserDns.tlsTrustState === "untrusted"
          ? "TLS untrusted"
          : browserDns.missingCount > 0
            ? "Needs repair"
            : browserDns.tlsStaleCount > 0
              ? "TLS stale"
              : "Ready";
  return formatSidebarSummary(state, [
    { count: browserDns.records.length, singular: "alias" },
    { count: browserDns.missingCount, singular: "missing alias" },
    { count: browserDns.tlsStaleCount, singular: "TLS stale alias" },
  ]);
}

/** Summarizes actual terminal/runtime discovery rather than presentation placeholders. */
function formatRuntimeDiscoverySummary(snapshot: NetworkSnapshot): string {
  if (snapshot.terminalWindows.length === 0 && snapshot.runtimes.length === 0) {
    return "No terminals or runtimes";
  }

  return formatSidebarCounts([
    { count: snapshot.terminalWindows.length, singular: "terminal" },
    { count: snapshot.runtimes.length, singular: "runtime" },
  ]);
}

/**
 * First-run shortcuts listed above the networks. Initialize stays until this
 * window has a default network; the isolated-worktree row only fills the empty
 * state because the view toolbar already carries that command.
 */
function buildOnboardingActionItems(
  snapshot: NetworkSnapshot,
  ownerAction: ActionAvailability,
): PortManagerTreeItem[] {
  return [
    ...(snapshot.vscodeWindowTerminalBinding === undefined
      ? [
          new ActionTreeItem(
            "Initialize This Worktree",
            "portManager.initializeWorktree",
            "rocket",
            "Create and use one default network",
            undefined,
            ownerAction,
          ),
        ]
      : []),
    ...(snapshot.networks.length === 0
      ? [
          new ActionTreeItem(
            "Create Isolated Worktree",
            "portManager.createIsolatedWorktree",
            "new-folder",
            "Worktree + network + Compose copy",
            undefined,
            ownerAction,
          ),
        ]
      : []),
  ];
}

/**
 * Active routes can outlive the network row that owned them, for example when
 * a network is removed while its servers keep running. Those scopes get a
 * warning row after the known networks so the leftover routes stay visible.
 */
function buildStaleRouteScopeItems(
  snapshot: NetworkSnapshot,
  agentSnapshot: AgentSnapshot,
): PortManagerTreeItem[] {
  const knownNetworkIds = new Set(snapshot.networks.map((network) => network.id));

  return projectCurrentRouting(snapshot, agentSnapshot)
    .networkIds.filter((networkId) => !knownNetworkIds.has(networkId))
    .map((networkId) => {
      const scope = { id: networkId, name: `Unknown network ${networkId.slice(0, 8)}` };
      const routeRows = buildNetworkRouteConnectionRows(networkId, snapshot, agentSnapshot, "current");
      const description = routeRows.length === 0
        ? "Stale · no routes"
        : formatSidebarSummary("Stale", [{ count: routeRows.length, singular: "route" }]);

      return new NetworkRoutingGroupTreeItem(
        scope,
        scope.name,
        description,
        routeRows,
        "stale",
        "warning",
        new vscode.ThemeColor("problemsWarningIcon.foreground"),
      );
    });
}

/**
 * Flattens one network into scan order: routed ports first (sorted by logical
 * port), then the window default, terminals, and Compose projects that feed
 * them. Host bindings and host access arrive as route rows but render through
 * their own leaves so the open/copy/remove menus stay attached to them.
 */
function buildNetworkChildItems(
  network: LogicalNetwork,
  snapshot: NetworkSnapshot,
  routeRows: readonly NetworkRouteConnection[],
): PortManagerTreeItem[] {
  const exposuresById = new Map(
    snapshot.exposures.filter((exposure) => exposure.networkId === network.id).map((exposure) => [exposure.id, exposure]),
  );
  const hostAccessById = new Map(
    snapshot.hostAccessBindings.filter((binding) => binding.networkId === network.id).map((binding) => [binding.id, binding]),
  );
  const portRows = routeRows.map((route): PortManagerTreeItem => {
    const exposure = route.kind === "hostExposure" && route.sourceId !== undefined
      ? exposuresById.get(route.sourceId)
      : undefined;
    if (exposure !== undefined) {
      return new HostPortExposureTreeItem(exposure, [network]);
    }

    const binding = route.kind === "hostAccess" && route.sourceId !== undefined
      ? hostAccessById.get(route.sourceId)
      : undefined;
    return binding !== undefined ? new HostAccessBindingTreeItem(binding) : new NetworkRouteConnectionTreeItem(route);
  });
  const windowBinding = snapshot.vscodeWindowTerminalBinding?.networkId === network.id
    ? snapshot.vscodeWindowTerminalBinding
    : undefined;

  return [
    ...portRows,
    ...(windowBinding !== undefined
      ? [new VscodeWindowTerminalBindingTreeItem(windowBinding, network, { enabled: true }, "network")]
      : []),
    ...snapshot.attachments
      .filter((attachment) => attachment.networkId === network.id)
      .map((attachment) => new TerminalAttachmentTreeItem(attachment)),
    ...snapshot.composeAttachments
      .filter((attachment) => attachment.networkId === network.id)
      .map((attachment) => new ComposeAttachmentTreeItem(attachment)),
  ];
}

/** Compact active/current context projection shared by root routing rows and their summary. */
export function projectCurrentRouting(
  snapshot: NetworkSnapshot,
  agentSnapshot: AgentSnapshot,
): { readonly networkIds: readonly string[]; readonly attachedTerminalCount: number } {
  const networkIds = new Set<string>();

  if (snapshot.vscodeWindowTerminalBinding !== undefined) {
    networkIds.add(snapshot.vscodeWindowTerminalBinding.networkId);
  }

  for (const attachment of snapshot.attachments) {
    if (attachment.status === "attached") {
      networkIds.add(attachment.networkId);
    }
  }

  for (const route of agentSnapshot.routes) {
    if (route.networkId !== undefined && route.status === "running") {
      networkIds.add(route.networkId);
    }
  }

  for (const binding of snapshot.hostAccessBindings) {
    if (binding.status === "active") {
      networkIds.add(binding.networkId);
    }
  }

  for (const exposure of snapshot.exposures) {
    if (exposure.status === "active") {
      networkIds.add(exposure.networkId);
    }
  }

  for (const attachment of snapshot.composeAttachments) {
    if (attachment.status === "attached") {
      networkIds.add(attachment.networkId);
    }
  }

  return {
    networkIds: [...networkIds],
    attachedTerminalCount: snapshot.attachments.filter((attachment) => attachment.status === "attached").length,
  };
}

/** Normalizes every route source for one network into display rows. */
function buildNetworkRouteConnectionRows(
  networkId: string,
  snapshot: NetworkSnapshot,
  agentSnapshot: AgentSnapshot,
  scope: "network" | "current" = "network",
): readonly NetworkRouteConnection[] {
  const daemonRoutes = agentSnapshot.routes.filter(
    (route) => route.networkId === networkId && (scope === "network" || route.status === "running"),
  );
  const daemonProcessIds = new Set(
    daemonRoutes.map((route) => route.processId).filter((processId): processId is string => processId !== undefined),
  );
  const rows: NetworkRouteConnection[] = daemonRoutes.map(buildDaemonRouteConnection);

  for (const attachment of snapshot.composeAttachments.filter(
    (item) => item.networkId === networkId && (scope === "network" || item.status === "attached"),
  )) {
    for (const port of attachment.ports) {
      if (
        (port.processId !== undefined && daemonProcessIds.has(port.processId)) ||
        daemonRoutes.some(
          (route) =>
            route.source === "compose" &&
            route.logicalPort === port.logicalPort &&
            route.actualPort === port.actualHostPort,
        )
      ) {
        continue;
      }

      rows.push(buildComposeRouteConnection(attachment, port));
    }
  }

  for (const binding of snapshot.hostAccessBindings.filter(
    (item) => item.networkId === networkId && (scope === "network" || item.status === "active"),
  )) {
    rows.push(buildHostAccessRouteConnection(binding));
  }

  for (const exposure of snapshot.exposures.filter(
    (item) => item.networkId === networkId && (scope === "network" || item.status === "active"),
  )) {
    rows.push(buildHostExposureRouteConnection(exposure));
  }

  return rows.sort((left, right) => left.logicalPort - right.logicalPort || left.label.localeCompare(right.label));
}

/**
 * Route rows read as `logical → transport` with the owner as description.
 * Healthy states stay implicit; only a non-default status is spelled out.
 */
function buildDaemonRouteConnection(route: LogicalPortRoute): NetworkRouteConnection {
  const owner = route.processName ?? route.source;

  return {
    id: `route:${route.networkId ?? "global"}:daemon:${route.logicalPort}:${route.actualPort}:${route.processId ?? route.source}:${route.routeDirection ?? "listen"}`,
    label: `${route.logicalPort} → ${route.host}:${route.actualPort}`,
    description: formatRouteDescription([owner, route.routeDirection === "send" ? "sender" : undefined], route.status, "running"),
    logicalPort: route.logicalPort,
    kind: "daemon",
    tooltip: buildRouteTooltip(route),
    icon: route.status === "error" ? "error" : route.source === "compose" ? "server-environment" : "symbol-interface",
    ...(route.status === "error" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
  };
}

function buildComposeRouteConnection(
  attachment: ComposeAttachment,
  port: ComposePublishedPort,
): NetworkRouteConnection {
  return {
    id: `route:${attachment.networkId}:compose:${attachment.id}:${port.serviceName}:${port.logicalPort}:${port.actualHostPort}`,
    label: `${port.logicalPort} → ${port.actualHostAddress}:${port.actualHostPort}`,
    description: formatRouteDescription([`${attachment.projectName}/${port.serviceName}`], attachment.status, "attached"),
    logicalPort: port.logicalPort,
    kind: "compose",
    tooltip: buildComposeRouteTooltip(attachment, port),
    icon: attachment.status === "error" ? "error" : "server-environment",
    ...(attachment.status === "error" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
  };
}

function buildHostAccessRouteConnection(binding: HostAccessBinding): NetworkRouteConnection {
  return {
    id: `route:${binding.networkId}:host-access:${binding.id}`,
    label: `${binding.logicalPort} → ${binding.hostAddress}:${binding.hostPort}`,
    description: formatRouteDescription(["host access"], binding.status, "active"),
    logicalPort: binding.logicalPort,
    kind: "hostAccess",
    sourceId: binding.id,
    tooltip: buildHostAccessBindingTooltip(binding),
    icon: "arrow-swap",
    ...(binding.status === "error" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
  };
}

function buildHostExposureRouteConnection(exposure: HostPortExposure): NetworkRouteConnection {
  return {
    id: `route:${exposure.networkId}:host-exposure:${exposure.id}`,
    label: `${exposure.hostAddress}:${exposure.hostPort} → ${exposure.targetPort}`,
    description: formatRouteDescription(["host binding"], exposure.status, "active"),
    logicalPort: exposure.targetPort,
    kind: "hostExposure",
    sourceId: exposure.id,
    tooltip: buildExposureTooltip(exposure, undefined),
    icon: "link-external",
    ...(exposure.status === "error" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
  };
}

/** Joins route context with ` · ` and appends the status only when it is not the healthy one. */
function formatRouteDescription(
  parts: readonly (string | undefined)[],
  status: string,
  healthyStatus: string,
): string {
  return [...parts, status === healthyStatus ? undefined : status]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" · ");
}

/** Terminal rows name only the exceptional cases: shared-port mode or a non-attached state. */
function formatTerminalAttachmentDescription(attachment: TerminalAttachment): string {
  return formatRouteDescription(
    [attachment.mode === "logical" ? "logical mode" : "terminal"],
    attachment.status,
    "attached",
  );
}

function formatTerminalSectionDescription(
  terminalWindows: readonly TerminalWindow[],
  binding: VscodeWindowTerminalBinding | undefined,
  networks: readonly LogicalNetwork[],
): string {
  if (binding === undefined) {
    return `${terminalWindows.length} windows`;
  }

  const network = networks.find((item) => item.id === binding.networkId);
  return `${terminalWindows.length} windows, ${network?.name ?? binding.networkId}`;
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

/** Extracts a logical network from a tree command argument. */
export function getLogicalNetworkFromCommandArgument(argument: unknown): LogicalNetwork | undefined {
  if (argument instanceof LogicalNetworkTreeItem) {
    return argument.network;
  }

  if (isLogicalNetwork(argument)) {
    return argument;
  }

  const wrappedNetwork = getWrappedLogicalNetwork(argument);
  if (wrappedNetwork !== undefined) {
    return wrappedNetwork;
  }

  return undefined;
}

function getWrappedLogicalNetwork(argument: unknown): LogicalNetwork | undefined {
  if (typeof argument !== "object" || argument === null || !("network" in argument)) {
    return undefined;
  }

  const candidate = argument as { readonly network?: unknown };
  return isLogicalNetwork(candidate.network) ? candidate.network : undefined;
}

/** Extracts a terminal window from a tree command argument. */
export function getTerminalWindowFromCommandArgument(argument: unknown): TerminalWindow | undefined {
  if (argument instanceof TerminalWindowTreeItem) {
    return argument.window;
  }

  if (isTerminalWindow(argument)) {
    return argument;
  }

  return undefined;
}

/** Extracts a container service candidate from a tree command argument. */
export function getContainerServiceCandidateFromCommandArgument(
  argument: unknown,
): ContainerServiceCandidate | undefined {
  if (argument instanceof ComposeProjectCandidateTreeItem) {
    return argument.aggregateCandidate;
  }

  if (argument instanceof ContainerServiceCandidateTreeItem) {
    return argument.candidate;
  }

  if (isAttachContainerInput(argument)) {
    return argument.containerService;
  }

  if (isContainerServiceCandidate(argument)) {
    return argument;
  }

  return undefined;
}

/** Extracts a terminal attachment from a tree command argument. */
export function getTerminalAttachmentFromCommandArgument(argument: unknown): TerminalAttachment | undefined {
  if (argument instanceof TerminalAttachmentTreeItem) {
    return argument.attachment;
  }

  if (isTerminalAttachment(argument)) {
    return argument;
  }

  return undefined;
}

/** Extracts a host exposure from a tree command argument. */
export function getHostPortExposureFromCommandArgument(argument: unknown): HostPortExposure | undefined {
  if (argument instanceof HostPortExposureTreeItem) {
    return argument.exposure;
  }

  if (isHostPortExposure(argument)) {
    return argument;
  }

  return undefined;
}

/** Extracts a network-to-host binding from a tree command argument. */
export function getHostAccessBindingFromCommandArgument(argument: unknown): HostAccessBinding | undefined {
  if (argument instanceof HostAccessBindingTreeItem) {
    return argument.binding;
  }

  if (isHostAccessBinding(argument)) {
    return argument;
  }

  return undefined;
}

/** Extracts a compose attachment from a tree command argument. */
export function getComposeAttachmentFromCommandArgument(argument: unknown): ComposeAttachment | undefined {
  if (argument instanceof ComposeAttachmentTreeItem) {
    return argument.attachment;
  }

  if (isComposeAttachment(argument)) {
    return argument;
  }

  return undefined;
}

function isHostAccessBinding(argument: unknown): argument is HostAccessBinding {
  return (
    typeof argument === "object" &&
    argument !== null &&
    "id" in argument &&
    "networkId" in argument &&
    "logicalPort" in argument &&
    "hostPort" in argument
  );
}

function isComposeAttachment(argument: unknown): argument is ComposeAttachment {
  return (
    typeof argument === "object" &&
    argument !== null &&
    "id" in argument &&
    "networkId" in argument &&
    "projectName" in argument &&
    "ports" in argument
  );
}

function isTerminalAttachment(argument: unknown): argument is TerminalAttachment {
  return (
    typeof argument === "object" &&
    argument !== null &&
    "id" in argument &&
    "networkId" in argument &&
    "rootPid" in argument &&
    "status" in argument &&
    "attachedAt" in argument
  );
}

/**
 * `<state> · <routes> · <terminals>` for a root network row. Host mappings are
 * already counted as routes and Compose projects feed routes, so the row keeps
 * two counts; the tooltip retains the full per-source breakdown.
 */
function buildNetworkDescription(
  network: LogicalNetwork,
  attachmentCount: number,
  exposureCount: number,
  hostAccessCount: number,
  composeCount: number,
  routeCount: number,
  isCurrentWindowNetwork: boolean,
): string {
  const hasActivity = routeCount + attachmentCount + exposureCount + hostAccessCount + composeCount > 0;
  const state =
    network.status === "error"
      ? "Error"
      : network.status === "creating"
        ? "Creating"
        : network.status === "stopped"
          ? "Stopped"
          : isCurrentWindowNetwork
            ? "This window"
            : hasActivity
              ? "Active"
              : "Idle";
  return formatSidebarSummary(state, [
    { count: routeCount, singular: "route" },
    { count: attachmentCount, singular: "terminal" },
  ]);
}

/**
 * Network icon shape and color follow the same state as the description text:
 * red on error, dimmed when stopped, green once something routes through it.
 */
function buildNetworkIcon(network: LogicalNetwork, hasChildren: boolean): vscode.ThemeIcon {
  switch (network.status) {
    case "error":
      return new vscode.ThemeIcon("vm", new vscode.ThemeColor("testing.iconFailed"));
    case "creating":
      return new vscode.ThemeIcon("loading~spin");
    case "stopped":
      return new vscode.ThemeIcon("vm-outline", new vscode.ThemeColor("disabledForeground"));
    case "running":
      return hasChildren
        ? new vscode.ThemeIcon("vm-active", new vscode.ThemeColor("testing.iconPassed"))
        : new vscode.ThemeIcon("vm-outline");
  }
}

/** Builds tooltip details for one logical network. */
function buildNetworkTooltip(
  network: LogicalNetwork,
  attachmentCount: number,
  exposureCount: number,
  hostAccessCount: number,
  composeCount: number,
  routeCount: number,
  isCurrentWindowNetwork: boolean,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(network.name)}**\n\n`);
  tooltip.appendMarkdown(`- ID: \`${escapeMarkdown(network.id)}\`\n`);
  tooltip.appendMarkdown(`- Runtime: \`${network.runtimeKind}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${network.status}\`\n`);
  tooltip.appendMarkdown(`- Current VS Code Terminal Network: \`${isCurrentWindowNetwork ? "yes" : "no"}\`\n`);
  tooltip.appendMarkdown(`- Routes: \`${routeCount}\`\n`);
  tooltip.appendMarkdown(`- Attachments: \`${attachmentCount}\`\n`);
  tooltip.appendMarkdown(`- Host Bindings: \`${exposureCount}\`\n`);
  tooltip.appendMarkdown(`- Host Access: \`${hostAccessCount}\`\n`);
  tooltip.appendMarkdown(`- Compose Attachments: \`${composeCount}\`\n`);
  tooltip.appendMarkdown(`- Created: \`${network.createdAt}\`\n`);

  if (network.errorMessage) {
    tooltip.appendMarkdown(`\nError: \`${escapeMarkdown(network.errorMessage)}\``);
  }

  return tooltip;
}

/** Builds tooltip details for one routing group. */
function buildNetworkRoutingGroupTooltip(
  network: Pick<LogicalNetwork, "id" | "name">,
  description: string,
  routeRows: readonly NetworkRouteConnection[],
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(network.name)} Routing**\n\n`);
  tooltip.appendMarkdown(`- Network ID: \`${escapeMarkdown(network.id)}\`\n`);
  tooltip.appendMarkdown(`- Context: \`${escapeMarkdown(description)}\`\n`);
  tooltip.appendMarkdown(`- Routes: \`${routeRows.length}\`\n`);

  for (const route of routeRows.slice(0, 8)) {
    tooltip.appendMarkdown(`- \`${escapeMarkdown(route.label)}\` ${escapeMarkdown(route.description)}\n`);
  }

  if (routeRows.length > 8) {
    tooltip.appendMarkdown(`- ... ${routeRows.length - 8} more\n`);
  }

  return tooltip;
}

/** Builds tooltip details for one compose attachment. */
function buildComposeAttachmentTooltip(attachment: ComposeAttachment): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  const workingDirectory = composeAttachmentWorkingDirectory(attachment);
  tooltip.appendMarkdown(`**${escapeMarkdown(attachment.projectName)}**\n\n`);
  tooltip.appendMarkdown(`- Network ID: \`${escapeMarkdown(attachment.networkId)}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${attachment.status}\`\n`);
  tooltip.appendMarkdown(`- Attached: \`${attachment.attachedAt}\`\n`);
  if (workingDirectory !== undefined) {
    tooltip.appendMarkdown(`- Original Folder: \`${escapeMarkdown(workingDirectory)}\`\n`);
  }
  if (attachment.composeFiles.length > 0) {
    tooltip.appendMarkdown("- Compose Files:\n");
    for (const composeFile of attachment.composeFiles) {
      tooltip.appendMarkdown(`  - \`${escapeMarkdown(composeFile)}\`\n`);
    }
  }
  if (attachment.mutation !== undefined) {
    tooltip.appendMarkdown(`- Original Project: \`${escapeMarkdown(attachment.mutation.originalProjectName)}\`\n`);
    tooltip.appendMarkdown(`- Hidden Project: \`${escapeMarkdown(attachment.mutation.attachedProjectName)}\`\n`);
    if (attachment.mutation.clonedVolumes !== undefined && attachment.mutation.clonedVolumes.length > 0) {
      tooltip.appendMarkdown("- Cloned Volumes:\n");
      for (const volume of attachment.mutation.clonedVolumes) {
        tooltip.appendMarkdown(
          `  - ${escapeMarkdown(volume.serviceName)} \`${escapeMarkdown(volume.containerPath)}\`: ${volume.sourceKind} \`${escapeMarkdown(volume.sourceName)}\` -> \`${escapeMarkdown(volume.targetVolumeName)}\``,
        );
        if (volume.readOnly) {
          tooltip.appendMarkdown(" `read-only`");
        }
        tooltip.appendMarkdown("\n");
      }
    }
  }

  for (const port of attachment.ports) {
    tooltip.appendMarkdown(
      `- ${escapeMarkdown(port.serviceName)}: \`${formatComposePort(port)}\``,
    );
    if (port.actualHostPort !== port.logicalPort) {
      tooltip.appendMarkdown(` transport \`${escapeMarkdown(port.actualHostAddress)}:${port.actualHostPort}\``);
    }
    if (port.protocolName) {
      tooltip.appendMarkdown(` \`${escapeMarkdown(port.protocolName)}\``);
    }
    tooltip.appendMarkdown("\n");
  }

  if (attachment.errorMessage) {
    tooltip.appendMarkdown(`\nError: \`${escapeMarkdown(attachment.errorMessage)}\``);
  }

  return tooltip;
}

/** Builds a compact row description; folder, file, and route details live in child rows. */
function formatComposeAttachmentDescription(attachment: ComposeAttachment): string {
  return formatRouteDescription(
    [
      "compose",
      attachment.mutation === undefined ? undefined : `from ${attachment.mutation.originalProjectName}`,
      `${attachment.ports.length} port${attachment.ports.length === 1 ? "" : "s"}`,
    ],
    attachment.status,
    "attached",
  );
}

function buildComposeAttachmentDetailRows(attachment: ComposeAttachment): PortManagerTreeItem[] {
  const rows: PortManagerTreeItem[] = [];
  const workingDirectory = composeAttachmentWorkingDirectory(attachment);

  if (attachment.mutation !== undefined) {
    rows.push(
      new ServiceDetailTreeItem(
        `${attachment.id}:detail:original-project`,
        "Original Project",
        attachment.mutation.originalProjectName,
        "repo",
      ),
    );
    rows.push(
      new ServiceDetailTreeItem(
        `${attachment.id}:detail:hidden-project`,
        "Attached Project",
        attachment.mutation.attachedProjectName,
        "server-environment",
      ),
    );
  }

  if (workingDirectory !== undefined) {
    rows.push(new ServiceDetailTreeItem(`${attachment.id}:detail:folder`, "Original Folder", workingDirectory, "folder"));
  }

  const composeFilesGroup = buildComposeFilesDetailGroup(
    `${attachment.id}:detail:compose-files`,
    attachment.mutation?.composeFiles ?? attachment.composeFiles,
  );
  if (composeFilesGroup !== undefined) {
    rows.push(composeFilesGroup);
  }

  const containerGroup = buildComposeContainerMappingDetailGroup(
    `${attachment.id}:detail:containers`,
    attachment.mutation?.containerMappings ?? [],
  );
  if (containerGroup !== undefined) {
    rows.push(containerGroup);
  }

  return rows;
}

function composeAttachmentWorkingDirectory(attachment: ComposeAttachment): string | undefined {
  return (
    attachment.mutation?.workingDirectory ??
    attachment.workingDirectory ??
    composeWorkingDirectoryFromFiles(attachment.composeFiles)
  );
}

function composeWorkingDirectoryFromFiles(composeFiles: readonly string[]): string | undefined {
  const firstFile = composeFiles.find((file) => file.trim().length > 0);
  return firstFile === undefined ? undefined : dirnameFromPath(firstFile);
}

function dirnameFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/[/\\]+$/, "");
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSlash < 0) {
    return undefined;
  }

  return lastSlash === 0 ? normalized.slice(0, 1) : normalized.slice(0, lastSlash);
}

/** Builds tooltip details for one compose route endpoint. */
function buildComposeRouteTooltip(attachment: ComposeAttachment, port: ComposePublishedPort): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  const workingDirectory = composeAttachmentWorkingDirectory(attachment);
  tooltip.appendMarkdown(`**Compose Route**\n\n`);
  tooltip.appendMarkdown(`- Project: \`${escapeMarkdown(attachment.projectName)}\`\n`);
  tooltip.appendMarkdown(`- Service: \`${escapeMarkdown(port.serviceName)}\`\n`);
  tooltip.appendMarkdown(`- Network ID: \`${escapeMarkdown(attachment.networkId)}\`\n`);
  if (workingDirectory !== undefined) {
    tooltip.appendMarkdown(`- Original Folder: \`${escapeMarkdown(workingDirectory)}\`\n`);
  }
  tooltip.appendMarkdown(`- Logical Port: \`${port.logicalPort}\`\n`);
  tooltip.appendMarkdown(`- Transport: \`${escapeMarkdown(port.actualHostAddress)}:${port.actualHostPort}\`\n`);
  tooltip.appendMarkdown(`- Container Port: \`${port.containerPort}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${attachment.status}\`\n`);

  if (port.protocolName) {
    tooltip.appendMarkdown(`- Protocol Name: \`${escapeMarkdown(port.protocolName)}\`\n`);
  }

  if (attachment.errorMessage) {
    tooltip.appendMarkdown(`\nError: \`${escapeMarkdown(attachment.errorMessage)}\``);
  }

  return tooltip;
}

/** Builds tooltip details for one grouped terminal window. */
function buildTerminalWindowTooltip(window: TerminalWindow): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(window.title)}**\n\n`);
  tooltip.appendMarkdown(`- Source: \`${window.source}\`\n`);
  tooltip.appendMarkdown(`- Terminal: \`${escapeMarkdown(window.terminalId ?? "n/a")}\`\n`);
  tooltip.appendMarkdown(`- Root PID: \`${window.rootPid}\`\n`);
  tooltip.appendMarkdown(`- Process Group: \`${window.processGroupId ?? "n/a"}\`\n`);
  tooltip.appendMarkdown(`- Candidate Processes: \`${window.candidateCount}\`\n`);
  tooltip.appendMarkdown(`- Command: \`${escapeMarkdown(window.command ?? "n/a")}\`\n`);

  return tooltip;
}

/** Builds tooltip details for an attached terminal window. */
function buildTerminalAttachmentTooltip(attachment: TerminalAttachment): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(attachment.terminalTitle ?? `PID ${attachment.rootPid}`)}**\n\n`);
  tooltip.appendMarkdown(`- Mode: \`${attachment.mode ?? "isolated"}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${attachment.status}\`\n`);
  tooltip.appendMarkdown(`- Root PID: \`${attachment.rootPid}\`\n`);
  tooltip.appendMarkdown(`- Process Group: \`${attachment.processGroupId ?? "n/a"}\`\n`);
  tooltip.appendMarkdown(`- Window ID: \`${escapeMarkdown(attachment.terminalWindowId ?? "n/a")}\`\n`);

  if (attachment.errorMessage) {
    tooltip.appendMarkdown(`\nWarning: \`${escapeMarkdown(attachment.errorMessage)}\``);
  }

  return tooltip;
}

/** Builds tooltip details for the VS Code window-wide terminal default. */
function buildVscodeWindowTerminalBindingTooltip(
  binding: VscodeWindowTerminalBinding,
  network: LogicalNetwork | undefined,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown("**VS Code Window Terminals**\n\n");
  tooltip.appendMarkdown(`- Network: \`${escapeMarkdown(network?.name ?? binding.networkId)}\`\n`);
  tooltip.appendMarkdown(`- Network ID: \`${escapeMarkdown(binding.networkId)}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${binding.status}\`\n`);
  tooltip.appendMarkdown(`- Open Terminals Updated: \`${binding.injectedTerminalCount}\`\n`);
  tooltip.appendMarkdown(`- Attached: \`${escapeMarkdown(binding.attachedAt)}\`\n`);

  if (binding.errorMessage) {
    tooltip.appendMarkdown(`\nWarning: \`${escapeMarkdown(binding.errorMessage)}\``);
  }

  return tooltip;
}

/** Builds tooltip details for one terminal candidate. */
function buildTerminalTooltip(candidate: TerminalCandidate): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(candidate.name)}**\n\n`);
  tooltip.appendMarkdown(`- PID: \`${candidate.pid}\`\n`);
  tooltip.appendMarkdown(`- Parent PID: \`${candidate.parentPid ?? "n/a"}\`\n`);
  tooltip.appendMarkdown(`- Process Group: \`${candidate.processGroupId ?? "n/a"}\`\n`);
  tooltip.appendMarkdown(`- Terminal: \`${escapeMarkdown(candidate.terminalId ?? "n/a")}\`\n`);
  tooltip.appendMarkdown(`- Window Title: \`${escapeMarkdown(candidate.windowTitle ?? "n/a")}\`\n`);
  tooltip.appendMarkdown(`- Source: \`${candidate.vscodeTerminal ? "VS Code" : "OS"}\`\n`);
  tooltip.appendMarkdown(`- Command: \`${escapeMarkdown(candidate.command ?? "n/a")}\`\n`);

  return tooltip;
}

/** Builds tooltip details for one discovered container or compose service. */
function buildContainerServiceTooltip(candidate: ContainerServiceCandidate): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(formatContainerServiceLabel(candidate))}**\n\n`);
  tooltip.appendMarkdown(`- Runtime: \`${candidate.runtime}\`\n`);
  tooltip.appendMarkdown(`- Container: \`${escapeMarkdown(candidate.containerName)}\`\n`);
  tooltip.appendMarkdown(`- ID: \`${escapeMarkdown(candidate.containerId)}\`\n`);
  tooltip.appendMarkdown(`- Image: \`${escapeMarkdown(candidate.image ?? "n/a")}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${escapeMarkdown(candidate.status ?? "n/a")}\`\n`);

  if (candidate.composeProject || candidate.composeService) {
    const workingDirectory = composeCandidateWorkingDirectory(candidate);
    const composeFiles = composeCandidateSourceFiles(candidate);
    tooltip.appendMarkdown(`- Compose Project: \`${escapeMarkdown(candidate.composeProject ?? "n/a")}\`\n`);
    tooltip.appendMarkdown(`- Compose Service: \`${escapeMarkdown(candidate.composeService ?? "n/a")}\`\n`);
    tooltip.appendMarkdown(`- Original Folder: \`${escapeMarkdown(workingDirectory ?? "n/a")}\`\n`);
    tooltip.appendMarkdown(`- Compose Files: \`${escapeMarkdown(composeFiles?.join(", ") ?? "n/a")}\`\n`);
  }

  for (const port of candidate.ports) {
    tooltip.appendMarkdown(
      `- ${escapeMarkdown(port.serviceName)}: \`${formatComposePort(port)}\``,
    );
    if (port.actualHostPort !== port.logicalPort) {
      tooltip.appendMarkdown(` transport \`${escapeMarkdown(port.actualHostAddress)}:${port.actualHostPort}\``);
    }
    tooltip.appendMarkdown("\n");
  }

  return tooltip;
}

/** Builds tooltip details for one compose project group. */
function buildComposeProjectCandidateTooltip(
  projectName: string,
  runtime: ContainerServiceCandidate["runtime"],
  candidates: readonly ContainerServiceCandidate[],
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  const aggregateCandidate = buildAggregateComposeProjectCandidate(projectName, runtime, candidates);
  const workingDirectory = composeCandidateWorkingDirectory(aggregateCandidate);
  tooltip.appendMarkdown(`**${escapeMarkdown(projectName)}**\n\n`);
  tooltip.appendMarkdown(`- Runtime: \`${runtime}\`\n`);
  tooltip.appendMarkdown(`- Services: \`${candidates.length}\`\n`);
  tooltip.appendMarkdown(`- Published Ports: \`${candidates.reduce((total, candidate) => total + candidate.ports.length, 0)}\`\n`);
  if (workingDirectory !== undefined) {
    tooltip.appendMarkdown(`- Original Folder: \`${escapeMarkdown(workingDirectory)}\`\n`);
  }
  const composeFiles = composeCandidateSourceFiles(aggregateCandidate);
  if (composeFiles !== undefined && composeFiles.length > 0) {
    tooltip.appendMarkdown("- Compose Files:\n");
    for (const composeFile of composeFiles) {
      tooltip.appendMarkdown(`  - \`${escapeMarkdown(composeFile)}\`\n`);
    }
  }

  for (const candidate of candidates) {
    tooltip.appendMarkdown(
      `- ${escapeMarkdown(candidate.composeService ?? candidate.containerName)}: \`${candidate.ports.map(formatComposePort).join(", ")}\`\n`,
    );
  }

  return tooltip;
}

/** Builds tooltip details for one container published port. */
function buildContainerPortTooltip(
  candidate: ContainerServiceCandidate,
  port: ContainerServiceCandidate["ports"][number],
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**Published Port**\n\n`);
  tooltip.appendMarkdown(`- Service: \`${escapeMarkdown(port.serviceName)}\`\n`);
  tooltip.appendMarkdown(`- Container: \`${escapeMarkdown(candidate.containerName)}\`\n`);
  tooltip.appendMarkdown(`- Logical Mapping: \`${formatComposePort(port)}\`\n`);
  tooltip.appendMarkdown(`- Transport: \`${escapeMarkdown(port.actualHostAddress)}:${port.actualHostPort}\`\n`);
  tooltip.appendMarkdown(`- Protocol: \`${port.protocolName ?? port.protocol}\`\n`);

  return tooltip;
}

/** Builds tooltip details for one host port exposure. */
function buildExposureTooltip(
  exposure: HostPortExposure,
  network: LogicalNetwork | undefined,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**Host Exposure**\n\n`);
  tooltip.appendMarkdown(`- Host: \`${escapeMarkdown(exposure.hostAddress)}:${exposure.hostPort}\`\n`);
  tooltip.appendMarkdown(`- Network Target: \`${escapeMarkdown(exposure.targetAddress)}:${exposure.targetPort}\`\n`);
  tooltip.appendMarkdown(`- Network: \`${escapeMarkdown(network?.name ?? exposure.networkId)}\`\n`);
  tooltip.appendMarkdown(`- Protocol: \`${exposure.protocol}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${exposure.status}\`\n`);

  if (exposure.errorMessage) {
    tooltip.appendMarkdown(`\nError: \`${escapeMarkdown(exposure.errorMessage)}\``);
  }

  return tooltip;
}

/** Builds tooltip details for one network-to-host access binding. */
function buildHostAccessBindingTooltip(binding: HostAccessBinding): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**Host Access**\n\n`);
  tooltip.appendMarkdown(`- Network Logical Port: \`${binding.logicalPort}\`\n`);
  tooltip.appendMarkdown(`- Host Target: \`${escapeMarkdown(binding.hostAddress)}:${binding.hostPort}\`\n`);
  tooltip.appendMarkdown(`- Network ID: \`${escapeMarkdown(binding.networkId)}\`\n`);
  tooltip.appendMarkdown(`- Protocol: \`${binding.protocol}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${binding.status}\`\n`);

  if (binding.errorMessage) {
    tooltip.appendMarkdown(`\nError: \`${escapeMarkdown(binding.errorMessage)}\``);
  }

  return tooltip;
}

/** Formats one compose endpoint as logical/public port to compose-internal port. */
function formatComposePort(port: ComposeAttachment["ports"][number]): string {
  const protocol = port.protocolName === undefined ? "" : ` ${port.protocolName}`;
  return `${port.logicalPort}:${port.containerPort}${protocol}`;
}

/** Labels compose services as project/service and raw containers by name. */
function formatContainerServiceLabel(candidate: ContainerServiceCandidate): string {
  if (candidate.composeProject !== undefined && candidate.composeService !== undefined) {
    return `${candidate.composeProject}/${candidate.composeService}`;
  }

  if (candidate.composeProject !== undefined) {
    return candidate.composeProject;
  }

  return candidate.containerName;
}

function formatContainerServiceTreeLabel(candidate: ContainerServiceCandidate): string {
  return candidate.composeService ?? formatContainerServiceLabel(candidate);
}

function buildAggregateComposeProjectCandidate(
  projectName: string,
  runtime: ContainerServiceCandidate["runtime"],
  candidates: readonly ContainerServiceCandidate[],
): ContainerServiceCandidate {
  const composeConfigFiles = uniqueStrings(candidates.flatMap((candidate) => [...(candidate.composeConfigFiles ?? [])]));
  const portManagerClone = mergePortManagerCloneMetadata(candidates);

  return {
    id: buildComposeProjectCandidateId(
      runtime,
      projectName,
      candidates[0]?.composeWorkingDirectory,
      composeConfigFiles,
    ),
    runtime,
    containerId: projectName,
    containerName: projectName,
    composeProject: projectName,
    ...(candidates[0]?.composeWorkingDirectory !== undefined
      ? { composeWorkingDirectory: candidates[0].composeWorkingDirectory }
      : {}),
    ...(composeConfigFiles.length > 0 ? { composeConfigFiles } : {}),
    ...(portManagerClone !== undefined ? { portManagerClone } : {}),
    ports: candidates.flatMap((candidate) => [...candidate.ports]),
  };
}

function formatComposeProjectCandidateDescription(
  candidate: ContainerServiceCandidate,
  serviceCount: number,
  portCount: number,
): string {
  const details = [
    candidate.runtime,
    `${serviceCount} services`,
    `${portCount} port${portCount === 1 ? "" : "s"}`,
  ].filter((item): item is string => item !== undefined && item.length > 0);

  return details.join(", ");
}

function formatContainerServiceCandidateDescription(candidate: ContainerServiceCandidate): string {
  const details = [
    candidate.runtime,
    `${candidate.ports.length} port${candidate.ports.length === 1 ? "" : "s"}`,
  ].filter((item): item is string => item !== undefined && item.length > 0);

  return details.join(", ");
}

function buildComposeProjectCandidateDetailRows(candidate: ContainerServiceCandidate): PortManagerTreeItem[] {
  const rows: PortManagerTreeItem[] = [];
  const workingDirectory = composeCandidateWorkingDirectory(candidate);

  if (workingDirectory !== undefined) {
    rows.push(new ServiceDetailTreeItem(`${candidate.id}:detail:folder`, "Original Folder", workingDirectory, "folder"));
  }

  const composeFilesGroup = buildComposeFilesDetailGroup(
    `${candidate.id}:detail:compose-files`,
    composeCandidateSourceFiles(candidate) ?? [],
  );
  if (composeFilesGroup !== undefined) {
    rows.push(composeFilesGroup);
  }

  return rows;
}

function buildContainerCandidateDetailRows(candidate: ContainerServiceCandidate): PortManagerTreeItem[] {
  const rows: PortManagerTreeItem[] = [
    new ServiceDetailTreeItem(`${candidate.id}:detail:container`, "Container", candidate.containerName, "server-process"),
  ];

  if (candidate.image !== undefined && candidate.image.length > 0) {
    rows.push(new ServiceDetailTreeItem(`${candidate.id}:detail:image`, "Image", candidate.image, "package"));
  }
  if (candidate.status !== undefined && candidate.status.length > 0) {
    rows.push(new ServiceDetailTreeItem(`${candidate.id}:detail:status`, "Status", candidate.status, "pulse"));
  }

  return rows;
}

function composeCandidateWorkingDirectory(candidate: ContainerServiceCandidate): string | undefined {
  return candidate.composeWorkingDirectory ?? composeWorkingDirectoryFromFiles(composeCandidateSourceFiles(candidate) ?? []);
}

function composeCandidateSourceFiles(candidate: ContainerServiceCandidate): readonly string[] | undefined {
  return candidate.portManagerClone?.composeFiles ?? candidate.composeConfigFiles;
}

function buildComposeFilesDetailGroup(
  groupId: string,
  composeFiles: readonly string[],
): ServiceDetailGroupTreeItem | undefined {
  const fileRows = composeFiles
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .map((file, index) => new ServiceDetailTreeItem(`${groupId}:${index}`, "File", file, "file-code"));

  return fileRows.length > 0 ? new ServiceDetailGroupTreeItem(groupId, "Compose Files", fileRows, "files") : undefined;
}

function buildComposeContainerMappingDetailGroup(
  groupId: string,
  mappings: readonly {
    readonly serviceName: string;
    readonly originalContainerName: string;
    readonly attachedContainerName: string;
  }[],
): ServiceDetailGroupTreeItem | undefined {
  const containerRows = mappings.map(
    (mapping, index) =>
      new ServiceDetailTreeItem(
        `${groupId}:${index}`,
        mapping.serviceName.length > 0 ? mapping.serviceName : "Container",
        `${mapping.originalContainerName} -> ${mapping.attachedContainerName}`,
        "server-process",
      ),
  );

  return containerRows.length > 0
    ? new ServiceDetailGroupTreeItem(groupId, "Containers", containerRows, "server-process")
    : undefined;
}

function buildServiceDetailTooltip(label: string, value: string): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(label)}**\n\n`);
  tooltip.appendMarkdown(`\`${escapeMarkdown(value)}\``);
  return tooltip;
}

/** Groups compose service containers under their compose project while keeping raw containers flat. */
function buildContainerServiceTreeItems(
  candidates: readonly ContainerServiceCandidate[],
  availability: ActionAvailability = { enabled: true },
): Array<ComposeProjectCandidateTreeItem | ContainerServiceCandidateTreeItem> {
  const composeGroups = new Map<string, ContainerServiceCandidate[]>();
  const rawCandidates: ContainerServiceCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.composeProject === undefined) {
      rawCandidates.push(candidate);
      continue;
    }

    const key = buildComposeProjectCandidateId(
      candidate.runtime,
      candidate.composeProject,
      candidate.composeWorkingDirectory,
      candidate.composeConfigFiles ?? [],
    );
    composeGroups.set(key, [...(composeGroups.get(key) ?? []), candidate]);
  }

  return [
    ...[...composeGroups.values()].map((group) => {
      const first = group[0]!;
      return new ComposeProjectCandidateTreeItem(first.composeProject!, first.runtime, group, availability);
    }),
    ...rawCandidates.map((candidate) => new ContainerServiceCandidateTreeItem(candidate, availability)),
  ];
}

function buildComposeProjectCandidateId(
  runtime: ContainerServiceCandidate["runtime"],
  projectName: string,
  workingDirectory?: string,
  composeConfigFiles: readonly string[] = [],
): string {
  return `compose-project:${runtime}:${projectName}:${workingDirectory ?? ""}:${composeConfigFiles.join("|")}`;
}

function mergePortManagerCloneMetadata(
  candidates: readonly ContainerServiceCandidate[],
): ContainerServiceCandidate["portManagerClone"] | undefined {
  const metadata = candidates.map((candidate) => candidate.portManagerClone);
  if (metadata.length === 0 || metadata.some((item) => item === undefined)) {
    return undefined;
  }

  const first = metadata[0]!;
  if (
    metadata.some(
      (item) =>
        item!.originalProjectName !== first.originalProjectName ||
        item!.attachedProjectName !== first.attachedProjectName ||
        item!.overrideFile !== first.overrideFile,
    )
  ) {
    return undefined;
  }

  return {
    originalProjectName: first.originalProjectName,
    attachedProjectName: first.attachedProjectName,
    composeFiles: uniqueStrings(metadata.flatMap((item) => [...item!.composeFiles])),
    overrideFile: first.overrideFile,
    originalPorts: metadata.flatMap((item) => [...(item!.originalPorts ?? [])]),
    containerMappings: metadata.flatMap((item) => [...(item!.containerMappings ?? [])]),
  };
}

function formatContainerSectionDescription(candidates: readonly ContainerServiceCandidate[]): string {
  const composeProjectCount = new Set(
    candidates
      .filter((candidate) => candidate.composeProject !== undefined)
      .map((candidate) =>
        buildComposeProjectCandidateId(
          candidate.runtime,
          candidate.composeProject!,
          candidate.composeWorkingDirectory,
          candidate.composeConfigFiles ?? [],
        ),
      ),
  ).size;
  const rawContainerCount = candidates.filter((candidate) => candidate.composeProject === undefined).length;
  return candidates.length === 0 ? "No services" : formatSidebarCounts([
    { count: composeProjectCount, singular: "compose project" },
    { count: rawContainerCount, singular: "container" },
  ]);
}

/** Builds tooltip details for one runtime adapter. */
function buildRuntimeTooltip(runtime: NetworkRuntimeDescriptor): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(runtime.name)}**\n\n`);
  tooltip.appendMarkdown(`- Kind: \`${runtime.kind}\`\n`);
  tooltip.appendMarkdown(`- Same Internal Ports: \`${runtime.capabilities.supportsSameInternalPorts}\`\n`);
  tooltip.appendMarkdown(`- Terminal Attach: \`${runtime.capabilities.supportsTerminalAttach}\`\n`);
  tooltip.appendMarkdown(`- Host Exposure: \`${runtime.capabilities.supportsHostExposure}\`\n`);
  tooltip.appendMarkdown(`- Privileged Helper: \`${runtime.capabilities.requiresPrivilegedHelper}\`\n`);
  tooltip.appendMarkdown(`- Container Runtime: \`${runtime.capabilities.requiresContainerRuntime}\`\n`);

  if (!isContainerLevelRuntime(runtime)) {
    tooltip.appendMarkdown(
      "\nWarning: this runtime cannot attach terminals as logical networks.",
    );
  }

  return tooltip;
}

/** True only for runtimes that can keep internal ports off the host namespace. */
function isContainerLevelRuntime(runtime: NetworkRuntimeDescriptor): boolean {
  return runtime.capabilities.supportsSameInternalPorts && runtime.capabilities.supportsTerminalAttach;
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
    case "compose":
      return "compose";
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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
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

function isLogicalNetwork(value: unknown): value is LogicalNetwork {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<LogicalNetwork>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.runtimeKind === "string"
  );
}

function isTerminalCandidate(value: unknown): value is TerminalCandidate {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TerminalCandidate>;
  return (
    typeof candidate.pid === "number" &&
    typeof candidate.name === "string" &&
    typeof candidate.vscodeTerminal === "boolean"
  );
}

function isTerminalWindow(value: unknown): value is TerminalWindow {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TerminalWindow>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.rootPid === "number" &&
    typeof candidate.candidateCount === "number"
  );
}

function isContainerServiceCandidate(value: unknown): value is ContainerServiceCandidate {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ContainerServiceCandidate>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.runtime === "string" &&
    typeof candidate.containerId === "string" &&
    typeof candidate.containerName === "string" &&
    Array.isArray(candidate.ports)
  );
}

function isAttachContainerInput(value: unknown): value is { readonly containerService: ContainerServiceCandidate } {
  if (typeof value !== "object" || value === null || !("containerService" in value)) {
    return false;
  }

  return isContainerServiceCandidate((value as { readonly containerService?: unknown }).containerService);
}

function isHostPortExposure(value: unknown): value is HostPortExposure {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<HostPortExposure>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.networkId === "string" &&
    typeof candidate.hostAddress === "string" &&
    typeof candidate.hostPort === "number" &&
    typeof candidate.targetAddress === "string" &&
    typeof candidate.targetPort === "number"
  );
}

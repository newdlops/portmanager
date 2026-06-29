import * as vscode from "vscode";
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

type TreeSectionKind = "current" | "networks" | "containers" | "daemon";
type NetworkActionGroupKind = "quick" | "advanced";
const TERMINAL_WINDOW_MIME = "application/vnd.newdlops.portmanager.terminal-window";
const TREE_REFRESH_DEBOUNCE_MS = 50;

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
  /** False removes the command from the tree row so non-owner windows cannot invoke owner work. */
  readonly enabled: boolean;
  /** Short reason appended to disabled action rows. */
  readonly disabledReason?: string;
}

type PortManagerTreeItem =
  | TreeSectionItem
  | NetworkRoutingGroupTreeItem
  | NetworkRouteConnectionTreeItem
  | RoutingTimelineGroupTreeItem
  | RoutingTimelineTreeItem
  | NetworkActionGroupTreeItem
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

  constructor(private readonly source: PortManagerNetworkTreeSource) {
    this.sourceSubscription = this.source.onDidChange(() => this.refresh());
  }

  /** Triggers a full tree refresh after process state changes or manual refresh. */
  refresh(): void {
    if (this.refreshTimer !== undefined) {
      return;
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.onDidChangeTreeDataEmitter.fire(undefined);
    }, TREE_REFRESH_DEBOUNCE_MS);
    this.refreshTimer.unref();
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
   * Converts the daemon snapshot into grouped tree rows. VS Code tree groups
   * now act as accordions for the logical network model. Legacy daemon,
   * route, managed-process, and listener rows remain implemented below for
   * compatibility, but they are intentionally not surfaced from the root.
   */
  getChildren(element?: PortManagerTreeItem): PortManagerTreeItem[] {
    const snapshot = this.source.getSnapshot();
    const agentSnapshot = this.source.getAgentSnapshot();
    const daemon = this.source.getDaemonStatus();
    const browserDns = this.source.getBrowserDnsResolverStatus();
    const ownerAction = buildOwnerActionAvailability(snapshot.controlPlane);

    if (element === undefined) {
      return [
        new TreeSectionItem("current", "Current Routing", formatCurrentRoutingSummary(snapshot, agentSnapshot), "target"),
        new TreeSectionItem("networks", "Logical Networks", `${snapshot.networks.length} networks`, "vm"),
        new TreeSectionItem(
          "containers",
          "Discovered Services",
          formatContainerSectionDescription(snapshot.containerServiceCandidates),
          "server-environment",
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
        new TreeSectionItem(
          "daemon",
          "Diagnostics",
          formatDiagnosticsSummary(daemon, snapshot),
          daemon.restartRequired ? "warning" : "pulse",
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
      ];
    }

    if (element instanceof LogicalNetworkTreeItem) {
      const attachments = snapshot.attachments.filter((attachment) => attachment.networkId === element.network.id);
      const exposures = snapshot.exposures.filter((exposure) => exposure.networkId === element.network.id);
      const hostAccessBindings = snapshot.hostAccessBindings.filter((binding) => binding.networkId === element.network.id);
      const composeAttachments = snapshot.composeAttachments.filter((attachment) => attachment.networkId === element.network.id);
      const windowTerminalBinding = snapshot.vscodeWindowTerminalBinding?.networkId === element.network.id
        ? snapshot.vscodeWindowTerminalBinding
        : undefined;
      const routeRows = buildNetworkRouteConnectionRows(element.network.id, snapshot, agentSnapshot);
      const stateRows = [
        ...(routeRows.length > 0
          ? [
              new NetworkRoutingGroupTreeItem(
                element.network,
                "Routes",
                formatNetworkRouteGroupDescription(routeRows, attachments, windowTerminalBinding),
                routeRows,
                "network",
              ),
            ]
          : []),
        ...(windowTerminalBinding !== undefined
          ? [new VscodeWindowTerminalBindingTreeItem(windowTerminalBinding, element.network, ownerAction)]
          : []),
        ...attachments.map((attachment) => new TerminalAttachmentTreeItem(attachment)),
        ...composeAttachments.map((attachment) => new ComposeAttachmentTreeItem(attachment)),
        ...exposures.map((exposure) => new HostPortExposureTreeItem(exposure, [element.network])),
        ...hostAccessBindings.map((binding) => new HostAccessBindingTreeItem(binding)),
      ];

      return [
        ...(stateRows.length > 0 ? stateRows : [new EmptyTreeItem("No bindings or terminal windows", "Use Quick Actions")]),
        new NetworkActionGroupTreeItem(element.network, "quick", "Quick Actions", "Attach terminals and services", "zap"),
        new NetworkActionGroupTreeItem(element.network, "advanced", "Advanced", "Bindings, presets, cache", "tools"),
      ];
    }

    if (element instanceof NetworkActionGroupTreeItem) {
      if (element.kind === "quick") {
        return [
          new ActionTreeItem(
            "Attach Active Terminal",
            "portManager.attachActiveTerminalToNetwork",
            "terminal",
            "Use current VS Code terminal",
            element.network,
            ownerAction,
          ),
          new ActionTreeItem(
            "Attach Terminal",
            "portManager.attachTerminalToNetwork",
            "terminal",
            "Choose a terminal window",
            element.network,
            ownerAction,
          ),
          new ActionTreeItem(
            "Use for VS Code Terminals",
            "portManager.attachVscodeWindowTerminalsToNetwork",
            "terminal",
            "Make this window default",
            element.network,
            ownerAction,
          ),
          new ActionTreeItem(
            "Attach Service",
            "portManager.attachContainerToNetwork",
            "server-environment",
            "Choose a discovered service",
            { network: element.network },
            ownerAction,
          ),
          new ActionTreeItem(
            "Copy Terminal Script",
            "portManager.copyTerminalRoutingScript",
            "copy",
            "For external terminal UIs",
            element.network,
            ownerAction,
          ),
        ];
      }

      const networkAttachments = snapshot.attachments.filter((attachment) => attachment.networkId === element.network.id);
      const networkComposeAttachments = snapshot.composeAttachments.filter(
        (attachment) => attachment.networkId === element.network.id,
      );
      return [
        new ActionTreeItem(
          "Add Host Binding",
          "portManager.addHostPortExposure",
          "add",
          "Expose network port",
          element.network,
          ownerAction,
        ),
        new ActionTreeItem(
          "Add Host Access",
          "portManager.addHostAccessBinding",
          "arrow-swap",
          "Reach host port from network",
          element.network,
          ownerAction,
        ),
        new ActionTreeItem(
          "Add Compose Port",
          "portManager.addComposePublishedPort",
          "database",
          "Manually attach published service",
          element.network,
          ownerAction,
        ),
        ...(networkComposeAttachments.length > 0
          ? [
              new ActionTreeItem(
                "Copy Compose Attachment",
                "portManager.copyComposeAttachment",
                "copy",
                "Duplicate existing attachment",
                element.network,
                ownerAction,
              ),
            ]
          : []),
        new ActionTreeItem(
          "Attach Process",
          "portManager.attachProcessToNetwork",
          "debug-alt",
          "Attach existing backend PID",
          element.network,
          ownerAction,
        ),
        new ActionTreeItem(
          "Save Binding Preset",
          "portManager.saveBindingPreset",
          "save",
          "Save current bindings",
          element.network,
          ownerAction,
        ),
        new ActionTreeItem(
          "Apply Binding Preset",
          "portManager.applyBindingPreset",
          "cloud-download",
          "Load saved bindings",
          element.network,
          ownerAction,
        ),
        new ActionTreeItem(
          "Clear Network Cache",
          "portManager.clearNetworkCache",
          "clear-all",
          "Remove generated route maps",
          element.network,
          ownerAction,
        ),
        ...(networkAttachments.length > 0
          ? [new ActionTreeItem("Detach Terminal", "portManager.detachTerminalFromNetwork", "debug-disconnect", undefined, undefined, ownerAction)]
          : []),
      ];
    }

    if (element instanceof NetworkRoutingGroupTreeItem) {
      return element.routeRows.length > 0
        ? element.routeRows.map((route) => new NetworkRouteConnectionTreeItem(route))
        : [new EmptyTreeItem("No active routes", "Start or attach a service")];
    }

    if (element instanceof RoutingTimelineGroupTreeItem) {
      return element.rows.length > 0
        ? element.rows.map((row) => new RoutingTimelineTreeItem(row))
        : [new EmptyTreeItem("No recent routing activity", "Attach a terminal or service")];
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
      case "current":
        return buildCurrentRoutingGroupItems(snapshot, agentSnapshot);
      case "networks":
        return [
          ...(snapshot.networks.length > 0
            ? snapshot.networks.map((network) =>
                new LogicalNetworkTreeItem(
                  network,
                  snapshot.attachments,
                  snapshot.exposures,
                  snapshot.hostAccessBindings,
                  snapshot.composeAttachments,
                  buildNetworkRouteConnectionRows(network.id, snapshot, agentSnapshot).length,
                  snapshot.vscodeWindowTerminalBinding?.networkId === network.id,
                ),
              )
            : [new EmptyTreeItem("No logical networks", "Create one from the toolbar")]),
        ];
      case "containers":
        return [
          ...(snapshot.containerServiceCandidates.length > 0
            ? buildContainerServiceTreeItems(snapshot.containerServiceCandidates, ownerAction)
            : [new EmptyTreeItem("No published services", "Start compose services")]),
        ];
      case "daemon":
        return [
          ...(snapshot.vscodeWindowTerminalBinding !== undefined
            ? [
                new VscodeWindowTerminalBindingTreeItem(
                  snapshot.vscodeWindowTerminalBinding,
                  snapshot.networks.find((network) => network.id === snapshot.vscodeWindowTerminalBinding?.networkId),
                  ownerAction,
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
          ...buildDaemonChildren(daemon, snapshot, agentSnapshot, browserDns, ownerAction),
        ];
    }
  }

  /** Releases VS Code and registry event resources during deactivation. */
  dispose(): void {
    this.sourceSubscription.dispose();
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

/** One clickable command row in the Actions accordion. */
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
    this.description = availability.enabled
      ? description
      : [description, availability.disabledReason ?? "Owner window only"].filter(Boolean).join(" - ");
    this.iconPath = new vscode.ThemeIcon(
      availability.enabled ? icon : "circle-slash",
      availability.enabled ? undefined : new vscode.ThemeColor("disabledForeground"),
    );

    if (availability.enabled) {
      this.command = {
        command,
        title: label,
        arguments: argument === undefined ? [] : [argument],
      };
    }
  }
}

/** Collapsible route status group for the root current view and each network. */
class NetworkRoutingGroupTreeItem extends vscode.TreeItem {
  readonly contextValue = "networkRoutingGroup";

  constructor(
    readonly network: Pick<LogicalNetwork, "id" | "name">,
    label: string,
    description: string,
    readonly routeRows: readonly NetworkRouteConnection[],
    idPrefix: string,
    icon: string = "references",
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `${idPrefix}:routes:${network.id}`;
    this.description = description;
    this.tooltip = buildNetworkRoutingGroupTooltip(network, description, routeRows);
    this.iconPath = new vscode.ThemeIcon(icon);
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

/** Collapsible recent routing event group shown in Diagnostics. */
class RoutingTimelineGroupTreeItem extends vscode.TreeItem {
  readonly contextValue = "routingTimelineGroup";

  constructor(readonly rows: readonly RoutingTimelineEntry[]) {
    super("Recent Routing Activity", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = "routing-timeline";
    this.description =
      rows.length > 0
        ? `${rows.length} recent change${rows.length === 1 ? "" : "s"}`
        : "no recent changes";
    this.iconPath = new vscode.ThemeIcon("history");
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

/** Collapsible action group nested under a logical network. */
class NetworkActionGroupTreeItem extends vscode.TreeItem {
  readonly contextValue = "networkActionGroup";

  constructor(
    readonly network: LogicalNetwork,
    readonly kind: NetworkActionGroupKind,
    label: string,
    description: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `network-action:${network.id}:${kind}`;
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Collapsible root row used as a VS Code tree accordion section. */
class TreeSectionItem extends vscode.TreeItem {
  constructor(
    readonly kind: TreeSectionKind,
    label: string,
    description: string,
    icon: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded,
  ) {
    super(label, collapsibleState);
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

/** Logical Network row backed by real service state. */
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
    super(
      network.name,
      attachmentCount > 0 || exposureCount > 0 || hostAccessCount > 0 || composeCount > 0 || routeCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
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
    this.iconPath = new vscode.ThemeIcon(
      network.status === "running" ? "vm-active" : "vm-outline",
      network.status === "error" ? new vscode.ThemeColor("testing.iconFailed") : undefined,
    );
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
    this.description = availability.enabled
      ? formatComposeProjectCandidateDescription(this.aggregateCandidate, candidates.length, ports.length)
      : `${formatComposeProjectCandidateDescription(this.aggregateCandidate, candidates.length, ports.length)} - ${availability.disabledReason ?? "Owner window only"}`;
    this.tooltip = buildComposeProjectCandidateTooltip(projectName, runtime, candidates);
    this.iconPath = new vscode.ThemeIcon(
      availability.enabled ? "server-environment" : "circle-slash",
      availability.enabled ? undefined : new vscode.ThemeColor("disabledForeground"),
    );
    if (availability.enabled) {
      this.command = {
        command: "portManager.attachContainerToNetwork",
        title: "Attach Compose Project to Network",
        arguments: [{ containerService: this.aggregateCandidate }],
      };
    }
  }
}

/** Docker/Podman container or compose service with host-published ports. */
export class ContainerServiceCandidateTreeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(readonly candidate: ContainerServiceCandidate, availability: ActionAvailability = { enabled: true }) {
    super(formatContainerServiceTreeLabel(candidate), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = candidate.id;
    this.contextValue = availability.enabled ? "containerServiceCandidate" : "containerServiceCandidate.disabled";
    this.description = availability.enabled
      ? formatContainerServiceCandidateDescription(candidate)
      : `${formatContainerServiceCandidateDescription(candidate)} - ${availability.disabledReason ?? "Owner window only"}`;
    this.tooltip = buildContainerServiceTooltip(candidate);
    this.iconPath = new vscode.ThemeIcon(
      availability.enabled ? (candidate.composeProject ? "server-environment" : "server-process") : "circle-slash",
      availability.enabled ? undefined : new vscode.ThemeColor("disabledForeground"),
    );
    if (availability.enabled) {
      this.command = {
        command: "portManager.attachContainerToNetwork",
        title: "Attach Service to Network",
        arguments: [{ containerService: candidate }],
      };
    }
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
    this.description = `${attachment.mode ?? "isolated"} ${attachment.status}`;
    this.tooltip = buildTerminalAttachmentTooltip(attachment);
    this.iconPath = new vscode.ThemeIcon(
      attachment.mode === "logical" ? "warning" : "plug",
      attachment.mode === "logical" ? new vscode.ThemeColor("charts.yellow") : undefined,
    );
    this.command = {
      command: "portManager.revealTerminalWindow",
      title: "Reveal Terminal",
      arguments: [attachment],
    };
  }
}

/** Current VS Code window-wide terminal network default. */
export class VscodeWindowTerminalBindingTreeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(
    readonly binding: VscodeWindowTerminalBinding,
    network: LogicalNetwork | undefined,
    availability: ActionAvailability = { enabled: true },
  ) {
    super("VS Code Window Terminals", vscode.TreeItemCollapsibleState.None);
    this.id = binding.id;
    this.contextValue = availability.enabled ? "vscodeWindowTerminalBinding" : "vscodeWindowTerminalBinding.disabled";
    this.description = availability.enabled
      ? (network?.name ?? binding.networkId)
      : `${network?.name ?? binding.networkId} - ${availability.disabledReason ?? "Owner window only"}`;
    this.tooltip = buildVscodeWindowTerminalBindingTooltip(binding, network);
    this.iconPath = new vscode.ThemeIcon(
      availability.enabled ? (binding.status === "attached" ? "terminal" : "warning") : "circle-slash",
      availability.enabled
        ? binding.status === "error"
          ? new vscode.ThemeColor("testing.iconFailed")
          : undefined
        : new vscode.ThemeColor("disabledForeground"),
    );
    if (availability.enabled) {
      this.command = {
        command: "portManager.detachVscodeWindowTerminalsFromNetwork",
        title: "Detach VS Code Window Terminals",
      };
    }
  }
}

/** Host exposure row backed by an active or failed local listener/proxy. */
export class HostPortExposureTreeItem extends vscode.TreeItem {
  readonly contextValue: string;

  constructor(
    readonly exposure: HostPortExposure,
    networks: readonly LogicalNetwork[],
  ) {
    super(`${exposure.hostAddress}:${exposure.hostPort}`, vscode.TreeItemCollapsibleState.None);
    const network = networks.find((item) => item.id === exposure.networkId);
    this.id = exposure.id;
    this.contextValue = exposure.status === "active" ? "hostExposureActive" : "hostExposure";
    this.description = `${network?.name ?? exposure.networkId} -> logical ${exposure.targetPort}`;
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
    super(`network:${binding.logicalPort}`, vscode.TreeItemCollapsibleState.None);
    this.id = binding.id;
    this.description = `host ${binding.hostAddress}:${binding.hostPort}`;
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
    new ActionTreeItem("Install Shell Hook", "portManager.installShellHook", "plug", undefined, undefined, ownerAction),
    new ActionTreeItem("Install External CLI", "portManager.installExternalCli", "terminal", undefined, undefined, ownerAction),
    new ActionTreeItem("Stop All Processes", "portManager.stopAllProcesses", "debug-stop", undefined, undefined, ownerAction),
    new ActionTreeItem("Open Settings", "portManager.openSettings", "settings-gear"),
  ];
}

/** Static daemon detail row. */
class DaemonStatusTreeItem extends vscode.TreeItem {
  readonly contextValue = "daemonStatus";

  constructor(label: string, description: string, icon: string = "info", tooltip?: vscode.MarkdownString) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip;
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
function buildDaemonChildren(
  daemon: AgentDaemonStatus,
  snapshot: NetworkSnapshot,
  agentSnapshot: AgentSnapshot,
  browserDns: BrowserDnsResolverStatus,
  ownerAction: ActionAvailability,
): PortManagerTreeItem[] {
  const children: PortManagerTreeItem[] = [
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
    new RoutingTimelineGroupTreeItem(buildRoutingTimelineRows(snapshot, agentSnapshot)),
    ...buildBrowserDnsDiagnosticRows(browserDns, ownerAction),
    new DaemonStatusTreeItem(
      "Control Owner",
      formatControlPlaneRoleDescription(snapshot.controlPlane),
      snapshot.controlPlane?.role === "owner" ? "workspace-trusted" : "workspace-untrusted",
      buildControlPlaneTooltip(snapshot.controlPlane),
    ),
    new DaemonStatusTreeItem("This Window PID", String(snapshot.controlPlane?.currentPid ?? process.pid), "window"),
    new DaemonStatusTreeItem("Status", daemon.status, daemon.status === "running" ? "pass" : "warning"),
    new DaemonStatusTreeItem(
      "Version",
      daemon.versionStatus ?? "unknown",
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
    children.push(new DaemonStatusTreeItem("Warning", daemon.errorMessage, "warning"));
  }

  return children;
}

function buildControlPlaneTooltip(controlPlane: ControlPlaneStatus | undefined): vscode.MarkdownString {
  const lines = [
    `Role: ${controlPlane?.role ?? "unknown"}`,
    `This window PID: ${controlPlane?.currentPid ?? process.pid}`,
    `Owner PID: ${controlPlane?.ownerPid ?? "n/a"}`,
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

  const description =
    browserDns.records.length === 0
      ? "no aliases"
      : `${browserDns.installedCount}/${browserDns.records.length} installed`;
  const icon = browserDns.missingCount === 0 ? "globe" : "warning";

  return [
    new DaemonStatusTreeItem("Browser DNS", `${description}, port ${browserDns.dnsPort}`, icon),
    ...browserDns.records.flatMap((record) => buildBrowserDnsRecordRows(record)),
    new ActionTreeItem(
      "Install Browser DNS",
      "portManager.installBrowserDnsResolvers",
      "cloud-upload",
      "Create aliases",
      undefined,
      ownerAction,
    ),
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

function buildBrowserDnsRecordRows(record: BrowserDnsResolverStatus["records"][number]): PortManagerTreeItem[] {
  const resolverStatus = record.resolverConfigured ? "resolver ok" : "missing resolver";
  const aliasStatus = record.loopbackAliasConfigured ? "loopback ok" : "missing loopback";
  const configured = record.configured ? "configured" : `${resolverStatus}, ${aliasStatus}`;
  const aliasTooltip = new vscode.MarkdownString(
    [
      `Network: ${record.networkName}`,
      `Alias: ${record.hostname}`,
      `Loopback: ${record.address}`,
      `Resolver: ${resolverStatus}`,
      `Loopback alias: ${aliasStatus}`,
    ].join("\n\n"),
  );
  const rows: PortManagerTreeItem[] = [
    new DaemonStatusTreeItem(
      `DNS ${record.hostname}`,
      `${record.address}, ${configured}`,
      record.configured ? "globe" : "warning",
      aliasTooltip,
    ),
  ];

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
        label: "Daemon route table refreshed",
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

function isControlPlaneOwner(controlPlane: ControlPlaneStatus | undefined): boolean {
  return controlPlane?.role === "owner";
}

function buildOwnerActionAvailability(controlPlane: ControlPlaneStatus | undefined): ActionAvailability {
  return isControlPlaneOwner(controlPlane)
    ? { enabled: true }
    : { enabled: false, disabledReason: formatOwnerOnlyActionReason(controlPlane) };
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

/** One-line compact summary for the collapsed diagnostics section. */
function formatDiagnosticsSummary(daemon: AgentDaemonStatus, snapshot: NetworkSnapshot): string {
  const daemonSummary = daemon.restartRequired ? "daemon stale" : daemon.status;
  return `${formatControlPlaneRoleDescription(snapshot.controlPlane)}, ${daemonSummary}, ${snapshot.terminalWindows.length} terminals, ${snapshot.runtimes.length} runtimes`;
}

/** One-line current routing summary for the root section. */
function formatCurrentRoutingSummary(snapshot: NetworkSnapshot, agentSnapshot: AgentSnapshot): string {
  const currentNetwork = snapshot.networks.find((network) => network.id === snapshot.vscodeWindowTerminalBinding?.networkId);
  const attachedTerminalCount = snapshot.attachments.filter((attachment) => attachment.status === "attached").length;
  const routeCount = countAllNetworkRouteConnections(snapshot, agentSnapshot);

  if (currentNetwork !== undefined) {
    return `VS Code -> ${currentNetwork.name}, ${routeCount} routes`;
  }

  if (attachedTerminalCount > 0) {
    return `${attachedTerminalCount} terminals, ${routeCount} routes`;
  }

  return routeCount > 0 ? `${routeCount} routes, no VS Code default` : "no current network";
}

/** Builds the root current-routing groups, including stale route scopes. */
function buildCurrentRoutingGroupItems(snapshot: NetworkSnapshot, agentSnapshot: AgentSnapshot): PortManagerTreeItem[] {
  const networkIds = collectRoutingNetworkIds(snapshot, agentSnapshot);

  const knownNetworks = snapshot.networks.filter((network) => networkIds.has(network.id));
  const knownNetworkIds = new Set(knownNetworks.map((network) => network.id));
  const staleNetworkScopes = [...networkIds]
    .filter((networkId) => !knownNetworkIds.has(networkId))
    .map((networkId) => ({ id: networkId, name: `Unknown Network ${networkId.slice(0, 8)}` }));
  const groups = [...knownNetworks, ...staleNetworkScopes].map((network) => {
    const routeRows = buildNetworkRouteConnectionRows(network.id, snapshot, agentSnapshot);
    const attachments = snapshot.attachments.filter((attachment) => attachment.networkId === network.id);
    const binding = snapshot.vscodeWindowTerminalBinding?.networkId === network.id
      ? snapshot.vscodeWindowTerminalBinding
      : undefined;
    const description = formatNetworkRouteGroupDescription(routeRows, attachments, binding);

    return new NetworkRoutingGroupTreeItem(network, network.name, description, routeRows, "current", "target");
  });

  return groups.length > 0 ? groups : [new EmptyTreeItem("No current network", "Attach a terminal or choose VS Code default")];
}

/** Counts all displayed network-scoped route connections. */
function countAllNetworkRouteConnections(snapshot: NetworkSnapshot, agentSnapshot: AgentSnapshot): number {
  return [...collectRoutingNetworkIds(snapshot, agentSnapshot)].reduce(
    (total, networkId) => total + buildNetworkRouteConnectionRows(networkId, snapshot, agentSnapshot).length,
    0,
  );
}

/** Collects every known or stale network id that can affect current routing. */
function collectRoutingNetworkIds(snapshot: NetworkSnapshot, agentSnapshot: AgentSnapshot): Set<string> {
  const networkIds = new Set<string>();

  for (const network of snapshot.networks) {
    networkIds.add(network.id);
  }

  if (snapshot.vscodeWindowTerminalBinding !== undefined) {
    networkIds.add(snapshot.vscodeWindowTerminalBinding.networkId);
  }

  for (const attachment of snapshot.attachments) {
    if (attachment.status === "attached") {
      networkIds.add(attachment.networkId);
    }
  }

  for (const route of agentSnapshot.routes) {
    if (route.networkId !== undefined) {
      networkIds.add(route.networkId);
    }
  }

  for (const binding of snapshot.hostAccessBindings) {
    networkIds.add(binding.networkId);
  }

  for (const exposure of snapshot.exposures) {
    networkIds.add(exposure.networkId);
  }

  for (const attachment of snapshot.composeAttachments) {
    networkIds.add(attachment.networkId);
  }

  return networkIds;
}

/** Describes a route group using current context before raw route count. */
function formatNetworkRouteGroupDescription(
  routeRows: readonly NetworkRouteConnection[],
  attachments: readonly TerminalAttachment[],
  binding: VscodeWindowTerminalBinding | undefined,
): string {
  const details = [
    binding !== undefined ? "VS Code default" : undefined,
    attachments.filter((attachment) => attachment.status === "attached").length > 0
      ? `${attachments.filter((attachment) => attachment.status === "attached").length} terminals`
      : undefined,
    `${routeRows.length} route${routeRows.length === 1 ? "" : "s"}`,
  ].filter((item): item is string => item !== undefined);

  return details.join(", ");
}

/** Normalizes every route source for one network into display rows. */
function buildNetworkRouteConnectionRows(
  networkId: string,
  snapshot: NetworkSnapshot,
  agentSnapshot: AgentSnapshot,
): readonly NetworkRouteConnection[] {
  const daemonRoutes = agentSnapshot.routes.filter((route) => route.networkId === networkId);
  const daemonProcessIds = new Set(
    daemonRoutes.map((route) => route.processId).filter((processId): processId is string => processId !== undefined),
  );
  const rows: NetworkRouteConnection[] = daemonRoutes.map(buildDaemonRouteConnection);

  for (const attachment of snapshot.composeAttachments.filter((item) => item.networkId === networkId)) {
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

  for (const binding of snapshot.hostAccessBindings.filter((item) => item.networkId === networkId)) {
    rows.push(buildHostAccessRouteConnection(binding));
  }

  for (const exposure of snapshot.exposures.filter((item) => item.networkId === networkId)) {
    rows.push(buildHostExposureRouteConnection(exposure));
  }

  return rows.sort((left, right) => left.logicalPort - right.logicalPort || left.label.localeCompare(right.label));
}

function buildDaemonRouteConnection(route: LogicalPortRoute): NetworkRouteConnection {
  const owner = route.processName ?? route.source;
  const direction = route.routeDirection === "send" ? "sender" : "listener";

  return {
    id: `route:${route.networkId ?? "global"}:daemon:${route.logicalPort}:${route.actualPort}:${route.processId ?? route.source}:${route.routeDirection ?? "listen"}`,
    label: `${route.logicalPort} -> ${route.host}:${route.actualPort}`,
    description: `${direction}, ${owner}, ${route.status}`,
    logicalPort: route.logicalPort,
    kind: "daemon",
    tooltip: buildRouteTooltip(route),
    icon: route.source === "compose" ? "server-environment" : "symbol-interface",
    ...(route.status === "error" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
  };
}

function buildComposeRouteConnection(
  attachment: ComposeAttachment,
  port: ComposePublishedPort,
): NetworkRouteConnection {
  return {
    id: `route:${attachment.networkId}:compose:${attachment.id}:${port.serviceName}:${port.logicalPort}:${port.actualHostPort}`,
    label: `${port.logicalPort} -> ${port.actualHostAddress}:${port.actualHostPort}`,
    description: `${attachment.projectName}/${port.serviceName}, compose ${attachment.status}`,
    logicalPort: port.logicalPort,
    kind: "compose",
    tooltip: buildComposeRouteTooltip(attachment, port),
    icon: "server-environment",
    ...(attachment.status === "error" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
  };
}

function buildHostAccessRouteConnection(binding: HostAccessBinding): NetworkRouteConnection {
  return {
    id: `route:${binding.networkId}:host-access:${binding.id}`,
    label: `${binding.logicalPort} -> ${binding.hostAddress}:${binding.hostPort}`,
    description: `host access, ${binding.status}`,
    logicalPort: binding.logicalPort,
    kind: "hostAccess",
    tooltip: buildHostAccessBindingTooltip(binding),
    icon: "arrow-swap",
    ...(binding.status === "error" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
  };
}

function buildHostExposureRouteConnection(exposure: HostPortExposure): NetworkRouteConnection {
  return {
    id: `route:${exposure.networkId}:host-exposure:${exposure.id}`,
    label: `${exposure.hostAddress}:${exposure.hostPort} -> network:${exposure.targetPort}`,
    description: `host exposure, ${exposure.status}`,
    logicalPort: exposure.targetPort,
    kind: "hostExposure",
    tooltip: buildExposureTooltip(exposure, undefined),
    icon: "link-external",
    ...(exposure.status === "error" ? { color: new vscode.ThemeColor("testing.iconFailed") } : {}),
  };
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

  return undefined;
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

function buildNetworkDescription(
  network: LogicalNetwork,
  attachmentCount: number,
  exposureCount: number,
  hostAccessCount: number,
  composeCount: number,
  routeCount: number,
  isCurrentWindowNetwork: boolean,
): string {
  const details = [
    isCurrentWindowNetwork ? "current" : undefined,
    routeCount > 0 ? `${routeCount} routes` : undefined,
    attachmentCount > 0 ? `${attachmentCount} terminals` : undefined,
    exposureCount > 0 ? `${exposureCount} bindings` : undefined,
    hostAccessCount > 0 ? `${hostAccessCount} host access` : undefined,
    composeCount > 0 ? `${composeCount} compose` : undefined,
  ].filter((item): item is string => item !== undefined);

  return `${network.runtimeKind} ${network.status}${details.length > 0 ? `, ${details.join(", ")}` : ""}`;
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
  const details = [
    attachment.status,
    attachment.mutation?.originalProjectName,
    `${attachment.ports.length} port${attachment.ports.length === 1 ? "" : "s"}`,
  ].filter((item): item is string => item !== undefined && item.length > 0);

  return details.join(" | ");
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
  const details = [
    composeProjectCount > 0 ? `${composeProjectCount} compose` : undefined,
    rawContainerCount > 0 ? `${rawContainerCount} containers` : undefined,
  ].filter((item): item is string => item !== undefined);

  return details.length === 0 ? "0 services" : details.join(", ");
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

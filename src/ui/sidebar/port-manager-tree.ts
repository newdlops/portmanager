import * as vscode from "vscode";
import type {
  AgentDaemonStatus,
  AgentSnapshot,
  ComposeAttachment,
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
  /** Notifies the tree when networks, terminals, or exposures change. */
  onDidChange(listener: () => void): DisposableLike;
}

type TreeSectionKind = "networks" | "terminals" | "containers" | "exposures" | "runtime" | "daemon";
const TERMINAL_WINDOW_MIME = "application/vnd.newdlops.portmanager.terminal-window";

type PortManagerTreeItem =
  | TreeSectionItem
  | ActionTreeItem
  | PlannedFeatureTreeItem
  | LogicalNetworkTreeItem
  | TerminalWindowTreeItem
  | TerminalCandidateTreeItem
  | ComposeProjectCandidateTreeItem
  | ContainerServiceCandidateTreeItem
  | ContainerPublishedPortTreeItem
  | VscodeWindowTerminalBindingTreeItem
  | TerminalAttachmentTreeItem
  | ComposeAttachmentTreeItem
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

  constructor(private readonly source: PortManagerNetworkTreeSource) {
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
    const daemon = this.source.getDaemonStatus();

    if (element === undefined) {
      return [
        new TreeSectionItem("networks", "Logical Networks", `${snapshot.networks.length} networks`, "vm"),
        new TreeSectionItem(
          "terminals",
          "Terminal Windows",
          formatTerminalSectionDescription(snapshot.terminalWindows, snapshot.vscodeWindowTerminalBinding, snapshot.networks),
          "terminal",
        ),
        new TreeSectionItem(
          "containers",
          "Compose / Containers",
          formatContainerSectionDescription(snapshot.containerServiceCandidates),
          "server-environment",
        ),
        new TreeSectionItem("exposures", "Host Port Exposures", `${snapshot.exposures.length} bindings`, "ports-view-icon"),
        new TreeSectionItem("runtime", "Runtime Adapter", `${snapshot.runtimes.length} available`, "circuit-board"),
        new TreeSectionItem("daemon", "Daemon", formatDaemonSummary(daemon), daemon.restartRequired ? "warning" : "server-process"),
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
      return [
        new ActionTreeItem("Add Host Binding", "portManager.addHostPortExposure", "add", "Expose network port", element.network),
        new ActionTreeItem(
          "Add Host Access",
          "portManager.addHostAccessBinding",
          "arrow-swap",
          "Reach host port from network",
          element.network,
        ),
        new ActionTreeItem(
          "Add Compose Port",
          "portManager.addComposePublishedPort",
          "database",
          "Attach published service port",
          element.network,
        ),
        new ActionTreeItem(
          "Attach Service",
          "portManager.attachContainerToNetwork",
          "server-environment",
          "Use discovered published ports",
          { network: element.network },
        ),
        new ActionTreeItem(
          "Use for VS Code Terminals",
          "portManager.attachVscodeWindowTerminalsToNetwork",
          "terminal",
          "Attach this VS Code window",
          element.network,
        ),
        new ActionTreeItem(
          "Attach Process",
          "portManager.attachProcessToNetwork",
          "debug-alt",
          "Attach existing backend PID",
          element.network,
        ),
        new ActionTreeItem(
          "Copy Terminal Script",
          "portManager.copyTerminalRoutingScript",
          "copy",
          "Paste into custom terminal UI",
          element.network,
        ),
        new ActionTreeItem(
          "Save Binding Preset",
          "portManager.saveBindingPreset",
          "save",
          "Save current bindings",
          element.network,
        ),
        new ActionTreeItem(
          "Apply Binding Preset",
          "portManager.applyBindingPreset",
          "cloud-download",
          "Load saved bindings",
          element.network,
        ),
        ...(attachments.length > 0
          ? [new ActionTreeItem("Detach Terminal", "portManager.detachTerminalFromNetwork", "debug-disconnect")]
          : []),
        ...exposures.map((exposure) => new HostPortExposureTreeItem(exposure, [element.network])),
        ...hostAccessBindings.map((binding) => new HostAccessBindingTreeItem(binding)),
        ...composeAttachments.map((attachment) => new ComposeAttachmentTreeItem(attachment)),
        ...(windowTerminalBinding !== undefined
          ? [new VscodeWindowTerminalBindingTreeItem(windowTerminalBinding, element.network)]
          : []),
        ...attachments.map((attachment) => new TerminalAttachmentTreeItem(attachment)),
        ...(attachments.length === 0 &&
        exposures.length === 0 &&
        hostAccessBindings.length === 0 &&
        composeAttachments.length === 0 &&
        windowTerminalBinding === undefined
          ? [new EmptyTreeItem("No bindings or terminal windows", "Attach a window or add a host binding")]
          : []),
      ];
    }

    if (element instanceof TerminalWindowTreeItem) {
      const candidateSet = new Set(element.window.candidatePids);
      return snapshot.terminalCandidates
        .filter((candidate) => candidateSet.has(candidate.pid))
        .map((candidate) => new TerminalCandidateTreeItem(candidate));
    }

    if (element instanceof ComposeProjectCandidateTreeItem) {
      return element.candidates.map((candidate) => new ContainerServiceCandidateTreeItem(candidate));
    }

    if (element instanceof ContainerServiceCandidateTreeItem) {
      return element.candidate.ports.map((port) => new ContainerPublishedPortTreeItem(element.candidate, port));
    }

    if (!(element instanceof TreeSectionItem)) {
      return [];
    }

    switch (element.kind) {
      case "networks":
        return [
          new ActionTreeItem("Create Logical Network", "portManager.createLogicalNetwork", "add"),
          new ActionTreeItem("Remove Logical Network", "portManager.removeLogicalNetwork", "trash"),
          ...(snapshot.networks.length > 0
            ? snapshot.networks.map((network) =>
                new LogicalNetworkTreeItem(
                  network,
                  snapshot.attachments,
                  snapshot.exposures,
                  snapshot.hostAccessBindings,
                  snapshot.composeAttachments,
                ),
              )
            : [new EmptyTreeItem("No logical networks", "Create one here")]),
        ];
      case "terminals":
        return [
          new ActionTreeItem("Refresh Terminal Windows", "portManager.refreshTerminals", "refresh"),
          new ActionTreeItem("Attach VS Code Window", "portManager.attachVscodeWindowTerminalsToNetwork", "terminal"),
          new ActionTreeItem("Detach VS Code Window", "portManager.detachVscodeWindowTerminalsFromNetwork", "debug-disconnect"),
          new ActionTreeItem("Reset Terminal Network", "portManager.resetTerminalNetworkSettings", "debug-disconnect"),
          ...(snapshot.vscodeWindowTerminalBinding !== undefined
            ? [
                new VscodeWindowTerminalBindingTreeItem(
                  snapshot.vscodeWindowTerminalBinding,
                  snapshot.networks.find((network) => network.id === snapshot.vscodeWindowTerminalBinding?.networkId),
                ),
              ]
            : []),
          ...(snapshot.terminalWindows.length > 0
            ? snapshot.terminalWindows.map((window) => new TerminalWindowTreeItem(window))
            : [new EmptyTreeItem("No terminal windows discovered", "Open a shell and refresh")]),
        ];
      case "containers":
        return [
          new ActionTreeItem("Refresh Services", "portManager.refreshContainerServices", "refresh"),
          new ActionTreeItem("Attach Service to Network", "portManager.attachContainerToNetwork", "plug"),
          ...(snapshot.containerServiceCandidates.length > 0
            ? buildContainerServiceTreeItems(snapshot.containerServiceCandidates)
            : [new EmptyTreeItem("No published container ports", "Start compose services and refresh")]),
        ];
      case "exposures":
        return [
          new ActionTreeItem("Add Host Port Exposure", "portManager.addHostPortExposure", "add"),
          new ActionTreeItem("Open Host Exposure URL", "portManager.openHostPortExposureUrl", "link-external"),
          new ActionTreeItem("Copy Host Exposure URL", "portManager.copyHostPortExposureUrl", "copy"),
          new ActionTreeItem("Remove Host Port Exposure", "portManager.removeHostPortExposure", "trash"),
          ...(snapshot.exposures.length > 0
            ? snapshot.exposures.map((exposure) => new HostPortExposureTreeItem(exposure, snapshot.networks))
            : [new EmptyTreeItem("No host exposures", "Expose a network port here")]),
        ];
      case "runtime":
        return [
          new ActionTreeItem("Open Settings", "portManager.openSettings", "settings-gear"),
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
      case "daemon":
        return [
          new ActionTreeItem("Restart Daemon", "portManager.restartDaemon", "debug-restart"),
          new ActionTreeItem("Start Daemon", "portManager.startDaemon", "server-process"),
          new ActionTreeItem("Stop Daemon", "portManager.stopDaemon", "debug-disconnect"),
          new ActionTreeItem("Daemon Status", "portManager.showDaemonStatus", "pulse"),
          ...buildDaemonChildren(daemon),
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

  constructor(label: string, command: string, icon: string, description?: string, argument?: unknown) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = {
      command,
      title: label,
      arguments: argument === undefined ? [] : [argument],
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

/** Logical Network row backed by real service state. */
export class LogicalNetworkTreeItem extends vscode.TreeItem {
  readonly contextValue = "logicalNetwork";

  constructor(
    readonly network: LogicalNetwork,
    attachments: readonly TerminalAttachment[],
    exposures: readonly HostPortExposure[] = [],
    hostAccessBindings: readonly HostAccessBinding[] = [],
    composeAttachments: readonly ComposeAttachment[] = [],
  ) {
    const attachmentCount = attachments.filter((attachment) => attachment.networkId === network.id).length;
    const exposureCount = exposures.filter((exposure) => exposure.networkId === network.id).length;
    const hostAccessCount = hostAccessBindings.filter((binding) => binding.networkId === network.id).length;
    const composeCount = composeAttachments.filter((attachment) => attachment.networkId === network.id).length;
    super(
      network.name,
      attachmentCount > 0 || exposureCount > 0 || hostAccessCount > 0 || composeCount > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = network.id;
    this.description = buildNetworkDescription(network, attachmentCount, exposureCount, hostAccessCount, composeCount);
    this.tooltip = buildNetworkTooltip(network, attachmentCount, exposureCount, hostAccessCount, composeCount);
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
    super(attachment.projectName, vscode.TreeItemCollapsibleState.None);
    this.id = attachment.id;
    this.description = attachment.ports.map(formatComposePort).join(", ");
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
  readonly contextValue = "composeProjectCandidate";
  readonly aggregateCandidate: ContainerServiceCandidate;

  constructor(
    readonly projectName: string,
    readonly runtime: ContainerServiceCandidate["runtime"],
    readonly candidates: readonly ContainerServiceCandidate[],
  ) {
    const ports = candidates.flatMap((candidate) => [...candidate.ports]);

    super(projectName, vscode.TreeItemCollapsibleState.Collapsed);
    this.aggregateCandidate = {
      id: buildComposeProjectCandidateId(
        runtime,
        projectName,
        candidates[0]?.composeWorkingDirectory,
        uniqueStrings(candidates.flatMap((candidate) => [...(candidate.composeConfigFiles ?? [])])),
      ),
      runtime,
      containerId: projectName,
      containerName: projectName,
      composeProject: projectName,
      ...(candidates[0]?.composeWorkingDirectory !== undefined
        ? { composeWorkingDirectory: candidates[0].composeWorkingDirectory }
        : {}),
      ...(candidates.flatMap((candidate) => [...(candidate.composeConfigFiles ?? [])]).length > 0
        ? { composeConfigFiles: uniqueStrings(candidates.flatMap((candidate) => [...(candidate.composeConfigFiles ?? [])])) }
        : {}),
      ports,
    };
    this.id = this.aggregateCandidate.id;
    this.description = `${candidates.length} services, ${ports.length} port${ports.length === 1 ? "" : "s"}`;
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
  readonly contextValue = "containerServiceCandidate";

  constructor(readonly candidate: ContainerServiceCandidate) {
    super(formatContainerServiceTreeLabel(candidate), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = candidate.id;
    this.description = `${candidate.runtime}, ${candidate.ports.length} port${candidate.ports.length === 1 ? "" : "s"}`;
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
    super(`${port.actualHostAddress}:${port.actualHostPort}`, vscode.TreeItemCollapsibleState.None);
    this.id = `${candidate.id}:${port.actualHostAddress}:${port.actualHostPort}:${port.containerPort}`;
    this.description = `container ${port.containerPort}${port.protocolName ? ` ${port.protocolName}` : ""}`;
    this.tooltip = buildContainerPortTooltip(candidate, port);
    this.iconPath = new vscode.ThemeIcon("plug");
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
  }
}

/** Current VS Code window-wide terminal network default. */
export class VscodeWindowTerminalBindingTreeItem extends vscode.TreeItem {
  readonly contextValue = "vscodeWindowTerminalBinding";

  constructor(
    readonly binding: VscodeWindowTerminalBinding,
    network: LogicalNetwork | undefined,
  ) {
    super("VS Code Window Terminals", vscode.TreeItemCollapsibleState.None);
    this.id = binding.id;
    this.description = network?.name ?? binding.networkId;
    this.tooltip = buildVscodeWindowTerminalBindingTooltip(binding, network);
    this.iconPath = new vscode.ThemeIcon(
      binding.status === "attached" ? "terminal" : "warning",
      binding.status === "error" ? new vscode.ThemeColor("testing.iconFailed") : undefined,
    );
    this.command = {
      command: "portManager.detachVscodeWindowTerminalsFromNetwork",
      title: "Detach VS Code Window Terminals",
    };
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
function buildActionChildren(): PortManagerTreeItem[] {
  return [
    new ActionTreeItem("Start Daemon", "portManager.startDaemon", "server-process"),
    new ActionTreeItem("Restart Daemon", "portManager.restartDaemon", "debug-restart"),
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

/** One-line daemon summary for the root section. */
function formatDaemonSummary(daemon: AgentDaemonStatus): string {
  const version = daemon.restartRequired ? "stale" : (daemon.versionStatus ?? "unknown");
  return daemon.pid > 0 ? `${daemon.status} pid ${daemon.pid}, ${version}` : daemon.status;
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
): string {
  const details = [
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
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(network.name)}**\n\n`);
  tooltip.appendMarkdown(`- ID: \`${escapeMarkdown(network.id)}\`\n`);
  tooltip.appendMarkdown(`- Runtime: \`${network.runtimeKind}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${network.status}\`\n`);
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

/** Builds tooltip details for one compose attachment. */
function buildComposeAttachmentTooltip(attachment: ComposeAttachment): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(attachment.projectName)}**\n\n`);
  tooltip.appendMarkdown(`- Network ID: \`${escapeMarkdown(attachment.networkId)}\`\n`);
  tooltip.appendMarkdown(`- Status: \`${attachment.status}\`\n`);
  tooltip.appendMarkdown(`- Attached: \`${attachment.attachedAt}\`\n`);
  if (attachment.mutation !== undefined) {
    tooltip.appendMarkdown(`- Original Project: \`${escapeMarkdown(attachment.mutation.originalProjectName)}\`\n`);
    tooltip.appendMarkdown(`- Hidden Project: \`${escapeMarkdown(attachment.mutation.attachedProjectName)}\`\n`);
  }

  for (const port of attachment.ports) {
    tooltip.appendMarkdown(
      `- ${escapeMarkdown(port.serviceName)}: \`${port.logicalPort} -> ${escapeMarkdown(port.actualHostAddress)}:${port.actualHostPort}\``,
    );
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
    tooltip.appendMarkdown(`- Compose Project: \`${escapeMarkdown(candidate.composeProject ?? "n/a")}\`\n`);
    tooltip.appendMarkdown(`- Compose Service: \`${escapeMarkdown(candidate.composeService ?? "n/a")}\`\n`);
    tooltip.appendMarkdown(`- Compose CWD: \`${escapeMarkdown(candidate.composeWorkingDirectory ?? "n/a")}\`\n`);
    tooltip.appendMarkdown(`- Compose Files: \`${escapeMarkdown(candidate.composeConfigFiles?.join(", ") ?? "n/a")}\`\n`);
  }

  for (const port of candidate.ports) {
    tooltip.appendMarkdown(
      `- ${escapeMarkdown(port.serviceName)}: \`${port.logicalPort} -> ${escapeMarkdown(port.actualHostAddress)}:${port.actualHostPort}\` container \`${port.containerPort}\`\n`,
    );
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
  tooltip.appendMarkdown(`**${escapeMarkdown(projectName)}**\n\n`);
  tooltip.appendMarkdown(`- Runtime: \`${runtime}\`\n`);
  tooltip.appendMarkdown(`- Services: \`${candidates.length}\`\n`);
  tooltip.appendMarkdown(`- Published Ports: \`${candidates.reduce((total, candidate) => total + candidate.ports.length, 0)}\`\n`);

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
  tooltip.appendMarkdown(`- Host: \`${escapeMarkdown(port.actualHostAddress)}:${port.actualHostPort}\`\n`);
  tooltip.appendMarkdown(`- Container Port: \`${port.containerPort}\`\n`);
  tooltip.appendMarkdown(`- Default Logical Port: \`${port.logicalPort}\`\n`);
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

/** Formats one compose route as logical port to actual published endpoint. */
function formatComposePort(port: ComposeAttachment["ports"][number]): string {
  const protocol = port.protocolName === undefined ? "" : ` ${port.protocolName}`;
  return `${port.logicalPort} -> ${port.actualHostPort}${protocol}`;
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

/** Groups compose service containers under their compose project while keeping raw containers flat. */
function buildContainerServiceTreeItems(
  candidates: readonly ContainerServiceCandidate[],
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
      return new ComposeProjectCandidateTreeItem(first.composeProject!, first.runtime, group);
    }),
    ...rawCandidates.map((candidate) => new ContainerServiceCandidateTreeItem(candidate)),
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

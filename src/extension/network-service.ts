import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getAgentSocketPath } from "../agent/agent-socket";
import {
  getDefaultHostAccessBindingsPath,
  getDefaultRouteTablePath,
  getRouteTablePathForNetwork,
} from "../agent/route-table";
import { readContainerRuntimeSettings, readPortManagerSettings } from "../config/vscode-settings";
import { LogicalNetworkRegistry, type LogicalNetworkRegistryState } from "../core/networks/logical-network-registry";
import { findRoutesMatchingClientCwd } from "../core/networks/logical-route-selection";
import { SimpleEventEmitter } from "../shared/events";
import {
  ContainerNetworkRuntimeAdapter,
  type ContainerRuntimeTarget,
  runContainerCommand,
} from "../platform/network/container-runtime";
import { ComposePublishMutator } from "../platform/network/compose-publish-mutator";
import { ContainerServiceDiscoveryAdapter } from "../platform/network/container-service-discovery";
import { SharedLogicalNetworkStateStore } from "../platform/network/shared-network-state-store";
import { HostPortProxyManager, type HostPortProxyTarget } from "../platform/ports/host-port-proxy";
import {
  LogicalPortRouterManager,
  type LogicalPortRouterConnection,
  type LogicalPortRouterTarget,
} from "../platform/ports/logical-port-router";
import { NodeTcpConnectionProcessResolver } from "../platform/ports/tcp-connection-process-resolver";
import {
  buildProcessTreeContext,
  NodeProcessTableProvider,
  type ProcessTableRow,
} from "../platform/process/node-process-table";
import { getProcessLookupHelperRelativePath } from "../platform/process/native-process-lookup";
import { NodeProcessEnvironmentProvider } from "../platform/process/node-process-environment";
import { NodeTerminalCandidateProvider } from "../platform/process/node-terminal-candidate-provider";
import { ELECTRON_RUN_AS_NODE } from "../platform/process/node-runtime";
import type {
  AgentDaemonStatus,
  ComposeAttachment,
  ComposeContainerMutationMapping,
  ComposePortMutationMode,
  ComposePortMutationState,
  ComposePublishedPort,
  ContainerServiceCandidate,
  DisposableLike,
  HostAccessBinding,
  HostPortExposure,
  ManagedProcess,
  LogicalNetwork,
  LogicalPortRoute,
  NetworkRuntimeDescriptor,
  NetworkRuntimeKind,
  NetworkSnapshot,
  PortManagerSettings,
  RegisteredProcessInput,
  TerminalAttachment,
  TerminalCandidate,
  TerminalCandidateProvider,
  TerminalWindow,
  VscodeWindowTerminalBinding,
} from "../shared/types";
import {
  applyTerminalHookEnvironment,
  DOCKER_SHIM_PATH_ENV,
  getAsdfShimLauncherRelativePath,
  getHookLibraryRelativePath,
  getRuntimeCommandShimRelativePath,
  prepareRuntimeShimLauncherDirectory,
  prepareShellEnvRestoreScript,
  RUNTIME_SHIM_DIRECTORY_ENV,
  shouldInjectTerminalHook,
} from "./terminal-hook-environment";
import {
  buildComposeProjectRoutingShell,
  serializeComposeProjectRoutingRows,
  type ComposeProjectRoutingRow,
} from "./compose-project-routing";
import type { PortManagerProcessService } from "./process-service";

const NETWORK_STATE_KEY = "portManager.logicalNetworkState.v1";
const BINDING_PRESETS_KEY = "portManager.bindingPresets.v1";
const VSCODE_WINDOW_TERMINAL_BINDING_KEY = "portManager.vscodeWindowTerminalBinding.v1";
const COMPOSE_PROJECT_ROUTING_FILE_NAME = "compose-project-routing.tsv";
const COMPOSE_PROJECT_ROUTING_FILE_PREFIX = "compose-project-routing-";
const COMPOSE_PROJECT_ROUTING_COMPOSE_SEPARATOR = ".compose-";
const TERMINAL_ATTACHMENT_MARKER_DIRECTORY_NAME = "terminal-attachments";
const MANUAL_TERMINAL_ATTACHMENT_ID_PREFIX = "manual-terminal:";
const PROCESS_TERMINAL_ATTACHMENT_ID_PREFIX = "process-terminal:";
const COMPOSE_ATTACHMENT_RECONCILE_INTERVAL_MS = 3_000;
const execFileAsync = promisify(execFile);

export interface BindingPresetSummary {
  /** Stable preset id stored in VS Code global state. */
  readonly id: string;
  /** User-facing preset name. */
  readonly name: string;
  /** Number of host exposure rows captured in the preset. */
  readonly exposureCount: number;
  /** Number of network-to-host access rows captured in the preset. */
  readonly hostAccessCount: number;
  /** ISO timestamp from the latest save. */
  readonly updatedAt: string;
}

export interface TerminalNetworkResetSummary {
  /** Number of discovered terminal windows that received a reset command. */
  readonly terminalCount: number;
  /** Number of persisted attachment rows removed from the logical network state. */
  readonly removedAttachmentCount: number;
}

export interface RoutingFileCleanupSummary {
  /** Existing Port Manager routing cache files removed from disk. */
  readonly removedFileCount: number;
  /** Files that could not be removed because the filesystem rejected cleanup. */
  readonly failedFileCount: number;
  /** Compose endpoint routes re-registered into the singleton daemon afterward. */
  readonly restoredComposeRouteCount: number;
}

export interface VscodeWindowTerminalAttachSummary {
  /** Current VS Code window/workspace binding after attach. */
  readonly binding: VscodeWindowTerminalBinding;
  /** Already-open VS Code terminals that accepted the routing script. */
  readonly injectedTerminalCount: number;
}

export interface VscodeWindowTerminalDetachSummary {
  /** True when a stored VS Code window binding existed and was cleared. */
  readonly removedBinding: boolean;
  /** Already-open VS Code terminals that accepted the detach script. */
  readonly detachedTerminalCount: number;
}

interface BindingPreset {
  readonly id: string;
  readonly name: string;
  readonly exposures: readonly BindingPresetExposure[];
  readonly hostAccessBindings: readonly BindingPresetHostAccess[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BindingPresetExposure {
  readonly hostAddress: string;
  readonly hostPort: number;
  readonly targetAddress: string;
  readonly targetPort: number;
}

interface BindingPresetHostAccess {
  readonly logicalPort: number;
  readonly hostAddress: string;
  readonly hostPort: number;
}

interface TerminalAttachmentMarker {
  readonly networkId: string;
  readonly terminalId?: string;
  readonly pid?: number;
  readonly processGroupId?: number;
  readonly attachedAt: string;
  readonly filePath: string;
}

/**
 * Extension-side application service for the Logical Network mode.
 *
 * The service owns VS Code persistence and composes platform adapters, while
 * the registry keeps pure domain state. Runtime behavior is deliberately
 * capability-driven so unsupported attach/isolation paths fail before giving a
 * false impression that a terminal was moved into a network.
 */
export class PortManagerNetworkService implements DisposableLike {
  /** Pure domain store for networks, attachments, exposures, and terminal rows. */
  private readonly registry: LogicalNetworkRegistry;

  /** Cross-window durable state store shared by every VS Code extension host. */
  private readonly sharedNetworkStateStore: SharedLogicalNetworkStateStore;

  /** OS process-table terminal scanner. */
  private readonly terminalCandidateProvider: TerminalCandidateProvider;

  /** Local TCP proxy runtime used for concrete host exposure support. */
  private readonly proxyManager: HostPortProxyManager;

  /** Localhost logical-port router used for app-agnostic internal calls. */
  private readonly logicalPortRouter: LogicalPortRouterManager;

  /** Resolves accepted TCP connection tuples back to client PIDs. */
  private readonly tcpConnectionProcessResolver: NodeTcpConnectionProcessResolver;

  /** Reads process ancestry so client and listener PIDs can be tied to terminals. */
  private readonly processTableProvider: NodeProcessTableProvider;

  /** Reads inherited Port Manager routing scope from local client processes. */
  private readonly processEnvironmentProvider: NodeProcessEnvironmentProvider;

  /** Container runtime adapter that provides actual same-port isolation. */
  private readonly containerRuntime: ContainerNetworkRuntimeAdapter;

  /** Docker/Podman published-port discovery used for UI attach candidates. */
  private readonly containerServiceDiscovery: ContainerServiceDiscoveryAdapter;

  /** Mutates Compose publish rules so attached services release host ports. */
  private readonly composePublishMutator: ComposePublishMutator;

  /** Current VS Code window/workspace default network for newly opened terminals. */
  private vscodeWindowTerminalBinding: VscodeWindowTerminalBinding | undefined;

  /** Guards daemon route rehydration so snapshot events cannot recursively register compose routes. */
  private composeRouteRestoreInFlight: Promise<void> | undefined;

  /** Guards live compose endpoint refreshes while Docker is recreating hidden containers. */
  private composeAttachmentReconcileInFlight: Promise<void> | undefined;

  /** Background poller that keeps Docker-assigned hidden host ports from going stale. */
  private composeAttachmentReconcileTimer: ReturnType<typeof setInterval> | undefined;

  /** Last shared-state revision applied in this extension host. */
  private sharedNetworkStateRevision: string | undefined;

  /** Signature of the last durable registry state written or loaded. */
  private persistedNetworkStateSignature = "";

  /** True while applying file changes from another VS Code window. */
  private applyingSharedNetworkState = false;

  /** Extension-local state changes that are not owned by the pure registry. */
  private readonly localChangeEvents = new SimpleEventEmitter<void>();

  /** VS Code event subscriptions owned by this service. */
  private readonly disposables: DisposableLike[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly processService?: PortManagerProcessService,
  ) {
    this.sharedNetworkStateStore = new SharedLogicalNetworkStateStore({
      storageDirectory: this.context.globalStorageUri.fsPath,
    });
    this.terminalCandidateProvider = new NodeTerminalCandidateProvider();
    this.containerRuntime = new ContainerNetworkRuntimeAdapter();
    this.containerServiceDiscovery = new ContainerServiceDiscoveryAdapter();
    this.composePublishMutator = new ComposePublishMutator({
      storageDirectory: path.join(this.context.globalStorageUri.fsPath, "compose-overrides"),
      runCommand: runContainerCommand,
    });
    this.proxyManager = new HostPortProxyManager(
      {
        resolve: (exposure) => this.resolveHostExposureTarget(exposure),
      },
      {
        nativeProxyPath: this.context.asAbsolutePath(getHostExposureProxyHelperRelativePath()),
      },
    );
    this.logicalPortRouter = new LogicalPortRouterManager(
      {
        resolve: (connection) => this.resolveLogicalPortRouterTarget(connection),
      },
      {
        nativeRouterPath: this.context.asAbsolutePath(getTcpRouterHelperRelativePath()),
      },
    );
    const nativeProcessLookupPath = this.context.asAbsolutePath(getProcessLookupHelperRelativePath());
    this.tcpConnectionProcessResolver = new NodeTcpConnectionProcessResolver({
      nativeLookupPath: nativeProcessLookupPath,
    });
    this.processTableProvider = new NodeProcessTableProvider({
      nativeLookupPath: nativeProcessLookupPath,
    });
    this.processEnvironmentProvider = new NodeProcessEnvironmentProvider({
      nativeLookupPath: nativeProcessLookupPath,
    });
    this.registry = new LogicalNetworkRegistry(BASE_RUNTIMES, this.loadState());
    this.persistedNetworkStateSignature = stringifyPersistedNetworkState(this.registry.getPersistedState());
    this.vscodeWindowTerminalBinding = this.loadVscodeWindowTerminalBinding();
    this.disposables.push(
      this.registry.onDidChange(() => {
        this.saveState();
        void this.writeHostAccessBindingsFile();
        void this.writeComposeProjectRoutingFile();
        void this.syncLogicalPortRouters();
        this.reconcileVscodeWindowTerminalBinding();
      }),
    );
    if (this.processService !== undefined) {
      this.disposables.push(
        this.processService.onDidChange(() => {
          void this.syncLogicalPortRouters();
          void this.restorePersistedComposeRoutesIfMissing();
        }),
      );
    }
  }

  /** Loads terminal candidates and reopens persisted host exposures. */
  async start(): Promise<void> {
    await fs.mkdir(this.getTerminalAttachmentMarkerDirectoryPath(), { recursive: true }).catch(() => undefined);
    const terminalAttachmentMarkerWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.getTerminalAttachmentMarkerDirectoryPath(), "*.tsv"),
    );

    this.disposables.push(
      this.sharedNetworkStateStore.watch(() => {
        void this.reloadSharedNetworkState();
      }),
      terminalAttachmentMarkerWatcher,
      terminalAttachmentMarkerWatcher.onDidCreate(() => {
        void this.refreshTerminals();
      }),
      terminalAttachmentMarkerWatcher.onDidChange(() => {
        void this.refreshTerminals();
      }),
      terminalAttachmentMarkerWatcher.onDidDelete(() => {
        void this.refreshTerminals();
      }),
      vscode.window.onDidOpenTerminal(() => {
        void this.refreshTerminals();
      }),
      vscode.window.onDidCloseTerminal(() => {
        void this.refreshTerminals();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("portManager.containerRuntime") ||
          event.affectsConfiguration("portManager.enabled")
        ) {
          void this.refreshRuntimeDescriptors();
          void this.refreshContainerServices();
          this.applyVscodeWindowTerminalEnvironment();
        }
      }),
    );

    await this.reloadSharedNetworkState();
    await this.refreshRuntimeDescriptors();
    this.reconcileVscodeWindowTerminalBinding();
    this.applyVscodeWindowTerminalEnvironment();
    await this.reopenPersistedExposures();
    await this.writeHostAccessBindingsFile();
    await this.repairPersistedPortManagerCloneComposeAttachments();
    await this.reconcileComposeAttachmentPublishedPorts();
    await this.writeComposeProjectRoutingFile();
    await this.restorePersistedComposeRoutesIfMissing();
    await this.refreshTerminals();
    void this.refreshContainerServices();
    await this.syncLogicalPortRouters();
    this.startComposeAttachmentReconcileLoop();
  }

  /** Returns the latest logical network snapshot for the sidebar. */
  getSnapshot(): NetworkSnapshot {
    return {
      ...this.registry.getSnapshot(),
      ...(this.vscodeWindowTerminalBinding !== undefined
        ? { vscodeWindowTerminalBinding: this.vscodeWindowTerminalBinding }
        : {}),
    };
  }

  /** Returns daemon status when process service is available for the sidebar. */
  getDaemonStatus(): AgentDaemonStatus {
    return this.processService?.getSnapshot().daemon ?? createDisconnectedDaemonStatus();
  }

  /** Lists saved binding presets without exposing mutable stored arrays. */
  listBindingPresets(): readonly BindingPresetSummary[] {
    return this.loadBindingPresets().map((preset) => ({
      id: preset.id,
      name: preset.name,
      exposureCount: preset.exposures.length,
      hostAccessCount: preset.hostAccessBindings.length,
      updatedAt: preset.updatedAt,
    }));
  }

  /** Subscribes to logical network state changes. */
  onDidChange(listener: () => void): DisposableLike {
    const registrySubscription = this.registry.onDidChange(listener);
    const localSubscription = this.localChangeEvents.subscribe(listener);

    return {
      dispose: () => {
        registrySubscription.dispose();
        localSubscription.dispose();
      },
    };
  }

  /** Creates a network row for the runtime adapter selected at creation time. */
  async createNetwork(name: string, runtimeKind?: NetworkRuntimeKind): Promise<LogicalNetwork> {
    const runtimes = this.registry.getSnapshot().runtimes;
    const selectedRuntimeKind = runtimeKind ?? runtimes.find(isContainerLevelRuntime)?.kind;

    if (selectedRuntimeKind === undefined) {
      throw new Error("No runtime adapter is available for logical network creation.");
    }

    const runtime = requireRuntime(runtimes, selectedRuntimeKind);
    requireContainerLevelRuntime(runtime);

    const network: LogicalNetwork = {
      id: createId("network"),
      name,
      status: "running",
      runtimeKind: runtime.kind,
      createdAt: new Date().toISOString(),
    };

    if (runtime.kind === "container") {
      await this.containerRuntime.createNetwork(network, readContainerRuntimeSettings());
    }

    return this.registry.addNetwork(network);
  }

  /** Removes a network and closes any host exposures that belonged to it. */
  async removeNetwork(networkId: string): Promise<LogicalNetwork | undefined> {
    const snapshot = this.registry.getSnapshot();
    const network = snapshot.networks.find((item) => item.id === networkId);
    const exposures = snapshot.exposures.filter((exposure) => exposure.networkId === networkId);
    const composeAttachments = snapshot.composeAttachments.filter((attachment) => attachment.networkId === networkId);

    for (const exposure of exposures) {
      await this.proxyManager.close(exposure.id);
    }

    for (const attachment of composeAttachments) {
      for (const port of attachment.ports) {
        if (port.processId !== undefined) {
          await this.processService?.removeProcess(port.processId).catch(() => undefined);
        }
      }
    }

    if (network?.runtimeKind === "container") {
      await this.containerRuntime.removeNetwork(networkId).catch(() => undefined);
    }

    await this.removeManualTerminalAttachmentMarkersForNetwork(networkId).catch(() => undefined);

    return this.registry.removeNetwork(networkId);
  }

  /** Refreshes VS Code and external OS terminal windows. */
  async refreshTerminals(): Promise<readonly TerminalWindow[]> {
    const processRows = await this.listProcessRowsForTerminalControl();
    const [vscodeCandidates, osCandidates] = await Promise.all([
      listVscodeTerminalCandidates(processRows),
      this.terminalCandidateProvider.list().catch(() => []),
    ]);
    const candidates = [...vscodeCandidates, ...osCandidates];
    this.registry.setTerminalCandidates(candidates);
    this.syncProcessAttachmentLiveness(processRows);
    await this.syncManualTerminalAttachmentMarkers(processRows).catch(() => undefined);

    return this.registry.getSnapshot().terminalWindows;
  }

  /** Refreshes Docker/Podman containers that publish host ports for easy attach. */
  async refreshContainerServices(): Promise<readonly ContainerServiceCandidate[]> {
    const candidates = await this.containerServiceDiscovery
      .list(readContainerRuntimeSettings())
      .catch(() => []);

    this.registry.setContainerServiceCandidates(candidates);
    return this.registry.getSnapshot().containerServiceCandidates;
  }

  /**
   * Attaches a terminal candidate to a network only after the selected runtime
   * can provide network-namespace same-port isolation. Recording logical-only
   * associations would let host bind conflicts leak into the product model.
   */
  attachTerminal(networkId: string, terminalPid: number): TerminalAttachment {
    requireNetwork(this.registry.getNetwork(networkId), networkId);
    void terminalPid;
    throw new Error("Logical networks attach terminal windows through runtime-specific terminal commands.");
  }

  /** Attaches a user-facing terminal window by resolving it to its root process. */
  async attachTerminalWindow(networkId: string, terminalWindowId: string): Promise<TerminalAttachment> {
    const network = requireNetwork(this.registry.getNetwork(networkId), networkId);
    const runtime = requireRuntime(this.registry.getSnapshot().runtimes, network.runtimeKind);
    requireContainerLevelRuntime(runtime);
    const terminalWindow = this.registry
      .getSnapshot()
      .terminalWindows.find((window) => window.id === terminalWindowId);

    if (terminalWindow === undefined) {
      throw new Error(`Unknown terminal window: ${terminalWindowId}`);
    }

    if (runtime.kind === "container") {
      await this.containerRuntime.createNetwork(network, readContainerRuntimeSettings());
      const attachCommand = await this.containerRuntime.buildAttachCommand(network.id);
      const processRows = await this.listProcessRowsForTerminalControl();
      const sent = await sendCommandToTerminalWindow(
        terminalWindow,
        attachCommand,
        processRows,
        this.getTtyInputHelperPath(),
      );
      if (!sent) {
        throw new Error(`Could not send network namespace attach command to "${terminalWindow.title}".`);
      }
    } else if (runtime.kind === "nativeHelper") {
      const settings = readPortManagerSettings();
      if (shouldInjectTerminalHook(settings)) {
        await this.processService?.start();
      }
      const result = await this.injectRoutingIntoTerminalWindow(terminalWindow.id, network.id, settings);

      if (!result.injected) {
        throw new Error(result.reason ?? `Could not attach "${terminalWindow.title}" with native socket routing.`);
      }
    }

    for (const attachment of this.registry.getSnapshot().attachments) {
      if (attachment.terminalWindowId === terminalWindow.id || attachment.rootPid === terminalWindow.rootPid) {
        this.registry.removeAttachment(attachment.id);
      }
    }

    return this.registry.addAttachment({
      id: createId("attachment"),
      networkId,
      rootPid: terminalWindow.rootPid,
      processGroupId: terminalWindow.processGroupId,
      terminalWindowId: terminalWindow.id,
      terminalTitle: terminalWindow.title,
      mode: "isolated",
      status: "attached",
      attachedAt: new Date().toISOString(),
    });
  }

  /**
   * Makes the current VS Code window/workspace default every new terminal to a
   * logical network. Existing VS Code terminals receive the normal attach script
   * best-effort because already-running shells cannot inherit env collection
   * changes retroactively.
   */
  async attachVscodeWindowTerminalsToNetwork(networkId: string): Promise<VscodeWindowTerminalAttachSummary> {
    const network = requireNetwork(this.registry.getNetwork(networkId), networkId);
    const runtime = requireRuntime(this.registry.getSnapshot().runtimes, network.runtimeKind);
    requireNativeHelperRuntime(runtime);

    const settings = readPortManagerSettings();
    if (!settings.enabled) {
      throw new Error("Port Manager is disabled in settings.");
    }
    if (!shouldInjectTerminalHook(settings)) {
      throw new Error(`Native terminal routing is not supported on ${process.platform}.`);
    }

    await this.processService?.start();
    const binding: VscodeWindowTerminalBinding = {
      id: "vscode-window",
      networkId,
      status: "attached",
      attachedAt: new Date().toISOString(),
      injectedTerminalCount: 0,
    };

    this.vscodeWindowTerminalBinding = binding;
    this.saveVscodeWindowTerminalBinding();
    this.applyVscodeWindowTerminalEnvironment();

    const injectedTerminalCount = await this.injectRoutingIntoOpenVscodeTerminals(networkId, settings);
    const updatedBinding = {
      ...binding,
      injectedTerminalCount,
    };
    this.vscodeWindowTerminalBinding = updatedBinding;
    this.saveVscodeWindowTerminalBinding();
    this.localChangeEvents.emit();

    return {
      binding: updatedBinding,
      injectedTerminalCount,
    };
  }

  /** Clears the current VS Code window/workspace terminal default and resets open VS Code terminals. */
  async detachVscodeWindowTerminalsFromNetwork(): Promise<VscodeWindowTerminalDetachSummary> {
    const removedBinding = this.vscodeWindowTerminalBinding !== undefined;
    this.vscodeWindowTerminalBinding = undefined;
    this.saveVscodeWindowTerminalBinding();
    this.applyVscodeWindowTerminalEnvironment();

    const detachedTerminalCount = sendCommandToOpenVscodeTerminals(this.buildTerminalDetachScript());
    await this.refreshTerminals().catch(() => []);

    this.localChangeEvents.emit();
    return {
      removedBinding,
      detachedTerminalCount,
    };
  }

  /** Returns the native hook script that an external terminal owner can write to its shell stdin. */
  async createTerminalRoutingScript(networkId: string): Promise<string> {
    const network = requireNetwork(this.registry.getNetwork(networkId), networkId);
    const runtime = requireRuntime(this.registry.getSnapshot().runtimes, network.runtimeKind);
    requireNativeHelperRuntime(runtime);

    const settings = readPortManagerSettings();
    if (!settings.enabled) {
      throw new Error("Port Manager is disabled in settings.");
    }
    if (!shouldInjectTerminalHook(settings)) {
      throw new Error(`Native terminal routing is not supported on ${process.platform}.`);
    }

    await this.processService?.start();
    return this.buildTerminalRoutingScript(network.id, settings);
  }

  /** Returns the shell snippet that removes Port Manager routing variables from a custom terminal shell. */
  createTerminalDetachScript(): string {
    return this.buildTerminalDetachScript();
  }

  /** Detaches one terminal window from its logical network runtime. */
  async detachTerminal(attachmentId: string): Promise<TerminalAttachment | undefined> {
    const attachment = this.registry.getSnapshot().attachments.find((item) => item.id === attachmentId);

    if (attachment === undefined) {
      return undefined;
    }

    const network = this.registry.getNetwork(attachment.networkId);
    const terminalWindow =
      attachment.terminalWindowId === undefined
        ? undefined
        : this.registry.getSnapshot().terminalWindows.find((item) => item.id === attachment.terminalWindowId);

    if (terminalWindow !== undefined) {
      const processRows = await this.listProcessRowsForTerminalControl();
      if (network?.runtimeKind === "container") {
        await sendCommandToTerminalWindow(terminalWindow, "exit", processRows, this.getTtyInputHelperPath()).catch(
          () => false,
        );
      } else if (network?.runtimeKind === "nativeHelper") {
        await sendCommandToTerminalWindow(
          terminalWindow,
          this.buildTerminalDetachScript(),
          processRows,
          this.getTtyInputHelperPath(),
        ).catch(() => false);
      }
    }

    if (attachment.id.startsWith(MANUAL_TERMINAL_ATTACHMENT_ID_PREFIX) && terminalWindow !== undefined) {
      await this.removeManualTerminalAttachmentMarkersForTerminalWindow(terminalWindow).catch(() => undefined);
    }

    return this.registry.removeAttachment(attachmentId);
  }

  /** True when a VS Code terminal already belongs to one logical network. */
  async isTerminalAttached(terminal: vscode.Terminal): Promise<boolean> {
    if (this.vscodeWindowTerminalBinding !== undefined) {
      void terminal;
      return true;
    }

    let processId: number | undefined;

    try {
      processId = await terminal.processId;
    } catch {
      processId = undefined;
    }

    return processId !== undefined && this.isTerminalProcessAttached(processId);
  }

  /** True when a process id maps to a tracked attached terminal root. */
  isTerminalProcessAttached(processId: number): boolean {
    return this.registry
      .getSnapshot()
      .attachments.some(
        (attachment) =>
          attachment.status === "attached" &&
          (attachment.rootPid === processId ||
            attachment.processGroupId === processId ||
            attachment.terminalWindowId === `vscode:${processId}`),
      );
  }

  /**
   * Associates an already-running local process with a logical network.
   *
   * This is intentionally weaker than terminal hook injection: it lets the
   * localhost logical router classify outgoing client connections from the
   * process, but it cannot retroactively rewrite already-loaded bind hooks.
   */
  async attachProcessToNetwork(networkId: string, pid: number, title?: string): Promise<TerminalAttachment> {
    requireNetwork(this.registry.getNetwork(networkId), networkId);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid process id: ${pid}`);
    }

    const processRows = await this.processTableProvider.list().catch(() => []);
    const processRow = processRows.find((row) => row.pid === pid);
    const attachment: TerminalAttachment = {
      id: createProcessTerminalAttachmentId(networkId, pid),
      networkId,
      rootPid: pid,
      processGroupId: processRow?.processGroupId,
      terminalTitle: title?.trim() || `Process ${pid}`,
      mode: "logical",
      status: "attached",
      attachedAt: new Date().toISOString(),
      errorMessage:
        "Existing process attachment routes localhost clients only. Restart it from an attached terminal for bind isolation.",
    };

    for (const existing of this.registry.getSnapshot().attachments) {
      if (existing.rootPid === pid || existing.id === attachment.id) {
        this.registry.removeAttachment(existing.id);
      }
    }

    return this.registry.addAttachment(attachment);
  }

  /**
   * Injects routing variables into the selected terminal window's current shell.
   * The command affects only processes launched after the attach action, which
   * matches the pre-bind constraint of the native socket hook.
   */
  async injectRoutingIntoTerminalWindow(
    terminalWindowId: string,
    networkId: string,
    settings: PortManagerSettings,
  ): Promise<TerminalRoutingInjectionResult> {
    requireNetwork(this.registry.getNetwork(networkId), networkId);

    const terminalWindow = this.registry
      .getSnapshot()
      .terminalWindows.find((window) => window.id === terminalWindowId);

    if (terminalWindow === undefined) {
      throw new Error(`Unknown terminal window: ${terminalWindowId}`);
    }

    if (!settings.enabled) {
      return { injected: false, reason: "Port Manager is disabled in settings." };
    }

    if (!shouldInjectTerminalHook(settings)) {
      return {
        injected: false,
        reason: `Native terminal routing is not supported on ${process.platform}.`,
      };
    }

    const script = this.buildTerminalRoutingScript(networkId, settings);
    const processRows = await this.listProcessRowsForTerminalControl();
    if (await sendRoutingScriptToVscodeTerminal(terminalWindow, script, processRows)) {
      return { injected: true };
    }

    if (await sendRoutingScriptToExternalTerminalWindow(terminalWindow, script, this.getTtyInputHelperPath())) {
      return { injected: true };
    }

    return {
      injected: false,
      reason:
        terminalWindow.terminalId === undefined
          ? `Could not find a controllable terminal session for "${terminalWindow.title}".`
          : `Could not inject routing into "${terminalWindow.title}" via VS Code API, generic PTY input, Terminal.app, or iTerm2.`,
    };
  }

  /** Creates and opens a host TCP exposure through the concrete proxy runtime. */
  async createExposure(input: HostPortExposureInput): Promise<HostPortExposure> {
    const network = requireNetwork(this.registry.getNetwork(input.networkId), input.networkId);
    const runtime = requireRuntime(this.registry.getSnapshot().runtimes, network.runtimeKind);

    if (!runtime.capabilities.supportsHostExposure) {
      throw new Error(`${runtime.name} does not support host port exposure.`);
    }

    ensureNoExposureConflict(this.registry.getSnapshot().exposures, input);

    const exposure: HostPortExposure = {
      id: createId("exposure"),
      networkId: input.networkId,
      hostAddress: input.hostAddress,
      hostPort: input.hostPort,
      targetAddress: input.targetAddress,
      targetPort: input.targetPort,
      protocol: "tcp",
      status: "opening",
      createdAt: new Date().toISOString(),
    };

    try {
      await this.proxyManager.open(exposure);
      return this.registry.addExposure({
        ...exposure,
        status: "active",
      });
    } catch (error) {
      await this.proxyManager.close(exposure.id);
      throw new Error(`Failed to expose ${input.hostAddress}:${input.hostPort}: ${formatError(error)}`);
    }
  }

  /** Closes and removes one host exposure. */
  async removeExposure(exposureId: string): Promise<HostPortExposure | undefined> {
    await this.proxyManager.close(exposureId);
    return this.registry.removeExposure(exposureId);
  }

  /** Returns one exposure row from the latest snapshot. */
  getExposure(exposureId: string): HostPortExposure | undefined {
    return this.registry.getSnapshot().exposures.find((exposure) => exposure.id === exposureId);
  }

  /** Creates a network-local logical port that forwards to a host-machine port. */
  createHostAccessBinding(input: HostAccessBindingInput): HostAccessBinding {
    requireNetwork(this.registry.getNetwork(input.networkId), input.networkId);
    ensureNoHostAccessConflict(this.registry.getSnapshot().hostAccessBindings, input);

    return this.registry.addHostAccessBinding({
      id: createId("host-access"),
      networkId: input.networkId,
      logicalPort: input.logicalPort,
      hostAddress: input.hostAddress,
      hostPort: input.hostPort,
      protocol: "tcp",
      status: "active",
      createdAt: new Date().toISOString(),
    });
  }

  /** Removes one network-to-host access binding. */
  removeHostAccessBinding(bindingId: string): HostAccessBinding | undefined {
    return this.registry.removeHostAccessBinding(bindingId);
  }

  /** Returns one network-to-host access binding from the latest snapshot. */
  getHostAccessBinding(bindingId: string): HostAccessBinding | undefined {
    return this.registry.getSnapshot().hostAccessBindings.find((binding) => binding.id === bindingId);
  }

  /**
   * Registers host-published compose service ports as network-local routes.
   *
   * Compose keeps running in Docker's own network, but attached terminal
   * clients see these endpoints as local logical-network services. When a
   * compose route exists for a named protocol port such as 15432, it shadows
   * the same host port; removing the attachment restores host fallback.
   */
  async attachComposePublishedPorts(input: ComposePublishedPortsInput): Promise<ComposeAttachment> {
    const network = requireNetwork(this.registry.getNetwork(input.networkId), input.networkId);
    if (this.processService === undefined) {
      throw new Error("Compose published ports require the Port Manager daemon.");
    }
    if (input.ports.length === 0) {
      throw new Error("At least one compose published port is required.");
    }
    if (input.composeMutation !== undefined && input.existingMutation !== undefined) {
      throw new Error("Compose attach cannot both mutate a project and reattach an existing clone.");
    }

    const attachment: ComposeAttachment = {
      id: createId("compose"),
      networkId: input.networkId,
      projectName: assertNonEmptyString(input.projectName, "Compose project name"),
      composeFiles: [...(input.composeFiles ?? [])],
      ports: input.ports.map(normalizeComposePublishedPort),
      status: "attached",
      attachedAt: new Date().toISOString(),
    };
    const registeredProcessIds: string[] = [];
    let registeredAttachment = attachment;
    let mutation: ComposePortMutationState | undefined;

    try {
      if (input.composeMutation !== undefined) {
        const mutationResult = await this.composePublishMutator.hidePublishedPorts({
          mode: input.composeMutation.mode,
          allowStatefulClone: input.composeMutation.allowStatefulClone,
          runtime: input.composeMutation.runtime,
          networkName: network.name,
          originalProjectName: attachment.projectName,
          workingDirectory: input.composeMutation.workingDirectory ?? input.cwd,
          composeFiles: input.composeMutation.composeFiles ?? input.composeFiles ?? [],
          ports: attachment.ports,
        });

        mutation = mutationResult.state;
        registeredAttachment = {
          ...attachment,
          composeFiles: mutation.composeFiles,
          ports: mutationResult.ports,
          mutation,
        };
      }
      if (input.existingMutation !== undefined) {
        mutation = input.existingMutation;
        registeredAttachment = {
          ...attachment,
          projectName: mutation.originalProjectName,
          composeFiles: mutation.composeFiles,
          ports: mutation.hiddenPorts,
          mutation,
        };
      }

      registeredAttachment = this.registry.addComposeAttachment(registeredAttachment);
      await this.processService.start();

      const ports: ComposePublishedPort[] = [];
      for (const port of registeredAttachment.ports) {
        const process = await this.processService.registerExistingProcess(
          buildComposeRegisteredProcessInput(
            registeredAttachment,
            port,
            input.cwd ?? mutation?.workingDirectory,
          ),
        );

        registeredProcessIds.push(process.id);
        ports.push({
          ...port,
          processId: process.id,
        });
      }

      return this.registry.updateComposeAttachment({
        ...registeredAttachment,
        ports,
      });
    } catch (error) {
      for (const processId of registeredProcessIds) {
        await this.processService.removeProcess(processId).catch(() => undefined);
      }
      if (mutation !== undefined) {
        await this.composePublishMutator.restorePublishedPorts(mutation).catch(() => undefined);
      }
      this.registry.removeComposeAttachment(attachment.id);
      throw error;
    }
  }

  /**
   * Detaches a compose attachment from Port Manager routing without mutating
   * Docker/Podman state. Hidden clone projects and standalone containers keep
   * running exactly as they are; only daemon route rows and registry state are
   * released so the logical network no longer owns those ports.
   */
  async detachComposeAttachment(attachmentId: string): Promise<ComposeAttachment | undefined> {
    const attachment = this.registry
      .getSnapshot()
      .composeAttachments.find((candidate) => candidate.id === attachmentId);

    if (attachment === undefined) {
      return undefined;
    }

    const removedAttachment = this.registry.removeComposeAttachment(attachmentId);
    await this.removeComposeRouteProcesses(attachment, attachment.ports);
    return removedAttachment;
  }

  /** Removes a compose route attachment and restores Docker/Podman state when Port Manager mutated it. */
  async removeComposeAttachment(attachmentId: string): Promise<ComposeAttachment | undefined> {
    const attachment = this.registry
      .getSnapshot()
      .composeAttachments.find((candidate) => candidate.id === attachmentId);

    if (attachment === undefined) {
      return undefined;
    }

    if (attachment.mutation !== undefined) {
      try {
        await this.composePublishMutator.restorePublishedPorts(attachment.mutation);
      } catch (error) {
        this.registry.updateComposeAttachment({
          ...attachment,
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const removedAttachment = this.registry.removeComposeAttachment(attachmentId);
    await this.removeComposeRouteProcesses(attachment, attachment.ports);
    return removedAttachment;
  }

  /** Returns one compose attachment from the latest snapshot. */
  getComposeAttachment(attachmentId: string): ComposeAttachment | undefined {
    return this.registry.getSnapshot().composeAttachments.find((attachment) => attachment.id === attachmentId);
  }

  /** Captures the selected network's bindings as a reusable preset. */
  saveBindingPreset(name: string, networkId: string): BindingPresetSummary {
    requireNetwork(this.registry.getNetwork(networkId), networkId);
    const snapshot = this.registry.getSnapshot();
    const now = new Date().toISOString();
    const preset: BindingPreset = {
      id: createId("binding-preset"),
      name,
      exposures: snapshot.exposures
        .filter((exposure) => exposure.networkId === networkId && exposure.protocol === "tcp")
        .map((exposure) => ({
          hostAddress: exposure.hostAddress,
          hostPort: exposure.hostPort,
          targetAddress: exposure.targetAddress,
          targetPort: exposure.targetPort,
        })),
      hostAccessBindings: snapshot.hostAccessBindings
        .filter((binding) => binding.networkId === networkId && binding.protocol === "tcp")
        .map((binding) => ({
          logicalPort: binding.logicalPort,
          hostAddress: binding.hostAddress,
          hostPort: binding.hostPort,
        })),
      createdAt: now,
      updatedAt: now,
    };
    const presets = this.loadBindingPresets().filter((item) => item.name !== name);

    this.saveBindingPresets([...presets, preset]);
    return {
      id: preset.id,
      name: preset.name,
      exposureCount: preset.exposures.length,
      hostAccessCount: preset.hostAccessBindings.length,
      updatedAt: preset.updatedAt,
    };
  }

  /** Applies a saved binding preset to the selected logical network. */
  async applyBindingPreset(presetId: string, networkId: string): Promise<BindingPresetSummary> {
    requireNetwork(this.registry.getNetwork(networkId), networkId);
    const preset = this.loadBindingPresets().find((item) => item.id === presetId);

    if (preset === undefined) {
      throw new Error(`Unknown binding preset: ${presetId}`);
    }

    for (const binding of preset.hostAccessBindings) {
      if (this.hasEquivalentHostAccessBinding(networkId, binding)) {
        continue;
      }

      this.createHostAccessBinding({
        networkId,
        logicalPort: binding.logicalPort,
        hostAddress: binding.hostAddress,
        hostPort: binding.hostPort,
      });
    }

    for (const exposure of preset.exposures) {
      if (this.hasEquivalentHostExposure(networkId, exposure)) {
        continue;
      }

      await this.createExposure({
        networkId,
        hostAddress: exposure.hostAddress,
        hostPort: exposure.hostPort,
        targetAddress: exposure.targetAddress,
        targetPort: exposure.targetPort,
      });
    }

    return {
      id: preset.id,
      name: preset.name,
      exposureCount: preset.exposures.length,
      hostAccessCount: preset.hostAccessBindings.length,
      updatedAt: preset.updatedAt,
    };
  }

  /** Sends native detach settings to one terminal and removes tracked attachments. */
  async resetTerminalNetworkSettings(terminalWindowId: string): Promise<number> {
    const snapshot = this.registry.getSnapshot();
    const terminalWindow = snapshot.terminalWindows.find((item) => item.id === terminalWindowId);

    if (terminalWindow === undefined) {
      throw new Error(`Unknown terminal window: ${terminalWindowId}`);
    }

    const relatedAttachments = snapshot.attachments.filter((attachment) => attachment.terminalWindowId === terminalWindowId);
    const shouldExitContainerShell = relatedAttachments.some(
      (attachment) => this.registry.getNetwork(attachment.networkId)?.runtimeKind === "container",
    );
    const resetCommand = shouldExitContainerShell ? "exit" : this.buildTerminalDetachScript();
    const processRows = await this.listProcessRowsForTerminalControl();

    await sendCommandToTerminalWindow(
      terminalWindow,
      resetCommand,
      processRows,
      this.getTtyInputHelperPath(),
    ).catch(() => false);
    await this.removeManualTerminalAttachmentMarkersForTerminalWindow(terminalWindow).catch(() => undefined);

    let removedCount = 0;
    for (const attachment of relatedAttachments) {
      this.registry.removeAttachment(attachment.id);
      removedCount++;
    }

    return removedCount;
  }

  /** Resets Port Manager routing environment in every discovered terminal. */
  async resetAllTerminalNetworkSettings(): Promise<TerminalNetworkResetSummary> {
    await this.refreshTerminals().catch(() => []);

    const terminalWindows = this.registry.getSnapshot().terminalWindows;
    let removedAttachmentCount = 0;

    for (const terminalWindow of terminalWindows) {
      removedAttachmentCount += await this.resetTerminalNetworkSettings(terminalWindow.id).catch(() => 0);
    }

    for (const attachment of this.registry.getSnapshot().attachments) {
      this.registry.removeAttachment(attachment.id);
      removedAttachmentCount++;
    }

    await this.detachVscodeWindowTerminalsFromNetwork().catch(() => undefined);
    await this.clearManualTerminalAttachmentMarkers().catch(() => undefined);

    return {
      terminalCount: terminalWindows.length,
      removedAttachmentCount,
    };
  }

  /**
   * Removes generated routing cache files and immediately rehydrates durable
   * attachment state. This is a recovery path for stale route JSON/TSV files;
   * it intentionally does not mutate Docker containers, volumes, or overrides.
   */
  async clearRoutingFiles(): Promise<RoutingFileCleanupSummary> {
    const cleanupPaths = await this.collectRoutingFileCleanupPaths();
    let removedFileCount = 0;
    let failedFileCount = 0;

    await Promise.all(
      [...cleanupPaths].map(async (filePath) => {
        try {
          await fs.rm(filePath, { force: true });
          removedFileCount++;
        } catch {
          failedFileCount++;
        }
      }),
    );

    await this.writeHostAccessBindingsFile().catch(() => undefined);
    await this.writeComposeProjectRoutingFile().catch(() => undefined);

    const attachments = this.registry
      .getSnapshot()
      .composeAttachments.filter((attachment) => attachment.status === "attached" && attachment.ports.length > 0);
    const restoredComposeRouteCount =
      this.processService === undefined ? 0 : attachments.reduce((sum, attachment) => sum + attachment.ports.length, 0);
    await this.restorePersistedComposeRoutes(attachments);

    return {
      removedFileCount,
      failedFileCount,
      restoredComposeRouteCount,
    };
  }

  /** Releases listeners and event subscriptions. */
  dispose(): void {
    if (this.composeAttachmentReconcileTimer !== undefined) {
      clearInterval(this.composeAttachmentReconcileTimer);
      this.composeAttachmentReconcileTimer = undefined;
    }

    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    this.registry.dispose();
    this.localChangeEvents.clear();
    void this.proxyManager.dispose();
    this.logicalPortRouter.dispose();
  }

  /** Reads persisted logical network state from VS Code global storage. */
  private loadState(): LogicalNetworkRegistryState | undefined {
    const sharedDocument = this.sharedNetworkStateStore.load();
    if (sharedDocument !== undefined) {
      this.sharedNetworkStateRevision = sharedDocument.revision;
      return sharedDocument.state;
    }

    const legacyState = this.context.globalState.get<LogicalNetworkRegistryState>(NETWORK_STATE_KEY);
    if (legacyState !== undefined) {
      const migratedDocument = this.sharedNetworkStateStore.save(legacyState);
      this.sharedNetworkStateRevision = migratedDocument.revision;
      return migratedDocument.state;
    }

    return undefined;
  }

  /** Persists durable logical network state. */
  private saveState(): void {
    if (this.applyingSharedNetworkState) {
      return;
    }

    const state = this.registry.getPersistedState();
    const signature = stringifyPersistedNetworkState(state);
    if (signature === this.persistedNetworkStateSignature) {
      return;
    }

    const document = this.sharedNetworkStateStore.save(state);
    this.sharedNetworkStateRevision = document.revision;
    this.persistedNetworkStateSignature = signature;
    void this.context.globalState.update(NETWORK_STATE_KEY, state);
  }

  /** Applies durable logical network state written by another VS Code window. */
  private async reloadSharedNetworkState(): Promise<void> {
    const document = this.sharedNetworkStateStore.load();
    if (document === undefined || document.revision === this.sharedNetworkStateRevision) {
      return;
    }

    const signature = stringifyPersistedNetworkState(document.state);
    this.sharedNetworkStateRevision = document.revision;
    if (signature === this.persistedNetworkStateSignature) {
      return;
    }

    this.persistedNetworkStateSignature = signature;
    this.applyingSharedNetworkState = true;
    try {
      this.registry.replacePersistedState(document.state);
    } finally {
      this.applyingSharedNetworkState = false;
    }

    await this.reopenPersistedExposures();
    await this.writeHostAccessBindingsFile();
    await this.writeComposeProjectRoutingFile();
    await this.restorePersistedComposeRoutesIfMissing();
    await this.reconcileComposeAttachmentPublishedPorts();
    await this.syncLogicalPortRouters();
  }

  /** Reads the current VS Code workspace/window terminal default. */
  private loadVscodeWindowTerminalBinding(): VscodeWindowTerminalBinding | undefined {
    const binding = this.context.workspaceState.get<VscodeWindowTerminalBinding>(VSCODE_WINDOW_TERMINAL_BINDING_KEY);
    if (binding === undefined || this.registry.getNetwork(binding.networkId) === undefined) {
      return undefined;
    }

    return binding;
  }

  /** Persists the VS Code workspace/window terminal default separately from host-global network state. */
  private saveVscodeWindowTerminalBinding(): void {
    void this.context.workspaceState.update(VSCODE_WINDOW_TERMINAL_BINDING_KEY, this.vscodeWindowTerminalBinding);
  }

  /** Clears stale window defaults when their logical network is removed. */
  private reconcileVscodeWindowTerminalBinding(): void {
    if (
      this.vscodeWindowTerminalBinding === undefined ||
      this.registry.getNetwork(this.vscodeWindowTerminalBinding.networkId) !== undefined
    ) {
      return;
    }

    this.vscodeWindowTerminalBinding = undefined;
    this.saveVscodeWindowTerminalBinding();
    this.applyVscodeWindowTerminalEnvironment();
    this.localChangeEvents.emit();
  }

  /** Updates VS Code's new-terminal environment for the current window/workspace. */
  private applyVscodeWindowTerminalEnvironment(): void {
    const networkId = this.vscodeWindowTerminalBinding?.networkId;

    applyTerminalHookEnvironment(
      this.context,
      networkId === undefined
        ? undefined
        : {
            networkId,
            composeRoutingFilePath: this.getComposeProjectRoutingFilePath(networkId),
          },
    );
  }

  /** Sends the current network routing script to all already-open VS Code terminals. */
  private async injectRoutingIntoOpenVscodeTerminals(
    networkId: string,
    settings: PortManagerSettings,
  ): Promise<number> {
    const injectedTerminalCount = sendCommandToOpenVscodeTerminals(
      this.buildTerminalRoutingScript(networkId, settings),
    );
    await this.refreshTerminals().catch(() => []);
    return injectedTerminalCount;
  }

  /** Reads process rows used only to match VS Code Terminal objects to OS-discovered TTY rows. */
  private async listProcessRowsForTerminalControl(): Promise<readonly ProcessTableRow[]> {
    return this.processTableProvider.list().catch(() => []);
  }

  /** Packaged helper used to inject commands into generic PTY-backed terminal sessions. */
  private getTtyInputHelperPath(): string {
    return this.context.asAbsolutePath(getTtyInputHelperRelativePath());
  }

  /** Reads saved binding presets from VS Code global state. */
  private loadBindingPresets(): readonly BindingPreset[] {
    return this.context.globalState.get<readonly BindingPreset[]>(BINDING_PRESETS_KEY) ?? [];
  }

  /** Persists saved binding presets in VS Code global state. */
  private saveBindingPresets(presets: readonly BindingPreset[]): void {
    void this.context.globalState.update(BINDING_PRESETS_KEY, presets);
  }

  /** True when applying a preset would recreate the same host access row. */
  private hasEquivalentHostAccessBinding(networkId: string, preset: BindingPresetHostAccess): boolean {
    return this.registry
      .getSnapshot()
      .hostAccessBindings.some(
        (binding) =>
          binding.networkId === networkId &&
          binding.protocol === "tcp" &&
          binding.logicalPort === preset.logicalPort &&
          binding.hostAddress === preset.hostAddress &&
          binding.hostPort === preset.hostPort,
      );
  }

  /** True when applying a preset would recreate the same host exposure row. */
  private hasEquivalentHostExposure(networkId: string, preset: BindingPresetExposure): boolean {
    return this.registry
      .getSnapshot()
      .exposures.some(
        (exposure) =>
          exposure.networkId === networkId &&
          exposure.protocol === "tcp" &&
          exposure.hostAddress === preset.hostAddress &&
          exposure.hostPort === preset.hostPort &&
          exposure.targetAddress === preset.targetAddress &&
          exposure.targetPort === preset.targetPort,
      );
  }

  /**
   * Restores active proxy listeners after extension reload. If a host port is
   * now occupied, the exposure remains visible with an error status.
   */
  private async reopenPersistedExposures(): Promise<void> {
    for (const exposure of this.registry.getSnapshot().exposures) {
      if (exposure.status !== "active") {
        continue;
      }

      try {
        await this.proxyManager.open(exposure);
      } catch (error) {
        this.registry.updateExposure({
          ...exposure,
          status: "error",
          errorMessage: formatError(error),
        });
      }
    }
  }

  /**
   * Rehydrates persisted compose attachments into the singleton daemon.
   *
   * Compose attachment rows live in VS Code globalState, while route rows live in
   * the shared daemon. A daemon restart can therefore leave hidden clone
   * containers running with an empty route table. Re-registering the endpoints is
   * idempotent because the daemon upserts compose routes by network/logical/actual
   * port identity.
   */
  private async restorePersistedComposeRoutesIfMissing(): Promise<void> {
    if (this.composeAttachmentReconcileInFlight !== undefined) {
      return;
    }

    if (this.composeRouteRestoreInFlight !== undefined) {
      return this.composeRouteRestoreInFlight;
    }

    const attachments = this.registry
      .getSnapshot()
      .composeAttachments.filter((attachment) => attachment.status === "attached" && attachment.ports.length > 0);
    if (attachments.length === 0 || this.processService === undefined || !this.hasMissingPersistedComposeRoutes(attachments)) {
      return;
    }

    this.composeRouteRestoreInFlight = this.restorePersistedComposeRoutes(attachments).finally(() => {
      this.composeRouteRestoreInFlight = undefined;
    });

    return this.composeRouteRestoreInFlight;
  }

  /**
   * Repairs clone attachments that were accidentally registered from the clone.
   *
   * When a Port Manager-generated compose project is attached as-is, Docker's
   * hidden host port can be persisted as the logical port. The discovery adapter
   * can recover the original host port from stopped original containers, then
   * the normal compose route restore path re-registers the daemon rows.
   */
  private async repairPersistedPortManagerCloneComposeAttachments(): Promise<void> {
    const attachments = this.registry
      .getSnapshot()
      .composeAttachments.filter((attachment) => attachment.status === "attached" && attachment.mutation === undefined);

    if (attachments.length === 0) {
      return;
    }

    const settings = readContainerRuntimeSettings();
    for (const attachment of attachments) {
      const recoveredPorts = await this.containerServiceDiscovery
        .recoverPortManagerClonePorts(settings, attachment.composeFiles, attachment.ports)
        .catch(() => attachment.ports);

      if (!composePortsChanged(attachment.ports, recoveredPorts)) {
        continue;
      }

      if (this.processService !== undefined) {
        await this.processService.start().catch(() => undefined);
        await Promise.all(
          attachment.ports
            .map((port) => port.processId)
            .filter((processId): processId is string => processId !== undefined)
            .map((processId) => this.processService!.removeProcess(processId).catch(() => undefined)),
        );
      }

      this.registry.updateComposeAttachment({
        ...attachment,
        ports: recoveredPorts.map(dropComposeProcessId),
      });
    }
  }

  /**
   * Starts a low-frequency Docker poll that keeps hidden compose endpoints live.
   *
   * Docker assigns a fresh localhost port to `HostPort: ""` bindings whenever a
   * clone container is recreated. The logical port must remain stable, but the
   * daemon route row has to follow that concrete hidden port.
   */
  private startComposeAttachmentReconcileLoop(): void {
    if (this.composeAttachmentReconcileTimer !== undefined) {
      return;
    }

    this.composeAttachmentReconcileTimer = setInterval(() => {
      void this.reconcileComposeAttachmentPublishedPorts();
    }, COMPOSE_ATTACHMENT_RECONCILE_INTERVAL_MS);
  }

  /** Rewrites compose route rows when Docker changed a running container's host port. */
  private async reconcileComposeAttachmentPublishedPorts(): Promise<void> {
    if (this.composeAttachmentReconcileInFlight !== undefined) {
      return this.composeAttachmentReconcileInFlight;
    }

    this.composeAttachmentReconcileInFlight = this.reconcileComposeAttachmentPublishedPortsExclusive().finally(() => {
      this.composeAttachmentReconcileInFlight = undefined;
    });

    return this.composeAttachmentReconcileInFlight;
  }

  /** Performs one serialized live compose endpoint reconciliation pass. */
  private async reconcileComposeAttachmentPublishedPortsExclusive(): Promise<void> {
    if (this.processService === undefined) {
      return;
    }

    const attachments = this.registry
      .getSnapshot()
      .composeAttachments.filter((attachment) => attachment.status === "attached" && attachment.ports.length > 0);
    if (attachments.length === 0) {
      return;
    }

    const settings = readContainerRuntimeSettings();
    const restoredAttachments: ComposeAttachment[] = [];

    for (const attachment of attachments) {
      const refreshedPorts = await this.containerServiceDiscovery
        .refreshComposePublishedPorts(
          settings,
          composeRuntimeProjectName(attachment),
          attachment.composeFiles,
          attachment.ports,
        )
        .catch(() => attachment.ports);
      const refreshedMutation = await this.refreshComposeContainerMappings(attachment, settings);
      const portsChanged = composePortsChanged(attachment.ports, refreshedPorts);
      const mappingsChanged = composeContainerMappingsChanged(
        attachment.mutation?.containerMappings ?? [],
        refreshedMutation?.containerMappings ?? [],
      );

      if (!portsChanged && !mappingsChanged) {
        continue;
      }

      if (portsChanged) {
        await this.processService.start();
        await this.removeComposeRouteProcesses(attachment, attachment.ports);
      }

      restoredAttachments.push(
        this.registry.updateComposeAttachment({
          ...attachment,
          ports: portsChanged ? refreshedPorts.map(dropComposeProcessId) : attachment.ports,
          ...(refreshedMutation !== undefined ? { mutation: refreshedMutation } : {}),
          status: "attached",
          errorMessage: undefined,
        }),
      );
    }

    if (restoredAttachments.length > 0) {
      await this.restorePersistedComposeRoutes(restoredAttachments);
      void this.syncLogicalPortRouters();
    }
  }

  /** Refreshes clone container id rewrites without changing attach policy state. */
  private async refreshComposeContainerMappings(
    attachment: ComposeAttachment,
    settings: ReturnType<typeof readContainerRuntimeSettings>,
  ): Promise<ComposePortMutationState | undefined> {
    const mutation = attachment.mutation;
    if (
      mutation === undefined ||
      mutation.mode !== "clone" ||
      mutation.containerMappings === undefined ||
      mutation.containerMappings.length === 0
    ) {
      return mutation;
    }

    const containerMappings = await this.containerServiceDiscovery
      .refreshComposeContainerMappings(
        settings,
        mutation.originalProjectName,
        mutation.attachedProjectName,
        mutation.composeFiles,
        mutation.services,
        mutation.containerMappings,
      )
      .catch(() => mutation.containerMappings);

    return {
      ...mutation,
      containerMappings,
    };
  }

  /** Removes old daemon rows before the same logical route is re-registered with a new actual port. */
  private async removeComposeRouteProcesses(
    attachment: ComposeAttachment,
    ports: readonly ComposePublishedPort[],
  ): Promise<void> {
    if (this.processService === undefined) {
      return;
    }

    const processIds = new Set<string>();
    for (const port of ports) {
      if (port.processId !== undefined) {
        processIds.add(port.processId);
      }
    }

    const snapshot = this.processService.getSnapshot();
    for (const process of snapshot.processes) {
      if (ports.some((port) => isComposeProcessForPort(process, attachment, port))) {
        processIds.add(process.id);
      }
    }

    await Promise.all(
      [...processIds].map((processId) => this.processService!.removeProcess(processId).catch(() => undefined)),
    );
  }

  /** Returns true when at least one persisted compose endpoint is absent from the daemon snapshot. */
  private hasMissingPersistedComposeRoutes(attachments: readonly ComposeAttachment[]): boolean {
    if (this.processService === undefined) {
      return false;
    }

    const routes = this.processService.getSnapshot().routes;
    return attachments.some((attachment) =>
      attachment.ports.some((port) => !hasComposeRoute(routes, attachment.networkId, port)),
    );
  }

  /** Registers every persisted compose endpoint and updates stale process ids. */
  private async restorePersistedComposeRoutes(attachments: readonly ComposeAttachment[]): Promise<void> {
    if (this.processService === undefined) {
      return;
    }

    await this.processService.start();

    for (const attachment of attachments) {
      const ports: ComposePublishedPort[] = [];

      try {
        const cwd = attachment.mutation?.workingDirectory ?? composeWorkingDirectoryFromFiles(attachment.composeFiles);
        for (const port of attachment.ports) {
          const process = await this.processService.registerExistingProcess(
            buildComposeRegisteredProcessInput(attachment, port, cwd),
          );

          ports.push({
            ...port,
            processId: process.id,
          });
        }

        this.registry.updateComposeAttachment({
          ...attachment,
          ports,
          status: "attached",
          errorMessage: undefined,
        });
      } catch (error) {
        this.registry.updateComposeAttachment({
          ...attachment,
          status: "error",
          errorMessage: formatError(error),
        });
      }
    }
  }

  /**
   * Resolves a network-owned host binding to the live process port. The binding
   * stores the network-local logical port, while the daemon snapshot carries the
   * current actual port assigned by the native hook.
   */
  private async resolveHostExposureTarget(exposure: HostPortExposure): Promise<HostPortProxyTarget> {
    const network = this.registry.getNetwork(exposure.networkId);
    if (network?.runtimeKind === "container") {
      return toHostPortProxyTarget(await this.containerRuntime.resolveExposureTarget(exposure));
    }

    const route = await this.findNetworkRoute(exposure.networkId, exposure.targetPort);

    if (route !== undefined) {
      return {
        host: route.host,
        port: route.actualPort,
      };
    }

    return {
      host: exposure.targetAddress,
      port: exposure.targetPort,
    };
  }

  /**
   * Resolves a raw localhost logical-port connection to a network route.
   * This path is intentionally application-agnostic: it uses only the accepted
   * TCP tuple, process table ancestry, terminal attachments, and route rows.
   */
  private async resolveLogicalPortRouterTarget(
    connection: LogicalPortRouterConnection,
  ): Promise<LogicalPortRouterTarget> {
    const clientProcess = await this.tcpConnectionProcessResolver.resolveClientProcess(connection);
    const processRows = await this.processTableProvider.list().catch(() => []);
    const networkId =
      clientProcess === undefined ? undefined : await this.findClientNetworkForRouter(clientProcess.pid, processRows);

    if (networkId === undefined) {
      const cwdRoute =
        clientProcess?.cwd === undefined
          ? undefined
          : this.findClientCwdRouteForRouter(connection.logicalPort, clientProcess.cwd, processRows);

      if (cwdRoute !== undefined) {
        return {
          host: cwdRoute.host,
          port: cwdRoute.actualPort,
        };
      }

      const uniqueRoute = await this.findUniqueRouteForRouter(connection.logicalPort, processRows);
      if (uniqueRoute === undefined) {
        throw new Error(`No attached logical network found for localhost:${connection.logicalPort} client.`);
      }

      return {
        host: uniqueRoute.host,
        port: uniqueRoute.actualPort,
      };
    }

    const route = await this.findNetworkRouteForRouter(networkId, connection.logicalPort, processRows);
    if (route === undefined) {
      throw new Error(`No route for logical port ${connection.logicalPort} in ${networkId}.`);
    }

    return {
      host: route.host,
      port: route.actualPort,
    };
  }

  /** Opens localhost routers for every active logical route currently known. */
  private async syncLogicalPortRouters(): Promise<void> {
    if (this.processService === undefined) {
      return;
    }

    const logicalPorts = this.processService
      .getSnapshot()
      .routes.filter(
        (route) =>
          route.actualPort !== route.logicalPort &&
          isListenRoute(route) &&
          (route.status === "running" || route.status === "starting"),
      )
      .map((route) => route.logicalPort);

    await this.logicalPortRouter.sync(logicalPorts).catch(() => undefined);
  }

  /**
   * Resolves the caller's network from the most direct runtime signal first.
   * Native hook clients inherit PORT_MANAGER_NETWORK_ID even when VS Code's
   * terminal attachment snapshot cannot map a deep process tree reliably.
   */
  private async findClientNetworkForRouter(
    pid: number,
    processRows: readonly ProcessTableRow[],
  ): Promise<string | undefined> {
    const environmentNetworkId = await this.processEnvironmentProvider.readRoutingNetworkId(pid).catch(() => undefined);

    return environmentNetworkId ?? this.findAttachedNetworkForPid(pid, processRows);
  }

  /** Finds a route that belongs to the caller's terminal-bound logical network. */
  private async findNetworkRouteForRouter(
    networkId: string,
    logicalPort: number,
    processRows: readonly ProcessTableRow[],
  ): Promise<LogicalPortRoute | undefined> {
    if (this.processService === undefined) {
      return undefined;
    }

    const snapshot = this.processService.getSnapshot();
    const candidates = snapshot.routes.filter(
      (route) =>
        route.logicalPort === logicalPort &&
        isListenRoute(route) &&
        (route.status === "running" || route.status === "starting"),
    );
    const exactRoute = candidates.find((route) => route.networkId === networkId);

    if (exactRoute !== undefined) {
      return exactRoute;
    }

    for (const route of candidates) {
      const process = route.processId === undefined ? undefined : snapshot.processes.find((item) => item.id === route.processId);
      const routeNetworkId =
        route.networkId ?? process?.networkId ?? (process === undefined ? undefined : this.findAttachedNetworkForPid(process.pid, processRows));

      if (routeNetworkId === networkId) {
        return route;
      }
    }

    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /**
   * Allows host-side tooling to reach unambiguous routed ports.
   * Debug adapters and browsers can originate outside an attached terminal; a
   * single live route is still safe because there is no network choice to make.
   */
  private async findUniqueRouteForRouter(
    logicalPort: number,
    processRows: readonly ProcessTableRow[],
  ): Promise<LogicalPortRoute | undefined> {
    if (this.processService === undefined) {
      return undefined;
    }

    const snapshot = this.processService.getSnapshot();
    const candidates = snapshot.routes.filter(
      (route) =>
        route.logicalPort === logicalPort &&
        route.actualPort !== route.logicalPort &&
        isListenRoute(route) &&
        (route.status === "running" || route.status === "starting"),
    );

    /*
     * Compose/container attachments deliberately shadow host-published ports
     * only inside their owning logical network. Host-side fallback would make
     * those services reachable without network membership, so exclude them.
     */
    const fallbackCandidates = candidates.filter((route) => !isNetworkScopedComposeRoute(route));

    if (fallbackCandidates.length === 1) {
      return fallbackCandidates[0];
    }

    return this.findSingleAttachedRouteForRouter(fallbackCandidates, snapshot.processes, processRows);
  }

  /**
   * Uses client cwd as a deterministic fallback when environment variables and
   * terminal ancestry are unavailable. This keeps simultaneous logical ports in
   * sibling projects from collapsing into the global "unique route" fallback.
   */
  private findClientCwdRouteForRouter(
    logicalPort: number,
    clientCwd: string,
    processRows: readonly ProcessTableRow[],
  ): LogicalPortRoute | undefined {
    if (this.processService === undefined) {
      return undefined;
    }

    const snapshot = this.processService.getSnapshot();
    const candidates = findRoutesMatchingClientCwd(snapshot.routes, logicalPort, clientCwd);

    if (candidates.length === 1) {
      return candidates[0];
    }

    return this.findSingleAttachedRouteForRouter(candidates, snapshot.processes, processRows);
  }

  /**
   * Falls back to the only attached network candidate when a host-side client
   * cannot be mapped back to a terminal PID. This keeps launcher chains that
   * briefly lose hook metadata from failing just because stale rows from another
   * network still exist in the daemon snapshot.
   */
  private findSingleAttachedRouteForRouter(
    candidates: readonly LogicalPortRoute[],
    processes: readonly ManagedProcess[],
    processRows: readonly ProcessTableRow[],
  ): LogicalPortRoute | undefined {
    const attachedNetworkIds = new Set(
      this.registry
        .getSnapshot()
        .attachments.filter((attachment) => attachment.status === "attached")
        .map((attachment) => attachment.networkId),
    );
    const candidateByNetworkId = new Map<string, LogicalPortRoute>();

    for (const route of candidates) {
      const process =
        route.processId === undefined ? undefined : processes.find((item) => item.id === route.processId);
      const routeNetworkId =
        route.networkId ??
        process?.networkId ??
        (process === undefined ? undefined : this.findAttachedNetworkForPid(process.pid, processRows));

      if (routeNetworkId !== undefined && attachedNetworkIds.has(routeNetworkId)) {
        candidateByNetworkId.set(routeNetworkId, route);
      }
    }

    return candidateByNetworkId.size === 1 ? [...candidateByNetworkId.values()][0] : undefined;
  }

  /** Maps an arbitrary process PID back to the network attached to its terminal. */
  private findAttachedNetworkForPid(pid: number, processRows: readonly ProcessTableRow[]): string | undefined {
    const attachments = this.registry.getSnapshot().attachments.filter((attachment) => attachment.status === "attached");
    const directAttachment = attachments.find((attachment) => attachment.rootPid === pid);
    if (directAttachment !== undefined) {
      return directAttachment.networkId;
    }

    const processContext = buildProcessTreeContext(processRows, pid);

    if (processContext === undefined) {
      return undefined;
    }

    for (const attachment of attachments) {
      if (processContext.ancestorPids.includes(attachment.rootPid)) {
        return attachment.networkId;
      }

      if (
        attachment.processGroupId !== undefined &&
        processContext.row.processGroupId === attachment.processGroupId
      ) {
        return attachment.networkId;
      }

      if (
        attachment.terminalWindowId?.startsWith("tty:") &&
        processContext.row.terminalId === attachment.terminalWindowId.slice("tty:".length)
      ) {
        return attachment.networkId;
      }
    }

    return undefined;
  }

  /** Rebuilds runtime descriptors from native hook support and installed container tools. */
  private async refreshRuntimeDescriptors(): Promise<void> {
    const nativeDescriptor = buildNativeHookRuntimeDescriptor(readPortManagerSettings());
    const containerDescriptor = await this.containerRuntime
      .detect(readContainerRuntimeSettings())
      .catch(() => undefined);
    this.registry.setRuntimes([
      ...(nativeDescriptor === undefined ? [] : [nativeDescriptor]),
      ...(containerDescriptor === undefined ? [] : [containerDescriptor]),
      ...BASE_RUNTIMES,
    ]);
  }

  /** Looks up the latest route for one network-local logical target port. */
  private async findNetworkRoute(networkId: string, logicalPort: number): Promise<LogicalPortRoute | undefined> {
    const currentRoute = findMatchingRoute(this.processService?.getSnapshot().routes ?? [], networkId, logicalPort);
    if (currentRoute !== undefined || this.processService === undefined) {
      return currentRoute;
    }

    await this.processService.refresh().catch(() => undefined);
    return findMatchingRoute(this.processService.getSnapshot().routes, networkId, logicalPort);
  }

  /** Writes network-to-host bindings for native connect hooks in attached terminals. */
  private async writeHostAccessBindingsFile(): Promise<void> {
    const bindings = this.registry
      .getSnapshot()
      .hostAccessBindings.filter((binding) => binding.status === "active" && binding.protocol === "tcp");
    const filePath = getDefaultHostAccessBindingsPath();

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          bindings,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  /**
   * Writes clone compose project mappings consumed by attached terminal shell
   * wrappers. This is separate from port routes because `docker compose` chooses
   * the project before any application socket can be intercepted.
   */
  private async writeComposeProjectRoutingFile(): Promise<void> {
    const rows = buildComposeProjectRoutingRows(this.registry.getSnapshot().composeAttachments);
    const snapshot = this.registry.getSnapshot();
    const globalFilePath = this.getComposeProjectRoutingFilePath();
    const currentScopedPaths = new Set<string>();

    await fs.mkdir(path.dirname(globalFilePath), { recursive: true });
    await fs.writeFile(globalFilePath, "", "utf8");

    for (const network of snapshot.networks) {
      const scopedFilePath = this.getComposeProjectRoutingFilePath(network.id);
      currentScopedPaths.add(scopedFilePath);
      await fs.writeFile(scopedFilePath, "", "utf8");
    }

    for (const row of rows) {
      const scopedFilePath = this.getComposeProjectRoutingFilePath(row.networkId, composeProjectRoutingRowScope(row));
      currentScopedPaths.add(scopedFilePath);
      await fs.writeFile(scopedFilePath, serializeComposeProjectRoutingRows([row]), "utf8");
    }

    await this.removeStaleComposeProjectRoutingFiles(currentScopedPaths);
  }

  /** Stable path read by shell wrappers installed into network-attached terminals. */
  private getComposeProjectRoutingFilePath(networkId?: string, composeScope?: string): string {
    if (networkId === undefined || networkId.trim().length === 0) {
      return path.join(this.context.globalStorageUri.fsPath, COMPOSE_PROJECT_ROUTING_FILE_NAME);
    }

    const networkScope = sanitizeRouteFileScope(networkId);
    const suffix =
      composeScope === undefined
        ? ".tsv"
        : `${COMPOSE_PROJECT_ROUTING_COMPOSE_SEPARATOR}${sanitizeRouteFileScope(composeScope)}.tsv`;

    return path.join(
      this.context.globalStorageUri.fsPath,
      `${COMPOSE_PROJECT_ROUTING_FILE_PREFIX}${networkScope}${suffix}`,
    );
  }

  /** Removes scoped compose maps for deleted networks so stale terminals fail closed. */
  private async removeStaleComposeProjectRoutingFiles(currentScopedPaths: ReadonlySet<string>): Promise<void> {
    let entries: readonly Dirent[];

    try {
      entries = await fs.readdir(this.context.globalStorageUri.fsPath, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith(COMPOSE_PROJECT_ROUTING_FILE_PREFIX) &&
            entry.name.endsWith(".tsv"),
        )
        .map((entry) => path.join(this.context.globalStorageUri.fsPath, entry.name))
        .filter((filePath) => !currentScopedPaths.has(filePath))
        .map((filePath) => fs.rm(filePath, { force: true }).catch(() => undefined)),
    );
  }

  /** Collects only generated routing cache files that can be recreated from durable state. */
  private async collectRoutingFileCleanupPaths(): Promise<ReadonlySet<string>> {
    const filePaths = new Set<string>();

    await this.collectMatchingFiles(path.dirname(getDefaultRouteTablePath()), (entryName) =>
      isGeneratedRouteTableFile(entryName, getDefaultRouteTablePath()),
    ).then((paths) => paths.forEach((filePath) => filePaths.add(filePath)));

    await this.collectMatchingFiles(path.dirname(getDefaultHostAccessBindingsPath()), (entryName) =>
      isGeneratedHostAccessFile(entryName, getDefaultHostAccessBindingsPath()),
    ).then((paths) => paths.forEach((filePath) => filePaths.add(filePath)));

    await this.collectMatchingFiles(this.context.globalStorageUri.fsPath, (entryName) =>
      entryName === COMPOSE_PROJECT_ROUTING_FILE_NAME ||
      (entryName.startsWith(COMPOSE_PROJECT_ROUTING_FILE_PREFIX) && entryName.endsWith(".tsv")),
    ).then((paths) => paths.forEach((filePath) => filePaths.add(filePath)));

    return filePaths;
  }

  /** Lists generated files in one directory without letting cleanup fail on missing folders. */
  private async collectMatchingFiles(
    directoryPath: string,
    matches: (entryName: string) => boolean,
  ): Promise<readonly string[]> {
    let entries: readonly Dirent[];

    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isFile() && matches(entry.name))
      .map((entry) => path.join(directoryPath, entry.name));
  }

  /**
   * Reconciles marker files written by manually pasted routing scripts with
   * the normal attachment registry. Custom terminal UIs can run the same shell
   * script without exposing a VS Code Terminal object, so tty/pid markers are
   * the generic handoff from shell state back to the extension UI.
   */
  private async syncManualTerminalAttachmentMarkers(processRows: readonly ProcessTableRow[]): Promise<void> {
    const markers = await this.readManualTerminalAttachmentMarkers();
    const snapshot = this.registry.getSnapshot();
    const terminalWindows = snapshot.terminalWindows;
    const liveProcessIds = new Set(processRows.map((row) => row.pid));
    const existingManualAttachments = snapshot.attachments.filter((attachment) =>
      attachment.id.startsWith(MANUAL_TERMINAL_ATTACHMENT_ID_PREFIX),
    );
    const nextAttachments: TerminalAttachment[] = [];
    const staleMarkerPaths: string[] = [];

    for (const marker of markers) {
      const network = this.registry.getNetwork(marker.networkId);
      const terminalWindow = findTerminalWindowForMarker(marker, terminalWindows);

      if (network === undefined) {
        staleMarkerPaths.push(marker.filePath);
        continue;
      }

      if (terminalWindow === undefined) {
        if (marker.pid !== undefined && !liveProcessIds.has(marker.pid)) {
          staleMarkerPaths.push(marker.filePath);
        }
        continue;
      }

      const existingNonManualAttachment = snapshot.attachments.find(
        (attachment) =>
          !attachment.id.startsWith(MANUAL_TERMINAL_ATTACHMENT_ID_PREFIX) &&
          (attachment.terminalWindowId === terminalWindow.id || attachment.rootPid === terminalWindow.rootPid),
      );

      if (existingNonManualAttachment !== undefined) {
        continue;
      }

      nextAttachments.push({
        id: createManualTerminalAttachmentId(marker.networkId, terminalWindow.id),
        networkId: network.id,
        rootPid: terminalWindow.rootPid,
        processGroupId: terminalWindow.processGroupId ?? marker.processGroupId,
        terminalWindowId: terminalWindow.id,
        terminalTitle: terminalWindow.title,
        mode: "isolated",
        status: "attached",
        attachedAt: marker.attachedAt,
      });
    }

    for (const attachment of existingManualAttachments) {
      this.registry.removeAttachment(attachment.id);
    }

    for (const attachment of nextAttachments) {
      this.registry.addAttachment(attachment);
    }

    for (const markerPath of staleMarkerPaths) {
      await fs.rm(markerPath, { force: true }).catch(() => undefined);
    }
  }

  /** Removes process-only attachments after their owner PID exits. */
  private syncProcessAttachmentLiveness(processRows: readonly ProcessTableRow[]): void {
    const liveProcessIds = new Set(processRows.map((row) => row.pid));

    for (const attachment of this.registry.getSnapshot().attachments) {
      if (
        attachment.id.startsWith(PROCESS_TERMINAL_ATTACHMENT_ID_PREFIX) &&
        !liveProcessIds.has(attachment.rootPid)
      ) {
        this.registry.removeAttachment(attachment.id);
      }
    }
  }

  /** Reads all manually pasted terminal attachment markers from global storage. */
  private async readManualTerminalAttachmentMarkers(): Promise<readonly TerminalAttachmentMarker[]> {
    const markerDirectory = this.getTerminalAttachmentMarkerDirectoryPath();
    let entries: readonly Dirent[];

    try {
      entries = await fs.readdir(markerDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    const markers: TerminalAttachmentMarker[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".tsv")) {
        continue;
      }

      const filePath = path.join(markerDirectory, entry.name);
      const contents = await fs.readFile(filePath, "utf8").catch(() => undefined);
      const marker = contents === undefined ? undefined : parseTerminalAttachmentMarker(contents, filePath);

      if (marker !== undefined) {
        markers.push(marker);
      }
    }

    return markers;
  }

  /** Removes marker files that belong to one visible terminal window. */
  private async removeManualTerminalAttachmentMarkersForTerminalWindow(
    terminalWindow: TerminalWindow,
  ): Promise<void> {
    const markers = await this.readManualTerminalAttachmentMarkers();

    await Promise.all(
      markers
        .filter((marker) => isTerminalWindowMarkerMatch(marker, terminalWindow))
        .map((marker) => fs.rm(marker.filePath, { force: true }).catch(() => undefined)),
    );
  }

  /** Removes marker files scoped to a network being deleted. */
  private async removeManualTerminalAttachmentMarkersForNetwork(networkId: string): Promise<void> {
    const markers = await this.readManualTerminalAttachmentMarkers();

    await Promise.all(
      markers
        .filter((marker) => marker.networkId === networkId)
        .map((marker) => fs.rm(marker.filePath, { force: true }).catch(() => undefined)),
    );
  }

  /** Clears every manual marker when the user asks for a global terminal reset. */
  private async clearManualTerminalAttachmentMarkers(): Promise<void> {
    await fs.rm(this.getTerminalAttachmentMarkerDirectoryPath(), { recursive: true, force: true });
  }

  /** Directory shared between copied shell snippets and extension-side refresh. */
  private getTerminalAttachmentMarkerDirectoryPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, TERMINAL_ATTACHMENT_MARKER_DIRECTORY_NAME);
  }

  /** Builds the shell commands that make later child processes join one logical network scope. */
  private buildTerminalRoutingScript(networkId: string, settings: PortManagerSettings): string {
    const hookLibraryPath = this.context.asAbsolutePath(getHookLibraryRelativePath());
    const agentMainPath = this.context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
    const nativeAgentPath = this.context.asAbsolutePath(path.join("media", "native", "portmanager_agent"));
    const nativeContainerMapPath = this.context.asAbsolutePath(path.join("media", "native", "portmanager_container_map"));
    const asdfShimLauncherPath = this.context.asAbsolutePath(getAsdfShimLauncherRelativePath());
    const runtimeCommandShimPath = this.context.asAbsolutePath(getRuntimeCommandShimRelativePath());
    const runtimeShimDirectory = prepareRuntimeShimLauncherDirectory(
      this.context.globalStorageUri.fsPath,
      asdfShimLauncherPath,
      runtimeCommandShimPath,
    );
    const shellEnvRestorePath = prepareShellEnvRestoreScript(this.context.globalStorageUri.fsPath, hookLibraryPath, {
      networkId,
      composeRoutingFilePath: this.getComposeProjectRoutingFilePath(networkId),
      dockerShimPath: runtimeCommandShimPath,
    });
    const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
    const commands = [
      shellExport("PORT_MANAGER_HOOK", "1"),
      shellExport("PORT_MANAGER_NETWORK_ID", networkId),
      shellExport("PORT_MANAGER_ROUTE_TABLE_NETWORK_ID", networkId),
      shellExport("PORT_MANAGER_BORROWED_NETWORK_ID", networkId),
      shellExport("NEWDLOPS_PM_NETWORK_ID", networkId),
      shellExport("NEWDLOPS_PM_BORROWED_NETWORK_ID", networkId),
      shellExport("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath()),
      shellExport("PORT_MANAGER_AGENT_MAIN", agentMainPath),
      shellExport("PORT_MANAGER_AGENT_EXECUTABLE", nativeAgentPath),
      shellExport("PORT_MANAGER_CONTAINER_MAP_HELPER", nativeContainerMapPath),
      shellExport(DOCKER_SHIM_PATH_ENV, runtimeCommandShimPath),
      shellExport("PORT_MANAGER_ROUTES_FILE", getRouteTablePathForNetwork(networkId)),
      shellExport("PORT_MANAGER_GLOBAL_ROUTES_FILE", getDefaultRouteTablePath()),
      shellExport("PORT_MANAGER_HOST_ACCESS_FILE", getDefaultHostAccessBindingsPath()),
      shellExport("PORT_MANAGER_TERMINAL_ATTACHMENT_DIR", this.getTerminalAttachmentMarkerDirectoryPath()),
      buildTerminalAttachmentMarkerWriteShell(),
      buildComposeProjectRoutingShell(this.getComposeProjectRoutingFilePath(networkId), nativeContainerMapPath),
      shellExport("PORT_MANAGER_SCAN_RANGE", String(settings.scanRange)),
      shellExport("PORT_MANAGER_ROUTING_MODE", settings.routingMode),
      shellExport("PORT_MANAGER_VIRTUAL_PORT_START", String(settings.virtualPortRangeStart)),
      shellExport("PORT_MANAGER_VIRTUAL_PORT_END", String(settings.virtualPortRangeEnd)),
      shellExport("PORT_MANAGER_FIXED_PROTOCOL_PORTS", settings.fixedProtocolPorts.join(",")),
      shellPrependLibrary(preloadVariable, hookLibraryPath),
    ];
    commands.push(buildAgentDaemonEnsureShell(process.execPath));

    if (process.platform === "darwin" && shellEnvRestorePath !== undefined) {
      commands.push(
        shellExport("PORT_MANAGER_DYLD_INSERT_LIBRARIES", hookLibraryPath),
        `export PORT_MANAGER_PREV_BASH_ENV="\${BASH_ENV:-}"`,
        shellExport("BASH_ENV", shellEnvRestorePath),
      );
    }

    if (runtimeShimDirectory !== undefined) {
      commands.push(
        shellExport(RUNTIME_SHIM_DIRECTORY_ENV, runtimeShimDirectory),
        `export PATH=${shellQuote(runtimeShimDirectory)}:"$PATH"`,
        "hash -r 2>/dev/null || true",
      );
    }

    commands.push(
      `printf '%s\\n' ${shellQuote(
        `Port Manager routing active for ${networkId}. Restart servers launched before attach.`,
      )}`,
    );

    return commands.join("; ");
  }

  /** Builds a shell snippet that removes native routing variables from the current shell. */
  private buildTerminalDetachScript(): string {
    const hookLibraryPath = this.context.asAbsolutePath(getHookLibraryRelativePath());
    const asdfShimLauncherPath = this.context.asAbsolutePath(getAsdfShimLauncherRelativePath());
    const runtimeCommandShimPath = this.context.asAbsolutePath(getRuntimeCommandShimRelativePath());
    const runtimeShimDirectory = prepareRuntimeShimLauncherDirectory(
      this.context.globalStorageUri.fsPath,
      asdfShimLauncherPath,
      runtimeCommandShimPath,
    );
    const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
    const variables = [
      "PORT_MANAGER_HOOK",
      "PORT_MANAGER_NETWORK_ID",
      "PORT_MANAGER_ROUTE_TABLE_NETWORK_ID",
      "PORT_MANAGER_BORROWED_NETWORK_ID",
      "NEWDLOPS_PM_NETWORK_ID",
      "NEWDLOPS_PM_BORROWED_NETWORK_ID",
      "PORT_MANAGER_AGENT_SOCKET",
      "PORT_MANAGER_AGENT_MAIN",
      "PORT_MANAGER_AGENT_EXECUTABLE",
      "PORT_MANAGER_CONTAINER_MAP_HELPER",
      DOCKER_SHIM_PATH_ENV,
      "PORT_MANAGER_HOOK_DAEMON_STARTED",
      "PORT_MANAGER_ROUTES_FILE",
      "PORT_MANAGER_COMPOSE_ROUTING_FILE",
      "PORT_MANAGER_HOST_ACCESS_FILE",
      "PORT_MANAGER_TERMINAL_ATTACHMENT_DIR",
      "PORT_MANAGER_SCAN_RANGE",
      "PORT_MANAGER_ROUTING_MODE",
      "PORT_MANAGER_VIRTUAL_PORT_START",
      "PORT_MANAGER_VIRTUAL_PORT_END",
      "PORT_MANAGER_FIXED_PROTOCOL_PORTS",
      "PORT_MANAGER_DYLD_INSERT_LIBRARIES",
      RUNTIME_SHIM_DIRECTORY_ENV,
    ];
    const commands = [buildTerminalAttachmentMarkerRemoveShell(), ...variables.map((variable) => `unset ${variable}`)];

    if (process.platform === "darwin") {
      commands.push(
        `if [ -n "\${PORT_MANAGER_PREV_BASH_ENV:-}" ]; then export BASH_ENV="\${PORT_MANAGER_PREV_BASH_ENV}"; else unset BASH_ENV; fi`,
        "unset PORT_MANAGER_PREV_BASH_ENV",
      );
    }

    commands.push(
      `if [ "\${${preloadVariable}:-}" = ${shellQuote(hookLibraryPath)} ]; then unset ${preloadVariable}; else export ${preloadVariable}="\${${preloadVariable}#${shellPatternLiteral(`${hookLibraryPath}:`)}}"; fi`,
    );

    if (runtimeShimDirectory !== undefined) {
      commands.push(`export PATH="\${PATH#${shellPatternLiteral(`${runtimeShimDirectory}:`)}}"`, "hash -r 2>/dev/null || true");
    }

    commands.push(
      "unset -f docker podman docker-compose podman-compose /usr/local/bin/docker /opt/homebrew/bin/docker /usr/bin/docker /bin/docker /Applications/Docker.app/Contents/Resources/bin/docker /usr/local/bin/podman /opt/homebrew/bin/podman /usr/bin/podman /bin/podman /usr/local/bin/docker-compose /opt/homebrew/bin/docker-compose /usr/bin/docker-compose /bin/docker-compose /Applications/Docker.app/Contents/Resources/bin/docker-compose /usr/local/bin/podman-compose /opt/homebrew/bin/podman-compose /usr/bin/podman-compose /bin/podman-compose __port_manager_runtime_first_command __port_manager_runtime_container_subcommand __port_manager_network_id __port_manager_normalize_compose_file_path __port_manager_same_compose_file_path __port_manager_compose_args_reference_file __port_manager_compose_route_for_runtime __port_manager_cwd_matches_workdir __port_manager_container_target_for_runtime __port_manager_shell_quote __port_manager_runtime_command_may_reference_container __port_manager_run_runtime_with_container_routing __port_manager_run_compose_command_with_routing __port_manager_run_standalone_compose_with_routing __port_manager_define_absolute_runtime_function 2>/dev/null || true",
    );
    commands.push(`printf '%s\\n' ${shellQuote("Port Manager routing detached from this shell.")}`);

    return commands.join("; ");
  }
}

export interface TerminalRoutingInjectionResult {
  /** True when the command was sent to the selected terminal shell. */
  readonly injected: boolean;
  /** User-facing explanation when automatic injection is unavailable. */
  readonly reason?: string;
}

export interface HostAccessBindingInput {
  /** Existing logical network id. */
  readonly networkId: string;
  /** Network-local logical TCP port that attached apps call. */
  readonly logicalPort: number;
  /** Host-machine address reached by the binding. */
  readonly hostAddress: string;
  /** Host-machine TCP port reached by the binding. */
  readonly hostPort: number;
}

export interface HostPortExposureInput {
  /** Existing logical network id. */
  readonly networkId: string;
  /** Host interface exposed to users, commonly 127.0.0.1. */
  readonly hostAddress: string;
  /** Host TCP port selected by the user. */
  readonly hostPort: number;
  /** Runtime target address. For proxy runtime this is a local or reachable host. */
  readonly targetAddress: string;
  /** Runtime target TCP port. */
  readonly targetPort: number;
}

export interface ComposePublishedPortsInput {
  /** Logical network whose attached clients should see these compose endpoints. */
  readonly networkId: string;
  /** Compose project name shown in UI and route diagnostics. */
  readonly projectName: string;
  /** Working directory used for daemon route rows and cwd fallback matching. */
  readonly cwd?: string;
  /** Compose files that describe the project, when known. */
  readonly composeFiles?: readonly string[];
  /** Optional mutating flow that releases the original Docker-published ports. */
  readonly composeMutation?: ComposePublishMutationInput;
  /** Existing hidden clone state recovered from Port Manager clone discovery. */
  readonly existingMutation?: ComposePortMutationState;
  /** Published service endpoints to register into this logical network. */
  readonly ports: readonly ComposePublishedPortInput[];
}

export interface ComposePublishMutationInput {
  /** Clone changes project name; in-place recreates the original compose project. */
  readonly mode?: ComposePortMutationMode;
  /** Explicit confirmation for clone attach of stateful services with persistent mounts. */
  readonly allowStatefulClone?: boolean;
  /** Runtime CLI that owns the discovered compose services. */
  readonly runtime: "docker" | "podman";
  /** Directory where compose commands should resolve relative files. */
  readonly workingDirectory?: string;
  /** Compose config files discovered from runtime labels. */
  readonly composeFiles?: readonly string[];
}

export interface ComposePublishedPortInput {
  /** Compose service that owns the container-side listener. */
  readonly serviceName: string;
  /** Public/logical port that attached terminal clients should keep using. */
  readonly logicalPort: number;
  /** Docker-published host address reachable from the extension host. */
  readonly actualHostAddress: string;
  /** Docker-published host port, often allocated from a hidden range. */
  readonly actualHostPort: number;
  /** Compose-internal service port that must stay unchanged in Docker networking. */
  readonly containerPort?: number;
  /** Optional named protocol label such as postgresql, mysql, redis, or http. */
  readonly protocolName?: string;
}

/** Includes VS Code integrated terminals in the same model as OS-discovered shells. */
async function listVscodeTerminalCandidates(
  processRows: readonly ProcessTableRow[],
): Promise<readonly TerminalCandidate[]> {
  const terminals: Array<TerminalCandidate | undefined> = await Promise.all(
    vscode.window.terminals.map(async (terminal) => {
      let pid: number | undefined;

      try {
        pid = await terminal.processId;
      } catch {
        pid = undefined;
      }

      if (pid === undefined) {
        return undefined;
      }

      const processContext = findTerminalProcessContext(processRows, pid);
      return {
        pid,
        parentPid: processContext?.parentPid,
        processGroupId: processContext?.processGroupId,
        terminalId: processContext?.terminalId,
        name: terminal.name,
        windowTitle: terminal.name,
        command: terminal.name,
        vscodeTerminal: true,
      } satisfies TerminalCandidate;
    }),
  );

  return terminals.filter((candidate): candidate is TerminalCandidate => candidate !== undefined);
}

interface TerminalProcessContext {
  readonly parentPid?: number;
  readonly processGroupId?: number;
  readonly terminalId?: string;
}

/** Enriches VS Code terminal API rows with OS process identity used for grouping and control. */
function findTerminalProcessContext(
  processRows: readonly ProcessTableRow[],
  terminalProcessId: number,
): TerminalProcessContext | undefined {
  const processContext = buildProcessTreeContext(processRows, terminalProcessId);
  if (processContext === undefined) {
    return undefined;
  }

  const processGroupId = processContext.row.processGroupId;
  const terminalId =
    processContext.row.terminalId ??
    processRows.find((row) => row.processGroupId === processGroupId && row.terminalId !== undefined)?.terminalId;

  return {
    parentPid: processContext.row.parentPid,
    processGroupId,
    terminalId,
  };
}

function requireNetwork(network: LogicalNetwork | undefined, networkId: string): LogicalNetwork {
  if (network === undefined) {
    throw new Error(`Unknown logical network: ${networkId}`);
  }

  return network;
}

/** Converts command/API input into the persisted compose endpoint contract. */
function normalizeComposePublishedPort(input: ComposePublishedPortInput): ComposePublishedPort {
  assertTcpPort(input.logicalPort, "Logical compose port");
  assertTcpPort(input.actualHostPort, "Actual compose host port");
  const containerPort = input.containerPort ?? input.logicalPort;
  assertTcpPort(containerPort, "Compose container port");

  return {
    serviceName: assertNonEmptyString(input.serviceName, "Compose service name"),
    // Compose-internal ports are Docker service endpoints. The logical port is
    // the public port attached terminals already call, and it routes to the
    // hidden host publish created by the compose mutator.
    logicalPort: input.logicalPort,
    actualHostAddress: assertNonEmptyString(input.actualHostAddress, "Compose published host address"),
    actualHostPort: input.actualHostPort,
    containerPort,
    protocol: "tcp",
    ...(input.protocolName !== undefined && input.protocolName.trim().length > 0
      ? { protocolName: input.protocolName.trim() }
      : {}),
  };
}

function buildComposeProjectRoutingRows(
  attachments: readonly ComposeAttachment[],
): readonly ComposeProjectRoutingRow[] {
  return attachments.flatMap((attachment) => {
    const mutation = attachment.mutation;
    if (
      attachment.status !== "attached" ||
      mutation === undefined ||
      mutation.mode !== "clone" ||
      mutation.attachedProjectName === mutation.originalProjectName
    ) {
      return [];
    }

    const workingDirectory = mutation.workingDirectory ?? composeWorkingDirectoryFromFiles(mutation.composeFiles);
    if (workingDirectory === undefined) {
      return [];
    }

    return [
      {
        networkId: attachment.networkId,
        runtime: mutation.runtime,
        workingDirectory,
        composeFiles: mutation.composeFiles,
        originalProjectName: mutation.originalProjectName,
        attachedProjectName: mutation.attachedProjectName,
        containerMappings: mutation.containerMappings,
      },
    ];
  });
}

function composeWorkingDirectoryFromFiles(composeFiles: readonly string[]): string | undefined {
  const firstFile = composeFiles.find((file) => file.trim().length > 0);
  return firstFile === undefined ? undefined : path.dirname(firstFile);
}

function stringifyPersistedNetworkState(state: LogicalNetworkRegistryState): string {
  return JSON.stringify(state);
}

/** Checks whether the daemon already owns the persisted compose endpoint route. */
function hasComposeRoute(
  routes: readonly LogicalPortRoute[],
  networkId: string,
  port: ComposePublishedPort,
): boolean {
  return routes.some(
    (route) =>
      route.source === "compose" &&
      route.networkId === networkId &&
      route.logicalPort === port.logicalPort &&
      route.actualPort === port.actualHostPort &&
      route.host === port.actualHostAddress &&
      isListenRoute(route),
  );
}

function composeRuntimeProjectName(attachment: ComposeAttachment): string {
  return attachment.mutation?.attachedProjectName ?? attachment.projectName;
}

function isComposeProcessForPort(
  process: ManagedProcess,
  attachment: ComposeAttachment,
  port: ComposePublishedPort,
): boolean {
  return (
    process.source === "compose" &&
    process.networkId === attachment.networkId &&
    process.requestedPort === port.logicalPort &&
    process.actualPort === port.actualHostPort
  );
}

function composePortsChanged(
  currentPorts: readonly ComposePublishedPort[],
  nextPorts: readonly ComposePublishedPort[],
): boolean {
  return (
    currentPorts.length !== nextPorts.length ||
    currentPorts.some((port, index) => {
      const nextPort = nextPorts[index];
      return (
        nextPort === undefined ||
        port.logicalPort !== nextPort.logicalPort ||
        port.actualHostAddress !== nextPort.actualHostAddress ||
        port.actualHostPort !== nextPort.actualHostPort ||
        port.containerPort !== nextPort.containerPort ||
        port.protocol !== nextPort.protocol ||
        port.serviceName !== nextPort.serviceName
      );
    })
  );
}

function composeContainerMappingsChanged(
  currentMappings: readonly ComposeContainerMutationMapping[],
  nextMappings: readonly ComposeContainerMutationMapping[],
): boolean {
  return (
    currentMappings.length !== nextMappings.length ||
    currentMappings.some((mapping, index) => {
      const nextMapping = nextMappings[index];
      return (
        nextMapping === undefined ||
        mapping.serviceName !== nextMapping.serviceName ||
        mapping.originalContainerId !== nextMapping.originalContainerId ||
        mapping.originalContainerName !== nextMapping.originalContainerName ||
        mapping.attachedContainerId !== nextMapping.attachedContainerId ||
        mapping.attachedContainerName !== nextMapping.attachedContainerName
      );
    })
  );
}

function dropComposeProcessId(port: ComposePublishedPort): ComposePublishedPort {
  return {
    serviceName: port.serviceName,
    logicalPort: port.logicalPort,
    actualHostAddress: port.actualHostAddress,
    actualHostPort: port.actualHostPort,
    containerPort: port.containerPort,
    protocol: port.protocol,
    ...(port.protocolName !== undefined ? { protocolName: port.protocolName } : {}),
  };
}

function isGeneratedRouteTableFile(entryName: string, baseRouteTablePath: string): boolean {
  const parsedPath = path.parse(baseRouteTablePath);
  const extension = parsedPath.ext.length > 0 ? parsedPath.ext : ".json";

  return entryName === parsedPath.base || (entryName.startsWith(`${parsedPath.name}-`) && entryName.endsWith(extension));
}

function isGeneratedHostAccessFile(entryName: string, baseHostAccessPath: string): boolean {
  const parsedPath = path.parse(baseHostAccessPath);
  const extension = parsedPath.ext.length > 0 ? parsedPath.ext : ".json";

  return entryName === parsedPath.base || (entryName.startsWith(`${parsedPath.name}-`) && entryName.endsWith(extension));
}

/** Builds the daemon process row that owns one compose published-port route. */
function buildComposeRegisteredProcessInput(
  attachment: ComposeAttachment,
  port: ComposePublishedPort,
  cwd: string | undefined,
): RegisteredProcessInput {
  const protocolLabel = port.protocolName === undefined ? "" : `/${port.protocolName}`;
  // The daemon route table is also the fallback source for native docker shims.
  // It must name the runtime project, not the original compose project, so
  // child processes that lose the compose TSV env still target the clone.
  const runtimeProjectName = composeRuntimeProjectName(attachment);

  return {
    // Docker may hide the concrete owner PID behind a VM or proxy. A later OS
    // listener scan can adopt the real PID when the platform exposes it.
    pid: 0,
    name: `${runtimeProjectName}:${port.serviceName}${protocolLabel}`,
    command: `docker compose service ${attachment.projectName}/${port.serviceName}`,
    cwd: cwd ?? attachment.composeFiles[0] ?? process.cwd(),
    requestedPort: port.logicalPort,
    actualPort: port.actualHostPort,
    host: port.actualHostAddress,
    networkId: attachment.networkId,
    source: "compose",
  };
}

function requireRuntime(
  runtimes: readonly NetworkRuntimeDescriptor[],
  runtimeKind: NetworkRuntimeKind,
): NetworkRuntimeDescriptor {
  const runtime = runtimes.find((item) => item.kind === runtimeKind);
  if (runtime === undefined) {
    throw new Error(`No runtime adapter registered for ${runtimeKind}.`);
  }

  return runtime;
}

/**
 * Logical networks must keep terminal bind ports out of the host namespace.
 * Linux container runtimes lend only a holder network namespace; macOS uses a
 * borrowed-network socket hook that remaps bind/connect before sockets reach
 * the OS. Host-only proxy runtimes can expose ports, but they cannot attach
 * terminals with same-port semantics.
 */
function requireContainerLevelRuntime(runtime: NetworkRuntimeDescriptor): void {
  if (isContainerLevelRuntime(runtime)) {
    return;
  }

  throw new Error(
    `${runtime.name} cannot create logical networks with isolated terminal sockets. ` +
      "Install or select a runtime that isolates terminal sockets before attaching terminals.",
  );
}

/** Window-wide terminal defaults require env collection based native hook routing. */
function requireNativeHelperRuntime(runtime: NetworkRuntimeDescriptor): void {
  if (runtime.kind === "nativeHelper") {
    return;
  }

  throw new Error(
    `${runtime.name} cannot attach every new VS Code terminal from environment variables. ` +
      "Use a Borrowed Network native hook runtime for VS Code-window terminal defaults.",
  );
}

/** True for runtimes selectable when creating a logical network. */
function isContainerLevelRuntime(runtime: NetworkRuntimeDescriptor): boolean {
  return runtime.capabilities.supportsSameInternalPorts && runtime.capabilities.supportsTerminalAttach;
}

/** Native hook runtime is the macOS/Linux borrowed-network implementation. */
function buildNativeHookRuntimeDescriptor(settings: PortManagerSettings): NetworkRuntimeDescriptor | undefined {
  if (!shouldInjectTerminalHook(settings)) {
    return undefined;
  }

  return {
    id: "native-socket-hook",
    name: `Borrowed Network (${nativeHookPlatformName()} Native Hook)`,
    kind: "nativeHelper",
    capabilities: {
      supportsSameInternalPorts: true,
      supportsTerminalAttach: true,
      supportsHostExposure: true,
      requiresPrivilegedHelper: false,
      requiresContainerRuntime: false,
    },
  };
}

function nativeHookPlatformName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
}

/** Returns the packaged helper that can feed input into generic PTY-backed terminals. */
function getTtyInputHelperRelativePath(): string {
  return path.join("media", "native", "portmanager_tty_input");
}

/** Returns the packaged native TCP router helper used for the logical-router data plane. */
function getTcpRouterHelperRelativePath(): string {
  return path.join("media", "native", "portmanager_tcp_router");
}

/** Returns the packaged native TCP proxy helper used for host exposure data plane. */
function getHostExposureProxyHelperRelativePath(): string {
  return path.join("media", "native", "portmanager_host_exposure_proxy");
}

/** Fails before route rows can persist invalid TCP endpoint state. */
function assertTcpPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be a TCP port between 1 and 65535.`);
  }
}

/** Normalizes user-provided labels and host fields before they reach route state. */
function assertNonEmptyString(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

/** Prevents duplicate exposure rows before the platform bind call. */
function ensureNoExposureConflict(
  exposures: readonly HostPortExposure[],
  input: HostPortExposureInput,
): void {
  const conflictingExposure = exposures.find(
    (exposure) =>
      exposure.protocol === "tcp" &&
      exposure.hostAddress === input.hostAddress &&
      exposure.hostPort === input.hostPort,
  );

  if (conflictingExposure !== undefined) {
    throw new Error(`Host port already exposed: ${input.hostAddress}:${input.hostPort}`);
  }
}

/** Prevents ambiguous network-local ports before writing hook binding state. */
function ensureNoHostAccessConflict(
  bindings: readonly HostAccessBinding[],
  input: HostAccessBindingInput,
): void {
  const conflictingBinding = bindings.find(
    (binding) =>
      binding.networkId === input.networkId &&
      binding.protocol === "tcp" &&
      binding.logicalPort === input.logicalPort,
  );

  if (conflictingBinding !== undefined) {
    throw new Error(`Host access binding already exists for logical port ${input.logicalPort}.`);
  }
}

function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Mirrors route-table.ts filename scoping for per-network Compose routing maps. */
function sanitizeRouteFileScope(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
  return sanitized.length > 0 ? sanitized : "network";
}

/**
 * Builds a stable per-compose scope inside a logical network.
 * The readable prefix helps diagnostics, while the hash covers cwd, compose
 * files, runtime, and project names so two compose stacks in one network never
 * share the same routing TSV by row order.
 */
function composeProjectRoutingRowScope(row: ComposeProjectRoutingRow): string {
  const readableName = sanitizeRouteFileScope(row.originalProjectName ?? row.attachedProjectName).slice(0, 48);
  const hash = createHash("sha1")
    .update(
      JSON.stringify({
        runtime: row.runtime,
        workingDirectory: row.workingDirectory,
        composeFiles: row.composeFiles ?? [],
        originalProjectName: row.originalProjectName ?? "",
        attachedProjectName: row.attachedProjectName,
      }),
    )
    .digest("hex")
    .slice(0, 12);

  return `${readableName}-${hash}`;
}

/** Builds a UI-safe daemon status when the process service is unavailable. */
function createDisconnectedDaemonStatus(): AgentDaemonStatus {
  return {
    status: "disconnected",
    pid: 0,
    updatedAt: new Date(0).toISOString(),
    listenerCount: 0,
    routeCount: 0,
    monitoringAllListeners: false,
    versionStatus: "unknown",
    restartRequired: false,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Chooses a route scoped to the selected logical network and target port. */
function findMatchingRoute(
  routes: readonly LogicalPortRoute[],
  networkId: string,
  logicalPort: number,
): LogicalPortRoute | undefined {
  return routes.find(
    (route) =>
      route.networkId === networkId &&
      route.logicalPort === logicalPort &&
      isListenRoute(route) &&
      (route.status === "running" || route.status === "starting"),
  );
}

/** Sender reservations are not live targets for host exposure or logical routers. */
function isListenRoute(route: LogicalPortRoute): boolean {
  return route.routeDirection === undefined || route.routeDirection === "listen";
}

/** Converts the container adapter target into the socket proxy contract. */
function toHostPortProxyTarget(target: ContainerRuntimeTarget): HostPortProxyTarget {
  return {
    host: target.host,
    port: target.port,
  };
}

/** Sends a command into a terminal window using the best available platform route. */
async function sendCommandToTerminalWindow(
  terminalWindow: TerminalWindow,
  command: string,
  processRows: readonly ProcessTableRow[] = [],
  ttyInputHelperPath?: string,
): Promise<boolean> {
  if (await sendCommandToVscodeTerminal(terminalWindow, command, processRows)) {
    return true;
  }

  return sendCommandToExternalTerminalWindow(terminalWindow, command, ttyInputHelperPath);
}

/** Sends a command into an integrated terminal without relying on OS window automation. */
async function sendRoutingScriptToVscodeTerminal(
  terminalWindow: TerminalWindow,
  script: string,
  processRows: readonly ProcessTableRow[] = [],
): Promise<boolean> {
  return sendCommandToVscodeTerminal(terminalWindow, script, processRows);
}

/** Sends a command into an integrated terminal without relying on OS window automation. */
async function sendCommandToVscodeTerminal(
  terminalWindow: TerminalWindow,
  command: string,
  processRows: readonly ProcessTableRow[] = [],
): Promise<boolean> {
  const nameMatchedTerminals: vscode.Terminal[] = [];

  for (const terminal of vscode.window.terminals) {
    let processId: number | undefined;

    try {
      processId = await terminal.processId;
    } catch {
      processId = undefined;
    }

    if (isVscodeTerminalNameMatch(terminalWindow, terminal)) {
      nameMatchedTerminals.push(terminal);
    }

    if (processId === undefined || !isVscodeTerminalProcessMatch(terminalWindow, processId, processRows)) {
      continue;
    }

    terminal.sendText(command, true);
    return true;
  }

  if (nameMatchedTerminals.length === 1) {
    nameMatchedTerminals[0].sendText(command, true);
    return true;
  }

  if (
    vscode.window.activeTerminal !== undefined &&
    isVscodeTerminalNameMatch(terminalWindow, vscode.window.activeTerminal)
  ) {
    vscode.window.activeTerminal.sendText(command, true);
    return true;
  }

  return false;
}

/** Matches process-less VS Code pseudoterminals by stable display names only when unambiguous. */
function isVscodeTerminalNameMatch(terminalWindow: TerminalWindow, terminal: vscode.Terminal): boolean {
  const terminalName = normalizeTerminalDisplayName(terminal.name);
  const windowTitle = normalizeTerminalDisplayName(terminalWindow.title);
  const terminalId = normalizeTerminalDisplayName(terminalWindow.terminalId);

  return (
    terminalName.length > 0 &&
    (terminalName === windowTitle ||
      (terminalId.length > 0 && (terminalName === terminalId || terminalName === `Terminal ${terminalId}`)))
  );
}

/** Keeps terminal display-name comparisons insensitive to /dev prefixes and whitespace churn. */
function normalizeTerminalDisplayName(value: string | undefined): string {
  return value?.trim().replace(/^\/dev\//, "") ?? "";
}

/** Matches VS Code's Terminal object process back to a terminal row discovered through ps/TTY. */
function isVscodeTerminalProcessMatch(
  terminalWindow: TerminalWindow,
  terminalProcessId: number,
  processRows: readonly ProcessTableRow[],
): boolean {
  if (
    terminalWindow.rootPid === terminalProcessId ||
    terminalWindow.processGroupId === terminalProcessId ||
    terminalWindow.candidatePids.includes(terminalProcessId)
  ) {
    return true;
  }

  const processContext = buildProcessTreeContext(processRows, terminalProcessId);
  if (processContext === undefined) {
    return false;
  }

  if (processContext.ancestorPids.some((pid) => terminalWindow.candidatePids.includes(pid))) {
    return true;
  }

  const terminalRowsByPid = new Map(processRows.map((row) => [row.pid, row]));
  const relatedRows = [
    processContext.row,
    ...processContext.ancestorPids.flatMap((pid) => {
      const row = terminalRowsByPid.get(pid);
      return row === undefined ? [] : [row];
    }),
  ];

  if (
    terminalWindow.processGroupId !== undefined &&
    relatedRows.some((row) => row.processGroupId === terminalWindow.processGroupId)
  ) {
    return true;
  }

  const terminalId = normalizeProcessTerminalId(terminalWindow.terminalId);
  return (
    terminalId !== undefined &&
    relatedRows.some((row) => normalizeProcessTerminalId(row.terminalId) === terminalId)
  );
}

/** Normalizes ps and AppleScript TTY spellings to the same compact id. */
function normalizeProcessTerminalId(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^\/dev\//, "");
  return normalized === undefined || normalized.length === 0 || normalized === "?" ? undefined : normalized;
}

/** Finds the visible terminal window that corresponds to a manually executed routing script. */
function findTerminalWindowForMarker(
  marker: TerminalAttachmentMarker,
  terminalWindows: readonly TerminalWindow[],
): TerminalWindow | undefined {
  return terminalWindows.find((terminalWindow) => isTerminalWindowMarkerMatch(marker, terminalWindow));
}

/** Compares marker identity against the same grouped terminal model shown in the sidebar. */
function isTerminalWindowMarkerMatch(marker: TerminalAttachmentMarker, terminalWindow: TerminalWindow): boolean {
  const markerTerminalId = normalizeProcessTerminalId(marker.terminalId);
  const terminalWindowId = normalizeProcessTerminalId(terminalWindow.terminalId);

  if (markerTerminalId !== undefined && terminalWindowId === markerTerminalId) {
    return true;
  }

  if (
    marker.pid !== undefined &&
    (terminalWindow.rootPid === marker.pid || terminalWindow.candidatePids.includes(marker.pid))
  ) {
    return true;
  }

  return marker.processGroupId !== undefined && terminalWindow.processGroupId === marker.processGroupId;
}

/** Keeps manual attachment ids deterministic so refresh can update them idempotently. */
function createManualTerminalAttachmentId(networkId: string, terminalWindowId: string): string {
  return `${MANUAL_TERMINAL_ATTACHMENT_ID_PREFIX}${encodeURIComponent(networkId)}:${encodeURIComponent(
    terminalWindowId,
  )}`;
}

/** Keeps explicit process attachments stable across repeated user actions. */
function createProcessTerminalAttachmentId(networkId: string, pid: number): string {
  return `${PROCESS_TERMINAL_ATTACHMENT_ID_PREFIX}${encodeURIComponent(networkId)}:${pid}`;
}

/** Parses the TSV marker emitted by copied routing scripts. */
function parseTerminalAttachmentMarker(contents: string, filePath: string): TerminalAttachmentMarker | undefined {
  const line = contents.split(/\r?\n/).find((item) => item.trim().length > 0);

  if (line === undefined) {
    return undefined;
  }

  const [networkIdText, terminalIdText, pidText, processGroupIdText, attachedAtText] = line.split("\t");
  const networkId = networkIdText?.trim();

  if (networkId === undefined || networkId.length === 0) {
    return undefined;
  }

  const attachedAt =
    attachedAtText !== undefined && Number.isFinite(Date.parse(attachedAtText.trim()))
      ? attachedAtText.trim()
      : new Date().toISOString();

  return {
    networkId,
    terminalId: normalizeProcessTerminalId(terminalIdText),
    pid: parseOptionalPositiveInteger(pidText),
    processGroupId: parseOptionalPositiveInteger(processGroupIdText),
    attachedAt,
    filePath,
  };
}

/** Parses optional shell marker ids without treating blanks as zero. */
function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  const parsed = value === undefined || value.trim().length === 0 ? Number.NaN : Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Sends a command to every integrated terminal owned by this VS Code window. */
function sendCommandToOpenVscodeTerminals(command: string): number {
  let sentCount = 0;

  for (const terminal of vscode.window.terminals) {
    try {
      terminal.sendText(command, true);
      sentCount += 1;
    } catch {
      // A disposed terminal can remain visible briefly while VS Code settles events.
    }
  }

  return sentCount;
}

/** Sends a routing script into Terminal.app or iTerm2 sessions selected by tty. */
async function sendRoutingScriptToExternalTerminalWindow(
  terminalWindow: TerminalWindow,
  script: string,
  ttyInputHelperPath?: string,
): Promise<boolean> {
  return sendCommandToExternalTerminalWindow(terminalWindow, script, ttyInputHelperPath);
}

/** Sends a command into Terminal.app or iTerm2 sessions selected by tty. */
async function sendCommandToExternalTerminalWindow(
  terminalWindow: TerminalWindow,
  command: string,
  ttyInputHelperPath?: string,
): Promise<boolean> {
  if (process.platform !== "darwin" || terminalWindow.terminalId === undefined) {
    return terminalWindow.terminalId === undefined
      ? false
      : runGenericTtyInput(normalizeTerminalTty(terminalWindow.terminalId), command, ttyInputHelperPath);
  }

  const tty = normalizeTerminalTty(terminalWindow.terminalId);
  return (
    (await runGenericTtyInput(tty, command, ttyInputHelperPath)) ||
    (await runTerminalAppleScript(tty, command)) ||
    (await runITermAppleScript(tty, command))
  );
}

/** Generic PTY input fallback for terminals that are not exposed through VS Code, Terminal.app, or iTerm2 APIs. */
async function runGenericTtyInput(
  tty: string,
  command: string,
  ttyInputHelperPath: string | undefined,
): Promise<boolean> {
  if (ttyInputHelperPath === undefined || process.platform === "win32") {
    return false;
  }

  try {
    await execFileAsync(ttyInputHelperPath, [tty, command], {
      timeout: 1500,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/** Terminal.app exposes tty on each tab, which lets us target a window without matching titles. */
async function runTerminalAppleScript(tty: string, script: string): Promise<boolean> {
  const escapedScript = appleScriptString(script);
  const escapedTty = appleScriptString(tty);
  const appleScript = `
if application "Terminal" is not running then return "missing"
tell application "Terminal"
  repeat with windowItem in windows
    repeat with tabItem in tabs of windowItem
      if (tty of tabItem) is "${escapedTty}" then
        do script "${escapedScript}" in tabItem
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "missing"
`;

  return runAppleScript(appleScript);
}

/** iTerm2 exposes tty on sessions, so session selection does not depend on mutable titles. */
async function runITermAppleScript(tty: string, script: string): Promise<boolean> {
  const escapedScript = appleScriptString(script);
  const escapedTty = appleScriptString(tty);
  const appleScript = `
if application "iTerm2" is not running then return "missing"
tell application "iTerm2"
  repeat with windowItem in windows
    repeat with tabItem in tabs of windowItem
      repeat with sessionItem in sessions of tabItem
        if (tty of sessionItem) is "${escapedTty}" then
          tell sessionItem to write text "${escapedScript}"
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "missing"
`;

  return runAppleScript(appleScript);
}

async function runAppleScript(script: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 1500 });
    return stdout.trim() === "ok";
  } catch {
    return false;
  }
}

function normalizeTerminalTty(terminalId: string): string {
  return terminalId.startsWith("/dev/") ? terminalId : path.join("/dev", terminalId);
}

/** Shell fragment that records a manually routed shell for later sidebar refresh. */
function buildTerminalAttachmentMarkerWriteShell(): string {
  return [
    'mkdir -p "$PORT_MANAGER_TERMINAL_ATTACHMENT_DIR" 2>/dev/null || true',
    '__pm_tty="$(tty 2>/dev/null || true)"',
    '__pm_tty="${__pm_tty#/dev/}"',
    'if [ "$__pm_tty" = "not a tty" ]; then __pm_tty=""; fi',
    '__pm_pid="$$"',
    '__pm_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d " " || true)"',
    '__pm_marker_key="$(printf \'%s\' "${__pm_tty:-pid-$__pm_pid}" | sed \'s#[^A-Za-z0-9._-]#_#g\')"',
    'printf \'%s\\t%s\\t%s\\t%s\\t%s\\n\' "$PORT_MANAGER_NETWORK_ID" "$__pm_tty" "$__pm_pid" "$__pm_pgid" "$(date -u \'+%Y-%m-%dT%H:%M:%SZ\' 2>/dev/null || date \'+%Y-%m-%dT%H:%M:%SZ\')" > "$PORT_MANAGER_TERMINAL_ATTACHMENT_DIR/$__pm_marker_key.tsv" 2>/dev/null || true',
    "unset __pm_tty __pm_pid __pm_pgid __pm_marker_key",
  ].join("; ");
}

/** Shell fragment that removes the marker for the current shell before env reset. */
function buildTerminalAttachmentMarkerRemoveShell(): string {
  return [
    'if [ -n "${PORT_MANAGER_TERMINAL_ATTACHMENT_DIR:-}" ]; then',
    '__pm_tty="$(tty 2>/dev/null || true)"',
    '__pm_tty="${__pm_tty#/dev/}"',
    'if [ "$__pm_tty" = "not a tty" ]; then __pm_tty=""; fi',
    '__pm_pid="$$"',
    '__pm_marker_key="$(printf \'%s\' "${__pm_tty:-pid-$__pm_pid}" | sed \'s#[^A-Za-z0-9._-]#_#g\')"',
    'rm -f "$PORT_MANAGER_TERMINAL_ATTACHMENT_DIR/$__pm_marker_key.tsv" 2>/dev/null || true',
    "unset __pm_tty __pm_pid __pm_marker_key",
    "fi",
  ].join("; ");
}

function shellExport(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

function shellPrependLibrary(name: string, libraryPath: string): string {
  return `export ${name}=${shellQuote(libraryPath)}\${${name}:+":$${name}"}`;
}

/**
 * Native socket routing fails closed when the singleton daemon is unavailable.
 * Terminal attach is often followed immediately by process startup, so the
 * injected shell must both start the daemon when needed and wait until the
 * socket accepts connections before returning control to the prompt.
 */
function buildAgentDaemonEnsureShell(nodeExecutablePath: string): string {
  const nodeRuntimePrefix = `${ELECTRON_RUN_AS_NODE}=1`;
  const daemonRuntimePrefix = `PORT_MANAGER_HOOK_DISABLED=1 PORT_MANAGER_HOOK=0 DYLD_INSERT_LIBRARIES= LD_PRELOAD= ${nodeRuntimePrefix}`;
  const nodeProbeScript =
    'const net=require("node:net");const fs=require("node:fs");const socketPath=process.argv[1];const socket=net.createConnection(socketPath);const timer=setTimeout(()=>{socket.destroy();try{if(process.platform!=="win32")fs.unlinkSync(socketPath);}catch{}process.exit(1);},300);socket.once("connect",()=>{clearTimeout(timer);socket.end();process.exit(0);});socket.once("error",()=>{clearTimeout(timer);try{if(process.platform!=="win32")fs.unlinkSync(socketPath);}catch{}process.exit(1);});';
  const probeCommand = `${daemonRuntimePrefix} ${shellQuote(nodeExecutablePath)} -e ${shellQuote(
    nodeProbeScript,
  )} "$PORT_MANAGER_AGENT_SOCKET"`;

  return [
    `__pm_agent_ready=0`,
    `${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1`,
    `if [ "$__pm_agent_ready" != "1" ]; then`,
    `if [ -x "$PORT_MANAGER_AGENT_EXECUTABLE" ]; then`,
    `${daemonRuntimePrefix} nohup "$PORT_MANAGER_AGENT_EXECUTABLE" --socket "$PORT_MANAGER_AGENT_SOCKET" --route-table "$PORT_MANAGER_GLOBAL_ROUTES_FILE" --agent-main "$PORT_MANAGER_AGENT_MAIN" >/tmp/newdlops-portmanager-agent.log 2>&1 &`,
    `else`,
    `${daemonRuntimePrefix} nohup ${shellQuote(
      nodeExecutablePath,
    )} "$PORT_MANAGER_AGENT_MAIN" --socket "$PORT_MANAGER_AGENT_SOCKET" >/tmp/newdlops-portmanager-agent.log 2>&1 &`,
    `fi`,
    `__pm_agent_wait_count=0`,
    `while [ $__pm_agent_wait_count -lt 50 ]; do`,
    `${probeCommand} >/dev/null 2>&1 && break`,
    `__pm_agent_wait_count=$((__pm_agent_wait_count + 1))`,
    `sleep 0.1`,
    `done`,
    `unset __pm_agent_wait_count`,
    `fi`,
    `unset __pm_agent_ready`,
    `export PORT_MANAGER_HOOK_DAEMON_STARTED=1`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellPatternLiteral(value: string): string {
  return value.replace(/([\\*?\[])/g, "\\$1");
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isNetworkScopedComposeRoute(route: LogicalPortRoute): boolean {
  return route.source === "compose" && route.networkId !== undefined && route.networkId.trim().length > 0;
}

const BASE_RUNTIMES: readonly NetworkRuntimeDescriptor[] = [
  {
    id: "local-proxy",
    name: "Local TCP Proxy (host exposure only)",
    kind: "proxy",
    capabilities: {
      supportsSameInternalPorts: false,
      supportsTerminalAttach: false,
      supportsHostExposure: true,
      requiresPrivilegedHelper: false,
      requiresContainerRuntime: false,
    },
  },
];

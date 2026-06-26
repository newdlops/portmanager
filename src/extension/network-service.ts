import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as syncFs from "node:fs";
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
import {
  LogicalNetworkRegistry,
  terminalAttachmentsShareIdentity,
  type LogicalNetworkRegistryState,
} from "../core/networks/logical-network-registry";
import {
  browserLoopbackAddressForNetwork,
  isLoopbackAddressRoutingEnabled,
  loopbackAddressForNetwork,
  NETWORK_LOOPBACK_HOST_ENV,
  resolveLoopbackAddressRoutingMode,
} from "../core/networks/loopback-address";
import { findRoutesMatchingClientCwd } from "../core/networks/logical-route-selection";
import { resolveProcessTreeNetworkLabel } from "../core/process-network-labels";
import { SimpleEventEmitter } from "../shared/events";
import {
  ContainerNetworkRuntimeAdapter,
  type ContainerRuntimeTarget,
  runContainerCommand,
} from "../platform/network/container-runtime";
import { BrowserDnsServer, browserDnsPort, normalizeBrowserDnsHostname } from "../platform/network/browser-dns-server";
import { ComposePublishMutator } from "../platform/network/compose-publish-mutator";
import { ContainerServiceDiscoveryAdapter } from "../platform/network/container-service-discovery";
import { SharedLogicalNetworkStateStore } from "../platform/network/shared-network-state-store";
import {
  BrowserNetworkProxyManager,
  browserNetworkProxyEndpointId,
  browserNetworkProxyFallbackPort,
  formatBrowserNetworkProxyUrl,
  type BrowserNetworkProxyEndpoint,
  type BrowserNetworkProxyTarget,
} from "../platform/ports/browser-network-proxy";
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
  AgentSnapshot,
  BrowserDnsResolverStatus,
  ComposeAttachment,
  ComposeContainerMutationMapping,
  ComposePortMutationMode,
  ComposePortMutationState,
  ComposePublishedPort,
  ContainerServiceCandidate,
  DisposableLike,
  HostAccessBinding,
  HostPortExposure,
  ListeningPort,
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
  inferContainerMappingsFromComposeRoutingFiles,
  serializeComposeProjectRoutingRows,
  splitGeneratedComposeRoutingFiles,
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
const TERMINAL_HOOK_SCRIPT_DIRECTORY_NAME = "terminal-hook-scripts";
const TERMINAL_NETWORK_SELECTION_FILE_NAME = "terminal-networks.tsv";
const MANUAL_TERMINAL_ATTACHMENT_ID_PREFIX = "manual-terminal:";
const PROCESS_TERMINAL_ATTACHMENT_ID_PREFIX = "process-terminal:";
const ROUTING_SIGNAL_REFRESH_INTERVAL_MS = 60_000;
const BACKGROUND_CONTAINER_REFRESH_INTERVAL_MS = 60_000;
const BACKGROUND_CONTAINER_REFRESH_LOCK_STALE_MS = 120_000;
const BACKGROUND_CONTAINER_REFRESH_STAMP_PATH = buildBackgroundContainerRefreshControlPath("stamp");
const BACKGROUND_CONTAINER_REFRESH_LOCK_PATH = buildBackgroundContainerRefreshControlPath("lock");
// Owner lease must outlive the routing refresh interval; otherwise multiple
// VS Code windows can take turns stealing router ownership between renewals.
const LOGICAL_ROUTER_OWNER_LEASE_MS = 120_000;
const LOGICAL_ROUTER_OWNER_LOCK_STALE_MS = 30_000;
const LOGICAL_ROUTER_OWNER_PATH = buildLogicalRouterOwnerControlPath("owner");
const LOGICAL_ROUTER_OWNER_LOCK_PATH = buildLogicalRouterOwnerControlPath("lock");
const DAEMON_RESTART_BACKOFF_MS = 30_000;
const TERMINAL_ATTACHMENT_MARKER_POLL_INTERVAL_MS = 500;
const TERMINAL_ATTACHMENT_REFRESH_DEBOUNCE_MS = 50;
const TERMINAL_ATTACHMENT_REFRESH_BURST_WINDOW_MS = 2_000;
const TERMINAL_ATTACHMENT_REFRESH_BURST_INTERVAL_MS = 250;
const TERMINAL_NETWORK_SERVICE_ENTRY_SEPARATOR = " || ";
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

interface BackgroundRefreshOptions {
  /** True when called from the low-frequency repair loop instead of a user action. */
  readonly background?: boolean;
  /** Internal flag used when one outer Docker refresh already owns the shared lock. */
  readonly sharedRefreshAcquired?: boolean;
}

interface LogicalRouterOwnerDocument {
  /** Extension host process that currently owns localhost logical router children. */
  readonly pid: number;
  /** Lease renewal time; stale leases can be stolen by another active window. */
  readonly updatedAt: string;
}

export interface RoutingFileCleanupSummary {
  /** Existing Port Manager routing cache files removed from disk. */
  readonly removedFileCount: number;
  /** Files that could not be removed because the filesystem rejected cleanup. */
  readonly failedFileCount: number;
  /** Compose endpoint routes re-registered into the singleton daemon afterward. */
  readonly restoredComposeRouteCount: number;
}

export interface StaleRoutingRepairSummary extends RoutingFileCleanupSummary {
  /** True when the repair path observed a stale daemon before convergence. */
  readonly staleDaemonDetected: boolean;
  /** True when the daemon moved from stale to current during repair. */
  readonly daemonRestarted: boolean;
  /** Marker files removed by terminal-marker reconciliation. */
  readonly removedMarkerCount: number;
  /** Discovered terminal windows scanned while deciding which markers are stale. */
  readonly terminalCount: number;
  /** Active daemon route rows after convergence and refresh. */
  readonly routeCount: number;
}

export interface ComposeAttachmentCopyInput {
  /** Existing compose attachment whose route endpoints should be reused. */
  readonly attachmentId: string;
  /** Destination logical network that should receive the copied endpoints. */
  readonly networkId: string;
}

interface FileCleanupSummary {
  /** Existing generated files removed from disk. */
  readonly removedFileCount: number;
  /** Files that could not be removed because the filesystem rejected cleanup. */
  readonly failedFileCount: number;
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

interface TerminalAttachmentMarkerCandidate {
  readonly attachment: TerminalAttachment;
  readonly markerPath: string;
}

interface ComposeRouteRestoreOptions {
  /**
   * Reconcile calls this after it has refreshed Docker-published endpoints. The
   * normal path waits for an in-flight reconcile first so stale port snapshots
   * cannot overwrite fresher Docker state.
   */
  readonly allowDuringComposeReconcile?: boolean;
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

  /** Legacy localhost listener router kept only so active listeners can be closed. */
  private readonly logicalPortRouter: LogicalPortRouterManager;

  /** Development browser entrypoints that isolate cookie jars by network loopback host. */
  private readonly browserNetworkProxy: BrowserNetworkProxyManager;

  /** Resolves accepted TCP connection tuples back to client PIDs. */
  private readonly tcpConnectionProcessResolver: NodeTcpConnectionProcessResolver;

  /** Reads process ancestry so client and listener PIDs can be tied to terminals. */
  private readonly processTableProvider: NodeProcessTableProvider;

  /** Reads inherited Port Manager routing scope from local client processes. */
  private readonly processEnvironmentProvider: NodeProcessEnvironmentProvider;

  /** Local DNS responder that maps browser hostnames to per-network loopback addresses. */
  private readonly browserDnsServer: BrowserDnsServer;

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

  /** Guards Docker/Podman discovery so background ticks do not stack CLI scans. */
  private containerServiceRefreshInFlight: Promise<readonly ContainerServiceCandidate[]> | undefined;

  /** Last Docker/Podman discovery time; background refreshes reuse recent state. */
  private lastContainerServiceRefreshAtMs = 0;

  /** Last compose endpoint reconciliation time; background refreshes reuse recent route rows. */
  private lastComposeAttachmentReconcileAtMs = 0;

  /** Guards background signal refreshes so slow Docker/process-table reads do not overlap. */
  private routingSignalRefreshInFlight: Promise<void> | undefined;

  /** Guards daemon and routing-file convergence so refresh events cannot recurse. */
  private daemonConvergenceInFlight: Promise<void> | undefined;

  /** Guards localhost router reconciliation so owner handoffs do not overlap in one host. */
  private logicalRouterSyncInFlight: Promise<void> | undefined;

  /** Requests one more router reconciliation after the current sync sees an older snapshot. */
  private logicalRouterSyncQueued = false;

  /** Guards browser proxy reconciliation so process snapshot bursts do not overlap. */
  private browserProxySyncInFlight: Promise<void> | undefined;

  /** Requests one more browser proxy reconciliation after the current sync completes. */
  private browserProxySyncQueued = false;

  /** Guards privileged resolver installation so duplicate UI/registry events cannot stack prompts. */
  private browserDnsResolverInstallInFlight: Promise<BrowserDnsResolverStatus> | undefined;

  /** Last missing-resolver signature that already triggered an automatic admin prompt. */
  private browserDnsAutoInstallSignature: string | undefined;

  /** Serializes terminal picker rewrites so stale snapshots cannot win the last write. */
  private terminalNetworkSelectionWriteInFlight: Promise<void> | undefined;

  /** Requests one more terminal picker rewrite after the current filesystem write completes. */
  private terminalNetworkSelectionWriteQueued = false;

  /** Next timestamp at which a stale daemon restart may be retried after failure. */
  private daemonRestartBackoffUntilMs = 0;

  /** Guards terminal refreshes so watcher bursts cannot overlap process-table scans. */
  private terminalRefreshInFlight: Promise<readonly TerminalWindow[]> | undefined;

  /** Requests one more terminal refresh after the current process-table scan completes. */
  private terminalRefreshQueued = false;

  /** Background poller that keeps terminals, containers, and compose routes current. */
  private routingSignalRefreshTimer: ReturnType<typeof setInterval> | undefined;

  /** Lightweight marker poller used when VS Code file events miss global storage writes. */
  private terminalAttachmentMarkerPollTimer: ReturnType<typeof setInterval> | undefined;

  /** Debounces marker file events before scanning terminals. */
  private terminalAttachmentRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Keeps a short refresh burst alive while a newly hooked terminal appears in the process table. */
  private terminalAttachmentRefreshBurstUntilMs = 0;

  /** Last stat-level signature of terminal hook marker files. */
  private terminalAttachmentMarkerSignature = "";

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
    this.browserDnsServer = new BrowserDnsServer();
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
    this.browserNetworkProxy = new BrowserNetworkProxyManager({
      resolve: (endpoint) => this.resolveBrowserNetworkProxyTarget(endpoint),
    });
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
        void this.writeTerminalNetworkSelectionFile();
        void this.syncBrowserDnsRecords();
        void this.maybeAutoInstallBrowserDnsResolvers();
        void this.syncLogicalPortRouters();
        void this.syncBrowserNetworkProxies();
        this.reconcileVscodeWindowTerminalBinding();
      }),
    );
    if (this.processService !== undefined) {
      this.disposables.push(
        this.processService.onDidChange(() => {
          void this.syncLogicalPortRouters();
          void this.syncBrowserNetworkProxies();
          void this.restorePersistedComposeRoutesIfMissing();
          void this.writeTerminalNetworkSelectionFile();
          this.localChangeEvents.emit();
        }),
      );
    }
  }

  /** Loads terminal candidates and reopens persisted host exposures. */
  async start(): Promise<void> {
    const terminalAttachmentMarkerDirectory = this.getTerminalAttachmentMarkerDirectoryPath();
    await fs.mkdir(terminalAttachmentMarkerDirectory, { recursive: true }).catch(() => undefined);
    const terminalAttachmentMarkerWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(terminalAttachmentMarkerDirectory, "*.tsv"),
    );
    const nativeTerminalAttachmentMarkerWatcher =
      this.watchTerminalAttachmentMarkers(terminalAttachmentMarkerDirectory);

    this.disposables.push(
      this.sharedNetworkStateStore.watch(() => {
        void this.reloadSharedNetworkState();
      }),
      terminalAttachmentMarkerWatcher,
      nativeTerminalAttachmentMarkerWatcher,
      terminalAttachmentMarkerWatcher.onDidCreate(() => {
        this.scheduleTerminalAttachmentRefreshBurst();
      }),
      terminalAttachmentMarkerWatcher.onDidChange(() => {
        this.scheduleTerminalAttachmentRefreshBurst();
      }),
      terminalAttachmentMarkerWatcher.onDidDelete(() => {
        this.scheduleTerminalAttachmentRefreshBurst();
      }),
      vscode.window.onDidOpenTerminal((terminal) => {
        this.scheduleVscodeTerminalTitleRefresh(terminal);
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
          void this.refreshContainerServices({ background: true });
          this.applyVscodeWindowTerminalEnvironment();
        }
        if (event.affectsConfiguration("portManager")) {
          void this.writeTerminalNetworkSelectionFile();
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
    await this.reconcileComposeAttachmentPublishedPorts({ background: true });
    await this.writeComposeProjectRoutingFile();
    await this.writeTerminalNetworkSelectionFile();
    await this.startBrowserDnsServer();
    this.syncBrowserDnsRecords();
    void this.maybeAutoInstallBrowserDnsResolvers();
    await this.restorePersistedComposeRoutesIfMissing();
    await this.refreshTerminals();
    void this.refreshContainerServices({ background: true });
    await this.convergeDaemonAndRoutingState();
    await this.syncBrowserNetworkProxies();
    this.startRoutingSignalRefreshLoop();
    this.startTerminalAttachmentMarkerPolling();
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

  /** Returns the latest daemon route/process snapshot for routing status UI. */
  getAgentSnapshot(): AgentSnapshot {
    return this.processService?.getSnapshot() ?? createDisconnectedAgentSnapshot();
  }

  /**
   * Returns a browser-facing URL whose host is unique per logical network.
   * The upstream request is still rewritten as localhost so dev auth settings
   * that reject raw loopback aliases can continue to work.
   */
  async getBrowserIsolatedUrl(process: ManagedProcess): Promise<string | undefined> {
    if (!isBrowserProxyProcess(process, this.registry.getSnapshot().networks)) {
      return undefined;
    }

    const endpoint = await this.browserNetworkProxy.ensure(
      buildBrowserProxyEndpoint(process, this.registry.getSnapshot().networks, this.browserDnsServer.isRunning()),
    );
    return endpoint === undefined ? undefined : formatBrowserNetworkProxyUrl(endpoint);
  }

  /** Builds a sudo shell script that points macOS single-label resolvers at Port Manager DNS. */
  createBrowserDnsResolverSetupScript(): string {
    return buildBrowserDnsResolverSetupScript(
      buildBrowserDnsRecords(this.registry.getSnapshot().networks),
      this.browserDnsServer.getPort(),
    );
  }

  /** Returns browser DNS resolver installation state for diagnostics UI. */
  getBrowserDnsResolverStatus(): BrowserDnsResolverStatus {
    const networkSnapshot = this.registry.getSnapshot();
    const agentSnapshot = this.getAgentSnapshot();

    return buildBrowserDnsResolverStatus(
      buildBrowserDnsRecords(networkSnapshot.networks),
      this.browserDnsServer.getPort(),
      this.browserDnsServer.isRunning(),
      agentSnapshot.processes,
      agentSnapshot.routes,
      networkSnapshot.networks,
      this.browserNetworkProxy,
    );
  }

  /** Installs macOS resolver rows so browser URLs can use network names as hosts. */
  async installBrowserDnsResolvers(options: { readonly automatic?: boolean } = {}): Promise<BrowserDnsResolverStatus> {
    if (this.browserDnsResolverInstallInFlight !== undefined) {
      return this.browserDnsResolverInstallInFlight;
    }

    this.browserDnsResolverInstallInFlight = this.installBrowserDnsResolversExclusive(options);
    try {
      return await this.browserDnsResolverInstallInFlight;
    } finally {
      this.browserDnsResolverInstallInFlight = undefined;
    }
  }

  /** Removes only Port Manager-owned browser resolver files for current aliases. */
  async cleanupBrowserDnsResolvers(): Promise<BrowserDnsResolverStatus> {
    const status = this.getBrowserDnsResolverStatus();
    if (!status.supported || status.records.length === 0) {
      return status;
    }

    await runShellScriptWithAdministratorPrivileges(buildBrowserDnsResolverCleanupScript(status.records));
    this.localChangeEvents.emit();
    return this.getBrowserDnsResolverStatus();
  }

  private async installBrowserDnsResolversExclusive(
    options: { readonly automatic?: boolean },
  ): Promise<BrowserDnsResolverStatus> {
    const status = this.getBrowserDnsResolverStatus();
    if (!status.supported || status.records.length === 0 || status.missingCount === 0) {
      return status;
    }

    await runShellScriptWithAdministratorPrivileges(buildBrowserDnsResolverSetupScript(status.records, status.dnsPort));
    this.localChangeEvents.emit();

    if (options.automatic === true) {
      void vscode.window.showInformationMessage("Port Manager browser DNS aliases installed.");
    }

    return this.getBrowserDnsResolverStatus();
  }

  /** Starts one automatic resolver install prompt for each distinct missing alias set. */
  private maybeAutoInstallBrowserDnsResolvers(): void {
    const status = this.getBrowserDnsResolverStatus();
    if (!status.supported || !status.dnsRunning || status.missingCount === 0) {
      return;
    }

    const signature = status.records
      .filter((record) => !record.configured)
      .map((record) => `${record.hostname}:${record.address}:${status.dnsPort}`)
      .sort()
      .join("|");
    if (signature.length === 0 || this.browserDnsAutoInstallSignature === signature) {
      return;
    }

    this.browserDnsAutoInstallSignature = signature;
    void this.installBrowserDnsResolvers({ automatic: true }).catch(() => undefined);
  }

  /** Starts the local DNS responder used for single-label browser aliases. */
  private async startBrowserDnsServer(): Promise<void> {
    await this.browserDnsServer.start().catch(() => undefined);
  }

  /** Publishes current network-name aliases to the local browser DNS responder. */
  private syncBrowserDnsRecords(): void {
    const records = buildBrowserDnsRecords(this.registry.getSnapshot().networks);
    this.browserDnsServer.sync(records);
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
      await this.removeComposeAttachment(attachment.id);
    }

    if (network?.runtimeKind === "container") {
      await this.containerRuntime.removeNetwork(networkId).catch(() => undefined);
    }

    await this.removeManualTerminalAttachmentMarkersForNetwork(networkId).catch(() => undefined);

    return this.registry.removeNetwork(networkId);
  }

  /** Refreshes VS Code and external OS terminal windows. */
  async refreshTerminals(): Promise<readonly TerminalWindow[]> {
    if (this.terminalRefreshInFlight !== undefined) {
      this.terminalRefreshQueued = true;
      return this.terminalRefreshInFlight;
    }

    this.terminalRefreshInFlight = this.refreshTerminalsSerially().finally(() => {
      this.terminalRefreshInFlight = undefined;
    });

    return this.terminalRefreshInFlight;
  }

  /** Runs terminal refreshes sequentially while preserving one queued follow-up scan. */
  private async refreshTerminalsSerially(): Promise<readonly TerminalWindow[]> {
    let terminalWindows: readonly TerminalWindow[] = [];

    do {
      this.terminalRefreshQueued = false;
      terminalWindows = await this.refreshTerminalsExclusive();
    } while (this.terminalRefreshQueued);

    return terminalWindows;
  }

  /** Reads terminal/process state once and reconciles hook marker files into attachments. */
  private async refreshTerminalsExclusive(): Promise<readonly TerminalWindow[]> {
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
  async refreshContainerServices(
    options: BackgroundRefreshOptions = {},
  ): Promise<readonly ContainerServiceCandidate[]> {
    if (
      options.background === true &&
      this.lastContainerServiceRefreshAtMs > 0 &&
      Date.now() - this.lastContainerServiceRefreshAtMs < BACKGROUND_CONTAINER_REFRESH_INTERVAL_MS
    ) {
      return this.registry.getSnapshot().containerServiceCandidates;
    }

    if (this.containerServiceRefreshInFlight !== undefined) {
      return this.containerServiceRefreshInFlight;
    }

    const releaseSharedRefresh =
      options.background === true && options.sharedRefreshAcquired !== true
        ? tryAcquireSharedBackgroundContainerRefreshSlot()
        : undefined;

    if (options.background === true && options.sharedRefreshAcquired !== true && releaseSharedRefresh === undefined) {
      return this.registry.getSnapshot().containerServiceCandidates;
    }

    this.containerServiceRefreshInFlight = this.refreshContainerServicesExclusive({
      ...options,
      sharedRefreshAcquired: options.sharedRefreshAcquired === true || releaseSharedRefresh !== undefined,
    }).finally(() => {
      this.containerServiceRefreshInFlight = undefined;
      releaseSharedRefresh?.();
    });

    return this.containerServiceRefreshInFlight;
  }

  /** Runs one Docker/Podman discovery pass and records its refresh timestamp. */
  private async refreshContainerServicesExclusive(
    options: BackgroundRefreshOptions,
  ): Promise<readonly ContainerServiceCandidate[]> {
    const candidates = await this.containerServiceDiscovery
      .list(readContainerRuntimeSettings())
      .catch(() => []);

    this.lastContainerServiceRefreshAtMs = Date.now();
    this.registry.setContainerServiceCandidates(candidates);
    void this.reconcileComposeAttachmentPublishedPorts(
      options.background === true ? { background: true, sharedRefreshAcquired: options.sharedRefreshAcquired } : {},
    );
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
      this.scheduleTerminalWindowTitleRefresh(terminalWindow, network.name, processRows);
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

  /** Brings a discovered terminal window to the foreground when the platform exposes a focus route. */
  async revealTerminalWindow(terminalWindowId: string): Promise<boolean> {
    const terminalWindow = this.registry
      .getSnapshot()
      .terminalWindows.find((window) => window.id === terminalWindowId);

    if (terminalWindow === undefined) {
      throw new Error(`Unknown terminal window: ${terminalWindowId}`);
    }

    const processRows = await this.listProcessRowsForTerminalControl();
    return revealTerminalWindow(terminalWindow, processRows);
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

    const injectedTerminalCount = await this.injectRoutingIntoOpenVscodeTerminals(network, settings);
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
    return this.buildTerminalRoutingScript(network, settings);
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
        this.scheduleTerminalWindowTitleRefresh(terminalWindow, "detached", processRows);
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

    const network = requireNetwork(this.registry.getNetwork(networkId), networkId);
    const script = this.buildTerminalRoutingScript(network, settings);
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

    const workingDirectory = normalizeOptionalString(input.cwd);
    const attachment: ComposeAttachment = {
      id: createId("compose"),
      networkId: input.networkId,
      projectName: assertNonEmptyString(input.projectName, "Compose project name"),
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      composeFiles: [...(input.composeFiles ?? [])],
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      ports: input.ports.map(normalizeComposePublishedPort),
      status: "attached",
      attachedAt: new Date().toISOString(),
    };
    const existingAttachments = this.registry.getSnapshot().composeAttachments;
    const equivalentAttachment = findEquivalentComposeAttachment(existingAttachments, attachment, input);
    if (equivalentAttachment !== undefined) {
      const refreshedAttachment =
        equivalentAttachment.workingDirectory === undefined && attachment.workingDirectory !== undefined
          ? this.registry.updateComposeAttachment({
              ...equivalentAttachment,
              workingDirectory: attachment.workingDirectory,
            })
          : equivalentAttachment;
      await this.restorePersistedComposeRoutes([refreshedAttachment]);
      await this.convergeAfterComposeAttachmentChange([refreshedAttachment]);
      return this.getComposeAttachment(refreshedAttachment.id) ?? refreshedAttachment;
    }

    const conflict = findComposeRouteConflict(existingAttachments, attachment);
    if (conflict !== undefined) {
      throw new Error(formatComposeRouteConflictMessage(network, attachment, conflict));
    }

    const registeredProcessIds: string[] = [];
    let registeredAttachment = attachment;
    let mutation: ComposePortMutationState | undefined;

    try {
      if (input.composeMutation !== undefined) {
        const mutationResult = await this.composePublishMutator.hidePublishedPorts({
          mode: input.composeMutation.mode,
          allowStatefulClone: input.composeMutation.allowStatefulClone,
          attachedProjectName: input.composeMutation.attachedProjectName,
          runtime: input.composeMutation.runtime,
          networkName: network.name,
          networkId: network.id,
          originalProjectName: attachment.projectName,
          workingDirectory: input.composeMutation.workingDirectory ?? input.cwd,
          composeFiles: input.composeMutation.composeFiles ?? input.composeFiles ?? [],
          sourceContainerMappings: input.composeMutation.sourceContainerMappings,
          copyStoppedServices: input.composeMutation.copyStoppedServices,
          ports: attachment.ports,
        });

        mutation = mutationResult.state;
        registeredAttachment = {
          ...attachment,
          runtime: mutation.runtime,
          workingDirectory: mutation.workingDirectory ?? attachment.workingDirectory,
          composeFiles: mutation.composeFiles,
          ports: mutationResult.ports,
          mutation,
        };
      }
      if (input.existingMutation !== undefined) {
        mutation = input.existingMutation;
        registeredAttachment = {
          ...attachment,
          runtime: mutation.runtime,
          projectName: mutation.originalProjectName,
          workingDirectory: mutation.workingDirectory ?? attachment.workingDirectory,
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
            composeAttachmentWorkingDirectory(registeredAttachment),
          ),
        );

        registeredProcessIds.push(process.id);
        ports.push({
          ...port,
          processId: process.id,
        });
      }

      const updatedAttachment = this.registry.updateComposeAttachment({
        ...registeredAttachment,
        ports,
      });
      await this.convergeAfterComposeAttachmentChange([updatedAttachment]);

      return updatedAttachment;
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
    await this.writeTerminalNetworkSelectionFile().catch(() => undefined);
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
    await this.writeTerminalNetworkSelectionFile().catch(() => undefined);
    return removedAttachment;
  }

  /** Returns one compose attachment from the latest snapshot. */
  getComposeAttachment(attachmentId: string): ComposeAttachment | undefined {
    return this.registry.getSnapshot().composeAttachments.find((attachment) => attachment.id === attachmentId);
  }

  /**
   * Copies a Compose attachment into another logical network. When Compose
   * runtime metadata is available this creates a separate hidden Compose
   * project, including stopped services; older route-only rows fall back to
   * sharing the currently published endpoints.
   */
  async copyComposeAttachment(input: ComposeAttachmentCopyInput): Promise<ComposeAttachment | undefined> {
    const source = this.getComposeAttachment(input.attachmentId);
    if (source === undefined) {
      return undefined;
    }

    if (source.status !== "attached") {
      throw new Error(`Only attached Compose routes can be copied. "${source.projectName}" is ${source.status}.`);
    }

    const network = requireNetwork(this.registry.getNetwork(input.networkId), input.networkId);
    if (source.networkId === network.id) {
      throw new Error(`"${composeRuntimeProjectName(source)}" is already attached to "${network.name}". Choose another logical network.`);
    }

    const composeFiles = composeRouteCopyFiles(source);
    const runtime = source.runtime ?? source.mutation?.runtime;
    const cwd = composeAttachmentWorkingDirectory(source) ?? composeWorkingDirectoryFromFiles(composeFiles) ?? process.cwd();
    if (runtime !== undefined && composeFiles.length > 0) {
      return this.attachComposePublishedPorts({
        networkId: network.id,
        projectName: composeRuntimeProjectName(source),
        runtime,
        cwd,
        composeFiles,
        composeMutation: {
          mode: "copy",
          allowStatefulClone: true,
          runtime,
          workingDirectory: cwd,
          composeFiles,
          copyStoppedServices: true,
          ...(source.mutation?.containerMappings !== undefined
            ? { sourceContainerMappings: source.mutation.containerMappings }
            : {}),
        },
        ports: source.ports.map(dropComposeProcessId),
      });
    }

    return this.attachComposePublishedPorts({
      networkId: network.id,
      projectName: composeRuntimeProjectName(source),
      runtime,
      cwd,
      composeFiles,
      ports: source.ports.map(dropComposeProcessId),
    });
  }

  /** Renames the real hidden Compose project backing a cloned attachment. */
  async renameComposeAttachment(
    attachmentId: string,
    attachedProjectName: string,
  ): Promise<ComposeAttachment | undefined> {
    if (this.processService === undefined) {
      throw new Error("Compose project rename requires the Port Manager daemon.");
    }

    const attachment = this.getComposeAttachment(attachmentId);
    if (attachment === undefined) {
      return undefined;
    }

    const mutation = attachment.mutation;
    if (mutation === undefined || mutation.mode !== "clone") {
      throw new Error("Only cloned Compose attachments can change the Compose project name.");
    }

    try {
      const mutationResult = await this.composePublishMutator.renameAttachedProject(
        mutation,
        attachedProjectName,
      );
      await this.processService.start();
      await this.removeComposeRouteProcesses(attachment, attachment.ports);
      const updatedAttachment = this.registry.updateComposeAttachment({
        ...attachment,
        projectName: mutationResult.state.attachedProjectName,
        composeFiles: mutationResult.state.composeFiles,
        ports: mutationResult.ports.map(dropComposeProcessId),
        mutation: mutationResult.state,
        status: "attached",
        errorMessage: undefined,
      });

      await this.restorePersistedComposeRoutes([updatedAttachment]);
      void this.syncLogicalPortRouters();

      return this.getComposeAttachment(attachmentId) ?? updatedAttachment;
    } catch (error) {
      this.registry.updateComposeAttachment({
        ...attachment,
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
    const summary = await removeRoutingFilePaths(cleanupPaths);
    const attachments = this.registry
      .getSnapshot()
      .composeAttachments.filter(isRestorableComposeAttachment);

    return this.rehydrateRoutingFiles(summary, attachments);
  }

  /**
   * Removes only generated route/cache files scoped to one logical network.
   *
   * Docker state and durable registry rows are preserved. The network's compose
   * routes are rehydrated immediately so attached clones stay reachable after a
   * stale TSV/JSON cleanup.
   */
  async clearNetworkRoutingFiles(networkId: string): Promise<RoutingFileCleanupSummary> {
    const network = this.registry.getNetwork(networkId);
    if (network === undefined) {
      throw new Error(`Unknown logical network: ${networkId}`);
    }

    const cleanupPaths = await this.collectNetworkRoutingFileCleanupPaths(network.id);
    const summary = await removeRoutingFilePaths(cleanupPaths);
    const markerSummary = await this.clearManualTerminalAttachmentMarkersForNetwork(network.id);

    return this.rehydrateRoutingFiles(
      {
        removedFileCount: summary.removedFileCount + markerSummary.removedFileCount,
        failedFileCount: summary.failedFileCount + markerSummary.failedFileCount,
      },
      this.registry
        .getSnapshot()
        .composeAttachments.filter(
          (attachment) => attachment.networkId === network.id && isRestorableComposeAttachment(attachment),
        ),
    );
  }

  /**
   * User-triggered repair path for stale daemon/routes/terminal marker drift.
   *
   * Only generated control-plane files are deleted. Durable network bindings,
   * Compose clone state, containers, and volumes are preserved, then runtime
   * files and daemon rows are rebuilt from the current registry snapshot.
   */
  async fixStaleRouting(): Promise<StaleRoutingRepairSummary> {
    const beforeDaemon = this.getDaemonStatus();
    const markerCountBefore = await this.countManualTerminalAttachmentMarkerFiles();
    const cleanupSummary = await this.clearRoutingFiles();
    const terminalWindows = await this.refreshTerminals().catch(() => []);
    const markerCountAfter = await this.countManualTerminalAttachmentMarkerFiles();

    await this.reconcileComposeAttachmentPublishedPorts().catch(() => undefined);
    await this.convergeDaemonAndRoutingState();
    await this.processService?.refresh().catch(() => undefined);

    const afterDaemon = this.getDaemonStatus();
    const daemonRestarted =
      beforeDaemon.restartRequired === true &&
      afterDaemon.restartRequired !== true &&
      (beforeDaemon.pid <= 0 || afterDaemon.pid !== beforeDaemon.pid || afterDaemon.versionStatus === "current");

    return {
      ...cleanupSummary,
      staleDaemonDetected: beforeDaemon.restartRequired === true,
      daemonRestarted,
      removedMarkerCount: Math.max(0, markerCountBefore - markerCountAfter),
      terminalCount: terminalWindows.length,
      routeCount: this.getAgentSnapshot().routes.length,
    };
  }

  /** Releases listeners and event subscriptions. */
  dispose(): void {
    if (this.routingSignalRefreshTimer !== undefined) {
      clearInterval(this.routingSignalRefreshTimer);
      this.routingSignalRefreshTimer = undefined;
    }
    if (this.terminalAttachmentMarkerPollTimer !== undefined) {
      clearInterval(this.terminalAttachmentMarkerPollTimer);
      this.terminalAttachmentMarkerPollTimer = undefined;
    }
    if (this.terminalAttachmentRefreshTimer !== undefined) {
      clearTimeout(this.terminalAttachmentRefreshTimer);
      this.terminalAttachmentRefreshTimer = undefined;
    }

    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    this.registry.dispose();
    this.localChangeEvents.clear();
    void this.proxyManager.dispose();
    void this.browserNetworkProxy.dispose();
    this.browserDnsServer.dispose();
    this.logicalPortRouter.dispose();
    releaseLogicalRouterOwnerLease();
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
    await this.reconcileComposeAttachmentPublishedPorts({ background: true });
    await this.writeComposeProjectRoutingFile();
    await this.writeTerminalNetworkSelectionFile();
    await this.restorePersistedComposeRoutesIfMissing();
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
            networkName: this.registry.getNetwork(networkId)?.name,
            composeRoutingFilePath: this.getComposeProjectRoutingFilePath(networkId),
          },
    );
  }

  /** Sends the current network routing script to all already-open VS Code terminals. */
  private async injectRoutingIntoOpenVscodeTerminals(
    network: LogicalNetwork,
    settings: PortManagerSettings,
  ): Promise<number> {
    const injectedTerminalCount = sendCommandToOpenVscodeTerminals(
      this.buildTerminalRoutingScript(network, settings),
    );
    await this.refreshTerminals().catch(() => []);
    return injectedTerminalCount;
  }

  /** Labels a newly opened VS Code terminal after env collection selects a network. */
  private scheduleVscodeTerminalTitleRefresh(terminal: vscode.Terminal): void {
    const networkId = this.vscodeWindowTerminalBinding?.networkId;
    const network = networkId === undefined ? undefined : this.registry.getNetwork(networkId);

    if (network === undefined) {
      return;
    }

    setTimeout(() => {
      try {
        terminal.sendText(buildTerminalTitleShell(buildPortManagerTerminalTitle(network.name)), true);
      } catch {
        // The terminal can close between the open event and the delayed title write.
      }
    }, 250);
  }

  /** Sends a delayed title command to a known terminal window after shell state changes. */
  private scheduleTerminalWindowTitleRefresh(
    terminalWindow: TerminalWindow,
    networkName: string,
    processRows: readonly ProcessTableRow[],
  ): void {
    setTimeout(() => {
      void sendCommandToTerminalWindow(
        terminalWindow,
        buildTerminalTitleShell(buildPortManagerTerminalTitle(networkName)),
        processRows,
        this.getTtyInputHelperPath(),
      ).catch(() => undefined);
    }, 250);
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
  private async restorePersistedComposeRoutesIfMissing(options: ComposeRouteRestoreOptions = {}): Promise<void> {
    if (!options.allowDuringComposeReconcile && this.composeAttachmentReconcileInFlight !== undefined) {
      await this.composeAttachmentReconcileInFlight.catch(() => undefined);
    }

    if (this.composeRouteRestoreInFlight !== undefined) {
      return this.composeRouteRestoreInFlight;
    }

    const attachments = this.registry
      .getSnapshot()
      .composeAttachments.filter(isRestorableComposeAttachment);
    if (
      attachments.length === 0 ||
      this.processService === undefined ||
      !this.hasMissingPersistedComposeRoutes(attachments)
    ) {
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
      .composeAttachments.filter(
        (attachment) => isRestorableComposeAttachment(attachment) && attachment.mutation === undefined,
      );

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
   * Starts a low-frequency poll for external signals that VS Code may miss.
   *
   * File watchers and terminal events are best effort, and Docker can recreate
   * hidden containers without an extension event. This loop reconciles terminal
   * markers, container candidates, compose endpoint routes, and then lets
   * registry events refresh the UI only when the observed state changed.
   */
  private startRoutingSignalRefreshLoop(): void {
    if (this.routingSignalRefreshTimer !== undefined) {
      return;
    }

    this.routingSignalRefreshTimer = setInterval(() => {
      void this.refreshRoutingSignals();
    }, ROUTING_SIGNAL_REFRESH_INTERVAL_MS);
  }

  /** Performs one serialized background refresh of terminals and container-backed routes. */
  private async refreshRoutingSignals(): Promise<void> {
    if (this.routingSignalRefreshInFlight !== undefined) {
      return this.routingSignalRefreshInFlight;
    }

    this.routingSignalRefreshInFlight = this.refreshRoutingSignalsExclusive().finally(() => {
      this.routingSignalRefreshInFlight = undefined;
    });

    return this.routingSignalRefreshInFlight;
  }

  private async refreshRoutingSignalsExclusive(): Promise<void> {
    await Promise.all([
      this.refreshTerminals().catch(() => []),
      this.refreshContainerServices({ background: true }).catch(() => []),
    ]);
    await this.reconcileComposeAttachmentPublishedPorts({ background: true }).catch(() => undefined);
    await this.convergeDaemonAndRoutingState();
    await this.writeTerminalNetworkSelectionFile().catch(() => undefined);
  }

  /**
   * Closes the small stale window after a compose attach/copy command.
   *
   * Registry change events also rewrite these files, but they are intentionally
   * fire-and-forget. Waiting here means a terminal that was already attached to
   * the target network can run `docker compose` immediately after the command
   * returns and see the new project routing rows.
   */
  private async convergeAfterComposeAttachmentChange(attachments: readonly ComposeAttachment[]): Promise<void> {
    if (attachments.length === 0) {
      return;
    }

    await this.writeComposeProjectRoutingFile().catch(() => undefined);
    await this.writeTerminalNetworkSelectionFile().catch(() => undefined);
    await this.restorePersistedComposeRoutesIfMissing().catch(() => undefined);
    await this.convergeDaemonAndRoutingState();
    await this.refreshContainerServices().catch(() => []);
    this.localChangeEvents.emit();
  }

  /**
   * Gradually converges all generated routing channels after missed events.
   *
   * UI state is durable in VS Code storage, while the daemon and generated files
   * are disposable runtime state. Running this from the background refresh loop
   * makes stale daemon replacement, host-access files, compose project maps,
   * daemon route tables, and localhost logical routers eventually agree even
   * when VS Code or Docker drops an event.
   */
  private async convergeDaemonAndRoutingState(): Promise<void> {
    if (this.daemonConvergenceInFlight !== undefined) {
      return this.daemonConvergenceInFlight;
    }

    this.daemonConvergenceInFlight = this.convergeDaemonAndRoutingStateExclusive().finally(() => {
      this.daemonConvergenceInFlight = undefined;
    });

    return this.daemonConvergenceInFlight;
  }

  private async convergeDaemonAndRoutingStateExclusive(): Promise<void> {
    await this.ensureCurrentProcessDaemon().catch(() => undefined);
    await this.writeHostAccessBindingsFile().catch(() => undefined);
    await this.writeComposeProjectRoutingFile().catch(() => undefined);
    await this.writeTerminalNetworkSelectionFile().catch(() => undefined);
    await this.restorePersistedComposeRoutesIfMissing().catch(() => undefined);

    if (this.processService !== undefined && tryAcquireLogicalRouterOwnerLease()) {
      /*
       * The daemon refresh path rewrites its route-table files from the current
       * snapshot. Only the cross-window router owner performs this expensive
       * listener scan; other windows consume the agent's event snapshots and
       * close any local routers they still own below.
       */
      await this.processService.refresh().catch(() => undefined);
    }

    await this.syncLogicalPortRouters().catch(() => undefined);
  }

  /**
   * Ensures the singleton daemon is connected and belongs to this extension
   * build. Restart failures are backed off because route convergence continues
   * through file regeneration and compose rehydration on later passes.
   */
  private async ensureCurrentProcessDaemon(): Promise<void> {
    if (this.processService === undefined) {
      return;
    }

    const daemon = this.processService.getSnapshot().daemon;
    if (daemon.status !== "running") {
      await this.processService.start();
      this.localChangeEvents.emit();
      return;
    }

    if (!daemon.restartRequired) {
      return;
    }

    const nowMs = Date.now();
    if (nowMs < this.daemonRestartBackoffUntilMs) {
      return;
    }

    this.daemonRestartBackoffUntilMs = nowMs + DAEMON_RESTART_BACKOFF_MS;
    await this.processService.restartDaemon();
    this.daemonRestartBackoffUntilMs = 0;
    this.localChangeEvents.emit();
  }

  /**
   * Watches the marker directory with Node's native watcher in addition to the
   * VS Code watcher. Global storage file events can lag or be dropped outside a
   * workspace folder, while this watcher observes the exact directory the shell
   * writes to.
   */
  private watchTerminalAttachmentMarkers(directoryPath: string): DisposableLike {
    try {
      const watcher = syncFs.watch(directoryPath, { persistent: false }, (_eventType, fileName) => {
        const markerName = fileName === undefined || fileName === null ? undefined : String(fileName);
        if (markerName === undefined || markerName.endsWith(".tsv")) {
          this.scheduleTerminalAttachmentRefreshBurst();
        }
      });
      watcher.on("error", () => undefined);
      return {
        dispose: () => watcher.close(),
      };
    } catch {
      return {
        dispose: () => undefined,
      };
    }
  }

  /** Starts a stat-only fallback poll for terminal hook marker changes. */
  private startTerminalAttachmentMarkerPolling(): void {
    if (this.terminalAttachmentMarkerPollTimer !== undefined) {
      return;
    }

    void this.refreshTerminalAttachmentsWhenMarkersChanged();
    this.terminalAttachmentMarkerPollTimer = setInterval(() => {
      void this.refreshTerminalAttachmentsWhenMarkersChanged();
    }, TERMINAL_ATTACHMENT_MARKER_POLL_INTERVAL_MS);
    this.terminalAttachmentMarkerPollTimer.unref?.();
  }

  /** Schedules a short refresh burst so process-table discovery can catch up to the shell marker. */
  private scheduleTerminalAttachmentRefreshBurst(): void {
    this.terminalAttachmentRefreshBurstUntilMs = Date.now() + TERMINAL_ATTACHMENT_REFRESH_BURST_WINDOW_MS;
    this.scheduleTerminalAttachmentRefresh(TERMINAL_ATTACHMENT_REFRESH_DEBOUNCE_MS);
  }

  private scheduleTerminalAttachmentRefresh(delayMs: number): void {
    if (this.terminalAttachmentRefreshTimer !== undefined) {
      return;
    }

    this.terminalAttachmentRefreshTimer = setTimeout(() => {
      this.terminalAttachmentRefreshTimer = undefined;
      void this.runTerminalAttachmentRefreshBurstStep();
    }, delayMs);
    this.terminalAttachmentRefreshTimer.unref?.();
  }

  private async runTerminalAttachmentRefreshBurstStep(): Promise<void> {
    await this.refreshTerminals().catch(() => []);
    if (Date.now() < this.terminalAttachmentRefreshBurstUntilMs) {
      this.scheduleTerminalAttachmentRefresh(TERMINAL_ATTACHMENT_REFRESH_BURST_INTERVAL_MS);
    }
  }

  /**
   * Reads only names, sizes, and mtimes until a marker changes. Full marker
   * parsing and process-table scans happen only when this cheap signature moves.
   */
  private async refreshTerminalAttachmentsWhenMarkersChanged(): Promise<void> {
    const signature = await this.readTerminalAttachmentMarkerSignature();
    if (signature === this.terminalAttachmentMarkerSignature) {
      return;
    }

    this.terminalAttachmentMarkerSignature = signature;
    this.scheduleTerminalAttachmentRefreshBurst();
  }

  private async readTerminalAttachmentMarkerSignature(): Promise<string> {
    const markerDirectory = this.getTerminalAttachmentMarkerDirectoryPath();
    const entries = await fs.readdir(markerDirectory, { withFileTypes: true }).catch(() => []);
    const rows = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".tsv"))
        .map(async (entry) => {
          const filePath = path.join(markerDirectory, entry.name);
          const stats = await fs.stat(filePath).catch(() => undefined);
          if (stats === undefined) {
            return `${entry.name}:missing`;
          }

          return `${entry.name}:${stats.size}:${Math.trunc(stats.mtimeMs)}`;
        }),
    );

    return rows.sort().join("\n");
  }

  /** Rewrites compose route rows when Docker changed a running container's host port. */
  private async reconcileComposeAttachmentPublishedPorts(
    options: BackgroundRefreshOptions = {},
  ): Promise<void> {
    if (this.composeRouteRestoreInFlight !== undefined) {
      await this.composeRouteRestoreInFlight.catch(() => undefined);
    }

    if (
      options.background === true &&
      this.lastComposeAttachmentReconcileAtMs > 0 &&
      Date.now() - this.lastComposeAttachmentReconcileAtMs < BACKGROUND_CONTAINER_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    if (this.composeAttachmentReconcileInFlight !== undefined) {
      return this.composeAttachmentReconcileInFlight;
    }

    const releaseSharedRefresh =
      options.background === true && options.sharedRefreshAcquired !== true
        ? tryAcquireSharedBackgroundContainerRefreshSlot()
        : undefined;

    if (options.background === true && options.sharedRefreshAcquired !== true && releaseSharedRefresh === undefined) {
      return;
    }

    this.composeAttachmentReconcileInFlight = this.reconcileComposeAttachmentPublishedPortsExclusive().finally(() => {
      this.composeAttachmentReconcileInFlight = undefined;
      releaseSharedRefresh?.();
    });

    return this.composeAttachmentReconcileInFlight;
  }

  /** Performs one serialized live compose endpoint reconciliation pass. */
  private async reconcileComposeAttachmentPublishedPortsExclusive(): Promise<void> {
    this.lastComposeAttachmentReconcileAtMs = Date.now();

    if (this.processService === undefined) {
      return;
    }

    const attachments = this.registry
      .getSnapshot()
      .composeAttachments.filter(isRestorableComposeAttachment);
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
    }

    await this.restorePersistedComposeRoutesIfMissing({ allowDuringComposeReconcile: true });
    void this.syncLogicalPortRouters();
  }

  /** Refreshes clone container id rewrites without changing attach policy state. */
  private async refreshComposeContainerMappings(
    attachment: ComposeAttachment,
    settings: ReturnType<typeof readContainerRuntimeSettings>,
  ): Promise<ComposePortMutationState | undefined> {
    const mutation = attachment.mutation;
    if (
      mutation === undefined ||
      (mutation.mode !== "clone" && mutation.mode !== "copy") ||
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

    const snapshot = this.processService.getSnapshot();
    return attachments.some((attachment) =>
      attachment.ports.some((port) => {
        const hasRuntimeListener = hasComposePublishedPortListener(snapshot.listeners, attachment, port);
        const hasRoute = hasComposeRoute(snapshot.routes, attachment.networkId, port);

        if (!hasRuntimeListener) {
          return hasRoute || port.processId !== undefined;
        }

        return attachment.status !== "attached" || attachment.errorMessage !== undefined || !hasRoute;
      }),
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
        const cwd = composeAttachmentWorkingDirectory(attachment);
        const snapshot = this.processService.getSnapshot();
        for (const port of attachment.ports) {
          const hasRuntimeListener = hasComposePublishedPortListener(snapshot.listeners, attachment, port);
          const hasRoute = hasComposeRoute(snapshot.routes, attachment.networkId, port);

          if (!hasRuntimeListener) {
            if (hasRoute || port.processId !== undefined) {
              await this.removeComposeRouteProcesses(attachment, [port]);
            }

            ports.push(dropComposeProcessId(port));
            continue;
          }

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
   * Resolves a browser alias request to the current network-local web server.
   * The HTTP proxy rewrites headers, while this method only chooses the live
   * socket target from the daemon route table.
   */
  private async resolveBrowserNetworkProxyTarget(
    endpoint: Pick<BrowserNetworkProxyEndpoint, "networkId" | "logicalPort">,
  ): Promise<BrowserNetworkProxyTarget> {
    const route = await this.findNetworkRoute(endpoint.networkId, endpoint.logicalPort);
    if (route === undefined || !isLiveListenRoute(route)) {
      const fallbackTarget = await this.findBrowserProxyFallbackListenerTarget(endpoint.networkId, endpoint.logicalPort);
      if (fallbackTarget !== undefined) {
        return fallbackTarget;
      }

      throw new Error(`No browser proxy route for ${endpoint.networkId}:${endpoint.logicalPort}.`);
    }

    return {
      host: route.host,
      port: route.actualPort,
    };
  }

  /**
   * Package managers sometimes launch dev servers through an absolute runtime
   * path after protected shebang hops have stripped DYLD. Those processes still
   * inherit the terminal's network id, so browser isolation can safely target a
   * same-port live listener without changing the global logical route table.
   */
  private async findBrowserProxyFallbackListenerTarget(
    networkId: string,
    logicalPort: number,
  ): Promise<BrowserNetworkProxyTarget | undefined> {
    const listener = await this.findNetworkScopedListener(networkId, logicalPort);
    if (listener === undefined) {
      return undefined;
    }

    return {
      host: normalizeBrowserProxyTargetHost(listener.localAddress),
      port: listener.port,
    };
  }

  private async findNetworkScopedListener(
    networkId: string,
    logicalPort: number,
  ): Promise<ListeningPort | undefined> {
    const findInSnapshot = async (snapshot: AgentSnapshot): Promise<ListeningPort | undefined> => {
      for (const listener of snapshot.listeners) {
        if (listener.port !== logicalPort || listener.pid === undefined) {
          continue;
        }

        const listenerNetworkId = await this.processEnvironmentProvider
          .readRoutingNetworkId(listener.pid)
          .catch(() => undefined);
        if (listenerNetworkId === networkId) {
          return listener;
        }
      }

      return undefined;
    };

    const current = await findInSnapshot(this.getAgentSnapshot());
    if (current !== undefined || this.processService === undefined) {
      return current;
    }

    await this.processService.refresh().catch(() => undefined);
    return findInSnapshot(this.processService.getSnapshot());
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
          : this.findClientCwdRouteForRouter(connection.logicalPort, clientProcess.cwd);

      if (cwdRoute !== undefined) {
        return {
          host: cwdRoute.host,
          port: cwdRoute.actualPort,
        };
      }

      const uniqueRoute = await this.findUniqueRouteForRouter(connection.logicalPort);
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

  /** Opens localhost routers for live logical routes that unhooked clients may need. */
  private async syncLogicalPortRouters(): Promise<void> {
    if (this.logicalRouterSyncInFlight !== undefined) {
      this.logicalRouterSyncQueued = true;
      return this.logicalRouterSyncInFlight;
    }

    this.logicalRouterSyncInFlight = this.syncLogicalPortRoutersQueued().finally(() => {
      this.logicalRouterSyncInFlight = undefined;
    });

    return this.logicalRouterSyncInFlight;
  }

  /** Runs router reconciliation until one queued refresh has seen the latest snapshot. */
  private async syncLogicalPortRoutersQueued(): Promise<void> {
    do {
      this.logicalRouterSyncQueued = false;
      await this.syncLogicalPortRoutersExclusive();
    } while (this.logicalRouterSyncQueued);
  }

  private async syncLogicalPortRoutersExclusive(): Promise<void> {
    /*
     * Native hooks normally rewrite connect() directly, but macOS protected
     * tools such as /usr/bin/curl ignore DYLD injection and some package
     * launchers can lose the preload before opening client sockets. Open
     * routers only after a listener route is running; pending allocations stay
     * excluded so the router cannot win the app server's original bind race.
     */
    const snapshot = this.processService?.getSnapshot();
    const logicalPorts = collectLogicalRouterPorts(snapshot?.routes ?? [], snapshot?.listeners ?? []);

    if (!tryAcquireLogicalRouterOwnerLease()) {
      await this.logicalPortRouter.sync([]).catch(() => undefined);
      return;
    }

    await this.logicalPortRouter.sync(logicalPorts).catch(() => undefined);
  }

  /** Keeps per-network browser entrypoints in sync with running web process rows. */
  private async syncBrowserNetworkProxies(): Promise<void> {
    if (this.browserProxySyncInFlight !== undefined) {
      this.browserProxySyncQueued = true;
      return this.browserProxySyncInFlight;
    }

    this.browserProxySyncInFlight = this.syncBrowserNetworkProxiesQueued().finally(() => {
      this.browserProxySyncInFlight = undefined;
    });

    return this.browserProxySyncInFlight;
  }

  /** Runs browser proxy reconciliation until one queued refresh sees the latest snapshot. */
  private async syncBrowserNetworkProxiesQueued(): Promise<void> {
    do {
      this.browserProxySyncQueued = false;
      await this.syncBrowserNetworkProxiesExclusive();
    } while (this.browserProxySyncQueued);
  }

  private async syncBrowserNetworkProxiesExclusive(): Promise<void> {
    const snapshot = this.processService?.getSnapshot();
    const endpoints = collectBrowserProxyEndpoints(
      snapshot?.processes ?? [],
      this.registry.getSnapshot().networks,
      this.browserDnsServer.isRunning(),
    );

    await this.browserNetworkProxy.sync(endpoints).catch(() => undefined);
  }

  /**
   * Resolves the caller's network from process-tree labels first.
   * Environment variables from the native hook remain as a compatibility
   * fallback for clients whose ancestry has already detached from a terminal.
   */
  private async findClientNetworkForRouter(
    pid: number,
    processRows: readonly ProcessTableRow[],
  ): Promise<string | undefined> {
    const processTreeNetworkId = this.findAttachedNetworkForPid(pid, processRows);
    if (processTreeNetworkId !== undefined) {
      return processTreeNetworkId;
    }

    const environmentNetworkId = await this.processEnvironmentProvider.readRoutingNetworkId(pid).catch(() => undefined);

    return environmentNetworkId;
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
        isLiveListenRoute(route),
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
   * Debug adapters, browsers, and host CLIs can originate outside an attached
   * terminal. A single live route, including a Compose route, is still safe
   * because there is no network choice to make.
   */
  private async findUniqueRouteForRouter(
    logicalPort: number,
  ): Promise<LogicalPortRoute | undefined> {
    if (this.processService === undefined) {
      return undefined;
    }

    const snapshot = this.processService.getSnapshot();
    const candidates = snapshot.routes.filter(
      (route) =>
        route.logicalPort === logicalPort &&
        route.actualPort !== route.logicalPort &&
        isLiveListenRoute(route),
    );

    if (candidates.length === 1) {
      return candidates[0];
    }

    return undefined;
  }

  /**
   * Uses client cwd as a deterministic fallback when environment variables and
   * terminal ancestry are unavailable. This keeps simultaneous logical ports in
   * sibling projects from collapsing into the global "unique route" fallback.
   */
  private findClientCwdRouteForRouter(
    logicalPort: number,
    clientCwd: string,
  ): LogicalPortRoute | undefined {
    if (this.processService === undefined) {
      return undefined;
    }

    const snapshot = this.processService.getSnapshot();
    const candidates = findRoutesMatchingClientCwd(snapshot.routes, logicalPort, clientCwd);

    if (candidates.length === 1) {
      return candidates[0];
    }

    return undefined;
  }

  /** Maps an arbitrary process PID back to the network label attached to its process tree. */
  private findAttachedNetworkForPid(pid: number, processRows: readonly ProcessTableRow[]): string | undefined {
    return resolveProcessTreeNetworkLabel(this.registry.getSnapshot().attachments, processRows, pid)?.networkId;
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
      entryName === TERMINAL_NETWORK_SELECTION_FILE_NAME ||
      (entryName.startsWith(COMPOSE_PROJECT_ROUTING_FILE_PREFIX) && entryName.endsWith(".tsv")),
    ).then((paths) => paths.forEach((filePath) => filePaths.add(filePath)));

    return filePaths;
  }

  /** Collects generated routing files that are scoped to one logical network. */
  private async collectNetworkRoutingFileCleanupPaths(networkId: string): Promise<ReadonlySet<string>> {
    const filePaths = new Set<string>();
    const networkRouteTablePath = getRouteTablePathForNetwork(networkId);
    const networkRouteTableName = path.basename(networkRouteTablePath);
    const networkRouteTableStem = path.basename(networkRouteTablePath, path.extname(networkRouteTablePath));
    const networkRouteTableExtension = path.extname(networkRouteTablePath) || ".json";
    const networkScope = sanitizeRouteFileScope(networkId);

    await this.collectMatchingFiles(path.dirname(getDefaultRouteTablePath()), (entryName) =>
      entryName === networkRouteTableName ||
      (entryName.startsWith(`${networkRouteTableStem}-`) && entryName.endsWith(networkRouteTableExtension)),
    ).then((paths) => paths.forEach((filePath) => filePaths.add(filePath)));

    await this.collectMatchingFiles(this.context.globalStorageUri.fsPath, (entryName) =>
      entryName === `${COMPOSE_PROJECT_ROUTING_FILE_PREFIX}${networkScope}.tsv` ||
      (entryName.startsWith(`${COMPOSE_PROJECT_ROUTING_FILE_PREFIX}${networkScope}${COMPOSE_PROJECT_ROUTING_COMPOSE_SEPARATOR}`) &&
        entryName.endsWith(".tsv")) ||
      entryName === `portmanager-bash-env-${networkScope}.sh`,
    ).then((paths) => paths.forEach((filePath) => filePaths.add(filePath)));

    await this.collectMatchingFiles(this.getTerminalHookScriptDirectoryPath(), (entryName) =>
      entryName === `attach-${networkScope}.sh`,
    ).then((paths) => paths.forEach((filePath) => filePaths.add(filePath)));

    return filePaths;
  }

  /** Rewrites generated route files and daemon compose rows after cleanup. */
  private async rehydrateRoutingFiles(
    summary: FileCleanupSummary,
    attachments: readonly ComposeAttachment[],
  ): Promise<RoutingFileCleanupSummary> {
    await this.writeHostAccessBindingsFile().catch(() => undefined);
    await this.writeComposeProjectRoutingFile().catch(() => undefined);
    await this.writeTerminalNetworkSelectionFile().catch(() => undefined);

    const restoredComposeRouteCount =
      this.processService === undefined ? 0 : attachments.reduce((sum, attachment) => sum + attachment.ports.length, 0);
    await this.restorePersistedComposeRoutes(attachments);
    await this.syncLogicalPortRouters();

    return {
      removedFileCount: summary.removedFileCount,
      failedFileCount: summary.failedFileCount,
      restoredComposeRouteCount,
    };
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
    const nextAttachmentCandidates: TerminalAttachmentMarkerCandidate[] = [];
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

      nextAttachmentCandidates.push({
        attachment: {
          id: createManualTerminalAttachmentId(marker.networkId, terminalWindow.id),
          networkId: network.id,
          rootPid: terminalWindow.rootPid,
          processGroupId: terminalWindow.processGroupId ?? marker.processGroupId,
          terminalWindowId: terminalWindow.id,
          terminalTitle: terminalWindow.title,
          mode: "isolated",
          status: "attached",
          attachedAt: marker.attachedAt,
        },
        markerPath: marker.filePath,
      });
    }

    const selectedAttachmentCandidates = selectLatestTerminalAttachmentMarkerCandidates(nextAttachmentCandidates);
    const selectedMarkerPaths = new Set(selectedAttachmentCandidates.map((candidate) => candidate.markerPath));
    staleMarkerPaths.push(
      ...nextAttachmentCandidates
        .filter((candidate) => !selectedMarkerPaths.has(candidate.markerPath))
        .map((candidate) => candidate.markerPath),
    );

    for (const attachment of existingManualAttachments) {
      this.registry.removeAttachment(attachment.id);
    }

    for (const candidate of selectedAttachmentCandidates) {
      this.registry.addAttachment(candidate.attachment);
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

  /** Removes marker files scoped to one network and reports cleanup failures. */
  private async clearManualTerminalAttachmentMarkersForNetwork(networkId: string): Promise<FileCleanupSummary> {
    const markers = await this.readManualTerminalAttachmentMarkers();
    return removeRoutingFilePaths(
      new Set(markers.filter((marker) => marker.networkId === networkId).map((marker) => marker.filePath)),
    );
  }

  /** Removes marker files scoped to a network being deleted. */
  private async removeManualTerminalAttachmentMarkersForNetwork(networkId: string): Promise<void> {
    await this.clearManualTerminalAttachmentMarkersForNetwork(networkId);
  }

  /** Clears every manual marker when the user asks for a global terminal reset. */
  private async clearManualTerminalAttachmentMarkers(): Promise<void> {
    await fs.rm(this.getTerminalAttachmentMarkerDirectoryPath(), { recursive: true, force: true });
  }

  /** Counts raw marker files so repair can report how many stale rows disappeared. */
  private async countManualTerminalAttachmentMarkerFiles(): Promise<number> {
    const markerDirectory = this.getTerminalAttachmentMarkerDirectoryPath();

    try {
      const entries = await fs.readdir(markerDirectory, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tsv")).length;
    } catch {
      return 0;
    }
  }

  /** Directory shared between copied shell snippets and extension-side refresh. */
  private getTerminalAttachmentMarkerDirectoryPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, TERMINAL_ATTACHMENT_MARKER_DIRECTORY_NAME);
  }

  /** Directory for generated shell bodies sourced by the one-line terminal injection command. */
  private getTerminalHookScriptDirectoryPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, TERMINAL_HOOK_SCRIPT_DIRECTORY_NAME);
  }

  /** Stable TSV path read by the external `pm` shell function. */
  private getTerminalNetworkSelectionFilePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, TERMINAL_NETWORK_SELECTION_FILE_NAME);
  }

  /**
   * Writes a generated terminal script body and returns the stable path to source.
   * Terminal input must stay short because some PTY paste paths truncate very long
   * one-line snippets, while the sourced file can keep the readable full bootstrap.
   */
  private writeTerminalHookScript(fileName: string, contents: string): string {
    const directoryPath = this.getTerminalHookScriptDirectoryPath();
    const scriptPath = path.join(directoryPath, fileName);

    syncFs.mkdirSync(directoryPath, { recursive: true });
    syncFs.writeFileSync(scriptPath, `${contents.trimEnd()}\n`, { encoding: "utf8", mode: 0o700 });
    syncFs.chmodSync(scriptPath, 0o700);
    return scriptPath;
  }

  /**
   * Writes the network picker file consumed by the external `pm` shell function.
   *
   * A shell function is required because selecting a network mutates the current
   * shell environment. Each row points at the same attach script used by UI
   * injection, keeping external terminals on the full native-hook path.
   */
  private async writeTerminalNetworkSelectionFile(): Promise<void> {
    if (this.terminalNetworkSelectionWriteInFlight !== undefined) {
      this.terminalNetworkSelectionWriteQueued = true;
      return this.terminalNetworkSelectionWriteInFlight;
    }

    this.terminalNetworkSelectionWriteInFlight = this.writeTerminalNetworkSelectionFileSerially().finally(() => {
      this.terminalNetworkSelectionWriteInFlight = undefined;
    });

    return this.terminalNetworkSelectionWriteInFlight;
  }

  /** Re-runs if another registry/process event arrived while the previous TSV was being written. */
  private async writeTerminalNetworkSelectionFileSerially(): Promise<void> {
    do {
      this.terminalNetworkSelectionWriteQueued = false;
      await this.writeTerminalNetworkSelectionFileExclusive();
    } while (this.terminalNetworkSelectionWriteQueued);
  }

  /** Writes the latest terminal network picker rows with an atomic replace. */
  private async writeTerminalNetworkSelectionFileExclusive(): Promise<void> {
    const settings = readPortManagerSettings();
    const snapshot = this.registry.getSnapshot();
    const rows = snapshot.networks.map((network) => {
      const scriptPath = this.writeTerminalHookScript(
        `attach-${sanitizeRouteFileScope(network.id)}.sh`,
        this.buildTerminalRoutingScriptBody(network.id, network.name, settings),
      );
      const serviceSummary = buildTerminalNetworkServiceSummary(network.id, snapshot);

      return serializeTerminalNetworkSelectionRow(network.id, network.name, scriptPath, serviceSummary);
    });
    const filePath = this.getTerminalNetworkSelectionFilePath();

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeTextFileAtomically(filePath, rows.length === 0 ? "" : `${rows.join("\n")}\n`);
  }

  /** Builds a one-line command that makes later child processes join one logical network scope. */
  private buildTerminalRoutingScript(network: Pick<LogicalNetwork, "id" | "name">, settings: PortManagerSettings): string {
    const scriptPath = this.writeTerminalHookScript(
      `attach-${sanitizeRouteFileScope(network.id)}.sh`,
      this.buildTerminalRoutingScriptBody(network.id, network.name, settings),
    );

    return `. ${shellQuote(scriptPath)}`;
  }

  /** Builds the full attach bootstrap stored in globalStorage and sourced by the shell. */
  private buildTerminalRoutingScriptBody(networkId: string, networkName: string, settings: PortManagerSettings): string {
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
      agentSocketPath: getAgentSocketPath(),
      agentMainPath,
      agentExecutablePath: nativeAgentPath,
      containerMapHelperPath: nativeContainerMapPath,
      globalRouteTablePath: getDefaultRouteTablePath(),
      hostAccessFilePath: getDefaultHostAccessBindingsPath(),
      settings,
      composeRoutingFilePath: this.getComposeProjectRoutingFilePath(networkId),
      dockerShimPath: runtimeCommandShimPath,
    });
    const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
    const commands = [
      shellExport("PORT_MANAGER_HOOK", "1"),
      shellExport("PORT_MANAGER_NETWORK_ID", networkId),
      shellExport("PORT_MANAGER_NETWORK_NAME", networkName),
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
      buildTerminalTitleShell(buildPortManagerTerminalTitle(networkName)),
      buildTerminalAttachmentMarkerWriteShell(),
      buildComposeProjectRoutingShell(this.getComposeProjectRoutingFilePath(networkId), nativeContainerMapPath),
      shellExport("PORT_MANAGER_SCAN_RANGE", String(settings.scanRange)),
      shellExport("PORT_MANAGER_ROUTING_MODE", settings.routingMode),
      shellExport("PORT_MANAGER_VIRTUAL_PORT_START", String(settings.virtualPortRangeStart)),
      shellExport("PORT_MANAGER_VIRTUAL_PORT_END", String(settings.virtualPortRangeEnd)),
      shellExport("PORT_MANAGER_FIXED_PROTOCOL_PORTS", settings.fixedProtocolPorts.join(",")),
      shellExport("PORT_MANAGER_PRESERVE_LISTEN_PORTS", settings.preservedListenPorts.join(",")),
      shellPrependLibrary(preloadVariable, hookLibraryPath),
    ];
    if (isLoopbackAddressRoutingEnabled(settings)) {
      commands.push(buildLoopbackAddressRoutingShell(loopbackAddressForNetwork(networkId), resolveLoopbackAddressRoutingMode(settings)));
    }
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
        `if [ "\${PORT_MANAGER_HOOK_DAEMON_STARTED:-0}" = "1" ]; then printf '%s\\n' ${shellQuote(
        `Port Manager routing active for ${networkName} (${networkId}). Restart servers launched before attach.`,
      )}; fi`,
    );

    return commands.join("\n");
  }

  /** Builds a one-line shell command that removes native routing variables from the current shell. */
  private buildTerminalDetachScript(): string {
    const scriptPath = this.writeTerminalHookScript("detach.sh", this.buildTerminalDetachScriptBody());
    return `. ${shellQuote(scriptPath)}`;
  }

  /** Builds the full detach bootstrap stored in globalStorage and sourced by the shell. */
  private buildTerminalDetachScriptBody(): string {
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
      "PORT_MANAGER_NETWORK_NAME",
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
      "PORT_MANAGER_PRESERVE_LISTEN_PORTS",
      NETWORK_LOOPBACK_HOST_ENV,
      "PORT_MANAGER_DYLD_INSERT_LIBRARIES",
      RUNTIME_SHIM_DIRECTORY_ENV,
    ];
    const commands = [
      buildTerminalAttachmentMarkerRemoveShell(),
      buildTerminalTitleShell("Port Manager: detached"),
      ...variables.map((variable) => `unset ${variable}`),
    ];

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

    return commands.join("\n");
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
  /** Runtime CLI that owns the discovered compose project. */
  readonly runtime?: "docker" | "podman";
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
  /** Optional exact Compose project name for the hidden clone. */
  readonly attachedProjectName?: string;
  /** Runtime CLI that owns the discovered compose services. */
  readonly runtime: "docker" | "podman";
  /** Directory where compose commands should resolve relative files. */
  readonly workingDirectory?: string;
  /** Compose config files discovered from runtime labels. */
  readonly composeFiles?: readonly string[];
  /** Existing clone id/name lineage to preserve when copying a Port Manager clone. */
  readonly sourceContainerMappings?: readonly ComposeContainerMutationMapping[];
  /** Copy defined services that currently have no running published endpoint. */
  readonly copyStoppedServices?: boolean;
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

interface ComposeRouteConflict {
  readonly attachment: ComposeAttachment;
  readonly existingPort: ComposePublishedPort;
  readonly requestedPort: ComposePublishedPort;
}

function findEquivalentComposeAttachment(
  attachments: readonly ComposeAttachment[],
  requested: ComposeAttachment,
  input: ComposePublishedPortsInput,
): ComposeAttachment | undefined {
  return attachments.find(
    (attachment) =>
      isRestorableComposeAttachment(attachment) &&
      attachment.networkId === requested.networkId &&
      composeAttachmentMatchesInput(attachment, requested, input) &&
      requestedComposePortsAreAlreadyAttached(attachment.ports, requested.ports),
  );
}

function composeAttachmentMatchesInput(
  attachment: ComposeAttachment,
  requested: ComposeAttachment,
  input: ComposePublishedPortsInput,
): boolean {
  if (input.existingMutation !== undefined) {
    const mutation = attachment.mutation;
    return (
      mutation !== undefined &&
      mutation.originalProjectName === input.existingMutation.originalProjectName &&
      mutation.attachedProjectName === input.existingMutation.attachedProjectName &&
      sameStringList(mutation.composeFiles, input.existingMutation.composeFiles)
    );
  }

  if (input.composeMutation !== undefined) {
    const mutation = attachment.mutation;
    const requestedMode = input.composeMutation.mode ?? "clone";
    const requestedComposeFiles = input.composeMutation.composeFiles ?? input.composeFiles ?? [];
    return (
      mutation !== undefined &&
      mutation.mode === requestedMode &&
      mutation.originalProjectName === requested.projectName &&
      (input.composeMutation.attachedProjectName === undefined ||
        mutation.attachedProjectName === input.composeMutation.attachedProjectName) &&
      sameStringList(mutation.composeFiles, requestedComposeFiles)
    );
  }

  return (
    attachment.mutation === undefined &&
    attachment.projectName === requested.projectName &&
    sameStringList(attachment.composeFiles, requested.composeFiles)
  );
}

function requestedComposePortsAreAlreadyAttached(
  existingPorts: readonly ComposePublishedPort[],
  requestedPorts: readonly ComposePublishedPort[],
): boolean {
  const existingPortKeys = new Set(existingPorts.map(composeServiceRouteKey));
  return requestedPorts.every((port) => existingPortKeys.has(composeServiceRouteKey(port)));
}

function findComposeRouteConflict(
  attachments: readonly ComposeAttachment[],
  requested: ComposeAttachment,
): ComposeRouteConflict | undefined {
  for (const attachment of attachments) {
    if (attachment.id === requested.id || attachment.networkId !== requested.networkId) {
      continue;
    }

    for (const existingPort of attachment.ports) {
      const requestedPort = requested.ports.find(
        (port) => port.protocol === existingPort.protocol && port.logicalPort === existingPort.logicalPort,
      );
      if (requestedPort !== undefined) {
        return { attachment, existingPort, requestedPort };
      }
    }
  }

  return undefined;
}

function formatComposeRouteConflictMessage(
  network: LogicalNetwork,
  requested: ComposeAttachment,
  conflict: ComposeRouteConflict,
): string {
  const existingProjectName = conflict.attachment.mutation?.attachedProjectName ?? conflict.attachment.projectName;
  return (
    `Compose route already exists for logical port ${conflict.requestedPort.logicalPort}/${conflict.requestedPort.protocol} ` +
    `in "${network.name}" from project "${existingProjectName}" service "${conflict.existingPort.serviceName}". ` +
    `Detach that Compose route or choose another logical network before attaching "${requested.projectName}".`
  );
}

function composeServiceRouteKey(port: ComposePublishedPort): string {
  return `${port.serviceName}:${port.protocol}:${port.logicalPort}:${port.containerPort}`;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildComposeProjectRoutingRows(
  attachments: readonly ComposeAttachment[],
): readonly ComposeProjectRoutingRow[] {
  return attachments.flatMap((attachment) => {
    const mutation = attachment.mutation;
    if (attachment.status !== "attached") {
      return [];
    }

    if (mutation === undefined) {
      const routingFiles = splitGeneratedComposeRoutingFiles(attachment.composeFiles);
      const workingDirectory = attachment.workingDirectory ?? composeWorkingDirectoryFromFiles(routingFiles.composeFiles);
      if (workingDirectory === undefined || attachment.projectName.trim().length === 0) {
        return [];
      }
      const containerMappings = inferContainerMappingsFromComposeRoutingFiles({
        attachedProjectName: attachment.projectName,
        composeFiles: attachment.composeFiles,
        serviceNames: attachment.ports.map((port) => port.serviceName),
      });

      return composeAttachmentRuntimes(attachment).map((runtime) => ({
        networkId: attachment.networkId,
        runtime,
        workingDirectory,
        composeFiles: routingFiles.composeFiles,
        attachedProjectName: attachment.projectName,
        ...(routingFiles.overrideFile !== undefined ? { overrideFile: routingFiles.overrideFile } : {}),
        ...(containerMappings.length > 0 ? { containerMappings } : {}),
      }));
    }

    if (mutation.mode === "in-place" || mutation.attachedProjectName === mutation.originalProjectName) {
      return [];
    }

    const workingDirectory = composeAttachmentWorkingDirectory(attachment);
    if (workingDirectory === undefined) {
      return [];
    }

    const routingFiles = splitGeneratedComposeRoutingFiles(mutation.composeFiles);
    const inferredContainerMappings = inferContainerMappingsFromComposeRoutingFiles({
      attachedProjectName: mutation.attachedProjectName,
      composeFiles: mutation.composeFiles,
      serviceNames: mutation.services,
    });
    const containerMappings = mergeComposeRoutingContainerMappings(
      mutation.containerMappings ?? [],
      inferredContainerMappings,
    );

    return [
      {
        networkId: attachment.networkId,
        runtime: mutation.runtime,
        workingDirectory,
        composeFiles: routingFiles.composeFiles,
        originalProjectName: mutation.originalProjectName,
        attachedProjectName: mutation.attachedProjectName,
        overrideFile: routingFiles.overrideFile ?? mutation.overrideFile,
        ...(containerMappings.length > 0 ? { containerMappings } : {}),
      },
    ];
  });
}

function mergeComposeRoutingContainerMappings(
  primaryMappings: readonly ComposeContainerMutationMapping[],
  fallbackMappings: readonly ComposeContainerMutationMapping[],
): readonly ComposeContainerMutationMapping[] {
  const serviceNames = new Set(primaryMappings.map((mapping) => mapping.serviceName));
  return [
    ...primaryMappings,
    ...fallbackMappings.filter((mapping) => !serviceNames.has(mapping.serviceName)),
  ];
}

function composeAttachmentRuntimes(attachment: ComposeAttachment): ReadonlyArray<"docker" | "podman"> {
  if (attachment.runtime !== undefined) {
    return [attachment.runtime];
  }

  return ["docker", "podman"];
}

function composeWorkingDirectoryFromFiles(composeFiles: readonly string[]): string | undefined {
  const firstFile = composeFiles.find((file) => file.trim().length > 0);
  return firstFile === undefined ? undefined : path.dirname(firstFile);
}

function composeAttachmentWorkingDirectory(attachment: ComposeAttachment): string | undefined {
  return (
    attachment.mutation?.workingDirectory ??
    attachment.workingDirectory ??
    composeWorkingDirectoryFromFiles(attachment.composeFiles)
  );
}

function stringifyPersistedNetworkState(state: LogicalNetworkRegistryState): string {
  return JSON.stringify(state);
}

/** True when a persisted compose row should keep participating in route recovery. */
function isRestorableComposeAttachment(attachment: ComposeAttachment): boolean {
  return (
    (attachment.status === "attached" || attachment.status === "error") &&
    attachment.ports.length > 0
  );
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

/** True when Docker/Podman still exposes the host-side endpoint for a compose route. */
function hasComposePublishedPortListener(
  listeners: readonly ListeningPort[],
  attachment: ComposeAttachment,
  port: ComposePublishedPort,
): boolean {
  if (port.protocol !== "tcp") {
    return false;
  }

  return listeners.some(
    (listener) =>
      listener.protocol === "tcp" &&
      listener.port === port.actualHostPort &&
      listenerAddressMatchesHost(listener.localAddress, port.actualHostAddress) &&
      isComposeRuntimeListener(listener, attachment.runtime ?? attachment.mutation?.runtime),
  );
}

function isComposeRuntimeListener(listener: ListeningPort, runtime: "docker" | "podman" | undefined): boolean {
  const owner = `${listener.processName ?? ""} ${listener.command ?? ""}`.toLowerCase();

  if (owner.trim().length === 0) {
    return false;
  }

  if (runtime === "docker") {
    return owner.includes("docker") || owner.includes("vpnkit");
  }

  if (runtime === "podman") {
    return owner.includes("podman") || owner.includes("gvproxy") || owner.includes("conmon");
  }

  return (
    owner.includes("docker") ||
    owner.includes("podman") ||
    owner.includes("vpnkit") ||
    owner.includes("gvproxy") ||
    owner.includes("conmon") ||
    owner.includes("rootlesskit") ||
    owner.includes("slirp4netns")
  );
}

function listenerAddressMatchesHost(listenerAddress: string, host: string): boolean {
  const normalizedListener = listenerAddress.trim().toLowerCase();
  const normalizedHost = host.trim().toLowerCase();

  if (normalizedListener === "*" || normalizedListener === "0.0.0.0" || normalizedListener === "::") {
    return true;
  }

  if (normalizedHost === "" || normalizedHost === "*" || normalizedHost === "0.0.0.0" || normalizedHost === "::") {
    return true;
  }

  if (
    (normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1") &&
    (normalizedListener === "localhost" || normalizedListener === "127.0.0.1" || normalizedListener === "::1")
  ) {
    return true;
  }

  return normalizedListener === normalizedHost;
}

function composeRuntimeProjectName(attachment: ComposeAttachment): string {
  return attachment.mutation?.attachedProjectName ?? attachment.projectName;
}

function composeRouteCopyFiles(attachment: ComposeAttachment): readonly string[] {
  const mutation = attachment.mutation;
  if (mutation === undefined) {
    return [...attachment.composeFiles];
  }

  // A routing copy must keep the generated override so Docker/Podman shims can
  // still map commands to the already-running hidden clone project.
  return [...mutation.composeFiles, mutation.overrideFile];
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

async function removeRoutingFilePaths(filePaths: ReadonlySet<string>): Promise<FileCleanupSummary> {
  let removedFileCount = 0;
  let failedFileCount = 0;

  await Promise.all(
    [...filePaths].map(async (filePath) => {
      try {
        await fs.rm(filePath, { force: true });
        removedFileCount++;
      } catch {
        failedFileCount++;
      }
    }),
  );

  return {
    removedFileCount,
    failedFileCount,
  };
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

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
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

/** Builds readable service rows displayed under each network in the external `pm` picker. */
function buildTerminalNetworkServiceSummary(
  networkId: string,
  snapshot: NetworkSnapshot,
): string {
  const entries: string[] = [];
  const seen = new Set<string>();

  // The picker is for choosing the correct logical network, so summarize the
  // owning Compose project/container instead of repeating every routed port.
  const addEntry = (entry: string): void => {
    const normalized = entry.trim();
    if (normalized.length === 0) {
      return;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    entries.push(normalized);
  };

  for (const attachment of snapshot.composeAttachments.filter(
    (item) => item.networkId === networkId && (item.status === "attached" || item.status === "error"),
  )) {
    if (isContainerStyleComposeAttachment(attachment)) {
      for (const containerName of composeAttachmentContainerNames(attachment)) {
        addEntry(formatTerminalNetworkServiceEntry("container", containerName, undefined, attachment.status));
      }
      continue;
    }

    const workingDirectory = composeAttachmentWorkingDirectory(attachment);
    addEntry(formatTerminalNetworkServiceEntry("compose", attachment.projectName, workingDirectory, attachment.status));
  }

  if (entries.length === 0) {
    return "no services";
  }

  return entries.join(TERMINAL_NETWORK_SERVICE_ENTRY_SEPARATOR);
}

function isContainerStyleComposeAttachment(attachment: ComposeAttachment): boolean {
  return (
    attachment.mutation === undefined &&
    attachment.composeFiles.length === 0 &&
    attachment.ports.length > 0 &&
    attachment.ports.every((port) => port.serviceName === attachment.projectName)
  );
}

function composeAttachmentContainerNames(attachment: ComposeAttachment): readonly string[] {
  const names = [...new Set(attachment.ports.map((port) => port.serviceName).filter((name) => name.length > 0))];
  return names.length > 0 ? names : [attachment.projectName];
}

function formatTerminalNetworkServiceEntry(
  kind: "compose" | "container",
  name: string,
  workingDirectory: string | undefined,
  status: ComposeAttachment["status"],
): string {
  const location = workingDirectory === undefined ? "" : ` (${workingDirectory})`;
  const statusSuffix = status === "attached" ? "" : ` [${status}]`;
  return `${kind}: ${name}${location}${statusSuffix}`;
}

/** Serializes one shell-readable network picker row as id, name, attach script, and visible services. */
function serializeTerminalNetworkSelectionRow(
  networkId: string,
  networkName: string,
  scriptPath: string,
  serviceSummary: string,
): string {
  return [networkId, networkName, scriptPath, serviceSummary].map(serializeTerminalNetworkSelectionCell).join("\t");
}

function serializeTerminalNetworkSelectionCell(value: string): string {
  return value.replace(/[\t\r\n]/g, " ").trim();
}

async function writeTextFileAtomically(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  await fs.writeFile(tempPath, contents, "utf8");
  await fs.rename(tempPath, filePath).catch(async (error) => {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  });
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
        overrideFile: row.overrideFile ?? "",
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

/** Builds a UI-safe agent snapshot when the process service is unavailable. */
function createDisconnectedAgentSnapshot(): AgentSnapshot {
  return {
    agentPid: 0,
    daemon: createDisconnectedDaemonStatus(),
    processes: [],
    listeners: [],
    routes: [],
    updatedAt: new Date(0).toISOString(),
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
      isLiveListenRoute(route),
  );
}

/**
 * Only registered listeners are live routing targets.
 *
 * Pending native allocations are published as `starting` before the process has
 * actually completed bind/register. Opening a logical router for that state can
 * keep the requested port occupied after the real listener fails to start.
 */
function isLiveListenRoute(route: LogicalPortRoute): boolean {
  return isListenRoute(route) && route.status === "running";
}

/** Sender reservations are not targets for host exposure or logical routers. */
function isListenRoute(route: LogicalPortRoute): boolean {
  return route.routeDirection === undefined || route.routeDirection === "listen";
}

function collectLogicalRouterPorts(
  routes: readonly LogicalPortRoute[],
  listeners: readonly ListeningPort[] = [],
): readonly number[] {
  const ports = new Set<number>();
  const externallyOwnedPorts = new Set(
    listeners
      .filter((listener) => listener.protocol === "tcp" && !isPortManagerLogicalRouterListener(listener))
      .map((listener) => listener.port),
  );

  for (const route of routes) {
    if (
      isLiveListenRoute(route) &&
      route.actualPort !== route.logicalPort &&
      isTcpPort(route.logicalPort) &&
      !externallyOwnedPorts.has(route.logicalPort)
    ) {
      ports.add(route.logicalPort);
    }
  }

  return [...ports].sort((left, right) => left - right);
}

function collectBrowserProxyEndpoints(
  processes: readonly ManagedProcess[],
  networks: readonly LogicalNetwork[],
  useDnsAlias: boolean,
): readonly BrowserNetworkProxyEndpoint[] {
  const endpoints = new Map<string, BrowserNetworkProxyEndpoint>();

  for (const process of processes) {
    if (!isBrowserProxyProcess(process, networks)) {
      continue;
    }

    const endpoint = buildBrowserProxyEndpoint(process, networks, useDnsAlias);
    endpoints.set(endpoint.id, endpoint);
  }

  return [...endpoints.values()];
}

function isBrowserProxyProcess(
  process: ManagedProcess,
  networks: readonly LogicalNetwork[],
): process is ManagedProcess & {
  readonly networkId: string;
  readonly url: string;
} {
  if (
    process.status !== "running" ||
    process.networkId === undefined ||
    process.url === undefined ||
    !isTcpPort(process.requestedPort)
  ) {
    return false;
  }

  if (!networks.some((network) => network.id === process.networkId)) {
    return false;
  }

  return (
    process.source !== "detected" &&
    process.source !== "compose" &&
    process.source !== "allocated" &&
    isPublicWebEntrypointProcess(process)
  );
}

function isPublicWebEntrypointProcess(process: ManagedProcess): boolean {
  const text = `${process.name} ${process.command} ${process.cwd} ${process.url ?? ""}`.toLowerCase();

  /*
   * DNS aliases are for the browser entrypoint, not every network-local API or
   * worker listener. Keep this as a positive classifier so backend ports remain
   * available through routing without taking browser cookie/DNS slots.
   */
  return [
    /\bvite\b/,
    /\bnext\s+dev\b/,
    /\bnuxt\s+dev\b/,
    /\bstorybook\s+dev\b/,
    /\bwebpack-dev-server\b/,
    /\breact-scripts\s+start\b/,
    /\bvue-cli-service\s+serve\b/,
    /\bastro\s+dev\b/,
    /\bsvelte-kit\b/,
    /\bremix\s+vite:dev\b/,
  ].some((pattern) => pattern.test(text));
}

function buildBrowserProxyEndpoint(
  process: ManagedProcess & { readonly networkId: string },
  networks: readonly LogicalNetwork[],
  useDnsAlias: boolean,
): BrowserNetworkProxyEndpoint {
  const fallbackPort = browserNetworkProxyFallbackPort(process.requestedPort);
  const listenPorts =
    fallbackPort === process.requestedPort ? [process.requestedPort] : [process.requestedPort, fallbackPort];
  const publicHost = useDnsAlias ? browserPublicHostForNetwork(process.networkId, networks) : undefined;

  return {
    id: browserNetworkProxyEndpointId(process.networkId, process.requestedPort),
    networkId: process.networkId,
    logicalPort: process.requestedPort,
    listenHost: browserLoopbackAddressForNetwork(process.networkId),
    ...(publicHost === undefined ? {} : { publicHost }),
    listenPorts,
  };
}

function buildBrowserDnsRecords(
  networks: readonly LogicalNetwork[],
): readonly {
  readonly networkId: string;
  readonly networkName: string;
  readonly hostname: string;
  readonly address: string;
}[] {
  const hostnameCounts = new Map<string, number>();
  const hostnamesByNetworkId = new Map<string, string>();

  for (const network of networks) {
    const hostname = normalizeBrowserDnsHostname(network.name);
    if (hostname === undefined) {
      continue;
    }

    hostnamesByNetworkId.set(network.id, hostname);
    hostnameCounts.set(hostname, (hostnameCounts.get(hostname) ?? 0) + 1);
  }

  return networks
    .map((network) => {
      const hostname = hostnamesByNetworkId.get(network.id);
      if (hostname === undefined || hostnameCounts.get(hostname) !== 1) {
        return undefined;
      }

      return {
        networkId: network.id,
        networkName: network.name,
        hostname,
        address: browserLoopbackAddressForNetwork(network.id),
      };
    })
    .filter(
      (
        record,
      ): record is {
        readonly networkId: string;
        readonly networkName: string;
        readonly hostname: string;
        readonly address: string;
      } => record !== undefined,
    );
}

function browserPublicHostForNetwork(networkId: string, networks: readonly LogicalNetwork[]): string | undefined {
  const records = buildBrowserDnsRecords(networks);
  const address = browserLoopbackAddressForNetwork(networkId);

  const record = records.find((item) => item.address === address);
  if (record === undefined || !isBrowserDnsResolverConfigured(record.hostname)) {
    return undefined;
  }

  return record.hostname;
}

function isBrowserDnsResolverConfigured(hostname: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }

  const filePath = path.join("/etc/resolver", hostname);

  try {
    const content = syncFs.readFileSync(filePath, "utf8");
    return (
      /^nameserver[ \t]+127\.0\.0\.1$/m.test(content) &&
      new RegExp(`^port[ \\t]+${browserDnsPort()}$`, "m").test(content)
    );
  } catch {
    return false;
  }
}

function normalizeBrowserProxyTargetHost(host: string): string {
  if (host === "0.0.0.0" || host === "*" || host === "") {
    return "127.0.0.1";
  }

  if (host === "::" || host === "[::]") {
    return "::1";
  }

  return host;
}

function buildBrowserDnsResolverStatus(
  records: readonly {
    readonly networkId: string;
    readonly networkName: string;
    readonly hostname: string;
    readonly address: string;
  }[],
  dnsPort: number,
  dnsRunning: boolean,
  processes: readonly ManagedProcess[],
  routes: readonly LogicalPortRoute[],
  networks: readonly LogicalNetwork[],
  browserNetworkProxy: BrowserNetworkProxyManager,
): BrowserDnsResolverStatus {
  const supported = process.platform === "darwin";
  const recordStatuses = records.map((record) => ({
    ...record,
    configured: supported && isBrowserDnsResolverConfigured(record.hostname),
    routes: buildBrowserDnsAliasRouteStatus(record, processes, routes, networks, browserNetworkProxy),
  }));

  return {
    supported,
    dnsRunning,
    dnsPort,
    records: recordStatuses,
    installedCount: recordStatuses.filter((record) => record.configured).length,
    missingCount: recordStatuses.filter((record) => !record.configured).length,
  };
}

function buildBrowserDnsAliasRouteStatus(
  record: {
    readonly networkId: string;
    readonly hostname: string;
    readonly address: string;
  },
  processes: readonly ManagedProcess[],
  routes: readonly LogicalPortRoute[],
  networks: readonly LogicalNetwork[],
  browserNetworkProxy: BrowserNetworkProxyManager,
): BrowserDnsResolverStatus["records"][number]["routes"] {
  return processes
    .filter((process): process is ManagedProcess & { readonly networkId: string; readonly url: string } =>
      process.networkId === record.networkId && isBrowserProxyProcess(process, networks),
    )
    .map((process) => {
      const endpoint = buildBrowserProxyEndpoint(process, networks, true);
      const activeEndpoint = browserNetworkProxy.get(record.networkId, process.requestedPort);
      const proxyPort = activeEndpoint?.listenPort ?? endpoint.listenPorts[0] ?? process.requestedPort;
      const route = findMatchingRoute(routes, record.networkId, process.requestedPort);

      return {
        url: `http://${record.hostname}:${proxyPort}/`,
        logicalPort: process.requestedPort,
        proxyHost: endpoint.listenHost,
        proxyPort,
        proxyActive: activeEndpoint !== undefined,
        ...(route === undefined ? {} : { upstreamHost: route.host, upstreamPort: route.actualPort }),
        processName: process.name,
      };
    })
    .sort((left, right) => left.logicalPort - right.logicalPort || left.processName.localeCompare(right.processName));
}

function buildBrowserDnsResolverSetupScript(
  records: readonly { readonly hostname: string; readonly address: string }[],
  dnsPort: number,
): string {
  const uniqueRecords = [...new Map(records.map((record) => [record.hostname, record])).values()];
  const lines = [
    "#!/bin/sh",
    "set -eu",
    "mkdir -p /etc/resolver",
  ];

  for (const record of uniqueRecords) {
    lines.push(
      `cat > ${shellQuote(path.join("/etc/resolver", record.hostname))} <<'PORTMANAGER_RESOLVER'`,
      "# Port Manager browser DNS resolver",
      `# ${record.hostname} -> ${record.address}`,
      "nameserver 127.0.0.1",
      `port ${dnsPort}`,
      "timeout 1",
      "PORTMANAGER_RESOLVER",
    );
  }

  lines.push("dscacheutil -flushcache >/dev/null 2>&1 || true");
  lines.push("killall -HUP mDNSResponder >/dev/null 2>&1 || true");
  return `${lines.join("\n")}\n`;
}

function buildBrowserDnsResolverCleanupScript(
  records: readonly { readonly hostname: string; readonly address: string }[],
): string {
  const uniqueRecords = [...new Map(records.map((record) => [record.hostname, record])).values()];
  const lines = ["#!/bin/sh", "set -eu"];

  for (const record of uniqueRecords) {
    const filePath = path.join("/etc/resolver", record.hostname);
    lines.push(
      `if [ -f ${shellQuote(filePath)} ] && grep -q '^# Port Manager browser DNS resolver$' ${shellQuote(filePath)}; then`,
      `  rm -f ${shellQuote(filePath)}`,
      "fi",
    );
  }

  lines.push("dscacheutil -flushcache >/dev/null 2>&1 || true");
  lines.push("killall -HUP mDNSResponder >/dev/null 2>&1 || true");
  return `${lines.join("\n")}\n`;
}

function isPortManagerLogicalRouterListener(listener: ListeningPort): boolean {
  const processName = listener.processName ?? "";
  const command = listener.command ?? "";
  return processName.includes("portmanager_tcp_router") || command.includes("portmanager_tcp_router");
}

function isTcpPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
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
  const terminal = await findMatchingVscodeTerminal(terminalWindow, processRows);
  if (terminal === undefined) {
    return false;
  }

  terminal.sendText(command, true);
  return true;
}

/** Brings a terminal window to the foreground without writing input. */
async function revealTerminalWindow(
  terminalWindow: TerminalWindow,
  processRows: readonly ProcessTableRow[] = [],
): Promise<boolean> {
  if (await revealVscodeTerminal(terminalWindow, processRows)) {
    return true;
  }

  return revealExternalTerminalWindow(terminalWindow);
}

/** Finds the matching integrated terminal using process ancestry first and display names as fallback. */
async function findMatchingVscodeTerminal(
  terminalWindow: TerminalWindow,
  processRows: readonly ProcessTableRow[] = [],
): Promise<vscode.Terminal | undefined> {
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

    return terminal;
  }

  if (nameMatchedTerminals.length === 1) {
    return nameMatchedTerminals[0];
  }

  if (
    vscode.window.activeTerminal !== undefined &&
    isVscodeTerminalNameMatch(terminalWindow, vscode.window.activeTerminal)
  ) {
    return vscode.window.activeTerminal;
  }

  return undefined;
}

/** Focuses an integrated terminal when VS Code owns the terminal object. */
async function revealVscodeTerminal(
  terminalWindow: TerminalWindow,
  processRows: readonly ProcessTableRow[] = [],
): Promise<boolean> {
  const terminal = await findMatchingVscodeTerminal(terminalWindow, processRows);
  if (terminal === undefined) {
    return false;
  }

  terminal.show(false);
  return true;
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

/** Collapses competing marker files so each terminal keeps the latest network label. */
function selectLatestTerminalAttachmentMarkerCandidates(
  candidates: readonly TerminalAttachmentMarkerCandidate[],
): readonly TerminalAttachmentMarkerCandidate[] {
  const selected: TerminalAttachmentMarkerCandidate[] = [];

  for (const candidate of candidates) {
    const existingIndex = selected.findIndex((existing) =>
      terminalAttachmentsShareIdentity(existing.attachment, candidate.attachment),
    );
    if (existingIndex < 0) {
      selected.push(candidate);
      continue;
    }

    if (isAttachmentAtLeastAsNew(candidate.attachment, selected[existingIndex]!.attachment)) {
      selected[existingIndex] = candidate;
    }
  }

  return selected;
}

/** Compares attach timestamps while treating malformed legacy values as oldest. */
function isAttachmentAtLeastAsNew(candidate: TerminalAttachment, existing: TerminalAttachment): boolean {
  return parseAttachmentTime(candidate.attachedAt) >= parseAttachmentTime(existing.attachedAt);
}

function parseAttachmentTime(attachedAt: string): number {
  const parsed = Date.parse(attachedAt);
  return Number.isFinite(parsed) ? parsed : 0;
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

/** Brings an external Terminal.app or iTerm2 session to the foreground by tty. */
async function revealExternalTerminalWindow(terminalWindow: TerminalWindow): Promise<boolean> {
  if (process.platform !== "darwin" || terminalWindow.terminalId === undefined) {
    return false;
  }

  const tty = normalizeTerminalTty(terminalWindow.terminalId);
  return (await revealTerminalAppleScript(tty)) || (await revealITermAppleScript(tty));
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

/** Selects the Terminal.app tab owning the target tty and activates its window. */
async function revealTerminalAppleScript(tty: string): Promise<boolean> {
  const escapedTty = appleScriptString(tty);
  const appleScript = `
if application "Terminal" is not running then return "missing"
tell application "Terminal"
  repeat with windowItem in windows
    repeat with tabItem in tabs of windowItem
      if (tty of tabItem) is "${escapedTty}" then
        set selected tab of windowItem to tabItem
        set index of windowItem to 1
        activate
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

/** Selects the iTerm2 session owning the target tty and activates its window. */
async function revealITermAppleScript(tty: string): Promise<boolean> {
  const escapedTty = appleScriptString(tty);
  const appleScript = `
if application "iTerm2" is not running then return "missing"
tell application "iTerm2"
  repeat with windowItem in windows
    repeat with tabItem in tabs of windowItem
      repeat with sessionItem in sessions of tabItem
        if (tty of sessionItem) is "${escapedTty}" then
          select windowItem
          select tabItem
          select sessionItem
          activate
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

async function runShellScriptWithAdministratorPrivileges(script: string): Promise<void> {
  const encodedScript = Buffer.from(script, "utf8").toString("base64");
  const command = `printf %s ${shellQuote(encodedScript)} | /usr/bin/base64 -D | /bin/sh`;
  const appleScript = `do shell script "${appleScriptString(command)}" with administrator privileges`;
  await execFileAsync("osascript", ["-e", appleScript], { timeout: 120_000 });
}

function normalizeTerminalTty(terminalId: string): string {
  return terminalId.startsWith("/dev/") ? terminalId : path.join("/dev", terminalId);
}

/** User-visible terminal title while a shell is attached to a logical network. */
function buildPortManagerTerminalTitle(networkName: string): string {
  return `Port Manager: ${networkName}`;
}

/** Shell fragment that writes an OSC terminal-title escape from inside the PTY. */
function buildTerminalTitleShell(title: string): string {
  return `printf '\\033]0;%s\\007' ${shellQuote(title)} 2>/dev/null || true`;
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
  ].join("\n");
}

function shellExport(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

function shellPrependLibrary(name: string, libraryPath: string): string {
  return `export ${name}=${shellQuote(libraryPath)}\${${name}:+":$${name}"}`;
}

/**
 * Enables loopback-address routing only after the OS can bind the generated
 * address. Auto mode keeps startup non-interactive; loopback mode may prompt
 * for sudo to create the macOS lo0 alias and still falls back if provisioning
 * fails.
 */
function buildLoopbackAddressRoutingShell(host: string, mode: "auto" | "loopback" | "high-port"): string {
  const quotedHost = shellQuote(host);

  if (mode === "high-port") {
    return `unset ${NETWORK_LOOPBACK_HOST_ENV}`;
  }

  if (process.platform !== "darwin") {
    return `export ${NETWORK_LOOPBACK_HOST_ENV}=${quotedHost}`;
  }

  const aliasCommand =
    mode === "loopback"
      ? `ifconfig lo0 alias "$__pm_loopback_host" 255.255.255.255 >/dev/null 2>&1 || sudo ifconfig lo0 alias "$__pm_loopback_host" 255.255.255.255 >/dev/null`
      : `ifconfig lo0 alias "$__pm_loopback_host" 255.255.255.255 >/dev/null 2>&1 || sudo -n ifconfig lo0 alias "$__pm_loopback_host" 255.255.255.255 >/dev/null 2>&1`;
  const failureMessage =
    mode === "loopback"
      ? "Port Manager loopback IP routing unavailable; using high-port routing fallback. Set portManager.loopbackAddressRoutingMode to high-port to skip alias provisioning."
      : "Port Manager loopback IP routing unavailable; using high-port routing fallback.";

  return [
    `__pm_loopback_host=${quotedHost}`,
    `if ifconfig lo0 2>/dev/null | grep -E "inet[[:space:]]+$__pm_loopback_host([[:space:]]|$)" >/dev/null 2>&1; then`,
    `export ${NETWORK_LOOPBACK_HOST_ENV}="$__pm_loopback_host"`,
    `elif ${aliasCommand}; then`,
    `export ${NETWORK_LOOPBACK_HOST_ENV}="$__pm_loopback_host"`,
    `else`,
    `unset ${NETWORK_LOOPBACK_HOST_ENV}`,
    `printf '%s\\n' ${shellQuote(failureMessage)} >&2`,
    `fi`,
    `unset __pm_loopback_host`,
  ].join("\n");
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
  const nodeProbeScript = [
    'const net=require("node:net");',
    'const fs=require("node:fs");',
    'const path=require("node:path");',
    'const socketPath=process.argv[1];',
    'const expected=process.argv[2];',
    'function removeSocket(){try{if(process.platform!=="win32")fs.unlinkSync(socketPath);}catch{}}',
    'function normalize(value){if(!value)return "";try{return fs.realpathSync.native(value);}catch{return path.resolve(value);}}',
    'function isOlder(startedAt,file){const started=Date.parse(startedAt||"");if(!Number.isFinite(started))return false;try{return started+1000<fs.statSync(file).mtimeMs;}catch{return false;}}',
    'let timer;',
    'let done=false;',
    'const socket=net.createConnection(socketPath);',
    'function finish(code,remove){if(done)return;done=true;if(timer)clearTimeout(timer);try{socket.destroy();}catch{}if(remove)removeSocket();process.exit(code);}',
    'function shutdownStale(){if(done)return;done=true;if(timer)clearTimeout(timer);try{socket.end(JSON.stringify({id:"probe-shutdown",method:"shutdownDaemon"})+"\\n");}catch{}setTimeout(()=>process.exit(2),75);}',
    'let buffer="";',
    'timer=setTimeout(()=>finish(1,false),700);',
    'socket.setEncoding("utf8");',
    'socket.once("connect",()=>{socket.write(JSON.stringify({id:"probe",method:"listSnapshot"})+"\\n");});',
    'socket.once("error",()=>finish(1,false));',
    'socket.on("data",(chunk)=>{buffer+=chunk;const lineEnd=buffer.indexOf("\\n");if(lineEnd<0)return;try{const message=JSON.parse(buffer.slice(0,lineEnd));const daemon=message&&message.payload&&message.payload.daemon;const actual=normalize(daemon&&daemon.agentMainPath);const expectedPath=normalize(expected);if(!actual||actual!==expectedPath||isOlder(daemon&&daemon.startedAt,expected)){shutdownStale();return;}finish(0,false);}catch{finish(1,true);}});',
  ].join("");
  const probeCommand = `${daemonRuntimePrefix} ${shellQuote(nodeExecutablePath)} -e ${shellQuote(
    nodeProbeScript,
  )} "$PORT_MANAGER_AGENT_SOCKET" "$PORT_MANAGER_AGENT_MAIN"`;

  return [
    `__pm_agent_ready=0`,
    `__pm_agent_lock="\${PORT_MANAGER_AGENT_SOCKET}.startup.lock"`,
    `${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1`,
    `if [ "$__pm_agent_ready" != "1" ]; then`,
    `if mkdir "$__pm_agent_lock" 2>/dev/null; then`,
    `__pm_agent_wait_count=0`,
    `while [ $__pm_agent_wait_count -lt 50 ]; do`,
    `${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1 && break`,
    `__pm_agent_wait_count=$((__pm_agent_wait_count + 1))`,
    `sleep 0.1`,
    `done`,
    `if [ "$__pm_agent_ready" != "1" ]; then`,
    `rm -f "$PORT_MANAGER_AGENT_SOCKET" 2>/dev/null || true`,
    `if [ -x "$PORT_MANAGER_AGENT_EXECUTABLE" ]; then`,
    `${daemonRuntimePrefix} nohup "$PORT_MANAGER_AGENT_EXECUTABLE" --socket "$PORT_MANAGER_AGENT_SOCKET" --route-table "$PORT_MANAGER_GLOBAL_ROUTES_FILE" --agent-main "$PORT_MANAGER_AGENT_MAIN" >/tmp/newdlops-portmanager-agent.log 2>&1 &`,
    `else`,
    `${daemonRuntimePrefix} nohup ${shellQuote(
      nodeExecutablePath,
    )} "$PORT_MANAGER_AGENT_MAIN" --socket "$PORT_MANAGER_AGENT_SOCKET" >/tmp/newdlops-portmanager-agent.log 2>&1 &`,
    `fi`,
    `__pm_agent_wait_count=0`,
    `while [ $__pm_agent_wait_count -lt 50 ]; do`,
    `${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1 && break`,
    `__pm_agent_wait_count=$((__pm_agent_wait_count + 1))`,
    `sleep 0.1`,
    `done`,
    `fi`,
    `rmdir "$__pm_agent_lock" 2>/dev/null || true`,
    `else`,
    `__pm_agent_wait_count=0`,
    `while [ $__pm_agent_wait_count -lt 60 ]; do`,
    `${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1 && break`,
    `__pm_agent_wait_count=$((__pm_agent_wait_count + 1))`,
    `sleep 0.1`,
    `done`,
    `fi`,
    `unset __pm_agent_wait_count`,
    `fi`,
    `if [ "$__pm_agent_ready" = "1" ]; then`,
    `export PORT_MANAGER_HOOK_DAEMON_STARTED=1`,
    `else`,
    `export PORT_MANAGER_HOOK=0`,
    `export PORT_MANAGER_HOOK_DAEMON_STARTED=0`,
    `printf '%s\\n' 'Port Manager routing unavailable: local daemon did not become ready.' >&2`,
    `fi`,
    `unset __pm_agent_ready __pm_agent_lock`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildBackgroundContainerRefreshControlPath(kind: "stamp" | "lock"): string {
  const routeTablePath = getDefaultRouteTablePath();
  const parsedPath = path.parse(routeTablePath);
  return path.join(parsedPath.dir, `${parsedPath.name.replace("routes", "container-refresh")}.${kind}`);
}

function buildLogicalRouterOwnerControlPath(kind: "owner" | "lock"): string {
  const routeTablePath = getDefaultRouteTablePath();
  const parsedPath = path.parse(routeTablePath);
  return path.join(parsedPath.dir, `${parsedPath.name.replace("routes", "logical-router-owner")}.${kind}`);
}

/**
 * Elects one VS Code extension host to own localhost logical router processes.
 * Logical routers bind fixed localhost ports, so letting every window reconcile
 * them independently can split ports across windows and cause repeated handoff.
 */
function tryAcquireLogicalRouterOwnerLease(): boolean {
  const nowMs = Date.now();
  const owner = readLogicalRouterOwner();
  if (owner?.pid === process.pid) {
    return writeLogicalRouterOwnerLease(nowMs);
  }

  if (isActiveLogicalRouterOwner(owner, nowMs)) {
    return false;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let lockFd: number | undefined;

    try {
      ensureLogicalRouterOwnerControlDirectory();
      lockFd = syncFs.openSync(LOGICAL_ROUTER_OWNER_LOCK_PATH, "wx");
      syncFs.writeFileSync(lockFd, `${process.pid}\n${new Date(nowMs).toISOString()}\n`, "utf8");
    } catch (error) {
      if (lockFd !== undefined) {
        closeFileDescriptor(lockFd);
      }

      if (isNodeErrorWithCode(error, "EEXIST")) {
        removeStaleLogicalRouterOwnerLock();
        continue;
      }

      return false;
    }

    try {
      const currentOwner = readLogicalRouterOwner();
      if (currentOwner?.pid !== process.pid && isActiveLogicalRouterOwner(currentOwner, nowMs)) {
        return false;
      }

      return writeLogicalRouterOwnerLease(nowMs);
    } finally {
      closeFileDescriptor(lockFd);
      try {
        syncFs.rmSync(LOGICAL_ROUTER_OWNER_LOCK_PATH, { force: true });
      } catch {
        // A stale lock will be removed by a later owner election attempt.
      }
    }
  }

  return false;
}

function releaseLogicalRouterOwnerLease(): void {
  const owner = readLogicalRouterOwner();
  if (owner?.pid !== process.pid) {
    return;
  }

  try {
    syncFs.rmSync(LOGICAL_ROUTER_OWNER_PATH, { force: true });
  } catch {
    // Stale owner leases expire naturally when another window refreshes routing.
  }
}

function readLogicalRouterOwner(): LogicalRouterOwnerDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(syncFs.readFileSync(LOGICAL_ROUTER_OWNER_PATH, "utf8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const owner = parsed as Partial<LogicalRouterOwnerDocument>;
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return undefined;
  }
  if (typeof owner.updatedAt !== "string" || Number.isNaN(Date.parse(owner.updatedAt))) {
    return undefined;
  }

  return { pid: owner.pid, updatedAt: owner.updatedAt };
}

function writeLogicalRouterOwnerLease(nowMs: number): boolean {
  try {
    ensureLogicalRouterOwnerControlDirectory();
    syncFs.writeFileSync(
      LOGICAL_ROUTER_OWNER_PATH,
      `${JSON.stringify({ pid: process.pid, updatedAt: new Date(nowMs).toISOString() })}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

function isActiveLogicalRouterOwner(owner: LogicalRouterOwnerDocument | undefined, nowMs: number): boolean {
  if (owner === undefined) {
    return false;
  }

  if (nowMs - Date.parse(owner.updatedAt) >= LOGICAL_ROUTER_OWNER_LEASE_MS) {
    return false;
  }

  return isProcessAlive(owner.pid);
}

function removeStaleLogicalRouterOwnerLock(): void {
  try {
    const stats = syncFs.statSync(LOGICAL_ROUTER_OWNER_LOCK_PATH);
    if (Date.now() - stats.mtimeMs >= LOGICAL_ROUTER_OWNER_LOCK_STALE_MS) {
      syncFs.rmSync(LOGICAL_ROUTER_OWNER_LOCK_PATH, { force: true });
    }
  } catch {
    // Missing lock files are expected between owner election attempts.
  }
}

function ensureLogicalRouterOwnerControlDirectory(): void {
  syncFs.mkdirSync(path.dirname(LOGICAL_ROUTER_OWNER_PATH), { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeErrorWithCode(error, "ESRCH");
  }
}

/**
 * Serializes Docker/Podman background discovery across VS Code windows.
 * Container inspection is expensive on Docker Desktop, so memory-only throttles
 * still let each extension host wake Docker independently.
 */
function tryAcquireSharedBackgroundContainerRefreshSlot(): (() => void) | undefined {
  if (isSharedBackgroundContainerRefreshRecent()) {
    return undefined;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let lockFd: number | undefined;

    try {
      lockFd = syncFs.openSync(BACKGROUND_CONTAINER_REFRESH_LOCK_PATH, "wx");
      syncFs.writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if (lockFd !== undefined) {
        closeFileDescriptor(lockFd);
      }

      if (isNodeErrorWithCode(error, "EEXIST")) {
        removeStaleSharedBackgroundContainerRefreshLock();
        continue;
      }

      return undefined;
    }

    const release = (writeStamp: boolean) => {
      if (writeStamp) {
        try {
          syncFs.writeFileSync(
            BACKGROUND_CONTAINER_REFRESH_STAMP_PATH,
            `${process.pid}\n${new Date().toISOString()}\n`,
            "utf8",
          );
        } catch {
          // The stamp only throttles background work; failed writes should not
          // block foreground attach or cleanup paths.
        }
      }

      closeFileDescriptor(lockFd);
      try {
        syncFs.rmSync(BACKGROUND_CONTAINER_REFRESH_LOCK_PATH, { force: true });
      } catch {
        // A stale lock will be removed on a later background pass.
      }
    };

    if (isSharedBackgroundContainerRefreshRecent()) {
      release(false);
      return undefined;
    }

    return () => release(true);
  }

  return undefined;
}

function isSharedBackgroundContainerRefreshRecent(): boolean {
  try {
    const stats = syncFs.statSync(BACKGROUND_CONTAINER_REFRESH_STAMP_PATH);
    return Date.now() - stats.mtimeMs < BACKGROUND_CONTAINER_REFRESH_INTERVAL_MS;
  } catch {
    return false;
  }
}

function removeStaleSharedBackgroundContainerRefreshLock(): void {
  try {
    const stats = syncFs.statSync(BACKGROUND_CONTAINER_REFRESH_LOCK_PATH);
    if (Date.now() - stats.mtimeMs >= BACKGROUND_CONTAINER_REFRESH_LOCK_STALE_MS) {
      syncFs.rmSync(BACKGROUND_CONTAINER_REFRESH_LOCK_PATH, { force: true });
    }
  } catch {
    // Missing lock files are expected between background refreshes.
  }
}

function closeFileDescriptor(fd: number | undefined): void {
  if (fd === undefined) {
    return;
  }

  try {
    syncFs.closeSync(fd);
  } catch {
    // The descriptor can already be closed during process teardown.
  }
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

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import {
  ContainerNetworkRuntimeAdapter,
  type ContainerRuntimeTarget,
} from "../platform/network/container-runtime";
import { ContainerServiceDiscoveryAdapter } from "../platform/network/container-service-discovery";
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
import { NodeProcessEnvironmentProvider } from "../platform/process/node-process-environment";
import { NodeTerminalCandidateProvider } from "../platform/process/node-terminal-candidate-provider";
import type {
  AgentDaemonStatus,
  ComposeAttachment,
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
} from "../shared/types";
import {
  getAsdfShimLauncherRelativePath,
  getHookLibraryRelativePath,
  prepareRuntimeShimLauncherDirectory,
  prepareShellEnvRestoreScript,
  RUNTIME_SHIM_DIRECTORY_ENV,
  shouldInjectTerminalHook,
} from "./terminal-hook-environment";
import type { PortManagerProcessService } from "./process-service";

const NETWORK_STATE_KEY = "portManager.logicalNetworkState.v1";
const BINDING_PRESETS_KEY = "portManager.bindingPresets.v1";
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

  /** VS Code event subscriptions owned by this service. */
  private readonly disposables: DisposableLike[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly processService?: PortManagerProcessService,
  ) {
    this.terminalCandidateProvider = new NodeTerminalCandidateProvider();
    this.containerRuntime = new ContainerNetworkRuntimeAdapter();
    this.containerServiceDiscovery = new ContainerServiceDiscoveryAdapter();
    this.proxyManager = new HostPortProxyManager({
      resolve: (exposure) => this.resolveHostExposureTarget(exposure),
    });
    this.logicalPortRouter = new LogicalPortRouterManager({
      resolve: (connection) => this.resolveLogicalPortRouterTarget(connection),
    });
    this.tcpConnectionProcessResolver = new NodeTcpConnectionProcessResolver();
    this.processTableProvider = new NodeProcessTableProvider();
    this.processEnvironmentProvider = new NodeProcessEnvironmentProvider();
    this.registry = new LogicalNetworkRegistry(BASE_RUNTIMES, this.loadState());
    this.disposables.push(
      this.registry.onDidChange(() => {
        this.saveState();
        void this.writeHostAccessBindingsFile();
        void this.syncLogicalPortRouters();
      }),
    );
    if (this.processService !== undefined) {
      this.disposables.push(
        this.processService.onDidChange(() => {
          void this.syncLogicalPortRouters();
        }),
      );
    }
  }

  /** Loads terminal candidates and reopens persisted host exposures. */
  async start(): Promise<void> {
    this.disposables.push(
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
        }
      }),
    );

    await this.refreshRuntimeDescriptors();
    await this.reopenPersistedExposures();
    await this.writeHostAccessBindingsFile();
    await this.refreshTerminals();
    void this.refreshContainerServices();
    await this.syncLogicalPortRouters();
  }

  /** Returns the latest logical network snapshot for the sidebar. */
  getSnapshot(): NetworkSnapshot {
    return this.registry.getSnapshot();
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
    return this.registry.onDidChange(listener);
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

    return this.registry.removeNetwork(networkId);
  }

  /** Refreshes VS Code and external OS terminal windows. */
  async refreshTerminals(): Promise<readonly TerminalWindow[]> {
    const [vscodeCandidates, osCandidates] = await Promise.all([
      listVscodeTerminalCandidates(),
      this.terminalCandidateProvider.list().catch(() => []),
    ]);
    const candidates = [...vscodeCandidates, ...osCandidates];
    this.registry.setTerminalCandidates(candidates);

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
      const sent = await sendCommandToTerminalWindow(terminalWindow, attachCommand);
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
      if (network?.runtimeKind === "container") {
        await sendCommandToTerminalWindow(terminalWindow, "exit").catch(() => false);
      } else if (network?.runtimeKind === "nativeHelper") {
        await sendCommandToTerminalWindow(terminalWindow, this.buildTerminalDetachScript()).catch(() => false);
      }
    }

    return this.registry.removeAttachment(attachmentId);
  }

  /** True when a VS Code terminal already belongs to one logical network. */
  async isTerminalAttached(terminal: vscode.Terminal): Promise<boolean> {
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
    if (terminalWindow.source === "vscode" && (await sendRoutingScriptToVscodeTerminal(terminalWindow, script))) {
      return { injected: true };
    }

    if (await sendRoutingScriptToExternalTerminalWindow(terminalWindow, script)) {
      return { injected: true };
    }

    return {
      injected: false,
      reason: `Could not find a controllable terminal session for "${terminalWindow.title}".`,
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
    requireNetwork(this.registry.getNetwork(input.networkId), input.networkId);
    if (this.processService === undefined) {
      throw new Error("Compose published ports require the Port Manager daemon.");
    }
    if (input.ports.length === 0) {
      throw new Error("At least one compose published port is required.");
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

    this.registry.addComposeAttachment(attachment);

    try {
      await this.processService.start();

      const ports: ComposePublishedPort[] = [];
      for (const port of attachment.ports) {
        const process = await this.processService.registerExistingProcess(
          buildComposeRegisteredProcessInput(attachment, port, input.cwd),
        );

        registeredProcessIds.push(process.id);
        ports.push({
          ...port,
          processId: process.id,
        });
      }

      return this.registry.updateComposeAttachment({
        ...attachment,
        ports,
      });
    } catch (error) {
      for (const processId of registeredProcessIds) {
        await this.processService.removeProcess(processId).catch(() => undefined);
      }
      this.registry.removeComposeAttachment(attachment.id);
      throw error;
    }
  }

  /** Removes a compose route attachment and its daemon route rows. */
  async removeComposeAttachment(attachmentId: string): Promise<ComposeAttachment | undefined> {
    const attachment = this.registry
      .getSnapshot()
      .composeAttachments.find((candidate) => candidate.id === attachmentId);

    if (attachment === undefined) {
      return undefined;
    }

    for (const port of attachment.ports) {
      if (port.processId !== undefined) {
        await this.processService?.removeProcess(port.processId).catch(() => undefined);
      }
    }

    return this.registry.removeComposeAttachment(attachmentId);
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

    await sendCommandToTerminalWindow(terminalWindow, resetCommand).catch(() => false);

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

    return {
      terminalCount: terminalWindows.length,
      removedAttachmentCount,
    };
  }

  /** Releases listeners and event subscriptions. */
  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    this.registry.dispose();
    void this.proxyManager.dispose();
    this.logicalPortRouter.dispose();
  }

  /** Reads persisted logical network state from VS Code global storage. */
  private loadState(): LogicalNetworkRegistryState | undefined {
    return this.context.globalState.get<LogicalNetworkRegistryState>(NETWORK_STATE_KEY);
  }

  /** Persists durable logical network state. */
  private saveState(): void {
    void this.context.globalState.update(NETWORK_STATE_KEY, this.registry.getPersistedState());
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
    const processContext = buildProcessTreeContext(processRows, pid);

    if (processContext === undefined) {
      return undefined;
    }

    for (const attachment of this.registry.getSnapshot().attachments) {
      if (attachment.status !== "attached") {
        continue;
      }

      if (attachment.rootPid === pid || processContext.ancestorPids.includes(attachment.rootPid)) {
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

  /** Builds the shell commands that make later child processes join one logical network scope. */
  private buildTerminalRoutingScript(networkId: string, settings: PortManagerSettings): string {
    const hookLibraryPath = this.context.asAbsolutePath(getHookLibraryRelativePath());
    const agentMainPath = this.context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
    const asdfShimLauncherPath = this.context.asAbsolutePath(getAsdfShimLauncherRelativePath());
    const runtimeShimDirectory = prepareRuntimeShimLauncherDirectory(
      this.context.globalStorageUri.fsPath,
      asdfShimLauncherPath,
    );
    const shellEnvRestorePath = prepareShellEnvRestoreScript(this.context.globalStorageUri.fsPath, hookLibraryPath, {
      networkId,
    });
    const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
    const commands = [
      shellExport("PORT_MANAGER_HOOK", "1"),
      shellExport("PORT_MANAGER_NETWORK_ID", networkId),
      shellExport("PORT_MANAGER_BORROWED_NETWORK_ID", networkId),
      shellExport("NEWDLOPS_PM_NETWORK_ID", networkId),
      shellExport("NEWDLOPS_PM_BORROWED_NETWORK_ID", networkId),
      shellExport("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath()),
      shellExport("PORT_MANAGER_AGENT_MAIN", agentMainPath),
      shellExport("PORT_MANAGER_ROUTES_FILE", getRouteTablePathForNetwork(networkId)),
      shellExport("PORT_MANAGER_GLOBAL_ROUTES_FILE", getDefaultRouteTablePath()),
      shellExport("PORT_MANAGER_HOST_ACCESS_FILE", getDefaultHostAccessBindingsPath()),
      shellExport("PORT_MANAGER_SCAN_RANGE", String(settings.scanRange)),
      shellExport("PORT_MANAGER_ROUTING_MODE", settings.routingMode),
      shellExport("PORT_MANAGER_VIRTUAL_PORT_START", String(settings.virtualPortRangeStart)),
      shellExport("PORT_MANAGER_VIRTUAL_PORT_END", String(settings.virtualPortRangeEnd)),
      shellExport("PORT_MANAGER_FIXED_PROTOCOL_PORTS", settings.fixedProtocolPorts.join(",")),
      shellPrependLibrary(preloadVariable, hookLibraryPath),
    ];

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
    const runtimeShimDirectory = prepareRuntimeShimLauncherDirectory(
      this.context.globalStorageUri.fsPath,
      asdfShimLauncherPath,
    );
    const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
    const variables = [
      "PORT_MANAGER_HOOK",
      "PORT_MANAGER_NETWORK_ID",
      "PORT_MANAGER_BORROWED_NETWORK_ID",
      "NEWDLOPS_PM_NETWORK_ID",
      "NEWDLOPS_PM_BORROWED_NETWORK_ID",
      "PORT_MANAGER_AGENT_SOCKET",
      "PORT_MANAGER_AGENT_MAIN",
      "PORT_MANAGER_HOOK_DAEMON_STARTED",
      "PORT_MANAGER_ROUTES_FILE",
      "PORT_MANAGER_HOST_ACCESS_FILE",
      "PORT_MANAGER_SCAN_RANGE",
      "PORT_MANAGER_ROUTING_MODE",
      "PORT_MANAGER_VIRTUAL_PORT_START",
      "PORT_MANAGER_VIRTUAL_PORT_END",
      "PORT_MANAGER_FIXED_PROTOCOL_PORTS",
      "PORT_MANAGER_DYLD_INSERT_LIBRARIES",
      RUNTIME_SHIM_DIRECTORY_ENV,
    ];
    const commands = variables.map((variable) => `unset ${variable}`);

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
      commands.push(`export PATH="\${PATH#${shellPatternLiteral(`${runtimeShimDirectory}:`)}}"`);
    }

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
  /** Published service endpoints to register into this logical network. */
  readonly ports: readonly ComposePublishedPortInput[];
}

export interface ComposePublishedPortInput {
  /** Compose service that owns the container-side listener. */
  readonly serviceName: string;
  /** Logical-network port used by clients, for example PostgreSQL 15432. */
  readonly logicalPort: number;
  /** Docker-published host address reachable from the extension host. */
  readonly actualHostAddress: string;
  /** Docker-published host port, often allocated from a hidden range. */
  readonly actualHostPort: number;
  /** Container-side port for diagnostics; defaults to logicalPort. */
  readonly containerPort?: number;
  /** Optional named protocol label such as postgresql, mysql, redis, or http. */
  readonly protocolName?: string;
}

/** Includes VS Code integrated terminals in the same model as OS-discovered shells. */
async function listVscodeTerminalCandidates(): Promise<readonly TerminalCandidate[]> {
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

      return {
        pid,
        name: terminal.name,
        windowTitle: terminal.name,
        command: terminal.name,
        vscodeTerminal: true,
      } satisfies TerminalCandidate;
    }),
  );

  return terminals.filter((candidate): candidate is TerminalCandidate => candidate !== undefined);
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

  return {
    serviceName: assertNonEmptyString(input.serviceName, "Compose service name"),
    logicalPort: input.logicalPort,
    actualHostAddress: assertNonEmptyString(input.actualHostAddress, "Compose published host address"),
    actualHostPort: input.actualHostPort,
    containerPort: input.containerPort ?? input.logicalPort,
    protocol: "tcp",
    ...(input.protocolName !== undefined && input.protocolName.trim().length > 0
      ? { protocolName: input.protocolName.trim() }
      : {}),
  };
}

/** Builds the daemon process row that owns one compose published-port route. */
function buildComposeRegisteredProcessInput(
  attachment: ComposeAttachment,
  port: ComposePublishedPort,
  cwd: string | undefined,
): RegisteredProcessInput {
  const protocolLabel = port.protocolName === undefined ? "" : `/${port.protocolName}`;

  return {
    // Docker may hide the concrete owner PID behind a VM or proxy. A later OS
    // listener scan can adopt the real PID when the platform exposes it.
    pid: 0,
    name: `${attachment.projectName}:${port.serviceName}${protocolLabel}`,
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
async function sendCommandToTerminalWindow(terminalWindow: TerminalWindow, command: string): Promise<boolean> {
  if (terminalWindow.source === "vscode" && (await sendCommandToVscodeTerminal(terminalWindow, command))) {
    return true;
  }

  return sendCommandToExternalTerminalWindow(terminalWindow, command);
}

/** Sends a command into an integrated terminal without relying on OS window automation. */
async function sendRoutingScriptToVscodeTerminal(
  terminalWindow: TerminalWindow,
  script: string,
): Promise<boolean> {
  return sendCommandToVscodeTerminal(terminalWindow, script);
}

/** Sends a command into an integrated terminal without relying on OS window automation. */
async function sendCommandToVscodeTerminal(
  terminalWindow: TerminalWindow,
  command: string,
): Promise<boolean> {
  for (const terminal of vscode.window.terminals) {
    let processId: number | undefined;

    try {
      processId = await terminal.processId;
    } catch {
      processId = undefined;
    }

    if (processId === undefined || !terminalWindow.candidatePids.includes(processId)) {
      continue;
    }

    terminal.sendText(command, true);
    return true;
  }

  return false;
}

/** Sends a routing script into Terminal.app or iTerm2 sessions selected by tty. */
async function sendRoutingScriptToExternalTerminalWindow(
  terminalWindow: TerminalWindow,
  script: string,
): Promise<boolean> {
  return sendCommandToExternalTerminalWindow(terminalWindow, script);
}

/** Sends a command into Terminal.app or iTerm2 sessions selected by tty. */
async function sendCommandToExternalTerminalWindow(
  terminalWindow: TerminalWindow,
  command: string,
): Promise<boolean> {
  if (process.platform !== "darwin" || terminalWindow.terminalId === undefined) {
    return false;
  }

  const tty = normalizeTerminalTty(terminalWindow.terminalId);
  return (await runTerminalAppleScript(tty, command)) || (await runITermAppleScript(tty, command));
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

function shellExport(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

function shellPrependLibrary(name: string, libraryPath: string): string {
  return `export ${name}=${shellQuote(libraryPath)}\${${name}:+":$${name}"}`;
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

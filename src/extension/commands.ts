import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAgentSocketPath } from "../agent/agent-socket";
import { getDefaultHostAccessBindingsPath, getDefaultRouteTablePath } from "../agent/route-table";
import { readPortManagerSettings, openPortManagerSettings } from "../config/vscode-settings";
import { buildExistingCloneMutationFromCandidate } from "../platform/network/container-service-discovery";
import { isValidComposeProjectName } from "../platform/network/compose-publish-mutator";
import { ELECTRON_RUN_AS_NODE } from "../platform/process/node-runtime";
import type { PortManagerTreeProvider } from "../ui/sidebar/port-manager-tree";
import {
  getComposeAttachmentFromCommandArgument,
  getContainerServiceCandidateFromCommandArgument,
  getHostPortExposureFromCommandArgument,
  getHostAccessBindingFromCommandArgument,
  getLogicalNetworkFromCommandArgument,
  getProcessFromCommandArgument,
  getTerminalAttachmentFromCommandArgument,
  getTerminalWindowFromCommandArgument,
} from "../ui/sidebar/port-manager-tree";
import type { PortManagerNetworkService } from "./network-service";
import type { PortManagerProcessService } from "./process-service";
import {
  DOCKER_SHIM_PATH_ENV,
  prepareRuntimeShimLauncherDirectory,
  prepareShellEnvRestoreScript,
  RUNTIME_SHIM_DIRECTORY_ENV,
} from "./terminal-hook-environment";
import type {
  ComposeAttachment,
  ContainerServiceCandidate,
  DisposableLike,
  HostAccessBinding,
  HostPortExposure,
  ListeningPort,
  LogicalNetwork,
  ManagedProcess,
  ManagedProcessStartInput,
  NetworkRuntimeDescriptor,
  NetworkRuntimeKind,
  NetworkSnapshot,
  PortInjectionMode,
  PortManagerSettings,
  TerminalAttachment,
  TerminalWindow,
} from "../shared/types";

const TERMINAL_NETWORK_SELECTION_FILE_NAME = "terminal-networks.tsv";

/**
 * Registers Port Manager commands and coordinates the MVP flow.
 *
 * This controller is intentionally an orchestration boundary: it reads VS Code
 * input and delegates routing, process mechanics, and shared state to the
 * local agent process service.
 */

export interface PortManagerCommandDependencies {
  /** Agent-backed service shared by commands and the sidebar. */
  readonly processService: PortManagerProcessService;
  /** Logical network service shared by commands and the sidebar. */
  readonly networkService: PortManagerNetworkService;
  /** Sidebar provider refreshed after command-driven changes. */
  readonly treeProvider: PortManagerTreeProvider;
}

/**
 * Command controller keeps VS Code prompt flow separate from the agent-backed
 * process service so the same agent can serve multiple VS Code windows.
 */
export class PortManagerCommandController implements DisposableLike {
  /** Disposables returned by VS Code command registration. */
  private readonly disposables: DisposableLike[] = [];

  constructor(private readonly dependencies: PortManagerCommandDependencies) {}

  /**
   * Registers every command contribution declared in package.json.
   * All command handlers are wrapped so user-facing failures become VS Code
   * error notifications instead of unhandled promise rejections.
   */
  register(context: vscode.ExtensionContext): void {
    this.registerCommand(context, "portManager.createLogicalNetwork", () => this.createLogicalNetwork());
    this.registerCommand(context, "portManager.removeLogicalNetwork", (argument) =>
      this.removeLogicalNetwork(argument),
    );
    this.registerCommand(context, "portManager.refreshTerminals", () => this.refreshTerminals());
    this.registerCommand(context, "portManager.refreshContainerServices", () => this.refreshContainerServices());
    this.registerCommand(context, "portManager.attachTerminalToNetwork", (argument) =>
      this.attachTerminalToNetwork(argument),
    );
    this.registerCommand(context, "portManager.attachActiveTerminalToNetwork", (argument) =>
      this.attachActiveTerminalToNetwork(argument),
    );
    this.registerCommand(context, "portManager.revealTerminalWindow", (argument) =>
      this.revealTerminalWindow(argument),
    );
    this.registerCommand(context, "portManager.attachProcessToNetwork", (argument) =>
      this.attachProcessToNetwork(argument),
    );
    this.registerCommand(context, "portManager.attachVscodeWindowTerminalsToNetwork", (argument) =>
      this.attachVscodeWindowTerminalsToNetwork(argument),
    );
    this.registerCommand(context, "portManager.detachVscodeWindowTerminalsFromNetwork", () =>
      this.detachVscodeWindowTerminalsFromNetwork(),
    );
    this.registerCommand(context, "portManager.copyTerminalRoutingScript", (argument) =>
      this.copyTerminalRoutingScript(argument),
    );
    this.registerApiCommand(context, "portManager.listLogicalNetworks", () => this.listLogicalNetworks());
    this.registerApiCommand(context, "portManager.getTerminalRoutingScript", (argument) =>
      this.getTerminalRoutingScript(argument),
    );
    this.registerApiCommand(context, "portManager.getTerminalDetachScript", () =>
      this.dependencies.networkService.createTerminalDetachScript(),
    );
    this.registerCommand(context, "portManager.attachContainerToNetwork", (argument) =>
      this.attachContainerToNetwork(argument),
    );
    this.registerCommand(context, "portManager.detachTerminalFromNetwork", (argument) =>
      this.detachTerminalFromNetwork(argument),
    );
    this.registerCommand(context, "portManager.resetTerminalNetworkSettings", (argument) =>
      this.resetTerminalNetworkSettings(argument),
    );
    this.registerCommand(context, "portManager.addHostPortExposure", (argument) =>
      this.addHostPortExposure(argument),
    );
    this.registerCommand(context, "portManager.addHostAccessBinding", (argument) =>
      this.addHostAccessBinding(argument),
    );
    this.registerCommand(context, "portManager.addComposePublishedPort", (argument) =>
      this.addComposePublishedPort(argument),
    );
    this.registerCommand(context, "portManager.copyComposeAttachment", (argument) =>
      this.copyComposeAttachment(argument),
    );
    this.registerCommand(context, "portManager.detachComposeAttachment", (argument) =>
      this.detachComposeAttachment(argument),
    );
    this.registerCommand(context, "portManager.renameComposeAttachment", (argument) =>
      this.renameComposeAttachment(argument),
    );
    this.registerCommand(context, "portManager.removeComposeAttachment", (argument) =>
      this.removeComposeAttachment(argument),
    );
    this.registerCommand(context, "portManager.saveBindingPreset", (argument) => this.saveBindingPreset(argument));
    this.registerCommand(context, "portManager.applyBindingPreset", (argument) => this.applyBindingPreset(argument));
    this.registerCommand(context, "portManager.removeHostAccessBinding", (argument) =>
      this.removeHostAccessBinding(argument),
    );
    this.registerCommand(context, "portManager.removeHostPortExposure", (argument) =>
      this.removeHostPortExposure(argument),
    );
    this.registerCommand(context, "portManager.copyHostPortExposureUrl", (argument) =>
      this.copyHostPortExposureUrl(argument),
    );
    this.registerCommand(context, "portManager.openHostPortExposureUrl", (argument) =>
      this.openHostPortExposureUrl(argument),
    );
    this.registerCommand(context, "portManager.startDaemon", () => this.startDaemon());
    this.registerCommand(context, "portManager.restartDaemon", () => this.restartDaemon());
    this.registerCommand(context, "portManager.stopDaemon", () => this.stopDaemon());
    this.registerCommand(context, "portManager.showDaemonStatus", () => this.showDaemonStatus());
    this.registerCommand(context, "portManager.fixStaleRouting", () => this.fixStaleRouting());
    this.registerCommand(context, "portManager.clearRoutingFiles", () => this.clearRoutingFiles());
    this.registerCommand(context, "portManager.resetRouting", () => this.clearRoutingFiles());
    this.registerCommand(context, "portManager.clearNetworkCache", (argument) =>
      this.clearNetworkCache(argument),
    );
    this.registerCommand(context, "portManager.clearNetworkRoutingFiles", (argument) =>
      this.clearNetworkCache(argument),
    );
    this.registerCommand(context, "portManager.startManagedProcess", () => this.startManagedProcess());
    this.registerCommand(context, "portManager.addExistingProcess", () => this.addExistingProcess());
    this.registerCommand(context, "portManager.refresh", () => this.refresh());
    this.registerCommand(context, "portManager.showStatusMenu", () => this.showStatusMenu());
    this.registerCommand(context, "portManager.stopProcess", (argument) => this.stopProcess(argument));
    this.registerCommand(context, "portManager.restartProcess", (argument) => this.restartProcess(argument));
    this.registerCommand(context, "portManager.stopAllProcesses", () => this.stopAllProcesses());
    this.registerCommand(context, "portManager.copyRoutedUrl", (argument) => this.copyRoutedUrl(argument));
    this.registerCommand(context, "portManager.openRoutedUrl", (argument) => this.openRoutedUrl(argument));
    this.registerCommand(context, "portManager.removeProcess", (argument) => this.removeProcess(argument));
    this.registerCommand(context, "portManager.installBrowserDnsResolvers", () =>
      this.installBrowserDnsResolvers(),
    );
    this.registerCommand(context, "portManager.cleanupBrowserDnsResolvers", () =>
      this.cleanupBrowserDnsResolvers(),
    );
    this.registerCommand(context, "portManager.installShellHook", () => this.installShellHook(context));
    this.registerCommand(context, "portManager.installExternalCli", () => this.installExternalCli(context));
    this.registerCommand(context, "portManager.openSettings", () => openPortManagerSettings());
  }

  /** Refreshes generated shell hook assets without mutating user profile files. */
  async ensureShellHookAssets(context: vscode.ExtensionContext): Promise<void> {
    if (process.platform === "win32") {
      return;
    }

    await this.writeShellHookAssets(context);
  }

  /** Creates a logical network row backed by the selected runtime adapter. */
  private async createLogicalNetwork(): Promise<void> {
    const runtimeKind = await promptForRuntimeKind(this.dependencies.networkService.getSnapshot().runtimes);
    if (runtimeKind === undefined) {
      return;
    }

    const name = await vscode.window.showInputBox({
      title: "Create Logical Network",
      prompt: "Network name",
      placeHolder: "A app",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Network name is required." : undefined),
    });

    if (!name) {
      return;
    }

    await this.dependencies.networkService.createNetwork(name.trim(), runtimeKind);
    this.dependencies.treeProvider.refresh();
  }

  /** Removes a logical network after closing its host exposures. */
  private async removeLogicalNetwork(argument: unknown): Promise<void> {
    const network = await this.resolveNetworkArgument(argument, "Remove Logical Network");
    if (network === undefined) {
      return;
    }

    const selection = await vscode.window.showWarningMessage(
      `Remove logical network "${network.name}" and its host exposures?`,
      { modal: true },
      "Remove Network",
    );

    if (selection !== "Remove Network") {
      return;
    }

    await this.dependencies.networkService.removeNetwork(network.id);
    this.dependencies.treeProvider.refresh();
  }

  /** Refreshes OS and VS Code terminal windows. */
  private async refreshTerminals(): Promise<void> {
    const windows = await this.dependencies.networkService.refreshTerminals();
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(`Discovered ${windows.length} terminal windows.`);
  }

  /** Refreshes Docker/Podman containers with host-published ports. */
  private async refreshContainerServices(): Promise<void> {
    const candidates = await this.dependencies.networkService.refreshContainerServices();
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(`Discovered ${candidates.length} container services.`);
  }

  /** Attaches a selected terminal window to a selected network when the runtime supports it. */
  private async attachTerminalToNetwork(argument: unknown): Promise<void> {
    const directInput = getAttachTerminalInput(argument);
    const networkFromArgument = getLogicalNetworkFromCommandArgument(argument);
    const terminalWindow = directInput?.terminalWindow ?? (await this.resolveTerminalWindowArgument(argument, "Attach Terminal Window to Network"));
    if (terminalWindow === undefined) {
      return;
    }

    const network =
      directInput?.network ??
      networkFromArgument ??
      (await this.resolveNetworkArgument(undefined, "Attach Terminal Window to Network"));
    if (network === undefined) {
      return;
    }

    let attachment: TerminalAttachment;
    try {
      attachment = await this.dependencies.networkService.attachTerminalWindow(network.id, terminalWindow.id);
    } catch (error) {
      if (await this.offerTerminalRoutingScriptFallback(error, network, terminalWindow)) {
        return;
      }

      throw error;
    }
    this.dependencies.treeProvider.refresh();

    const selection = await vscode.window.showInformationMessage(
      `Attached "${terminalWindow.title}" to "${network.name}" (${attachment.mode ?? "isolated"} mode).`,
      "Reveal Terminal",
    );
    if (selection === "Reveal Terminal") {
      await this.revealTerminalWindow(terminalWindow);
    }
  }

  /** Attaches the currently focused VS Code terminal to a selected network without opening a terminal picker. */
  private async attachActiveTerminalToNetwork(argument: unknown): Promise<void> {
    const network = await this.resolveNetworkArgument(argument, "Attach Active Terminal to Network");
    if (network === undefined) {
      return;
    }

    const terminalWindow = await this.resolveActiveTerminalWindow();
    if (terminalWindow === undefined) {
      return;
    }

    let attachment: TerminalAttachment;
    try {
      attachment = await this.dependencies.networkService.attachTerminalWindow(network.id, terminalWindow.id);
    } catch (error) {
      if (await this.offerTerminalRoutingScriptFallback(error, network, terminalWindow)) {
        return;
      }

      throw error;
    }

    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(
      `Attached active terminal "${terminalWindow.title}" to "${network.name}" (${attachment.mode ?? "isolated"} mode).`,
    );
  }

  /** Attaches an existing backend process so localhost client traffic can resolve to one network. */
  private async attachProcessToNetwork(argument: unknown): Promise<void> {
    const directInput = getAttachProcessInput(argument);
    const network =
      directInput?.network ?? (await this.resolveNetworkArgument(argument, "Attach Process to Network"));
    if (network === undefined) {
      return;
    }

    const target = await this.resolveProcessAttachTarget(directInput, "Attach Process to Network");
    if (target === undefined) {
      return;
    }

    const attachment = await this.dependencies.networkService.attachProcessToNetwork(
      network.id,
      target.pid,
      target.title,
    );
    this.dependencies.treeProvider.refresh();

    await vscode.window.showInformationMessage(
      `Attached "${attachment.terminalTitle ?? `PID ${attachment.rootPid}`}" to "${network.name}" for localhost client routing.`,
    );
  }

  /** Applies one logical network to every new terminal opened by this VS Code window. */
  private async attachVscodeWindowTerminalsToNetwork(argument: unknown): Promise<void> {
    const network = await this.resolveNetworkArgument(argument, "Attach VS Code Window Terminals to Network");
    if (network === undefined) {
      return;
    }

    const result = await this.dependencies.networkService.attachVscodeWindowTerminalsToNetwork(network.id);
    this.dependencies.treeProvider.refresh();

    await vscode.window.showInformationMessage(
      `VS Code window terminals now use "${network.name}". Updated ${result.injectedTerminalCount} open terminal${result.injectedTerminalCount === 1 ? "" : "s"}.`,
    );
  }

  /** Clears the current VS Code window-wide terminal network default. */
  private async detachVscodeWindowTerminalsFromNetwork(): Promise<void> {
    const result = await this.dependencies.networkService.detachVscodeWindowTerminalsFromNetwork();
    this.dependencies.treeProvider.refresh();

    await vscode.window.showInformationMessage(
      result.removedBinding
        ? `VS Code window terminal network cleared. Updated ${result.detachedTerminalCount} open terminal${result.detachedTerminalCount === 1 ? "" : "s"}.`
        : "No VS Code window terminal network was active.",
    );
  }

  /** Returns logical networks for external terminal-owning extensions. */
  private listLogicalNetworks(): readonly LogicalNetwork[] {
    return this.dependencies.networkService.getSnapshot().networks;
  }

  /** Returns a shell snippet that another extension can write to its custom terminal stdin. */
  private async getTerminalRoutingScript(argument: unknown): Promise<string> {
    const network = this.resolveNetworkForApi(argument);
    return this.dependencies.networkService.createTerminalRoutingScript(network.id);
  }

  /** Offers a generic clipboard fallback when no controllable terminal input path exists. */
  private async offerTerminalRoutingScriptFallback(
    error: unknown,
    network: LogicalNetwork,
    terminalWindow: TerminalWindow,
  ): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Could not (find|inject|send)/i.test(message)) {
      return false;
    }

    const selection = await vscode.window.showWarningMessage(
      `Could not write to "${terminalWindow.title}" automatically. Copy the routing script and paste it into that terminal prompt.`,
      "Reveal Terminal",
      "Copy Script",
      "Show Error",
    );

    if (selection === "Reveal Terminal") {
      await this.revealTerminalWindow(terminalWindow);
      return true;
    }
    if (selection === "Show Error") {
      throw error;
    }
    if (selection !== "Copy Script") {
      return true;
    }

    const script = await this.dependencies.networkService.createTerminalRoutingScript(network.id);
    await vscode.env.clipboard.writeText(script);
    await vscode.window.showInformationMessage(
      `Copied terminal routing script for "${network.name}". Paste it into "${terminalWindow.title}".`,
    );
    return true;
  }

  /** Copies a terminal attach script for custom terminal UIs that own their own stdin. */
  private async copyTerminalRoutingScript(argument: unknown): Promise<void> {
    const network = await this.resolveNetworkArgument(argument, "Copy Terminal Routing Script");
    if (network === undefined) {
      return;
    }

    const script = await this.dependencies.networkService.createTerminalRoutingScript(network.id);
    await vscode.env.clipboard.writeText(script);
    await vscode.window.showInformationMessage(
      `Copied terminal routing script for "${network.name}". Paste it into the custom terminal prompt.`,
    );
  }

  /** Attaches a discovered container or compose service's published ports to a logical network. */
  private async attachContainerToNetwork(argument: unknown): Promise<void> {
    const directInput = getAttachContainerInput(argument);
    const candidate =
      directInput?.containerService ??
      (await this.resolveContainerServiceCandidateArgument(argument, "Attach Service to Network"));
    if (candidate === undefined) {
      return;
    }

    const network =
      directInput?.network ?? (await this.resolveNetworkArgument(undefined, "Attach Service to Network"));
    if (network === undefined) {
      return;
    }

    if (candidate.ports.length === 0) {
      await vscode.window.showInformationMessage(`"${formatContainerServiceLabel(candidate)}" has no published TCP ports.`);
      return;
    }

    const composeAttachMode =
      directInput?.composeAttachMode ??
      (candidate.composeProject === undefined
        ? "as-is"
        : await promptForComposeAttachMode(candidate));
    if (composeAttachMode === undefined) {
      return;
    }
    const allowStatefulClone =
      isComposeCloneAttachMode(composeAttachMode) ? await confirmStatefulComposeClone(candidate) : false;
    if (allowStatefulClone === undefined) {
      return;
    }
    const attachedProjectName =
      directInput?.attachedProjectName ??
      (composeAttachMode === "clone-custom"
        ? await promptForComposeProjectName("Clone Compose Project Name")
        : undefined);
    if (composeAttachMode === "clone-custom" && attachedProjectName === undefined) {
      return;
    }

    const existingCloneMutation =
      composeAttachMode === "as-is" ? buildExistingCloneMutationFromCandidate(candidate) : undefined;
    const composeFiles = existingCloneMutation?.composeFiles ?? candidate.composeConfigFiles;
    const composeWorkingDirectory =
      resolveComposeWorkingDirectory(candidate.composeWorkingDirectory, composeFiles) ??
      getDefaultWorkspaceFolder() ??
      process.cwd();
    const composeMutation =
      candidate.composeProject !== undefined && isComposeCloneAttachMode(composeAttachMode)
        ? {
            composeMutation: {
              mode: "clone" as const,
              allowStatefulClone,
              ...(attachedProjectName !== undefined ? { attachedProjectName } : {}),
              runtime: candidate.runtime,
              workingDirectory: composeWorkingDirectory,
              composeFiles: candidate.composeConfigFiles,
              ...(candidate.portManagerClone?.containerMappings !== undefined
                ? { sourceContainerMappings: candidate.portManagerClone.containerMappings }
                : {}),
            },
          }
        : {};

    const attachment = await this.dependencies.networkService.attachComposePublishedPorts({
      networkId: network.id,
      projectName: existingCloneMutation?.originalProjectName ?? candidate.composeProject ?? candidate.containerName,
      runtime: candidate.runtime,
      cwd: composeWorkingDirectory,
      composeFiles,
      ...composeMutation,
      ...(existingCloneMutation !== undefined ? { existingMutation: existingCloneMutation } : {}),
      ports: candidate.ports.map((port) => ({
        serviceName: port.serviceName,
        logicalPort: port.logicalPort,
        actualHostAddress: port.actualHostAddress,
        actualHostPort: port.actualHostPort,
        containerPort: port.containerPort,
        protocolName: port.protocolName,
      })),
    });

    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(
      `Attached "${formatContainerServiceLabel(candidate)}" to "${network.name}" (${attachment.ports.length} port${attachment.ports.length === 1 ? "" : "s"}).`,
    );
  }

  /** Clears network routing variables from a terminal window and removes tracked attachments. */
  private async resetTerminalNetworkSettings(argument: unknown): Promise<void> {
    const attachment = getTerminalAttachmentFromCommandArgument(argument);
    if (attachment !== undefined) {
      if (attachment.terminalWindowId !== undefined) {
        await this.dependencies.networkService.resetTerminalNetworkSettings(attachment.terminalWindowId);
      } else {
        await this.dependencies.networkService.detachTerminal(attachment.id);
      }
      this.dependencies.treeProvider.refresh();
      await vscode.window.showInformationMessage(`Reset "${attachment.terminalTitle ?? attachment.rootPid}".`);
      return;
    }

    const terminalWindow = await this.resolveTerminalWindowArgument(argument, "Reset Terminal Network Settings");
    if (terminalWindow === undefined) {
      return;
    }

    const removedCount = await this.dependencies.networkService.resetTerminalNetworkSettings(terminalWindow.id);
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(
      `Reset "${terminalWindow.title}" network settings${removedCount > 0 ? ` and removed ${removedCount} attachment(s)` : ""}.`,
    );
  }

  /** Detaches a terminal attachment and lets the runtime clean up terminal state. */
  private async detachTerminalFromNetwork(argument: unknown): Promise<void> {
    const attachment = await this.resolveTerminalAttachmentArgument(argument, "Detach Terminal from Network");
    if (attachment === undefined) {
      return;
    }

    await this.dependencies.networkService.detachTerminal(attachment.id);
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(`Detached "${attachment.terminalTitle ?? attachment.rootPid}".`);
  }

  /** Reveals a discovered VS Code, Terminal.app, or iTerm2 terminal window. */
  private async revealTerminalWindow(argument: unknown): Promise<void> {
    const terminalWindow = await this.resolveTerminalWindowForReveal(argument);
    if (terminalWindow === undefined) {
      return;
    }

    const revealed = await this.dependencies.networkService.revealTerminalWindow(terminalWindow.id);
    if (!revealed) {
      await vscode.window.showWarningMessage(
        `Could not focus "${terminalWindow.title}". Use the terminal id ${terminalWindow.terminalId ?? terminalWindow.id}.`,
      );
    }
  }

  /** Opens a host TCP listener/proxy for a network target port. */
  private async addHostPortExposure(argument: unknown): Promise<void> {
    const settings = readPortManagerSettings();
    const network = await this.resolveNetworkArgument(argument, "Add Host Port Exposure");
    if (network === undefined) {
      return;
    }

    const hostAddress = await vscode.window.showInputBox({
      title: "Add Host Port Exposure",
      prompt: "Host address",
      value: settings.defaultHost,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Host address is required." : undefined),
    });

    if (!hostAddress) {
      return;
    }

    const hostPort = await promptForPort("Host port", settings.preferredPorts[0] ?? 3000);
    if (hostPort === undefined) {
      return;
    }

    const targetAddress = await vscode.window.showInputBox({
      title: "Add Host Port Exposure",
      prompt: "Target address inside the selected logical network",
      value: network.runtimeKind === "container" ? "0.0.0.0" : "127.0.0.1",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Target address is required." : undefined),
    });

    if (!targetAddress) {
      return;
    }

    const targetPort = await promptForPort("Target logical port inside network", settings.preferredPorts[0] ?? hostPort);
    if (targetPort === undefined) {
      return;
    }

    if (settings.enabled) {
      await this.dependencies.processService.start();
    }

    const exposure = await this.dependencies.networkService.createExposure({
      networkId: network.id,
      hostAddress: hostAddress.trim(),
      hostPort,
      targetAddress: targetAddress.trim(),
      targetPort,
    });
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(`Exposed ${formatExposureUrl(exposure)}.`);
  }

  /** Creates a network-to-host binding visible from attached terminal processes. */
  private async addHostAccessBinding(argument: unknown): Promise<void> {
    const network = await this.resolveNetworkArgument(argument, "Add Host Access Binding");
    if (network === undefined) {
      return;
    }

    const logicalPort = await promptForPort("Network logical port", 15_432);
    if (logicalPort === undefined) {
      return;
    }

    const hostAddress = await vscode.window.showInputBox({
      title: "Add Host Access Binding",
      prompt: "Host machine address",
      value: "127.0.0.1",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Host address is required." : undefined),
    });

    if (!hostAddress) {
      return;
    }

    const hostPort = await promptForPort("Host machine port", logicalPort);
    if (hostPort === undefined) {
      return;
    }

    const binding = this.dependencies.networkService.createHostAccessBinding({
      networkId: network.id,
      logicalPort,
      hostAddress: hostAddress.trim(),
      hostPort,
    });
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(
      `Bound "${network.name}" logical port ${binding.logicalPort} to host ${binding.hostAddress}:${binding.hostPort}.`,
    );
  }

  /** Registers one Docker Compose published service port as a network-local route. */
  private async addComposePublishedPort(argument: unknown): Promise<void> {
    const settings = readPortManagerSettings();
    const network = await this.resolveNetworkArgument(argument, "Add Compose Published Port");
    if (network === undefined) {
      return;
    }

    const cwd = getDefaultWorkspaceFolder() ?? process.cwd();
    const projectName = await vscode.window.showInputBox({
      title: "Add Compose Published Port",
      prompt: "Compose project name",
      value: path.basename(cwd),
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Project name is required." : undefined),
    });

    if (!projectName) {
      return;
    }

    const serviceName = await vscode.window.showInputBox({
      title: "Add Compose Published Port",
      prompt: "Compose service name",
      placeHolder: "postgres",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Service name is required." : undefined),
    });

    if (!serviceName) {
      return;
    }

    const logicalPort = await promptForPort("Logical network port", settings.preferredPorts[0] ?? 15_432);
    if (logicalPort === undefined) {
      return;
    }

    const actualHostAddress = await vscode.window.showInputBox({
      title: "Add Compose Published Port",
      prompt: "Docker-published host address",
      value: "127.0.0.1",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Host address is required." : undefined),
    });

    if (!actualHostAddress) {
      return;
    }

    const actualHostPort = await promptForPort("Docker-published host port", logicalPort);
    if (actualHostPort === undefined) {
      return;
    }

    const protocolName = await vscode.window.showInputBox({
      title: "Add Compose Published Port",
      prompt: "Protocol label",
      value: inferProtocolName(logicalPort),
      placeHolder: "postgresql",
      ignoreFocusOut: true,
    });

    const attachment = await this.dependencies.networkService.attachComposePublishedPorts({
      networkId: network.id,
      projectName: projectName.trim(),
      cwd,
      ports: [
        {
          serviceName: serviceName.trim(),
          logicalPort,
          actualHostAddress: actualHostAddress.trim(),
          actualHostPort,
          protocolName: protocolName?.trim(),
        },
      ],
    });

    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(`Attached compose project "${attachment.projectName}".`);
  }

  /** Copies an existing Compose route attachment into another logical network. */
  private async copyComposeAttachment(argument: unknown): Promise<void> {
    const targetFromArgument = getLogicalNetworkFromCommandArgument(argument);
    const source = await this.resolveComposeAttachmentForCopy(
      targetFromArgument === undefined ? argument : undefined,
      targetFromArgument,
      "Copy Compose Attachment",
    );
    if (source === undefined) {
      return;
    }

    const target =
      targetFromArgument ?? (await this.resolveComposeCopyTargetNetwork(source, "Copy Compose Attachment"));
    if (target === undefined) {
      return;
    }

    const copied = await this.dependencies.networkService.copyComposeAttachment({
      attachmentId: source.id,
      networkId: target.id,
    });
    if (copied === undefined) {
      await vscode.window.showWarningMessage("Compose attachment no longer exists.");
      return;
    }

    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(
      `Copied "${formatComposeAttachmentName(source)}" to "${target.name}" (${copied.ports.length} route${copied.ports.length === 1 ? "" : "s"}).`,
    );
  }

  /** Detaches compose route rows without changing the underlying Docker/Podman project. */
  private async detachComposeAttachment(argument: unknown): Promise<void> {
    const attachment = await this.resolveComposeAttachmentArgument(argument, "Detach Service from Network");
    if (attachment === undefined) {
      return;
    }

    await this.dependencies.networkService.detachComposeAttachment(attachment.id);
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(`Detached "${attachment.projectName}" from its network.`);
  }

  /** Renames the hidden Docker/Podman Compose project created by clone attach. */
  private async renameComposeAttachment(argument: unknown): Promise<void> {
    const attachment = await this.resolveComposeAttachmentArgument(argument, "Rename Compose Project");
    if (attachment === undefined) {
      return;
    }

    const projectName = await promptForComposeProjectName(
      "Rename Compose Project",
      attachment.mutation?.attachedProjectName ?? attachment.projectName,
    );
    if (projectName === undefined) {
      return;
    }

    const renamed = await this.dependencies.networkService.renameComposeAttachment(attachment.id, projectName);
    this.dependencies.treeProvider.refresh();
    if (renamed !== undefined) {
      await vscode.window.showInformationMessage(`Renamed compose project to "${projectName}".`);
    }
  }

  /** Removes compose route rows and restores any Docker/Podman mutation Port Manager created. */
  private async removeComposeAttachment(argument: unknown): Promise<void> {
    const attachment = await this.resolveComposeAttachmentArgument(argument, "Remove Compose Attachment");
    if (attachment === undefined) {
      return;
    }

    await this.dependencies.networkService.removeComposeAttachment(attachment.id);
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(`Removed compose project "${attachment.projectName}".`);
  }

  /** Removes one host exposure and closes its local listener. */
  private async removeHostPortExposure(argument: unknown): Promise<void> {
    const exposure = await this.resolveExposureArgument(argument, "Remove Host Port Exposure");
    if (exposure === undefined) {
      return;
    }

    await this.dependencies.networkService.removeExposure(exposure.id);
    this.dependencies.treeProvider.refresh();
  }

  /** Removes one network-to-host binding. */
  private async removeHostAccessBinding(argument: unknown): Promise<void> {
    const binding = await this.resolveHostAccessBindingArgument(argument, "Remove Host Access Binding");
    if (binding === undefined) {
      return;
    }

    this.dependencies.networkService.removeHostAccessBinding(binding.id);
    this.dependencies.treeProvider.refresh();
  }

  /** Saves the selected network's current bindings as a reusable preset. */
  private async saveBindingPreset(argument: unknown): Promise<void> {
    const network = await this.resolveNetworkArgument(argument, "Save Binding Preset");
    if (network === undefined) {
      return;
    }

    const name = await vscode.window.showInputBox({
      title: "Save Binding Preset",
      prompt: "Preset name",
      value: `${network.name} bindings`,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Preset name is required." : undefined),
    });

    if (name === undefined) {
      return;
    }

    const preset = this.dependencies.networkService.saveBindingPreset(name.trim(), network.id);
    await vscode.window.showInformationMessage(
      `Saved preset "${preset.name}" (${preset.exposureCount} exposures, ${preset.hostAccessCount} host access).`,
    );
  }

  /** Applies a saved binding preset to the selected logical network. */
  private async applyBindingPreset(argument: unknown): Promise<void> {
    const network = await this.resolveNetworkArgument(argument, "Apply Binding Preset");
    if (network === undefined) {
      return;
    }

    const presets = this.dependencies.networkService.listBindingPresets();
    if (presets.length === 0) {
      await vscode.window.showInformationMessage("No binding presets saved.");
      return;
    }

    const selected = await vscode.window.showQuickPick(
      presets.map((preset) => ({
        label: preset.name,
        description: `${preset.exposureCount} exposures, ${preset.hostAccessCount} host access`,
        detail: `Updated ${preset.updatedAt}`,
        preset,
      })),
      { title: "Apply Binding Preset", placeHolder: "Select a preset" },
    );

    if (selected === undefined) {
      return;
    }

    const preset = await this.dependencies.networkService.applyBindingPreset(selected.preset.id, network.id);
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage(`Applied preset "${preset.name}" to "${network.name}".`);
  }

  /** Copies the URL for one active host exposure. */
  private async copyHostPortExposureUrl(argument: unknown): Promise<void> {
    const exposure = await this.resolveExposureArgument(argument, "Copy Host Exposure URL");
    if (exposure === undefined) {
      return;
    }

    const url = formatExposureUrl(exposure);
    await vscode.env.clipboard.writeText(url);
    await vscode.window.showInformationMessage(`Copied ${url}`);
  }

  /** Opens the URL for one active host exposure. */
  private async openHostPortExposureUrl(argument: unknown): Promise<void> {
    const exposure = await this.resolveExposureArgument(argument, "Open Host Exposure URL");
    if (exposure === undefined) {
      return;
    }

    await openUrl(formatExposureUrl(exposure));
  }

  /** Releases command subscriptions during extension deactivation. */
  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  /** Starts or reconnects to the singleton local daemon and refreshes the view. */
  private async startDaemon(): Promise<void> {
    await this.dependencies.processService.start();
    this.dependencies.treeProvider.refresh();

    const daemon = this.dependencies.processService.getSnapshot().daemon;
    if (daemon.restartRequired) {
      const selection = await vscode.window.showWarningMessage(
        `Port Manager daemon is stale: pid ${daemon.pid}. Restart it and reset all terminal routing settings?`,
        "Restart Daemon",
      );

      if (selection === "Restart Daemon") {
        await this.restartDaemon({ skipConfirmation: true });
      }
      return;
    }

    await vscode.window.showInformationMessage(
      `Port Manager daemon ${daemon.status}: pid ${daemon.pid}, ${daemon.listenerCount} listeners, ${daemon.routeCount} routes`,
    );
  }

  /** Restarts the shared daemon and clears routing variables from every terminal. */
  private async restartDaemon(options: { readonly skipConfirmation?: boolean } = {}): Promise<void> {
    if (!options.skipConfirmation) {
      const selection = await vscode.window.showWarningMessage(
        "Restart the Port Manager daemon? This resets Port Manager routing variables in all discovered terminal windows.",
        { modal: true },
        "Restart Daemon",
      );

      if (selection !== "Restart Daemon") {
        return;
      }
    }

    await this.dependencies.processService.restartDaemon();
    const resetSummary = await this.dependencies.networkService.resetAllTerminalNetworkSettings();
    this.dependencies.treeProvider.refresh();

    const daemon = this.dependencies.processService.getSnapshot().daemon;
    await vscode.window.showInformationMessage(
      `Port Manager daemon restarted: pid ${daemon.pid}. Reset ${resetSummary.terminalCount} terminal(s), removed ${resetSummary.removedAttachmentCount} attachment(s).`,
    );
  }

  /** Stops the shared daemon without terminating processes it previously tracked. */
  private async stopDaemon(): Promise<void> {
    const selection = await vscode.window.showWarningMessage(
      "Stop the Port Manager daemon? Running application processes may keep running, but routing and monitoring stop until the daemon starts again.",
      { modal: true },
      "Stop Daemon",
    );

    if (selection !== "Stop Daemon") {
      return;
    }

    await this.dependencies.processService.stopDaemon();
    this.dependencies.treeProvider.refresh();
    await vscode.window.showInformationMessage("Port Manager daemon stopped.");
  }

  /** Shows the latest daemon status known from the shared agent snapshot. */
  private async showDaemonStatus(): Promise<void> {
    await this.dependencies.processService.refresh();
    const daemon = this.dependencies.processService.getSnapshot().daemon;
    const routeTablePath = daemon.routeTablePath ? `\nRoute table: ${daemon.routeTablePath}` : "";
    const version = `\nVersion: ${daemon.versionStatus ?? "unknown"}${daemon.restartRequired ? " (restart required)" : ""}`;
    const agentMainPath = daemon.agentMainPath ? `\nAgent main: ${daemon.agentMainPath}` : "";
    const expectedAgentMainPath = daemon.expectedAgentMainPath ? `\nExpected agent: ${daemon.expectedAgentMainPath}` : "";
    const errorMessage = daemon.errorMessage ? `\nWarning: ${daemon.errorMessage}` : "";

    await vscode.window.showInformationMessage(
      `Daemon ${daemon.status}. PID: ${daemon.pid || "n/a"}. Listeners: ${daemon.listenerCount}. Routes: ${daemon.routeCount}.${version}${agentMainPath}${expectedAgentMainPath}${routeTablePath}${errorMessage}`,
      { modal: true },
    );
  }

  /** Converges daemon state and regenerates disposable routing files from durable bindings. */
  private async fixStaleRouting(): Promise<void> {
    const summary = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Port Manager: fixing stale routing",
      },
      () => this.dependencies.networkService.fixStaleRouting(),
    );

    await this.dependencies.processService.refresh().catch(() => undefined);
    this.dependencies.treeProvider.refresh();

    const daemonText = summary.daemonRestarted
      ? " Restarted the stale daemon."
      : summary.staleDaemonDetected
        ? " Daemon convergence is still pending or backed off."
        : "";
    const failureText =
      summary.failedFileCount > 0 ? ` ${summary.failedFileCount} file(s) could not be removed.` : "";

    await vscode.window.showInformationMessage(
      `Fixed routing state: removed ${summary.removedFileCount} generated file(s), ${summary.removedMarkerCount} stale marker(s), restored ${summary.restoredComposeRouteCount} compose route(s), ${summary.routeCount} active route(s).${daemonText}${failureText}`,
    );
  }

  /** Clears generated routing cache files and rehydrates durable compose routes. */
  private async clearRoutingFiles(): Promise<void> {
    const selection = await vscode.window.showWarningMessage(
      "Clear Port Manager routing files? Current network, compose, container, and volume state is preserved, but attached terminals should be reattached if they still carry old environment variables.",
      { modal: true },
      "Clear Routing Files",
    );

    if (selection !== "Clear Routing Files") {
      return;
    }

    const summary = await this.dependencies.networkService.clearRoutingFiles();
    await this.dependencies.processService.refresh().catch(() => undefined);
    this.dependencies.treeProvider.refresh();

    const failureText =
      summary.failedFileCount > 0 ? ` ${summary.failedFileCount} file(s) could not be removed.` : "";
    await vscode.window.showInformationMessage(
      `Cleared ${summary.removedFileCount} routing file(s) and restored ${summary.restoredComposeRouteCount} compose route(s).${failureText}`,
    );
  }

  /** Clears generated network-scoped cache files from the sidebar or command palette. */
  private async clearNetworkCache(argument: unknown): Promise<void> {
    const network = await this.resolveNetworkArgument(argument, "Clear Network Cache");
    if (network === undefined) {
      return;
    }

    const selection = await vscode.window.showWarningMessage(
      `Clear generated cache files for "${network.name}"? Durable bindings and running Compose clone state are preserved, but attached terminals should be reattached if they still carry old environment variables.`,
      { modal: true },
      "Clear Network Cache",
    );

    if (selection !== "Clear Network Cache") {
      return;
    }

    const summary = await this.dependencies.networkService.clearNetworkRoutingFiles(network.id);
    await this.dependencies.processService.refresh().catch(() => undefined);
    this.dependencies.treeProvider.refresh();

    const failureText =
      summary.failedFileCount > 0 ? ` ${summary.failedFileCount} file(s) could not be removed.` : "";
    await vscode.window.showInformationMessage(
      `Cleared ${summary.removedFileCount} routing file(s) for "${network.name}" and restored ${summary.restoredComposeRouteCount} compose route(s).${failureText}`,
    );
  }

  /**
   * Starts a managed process from interactive VS Code prompts.
   * Returning early on undefined inputs lets cancellation behave naturally.
   */
  private async startManagedProcess(): Promise<void> {
    const settings = readPortManagerSettings();

    if (!settings.enabled) {
      await vscode.window.showWarningMessage("Port Manager is disabled in settings.");
      return;
    }

    const workspaceFolder = getDefaultWorkspaceFolder();
    const command = await vscode.window.showInputBox({
      title: "Start Managed Process",
      prompt: "Command to run",
      placeHolder: "npm run dev",
      ignoreFocusOut: true,
    });

    if (!command) {
      return;
    }

    const requestedPort = await promptForPort("Requested port", settings.preferredPorts[0] ?? 3000);
    if (requestedPort === undefined) {
      return;
    }

    const cwd = await vscode.window.showInputBox({
      title: "Start Managed Process",
      prompt: "Working directory",
      value: workspaceFolder ?? process.cwd(),
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Working directory is required." : undefined),
    });

    if (!cwd) {
      return;
    }

    const injectionMode = await promptForInjectionMode();
    if (injectionMode === undefined) {
      return;
    }

    const name = await vscode.window.showInputBox({
      title: "Start Managed Process",
      prompt: "Display name",
      value: deriveProcessName(command, cwd),
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Display name is required." : undefined),
    });

    if (!name) {
      return;
    }

    await this.startFromProfile({
      name,
      command,
      cwd,
      requestedPort,
      host: settings.defaultHost,
      injectionMode,
    });
  }

  /**
   * Adds an already running process to the sidebar. MVP registration does not
   * reroute external processes because their sockets are already bound.
   */
  private async addExistingProcess(): Promise<void> {
    const settings = readPortManagerSettings();
    const pid = await promptForInteger("PID", undefined, "Operating system process id");

    if (pid === undefined) {
      return;
    }

    const actualPort = await promptForPort("Actual port", settings.preferredPorts[0] ?? 3000);
    if (actualPort === undefined) {
      return;
    }

    const requestedPort = await promptForPort("Requested port", actualPort);
    if (requestedPort === undefined) {
      return;
    }

    const name = await vscode.window.showInputBox({
      title: "Add Existing Process",
      prompt: "Display name",
      value: `Process ${pid}`,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "Display name is required." : undefined),
    });

    if (!name) {
      return;
    }

    const cwd = getDefaultWorkspaceFolder() ?? process.cwd();
    await this.dependencies.processService.registerExistingProcess({
      pid,
      name,
      command: name,
      cwd,
      requestedPort,
      actualPort,
      host: settings.defaultHost,
    });

    this.dependencies.treeProvider.refresh();
  }

  /** Forces the tree provider to request the latest registry snapshot. */
  private async refresh(): Promise<void> {
    await Promise.all([
      this.dependencies.networkService.refreshTerminals(),
      this.dependencies.networkService.refreshContainerServices(),
    ]);
    this.dependencies.treeProvider.refresh();
  }

  /** Opens the status bar command menu around the current terminal routing scope. */
  private async showStatusMenu(): Promise<void> {
    const snapshot = this.dependencies.networkService.getSnapshot();
    const statusSummary = formatStatusMenuSummary(snapshot);
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: "$(target) Current Routing",
          description: statusSummary.label,
          detail: statusSummary.detail,
          action: "current" as const,
        },
        {
          label: "$(vm) Switch VS Code Terminal Network",
          description: "Choose the network inherited by new terminals",
          action: "switch" as const,
        },
        {
          label: "$(debug-disconnect) Detach",
          description: statusSummary.detachDescription,
          action: "detach" as const,
        },
        {
          label: "$(refresh) Refresh",
          description: "Rescan terminals and services",
          action: "refresh" as const,
        },
      ],
      { title: "Port Manager", placeHolder: statusSummary.label },
    );

    if (selected === undefined) {
      return;
    }

    switch (selected.action) {
      case "current":
        await vscode.commands.executeCommand("workbench.view.extension.portManager");
        await vscode.commands.executeCommand("portManager.processes.focus");
        return;
      case "switch":
        await this.attachVscodeWindowTerminalsToNetwork(undefined);
        return;
      case "detach":
        if (snapshot.vscodeWindowTerminalBinding !== undefined) {
          await this.detachVscodeWindowTerminalsFromNetwork();
          return;
        }
        await this.detachTerminalFromNetwork(undefined);
        return;
      case "refresh":
        await this.refresh();
        return;
    }
  }

  /**
   * Stops a selected process through the shared agent. External detected rows
   * may not map to an agent-owned child process, so the service decides whether
   * stop is actionable.
   */
  private async stopProcess(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Stop Process");
    if (process === undefined) {
      return;
    }

    const settings = readPortManagerSettings();
    await this.dependencies.processService.stopProcess(process.id, settings);
  }

  /**
   * Restarts a managed process using the launch profile stored by the agent.
   * Detected external rows generally cannot restart because the agent did not
   * launch them.
   */
  private async restartProcess(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Restart Process");
    if (process === undefined) {
      return;
    }

    const settings = readPortManagerSettings();
    const restarted = await this.dependencies.processService.restartProcess(process.id, settings);

    if (settings.autoOpenBrowser && restarted?.url) {
      const url = (await this.dependencies.networkService.getBrowserIsolatedUrl(restarted)) ?? restarted.url;
      await openUrl(url);
    }
  }

  /** Stops every registered process in snapshot order. */
  private async stopAllProcesses(): Promise<void> {
    const settings = readPortManagerSettings();

    for (const process of this.dependencies.processService.list()) {
      if (process.status === "stopped") {
        continue;
      }

      await this.dependencies.processService.stopProcess(process.id, settings);
    }
  }

  /** Copies the selected process URL to the system clipboard. */
  private async copyRoutedUrl(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Copy Routed URL");
    if (!isReachableProcess(process)) {
      await vscode.window.showInformationMessage("This process is not running, so there is no routed URL to copy.");
      return;
    }

    const url = (await this.dependencies.networkService.getBrowserIsolatedUrl(process)) ?? process.url;
    await vscode.env.clipboard.writeText(url);
    await vscode.window.showInformationMessage(`Copied ${url}`);
  }

  /** Opens the selected process URL in the user's default browser. */
  private async openRoutedUrl(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Open Routed URL");
    if (!isReachableProcess(process)) {
      await vscode.window.showInformationMessage("This process is not running, so there is no routed URL to open.");
      return;
    }

    const url = (await this.dependencies.networkService.getBrowserIsolatedUrl(process)) ?? process.url;
    await openUrl(url);
  }

  /** Installs macOS resolver rows needed for single-label browser aliases. */
  private async installBrowserDnsResolvers(): Promise<void> {
    try {
      const status = await this.dependencies.networkService.installBrowserDnsResolvers();
      if (!status.supported) {
        await vscode.window.showInformationMessage("Browser DNS aliases are only supported on macOS.");
        return;
      }
      await vscode.window.showInformationMessage(
        `Browser DNS aliases installed: ${status.installedCount}/${status.records.length}`,
      );
    } catch (error) {
      await vscode.window.showWarningMessage(`Browser DNS install failed: ${toErrorMessage(error)}`);
    }
  }

  /** Removes Port Manager-owned macOS resolver rows for browser aliases. */
  private async cleanupBrowserDnsResolvers(): Promise<void> {
    try {
      const status = await this.dependencies.networkService.cleanupBrowserDnsResolvers();
      if (!status.supported) {
        await vscode.window.showInformationMessage("Browser DNS aliases are only supported on macOS.");
        return;
      }
      await vscode.window.showInformationMessage(
        `Browser DNS aliases cleaned: ${status.records.length - status.installedCount}/${status.records.length}`,
      );
    } catch (error) {
      await vscode.window.showWarningMessage(`Browser DNS cleanup failed: ${toErrorMessage(error)}`);
    }
  }

  /**
   * Removes a process row from the shared agent state. The command does not
   * stop external processes; users can choose Stop first for managed children.
   */
  private async removeProcess(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Remove Process");
    if (process === undefined) {
      return;
    }

    await this.dependencies.processService.removeProcess(process.id);
  }

  /** Installs a small shell shim so OS terminals can call the daemon wrapper. */
  private async installExternalCli(context: vscode.ExtensionContext): Promise<void> {
    const cliPath = context.asAbsolutePath(path.join("out", "src", "cli", "portmanager-cli.js"));
    const installDirectory = getExternalCliInstallDirectory();
    const shimPath = getExternalCliShimPath(installDirectory);
    const shimContent = buildExternalCliShim(cliPath, process.execPath);

    await fs.mkdir(installDirectory, { recursive: true });
    await fs.writeFile(shimPath, shimContent, "utf8");

    if (process.platform !== "win32") {
      await fs.chmod(shimPath, 0o755);
    }

    const pathHint = buildPathHint(installDirectory);
    const selection = await vscode.window.showInformationMessage(
      `Installed Port Manager CLI shim: ${shimPath}`,
      pathHint === undefined ? "Copy Command" : "Copy PATH Setup",
    );

    if (selection === "Copy Command") {
      await vscode.env.clipboard.writeText(`"${shimPath}"`);
    }

    if (selection === "Copy PATH Setup" && pathHint !== undefined) {
      await vscode.env.clipboard.writeText(pathHint);
    }
  }

  /** Installs the native socket hook into the user's shell startup file. */
  private async installShellHook(context: vscode.ExtensionContext): Promise<void> {
    const assets = await this.writeShellHookAssets(context);

    for (const shellProfilePath of assets.shellProfilePaths) {
      await appendLineOnce(shellProfilePath, assets.sourceLine);
    }

    const message =
      assets.shellProfilePaths.length === 0
        ? `Installed Port Manager shell hook: ${assets.hookScriptPath}`
        : `Installed Port Manager shell hook and updated ${assets.shellProfilePaths.join(", ")}`;
    const selection = await vscode.window.showInformationMessage(message, "Copy Source Line");

    if (selection === "Copy Source Line") {
      await vscode.env.clipboard.writeText(assets.sourceLine);
    }
  }

  /** Writes the generated shell hook that external terminals source on startup. */
  private async writeShellHookAssets(context: vscode.ExtensionContext): Promise<ShellHookAssets> {
    const settings = readPortManagerSettings();
    const hookLibraryPath = context.asAbsolutePath(getHookLibraryRelativePath());
    const asdfShimLauncherPath = context.asAbsolutePath(getAsdfShimLauncherRelativePath());
    const runtimeCommandShimPath = context.asAbsolutePath(getRuntimeCommandShimRelativePath());
    const agentMainPath = context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
    const nativeAgentPath = context.asAbsolutePath(path.join("media", "native", "portmanager_agent"));
    const nativeContainerMapPath = context.asAbsolutePath(path.join("media", "native", "portmanager_container_map"));
    const hookDirectory = path.join(os.homedir(), ".portmanager");
    const hookScriptPath = path.join(hookDirectory, "portmanager-hook.sh");
    const terminalNetworkSelectionFilePath = path.join(
      context.globalStorageUri.fsPath,
      TERMINAL_NETWORK_SELECTION_FILE_NAME,
    );
    const shellProfilePaths = getShellProfilePaths();
    const sourceLine = `. "${hookScriptPath}"`;

    await fs.mkdir(hookDirectory, { recursive: true });
    const runtimeShimDirectory = prepareRuntimeShimLauncherDirectory(
      hookDirectory,
      asdfShimLauncherPath,
      runtimeCommandShimPath,
    );
    const shellEnvRestorePath = prepareShellEnvRestoreScript(hookDirectory, hookLibraryPath, {
      agentSocketPath: getAgentSocketPath(),
      agentMainPath,
      agentExecutablePath: nativeAgentPath,
      containerMapHelperPath: nativeContainerMapPath,
      globalRouteTablePath: getDefaultRouteTablePath(),
      hostAccessFilePath: getDefaultHostAccessBindingsPath(),
      settings,
      dockerShimPath: runtimeCommandShimPath,
    });
    await fs.writeFile(
      hookScriptPath,
      buildShellHookScript({
        hookLibraryPath,
        agentMainPath,
        nativeAgentPath,
        nativeContainerMapPath,
        dockerShimPath: runtimeCommandShimPath,
        nodeExecutablePath: process.execPath,
        socketPath: getAgentSocketPath(),
        routeTablePath: getDefaultRouteTablePath(),
        hostAccessFilePath: getDefaultHostAccessBindingsPath(),
        terminalNetworkSelectionFilePath,
        settings,
        runtimeShimDirectory,
        shellEnvRestorePath,
      }),
      "utf8",
    );

    if (process.platform !== "win32") {
      await fs.chmod(hookScriptPath, 0o700).catch(() => undefined);
    }

    return {
      hookScriptPath,
      sourceLine,
      shellProfilePaths,
    };
  }

  /**
   * Starts a process from an explicit profile through the agent, which owns
   * routing and restart metadata.
   */
  private async startFromProfile(profile: ManagedProcessStartInput): Promise<ManagedProcess> {
    const settings = readPortManagerSettings();
    const process = await this.dependencies.processService.startManagedProcess(profile, settings);
    const routed = process.requestedPort !== process.actualPort;

    if (routed && settings.showConflictNotification) {
      await vscode.window.showInformationMessage(
        `Port ${profile.requestedPort} is busy. Routed app to ${process.actualPort}.`,
      );
    }

    if (settings.autoOpenBrowser && process.url) {
      const url = (await this.dependencies.networkService.getBrowserIsolatedUrl(process)) ?? process.url;
      await openUrl(url);
    }

    return process;
  }

  /**
   * Resolves a command argument from the tree, or asks the user to choose a
   * process when the command was launched from the palette.
   */
  private async resolveProcessArgument(argument: unknown, title: string): Promise<ManagedProcess | undefined> {
    const process = getProcessFromCommandArgument(argument);

    if (process !== undefined) {
      return this.dependencies.processService.get(process.id);
    }

    const processes = this.dependencies.processService.list();
    if (processes.length === 0) {
      await vscode.window.showInformationMessage("No managed processes are registered.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      processes.map((item) => ({
        label: item.name,
        description: `${item.requestedPort} -> ${item.actualPort} ${item.status}`,
        detail: item.url,
        process: item,
      })),
      { title, placeHolder: "Select a managed process" },
    );

    return selected?.process;
  }

  /** Resolves a logical network from tree context or Quick Pick. */
  private async resolveNetworkArgument(argument: unknown, title: string): Promise<LogicalNetwork | undefined> {
    const network = getLogicalNetworkFromCommandArgument(argument);

    if (network !== undefined) {
      return this.dependencies.networkService.getSnapshot().networks.find((item) => item.id === network.id);
    }

    const networks = this.dependencies.networkService.getSnapshot().networks;
    if (networks.length === 0) {
      await vscode.window.showInformationMessage("No logical networks exist.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      networks.map((item) => ({
        label: item.name,
        description: `${item.runtimeKind} ${item.status}`,
        network: item,
      })),
      { title, placeHolder: "Select a logical network" },
    );

    return selected?.network;
  }

  /** Resolves a network for machine-facing API commands without opening UI prompts. */
  private resolveNetworkForApi(argument: unknown): LogicalNetwork {
    const networks = this.dependencies.networkService.getSnapshot().networks;
    const directNetwork = getLogicalNetworkFromCommandArgument(argument);
    const input = parseNetworkApiInput(argument);
    const networkId = directNetwork?.id ?? input.networkId;
    const networkName = directNetwork?.name ?? input.networkName;

    if (networkId !== undefined) {
      const network = networks.find((item) => item.id === networkId);
      if (network !== undefined) {
        return network;
      }

      throw new Error(`Unknown logical network: ${networkId}`);
    }

    if (networkName !== undefined) {
      const matches = networks.filter((item) => item.name === networkName);
      if (matches.length === 1) {
        return matches[0];
      }
      if (matches.length > 1) {
        throw new Error(`Multiple logical networks are named "${networkName}". Pass networkId instead.`);
      }

      throw new Error(`Unknown logical network: ${networkName}`);
    }

    if (networks.length === 1) {
      return networks[0];
    }

    throw new Error("Pass networkId to choose a logical network.");
  }

  /** Resolves a terminal window from tree context or Quick Pick. */
  private async resolveTerminalWindowArgument(argument: unknown, title: string): Promise<TerminalWindow | undefined> {
    const terminalWindow = getTerminalWindowFromCommandArgument(argument);

    if (terminalWindow !== undefined) {
      return terminalWindow;
    }

    const windows = this.dependencies.networkService.getSnapshot().terminalWindows;
    if (windows.length === 0) {
      await vscode.window.showInformationMessage("No terminal windows discovered.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      windows.map((item) => ({
        label: item.title,
        description: `${item.source}, ${item.candidateCount} processes, root ${item.rootPid}`,
        detail: item.command,
        terminalWindow: item,
      })),
      { title, placeHolder: "Select a terminal window" },
    );

    return selected?.terminalWindow;
  }

  /** Resolves the active VS Code terminal into the same grouped terminal model used by attach. */
  private async resolveActiveTerminalWindow(): Promise<TerminalWindow | undefined> {
    const activeTerminal = vscode.window.activeTerminal;
    if (activeTerminal === undefined) {
      await vscode.window.showInformationMessage("No active VS Code terminal.");
      return undefined;
    }

    let processId: number | undefined;
    try {
      processId = await activeTerminal.processId;
    } catch {
      processId = undefined;
    }

    await this.dependencies.networkService.refreshTerminals().catch(() => []);
    const terminalWindows = this.dependencies.networkService.getSnapshot().terminalWindows;
    const terminalWindow = terminalWindows.find((candidate) =>
      isActiveVscodeTerminalWindow(candidate, activeTerminal, processId),
    );

    if (terminalWindow === undefined) {
      await vscode.window.showWarningMessage(
        `Could not match active terminal "${activeTerminal.name}". Use Attach Terminal and choose it from the list.`,
      );
    }

    return terminalWindow;
  }

  /** Resolves terminal rows and attachment rows to a visible terminal window for focusing. */
  private async resolveTerminalWindowForReveal(argument: unknown): Promise<TerminalWindow | undefined> {
    const terminalWindow = getTerminalWindowFromCommandArgument(argument);
    if (terminalWindow !== undefined) {
      return terminalWindow;
    }

    const attachment = getTerminalAttachmentFromCommandArgument(argument);
    if (attachment !== undefined) {
      const window = await this.findTerminalWindowForAttachment(attachment);
      if (window === undefined) {
        await vscode.window.showWarningMessage(
          `Could not find a live terminal window for "${attachment.terminalTitle ?? attachment.rootPid}".`,
        );
      }

      return window;
    }

    return this.resolveTerminalWindowArgument(argument, "Reveal Terminal Window");
  }

  /** Refreshes discovery and maps an attachment back to a current terminal row. */
  private async findTerminalWindowForAttachment(attachment: TerminalAttachment): Promise<TerminalWindow | undefined> {
    let window = this.findSnapshotTerminalWindowForAttachment(attachment);
    if (window !== undefined) {
      return window;
    }

    await this.dependencies.networkService.refreshTerminals().catch(() => []);
    window = this.findSnapshotTerminalWindowForAttachment(attachment);

    return window;
  }

  private findSnapshotTerminalWindowForAttachment(attachment: TerminalAttachment): TerminalWindow | undefined {
    return this.dependencies.networkService
      .getSnapshot()
      .terminalWindows.find((window) => isTerminalWindowForAttachment(window, attachment));
  }

  /** Resolves an arbitrary local process from known listeners or a manual PID/port entry. */
  private async resolveProcessAttachTarget(
    input: AttachProcessCommandInput | undefined,
    title: string,
  ): Promise<ProcessAttachTarget | undefined> {
    await this.dependencies.processService.start();
    await this.dependencies.processService.refresh().catch(() => undefined);
    const listeners = this.dependencies.processService.getSnapshot().listeners.filter(
      (listener): listener is ListeningPort & { readonly pid: number } => listener.pid !== undefined,
    );

    if (input?.pid !== undefined) {
      const target = buildProcessAttachTargetFromPid(input.pid, listeners);
      return input.title === undefined ? target : { ...target, title: input.title };
    }

    if (input?.port !== undefined) {
      const target = buildProcessAttachTargetFromPort(input.port, listeners);
      if (target === undefined) {
        throw new Error(`No visible local listener owns port ${input.port}. Pass pid instead.`);
      }
      return input.title === undefined ? target : { ...target, title: input.title };
    }

    const listenerItems = dedupeListeningPortsByPidAndPort(listeners).map((listener) => ({
      label: `${listener.localAddress}:${listener.port}`,
      description: `pid ${listener.pid}${listener.processName ? `, ${listener.processName}` : ""}`,
      detail: listener.command,
      target: buildProcessAttachTargetFromListener(listener),
    }));
    const manualItem = {
      label: "Enter PID or listening port",
      description: "Use this for backend ports from extension logs",
      target: undefined,
      manual: true,
    };
    const selected = await vscode.window.showQuickPick([...listenerItems, manualItem], {
      title,
      placeHolder: "Select a backend process or enter a PID/port",
    });

    if (selected === undefined) {
      return undefined;
    }

    if (!("manual" in selected)) {
      return selected.target;
    }

    const rawValue = await vscode.window.showInputBox({
      title,
      prompt: "PID or listening TCP port, for example the Django Shell backend port 49343",
      ignoreFocusOut: true,
      validateInput: (value) =>
        parsePositiveIntegerText(value) === undefined ? "Enter a positive integer PID or TCP port." : undefined,
    });
    const value = parsePositiveIntegerText(rawValue);

    if (value === undefined) {
      return undefined;
    }

    const listenerTarget = buildProcessAttachTargetFromPort(value, listeners);
    if (listenerTarget !== undefined) {
      return listenerTarget;
    }

    const interpretation = await vscode.window.showQuickPick(
      [
        {
          label: `Attach PID ${value}`,
          description: "No local listener was found on that port",
          target: buildProcessAttachTargetFromPid(value, listeners),
        },
      ],
      { title, placeHolder: `No listener was found on port ${value}` },
    );

    return interpretation?.target;
  }

  /** Resolves a container service candidate from tree context or Quick Pick. */
  private async resolveContainerServiceCandidateArgument(
    argument: unknown,
    title: string,
  ): Promise<ContainerServiceCandidate | undefined> {
    const candidate = getContainerServiceCandidateFromCommandArgument(argument);

    if (candidate !== undefined) {
      return resolveLatestContainerServiceCandidate(
        this.dependencies.networkService.getSnapshot().containerServiceCandidates,
        candidate,
      );
    }

    const candidates = this.dependencies.networkService.getSnapshot().containerServiceCandidates;
    if (candidates.length === 0) {
      await vscode.window.showInformationMessage("No published container services discovered.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      candidates.map((item) => ({
        label: formatContainerServiceLabel(item),
        description: formatContainerServiceCandidateDescription(item),
        detail: formatContainerServiceCandidateDetail(item),
        candidate: item,
      })),
      { title, placeHolder: "Select a container or compose service" },
    );

    return selected?.candidate;
  }

  /** Resolves a terminal attachment from tree context or Quick Pick. */
  private async resolveTerminalAttachmentArgument(
    argument: unknown,
    title: string,
  ): Promise<TerminalAttachment | undefined> {
    const attachment = getTerminalAttachmentFromCommandArgument(argument);

    if (attachment !== undefined) {
      return this.dependencies.networkService
        .getSnapshot()
        .attachments.find((item) => item.id === attachment.id);
    }

    const snapshot = this.dependencies.networkService.getSnapshot();
    if (snapshot.attachments.length === 0) {
      await vscode.window.showInformationMessage("No terminal attachments exist.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      snapshot.attachments.map((item) => {
        const network = snapshot.networks.find((candidate) => candidate.id === item.networkId);
        return {
          label: item.terminalTitle ?? `PID ${item.rootPid}`,
          description: `${network?.name ?? item.networkId} ${item.mode ?? "isolated"} ${item.status}`,
          attachment: item,
        };
      }),
      { title, placeHolder: "Select a terminal attachment" },
    );

    return selected?.attachment;
  }

  /** Resolves a host exposure from tree context or Quick Pick. */
  private async resolveExposureArgument(argument: unknown, title: string): Promise<HostPortExposure | undefined> {
    const exposure = getHostPortExposureFromCommandArgument(argument);

    if (exposure !== undefined) {
      return this.dependencies.networkService.getExposure(exposure.id);
    }

    const exposures = this.dependencies.networkService.getSnapshot().exposures;
    if (exposures.length === 0) {
      await vscode.window.showInformationMessage("No host port exposures exist.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      exposures.map((item) => ({
        label: formatExposureUrl(item),
        description: `${item.targetAddress}:${item.targetPort} ${item.status}`,
        exposure: item,
      })),
      { title, placeHolder: "Select a host exposure" },
    );

    return selected?.exposure;
  }

  /** Resolves a network-to-host binding from tree context or Quick Pick. */
  private async resolveHostAccessBindingArgument(
    argument: unknown,
    title: string,
  ): Promise<HostAccessBinding | undefined> {
    const binding = getHostAccessBindingFromCommandArgument(argument);

    if (binding !== undefined) {
      return this.dependencies.networkService.getHostAccessBinding(binding.id);
    }

    const bindings = this.dependencies.networkService.getSnapshot().hostAccessBindings;
    if (bindings.length === 0) {
      await vscode.window.showInformationMessage("No host access bindings exist.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      bindings.map((item) => ({
        label: `${item.logicalPort} -> ${item.hostAddress}:${item.hostPort}`,
        description: item.status,
        binding: item,
      })),
      { title, placeHolder: "Select a host access binding" },
    );

    return selected?.binding;
  }

  /** Resolves a compose attachment from tree context or Quick Pick. */
  private async resolveComposeAttachmentArgument(
    argument: unknown,
    title: string,
  ): Promise<ComposeAttachment | undefined> {
    const attachment = getComposeAttachmentFromCommandArgument(argument);

    if (attachment !== undefined) {
      return this.dependencies.networkService.getComposeAttachment(attachment.id);
    }

    const snapshot = this.dependencies.networkService.getSnapshot();
    if (snapshot.composeAttachments.length === 0) {
      await vscode.window.showInformationMessage("No compose attachments exist.");
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      snapshot.composeAttachments.map((item) => {
        const network = snapshot.networks.find((candidate) => candidate.id === item.networkId);
        return {
          label: item.projectName,
          description: `${network?.name ?? item.networkId} ${item.status}`,
          detail: item.ports.map(formatComposePublishedPort).join(", "),
          attachment: item,
        };
      }),
      { title, placeHolder: "Select a compose attachment" },
    );

    return selected?.attachment;
  }

  /** Resolves a copy source, optionally excluding the destination network to avoid no-op conflicts. */
  private async resolveComposeAttachmentForCopy(
    argument: unknown,
    targetNetwork: LogicalNetwork | undefined,
    title: string,
  ): Promise<ComposeAttachment | undefined> {
    const attachment = getComposeAttachmentFromCommandArgument(argument);

    if (attachment !== undefined) {
      return this.dependencies.networkService.getComposeAttachment(attachment.id);
    }

    const snapshot = this.dependencies.networkService.getSnapshot();
    const attachments = snapshot.composeAttachments.filter(
      (item) => item.status === "attached" && item.networkId !== targetNetwork?.id,
    );
    if (attachments.length === 0) {
      await vscode.window.showInformationMessage(
        targetNetwork === undefined
          ? "No attached compose routes exist."
          : `No compose attachments can be copied into "${targetNetwork.name}".`,
      );
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      attachments.map((item) => {
        const network = snapshot.networks.find((candidate) => candidate.id === item.networkId);
        return {
          label: formatComposeAttachmentName(item),
          description: `${network?.name ?? item.networkId}, ${item.status}`,
          detail: item.ports.map(formatComposePublishedPort).join(", "),
          attachment: item,
        };
      }),
      { title, placeHolder: "Select a compose attachment to copy" },
    );

    return selected?.attachment;
  }

  /** Chooses a destination network that does not already own the source attachment. */
  private async resolveComposeCopyTargetNetwork(
    attachment: ComposeAttachment,
    title: string,
  ): Promise<LogicalNetwork | undefined> {
    const snapshot = this.dependencies.networkService.getSnapshot();
    const networks = snapshot.networks.filter((network) => network.id !== attachment.networkId);
    if (networks.length === 0) {
      await vscode.window.showInformationMessage(
        `Create another logical network before copying "${formatComposeAttachmentName(attachment)}".`,
      );
      return undefined;
    }

    if (networks.length === 1) {
      return networks[0];
    }

    const selected = await vscode.window.showQuickPick(
      networks.map((network) => ({
        label: network.name,
        description: network.runtimeKind,
        detail: network.id,
        network,
      })),
      { title, placeHolder: "Select the destination logical network" },
    );

    return selected?.network;
  }

  /** Registers one command and wraps thrown errors in a user-visible message. */
  private registerCommand(
    context: vscode.ExtensionContext,
    command: string,
    handler: (...args: unknown[]) => Promise<void> | void,
  ): void {
    const disposable = vscode.commands.registerCommand(command, async (...args: unknown[]) => {
      try {
        await handler(...args);
      } catch (error) {
        await showCommandError(error);
      }
    });

    context.subscriptions.push(disposable);
    this.disposables.push(disposable);
  }

  /** Registers machine-facing commands that return values to other extensions. */
  private registerApiCommand<T>(
    context: vscode.ExtensionContext,
    command: string,
    handler: (...args: unknown[]) => Promise<T> | T,
  ): void {
    const disposable = vscode.commands.registerCommand(command, (...args: unknown[]) => handler(...args));

    context.subscriptions.push(disposable);
    this.disposables.push(disposable);
  }
}

/**
 * Asks for a valid TCP port and converts cancellation into undefined.
 * The prompt accepts custom ports in addition to settings-driven suggestions.
 */
async function promptForPort(prompt: string, defaultPort: number): Promise<number | undefined> {
  return promptForInteger(prompt, defaultPort, "TCP port between 1 and 65535", isValidPort);
}

/**
 * Generic integer prompt used by PID and port flows. Validation stays here so
 * command methods can read as product workflows rather than parsing logic.
 */
async function promptForInteger(
  prompt: string,
  defaultValue: number | undefined,
  placeHolder: string,
  validate: (value: number) => boolean = (value) => Number.isInteger(value) && value > 0,
): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    title: prompt,
    prompt,
    value: defaultValue === undefined ? undefined : String(defaultValue),
    placeHolder,
    ignoreFocusOut: true,
    validateInput: (rawValue) => {
      const parsed = Number.parseInt(rawValue, 10);
      return validate(parsed) ? undefined : `Invalid value: ${rawValue}`;
    },
  });

  if (value === undefined) {
    return undefined;
  }

  return Number.parseInt(value, 10);
}

/**
 * Lets users choose how the actual port reaches their app. The mode maps
 * directly onto NodeProcessLauncher injection behavior.
 */
async function promptForInjectionMode(): Promise<PortInjectionMode | undefined> {
  const injectionItems: Array<vscode.QuickPickItem & { mode: PortInjectionMode }> = [
    {
      label: "Environment variable",
      description: "PORT=<actual port>",
      mode: "env",
    },
    {
      label: "Template replacement",
      description: "Replace ${port} in the command",
      mode: "template",
    },
    {
      label: "CLI argument",
      description: "Append --port <actual port>",
      mode: "argument",
    },
  ];

  const selected = await vscode.window.showQuickPick(
    injectionItems,
    {
      title: "Port Injection",
      placeHolder: "How should Port Manager pass the routed port?",
    },
  );

  return selected?.mode;
}

/** Builds a concise label for compose services while preserving raw container names. */
function formatContainerServiceLabel(candidate: ContainerServiceCandidate): string {
  if (candidate.composeProject !== undefined && candidate.composeService !== undefined) {
    return `${candidate.composeProject}/${candidate.composeService}`;
  }

  if (candidate.composeProject !== undefined) {
    return candidate.composeProject;
  }

  return candidate.containerName;
}

function formatContainerServiceCandidateDescription(candidate: ContainerServiceCandidate): string {
  const details = [
    candidate.runtime,
    `${candidate.ports.length} port${candidate.ports.length === 1 ? "" : "s"}`,
    formatComposeWorkingDirectory(candidate),
  ].filter((item): item is string => item !== undefined && item.length > 0);

  return details.join(", ");
}

function formatContainerServiceCandidateDetail(candidate: ContainerServiceCandidate): string {
  const details = [
    candidate.ports.map(formatComposePublishedPort).join(", "),
    formatComposeFilesDetail(composeCandidateSourceFiles(candidate)),
  ].filter((item): item is string => item !== undefined && item.length > 0);

  return details.join(" | ");
}

function formatComposeAttachContextDetail(candidate: ContainerServiceCandidate): string | undefined {
  const details = [
    formatComposeWorkingDirectory(candidate),
    formatComposeFilesDetail(composeCandidateSourceFiles(candidate)),
  ].filter((item): item is string => item !== undefined && item.length > 0);

  return details.length === 0 ? undefined : details.join(" | ");
}

function joinQuickPickDetails(details: readonly (string | undefined)[]): string {
  return details.filter((item): item is string => item !== undefined && item.length > 0).join(" ");
}

function formatComposeWorkingDirectory(candidate: ContainerServiceCandidate): string | undefined {
  const workingDirectory = resolveComposeWorkingDirectory(candidate.composeWorkingDirectory, composeCandidateSourceFiles(candidate));
  return workingDirectory === undefined ? undefined : `cwd ${workingDirectory}`;
}

function composeCandidateSourceFiles(candidate: ContainerServiceCandidate): readonly string[] | undefined {
  return candidate.portManagerClone?.composeFiles ?? candidate.composeConfigFiles;
}

function formatComposeFilesDetail(composeFiles: readonly string[] | undefined): string | undefined {
  const files = composeFiles?.filter((file) => file.trim().length > 0);
  return files === undefined || files.length === 0 ? undefined : `compose ${files.join(", ")}`;
}

function resolveLatestContainerServiceCandidate(
  candidates: readonly ContainerServiceCandidate[],
  candidate: ContainerServiceCandidate,
): ContainerServiceCandidate | undefined {
  const directCandidate = candidates.find((item) => item.id === candidate.id);
  if (directCandidate !== undefined) {
    return directCandidate;
  }

  if (!candidate.id.startsWith("compose-project:") || candidate.composeProject === undefined) {
    return undefined;
  }

  const group = candidates.filter(
    (item) =>
      item.runtime === candidate.runtime &&
      item.composeProject === candidate.composeProject &&
      sameComposeContext(item, candidate),
  );
  if (group.length === 0) {
    return undefined;
  }

  const portManagerClone = mergePortManagerCloneMetadata(group);

  return {
    id: candidate.id,
    runtime: candidate.runtime,
    containerId: candidate.composeProject,
    containerName: candidate.composeProject,
    composeProject: candidate.composeProject,
    ...(group[0]?.composeWorkingDirectory !== undefined
      ? { composeWorkingDirectory: group[0].composeWorkingDirectory }
      : {}),
    ...(group.flatMap((item) => [...(item.composeConfigFiles ?? [])]).length > 0
      ? { composeConfigFiles: uniqueStrings(group.flatMap((item) => [...(item.composeConfigFiles ?? [])])) }
      : {}),
    ...(portManagerClone !== undefined ? { portManagerClone } : {}),
    ports: group.flatMap((item) => [...item.ports]),
  };
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

function sameComposeContext(candidate: ContainerServiceCandidate, reference: ContainerServiceCandidate): boolean {
  const referenceFiles = reference.composeConfigFiles ?? [];
  const candidateFiles = candidate.composeConfigFiles ?? [];

  if (
    reference.composeWorkingDirectory !== undefined &&
    candidate.composeWorkingDirectory !== reference.composeWorkingDirectory
  ) {
    return false;
  }

  if (referenceFiles.length === 0) {
    return true;
  }

  return referenceFiles.length === candidateFiles.length && referenceFiles.every((file, index) => candidateFiles[index] === file);
}

type ComposeAttachMode = "clone" | "clone-custom" | "as-is";

async function promptForComposeAttachMode(
  candidate: ContainerServiceCandidate,
): Promise<ComposeAttachMode | undefined> {
  const contextDetail = formatComposeAttachContextDetail(candidate);
  const asIsItem =
    candidate.portManagerClone === undefined
      ? {
          label: "Attach as-is",
          description: "Register the current published ports without restarting Compose",
          detail: joinQuickPickDetails([
            "Keeps the original containers exactly as they are and only adds logical-network route rows.",
            contextDetail,
          ]),
          mode: "as-is" as const,
        }
      : {
          label: "Reattach existing clone",
          description: "Reuse the running Port Manager clone and its generated override",
          detail: joinQuickPickDetails([
            "Keeps the clone containers running and restores logical-network route rows.",
            contextDetail,
          ]),
          mode: "as-is" as const,
        };
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Clone and hide host ports",
        description: "Recreate services under a network-scoped Compose project",
        detail: joinQuickPickDetails([
          "Frees original host ports so the original Compose project can be started again.",
          contextDetail,
        ]),
        mode: "clone" as const,
      },
      {
        label: "Clone with custom Compose name",
        description: "Choose the hidden Compose project name before recreating services",
        detail: joinQuickPickDetails([
          "Use this when copying an existing clone or when the generated project name would collide.",
          contextDetail,
        ]),
        mode: "clone-custom" as const,
      },
      asIsItem,
    ],
    {
      title: "Attach Compose to Network",
      placeHolder: `Choose how to attach ${formatContainerServiceLabel(candidate)}`,
    },
  );

  return selected?.mode;
}

function isComposeCloneAttachMode(mode: ComposeAttachMode): boolean {
  return mode === "clone" || mode === "clone-custom";
}

async function promptForComposeProjectName(
  title: string,
  value?: string,
): Promise<string | undefined> {
  const projectName = await vscode.window.showInputBox({
    title,
    prompt: "Compose project name (-p)",
    value,
    placeHolder: "my-copy",
    ignoreFocusOut: true,
    validateInput: (rawValue) =>
      isValidComposeProjectName(rawValue)
        ? undefined
        : "Use 1-120 lowercase letters, digits, dashes, or underscores; start with a letter or digit.",
  });

  return projectName === undefined ? undefined : projectName.trim();
}

async function confirmStatefulComposeClone(
  candidate: ContainerServiceCandidate,
): Promise<boolean | undefined> {
  const statefulServices = inferStatefulComposeServices(candidate);
  if (statefulServices.length === 0) {
    return true;
  }

  const selected = await vscode.window.showWarningMessage(
    `Clone will stop the original service and copy Docker volumes for stateful service${statefulServices.length === 1 ? "" : "s"}: ${statefulServices.join(", ")}. Continue only if the database can tolerate a point-in-time clone.`,
    { modal: true },
    "Clone anyway",
  );

  return selected === "Clone anyway" ? true : undefined;
}

function inferStatefulComposeServices(candidate: ContainerServiceCandidate): readonly string[] {
  const services = new Set<string>();

  for (const port of candidate.ports) {
    const serviceName = port.serviceName.toLowerCase().replace(/[-_]+/g, " ");
    const protocolName = port.protocolName?.toLowerCase();
    const statefulProtocol =
      protocolName !== undefined &&
      ["postgresql", "postgres", "mysql", "mariadb", "redis", "rabbitmq", "mongodb", "mongo"].includes(
        protocolName,
      );
    const statefulPort = [5432, 3306, 33060, 6379, 5672, 15672, 27017, 9200, 9300, 50051].includes(
      port.containerPort,
    );

    if (
      statefulProtocol ||
      statefulPort ||
      /\b(db|database|postgres|postgresql|mysql|mariadb|redis|rabbitmq|mongo|mongodb|weaviate|elastic|opensearch)\b/.test(
        serviceName,
      )
    ) {
      services.add(port.serviceName);
    }
  }

  return [...services].sort();
}

/** Lets users choose a runtime adapter when more than one is available. */
async function promptForRuntimeKind(
  runtimes: readonly NetworkRuntimeDescriptor[],
): Promise<NetworkRuntimeKind | undefined> {
  const containerLevelRuntimes = runtimes.filter(isContainerLevelRuntime);

  if (containerLevelRuntimes.length === 0) {
    await vscode.window.showErrorMessage(
      buildNoLogicalRuntimeMessage(),
    );
    return undefined;
  }

  if (containerLevelRuntimes.length === 1) {
    return containerLevelRuntimes[0].kind;
  }

  const selected = await vscode.window.showQuickPick(
    containerLevelRuntimes.map((runtime) => ({
      label: runtime.kind === "container" ? `Linux namespace: ${runtime.name}` : `Borrowed network: ${runtime.name}`,
      description: runtime.kind,
      detail: describeRuntimeChoice(runtime),
      runtime,
    })),
    {
      title: "Network Runtime",
      placeHolder: "Select a runtime adapter",
    },
  );

  return selected?.runtime.kind;
}

/** Logical network creation is limited to runtimes that can isolate terminal sockets. */
function isContainerLevelRuntime(runtime: NetworkRuntimeDescriptor): boolean {
  return runtime.capabilities.supportsSameInternalPorts && runtime.capabilities.supportsTerminalAttach;
}

/** Explains the runtime choice in the create-network Quick Pick. */
function describeRuntimeChoice(runtime: NetworkRuntimeDescriptor): string {
  if (runtime.kind === "container") {
    return "Linux only: uses one global bridge and a per-network holder, then attaches terminals with only the network namespace changed.";
  }

  if (runtime.kind === "nativeHelper") {
    return "macOS/Linux: the selected terminal borrows a logical network through the native socket hook.";
  }

  return [
    runtime.capabilities.supportsSameInternalPorts ? "same internal ports" : "no same-port isolation",
    runtime.capabilities.supportsTerminalAttach ? "terminal attach" : "no terminal attach",
    runtime.capabilities.supportsHostExposure ? "host exposure" : "no host exposure",
  ].join(", ");
}

/** Gives platform-specific guidance when no attach-capable logical network runtime exists. */
function buildNoLogicalRuntimeMessage(): string {
  if (process.platform === "darwin") {
    return "No borrowed network runtime is available. On macOS, build/enable the native socket hook; Docker/Podman namespace attach is Linux-only.";
  }

  return "No logical network runtime is available. Enable the native socket hook or install a Linux namespace runtime; Local TCP Proxy is only for host exposure.";
}

/** Uses workspace folder name as the default process label when possible. */
function deriveProcessName(command: string, cwd: string): string {
  const folderName = path.basename(cwd);
  return folderName.length > 0 ? folderName : command;
}

/** A routed URL is only actionable while the target process is currently running. */
function isReachableProcess(process: ManagedProcess | undefined): process is ManagedProcess & { url: string } {
  return process !== undefined && process.status === "running" && typeof process.url === "string";
}

/** Returns the first workspace folder path because MVP commands are workspace-scoped. */
function getDefaultWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Opens an HTTP URL through VS Code's external URI bridge. */
async function openUrl(url: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Builds the URL users open from a host exposure row. */
function formatExposureUrl(exposure: HostPortExposure): string {
  const host =
    exposure.hostAddress === "0.0.0.0" || exposure.hostAddress === "::" ? "localhost" : exposure.hostAddress;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  return `http://${formattedHost}:${exposure.hostPort}`;
}

/** Gives named protocol ports useful defaults without constraining custom values. */
function inferProtocolName(port: number): string {
  switch (port) {
    case 15432:
    case 5432:
      return "postgresql";
    case 13306:
    case 3306:
      return "mysql";
    case 16379:
    case 6379:
      return "redis";
    case 15672:
      return "rabbitmq";
    default:
      return "";
  }
}

/** Formats one compose endpoint for Quick Pick details and notifications. */
function formatComposePublishedPort(port: {
  readonly logicalPort: number;
  readonly actualHostAddress: string;
  readonly actualHostPort: number;
  readonly containerPort: number;
}): string {
  const transport = port.actualHostPort === port.logicalPort ? "" : ` via ${port.actualHostAddress}:${port.actualHostPort}`;
  return `${port.logicalPort}:${port.containerPort}${transport}`;
}

function formatComposeAttachmentName(attachment: ComposeAttachment): string {
  return attachment.mutation?.attachedProjectName ?? attachment.projectName;
}

interface AttachTerminalCommandInput {
  readonly terminalWindow: TerminalWindow;
  readonly network: LogicalNetwork;
}

interface AttachProcessCommandInput {
  readonly network?: LogicalNetwork;
  readonly pid?: number;
  readonly port?: number;
  readonly title?: string;
}

interface ProcessAttachTarget {
  readonly pid: number;
  readonly title: string;
}

interface AttachContainerCommandInput {
  readonly containerService?: ContainerServiceCandidate;
  readonly network?: LogicalNetwork;
  readonly composeAttachMode?: ComposeAttachMode;
  readonly attachedProjectName?: string;
}

function isActiveVscodeTerminalWindow(
  terminalWindow: TerminalWindow,
  terminal: vscode.Terminal,
  processId: number | undefined,
): boolean {
  if (
    processId !== undefined &&
    (terminalWindow.rootPid === processId ||
      terminalWindow.processGroupId === processId ||
      terminalWindow.candidatePids.includes(processId) ||
      terminalWindow.id === `vscode:${processId}`)
  ) {
    return true;
  }

  return terminalWindow.source === "vscode" && terminalWindow.title === terminal.name;
}

function isTerminalWindowForAttachment(terminalWindow: TerminalWindow, attachment: TerminalAttachment): boolean {
  if (attachment.terminalWindowId !== undefined && terminalWindow.id === attachment.terminalWindowId) {
    return true;
  }

  if (terminalWindow.rootPid === attachment.rootPid || terminalWindow.candidatePids.includes(attachment.rootPid)) {
    return true;
  }

  return attachment.processGroupId !== undefined && terminalWindow.processGroupId === attachment.processGroupId;
}

function getAttachTerminalInput(argument: unknown): AttachTerminalCommandInput | undefined {
  if (typeof argument !== "object" || argument === null) {
    return undefined;
  }

  const candidate = argument as Partial<AttachTerminalCommandInput>;
  if (!isTerminalWindowLike(candidate.terminalWindow) || !isLogicalNetworkLike(candidate.network)) {
    return undefined;
  }

  return {
    terminalWindow: candidate.terminalWindow,
    network: candidate.network,
  };
}

function getAttachProcessInput(argument: unknown): AttachProcessCommandInput | undefined {
  if (typeof argument !== "object" || argument === null) {
    return undefined;
  }

  const candidate = argument as {
    readonly network?: unknown;
    readonly pid?: unknown;
    readonly port?: unknown;
    readonly title?: unknown;
  };
  const pid = typeof candidate.pid === "number" && Number.isInteger(candidate.pid) ? candidate.pid : undefined;
  const port = typeof candidate.port === "number" && Number.isInteger(candidate.port) ? candidate.port : undefined;
  const title = typeof candidate.title === "string" && candidate.title.trim().length > 0 ? candidate.title.trim() : undefined;
  const network = isLogicalNetworkLike(candidate.network) ? candidate.network : undefined;

  if (pid === undefined && port === undefined && title === undefined && network === undefined) {
    return undefined;
  }

  return {
    ...(network !== undefined ? { network } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

function buildProcessAttachTargetFromPid(
  pid: number,
  listeners: readonly (ListeningPort & { readonly pid: number })[],
): ProcessAttachTarget {
  const listener = listeners.find((item) => item.pid === pid);
  return listener === undefined ? { pid, title: `Process ${pid}` } : buildProcessAttachTargetFromListener(listener);
}

function buildProcessAttachTargetFromPort(
  port: number,
  listeners: readonly (ListeningPort & { readonly pid: number })[],
): ProcessAttachTarget | undefined {
  const listener = listeners.find((item) => item.port === port);
  return listener === undefined ? undefined : buildProcessAttachTargetFromListener(listener);
}

function buildProcessAttachTargetFromListener(listener: ListeningPort & { readonly pid: number }): ProcessAttachTarget {
  return {
    pid: listener.pid,
    title: `${listener.processName ?? "Process"} ${listener.pid} (${listener.localAddress}:${listener.port})`,
  };
}

function dedupeListeningPortsByPidAndPort(
  listeners: readonly (ListeningPort & { readonly pid: number })[],
): readonly (ListeningPort & { readonly pid: number })[] {
  const seen = new Set<string>();
  const deduped: Array<ListeningPort & { readonly pid: number }> = [];

  for (const listener of listeners) {
    const key = `${listener.pid}:${listener.port}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(listener);
  }

  return deduped;
}

function parsePositiveIntegerText(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

interface NetworkApiInput {
  readonly networkId?: string;
  readonly networkName?: string;
}

/** Accepts compact command input from external extensions without importing Port Manager types. */
function parseNetworkApiInput(argument: unknown): NetworkApiInput {
  if (typeof argument !== "object" || argument === null) {
    return {};
  }

  const candidate = argument as {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly networkId?: unknown;
    readonly networkName?: unknown;
  };
  const networkId =
    typeof candidate.networkId === "string"
      ? candidate.networkId
      : typeof candidate.id === "string"
        ? candidate.id
        : undefined;
  const networkName =
    typeof candidate.networkName === "string"
      ? candidate.networkName
      : typeof candidate.name === "string"
        ? candidate.name
        : undefined;

  return {
    ...(networkId !== undefined ? { networkId } : {}),
    ...(networkName !== undefined ? { networkName } : {}),
  };
}

function getAttachContainerInput(argument: unknown): AttachContainerCommandInput | undefined {
  if (typeof argument !== "object" || argument === null) {
    return undefined;
  }

  const candidate = argument as Partial<AttachContainerCommandInput>;
  if (candidate.containerService === undefined && candidate.network === undefined) {
    return undefined;
  }

  return {
    containerService: candidate.containerService,
    network: candidate.network,
    composeAttachMode: candidate.composeAttachMode,
    attachedProjectName: candidate.attachedProjectName,
  };
}

function isTerminalWindowLike(value: unknown): value is TerminalWindow {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<TerminalWindow>;
  return typeof candidate.id === "string" && typeof candidate.title === "string" && typeof candidate.rootPid === "number";
}

function isLogicalNetworkLike(value: unknown): value is LogicalNetwork {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<LogicalNetwork>;
  return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.runtimeKind === "string";
}

/** Validates the user-facing TCP port range. */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Returns the platform-specific directory used for the external CLI shim. */
function getExternalCliInstallDirectory(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "bin");
  }

  return path.join(os.homedir(), ".local", "bin");
}

/** Returns the executable shim path installed by the command palette action. */
function getExternalCliShimPath(installDirectory: string): string {
  return path.join(installDirectory, process.platform === "win32" ? "portmanager.cmd" : "portmanager");
}

/**
 * Builds a tiny shell wrapper that runs the compiled CLI in Node mode.
 * `process.execPath` may point at VS Code's Electron binary, so the shim must
 * force Node behavior instead of letting Electron open another editor window.
 */
function buildExternalCliShim(cliPath: string, nodeExecutablePath: string): string {
  if (process.platform === "win32") {
    return `@echo off\r\nset "${ELECTRON_RUN_AS_NODE}=1"\r\n"${nodeExecutablePath}" "${cliPath}" %*\r\n`;
  }

  return `#!/bin/sh\n${ELECTRON_RUN_AS_NODE}=1 exec "${shellDoubleQuote(nodeExecutablePath)}" "${shellDoubleQuote(cliPath)}" "$@"\n`;
}

/** Builds a shell command users can paste if the shim directory is not on PATH. */
function buildPathHint(installDirectory: string): string | undefined {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  if (pathEntries.includes(installDirectory)) {
    return undefined;
  }

  if (process.platform === "win32") {
    return `setx PATH "%PATH%;${installDirectory}"`;
  }

  return `export PATH="${installDirectory}:$PATH"`;
}

/** Returns the packaged native hook library for the current OS. */
function getHookLibraryRelativePath(): string {
  if (process.platform === "darwin") {
    return path.join("media", "native", "libportmanager_hook.dylib");
  }

  if (process.platform === "linux") {
    return path.join("media", "native", "libportmanager_hook.so");
  }

  throw new Error("Native shell hook is currently supported on macOS and Linux.");
}

/** Returns the packaged asdf shim launcher for macOS shell hook installs. */
function getAsdfShimLauncherRelativePath(): string {
  return path.join("media", "native", "portmanager_asdf_shim");
}

/** Returns the packaged native Docker/Podman PATH shim. */
function getRuntimeCommandShimRelativePath(): string {
  return path.join("media", "native", "portmanager_docker_shim");
}

/**
 * Chooses startup files for the current POSIX shell. Updating both login and
 * interactive profiles makes new OS terminals inherit the native hook env.
 */
function getShellProfilePaths(): readonly string[] {
  const shellName = path.basename(process.env.SHELL ?? "");

  if (shellName === "zsh") {
    return uniquePaths([path.join(os.homedir(), ".zprofile"), path.join(os.homedir(), ".zshrc")]);
  }

  if (shellName === "bash") {
    return uniquePaths([path.join(os.homedir(), ".bash_profile"), path.join(os.homedir(), ".bashrc")]);
  }

  if (shellName === "sh") {
    return [path.join(os.homedir(), ".profile")];
  }

  return [];
}

/** Removes duplicate profile paths while preserving the intended source order. */
function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

interface ShellHookScriptOptions {
  /** Native hook library packaged with this extension. */
  readonly hookLibraryPath: string;
  /** Agent entrypoint used when no daemon socket exists yet. */
  readonly agentMainPath: string;
  /** Native daemon executable used before falling back to the Node entrypoint. */
  readonly nativeAgentPath: string;
  /** Native helper used by shell fallback wrappers for container token mapping. */
  readonly nativeContainerMapPath: string;
  /** Native Docker/Podman shim used by the preload hook for hardcoded runtime paths. */
  readonly dockerShimPath: string;
  /** Node or Electron executable used to run compiled extension JS in Node mode. */
  readonly nodeExecutablePath: string;
  /** Singleton agent socket path shared with VS Code windows. */
  readonly socketPath: string;
  /** Dynamic route-table JSON file written by the daemon. */
  readonly routeTablePath: string;
  /** Network-to-host binding JSON file written by the extension. */
  readonly hostAccessFilePath: string;
  /** TSV file mapping logical networks to generated attach scripts for `pm`. */
  readonly terminalNetworkSelectionFilePath: string;
  /** Routing settings mirrored into native hook environment variables. */
  readonly settings: PortManagerSettings;
  /** Optional PATH directory that restores DYLD after protected runtime launch boundaries. */
  readonly runtimeShimDirectory?: string;
  /** Optional BASH_ENV fragment that restores DYLD after protected shebang boundaries. */
  readonly shellEnvRestorePath?: string;
}

interface ShellHookAssets {
  /** Generated hook script that profile files source. */
  readonly hookScriptPath: string;
  /** One-line profile entry users can add when automatic profile mutation is not desired. */
  readonly sourceLine: string;
  /** Candidate shell startup files for the current user shell. */
  readonly shellProfilePaths: readonly string[];
}

interface StatusMenuSummary {
  /** Compact summary shown in the Quick Pick placeholder and current row. */
  readonly label: string;
  /** Expanded routing source explanation for the current row. */
  readonly detail: string;
  /** Detach row copy changes based on the active routing source. */
  readonly detachDescription: string;
}

/** Builds the menu summary from VS Code window binding first, then terminal attachments. */
function formatStatusMenuSummary(snapshot: NetworkSnapshot): StatusMenuSummary {
  const windowNetwork = snapshot.networks.find(
    (network) => network.id === snapshot.vscodeWindowTerminalBinding?.networkId,
  );
  if (windowNetwork !== undefined) {
    return {
      label: `VS Code terminals use ${windowNetwork.name}`,
      detail: `${snapshot.vscodeWindowTerminalBinding?.injectedTerminalCount ?? 0} open terminal${snapshot.vscodeWindowTerminalBinding?.injectedTerminalCount === 1 ? "" : "s"} updated when this binding was applied.`,
      detachDescription: "Clear the VS Code terminal default",
    };
  }

  const attachedTerminals = snapshot.attachments.filter((attachment) => attachment.status === "attached");
  if (attachedTerminals.length === 0) {
    return {
      label: "No current network",
      detail: "Choose Switch VS Code Terminal Network to route new terminals.",
      detachDescription: "No active VS Code default; choose an attached terminal if one exists",
    };
  }

  const networkNames = formatAttachedNetworkNames(snapshot, attachedTerminals);
  return {
    label: `${attachedTerminals.length} attached terminal${attachedTerminals.length === 1 ? "" : "s"}`,
    detail: networkNames.join(", "),
    detachDescription: "Choose an attached terminal to detach",
  };
}

function formatAttachedNetworkNames(
  snapshot: NetworkSnapshot,
  attachments: readonly TerminalAttachment[],
): string[] {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    counts.set(attachment.networkId, (counts.get(attachment.networkId) ?? 0) + 1);
  }

  return [...counts.entries()].map(([networkId, count]) => {
    const network = snapshot.networks.find((item) => item.id === networkId);
    return `${network?.name ?? networkId} (${count})`;
  });
}

/** Builds the POSIX shell snippet that injects the native socket hook. */
function buildShellHookScript(options: ShellHookScriptOptions): string {
  const escapedHookLibraryPath = shellDoubleQuote(options.hookLibraryPath);
  const escapedAgentMainPath = shellDoubleQuote(options.agentMainPath);
  const escapedNativeAgentPath = shellDoubleQuote(options.nativeAgentPath);
  const escapedNativeContainerMapPath = shellDoubleQuote(options.nativeContainerMapPath);
  const escapedDockerShimPath = shellDoubleQuote(options.dockerShimPath);
  const escapedNodeExecutablePath = shellDoubleQuote(options.nodeExecutablePath);
  const escapedSocketPath = shellDoubleQuote(options.socketPath);
  const escapedRouteTablePath = shellDoubleQuote(options.routeTablePath);
  const escapedHostAccessFilePath = shellDoubleQuote(options.hostAccessFilePath);
  const escapedTerminalNetworkSelectionFilePath = shellDoubleQuote(options.terminalNetworkSelectionFilePath);
  const escapedRuntimeShimDirectory =
    options.runtimeShimDirectory !== undefined ? shellDoubleQuote(options.runtimeShimDirectory) : undefined;
  const escapedShellEnvRestorePath =
    options.shellEnvRestorePath !== undefined ? shellDoubleQuote(options.shellEnvRestorePath) : undefined;
  const nodeRuntimePrefix = `${ELECTRON_RUN_AS_NODE}=1`;
  const daemonRuntimePrefix = `PORT_MANAGER_HOOK_DISABLED=1 PORT_MANAGER_HOOK=0 DYLD_INSERT_LIBRARIES= LD_PRELOAD= ${nodeRuntimePrefix}`;
  const routeCountScript = [
    'const fs=require("node:fs");',
    'const file=process.argv[1]||"";',
    'try{const value=JSON.parse(fs.readFileSync(file,"utf8"));const routes=Array.isArray(value&&value.routes)?value.routes:[];console.log(routes.length);}catch{console.log("?");}',
  ].join("");
  const routePrintScript = [
    'const fs=require("node:fs");',
    'const routeFile=process.argv[1]||"";',
    'const hostAccessFile=process.argv[2]||"";',
    'const networkId=process.argv[3]||"";',
    'const networkName=process.argv[4]||"";',
    'function readJson(file){if(!file)return undefined;try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return undefined;}}',
    'function text(value){return value===undefined||value===null||value===""?"-":String(value);}',
    'const routeTable=readJson(routeFile);',
    'const routes=Array.isArray(routeTable&&routeTable.routes)?routeTable.routes:[];',
    'const matchingRoutes=networkId?routes.filter((route)=>!route.networkId||route.networkId===networkId):routes;',
    'const title=networkId?(networkName?networkName+" ["+networkId+"]":networkId):"all networks";',
    'console.log("Port Manager routes: "+title);',
    'if(matchingRoutes.length===0){console.log("  no routes");}else{for(const route of matchingRoutes){const network=route.networkId?" ["+route.networkId+"]":"";const label=route.processName?" "+route.processName:"";console.log("  "+text(route.host)+":"+text(route.logicalPort)+" -> "+text(route.actualPort)+" "+text(route.status)+" "+text(route.source)+network+label);}}',
    'const hostAccess=readJson(hostAccessFile);',
    'const bindings=Array.isArray(hostAccess&&hostAccess.bindings)?hostAccess.bindings:[];',
    'const matchingBindings=networkId?bindings.filter((binding)=>binding.networkId===networkId):bindings;',
    'if(hostAccessFile&&fs.existsSync(hostAccessFile)){console.log("Host access: "+matchingBindings.length);for(const binding of matchingBindings){console.log("  "+text(binding.logicalPort)+" -> "+text(binding.hostAddress)+":"+text(binding.hostPort)+" "+text(binding.status)+" ["+text(binding.networkId)+"]");}}',
  ].join("");
  const doctorRoutingScript = [
    'const fs=require("node:fs");',
    'const cp=require("node:child_process");',
    'const path=require("node:path");',
    'const currentNetwork=process.argv[1]||"";',
    'const currentCwd=process.argv[2]||process.cwd();',
    'const routeFile=process.argv[3]||"";',
    'const routingMode=process.argv[4]||"";',
    'const loopbackHost=process.argv[5]||"";',
    'function readJson(file){if(!file)return undefined;try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return undefined;}}',
    'function text(value){return value===undefined||value===null||value===""?"-":String(value);}',
    'function envValue(line,name){const match=line.match(new RegExp("(?:^|\\\\s)"+name+"=([^\\\\s]*)"));return match?match[1]:"";}',
    'function normalize(value){if(!value)return "";try{return fs.realpathSync.native(value);}catch{return path.resolve(value);}}',
    'function isSubPath(parent,child){if(!parent||!child)return false;const relative=path.relative(parent,child);return relative===""||(!relative.startsWith("..")&&!path.isAbsolute(relative));}',
    'function pathsRelated(a,b){return isSubPath(a,b)||isSubPath(b,a);}',
    'function cleanCommand(command){return String(command||"").replace(/\\s[A-Za-z_][A-Za-z0-9_]*=[^\\s]*/g,"").replace(/\\s+/g," ").trim().slice(0,140);}',
    'function hostKey(value){const host=String(value||"").toLowerCase();return host==="localhost"?"127.0.0.1":host;}',
    'function portFromLine(line){for(const name of ["PORT","VITE_CLIENT_PORT","VITE_PORT","DJANGO_PORT"]){const value=Number(envValue(line,name));if(Number.isInteger(value)&&value>0)return value;}let match=line.match(/(?:--port|-p)\\s+(\\d{2,5})(?:\\s|$)/);if(match)return Number(match[1]);match=line.match(/runserver(?:\\s+[0-9A-Fa-f:.]+:)?(\\d{2,5})(?:\\s|$)/);if(match)return Number(match[1]);match=line.match(/(?:^|\\s)(\\d{2,5})(?:\\s|$)/);return match?Number(match[1]):undefined;}',
    'function serverLike(line){return /manage\\.py\\s+runserver|(?:^|[\\/\\s])vite(?:$|[\\s.-])|uvicorn|gunicorn|daphne|webpack-dev-server|next\\s+dev|nuxt\\s+dev|astro\\s+dev|remix\\s+dev|rails\\s+server|bin\\/rails\\s+s|docker\\s+compose/i.test(line);}',
    'const routeTable=readJson(routeFile);',
    'const allRoutes=Array.isArray(routeTable&&routeTable.routes)?routeTable.routes:[];',
    'const routes=currentNetwork?allRoutes.filter((route)=>!route.networkId||route.networkId===currentNetwork):allRoutes;',
    'const sourceCounts=new Map();',
    'for(const route of routes){const source=text(route.source);sourceCounts.set(source,(sourceCounts.get(source)||0)+1);}',
    'const sourceSummary=Array.from(sourceCounts.entries()).map(([source,count])=>source+"="+count).join(", ")||"none";',
    'console.log("Routing mode detail: "+text(routingMode)+" loopback="+text(loopbackHost));',
    'console.log("Route sources: "+sourceSummary+" (current network routes="+routes.length+")");',
    'const appRouteCount=routes.filter((route)=>["managed","registered","hooked","allocated"].includes(String(route.source||""))).length;',
    'if(currentNetwork&&routes.length>0&&appRouteCount===0){console.log("Route warning: current network has no app/server route rows.");}',
    'if(currentNetwork&&routes.length===0){console.log("Route warning: current network has no route rows.");}',
    'const routeLogicalPorts=new Set(routes.map((route)=>Number(route.logicalPort)).filter((port)=>Number.isInteger(port)));',
    'const routeEndpointKeys=new Set(routes.map((route)=>hostKey(route.host)+":"+Number(route.logicalPort)).filter((value)=>!/NaN$/.test(value)));',
    'const routeRoots=Array.from(new Set(routes.map((route)=>route.cwd).filter(Boolean).map(normalize)));',
    'let psOutput="";',
    'try{psOutput=cp.execFileSync("ps",["eww","-Ao","pid=,ppid=,pgid=,tty=,command="],{encoding:"utf8",stdio:["ignore","pipe","ignore"]});}catch{}',
    'const currentRoot=normalize(currentCwd);',
    'const suspicious=[];',
    'for(const rawLine of psOutput.split(/\\r?\\n/)){if(!serverLike(rawLine))continue;const row=rawLine.match(/^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+([\\s\\S]+)$/);if(!row)continue;const command=row[5];if(command.includes("PORT_MANAGER_DOCTOR_PROCESS_SCAN=1"))continue;const hookDisabled=envValue(command,"PORT_MANAGER_HOOK_DISABLED")==="1"||envValue(command,"PORT_MANAGER_HOOK")==="0";const network=envValue(command,"PORT_MANAGER_NETWORK_ID")||envValue(command,"PORT_MANAGER_ROUTE_TABLE_NETWORK_ID")||envValue(command,"PORT_MANAGER_BORROWED_NETWORK_ID")||envValue(command,"NEWDLOPS_PM_NETWORK_ID");const cwd=envValue(command,"PWD")||envValue(command,"INIT_CWD");const normalizedCwd=normalize(cwd);const related=!normalizedCwd||pathsRelated(currentRoot,normalizedCwd)||routeRoots.some((root)=>pathsRelated(root,normalizedCwd));const port=portFromLine(command);const processLoopback=envValue(command,"PORT_MANAGER_NETWORK_LOOPBACK_HOST")||loopbackHost||"127.0.0.1";const endpointKey=hostKey(processLoopback)+":"+Number(port);const portMissing=Number.isInteger(port)&&!routeLogicalPorts.has(Number(port))&&!routeEndpointKeys.has(endpointKey);const wrongNetwork=Boolean(currentNetwork&&network&&network!==currentNetwork);const missingNetwork=Boolean(currentNetwork&&!network);if(!hookDisabled&&!wrongNetwork&&!(missingNetwork&&related)&&!(portMissing&&related))continue;suspicious.push({pid:row[1],pgid:row[3],tty:row[4],hook:hookDisabled?"disabled":envValue(command,"PORT_MANAGER_HOOK")||"unset",network:network||"none",cwd:cwd||"-",port:Number.isInteger(port)?String(port):"-",reason:wrongNetwork?"other-network":hookDisabled?"hook-disabled":portMissing?"no-current-route":"no-network",command:cleanCommand(command)});if(suspicious.length>=12)break;}',
    'if(suspicious.length===0){console.log("Process routing check: no obvious mismatches");}else{console.log("Process routing check: "+suspicious.length+" suspicious server process"+(suspicious.length===1?"":"es"));for(const item of suspicious){console.log("  pid "+item.pid+" tty="+item.tty+" pgid="+item.pgid+" port="+item.port+" hook="+item.hook+" network="+item.network+" reason="+item.reason+" cwd="+item.cwd);if(item.command)console.log("    "+item.command);}}',
  ].join("");
  const networkPrintScript = [
    'const fs=require("node:fs");',
    'const file=process.argv[1]||"";',
    'const current=process.argv[2]||"";',
    'function text(value){return value===undefined||value===null?"":String(value);}',
    'let rows=[];',
    'try{rows=fs.readFileSync(file,"utf8").split(/\\r?\\n/).filter((line)=>line.length>0).map((line)=>line.split("\\t"));}catch{}',
    'rows.forEach((row,index)=>{if(row.length<3)return;const marker=row[0]===current?"*":" ";console.error(marker+" "+(index+1)+") "+text(row[1])+" ["+text(row[0])+"]");const summary=row[3]&&row[3].trim()?row[3]:"no services";summary.split(/\\s+\\|\\|\\s+/).filter((entry)=>entry.trim().length>0).forEach((entry)=>console.error("     "+entry.trim()));});',
  ].join("");
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
  const probeCommand = `${daemonRuntimePrefix} "${escapedNodeExecutablePath}" -e "${shellDoubleQuote(
    nodeProbeScript,
  )}" "$PORT_MANAGER_AGENT_SOCKET" "$PORT_MANAGER_AGENT_MAIN"`;

  return `# Port Manager shell hook
# This file is generated by the VS Code Port Manager extension.
if [ -n "\${PORT_MANAGER_NETWORK_ID:-}" ] || [ -n "\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID:-}" ] || [ -n "\${PORT_MANAGER_BORROWED_NETWORK_ID:-}" ] || [ -n "\${NEWDLOPS_PM_NETWORK_ID:-}" ] || [ -n "\${NEWDLOPS_PM_BORROWED_NETWORK_ID:-}" ]; then
  unset PORT_MANAGER_HOOK_DISABLED
  export PORT_MANAGER_HOOK=1
else
  export PORT_MANAGER_HOOK=0
  export PORT_MANAGER_HOOK_DISABLED=1
  export PORT_MANAGER_HOOK_DAEMON_STARTED=0
  unset PORT_MANAGER_DYLD_INSERT_LIBRARIES
  ${escapedShellEnvRestorePath !== undefined ? `if [ -n "\${PORT_MANAGER_PREV_BASH_ENV:-}" ] && [ "\${BASH_ENV:-}" = "${escapedShellEnvRestorePath}" ]; then export BASH_ENV="\${PORT_MANAGER_PREV_BASH_ENV}"; elif [ "\${BASH_ENV:-}" = "${escapedShellEnvRestorePath}" ]; then unset BASH_ENV; fi` : ""}
  unset PORT_MANAGER_PREV_BASH_ENV
  if [ "\${DYLD_INSERT_LIBRARIES:-}" = "${escapedHookLibraryPath}" ]; then unset DYLD_INSERT_LIBRARIES; else export DYLD_INSERT_LIBRARIES="\${DYLD_INSERT_LIBRARIES#${shellPatternLiteral(`${options.hookLibraryPath}:`)}}"; fi
  if [ "\${LD_PRELOAD:-}" = "${escapedHookLibraryPath}" ]; then unset LD_PRELOAD; else export LD_PRELOAD="\${LD_PRELOAD#${shellPatternLiteral(`${options.hookLibraryPath}:`)}}"; fi
fi
export PORT_MANAGER_AGENT_SOCKET="${escapedSocketPath}"
export PORT_MANAGER_ROUTES_FILE="${escapedRouteTablePath}"
export PORT_MANAGER_GLOBAL_ROUTES_FILE="${escapedRouteTablePath}"
export PORT_MANAGER_HOST_ACCESS_FILE="${escapedHostAccessFilePath}"
export PORT_MANAGER_NETWORKS_FILE="${escapedTerminalNetworkSelectionFilePath}"
export PORT_MANAGER_AGENT_MAIN="${escapedAgentMainPath}"
export PORT_MANAGER_AGENT_EXECUTABLE="${escapedNativeAgentPath}"
export PORT_MANAGER_CONTAINER_MAP_HELPER="${escapedNativeContainerMapPath}"
export ${DOCKER_SHIM_PATH_ENV}="${escapedDockerShimPath}"
export PORT_MANAGER_SCAN_RANGE="${options.settings.scanRange}"
export PORT_MANAGER_ROUTING_MODE="${options.settings.routingMode}"
export PORT_MANAGER_VIRTUAL_PORT_START="${options.settings.virtualPortRangeStart}"
export PORT_MANAGER_VIRTUAL_PORT_END="${options.settings.virtualPortRangeEnd}"
export PORT_MANAGER_FIXED_PROTOCOL_PORTS="${options.settings.fixedProtocolPorts.join(",")}"
export PORT_MANAGER_PRESERVE_LISTEN_PORTS="${options.settings.preservedListenPorts.join(",")}"
	${escapedRuntimeShimDirectory !== undefined ? `export ${RUNTIME_SHIM_DIRECTORY_ENV}="${escapedRuntimeShimDirectory}"
	export PATH="${escapedRuntimeShimDirectory}:$PATH"
	hash -r 2>/dev/null || true` : ""}
${escapedShellEnvRestorePath !== undefined ? `if [ "\${PORT_MANAGER_HOOK:-0}" = "1" ]; then
  export PORT_MANAGER_DYLD_INSERT_LIBRARIES="${escapedHookLibraryPath}"
if [ -n "\${BASH_ENV:-}" ] && [ "\${BASH_ENV}" != "${escapedShellEnvRestorePath}" ]; then
  export PORT_MANAGER_PREV_BASH_ENV="\${BASH_ENV}"
fi
  export BASH_ENV="${escapedShellEnvRestorePath}"
fi` : ""}

if [ -n "\${PORT_MANAGER_NETWORK_NAME:-}" ]; then
  printf '\\033]0;%s\\007' "Port Manager: \${PORT_MANAGER_NETWORK_NAME}" 2>/dev/null || true
fi

pm() {
  if [ "\${1:-}" = "help" ] || [ "\${1:-}" = "--help" ] || [ "\${1:-}" = "-h" ]; then
    printf '%s\n' 'Usage: pm [current|status|doctor|routes|detach|network-number|network-name|network-id]' >&2
    printf '%s\n' 'Run without arguments to choose a Port Manager logical network for this shell.' >&2
    printf '%s\n' 'Run "pm current" to print the network currently attached to this shell.' >&2
    printf '%s\n' 'Run "pm doctor" to inspect shell routing files and daemon readiness.' >&2
    printf '%s\n' 'Run "pm routes" to print routes visible to this shell.' >&2
    printf '%s\n' 'Run "pm detach" to remove Port Manager routing from this shell.' >&2
    return 0
  fi

  if [ "\${1:-}" = "doctor" ]; then
    __pm_current_id="\${PORT_MANAGER_NETWORK_ID:-}"
    if [ -z "$__pm_current_id" ]; then __pm_current_id="\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID:-}"; fi
    if [ -z "$__pm_current_id" ]; then __pm_current_id="\${PORT_MANAGER_BORROWED_NETWORK_ID:-}"; fi
    __pm_current_name="\${PORT_MANAGER_NETWORK_NAME:-}"
    __pm_routes_file="\${PORT_MANAGER_ROUTES_FILE:-\${PORT_MANAGER_GLOBAL_ROUTES_FILE:-}}"
    __pm_networks_file="\${PORT_MANAGER_NETWORKS_FILE:-}"
    __pm_host_access_file="\${PORT_MANAGER_HOST_ACCESS_FILE:-}"
    if [ -n "$__pm_current_id" ] && [ -z "$__pm_current_name" ] && [ -n "$__pm_networks_file" ] && [ -s "$__pm_networks_file" ]; then
      __pm_current_name="$(awk -F '	' -v q="$__pm_current_id" 'NF >= 3 && $1 == q { print $2; exit }' "$__pm_networks_file")"
    fi
    if [ -n "$__pm_current_id" ]; then
      if [ -n "$__pm_current_name" ]; then
        printf 'Network: %s [%s]\n' "$__pm_current_name" "$__pm_current_id"
      else
        printf 'Network: %s\n' "$__pm_current_id"
      fi
    else
      printf '%s\n' 'Network: none'
    fi
    if [ "\${PORT_MANAGER_HOOK:-0}" = "1" ]; then
      printf '%s\n' 'Hook env: enabled'
    else
      printf 'Hook env: disabled (PORT_MANAGER_HOOK=%s)\n' "\${PORT_MANAGER_HOOK:-unset}"
    fi
    if [ "\${PORT_MANAGER_HOOK_DAEMON_STARTED:-0}" = "1" ]; then
      printf '%s\n' 'Daemon readiness flag: ready'
    else
      printf 'Daemon readiness flag: not ready (PORT_MANAGER_HOOK_DAEMON_STARTED=%s)\n' "\${PORT_MANAGER_HOOK_DAEMON_STARTED:-unset}"
    fi
    printf 'Routing mode: %s\n' "\${PORT_MANAGER_ROUTING_MODE:-unset}"
    printf 'Network loopback host: %s\n' "\${PORT_MANAGER_NETWORK_LOOPBACK_HOST:--}"
    if [ -n "$__pm_routes_file" ] && [ -f "$__pm_routes_file" ]; then
      __pm_route_count="$(${daemonRuntimePrefix} "${escapedNodeExecutablePath}" -e "${shellDoubleQuote(routeCountScript)}" "$__pm_routes_file" 2>/dev/null || printf '?')"
      printf 'Route table: %s (%s routes)\n' "$__pm_routes_file" "$__pm_route_count"
    elif [ -n "$__pm_routes_file" ]; then
      printf 'Route table: missing (%s)\n' "$__pm_routes_file"
    else
      printf '%s\n' 'Route table: unset'
    fi
    if [ -n "$__pm_host_access_file" ] && [ -f "$__pm_host_access_file" ]; then
      printf 'Host access file: %s\n' "$__pm_host_access_file"
    elif [ -n "$__pm_host_access_file" ]; then
      printf 'Host access file: missing (%s)\n' "$__pm_host_access_file"
    else
      printf '%s\n' 'Host access file: unset'
    fi
    if [ -n "$__pm_networks_file" ] && [ -f "$__pm_networks_file" ]; then
      __pm_network_count="$(awk -F '	' 'NF >= 3 { count += 1 } END { print count + 0 }' "$__pm_networks_file")"
      printf 'Network selection file: %s (%s networks)\n' "$__pm_networks_file" "$__pm_network_count"
    elif [ -n "$__pm_networks_file" ]; then
      printf 'Network selection file: missing (%s)\n' "$__pm_networks_file"
    else
      printf '%s\n' 'Network selection file: unset'
    fi
    PORT_MANAGER_DOCTOR_PROCESS_SCAN=1 ${daemonRuntimePrefix} "${escapedNodeExecutablePath}" -e "${shellDoubleQuote(
      doctorRoutingScript,
    )}" "$__pm_current_id" "$PWD" "$__pm_routes_file" "\${PORT_MANAGER_ROUTING_MODE:-}" "\${PORT_MANAGER_NETWORK_LOOPBACK_HOST:-}" 2>/dev/null || true
    unset __pm_current_id __pm_current_name __pm_routes_file __pm_networks_file __pm_host_access_file __pm_route_count __pm_network_count
    return 0
  fi

  if [ "\${1:-}" = "routes" ]; then
    __pm_current_id="\${PORT_MANAGER_NETWORK_ID:-}"
    if [ -z "$__pm_current_id" ]; then __pm_current_id="\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID:-}"; fi
    if [ -z "$__pm_current_id" ]; then __pm_current_id="\${PORT_MANAGER_BORROWED_NETWORK_ID:-}"; fi
    __pm_current_name="\${PORT_MANAGER_NETWORK_NAME:-}"
    __pm_routes_file="\${PORT_MANAGER_ROUTES_FILE:-\${PORT_MANAGER_GLOBAL_ROUTES_FILE:-}}"
    __pm_host_access_file="\${PORT_MANAGER_HOST_ACCESS_FILE:-}"
    if [ -z "$__pm_routes_file" ] || [ ! -f "$__pm_routes_file" ]; then
      printf 'Port Manager route table unavailable: %s\n' "\${__pm_routes_file:-unset}" >&2
      unset __pm_current_id __pm_current_name __pm_routes_file __pm_host_access_file
      return 1
    fi
    ${daemonRuntimePrefix} "${escapedNodeExecutablePath}" -e "${shellDoubleQuote(routePrintScript)}" "$__pm_routes_file" "$__pm_host_access_file" "$__pm_current_id" "$__pm_current_name"
    __pm_status=$?
    unset __pm_current_id __pm_current_name __pm_routes_file __pm_host_access_file
    return $__pm_status
  fi

  if [ "\${1:-}" = "detach" ]; then
    if [ -n "\${PORT_MANAGER_TERMINAL_ATTACHMENT_DIR:-}" ]; then
      __pm_tty="$(tty 2>/dev/null || true)"
      __pm_tty="\${__pm_tty#/dev/}"
      if [ "$__pm_tty" = "not a tty" ]; then __pm_tty=""; fi
      __pm_pid="$$"
      __pm_marker_key="$(printf '%s' "\${__pm_tty:-pid-$__pm_pid}" | sed 's#[^A-Za-z0-9._-]#_#g')"
      rm -f "$PORT_MANAGER_TERMINAL_ATTACHMENT_DIR/$__pm_marker_key.tsv" 2>/dev/null || true
    fi
    printf '\\033]0;%s\\007' 'Port Manager: detached' 2>/dev/null || true
    if [ -n "\${PORT_MANAGER_GLOBAL_ROUTES_FILE:-}" ]; then export PORT_MANAGER_ROUTES_FILE="$PORT_MANAGER_GLOBAL_ROUTES_FILE"; else unset PORT_MANAGER_ROUTES_FILE; fi
    unset PORT_MANAGER_HOOK PORT_MANAGER_HOOK_DISABLED PORT_MANAGER_NETWORK_ID PORT_MANAGER_NETWORK_NAME PORT_MANAGER_ROUTE_TABLE_NETWORK_ID PORT_MANAGER_BORROWED_NETWORK_ID NEWDLOPS_PM_NETWORK_ID NEWDLOPS_PM_BORROWED_NETWORK_ID PORT_MANAGER_HOOK_DAEMON_STARTED PORT_MANAGER_COMPOSE_ROUTING_FILE PORT_MANAGER_TERMINAL_ATTACHMENT_DIR PORT_MANAGER_SCAN_RANGE PORT_MANAGER_ROUTING_MODE PORT_MANAGER_VIRTUAL_PORT_START PORT_MANAGER_VIRTUAL_PORT_END PORT_MANAGER_FIXED_PROTOCOL_PORTS PORT_MANAGER_PRESERVE_LISTEN_PORTS PORT_MANAGER_NETWORK_LOOPBACK_HOST PORT_MANAGER_DYLD_INSERT_LIBRARIES
    export PORT_MANAGER_HOOK=0
    export PORT_MANAGER_HOOK_DISABLED=1
    export PORT_MANAGER_HOOK_DAEMON_STARTED=0
    if [ -n "\${PORT_MANAGER_PREV_BASH_ENV:-}" ]; then export BASH_ENV="\${PORT_MANAGER_PREV_BASH_ENV}"; else unset BASH_ENV; fi
    unset PORT_MANAGER_PREV_BASH_ENV
    if [ "\${DYLD_INSERT_LIBRARIES:-}" = "${escapedHookLibraryPath}" ]; then unset DYLD_INSERT_LIBRARIES; else export DYLD_INSERT_LIBRARIES="\${DYLD_INSERT_LIBRARIES#${shellPatternLiteral(`${options.hookLibraryPath}:`)}}"; fi
    if [ "\${LD_PRELOAD:-}" = "${escapedHookLibraryPath}" ]; then unset LD_PRELOAD; else export LD_PRELOAD="\${LD_PRELOAD#${shellPatternLiteral(`${options.hookLibraryPath}:`)}}"; fi
    ${escapedRuntimeShimDirectory !== undefined ? `export PATH="\${PATH#${shellPatternLiteral(`${options.runtimeShimDirectory}:`)}}"
    unset ${RUNTIME_SHIM_DIRECTORY_ENV}
    hash -r 2>/dev/null || true` : ""}
    unset -f docker podman docker-compose podman-compose /usr/local/bin/docker /opt/homebrew/bin/docker /usr/bin/docker /bin/docker /Applications/Docker.app/Contents/Resources/bin/docker /usr/local/bin/podman /opt/homebrew/bin/podman /usr/bin/podman /bin/podman /usr/local/bin/docker-compose /opt/homebrew/bin/docker-compose /usr/bin/docker-compose /bin/docker-compose /Applications/Docker.app/Contents/Resources/bin/docker-compose /usr/local/bin/podman-compose /opt/homebrew/bin/podman-compose /usr/bin/podman-compose /bin/podman-compose __port_manager_runtime_first_command __port_manager_runtime_container_subcommand __port_manager_network_id __port_manager_normalize_compose_file_path __port_manager_same_compose_file_path __port_manager_compose_args_reference_file __port_manager_compose_route_for_runtime __port_manager_cwd_matches_workdir __port_manager_container_target_for_runtime __port_manager_shell_quote __port_manager_runtime_command_may_reference_container __port_manager_run_runtime_with_container_routing __port_manager_run_compose_command_with_routing __port_manager_run_standalone_compose_with_routing __port_manager_define_absolute_runtime_function 2>/dev/null || true
    unset __pm_tty __pm_pid __pm_marker_key
    printf '%s\n' 'Port Manager routing detached from this shell.'
    return 0
  fi

  if [ "\${1:-}" = "current" ] || [ "\${1:-}" = "status" ] || [ "\${1:-}" = "--current" ]; then
    __pm_current_id="\${PORT_MANAGER_NETWORK_ID:-}"
    if [ -z "$__pm_current_id" ]; then __pm_current_id="\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID:-}"; fi
    if [ -z "$__pm_current_id" ]; then __pm_current_id="\${PORT_MANAGER_BORROWED_NETWORK_ID:-}"; fi
    __pm_current_name="\${PORT_MANAGER_NETWORK_NAME:-}"
    __pm_networks_file="\${PORT_MANAGER_NETWORKS_FILE:-}"
    if [ -n "$__pm_current_id" ] && [ -z "$__pm_current_name" ] && [ -n "$__pm_networks_file" ] && [ -s "$__pm_networks_file" ]; then
      __pm_current_name="$(awk -F '	' -v q="$__pm_current_id" 'NF >= 3 && $1 == q { print $2; exit }' "$__pm_networks_file")"
    fi
    if [ -z "$__pm_current_id" ]; then
      printf '%s\n' 'Port Manager shell network: none'
      unset __pm_current_id __pm_current_name __pm_networks_file
      return 1
    fi
    if [ -n "$__pm_current_name" ]; then
      printf 'Port Manager shell network: %s [%s]\n' "$__pm_current_name" "$__pm_current_id"
    else
      printf 'Port Manager shell network: %s\n' "$__pm_current_id"
    fi
    unset __pm_current_id __pm_current_name __pm_networks_file
    return 0
  fi

  __pm_networks_file="\${PORT_MANAGER_NETWORKS_FILE:-}"
  if [ -z "$__pm_networks_file" ] || [ ! -s "$__pm_networks_file" ]; then
    printf '%s\n' 'Port Manager has no exported networks yet. Open VS Code Port Manager and create or refresh a logical network.' >&2
    unset __pm_networks_file
    return 1
  fi

  if [ "$#" -gt 0 ]; then
    __pm_choice="$*"
  else
    ${daemonRuntimePrefix} "${escapedNodeExecutablePath}" -e "${shellDoubleQuote(networkPrintScript)}" "$__pm_networks_file" "\${PORT_MANAGER_NETWORK_ID:-}" >&2
    printf '%s' 'Select Port Manager network: ' >&2
    IFS= read -r __pm_choice || {
      unset __pm_networks_file __pm_choice
      return 1
    }
  fi

  __pm_row="$(awk -F '	' -v q="$__pm_choice" 'NF >= 3 && q ~ /^[0-9]+$/ && NR == q { print; exit } NF >= 3 && ($1 == q || $2 == q) { print; exit }' "$__pm_networks_file")"
  if [ -z "$__pm_row" ]; then
    printf 'Port Manager network not found: %s\n' "$__pm_choice" >&2
    unset __pm_networks_file __pm_choice __pm_row
    return 1
  fi

  __pm_network_id="$(printf '%s\n' "$__pm_row" | awk -F '	' '{ print $1 }')"
  __pm_network_name="$(printf '%s\n' "$__pm_row" | awk -F '	' '{ print $2 }')"
  __pm_attach_script="$(printf '%s\n' "$__pm_row" | awk -F '	' '{ print $3 }')"
  if [ ! -f "$__pm_attach_script" ]; then
    printf 'Port Manager attach script missing for %s. Refresh VS Code Port Manager and try again.\n' "$__pm_network_name" >&2
    unset __pm_networks_file __pm_choice __pm_row __pm_network_id __pm_network_name __pm_attach_script
    return 1
  fi

  . "$__pm_attach_script"
  __pm_status=$?
  if [ "$__pm_status" -eq 0 ]; then
    printf 'Port Manager shell network: %s [%s]\n' "$__pm_network_name" "$__pm_network_id" >&2
  fi
  unset __pm_networks_file __pm_choice __pm_row __pm_network_id __pm_network_name __pm_attach_script
  return $__pm_status
}

__pm_agent_ready=0
__pm_agent_lock="\${PORT_MANAGER_AGENT_SOCKET}.startup.lock"
${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1
if [ "$__pm_agent_ready" != "1" ]; then
  if mkdir "$__pm_agent_lock" 2>/dev/null; then
    __pm_agent_wait_count=0
    while [ $__pm_agent_wait_count -lt 50 ]; do
      ${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1 && break
      __pm_agent_wait_count=$((__pm_agent_wait_count + 1))
      sleep 0.1
    done
    if [ "$__pm_agent_ready" != "1" ]; then
      rm -f "$PORT_MANAGER_AGENT_SOCKET" 2>/dev/null || true
  if [ -x "$PORT_MANAGER_AGENT_EXECUTABLE" ]; then
    ${daemonRuntimePrefix} nohup "$PORT_MANAGER_AGENT_EXECUTABLE" --socket "$PORT_MANAGER_AGENT_SOCKET" --route-table "$PORT_MANAGER_GLOBAL_ROUTES_FILE" --agent-main "$PORT_MANAGER_AGENT_MAIN" >/tmp/newdlops-portmanager-agent.log 2>&1 &
  else
    ${daemonRuntimePrefix} nohup "${escapedNodeExecutablePath}" "$PORT_MANAGER_AGENT_MAIN" --socket "$PORT_MANAGER_AGENT_SOCKET" >/tmp/newdlops-portmanager-agent.log 2>&1 &
  fi
  __pm_agent_wait_count=0
  while [ $__pm_agent_wait_count -lt 50 ]; do
    ${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1 && break
    __pm_agent_wait_count=$((__pm_agent_wait_count + 1))
    sleep 0.1
  done
    fi
    rmdir "$__pm_agent_lock" 2>/dev/null || true
  else
    __pm_agent_wait_count=0
    while [ $__pm_agent_wait_count -lt 60 ]; do
      ${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1 && break
      __pm_agent_wait_count=$((__pm_agent_wait_count + 1))
      sleep 0.1
    done
  fi
  unset __pm_agent_wait_count
fi
if [ "$__pm_agent_ready" = "1" ]; then
  export PORT_MANAGER_HOOK_DAEMON_STARTED=1
else
  export PORT_MANAGER_HOOK=0
  export PORT_MANAGER_HOOK_DAEMON_STARTED=0
  printf '%s\n' 'Port Manager routing unavailable: local daemon did not become ready.' >&2
fi
unset __pm_agent_ready __pm_agent_lock

if [ "\${PORT_MANAGER_HOOK:-0}" = "1" ] && [ -f "${escapedHookLibraryPath}" ]; then
  case "$(uname -s)" in
    Darwin)
      case ":\${DYLD_INSERT_LIBRARIES:-}:" in
        *:"${escapedHookLibraryPath}":*) ;;
        *) export DYLD_INSERT_LIBRARIES="${escapedHookLibraryPath}\${DYLD_INSERT_LIBRARIES:+:$DYLD_INSERT_LIBRARIES}" ;;
      esac
      ;;
    Linux)
      case ":\${LD_PRELOAD:-}:" in
        *:"${escapedHookLibraryPath}":*) ;;
        *) export LD_PRELOAD="${escapedHookLibraryPath}\${LD_PRELOAD:+:$LD_PRELOAD}" ;;
      esac
      ;;
  esac
fi
`;
}

/** Appends one line to a shell profile if it is not already present. */
async function appendLineOnce(filePath: string, line: string): Promise<void> {
  let existingContent = "";

  try {
    existingContent = await fs.readFile(filePath, "utf8");
  } catch {
    // Missing shell profiles are created on first install.
  }

  if (existingContent.split(/\r?\n/).includes(line)) {
    return;
  }

  const prefix = existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";
  await fs.writeFile(filePath, `${existingContent}${prefix}${line}\n`, "utf8");
}

/** Escapes a string for safe use inside POSIX double quotes. */
function shellDoubleQuote(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

/** Escapes a literal prefix used inside POSIX parameter expansion patterns. */
function shellPatternLiteral(value: string): string {
  return value.replace(/([\\*?\[])/g, "\\$1");
}

/** Chooses the compose working directory before falling back to the VS Code workspace. */
function resolveComposeWorkingDirectory(
  workingDirectory: string | undefined,
  composeFiles: readonly string[] | undefined,
): string | undefined {
  const normalizedWorkingDirectory = workingDirectory?.trim();
  if (normalizedWorkingDirectory !== undefined && normalizedWorkingDirectory.length > 0) {
    return normalizedWorkingDirectory;
  }

  const firstComposeFile = composeFiles?.find((file) => file.trim().length > 0);
  return firstComposeFile === undefined ? undefined : path.dirname(firstComposeFile);
}

/** Shows concise but specific command errors. */
async function showCommandError(error: unknown): Promise<void> {
  if (error instanceof Error) {
    await vscode.window.showErrorMessage(error.message);
    return;
  }

  await vscode.window.showErrorMessage(String(error));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

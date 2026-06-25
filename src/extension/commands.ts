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
  PortInjectionMode,
  PortManagerSettings,
  TerminalAttachment,
  TerminalWindow,
} from "../shared/types";

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
    this.registerCommand(context, "portManager.stopProcess", (argument) => this.stopProcess(argument));
    this.registerCommand(context, "portManager.restartProcess", (argument) => this.restartProcess(argument));
    this.registerCommand(context, "portManager.stopAllProcesses", () => this.stopAllProcesses());
    this.registerCommand(context, "portManager.copyRoutedUrl", (argument) => this.copyRoutedUrl(argument));
    this.registerCommand(context, "portManager.openRoutedUrl", (argument) => this.openRoutedUrl(argument));
    this.registerCommand(context, "portManager.removeProcess", (argument) => this.removeProcess(argument));
    this.registerCommand(context, "portManager.installShellHook", () => this.installShellHook(context));
    this.registerCommand(context, "portManager.installExternalCli", () => this.installExternalCli(context));
    this.registerCommand(context, "portManager.openSettings", () => openPortManagerSettings());
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
    const terminalWindow = directInput?.terminalWindow ?? (await this.resolveTerminalWindowArgument(argument, "Attach Terminal Window to Network"));
    if (terminalWindow === undefined) {
      return;
    }

    const network = directInput?.network ?? (await this.resolveNetworkArgument(undefined, "Attach Terminal Window to Network"));
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

    await vscode.window.showInformationMessage(
      `Attached "${terminalWindow.title}" to "${network.name}" (${attachment.mode ?? "isolated"} mode).`,
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
      "Copy Script",
      "Show Error",
    );

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
    const composeMutation =
      candidate.composeProject !== undefined && isComposeCloneAttachMode(composeAttachMode)
        ? {
            composeMutation: {
              mode: "clone" as const,
              allowStatefulClone,
              ...(attachedProjectName !== undefined ? { attachedProjectName } : {}),
              runtime: candidate.runtime,
              workingDirectory: candidate.composeWorkingDirectory ?? getDefaultWorkspaceFolder() ?? process.cwd(),
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
      cwd: candidate.composeWorkingDirectory ?? getDefaultWorkspaceFolder() ?? process.cwd(),
      composeFiles: existingCloneMutation?.composeFiles ?? candidate.composeConfigFiles,
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
      await openUrl(restarted.url);
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

    await vscode.env.clipboard.writeText(process.url);
    await vscode.window.showInformationMessage(`Copied ${process.url}`);
  }

  /** Opens the selected process URL in the user's default browser. */
  private async openRoutedUrl(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Open Routed URL");
    if (!isReachableProcess(process)) {
      await vscode.window.showInformationMessage("This process is not running, so there is no routed URL to open.");
      return;
    }

    await openUrl(process.url);
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
    const settings = readPortManagerSettings();
    const hookLibraryPath = context.asAbsolutePath(getHookLibraryRelativePath());
    const asdfShimLauncherPath = context.asAbsolutePath(getAsdfShimLauncherRelativePath());
    const runtimeCommandShimPath = context.asAbsolutePath(getRuntimeCommandShimRelativePath());
    const agentMainPath = context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
    const nativeAgentPath = context.asAbsolutePath(path.join("media", "native", "portmanager_agent"));
    const nativeContainerMapPath = context.asAbsolutePath(path.join("media", "native", "portmanager_container_map"));
    const hookDirectory = path.join(os.homedir(), ".portmanager");
    const hookScriptPath = path.join(hookDirectory, "portmanager-hook.sh");
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
        settings,
        runtimeShimDirectory,
        shellEnvRestorePath,
      }),
      "utf8",
    );

    for (const shellProfilePath of shellProfilePaths) {
      await appendLineOnce(shellProfilePath, sourceLine);
    }

    const message =
      shellProfilePaths.length === 0
        ? `Installed Port Manager shell hook: ${hookScriptPath}`
        : `Installed Port Manager shell hook and updated ${shellProfilePaths.join(", ")}`;
    const selection = await vscode.window.showInformationMessage(message, "Copy Source Line");

    if (selection === "Copy Source Line") {
      await vscode.env.clipboard.writeText(sourceLine);
    }
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
      await openUrl(process.url);
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
        description: `${item.runtime}, ${item.ports.length} port${item.ports.length === 1 ? "" : "s"}`,
        detail: item.ports.map(formatComposePublishedPort).join(", "),
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
  const asIsItem =
    candidate.portManagerClone === undefined
      ? {
          label: "Attach as-is",
          description: "Register the current published ports without restarting Compose",
          detail: "Keeps the original containers exactly as they are and only adds logical-network route rows.",
          mode: "as-is" as const,
        }
      : {
          label: "Reattach existing clone",
          description: "Reuse the running Port Manager clone and its generated override",
          detail: "Keeps the clone containers running and restores logical-network route rows.",
          mode: "as-is" as const,
        };
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: "Clone and hide host ports",
        description: "Recreate services under a network-scoped Compose project",
        detail: "Frees original host ports so the original Compose project can be started again.",
        mode: "clone" as const,
      },
      {
        label: "Clone with custom Compose name",
        description: "Choose the hidden Compose project name before recreating services",
        detail: "Use this when copying an existing clone or when the generated project name would collide.",
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
  /** Routing settings mirrored into native hook environment variables. */
  readonly settings: PortManagerSettings;
  /** Optional PATH directory that restores DYLD after protected runtime launch boundaries. */
  readonly runtimeShimDirectory?: string;
  /** Optional BASH_ENV fragment that restores DYLD after protected shebang boundaries. */
  readonly shellEnvRestorePath?: string;
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
  const escapedRuntimeShimDirectory =
    options.runtimeShimDirectory !== undefined ? shellDoubleQuote(options.runtimeShimDirectory) : undefined;
  const escapedShellEnvRestorePath =
    options.shellEnvRestorePath !== undefined ? shellDoubleQuote(options.shellEnvRestorePath) : undefined;
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
    'timer=setTimeout(()=>finish(1,true),700);',
    'socket.setEncoding("utf8");',
    'socket.once("connect",()=>{socket.write(JSON.stringify({id:"probe",method:"listSnapshot"})+"\\n");});',
    'socket.once("error",()=>finish(1,true));',
    'socket.on("data",(chunk)=>{buffer+=chunk;const lineEnd=buffer.indexOf("\\n");if(lineEnd<0)return;try{const message=JSON.parse(buffer.slice(0,lineEnd));const daemon=message&&message.payload&&message.payload.daemon;const actual=normalize(daemon&&daemon.agentMainPath);const expectedPath=normalize(expected);if(!actual||actual!==expectedPath||isOlder(daemon&&daemon.startedAt,expected)){shutdownStale();return;}finish(0,false);}catch{finish(1,true);}});',
  ].join("");
  const probeCommand = `${daemonRuntimePrefix} "${escapedNodeExecutablePath}" -e "${shellDoubleQuote(
    nodeProbeScript,
  )}" "$PORT_MANAGER_AGENT_SOCKET" "$PORT_MANAGER_AGENT_MAIN"`;

  return `# Port Manager shell hook
# This file is generated by the VS Code Port Manager extension.
export PORT_MANAGER_HOOK=1
export PORT_MANAGER_AGENT_SOCKET="${escapedSocketPath}"
export PORT_MANAGER_ROUTES_FILE="${escapedRouteTablePath}"
export PORT_MANAGER_GLOBAL_ROUTES_FILE="${escapedRouteTablePath}"
export PORT_MANAGER_HOST_ACCESS_FILE="${escapedHostAccessFilePath}"
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
${escapedShellEnvRestorePath !== undefined ? `export PORT_MANAGER_DYLD_INSERT_LIBRARIES="${escapedHookLibraryPath}"
if [ -n "\${BASH_ENV:-}" ] && [ "\${BASH_ENV}" != "${escapedShellEnvRestorePath}" ]; then
  export PORT_MANAGER_PREV_BASH_ENV="\${BASH_ENV}"
fi
export BASH_ENV="${escapedShellEnvRestorePath}"` : ""}

__pm_agent_ready=0
${probeCommand} >/dev/null 2>&1 && __pm_agent_ready=1
if [ "$__pm_agent_ready" != "1" ]; then
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
  unset __pm_agent_wait_count
fi
if [ "$__pm_agent_ready" = "1" ]; then
  export PORT_MANAGER_HOOK_DAEMON_STARTED=1
else
  export PORT_MANAGER_HOOK=0
  export PORT_MANAGER_HOOK_DAEMON_STARTED=0
  printf '%s\n' 'Port Manager routing unavailable: local daemon did not become ready.' >&2
fi
unset __pm_agent_ready

if [ -f "${escapedHookLibraryPath}" ]; then
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

/** Shows concise but specific command errors. */
async function showCommandError(error: unknown): Promise<void> {
  if (error instanceof Error) {
    await vscode.window.showErrorMessage(error.message);
    return;
  }

  await vscode.window.showErrorMessage(String(error));
}

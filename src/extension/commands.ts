import * as path from "node:path";
import * as vscode from "vscode";
import { ManagedProcessRegistry } from "../core/process-registry";
import { PortRoutingError, PortRoutingService } from "../core/port-routing";
import { readPortManagerSettings, openPortManagerSettings } from "../config/vscode-settings";
import type { PortManagerTreeProvider } from "../ui/sidebar/port-manager-tree";
import { getProcessFromCommandArgument } from "../ui/sidebar/port-manager-tree";
import type {
  DisposableLike,
  ManagedProcess,
  ManagedProcessStartInput,
  PortInjectionMode,
  ProcessLauncher,
} from "../shared/types";

/**
 * Registers Port Manager commands and coordinates the MVP flow.
 *
 * This controller is intentionally an orchestration boundary: it reads VS Code
 * input, asks core services for routing decisions, delegates process mechanics
 * to the platform launcher, and updates the registry for the UI.
 */

export interface PortManagerCommandDependencies {
  /** Domain registry backing the sidebar process list. */
  readonly registry: ManagedProcessRegistry;
  /** Domain routing policy that resolves requested ports to actual ports. */
  readonly routingService: PortRoutingService;
  /** Platform launcher that starts and stops child processes. */
  readonly launcher: ProcessLauncher;
  /** Sidebar provider refreshed after command-driven changes. */
  readonly treeProvider: PortManagerTreeProvider;
}

/**
 * Command controller keeps restart profiles that are not part of the public
 * ManagedProcess record. This avoids changing the product data model while
 * still allowing a process to restart with its original injection strategy.
 */
export class PortManagerCommandController implements DisposableLike {
  /** Disposables returned by VS Code command registration and launcher events. */
  private readonly disposables: DisposableLike[] = [];

  /** Launch profiles keyed by registry id so restart can preserve user choices. */
  private readonly launchProfilesByProcessId = new Map<string, ManagedProcessStartInput>();

  constructor(private readonly dependencies: PortManagerCommandDependencies) {
    this.disposables.push(
      this.dependencies.launcher.onExit((pid) => {
        this.markExitedProcessStopped(pid);
      }),
    );
  }

  /**
   * Registers every command contribution declared in package.json.
   * All command handlers are wrapped so user-facing failures become VS Code
   * error notifications instead of unhandled promise rejections.
   */
  register(context: vscode.ExtensionContext): void {
    this.registerCommand(context, "portManager.startManagedProcess", () => this.startManagedProcess());
    this.registerCommand(context, "portManager.addExistingProcess", () => this.addExistingProcess());
    this.registerCommand(context, "portManager.refresh", () => this.refresh());
    this.registerCommand(context, "portManager.stopProcess", (argument) => this.stopProcess(argument));
    this.registerCommand(context, "portManager.restartProcess", (argument) => this.restartProcess(argument));
    this.registerCommand(context, "portManager.stopAllProcesses", () => this.stopAllProcesses());
    this.registerCommand(context, "portManager.copyRoutedUrl", (argument) => this.copyRoutedUrl(argument));
    this.registerCommand(context, "portManager.openRoutedUrl", (argument) => this.openRoutedUrl(argument));
    this.registerCommand(context, "portManager.removeProcess", (argument) => this.removeProcess(argument));
    this.registerCommand(context, "portManager.openSettings", () => openPortManagerSettings());
  }

  /** Releases command and launcher subscriptions during extension deactivation. */
  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
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
    this.dependencies.registry.register({
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
  private refresh(): void {
    this.dependencies.treeProvider.refresh();
  }

  /**
   * Stops a selected process. The platform launcher only owns child processes
   * it started; registry state is still marked stopped so external registrations
   * can be cleared from the active list by the user.
   */
  private async stopProcess(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Stop Process");
    if (process === undefined) {
      return;
    }

    const settings = readPortManagerSettings();
    await this.dependencies.launcher.stop(process.pid, settings.processKillSignal);
    this.dependencies.registry.stop(process.id);
  }

  /**
   * Restarts a managed process using its saved launch profile when available.
   * Registered external processes fall back to their current command and env
   * injection, which is enough for the MVP but may not match all external apps.
   */
  private async restartProcess(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Restart Process");
    if (process === undefined) {
      return;
    }

    const settings = readPortManagerSettings();
    await this.dependencies.launcher.stop(process.pid, settings.processKillSignal);

    const fallbackProfile: ManagedProcessStartInput = {
      name: process.name,
      command: process.command,
      cwd: process.cwd,
      requestedPort: process.requestedPort,
      host: settings.defaultHost,
      injectionMode: "env",
    };

    const profile = this.launchProfilesByProcessId.get(process.id) ?? fallbackProfile;
    const restarted = await this.launchProfile(profile);

    this.dependencies.registry.update(process.id, {
      pid: restarted.pid,
      command: restarted.command,
      actualPort: restarted.actualPort,
      status: "running",
      startedAt: new Date().toISOString(),
      stoppedAt: undefined,
      url: buildUrl(profile.host, restarted.actualPort),
      errorMessage: undefined,
    });

    this.launchProfilesByProcessId.set(process.id, profile);

    if (settings.autoOpenBrowser) {
      await openUrl(buildUrl(profile.host, restarted.actualPort));
    }
  }

  /** Stops every registered process in snapshot order. */
  private async stopAllProcesses(): Promise<void> {
    const settings = readPortManagerSettings();

    for (const process of this.dependencies.registry.list()) {
      if (process.status === "stopped") {
        continue;
      }

      await this.dependencies.launcher.stop(process.pid, settings.processKillSignal);
      this.dependencies.registry.stop(process.id);
    }
  }

  /** Copies the selected process URL to the system clipboard. */
  private async copyRoutedUrl(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Copy Routed URL");
    if (process?.url === undefined) {
      return;
    }

    await vscode.env.clipboard.writeText(process.url);
    await vscode.window.showInformationMessage(`Copied ${process.url}`);
  }

  /** Opens the selected process URL in the user's default browser. */
  private async openRoutedUrl(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Open Routed URL");
    if (process?.url === undefined) {
      return;
    }

    await openUrl(process.url);
  }

  /**
   * Removes a process from the registry. The command does not stop the process;
   * users can choose Stop first when they want lifecycle control.
   */
  private async removeProcess(argument: unknown): Promise<void> {
    const process = await this.resolveProcessArgument(argument, "Remove Process");
    if (process === undefined) {
      return;
    }

    this.launchProfilesByProcessId.delete(process.id);
    this.dependencies.registry.remove(process.id);
  }

  /**
   * Starts a process from an explicit profile, records it in the registry, and
   * stores the profile for restart.
   */
  private async startFromProfile(profile: ManagedProcessStartInput): Promise<ManagedProcess> {
    const settings = readPortManagerSettings();
    const launch = await this.launchProfile(profile);
    const process = this.dependencies.registry.register({
      pid: launch.pid,
      name: profile.name,
      command: launch.command,
      cwd: profile.cwd,
      requestedPort: profile.requestedPort,
      actualPort: launch.actualPort,
      host: profile.host,
    });

    this.launchProfilesByProcessId.set(process.id, profile);

    if (launch.routed && settings.showConflictNotification) {
      await vscode.window.showInformationMessage(
        `Port ${profile.requestedPort} is busy. Routed app to ${launch.actualPort}.`,
      );
    }

    if (settings.autoOpenBrowser && process.url) {
      await openUrl(process.url);
    }

    return process;
  }

  /**
   * Routes the requested port and delegates child-process creation to the
   * platform launcher. The returned command may include template expansion or
   * appended arguments depending on injection mode.
   */
  private async launchProfile(profile: ManagedProcessStartInput): Promise<{
    readonly pid: number;
    readonly command: string;
    readonly actualPort: number;
    readonly routed: boolean;
  }> {
    const settings = readPortManagerSettings();
    const decision = await this.dependencies.routingService.route({
      requestedPort: profile.requestedPort,
      host: profile.host,
      scanRange: settings.scanRange,
      scanDirection: settings.scanDirection,
    });

    const launch = await this.dependencies.launcher.launch({
      name: profile.name,
      command: profile.command,
      cwd: profile.cwd,
      requestedPort: profile.requestedPort,
      host: profile.host,
      actualPort: decision.actualPort,
      injectionMode: profile.injectionMode,
    });

    return {
      pid: launch.pid,
      command: launch.command,
      actualPort: decision.actualPort,
      routed: decision.routed,
    };
  }

  /**
   * Resolves a command argument from the tree, or asks the user to choose a
   * process when the command was launched from the palette.
   */
  private async resolveProcessArgument(argument: unknown, title: string): Promise<ManagedProcess | undefined> {
    const process = getProcessFromCommandArgument(argument);

    if (process !== undefined) {
      return this.dependencies.registry.get(process.id);
    }

    const processes = this.dependencies.registry.list();
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

  /**
   * Marks the matching registry entry stopped when the child process exits on
   * its own. PID matching is sufficient because the launcher only emits events
   * for processes it started.
   */
  private markExitedProcessStopped(pid: number): void {
    const process = this.dependencies.registry.list().find((candidate) => candidate.pid === pid);

    if (process === undefined || process.status === "stopped") {
      return;
    }

    this.dependencies.registry.stop(process.id);
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

/** Uses workspace folder name as the default process label when possible. */
function deriveProcessName(command: string, cwd: string): string {
  const folderName = path.basename(cwd);
  return folderName.length > 0 ? folderName : command;
}

/** Returns the first workspace folder path because MVP commands are workspace-scoped. */
function getDefaultWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Builds the HTTP URL used by MVP development servers. */
function buildUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/** Opens an HTTP URL through VS Code's external URI bridge. */
async function openUrl(url: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Validates the user-facing TCP port range. */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Shows concise but specific command errors. */
async function showCommandError(error: unknown): Promise<void> {
  if (error instanceof PortRoutingError) {
    await vscode.window.showErrorMessage(error.message);
    return;
  }

  if (error instanceof Error) {
    await vscode.window.showErrorMessage(error.message);
    return;
  }

  await vscode.window.showErrorMessage(String(error));
}

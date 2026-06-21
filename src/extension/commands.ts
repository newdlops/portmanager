import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAgentSocketPath } from "../agent/agent-socket";
import { getDefaultRouteTablePath } from "../agent/route-table";
import { readPortManagerSettings, openPortManagerSettings } from "../config/vscode-settings";
import type { PortManagerTreeProvider } from "../ui/sidebar/port-manager-tree";
import { getProcessFromCommandArgument } from "../ui/sidebar/port-manager-tree";
import type { PortManagerProcessService } from "./process-service";
import type {
  DisposableLike,
  ManagedProcess,
  ManagedProcessStartInput,
  PortInjectionMode,
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
    this.registerCommand(context, "portManager.startDaemon", () => this.startDaemon());
    this.registerCommand(context, "portManager.stopDaemon", () => this.stopDaemon());
    this.registerCommand(context, "portManager.showDaemonStatus", () => this.showDaemonStatus());
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
    await vscode.window.showInformationMessage(
      `Port Manager daemon ${daemon.status}: pid ${daemon.pid}, ${daemon.listenerCount} listeners, ${daemon.routeCount} routes`,
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
    const errorMessage = daemon.errorMessage ? `\nWarning: ${daemon.errorMessage}` : "";

    await vscode.window.showInformationMessage(
      `Daemon ${daemon.status}. PID: ${daemon.pid || "n/a"}. Listeners: ${daemon.listenerCount}. Routes: ${daemon.routeCount}.${routeTablePath}${errorMessage}`,
      { modal: true },
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
    await this.dependencies.processService.refresh();
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
    const shimContent = buildExternalCliShim(cliPath);

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
    const hookLibraryPath = context.asAbsolutePath(getHookLibraryRelativePath());
    const agentMainPath = context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
    const hookDirectory = path.join(os.homedir(), ".portmanager");
    const hookScriptPath = path.join(hookDirectory, "portmanager-hook.sh");
    const shellProfilePath = getShellProfilePath();
    const sourceLine = `. "${hookScriptPath}"`;

    await fs.mkdir(hookDirectory, { recursive: true });
    await fs.writeFile(
      hookScriptPath,
      buildShellHookScript({
        hookLibraryPath,
        agentMainPath,
        nodeExecutablePath: process.execPath,
        socketPath: getAgentSocketPath(),
        routeTablePath: getDefaultRouteTablePath(),
      }),
      "utf8",
    );

    if (shellProfilePath !== undefined) {
      await appendLineOnce(shellProfilePath, sourceLine);
    }

    const message =
      shellProfilePath === undefined
        ? `Installed Port Manager shell hook: ${hookScriptPath}`
        : `Installed Port Manager shell hook and updated ${shellProfilePath}`;
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

/** Builds a tiny shell wrapper that points at this extension's compiled CLI. */
function buildExternalCliShim(cliPath: string): string {
  if (process.platform === "win32") {
    return `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`;
  }

  return `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`;
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

/** Chooses the user's current shell startup file when it is a POSIX shell. */
function getShellProfilePath(): string | undefined {
  const shellName = path.basename(process.env.SHELL ?? "");

  if (shellName === "zsh") {
    return path.join(os.homedir(), ".zshrc");
  }

  if (shellName === "bash") {
    return path.join(os.homedir(), ".bashrc");
  }

  if (shellName === "sh") {
    return path.join(os.homedir(), ".profile");
  }

  return undefined;
}

interface ShellHookScriptOptions {
  /** Native hook library packaged with this extension. */
  readonly hookLibraryPath: string;
  /** Agent entrypoint used when no daemon socket exists yet. */
  readonly agentMainPath: string;
  /** Node-compatible executable used by VS Code to run extension JS. */
  readonly nodeExecutablePath: string;
  /** Singleton agent socket path shared with VS Code windows. */
  readonly socketPath: string;
  /** Dynamic route-table JSON file written by the daemon. */
  readonly routeTablePath: string;
}

/** Builds the POSIX shell snippet that injects the native socket hook. */
function buildShellHookScript(options: ShellHookScriptOptions): string {
  const escapedHookLibraryPath = shellDoubleQuote(options.hookLibraryPath);
  const escapedAgentMainPath = shellDoubleQuote(options.agentMainPath);
  const escapedNodeExecutablePath = shellDoubleQuote(options.nodeExecutablePath);
  const escapedSocketPath = shellDoubleQuote(options.socketPath);
  const escapedRouteTablePath = shellDoubleQuote(options.routeTablePath);

  return `# Port Manager shell hook
# This file is generated by the VS Code Port Manager extension.
export PORT_MANAGER_HOOK=1
export PORT_MANAGER_AGENT_SOCKET="${escapedSocketPath}"
export PORT_MANAGER_ROUTES_FILE="${escapedRouteTablePath}"
export PORT_MANAGER_AGENT_MAIN="${escapedAgentMainPath}"

if [ -z "$\{PORT_MANAGER_HOOK_DAEMON_STARTED:-}" ]; then
  export PORT_MANAGER_HOOK_DAEMON_STARTED=1
  "${escapedNodeExecutablePath}" -e 'const net=require("node:net");const fs=require("node:fs");const socketPath=process.argv[1];const socket=net.createConnection(socketPath);const timer=setTimeout(()=>{socket.destroy();try{if(process.platform!=="win32")fs.unlinkSync(socketPath);}catch{}process.exit(1);},500);socket.once("connect",()=>{clearTimeout(timer);socket.end();process.exit(0);});socket.once("error",()=>{clearTimeout(timer);try{if(process.platform!=="win32")fs.unlinkSync(socketPath);}catch{}process.exit(1);});' "$PORT_MANAGER_AGENT_SOCKET" >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    nohup "${escapedNodeExecutablePath}" "$PORT_MANAGER_AGENT_MAIN" --socket "$PORT_MANAGER_AGENT_SOCKET" >/tmp/newdlops-portmanager-agent.log 2>&1 &
  fi
fi

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

import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildReroutableCommand,
  detectTerminalListenFailure,
  detectTerminalPortIntent,
} from "../core/terminal-conflict-parser";
import { readPortManagerSettings } from "../config/vscode-settings";
import type {
  DisposableLike,
  ManagedProcess,
  ManagedProcessStartInput,
  PortManagerSettings,
} from "../shared/types";
import { shouldInjectTerminalHook } from "./terminal-hook-environment";
import type { PortManagerProcessService } from "./process-service";

/**
 * Watches VS Code shell integration output for listen failures.
 *
 * The monitor gives terminal commands an active daemon-managed path when their
 * command line exposes a requested port. If that preflight route is missed, it
 * still scans output for bind errors such as Daphne's Errno 48 message and
 * offers the same daemon-managed rerun after failure.
 */

export interface TerminalConflictMonitorOptions {
  /** Agent-backed service used to start the routed replacement command. */
  readonly processService: PortManagerProcessService;
  /** Optional logical-network view used to ignore already attached terminals. */
  readonly attachmentState?: TerminalAttachmentState;
}

export interface TerminalAttachmentState {
  /** True when this terminal is already running under a logical-network runtime. */
  isTerminalAttached(terminal: vscode.Terminal): Promise<boolean>;
}

export class TerminalConflictMonitor implements DisposableLike {
  /** VS Code event subscriptions owned by the monitor. */
  private readonly disposables: DisposableLike[] = [];

  /** Executions already handled, preventing repeated prompts for one failure. */
  private readonly handledExecutions = new WeakSet<vscode.TerminalShellExecution>();

  /** Executions that already received a start-time routing prompt. */
  private readonly promptedExecutions = new WeakSet<vscode.TerminalShellExecution>();

  constructor(private readonly options: TerminalConflictMonitorOptions) {}

  /** Registers shell execution listeners. Shell integration must be enabled. */
  start(context: vscode.ExtensionContext): void {
    const disposable = vscode.window.onDidStartTerminalShellExecution((event) => {
      void this.watchExecution(event);
    });

    context.subscriptions.push(disposable);
    this.disposables.push(disposable);
  }

  /** Releases VS Code subscriptions during extension deactivation. */
  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  /**
   * Reads terminal output from the start of an execution and scans recent text.
   * The rolling buffer is bounded because bind failures are short messages.
   */
  private async watchExecution(event: vscode.TerminalShellExecutionStartEvent): Promise<void> {
    const settings = readPortManagerSettings();
    if (!settings.detectTerminalListenFailures && !settings.routeTerminalCommandsOnStart) {
      return;
    }

    if (await this.options.attachmentState?.isTerminalAttached(event.terminal)) {
      return;
    }

    if (
      settings.routeTerminalCommandsOnStart &&
      !shouldInjectTerminalHook(settings) &&
      (await this.offerPreflightRerun(event, settings))
    ) {
      return;
    }

    if (!settings.detectTerminalListenFailures) {
      return;
    }

    let recentOutput = "";
    let handledFailure = false;

    try {
      for await (const chunk of event.execution.read()) {
        recentOutput = `${recentOutput}${chunk}`.slice(-4000);
        const failure = detectTerminalListenFailure(recentOutput);

        if (failure === undefined || this.handledExecutions.has(event.execution)) {
          continue;
        }

        this.handledExecutions.add(event.execution);
        handledFailure = true;
        await this.offerRerun(event, failure.port, failure.host);
        return;
      }
    } catch (error) {
      if (handledFailure) {
        await showTerminalRerunError(error);
        return;
      }

      // Terminal streams can end abruptly when the terminal closes. The monitor
      // is opportunistic, so stream failures should not affect the extension.
    }
  }

  /** Offers a daemon-managed rerun as soon as a terminal command exposes a port. */
  private async offerPreflightRerun(
    event: vscode.TerminalShellExecutionStartEvent,
    settings: PortManagerSettings,
  ): Promise<boolean> {
    const commandLine = event.execution.commandLine.value.trim();
    const intent = detectTerminalPortIntent(commandLine);

    if (intent === undefined || this.promptedExecutions.has(event.execution)) {
      return false;
    }

    await this.options.processService.refresh();

    const owner = findPortOwner(this.options.processService.list(), intent.port);
    const shouldOfferRouting = settings.routingMode === "hashed" || owner !== undefined;

    if (!shouldOfferRouting) {
      return false;
    }

    this.promptedExecutions.add(event.execution);

    const reason = owner
      ? `Port ${intent.port} is occupied by ${owner.name}`
      : `Port ${intent.port} is a logical port in hashed routing mode`;
    const selection = await vscode.window.showWarningMessage(
      `${reason}. Stop this terminal command and rerun it through the daemon?`,
      "Rerun Routed",
      "Show Ports",
    );

    if (selection === "Show Ports") {
      await this.options.processService.refresh();
      await vscode.commands.executeCommand("workbench.view.extension.portManager");
      return false;
    }

    if (selection !== "Rerun Routed") {
      return false;
    }

    event.terminal.sendText("\x03", false);
    await this.startRoutedReplacement(event, intent.port, intent.host ?? settings.defaultHost);
    return true;
  }

  /** Offers a user-confirmed rerun through the agent-managed launch path. */
  private async offerRerun(
    event: vscode.TerminalShellExecutionStartEvent,
    requestedPort: number,
    detectedHost: string | undefined,
  ): Promise<void> {
    const settings = readPortManagerSettings();
    const commandLine = event.execution.commandLine.value.trim();
    await this.options.processService.refresh();

    const owner = this.options.processService
      .list()
      .find((process) => process.actualPort === requestedPort && process.status === "running");
    const ownerText = owner ? ` occupied by ${owner.name}` : " already in use";
    const selection = await vscode.window.showWarningMessage(
      `Port ${requestedPort} is${ownerText}. Rerun this terminal command through Port Manager?`,
      "Rerun Routed",
      "Show Ports",
    );

    if (selection === "Show Ports") {
      await this.options.processService.refresh();
      await vscode.commands.executeCommand("workbench.view.extension.portManager");
      return;
    }

    if (selection !== "Rerun Routed") {
      return;
    }

    await this.startRoutedReplacement(event, requestedPort, detectedHost);
  }

  /** Starts the terminal command through the daemon after it assigns the route. */
  private async startRoutedReplacement(
    event: vscode.TerminalShellExecutionStartEvent,
    requestedPort: number,
    detectedHost: string | undefined,
  ): Promise<void> {
    const settings = readPortManagerSettings();
    const commandLine = event.execution.commandLine.value.trim();
    const reroutableCommand = buildReroutableCommand(commandLine, requestedPort);
    const cwd = event.execution.cwd?.fsPath ?? getDefaultWorkspaceFolder() ?? process.cwd();
    const host = normalizeHost(detectedHost ?? settings.defaultHost, settings.defaultHost);
    const profile: ManagedProcessStartInput = {
      name: deriveProcessName(commandLine, cwd),
      command: reroutableCommand.command,
      cwd,
      requestedPort,
      host,
      injectionMode: reroutableCommand.injectionMode,
    };

    const managedProcess = await this.options.processService.startManagedProcess(profile, settings);

    if (managedProcess.requestedPort !== managedProcess.actualPort) {
      await vscode.window.showInformationMessage(
        `Rerouted ${managedProcess.name}: ${managedProcess.requestedPort} -> ${managedProcess.actualPort}`,
      );
    }
  }
}

/** Finds the current visible owner for a TCP port in the latest agent snapshot. */
function findPortOwner(processes: readonly ManagedProcess[], port: number): ManagedProcess | undefined {
  return processes.find((process) => process.actualPort === port && process.status === "running");
}

/** Uses workspace folder name as a stable default process label. */
function deriveProcessName(command: string, cwd: string): string {
  const commandName = command.split(/\s+/)[0];
  const folderName = path.basename(cwd);
  return folderName.length > 0 ? folderName : commandName || "Managed Process";
}

/** Returns the first workspace folder path for terminal reruns. */
function getDefaultWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Wildcard hosts are useful bind addresses but poor browser/scan labels.
 * Localhost is the safer target for rerunning local development servers.
 */
function normalizeHost(host: string, defaultHost: string): string {
  const trimmed = host.trim();

  if (trimmed === "*" || trimmed === "0.0.0.0" || trimmed === "::" || trimmed.length === 0) {
    return defaultHost;
  }

  return trimmed;
}

/** Shows rerun failures separately from harmless terminal stream interruptions. */
async function showTerminalRerunError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await vscode.window.showErrorMessage(`Port Manager routed rerun failed: ${message}`);
}

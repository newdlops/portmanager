import * as vscode from "vscode";
import { PortManagerTreeProvider } from "../ui/sidebar/port-manager-tree";
import { LocalAgentClient } from "./local-agent-client";
import { PortManagerCommandController } from "./commands";
import { TerminalConflictMonitor } from "./terminal-conflict-monitor";
import { configureTerminalHookEnvironment } from "./terminal-hook-environment";

/**
 * VS Code activation entry point for Port Manager.
 *
 * Activation composes the layers defined in AGENTS.md: core services receive
 * platform adapters through interfaces, UI reads from the registry, and command
 * handlers orchestrate user workflows.
 */
export function activate(context: vscode.ExtensionContext): void {
  const processService = new LocalAgentClient(context);
  const treeProvider = new PortManagerTreeProvider(processService);
  const commandController = new PortManagerCommandController({
    processService,
    treeProvider,
  });
  const terminalConflictMonitor = new TerminalConflictMonitor({
    processService,
  });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("portManager.processes", treeProvider),
    processService,
    treeProvider,
    commandController,
    terminalConflictMonitor,
    configureTerminalHookEnvironment(context),
  );

  commandController.register(context);
  terminalConflictMonitor.start(context);
  void processService.start().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Port Manager agent failed to start: ${message}`);
  });
}

/**
 * VS Code calls deactivate during extension shutdown. Resources are already
 * attached to context.subscriptions, so no explicit work is required here.
 */
export function deactivate(): void {
  // Extension resources are disposed by VS Code through context.subscriptions.
}

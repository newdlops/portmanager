import * as vscode from "vscode";
import { ManagedProcessRegistry } from "../core/process-registry";
import { PortRoutingService } from "../core/port-routing";
import { NodePortScanner } from "../platform/ports/node-port-scanner";
import { NodeProcessLauncher } from "../platform/process/node-process-launcher";
import { PortManagerTreeProvider } from "../ui/sidebar/port-manager-tree";
import { PortManagerCommandController } from "./commands";

/**
 * VS Code activation entry point for Port Manager.
 *
 * Activation composes the layers defined in AGENTS.md: core services receive
 * platform adapters through interfaces, UI reads from the registry, and command
 * handlers orchestrate user workflows.
 */
export function activate(context: vscode.ExtensionContext): void {
  const portScanner = new NodePortScanner();
  const routingService = new PortRoutingService(portScanner);
  const processLauncher = new NodeProcessLauncher();
  const registry = new ManagedProcessRegistry();
  const treeProvider = new PortManagerTreeProvider(registry);
  const commandController = new PortManagerCommandController({
    registry,
    routingService,
    launcher: processLauncher,
    treeProvider,
  });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("portManager.processes", treeProvider),
    treeProvider,
    commandController,
  );

  commandController.register(context);
}

/**
 * VS Code calls deactivate during extension shutdown. Resources are already
 * attached to context.subscriptions, so no explicit work is required here.
 */
export function deactivate(): void {
  // Extension resources are disposed by VS Code through context.subscriptions.
}

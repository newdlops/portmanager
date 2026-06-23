import * as vscode from "vscode";
import { PortManagerTreeProvider } from "../ui/sidebar/port-manager-tree";
import { LocalAgentClient } from "./local-agent-client";
import { PortManagerCommandController } from "./commands";
import { PortManagerNetworkService } from "./network-service";
import type { LogicalNetwork } from "../shared/types";

export interface PortManagerExtensionApi {
  /** Lists logical networks so terminal-owning extensions can choose one without importing UI code. */
  listLogicalNetworks(): readonly LogicalNetwork[];
  /** Returns a shell snippet that the caller can write into its own terminal stdin. */
  getTerminalRoutingScript(input: { readonly networkId: string }): Promise<string>;
  /** Returns a shell snippet that clears Port Manager routing variables. */
  getTerminalDetachScript(): string;
}

/**
 * VS Code activation entry point for Port Manager.
 *
 * Activation composes the layers defined in AGENTS.md: core services receive
 * platform adapters through interfaces, UI reads from the registry, and command
 * handlers orchestrate user workflows.
 */
export function activate(context: vscode.ExtensionContext): PortManagerExtensionApi {
  const processService = new LocalAgentClient(context);
  const networkService = new PortManagerNetworkService(context, processService);
  const treeProvider = new PortManagerTreeProvider(networkService);
  const commandController = new PortManagerCommandController({
    processService,
    networkService,
    treeProvider,
  });

  context.subscriptions.push(
    vscode.window.createTreeView("portManager.processes", {
      treeDataProvider: treeProvider,
      dragAndDropController: treeProvider,
    }),
    networkService,
    processService,
    treeProvider,
    commandController,
  );

  commandController.register(context);
  const startPromise = networkService.start();
  void startPromise.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Port Manager network service failed to start: ${message}`);
  });

  return {
    listLogicalNetworks: () => networkService.getSnapshot().networks,
    getTerminalRoutingScript: async (input) => {
      await startPromise;
      return networkService.createTerminalRoutingScript(input.networkId);
    },
    getTerminalDetachScript: () => networkService.createTerminalDetachScript(),
  };
}

/**
 * VS Code calls deactivate during extension shutdown. Resources are already
 * attached to context.subscriptions, so no explicit work is required here.
 */
export function deactivate(): void {
  // Extension resources are disposed by VS Code through context.subscriptions.
}

import * as vscode from "vscode";
import * as path from "node:path";
import { configureRouteTableStorageDirectory } from "../agent/route-table";
import { PortManagerTreeProvider } from "../ui/sidebar/port-manager-tree";
import { LocalAgentClient } from "./local-agent-client";
import { PortManagerCommandController } from "./commands";
import { PortManagerNetworkService } from "./network-service";
import type { DisposableLike, LogicalNetwork, NetworkSnapshot } from "../shared/types";

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
  configureRouteTableStorageDirectory(path.join(context.globalStorageUri.fsPath, "route-tables"));
  const processService = new LocalAgentClient(context);
  const networkService = new PortManagerNetworkService(context, processService);
  const treeProvider = new PortManagerTreeProvider(networkService);
  const commandController = new PortManagerCommandController({
    processService,
    networkService,
    treeProvider,
  });
  const statusBar = new PortManagerStatusBar(networkService);

  context.subscriptions.push(
    vscode.window.createTreeView("portManager.processes", {
      treeDataProvider: treeProvider,
      dragAndDropController: treeProvider,
    }),
    networkService,
    processService,
    treeProvider,
    commandController,
    statusBar,
  );

  commandController.register(context);
  void commandController.ensureShellHookAssets(context).catch(() => undefined);
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

/**
 * Keeps the current routing scope visible without making status bar rendering
 * depend on command or sidebar implementation details.
 */
class PortManagerStatusBar implements DisposableLike {
  private readonly item: vscode.StatusBarItem;
  private readonly sourceSubscription: DisposableLike;

  constructor(private readonly networkService: PortManagerNetworkService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "Port Manager Network";
    this.item.command = "portManager.showStatusMenu";
    this.sourceSubscription = this.networkService.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  /** Recomputes the compact status text from the latest logical network snapshot. */
  private update(): void {
    const snapshot = this.networkService.getSnapshot();
    void vscode.commands.executeCommand(
      "setContext",
      "portManager.isControlPlaneOwner",
      snapshot.controlPlane?.role === "owner",
    );
    this.item.text = formatStatusBarNetworkText(snapshot);
    this.item.tooltip = formatStatusBarNetworkTooltip(snapshot);
  }

  dispose(): void {
    this.sourceSubscription.dispose();
    this.item.dispose();
  }
}

/** Status text prefers the VS Code terminal default, then falls back to attached terminals. */
function formatStatusBarNetworkText(snapshot: NetworkSnapshot): string {
  const role = formatControlPlaneRoleLabel(snapshot);
  const windowNetwork = snapshot.networks.find(
    (network) => network.id === snapshot.vscodeWindowTerminalBinding?.networkId,
  );
  if (windowNetwork !== undefined) {
    return `$(vm-active) Port Manager ${role}: ${windowNetwork.name}`;
  }

  const attachedTerminals = snapshot.attachments.filter((attachment) => attachment.status === "attached");
  if (attachedTerminals.length === 0) {
    return `$(vm-outline) Port Manager ${role}: No network`;
  }

  const networkCounts = countAttachedTerminalsByNetwork(attachedTerminals);
  if (networkCounts.size === 1) {
    const [networkId, count] = [...networkCounts.entries()][0];
    const network = snapshot.networks.find((item) => item.id === networkId);
    return `$(plug) Port Manager ${role}: ${network?.name ?? networkId} (${count})`;
  }

  return `$(plug) Port Manager ${role}: ${attachedTerminals.length} terminals`;
}

/** Tooltip expands the status bar label into the current source of routing state. */
function formatStatusBarNetworkTooltip(snapshot: NetworkSnapshot): string {
  const roleLine = formatControlPlaneTooltipLine(snapshot);
  const windowNetwork = snapshot.networks.find(
    (network) => network.id === snapshot.vscodeWindowTerminalBinding?.networkId,
  );
  if (windowNetwork !== undefined && snapshot.vscodeWindowTerminalBinding !== undefined) {
    return [
      roleLine,
      `VS Code terminals use ${windowNetwork.name}.`,
      `${snapshot.vscodeWindowTerminalBinding.injectedTerminalCount} open terminal${snapshot.vscodeWindowTerminalBinding.injectedTerminalCount === 1 ? "" : "s"} updated.`,
      "Click to manage routing.",
    ].join("\n");
  }

  const attachedTerminals = snapshot.attachments.filter((attachment) => attachment.status === "attached");
  if (attachedTerminals.length === 0) {
    return `${roleLine}\nNo Port Manager network is active for this VS Code window. Click to choose one.`;
  }

  const lines = [roleLine, "Attached terminal routing:", ...formatAttachedTerminalSummaryLines(snapshot, attachedTerminals)];
  lines.push("Click to manage routing.");
  return lines.join("\n");
}

function formatControlPlaneRoleLabel(snapshot: NetworkSnapshot): string {
  switch (snapshot.controlPlane?.role) {
    case "owner":
      return "Owner";
    case "worker":
      return "Worker";
    case "unowned":
      return "No Owner";
    default:
      return "Unknown";
  }
}

function formatControlPlaneTooltipLine(snapshot: NetworkSnapshot): string {
  const controlPlane = snapshot.controlPlane;
  if (controlPlane === undefined) {
    return "Control plane: unknown";
  }

  if (controlPlane.role === "owner") {
    return `Control plane: owner in this window, pid ${controlPlane.currentPid}.`;
  }

  if (controlPlane.role === "worker") {
    return `Control plane: worker in this window, owner pid ${controlPlane.ownerPid ?? "unknown"}.`;
  }

  return "Control plane: no active owner.";
}

function countAttachedTerminalsByNetwork(
  attachments: readonly NetworkSnapshot["attachments"][number][],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    counts.set(attachment.networkId, (counts.get(attachment.networkId) ?? 0) + 1);
  }

  return counts;
}

function formatAttachedTerminalSummaryLines(
  snapshot: NetworkSnapshot,
  attachments: readonly NetworkSnapshot["attachments"][number][],
): string[] {
  return [...countAttachedTerminalsByNetwork(attachments).entries()].map(([networkId, count]) => {
    const network = snapshot.networks.find((item) => item.id === networkId);
    return `${network?.name ?? networkId}: ${count} terminal${count === 1 ? "" : "s"}`;
  });
}

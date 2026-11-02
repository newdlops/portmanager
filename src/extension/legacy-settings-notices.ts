import * as vscode from "vscode";
import type { LegacyNetworkSettingsNotice } from "../platform/process/network-file-scaffold";

/** Latest metadata per inactive source, scoped to this extension-host lifetime. */
const displayed = new Map<string, string>();

/**
 * Surface inactive originals without touching their bytes or blocking attach on
 * a user's response. Changed source metadata invalidates the prior dismissal.
 * Kept separate from scaffold so filesystem callers never depend on VS Code.
 */
export async function presentLegacySettingsNotices(
  networkName: string,
  notices: readonly LegacyNetworkSettingsNotice[],
): Promise<void> {
  for (const notice of notices) {
    if (displayed.get(notice.sourcePath) === notice.signature) continue;
    displayed.delete(notice.sourcePath);
    displayed.set(notice.sourcePath, notice.signature);
    if (displayed.size > 256) displayed.delete(displayed.keys().next().value!);
    try {
      const action = await vscode.window.showWarningMessage(
        `Legacy settings for ${JSON.stringify(networkName)} are no longer read: ${notice.sourcePath}. Edit ${notice.destinationPath} instead. Original files were preserved; later edits are not imported.`,
        "Open Active Settings",
      );
      if (action === "Open Active Settings") {
        await vscode.commands.executeCommand(notice.isDirectory ? "revealInExplorer" : "vscode.open", vscode.Uri.file(notice.destinationPath));
      }
    } catch (error) {
      // Notification actions run after attach, so keep their failure visible
      // without turning it into an unhandled background rejection.
      try {
        await vscode.window.showErrorMessage(`Could not open network settings: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // An already-disposed extension host cannot render another notification.
      }
    }
  }
}

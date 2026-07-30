import * as vscode from "vscode";
import { findSecureLocalTerminalBrowserUrls, type SecureLocalTerminalBrowserUrl } from "../platform/browser-terminal-links";
import type { DisposableLike } from "../shared/types";
import type { PortManagerNetworkService } from "./network-service";

/**
 * Routes terminal HTTP links for local development aliases through Port Manager's
 * browser URL handler. This catches Vite and framework log URLs that users click
 * directly in the terminal, bypassing sidebar commands.
 */

class SecureLocalTerminalLink extends vscode.TerminalLink {
  constructor(candidate: SecureLocalTerminalBrowserUrl, fallbackNetworkId?: string) {
    super(candidate.startIndex, candidate.length, "Open through Port Manager browser routing");
    this.url = candidate.url;
    this.fallbackNetworkId = fallbackNetworkId;
  }

  /** Original terminal URL to pass to Port Manager browser routing. */
  readonly url: string;
  /** Attached-terminal attribution used only for localhost forms. */
  readonly fallbackNetworkId: string | undefined;
}

export class PortManagerTerminalSecureBrowserLinkProvider
  implements vscode.TerminalLinkProvider<SecureLocalTerminalLink>, DisposableLike
{
  /** VS Code registration handle for the provider lifetime. */
  private readonly registration: DisposableLike;

  constructor(private readonly networkService: PortManagerNetworkService) {
    this.registration = vscode.window.registerTerminalLinkProvider(this);
  }

  async provideTerminalLinks(
    context: vscode.TerminalLinkContext,
    token: vscode.CancellationToken,
  ): Promise<SecureLocalTerminalLink[]> {
    if (token.isCancellationRequested) {
      return [];
    }

    const fallbackNetworkId = await this.networkService.getTerminalBrowserFallbackNetworkId(context.terminal);
    return findSecureLocalTerminalBrowserUrls(context.line).map(
      (candidate) => new SecureLocalTerminalLink(candidate, fallbackNetworkId),
    );
  }

  async handleTerminalLink(link: SecureLocalTerminalLink): Promise<void> {
    await this.networkService.openBrowserUrl(link.url, link.fallbackNetworkId);
  }

  dispose(): void {
    this.registration.dispose();
  }
}

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
  constructor(candidate: SecureLocalTerminalBrowserUrl) {
    super(candidate.startIndex, candidate.length, "Open through Port Manager browser routing");
    this.url = candidate.url;
  }

  /** Original terminal URL to pass to Port Manager browser routing. */
  readonly url: string;
}

export class PortManagerTerminalSecureBrowserLinkProvider
  implements vscode.TerminalLinkProvider<SecureLocalTerminalLink>, DisposableLike
{
  /** VS Code registration handle for the provider lifetime. */
  private readonly registration: DisposableLike;

  constructor(private readonly networkService: PortManagerNetworkService) {
    this.registration = vscode.window.registerTerminalLinkProvider(this);
  }

  provideTerminalLinks(
    context: vscode.TerminalLinkContext,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<SecureLocalTerminalLink[]> {
    if (token.isCancellationRequested) {
      return [];
    }

    return findSecureLocalTerminalBrowserUrls(context.line).map((candidate) => new SecureLocalTerminalLink(candidate));
  }

  async handleTerminalLink(link: SecureLocalTerminalLink): Promise<void> {
    await this.networkService.openBrowserUrl(link.url);
  }

  dispose(): void {
    this.registration.dispose();
  }
}

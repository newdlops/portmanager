/**
 * Finds local development URLs in terminal output that should be opened through
 * Port Manager's browser routing. The provider intentionally keeps only the URL
 * text here; secure-context handling now belongs to the DNS/TLS browser proxy.
 */

export interface SecureLocalTerminalBrowserUrl {
  /** Start offset within the terminal line reported by VS Code. */
  readonly startIndex: number;
  /** Length of the URL text after trimming shell/log punctuation. */
  readonly length: number;
  /** Exact URL that should be opened through Port Manager browser routing. */
  readonly url: string;
}

/** Public browser identity for one logical network. */
export interface NetworkBrowserTarget {
  readonly networkId: string;
  readonly routedLoopbackHost: string;
  readonly browserLoopbackHost: string;
  readonly publicHost: string;
  readonly publicProtocol: "http" | "https";
  readonly logicalPort: number;
  /** All exact aliases that may identify this network at the source origin. */
  readonly sourceHosts?: readonly string[];
  /** Concrete owner-selected listener port; omitted when no listener is published. */
  readonly publicPort?: number;
}

const TERMINAL_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g;
const SIMPLE_TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

export function findSecureLocalTerminalBrowserUrls(line: string): readonly SecureLocalTerminalBrowserUrl[] {
  const matches: SecureLocalTerminalBrowserUrl[] = [];

  for (const match of line.matchAll(TERMINAL_URL_PATTERN)) {
    const startIndex = match.index ?? 0;
    const url = trimTerminalUrl(match[0]);
    if (!isLocalDevelopmentUrl(url)) {
      continue;
    }

    matches.push({
      startIndex,
      length: url.length,
      url,
    });
  }

  return matches;
}

/**
 * Replaces only an exact logical-network authority with its browser alias.
 * Localhost is intentionally opt-in through fallbackNetworkId: a routed IP is
 * self-identifying, while plain localhost needs terminal/window attribution.
 */
export function resolveNetworkBrowserTargetUrl(
  value: string,
  targets: readonly NetworkBrowserTarget[],
  fallbackNetworkId?: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return value;
  }

  const sourcePort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
  const target = targets.find((candidate) => {
    const hosts = [candidate.routedLoopbackHost, candidate.browserLoopbackHost, candidate.publicHost]
      .concat(candidate.sourceHosts ?? [])
      .map((host) => host.toLowerCase());
    return hosts.includes(hostname);
  }) ?? (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    ? targets.find((candidate) => candidate.networkId === fallbackNetworkId)
    : undefined);
  if (target === undefined) {
    return value;
  }

  parsed.protocol = `${target.publicProtocol}:`;
  parsed.hostname = target.publicHost;
  parsed.port = String(sourcePort === target.logicalPort ? target.publicPort ?? sourcePort : sourcePort);
  return parsed.toString();
}

/** Returns terminal attribution only when all matching attachment rows agree. */
export function selectUniqueTerminalNetworkId(networkIds: Iterable<string>): string | undefined {
  const candidates = new Set(networkIds);
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

export interface TerminalNetworkAttributionCandidate {
  readonly networkId: string;
  readonly rootPid?: number;
  readonly processGroupId?: number;
  readonly terminalWindowId?: string;
}

/** Prefers explicit PID attribution and falls back to the window default only when absent. */
export function selectTerminalNetworkFallback(
  terminalPid: number | undefined,
  candidates: readonly TerminalNetworkAttributionCandidate[],
  windowNetworkId?: string,
): string | undefined {
  if (!Number.isInteger(terminalPid) || terminalPid === undefined || terminalPid <= 0) {
    return windowNetworkId;
  }
  const explicit = candidates.filter(
    (candidate) =>
      candidate.rootPid === terminalPid ||
      candidate.processGroupId === terminalPid ||
      candidate.terminalWindowId === `vscode:${terminalPid}`,
  );
  return explicit.length === 0 ? windowNetworkId : selectUniqueTerminalNetworkId(explicit.map((candidate) => candidate.networkId));
}

function isLocalDevelopmentUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  return isLocalDevelopmentHostname(parsed.hostname);
}

function isLocalDevelopmentHostname(hostname: string): boolean {
  // URL.hostname keeps IPv6 literals bracketed; compare the address form so loopback aliases are not missed.
  const normalized = hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.endsWith(".pm") ||
    (!normalized.includes(".") && normalized.length > 0)
  );
}

function trimTerminalUrl(value: string): string {
  let end = value.length;
  while (end > 0 && shouldTrimTrailingCharacter(value, end - 1)) {
    end -= 1;
  }

  return value.slice(0, end);
}

function shouldTrimTrailingCharacter(value: string, index: number): boolean {
  const character = value[index];
  if (character === undefined) {
    return false;
  }

  if (SIMPLE_TRAILING_PUNCTUATION.has(character)) {
    return true;
  }

  if (character === ")") {
    const prefix = value.slice(0, index + 1);
    return countCharacter(prefix, ")") > countCharacter(prefix, "(");
  }

  if (character === "]") {
    const prefix = value.slice(0, index + 1);
    return countCharacter(prefix, "]") > countCharacter(prefix, "[");
  }

  if (character === "}") {
    const prefix = value.slice(0, index + 1);
    return countCharacter(prefix, "}") > countCharacter(prefix, "{");
  }

  return false;
}

function countCharacter(value: string, expected: string): number {
  let count = 0;
  for (const character of value) {
    if (character === expected) {
      count += 1;
    }
  }

  return count;
}

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

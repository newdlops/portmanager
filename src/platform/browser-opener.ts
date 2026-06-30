import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Opens Port Manager-owned local development URLs in Chrome/Chromium with the
 * secure-context override required by browser APIs such as WebAuthn, clipboard,
 * service workers, and media capture.
 */

export interface SecureLocalBrowserOpenOptions {
  /** Parent directory for Chrome profiles dedicated to one local secure origin. */
  readonly userDataRoot: string;
  /** Optional test/override list of browser commands to try in order. */
  readonly executableCandidates?: readonly string[];
  /** Test seam for command launching; production uses detached browser processes. */
  readonly spawnBrowser?: BrowserProcessSpawner;
}

export type BrowserProcessSpawner = (command: string, args: readonly string[]) => Promise<boolean>;

/** Opens a local HTTP origin as secure in Chrome/Chromium, returning false when no supported browser is available. */
export async function openUrlWithSecureLocalOrigin(
  url: string,
  options: SecureLocalBrowserOpenOptions,
): Promise<boolean> {
  const secureOrigin = secureLocalOriginForUrl(url);
  if (secureOrigin === undefined) {
    return false;
  }

  const userDataDir = path.join(options.userDataRoot, profileDirectoryNameForOrigin(secureOrigin));
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = buildSecureLocalBrowserArgs(url, secureOrigin, userDataDir);
  const spawnBrowser = options.spawnBrowser ?? spawnDetachedBrowser;
  for (const candidate of options.executableCandidates ?? browserExecutableCandidates()) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) {
      continue;
    }

    if (await spawnBrowser(candidate, args)) {
      return true;
    }
  }

  return false;
}

/** Returns an exact origin only for local HTTP URLs that Port Manager can safely treat as secure. */
export function secureLocalOriginForUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "http:" || !isLocalDevelopmentHostname(parsed.hostname)) {
    return undefined;
  }

  return parsed.origin;
}

/** Builds Chrome/Chromium flags for a dedicated local development browser profile. */
export function buildSecureLocalBrowserArgs(url: string, secureOrigin: string, userDataDir: string): readonly string[] {
  return [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    `--unsafely-treat-insecure-origin-as-secure=${secureOrigin}`,
    url,
  ];
}

function profileDirectoryNameForOrigin(origin: string): string {
  return createHash("sha256").update(origin).digest("hex").slice(0, 16);
}

function isLocalDevelopmentHostname(hostname: string): boolean {
  // URL.hostname keeps IPv6 literals bracketed; compare the address form so loopback aliases are not missed.
  const normalized = hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    (!normalized.includes(".") && normalized.length > 0)
  );
}

function browserExecutableCandidates(): readonly string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/opt/homebrew/bin/chromium",
      "/usr/local/bin/chromium",
      "google-chrome",
      "google-chrome-stable",
      "chromium",
    ];
  }

  if (process.platform === "linux") {
    return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  }

  return [];
}

function spawnDetachedBrowser(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(opened);
    };

    child.once("error", () => finish(false));
    child.once("spawn", () => {
      child.unref();
      finish(true);
    });
  });
}

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TRUST_CACHE_TTL_MS = 30_000;

export type BrowserTlsTrustState = "checking" | "trusted" | "untrusted" | "unsupported";

export interface BrowserTlsTrustStatus {
  /** Keychain verification state for the currently generated leaf certificate. */
  readonly state: BrowserTlsTrustState;
  /** Actionable failure detail shown in diagnostics when verification fails. */
  readonly detail?: string;
}

interface BrowserTlsTrustCacheEntry {
  readonly materialSignature: string;
  readonly checkedAtMs: number;
  readonly status: BrowserTlsTrustStatus;
}

let cachedTrust: BrowserTlsTrustCacheEntry | undefined;
let trustRefreshInFlight:
  | { readonly materialSignature: string; readonly promise: Promise<BrowserTlsTrustStatus> }
  | undefined;

/**
 * Returns cached Keychain verification without spawning from TreeView rendering.
 * A changed certificate or expired cache reports `checking`; the extension
 * service schedules the asynchronous security(1) probe and repaints afterwards.
 */
export function readCachedBrowserTlsTrustStatus(
  caCertificatePath: string,
  leafCertificatePath: string,
  nowMs = Date.now(),
): BrowserTlsTrustStatus {
  if (process.platform !== "darwin") {
    return { state: "unsupported" };
  }

  const materialSignature = readMaterialSignature(caCertificatePath, leafCertificatePath);
  if (materialSignature === undefined) {
    return { state: "untrusted", detail: "TLS certificate material is missing or unreadable." };
  }
  if (
    cachedTrust?.materialSignature === materialSignature &&
    nowMs - cachedTrust.checkedAtMs < TRUST_CACHE_TTL_MS
  ) {
    return cachedTrust.status;
  }
  return { state: "checking", detail: "Checking macOS Keychain trust…" };
}

/** Runs macOS trust evaluation for the real leaf without supplying an ad-hoc root. */
export async function refreshBrowserTlsTrustStatus(
  caCertificatePath: string,
  leafCertificatePath: string,
): Promise<BrowserTlsTrustStatus> {
  if (process.platform !== "darwin") {
    return { state: "unsupported" };
  }
  const materialSignature = readMaterialSignature(caCertificatePath, leafCertificatePath);
  if (materialSignature === undefined) {
    const status = { state: "untrusted", detail: "TLS certificate material is missing or unreadable." } as const;
    cachedTrust = { materialSignature: "missing", checkedAtMs: Date.now(), status };
    return status;
  }
  if (trustRefreshInFlight?.materialSignature === materialSignature) {
    return trustRefreshInFlight.promise;
  }

  const refresh = execFileAsync(
    "/usr/bin/security",
    ["verify-cert", "-c", leafCertificatePath, "-p", "ssl", "-n", "localhost", "-L", "-q"],
    { timeout: 15_000, maxBuffer: 256 * 1024 },
  )
    .then((): BrowserTlsTrustStatus => ({ state: "trusted", detail: "Trusted by the macOS default Keychain search list." }))
    .catch((error): BrowserTlsTrustStatus | undefined =>
      isTrustVerificationVerdict(error) ? { state: "untrusted", detail: conciseTrustError(error) } : undefined,
    )
    .then((status): BrowserTlsTrustStatus => {
      if (status === undefined) {
        // No verdict (timeout or spawn failure on a loaded machine). Reporting
        // `untrusted` here made callers re-register the CA, which opens a macOS
        // password dialog although trust never changed. Keep the last result
        // for this material, otherwise stay `checking`, and cache neither.
        return cachedTrust?.materialSignature === materialSignature
          ? cachedTrust.status
          : { state: "checking", detail: "macOS Keychain trust check did not finish; it retries on the next refresh." };
      }
      // A privileged repair can rotate the CA while an older verification is
      // still running. Never publish the old result for the new material.
      if (readMaterialSignature(caCertificatePath, leafCertificatePath) === materialSignature) {
        cachedTrust = { materialSignature, checkedAtMs: Date.now(), status };
      }
      return status;
    })
    .finally(() => {
      if (trustRefreshInFlight?.promise === refresh) {
        trustRefreshInFlight = undefined;
      }
    });

  trustRefreshInFlight = { materialSignature, promise: refresh };
  return refresh;
}

/**
 * True only when `security verify-cert` ran to completion and rejected the
 * leaf (non-zero numeric exit). A timeout kill (`killed`) or a spawn failure
 * (string `code` such as `ENOENT`) says nothing about trust.
 */
export function isTrustVerificationVerdict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as { readonly code?: unknown; readonly killed?: unknown; readonly signal?: unknown };
  return typeof record.code === "number" && record.killed !== true && (record.signal === undefined || record.signal === null);
}

/** Forces the next status read to re-evaluate Keychain trust. */
export function invalidateBrowserTlsTrustStatus(): void {
  cachedTrust = undefined;
}

function readMaterialSignature(caCertificatePath: string, leafCertificatePath: string): string | undefined {
  try {
    const ca = fs.statSync(caCertificatePath);
    const leaf = fs.statSync(leafCertificatePath);
    // The CA participates because rotating only the root must invalidate a
    // previously successful leaf trust result.
    return [
      caCertificatePath,
      ca.size,
      ca.mtimeMs,
      ca.ctimeMs,
      leafCertificatePath,
      leaf.size,
      leaf.mtimeMs,
      leaf.ctimeMs,
    ].join(":");
  } catch {
    return undefined;
  }
}

function conciseTrustError(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "The Port Manager CA is not trusted by macOS Keychain.";
  }
  const record = error as { readonly stderr?: unknown; readonly stdout?: unknown; readonly message?: unknown };
  const detail = [record.stderr, record.stdout, record.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return detail.length === 0
    ? "The Port Manager CA is not trusted by macOS Keychain."
    : `macOS Keychain verification failed: ${detail.slice(0, 240)}`;
}

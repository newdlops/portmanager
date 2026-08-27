import { lookup as lookupHost } from "node:dns/promises";

const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;
const DEFAULT_SINGLE_LOOKUP_TIMEOUT_MS = 1_000;
const DEFAULT_RETRY_INTERVAL_MS = 200;

export interface BrowserDnsAliasVerificationRecord {
  readonly hostname: string;
  readonly secureHostname: string;
  readonly address: string;
}

export interface BrowserDnsAliasVerificationOptions {
  /** Injectable system lookup keeps resolver policy testable without editing /etc. */
  readonly lookupIpv4?: (hostname: string) => Promise<readonly string[]>;
  /** Allows mDNSResponder and split-DNS cache changes a bounded time to settle. */
  readonly settleTimeoutMs?: number;
  /** Bounds one stuck getaddrinfo attempt inside the overall settle window. */
  readonly singleLookupTimeoutMs?: number;
  readonly retryIntervalMs?: number;
}

/**
 * Proves that the OS public resolver path—not only Port Manager's files and
 * daemon state—returns the exact loopback address browsers will use.
 *
 * Both the readable single-label alias and the `.pm` TLS alias are checked.
 * Unexpected extra IPv4 answers are rejected because getaddrinfo/browser
 * ordering could otherwise select a stale address even when the expected one
 * is also present.
 */
export async function verifyBrowserDnsAliasesResolve(
  records: readonly BrowserDnsAliasVerificationRecord[],
  options: BrowserDnsAliasVerificationOptions = {},
): Promise<void> {
  const lookupIpv4 = options.lookupIpv4 ?? systemIpv4Lookup;
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const singleLookupTimeoutMs = options.singleLookupTimeoutMs ?? DEFAULT_SINGLE_LOOKUP_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const checks = records.flatMap((record) =>
    [record.hostname, record.secureHostname].map((hostname) =>
      verifyOneBrowserDnsAlias(
        hostname,
        record.address,
        lookupIpv4,
        settleTimeoutMs,
        singleLookupTimeoutMs,
        retryIntervalMs,
      ),
    ),
  );
  await Promise.all(checks);
}

/** Retries transient post-flush misses but preserves the final concrete error. */
async function verifyOneBrowserDnsAlias(
  hostname: string,
  expectedAddress: string,
  lookupIpv4: (hostname: string) => Promise<readonly string[]>,
  settleTimeoutMs: number,
  singleLookupTimeoutMs: number,
  retryIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, settleTimeoutMs);
  let lastError: Error | undefined;

  do {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const actualAddresses = await promiseWithTimeout(
        lookupIpv4(hostname),
        Math.min(Math.max(1, singleLookupTimeoutMs), remainingMs),
        `macOS DNS lookup timed out for ${hostname}`,
      );
      const uniqueAddresses = [...new Set(actualAddresses)];
      if (uniqueAddresses.length > 0 && uniqueAddresses.every((address) => address === expectedAddress)) {
        return;
      }
      lastError = new Error(
        `macOS resolved Port Manager alias ${hostname} to ${uniqueAddresses.join(", ") || "no IPv4 address"}; expected only ${expectedAddress}.`,
      );
    } catch (error) {
      lastError = new Error(`macOS cannot resolve Port Manager alias ${hostname} to ${expectedAddress}.`, { cause: error });
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await delay(Math.min(Math.max(1, retryIntervalMs), remainingMs));
  } while (true);

  throw lastError ?? new Error(`macOS cannot verify Port Manager alias ${hostname}.`);
}

/** Uses getaddrinfo so macOS /etc/resolver and /etc/hosts behavior is exercised. */
async function systemIpv4Lookup(hostname: string): Promise<readonly string[]> {
  const answers = await lookupHost(hostname, { family: 4, all: true });
  return answers.map((answer) => answer.address);
}

/** Bounds external resolver checks while still observing late rejection. */
async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

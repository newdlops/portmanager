/**
 * Per-client attribution memo for the logical port gateway.
 *
 * Every accepted loopback connection is classified once per client process and
 * the verdict is cached by (pid, startTime). A connection storm from the same
 * client then reuses the verdict instead of re-running native/process lookups.
 * Network verdicts expire faster than non-network ones because a terminal can
 * detach without the pid changing; the whole cache is also cleared by the owner
 * when the attachment set changes.
 *
 * The start time is part of the key so a reused pid never inherits a stale
 * verdict. A clock is injectable so tests can advance TTLs deterministically.
 */

/** Sentinel stored for a client that belongs to no logical network. */
export const ROUTER_NON_NETWORK_VERDICT = " non-network";

export interface RouterVerdictCacheOptions {
  readonly networkTtlMs: number;
  readonly nonNetworkTtlMs: number;
  readonly maxEntries: number;
  /** Monotonic-enough millisecond clock; defaults to Date.now. */
  readonly now?: () => number;
}

interface RouterVerdictCacheEntry {
  readonly verdict: string;
  readonly expiresAtMs: number;
}

export class RouterVerdictCache {
  private readonly entries = new Map<string, RouterVerdictCacheEntry>();
  private readonly now: () => number;

  constructor(private readonly options: RouterVerdictCacheOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns the cached verdict for a client, or undefined when absent/expired. */
  read(pid: number, startTime: string | undefined): string | undefined {
    const key = this.key(pid, startTime);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.verdict;
  }

  /** Records a verdict, applying the TTL that matches its kind. */
  store(pid: number, startTime: string | undefined, verdict: string): void {
    const ttl = verdict === ROUTER_NON_NETWORK_VERDICT ? this.options.nonNetworkTtlMs : this.options.networkTtlMs;
    this.entries.set(this.key(pid, startTime), { verdict, expiresAtMs: this.now() + ttl });
    if (this.entries.size > this.options.maxEntries) {
      this.pruneExpired();
    }
  }

  /** Removes every verdict, used when attachments change under the client. */
  clear(): void {
    this.entries.clear();
  }

  /** Test/inspection helper for the current live entry count. */
  get size(): number {
    return this.entries.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
      }
    }
  }

  private key(pid: number, startTime: string | undefined): string {
    return `${pid}:${startTime ?? ""}`;
  }
}

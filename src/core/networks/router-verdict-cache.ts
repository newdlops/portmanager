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
  /** Elapsed millisecond clock; defaults to performance.now, independent of wall time. */
  readonly now?: () => number;
}

interface RouterVerdictCacheEntry {
  readonly verdict: string;
  readonly expiresAtMs: number;
}

export class RouterVerdictCache {
  private readonly entries = new Map<string, RouterVerdictCacheEntry>();
  private readonly now: () => number;
  /** Full expiry sweeps are throttled; a burst evicts its oldest key in O(1). */
  private nextPruneAtMs = 0;

  constructor(private readonly options: RouterVerdictCacheOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  /** Returns the cached verdict for a client, or undefined when absent/expired. */
  read(pid: number, startTime: string | undefined): string | undefined {
    // Without a birth identity, a recycled PID cannot be distinguished from
    // the previous client. Resolve that connection again rather than guessing.
    if (!this.hasIdentity(pid, startTime)) {
      return undefined;
    }
    const key = this.key(pid, startTime);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Map insertion order is the eviction order; reads keep busy clients hot
    // without extending the attachment-sensitive TTL.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.verdict;
  }

  /** Records a verdict, applying the TTL that matches its kind. */
  store(pid: number, startTime: string | undefined, verdict: string): void {
    if (!this.hasIdentity(pid, startTime) || this.options.maxEntries <= 0) {
      return;
    }
    const ttl = verdict === ROUTER_NON_NETWORK_VERDICT ? this.options.nonNetworkTtlMs : this.options.networkTtlMs;
    const key = this.key(pid, startTime);
    this.entries.delete(key);
    this.entries.set(key, { verdict, expiresAtMs: this.now() + ttl });
    if (this.entries.size > this.options.maxEntries) {
      const nowMs = this.now();
      if (nowMs >= this.nextPruneAtMs) {
        this.pruneExpired();
        this.nextPruneAtMs = nowMs + 1_000;
      }
      // A burst of live identities must remain bounded too. Evicting a verdict
      // merely causes a fresh attribution; it never chooses another network.
      while (this.entries.size > this.options.maxEntries) {
        this.entries.delete(this.entries.keys().next().value!);
      }
    }
  }

  /** Removes every verdict, used when attachments change under the client. */
  clear(): void {
    this.entries.clear();
    this.nextPruneAtMs = 0;
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

  private hasIdentity(pid: number, startTime: string | undefined): boolean {
    return Number.isSafeInteger(pid) && pid > 0 && startTime !== undefined && startTime.trim().length > 0;
  }
}

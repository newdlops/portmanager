import type { AgentBrowserDnsSyncResult } from "../shared/types";

export interface BrowserDnsSyncBatch { readonly records: string; readonly revision?: string; readonly sharedStatePath?: string; readonly signature: string; }
export type RejectedResolution = { readonly kind: "retry" | "drop" } | { readonly kind: "replace"; readonly batch: BrowserDnsSyncBatch };

/** Sole latest-value queue for daemon DNS publication; scheduling is injectable for deterministic tests. */
export class BrowserDnsSyncCoordinator {
  private queued: BrowserDnsSyncBatch | undefined; private active: Promise<void> | undefined; private retryTimer: unknown; private attempt = 0; private disposed = false;
  constructor(private readonly deps: {
    send(batch: BrowserDnsSyncBatch): Promise<AgentBrowserDnsSyncResult>;
    resolveRejected(batch: BrowserDnsSyncBatch): RejectedResolution;
    onResult(batch: BrowserDnsSyncBatch, result: AgentBrowserDnsSyncResult): void;
    onError(batch: BrowserDnsSyncBatch): void;
    schedule(delay: number, callback: () => void): unknown;
    cancel(timer: unknown): void;
  }) {}
  enqueue(batch: BrowserDnsSyncBatch): void { if (this.disposed) return; this.queued = batch; if (!this.active && this.retryTimer === undefined) this.start(); }
  waitForCurrentDrain(): Promise<void> { return this.active ?? Promise.resolve(); }
  dispose(): void { this.disposed = true; if (this.retryTimer !== undefined) this.deps.cancel(this.retryTimer); this.retryTimer = undefined; this.queued = undefined; }
  private start(): void { this.active = this.drain().finally(() => { this.active = undefined; }); }
  private async drain(): Promise<void> { while (!this.disposed && this.queued) { const batch = this.queued; this.queued = undefined; try { const result = await this.deps.send(batch); this.deps.onResult(batch, result); if (result.applied !== false) { this.attempt = 0; continue; } const resolution = this.deps.resolveRejected(batch); if (resolution.kind === "drop") continue; this.queued = resolution.kind === "replace" ? resolution.batch : (this.queued ?? batch); } catch { this.deps.onError(batch); this.queued ??= batch; } this.retry(); return; } }
  private retry(): void { if (this.retryTimer !== undefined || this.disposed) return; const delay = Math.min(5000, 100 * 2 ** Math.min(this.attempt++, 5)); this.retryTimer = this.deps.schedule(delay, () => { this.retryTimer = undefined; if (!this.active && this.queued) this.start(); }); }
}

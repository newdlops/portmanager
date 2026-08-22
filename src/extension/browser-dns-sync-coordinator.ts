import type { AgentBrowserDnsSyncResult } from "../shared/types";

export interface BrowserDnsSyncBatch {
  readonly records: string;
  readonly revision?: string;
  readonly sharedStatePath?: string;
  readonly signature: string;
}

export type RejectedResolution =
  | { readonly kind: "retry" | "drop" }
  | { readonly kind: "replace"; readonly batch: BrowserDnsSyncBatch };

/**
 * Publishes only the latest DNS table while keeping daemon requests single-flight.
 *
 * The runner owns its lifecycle until it has atomically cleared `active`. This
 * matters at promise-settlement boundaries: a batch queued after `drain()` has
 * inspected the queue but before an outer `finally()` runs must start another
 * drain instead of waiting forever for an unrelated registry event.
 */
export class BrowserDnsSyncCoordinator {
  /** Latest desired full-table replacement; newer batches supersede older ones. */
  private queued: BrowserDnsSyncBatch | undefined;

  /** Current drain generation, including its atomic handoff to a follow-up drain. */
  private active: Promise<void> | undefined;

  /** Backoff timer retained only after a transport, fence, or bind failure. */
  private retryTimer: unknown;

  /** Consecutive retry count used to calculate bounded exponential backoff. */
  private attempt = 0;

  private disposed = false;

  constructor(
    private readonly deps: {
      send(batch: BrowserDnsSyncBatch): Promise<AgentBrowserDnsSyncResult>;
      resolveRejected(batch: BrowserDnsSyncBatch): RejectedResolution;
      onResult(batch: BrowserDnsSyncBatch, result: AgentBrowserDnsSyncResult): void;
      onError(batch: BrowserDnsSyncBatch): void;
      schedule(delay: number, callback: () => void): unknown;
      cancel(timer: unknown): void;
    },
  ) {}

  enqueue(batch: BrowserDnsSyncBatch): void {
    if (this.disposed) {
      return;
    }

    this.queued = batch;
    if (this.active === undefined && this.retryTimer === undefined) {
      this.start();
    }
  }

  /**
   * Waits for the active generation and any drain handed off while it settles.
   * A scheduled failure retry is intentionally excluded so passive callers do
   * not wait forever when the daemon is unavailable.
   */
  async waitForCurrentDrain(): Promise<void> {
    let active = this.active;
    while (active !== undefined) {
      await active;
      active = this.active;
    }
  }

  /** Forces a user-driven repair past an existing backoff and awaits that pass. */
  async flushPendingNow(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.retryTimer !== undefined) {
      this.deps.cancel(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.active === undefined && this.queued !== undefined) {
      this.start();
    }
    await this.waitForCurrentDrain();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) {
      this.deps.cancel(this.retryTimer);
    }
    this.retryTimer = undefined;
    this.queued = undefined;
  }

  private start(): void {
    if (this.disposed || this.active !== undefined || this.queued === undefined) {
      return;
    }

    this.active = this.runDrain();
  }

  /** Clears the active generation and closes the settlement-edge lost-wakeup window. */
  private async runDrain(): Promise<void> {
    try {
      await this.drain();
    } finally {
      this.active = undefined;
      if (!this.disposed && this.retryTimer === undefined && this.queued !== undefined) {
        this.start();
      }
    }
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.queued !== undefined) {
      const batch = this.queued;
      this.queued = undefined;

      try {
        const result = await this.deps.send(batch);
        this.deps.onResult(batch, result);

        if (result.applied === false) {
          const resolution = this.deps.resolveRejected(batch);
          if (resolution.kind === "drop") {
            this.attempt = 0;
            continue;
          }
          this.queued = resolution.kind === "replace" ? resolution.batch : (this.queued ?? batch);
        } else if (result.running) {
          this.attempt = 0;
          continue;
        } else {
          /*
           * The record table may be durable while the UDP bind is still down.
           * Replaying the same revision crosses both native and Node fallback
           * bind boundaries, so recovery must not depend on another UI event.
           */
          this.queued ??= batch;
        }
      } catch {
        this.deps.onError(batch);
        this.queued ??= batch;
      }

      this.retry();
      return;
    }
  }

  private retry(): void {
    if (this.retryTimer !== undefined || this.disposed) {
      return;
    }

    const delay = Math.min(5_000, 100 * 2 ** Math.min(this.attempt++, 5));
    this.retryTimer = this.deps.schedule(delay, () => {
      this.retryTimer = undefined;
      if (this.active === undefined && this.queued !== undefined) {
        this.start();
      }
    });
  }
}

import type { AgentDaemonStatus } from "../shared/types";

/**
 * Minimal daemon boundary needed during owner startup.
 *
 * Keeping this smaller than PortManagerProcessService makes the generation
 * transition testable without an extension host while production still uses
 * the full process service implementation.
 */
export interface DaemonLifecyclePort {
  /** Returns the latest daemon status after each lifecycle operation. */
  getDaemonStatus(): AgentDaemonStatus;
  /** Connects to an existing daemon or starts one when disconnected. */
  start(): Promise<void>;
  /** Replaces a daemon that belongs to an older extension generation. */
  restartDaemon(options: { readonly refreshSnapshot: false }): Promise<void>;
  /** Scans listeners and publishes the authoritative generated route files. */
  repairRoutingState(): Promise<void>;
}

/** Mutable restart gate shared with the caller so failed restarts retain their backoff. */
export interface DaemonRestartBackoff {
  untilMs: number;
}

export interface DaemonLifecycleConvergenceOptions {
  /** Existing retry gate owned by the network service. */
  readonly restartBackoff: DaemonRestartBackoff;
  /** Delay retained after a failed stale-generation replacement. */
  readonly restartBackoffMs: number;
  /** Rehydration already forces repair separately, so it can defer this scan. */
  readonly repairRoutingAfterTransition: boolean;
  /** Injectable clock keeps the backoff decision deterministic in unit tests. */
  readonly nowMs?: () => number;
}

export interface DaemonLifecycleConvergenceResult {
  /** A connection or daemon generation changed during this invocation. */
  readonly transitioned: boolean;
  /** The daemon is connected and current, so downstream reconciliation may proceed. */
  readonly ready: boolean;
}

/**
 * Runs owner-only route consumers only after daemon convergence published an
 * authoritative route view. Returning false makes an incomplete generation a
 * terminal result for this pass instead of silently continuing with stale files.
 */
export async function continueWhenDaemonLifecycleReady(
  result: DaemonLifecycleConvergenceResult,
  continuation: () => Promise<void>,
): Promise<boolean> {
  if (!result.ready) {
    return false;
  }

  await continuation();
  return true;
}

/**
 * Converges one daemon lifecycle pass before any owner-only route consumers run.
 *
 * A disconnected start can attach to a stale singleton, so status is read again
 * before deciding readiness. A successful connect or replacement has one
 * authoritative repair publication, preventing generated files from exposing a
 * stale daemon generation to downstream proxy and router reconciliation.
 */
export async function convergeDaemonLifecycle(
  daemon: DaemonLifecyclePort,
  options: DaemonLifecycleConvergenceOptions,
): Promise<DaemonLifecycleConvergenceResult> {
  let transitioned = false;
  let status = daemon.getDaemonStatus();

  if (status.status !== "running") {
    await daemon.start();
    transitioned = true;
    // start() may have connected to a pre-existing old daemon rather than
    // spawning the current build, so never reuse the disconnected snapshot.
    status = daemon.getDaemonStatus();
  }

  if (status.status !== "running") {
    return { transitioned, ready: false };
  }

  if (status.restartRequired) {
    const nowMs = options.nowMs?.() ?? Date.now();
    if (nowMs < options.restartBackoff.untilMs) {
      return { transitioned, ready: false };
    }

    // Set before awaiting so a failed replacement cannot cause concurrent
    // owner passes to repeatedly terminate the same stale daemon.
    options.restartBackoff.untilMs = nowMs + options.restartBackoffMs;
    await daemon.restartDaemon({ refreshSnapshot: false });
    transitioned = true;
    status = daemon.getDaemonStatus();
    if (status.status !== "running" || status.restartRequired) {
      return { transitioned, ready: false };
    }
    options.restartBackoff.untilMs = 0;
  }

  if (status.status !== "running" || status.restartRequired) {
    return { transitioned, ready: false };
  }

  if (transitioned && options.repairRoutingAfterTransition) {
    await daemon.repairRoutingState();
  }

  return { transitioned, ready: true };
}

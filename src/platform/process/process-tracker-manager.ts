import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DisposableLike } from "../../shared/types";
import { buildNodeRuntimeEnvironment } from "./node-runtime";

/**
 * Drives the native process-membership tracker.
 *
 * The tracker maintains "which logical network does this process belong to" from
 * the attached shell subtree, without injecting an environment variable and
 * without losing processes that daemonize or reparent. This manager feeds it the
 * attached shell roots and answers per-connection network queries for the mux
 * resolver.
 */

export interface ProcessTrackerOptions {
  /** Native tracker helper path; when absent the manager is inert. */
  readonly trackerPath?: string;
  /** Per-query timeout before falling back to other attribution. */
  readonly queryTimeoutMs?: number;
}

const DEFAULT_QUERY_TIMEOUT_MS = 400;

export class ProcessTrackerManager implements DisposableLike {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  /** Root pid -> network id currently declared to the tracker. */
  private trackedRoots = new Map<number, string>();
  private readonly pendingQueries = new Map<number, Array<(networkId: string | undefined) => void>>();
  private disposed = false;

  constructor(private readonly options: ProcessTrackerOptions = {}) {}

  /**
   * Reconciles the tracker's tracked roots with the current attachment set.
   * New roots are TRACKed; networks no longer present are UNTRACKed.
   */
  syncTrackedRoots(roots: ReadonlyMap<number, string>): void {
    if (this.options.trackerPath === undefined) {
      return;
    }
    const child = this.ensureChild();
    if (child === undefined) {
      return;
    }

    const previousNetworks = new Set(this.trackedRoots.values());
    const nextNetworks = new Set(roots.values());

    for (const [rootPid, networkId] of roots) {
      if (this.trackedRoots.get(rootPid) !== networkId) {
        this.write(`TRACK\t${rootPid}\t${networkId}\n`);
      }
    }
    for (const networkId of previousNetworks) {
      if (!nextNetworks.has(networkId)) {
        this.write(`UNTRACK\t${networkId}\n`);
      }
    }

    this.trackedRoots = new Map(roots);
  }

  /** Resolves the network id for a client pid, or undefined when unattributed. */
  queryNetwork(pid: number): Promise<string | undefined> {
    if (this.options.trackerPath === undefined || !Number.isInteger(pid) || pid <= 0) {
      return Promise.resolve(undefined);
    }
    const child = this.ensureChild();
    if (child === undefined) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const waiters = this.pendingQueries.get(pid) ?? [];
      const timer = setTimeout(() => {
        this.removeWaiter(pid, settle);
        resolve(undefined);
      }, this.options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
      const settle = (networkId: string | undefined) => {
        clearTimeout(timer);
        resolve(networkId);
      };
      waiters.push(settle);
      this.pendingQueries.set(pid, waiters);
      this.write(`QUERY\t${pid}\n`);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.pendingQueries.clear();
    this.trackedRoots.clear();
    if (this.child !== undefined) {
      this.child.kill("SIGTERM");
      this.child = undefined;
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams | undefined {
    if (this.disposed || this.options.trackerPath === undefined) {
      return undefined;
    }
    if (this.child !== undefined) {
      return this.child;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      // A sanitized runtime env keeps the tracker's own process off the hook path.
      child = spawn(this.options.trackerPath, [], { env: buildNodeRuntimeEnvironment() });
    } catch {
      return undefined;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.stdoutBuffer = "";
        // Re-declare roots on the next sync by clearing the mirror.
        this.trackedRoots = new Map();
        this.failPendingQueries();
      }
    });
    child.on("error", () => {
      if (this.child === child) {
        this.child = undefined;
        this.failPendingQueries();
      }
    });

    this.child = child;
    // Re-assert any roots we already know about after a respawn.
    if (this.trackedRoots.size > 0) {
      const roots = this.trackedRoots;
      this.trackedRoots = new Map();
      this.syncTrackedRoots(roots);
    }
    return child;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const lineEnd = this.stdoutBuffer.indexOf("\n");
      if (lineEnd < 0) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const parts = line.split("\t");
    if (parts[0] !== "NETWORK" || parts.length < 3) {
      return;
    }
    const pid = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isInteger(pid)) {
      return;
    }
    const networkId = parts[2] === "-" || parts[2] === undefined || parts[2] === "" ? undefined : parts[2];
    const waiters = this.pendingQueries.get(pid);
    if (waiters === undefined) {
      return;
    }
    this.pendingQueries.delete(pid);
    for (const waiter of waiters) {
      waiter(networkId);
    }
  }

  private removeWaiter(pid: number, waiter: (networkId: string | undefined) => void): void {
    const waiters = this.pendingQueries.get(pid);
    if (waiters === undefined) {
      return;
    }
    const index = waiters.indexOf(waiter);
    if (index >= 0) {
      waiters.splice(index, 1);
    }
    if (waiters.length === 0) {
      this.pendingQueries.delete(pid);
    }
  }

  private failPendingQueries(): void {
    for (const waiters of this.pendingQueries.values()) {
      for (const waiter of waiters) {
        waiter(undefined);
      }
    }
    this.pendingQueries.clear();
  }

  private write(line: string): void {
    if (this.child === undefined || this.child.stdin.destroyed) {
      return;
    }
    this.child.stdin.write(line, "utf8");
  }
}

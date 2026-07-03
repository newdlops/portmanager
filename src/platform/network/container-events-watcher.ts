import { spawn, type ChildProcess } from "node:child_process";
import type { ContainerRuntimeSettings } from "../../shared/types";

/**
 * Streams container lifecycle events from the configured runtime CLI.
 *
 * While the stream is healthy the extension does not need fast Docker polling:
 * `docker events` blocks server-side and costs nothing between events, then
 * wakes the reconcile loop the moment a container is started, stopped, or
 * recreated. When the stream cannot start (runtime missing or daemon down) the
 * watcher retries with backoff and callers fall back to their polling cadence.
 */

const EVENT_DEBOUNCE_MS = 500;
const RESTART_BACKOFF_INITIAL_MS = 30_000;
const RESTART_BACKOFF_MAX_MS = 300_000;
// A stream that survives this long proves the runtime accepted it, so the next
// failure restarts the backoff ladder from the beginning.
const HEALTHY_STREAM_RESET_MS = 60_000;

/** Container/network actions that can change published ports or routing targets. */
const ROUTING_RELEVANT_ACTIONS = new Set([
  "create",
  "start",
  "restart",
  "stop",
  "kill",
  "die",
  "destroy",
  "remove",
  "rename",
  "update",
  "pause",
  "unpause",
  "connect",
  "disconnect",
]);

export interface ContainerEventsWatcherOptions {
  /** Reads the runtime preference lazily so setting changes apply on restart. */
  readonly readSettings: () => ContainerRuntimeSettings;
  /** Debounced notification that at least one routing-relevant event arrived. */
  readonly onEvent: () => void;
  /** Injectable spawner for unit tests. */
  readonly spawnProcess?: typeof spawn;
}

export class ContainerEventsWatcher {
  private child: ChildProcess | undefined;

  private disposed = false;

  /** True after the stream produced output or stayed alive long enough to trust. */
  private streamHealthy = false;

  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  private restartBackoffMs = RESTART_BACKOFF_INITIAL_MS;

  private startedAtMs = 0;

  /** Remaining runtime executables to try for the current start attempt. */
  private executableCandidates: readonly string[] = [];

  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: ContainerEventsWatcherOptions) {
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  start(): void {
    if (this.disposed || this.child !== undefined) {
      return;
    }

    this.executableCandidates = runtimeExecutableCandidates(this.options.readSettings());
    this.startNextCandidate();
  }

  /** True while an event stream is attached to a live runtime daemon. */
  isHealthy(): boolean {
    return this.child !== undefined && this.streamHealthy;
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    this.stopChild();
  }

  private startNextCandidate(): void {
    if (this.disposed) {
      return;
    }

    const [executable, ...remaining] = this.executableCandidates;
    this.executableCandidates = remaining;

    if (executable === undefined) {
      this.scheduleRestart();
      return;
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(
        executable,
        [
          "events",
          "--format",
          "{{json .}}",
          "--filter",
          "type=container",
          "--filter",
          "type=network",
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
    } catch {
      this.startNextCandidate();
      return;
    }

    this.child = child;
    this.streamHealthy = false;
    this.startedAtMs = Date.now();

    let pendingLine = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.child !== child) {
        return;
      }

      // Any output proves the runtime accepted the stream subscription.
      this.streamHealthy = true;
      const buffered = pendingLine + chunk;
      const lastNewlineIndex = buffered.lastIndexOf("\n");
      const completeLines = lastNewlineIndex < 0 ? "" : buffered.slice(0, lastNewlineIndex + 1);
      pendingLine = lastNewlineIndex < 0 ? buffered : buffered.slice(lastNewlineIndex + 1);
      // Cap the partial-line buffer; event lines are short and a runaway
      // buffer would mean the stream is not line-oriented JSON after all.
      if (pendingLine.length > 64 * 1024) {
        pendingLine = "";
      }

      if (chunkContainsRoutingRelevantEvent(completeLines)) {
        this.queueEventNotification();
      }
    });
    child.on("error", () => {
      this.handleChildEnd(child);
    });
    child.on("exit", () => {
      this.handleChildEnd(child);
    });

    /*
     * `docker events` emits nothing until the first event, so silence is not
     * failure. Surviving the probation window means the daemon accepted the
     * stream; immediate exit falls through to the next runtime or backoff.
     */
    const healthProbeTimer = setTimeout(() => {
      if (this.child === child && child.exitCode === null && !child.killed) {
        this.streamHealthy = true;
      }
    }, 1_000);
    healthProbeTimer.unref?.();
  }

  private handleChildEnd(child: ChildProcess): void {
    if (this.child !== child) {
      return;
    }

    const wasHealthy = this.streamHealthy;
    const lifetimeMs = Date.now() - this.startedAtMs;
    this.child = undefined;
    this.streamHealthy = false;

    if (this.disposed) {
      return;
    }

    if (!wasHealthy && this.executableCandidates.length > 0) {
      this.startNextCandidate();
      return;
    }

    if (wasHealthy && lifetimeMs >= HEALTHY_STREAM_RESET_MS) {
      this.restartBackoffMs = RESTART_BACKOFF_INITIAL_MS;
    }

    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer !== undefined) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.disposed || this.child !== undefined) {
        return;
      }

      this.executableCandidates = runtimeExecutableCandidates(this.options.readSettings());
      this.startNextCandidate();
    }, this.restartBackoffMs);
    this.restartTimer.unref?.();
    this.restartBackoffMs = Math.min(this.restartBackoffMs * 2, RESTART_BACKOFF_MAX_MS);
  }

  private queueEventNotification(): void {
    if (this.disposed || this.debounceTimer !== undefined) {
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (!this.disposed) {
        this.options.onEvent();
      }
    }, EVENT_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = undefined;
    this.streamHealthy = false;

    if (child === undefined) {
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // The stream process may already have exited with the runtime daemon.
    }
  }
}

function runtimeExecutableCandidates(settings: ContainerRuntimeSettings): readonly string[] {
  switch (settings.containerRuntime) {
    case "docker":
      return ["docker"];
    case "podman":
      return ["podman"];
    default:
      return ["docker", "podman"];
  }
}

/** Parses stream lines defensively; unknown shapes never wake the reconcile loop. */
export function chunkContainsRoutingRelevantEvent(chunk: string): boolean {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const action = readEventAction(record.Action ?? record.action ?? record.Status ?? record.status);
    if (action !== undefined && ROUTING_RELEVANT_ACTIONS.has(action)) {
      return true;
    }
  }

  return false;
}

/** Normalizes actions such as "exec_create: sh" or "health_status: healthy" to their base verb. */
function readEventAction(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value.split(":", 1)[0].trim().toLowerCase();
}

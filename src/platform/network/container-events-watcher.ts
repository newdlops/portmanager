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
  readonly onEvent: (changes: readonly ContainerRuntimeChange[]) => void | Promise<void>;
  /** Injectable spawner for unit tests. */
  readonly spawnProcess?: typeof spawn;
}

/** A missing project means the runtime changed without enough metadata to narrow reconciliation. */
export interface ContainerRuntimeChange {
  readonly runtime: "docker" | "podman";
  readonly composeProject?: string;
  /** Network connect/disconnect events often identify only their container. */
  readonly containerId?: string;
}

/** Links unlabelled network events to labelled container events in the same bounded batch. */
interface PendingContainerChanges {
  readonly projects: Set<string>;
  readonly containers: Map<string, string | undefined>;
  unscoped: boolean;
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
  private executableCandidates: readonly ("docker" | "podman")[] = [];

  /** Runtime coverage is valid only while this child's event stream is healthy. */
  private executable: "docker" | "podman" | undefined;

  /** Bursts retain only unique scopes; unresolved metadata conservatively covers its runtime. */
  private readonly pendingChanges = new Map<"docker" | "podman", PendingContainerChanges>();

  /** Slow Docker reconciliation gets one trailing batch instead of overlapping callbacks. */
  private notificationInFlight = false;

  /** Reconnection must repair events missed while the stream was unavailable. */
  private needsReconnectRefresh = false;

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

  /** Returns the runtime whose lifecycle events currently cover background discovery. */
  getRuntime(): "docker" | "podman" | undefined {
    return this.isHealthy() ? this.executable : undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingChanges.clear();
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
          // Docker healthchecks and exec probes are frequent. Filter at the
          // daemon so they never wake this process just to be discarded below.
          // Podman keeps its broader subscription because its action names differ.
          ...(executable === "docker"
            ? [...ROUTING_RELEVANT_ACTIONS].flatMap((action) => ["--filter", `event=${action}`])
            : []),
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
    } catch {
      this.startNextCandidate();
      return;
    }

    this.child = child;
    this.executable = executable;
    this.streamHealthy = false;
    this.startedAtMs = Date.now();

    let pendingLine = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.child !== child) {
        return;
      }

      // Any output proves the runtime accepted the stream subscription.
      this.markStreamHealthy(executable);
      const buffered = pendingLine + chunk;
      const lastNewlineIndex = buffered.lastIndexOf("\n");
      const completeLines = lastNewlineIndex < 0 ? "" : buffered.slice(0, lastNewlineIndex + 1);
      pendingLine = lastNewlineIndex < 0 ? buffered : buffered.slice(lastNewlineIndex + 1);
      // Cap the partial-line buffer; event lines are short and a runaway
      // buffer would mean the stream is not line-oriented JSON after all.
      if (pendingLine.length > 64 * 1024) {
        pendingLine = "";
      }

      for (const event of readRoutingRelevantEvents(completeLines)) {
        this.queueEventNotification(executable, readComposeProject(event), readEventContainerId(event));
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
        this.markStreamHealthy(executable);
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
    this.needsReconnectRefresh ||= wasHealthy;

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

  /** A recovered subscription immediately catches up changes missed during daemon downtime. */
  private markStreamHealthy(executable: "docker" | "podman"): void {
    this.streamHealthy = true;
    if (this.needsReconnectRefresh) {
      this.needsReconnectRefresh = false;
      this.queueEventNotification(executable);
    }
  }

  private queueEventNotification(runtime: "docker" | "podman", composeProject?: string, containerId?: string): void {
    if (this.disposed) {
      return;
    }

    let pending = this.pendingChanges.get(runtime);
    if (pending === undefined) {
      pending = { projects: new Set(), containers: new Map(), unscoped: false };
      this.pendingChanges.set(runtime, pending);
    }
    if (!pending.unscoped) {
      if (containerId !== undefined) {
        pending.containers.set(containerId, composeProject ?? pending.containers.get(containerId));
      } else if (composeProject !== undefined) {
        pending.projects.add(composeProject);
      } else {
        pending.unscoped = true;
      }
      if (pending.projects.size + pending.containers.size > 256) {
        pending.unscoped = true;
      }
      if (pending.unscoped) {
        pending.projects.clear();
        pending.containers.clear();
      }
    }
    this.scheduleEventNotification();
  }

  /** A fixed debounce window remains responsive while an active callback owns the next batch. */
  private scheduleEventNotification(): void {
    if (this.disposed || this.notificationInFlight || this.debounceTimer !== undefined || this.pendingChanges.size === 0) {
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.deliverEventNotification();
    }, EVENT_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /** Events arriving during reconciliation form a fresh trailing batch, including after failures. */
  private async deliverEventNotification(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const changes = [...this.pendingChanges].flatMap(([runtime, pending]): ContainerRuntimeChange[] => {
      if (pending.unscoped) {
        return [{ runtime }];
      }
      const unresolved: ContainerRuntimeChange[] = [];
      for (const [containerId, project] of pending.containers) {
        if (project === undefined) { unresolved.push({ runtime, containerId }); }
        else { pending.projects.add(project); }
      }
      return [...pending.projects].map<ContainerRuntimeChange>((composeProject) => ({ runtime, composeProject })).concat(unresolved);
    });
    this.pendingChanges.clear();
    this.notificationInFlight = true;
    try {
      await this.options.onEvent(changes);
    } catch {
      // The periodic runtime reconciliation remains the recovery path for a failed batch.
    } finally {
      this.notificationInFlight = false;
      this.scheduleEventNotification();
    }
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

function runtimeExecutableCandidates(settings: ContainerRuntimeSettings): readonly ("docker" | "podman")[] {
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
  return readRoutingRelevantEvents(chunk).length > 0;
}

/** Retains Compose identity from the event so unrelated projects need no runtime repair. */
function readRoutingRelevantEvents(chunk: string): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
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
      events.push(record);
    }
  }

  return events;
}

/** Docker uses Actor.Attributes; Podman exposes Attributes directly. Unknown shapes stay unscoped. */
function readComposeProject(event: Record<string, unknown>): string | undefined {
  const actor = event.Actor;
  const attributes = actor !== null && typeof actor === "object"
    ? (actor as Record<string, unknown>).Attributes
    : event.Attributes ?? event.attributes;
  if (typeof attributes !== "object" || attributes === null) {
    return undefined;
  }
  const labels = attributes as Record<string, unknown>;
  const project = labels["com.docker.compose.project"] ?? labels["io.podman.compose.project"];
  return typeof project === "string" && project.trim().length > 0 ? project.trim() : undefined;
}

/** The event's Actor.ID is a network ID for network events, so use Attributes.container there. */
function readEventContainerId(event: Record<string, unknown>): string | undefined {
  const actor = typeof event.Actor === "object" && event.Actor !== null ? event.Actor as Record<string, unknown> : undefined;
  const attributes = actor?.Attributes ?? event.Attributes ?? event.attributes;
  const type = event.Type ?? event.type;
  const id = type === "network" && typeof attributes === "object" && attributes !== null
    ? (attributes as Record<string, unknown>).container
    : type === "container" ? actor?.ID ?? event.ID ?? event.id : undefined;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

/** Normalizes actions such as "exec_create: sh" or "health_status: healthy" to their base verb. */
function readEventAction(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const action = value.split(":", 1)[0].trim().toLowerCase();
  return action === "died" ? "die" : action;
}

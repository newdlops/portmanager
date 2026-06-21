import { ManagedProcessRegistry } from "./process-registry";
import { SimpleEventEmitter } from "../shared/events";
import type {
  DisposableLike,
  ManagedProcess,
  PortAvailability,
  PortAvailabilityProvider,
  ProcessSnapshot,
} from "../shared/types";

/**
 * Background watcher for preferred ports.
 *
 * The watcher cannot intercept an arbitrary process' failed bind request.
 * Instead, it continuously observes the preferred ports that matter to the
 * workspace and reflects externally occupied listeners in the registry.
 */

export interface PreferredPortWatchSettings {
  /** Master switch for polling external port occupancy. */
  readonly enabled: boolean;
  /** Host used by the platform scanner. */
  readonly host: string;
  /** Ports that should be watched in the background. */
  readonly ports: readonly number[];
  /** Polling interval used after start. */
  readonly intervalMs: number;
  /** Working directory stored on detected entries when the OS cannot provide one. */
  readonly cwd: string;
}

export interface DetectedPortEvent {
  /** Port that is currently occupied by an external listener. */
  readonly port: number;
  /** Registry entry created or updated for the detected listener. */
  readonly process: ManagedProcess;
  /** Raw scanner result retained for diagnostics and notifications. */
  readonly availability: PortAvailability;
}

export interface PreferredPortWatcherOptions {
  /** Low-level scanner used to check local TCP availability. */
  readonly availabilityProvider: PortAvailabilityProvider;
  /** Registry where detected external listeners should appear. */
  readonly registry: ManagedProcessRegistry;
  /** Reads the latest settings on every scan so VS Code setting changes apply live. */
  readonly readSettings: () => PreferredPortWatchSettings;
  /** Supplies deterministic timestamps in tests and wall-clock time in production. */
  readonly now?: () => Date;
}

/**
 * Polls preferred ports and keeps detected external listeners in sync with the
 * process registry. Detected entries are deterministic per port so a busy port
 * updates a single row instead of adding duplicates on every interval.
 */
export class PreferredPortWatcher implements DisposableLike {
  /** Timer handle for the active polling loop; undefined means the watcher is stopped. */
  private timer: NodeJS.Timeout | undefined;

  /** Lifecycle flag that prevents a finished scan from rescheduling after dispose. */
  private disposed = false;

  /** Ports already emitted as newly detected, used to avoid repeated notifications. */
  private readonly notifiedPorts = new Set<number>();

  /** Event channel used by the extension layer to show optional notifications. */
  private readonly detectedEvents = new SimpleEventEmitter<DetectedPortEvent>();

  /** Clock source used for deterministic registry timestamps in tests. */
  private readonly now: () => Date;

  constructor(private readonly options: PreferredPortWatcherOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Starts polling. The first scan runs immediately so the sidebar is useful as
   * soon as the extension activates instead of waiting for the first interval.
   */
  start(): void {
    this.disposed = false;

    if (this.timer !== undefined) {
      return;
    }

    void this.scanNow();
    this.scheduleNextScan();
  }

  /** Stops future polling and releases event listeners. */
  dispose(): void {
    this.disposed = true;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.detectedEvents.clear();
  }

  /** Subscribes to newly detected external port occupancy events. */
  onDidDetect(listener: (event: DetectedPortEvent) => void): DisposableLike {
    return this.detectedEvents.subscribe(listener);
  }

  /**
   * Performs one foreground scan. Refresh commands call this directly so the
   * user can force the registry to catch up with the current process table.
   */
  async scanNow(): Promise<void> {
    const settings = this.options.readSettings();
    const watchedPorts = normalizeWatchedPorts(settings.ports);

    if (!settings.enabled || watchedPorts.length === 0) {
      this.removeStaleDetectedEntries(new Set());
      return;
    }

    const activeWatchedPorts = new Set(watchedPorts);

    for (const port of watchedPorts) {
      await this.scanPort(port, settings);
    }

    this.removeStaleDetectedEntries(activeWatchedPorts);
  }

  /** Schedules the next scan with a fresh interval value from settings. */
  private scheduleNextScan(): void {
    if (this.disposed) {
      return;
    }

    const settings = this.options.readSettings();
    const intervalMs = Math.max(1000, settings.intervalMs);

    this.timer = setTimeout(() => {
      this.timer = undefined;

      void this.scanNow().finally(() => {
        this.scheduleNextScan();
      });
    }, intervalMs);
  }

  /**
   * Checks one port and reconciles the matching detected registry row.
   * Managed or manually registered rows take precedence because they represent
   * explicit user actions rather than passive observation.
   */
  private async scanPort(port: number, settings: PreferredPortWatchSettings): Promise<void> {
    const availability = await this.options.availabilityProvider.check(port, settings.host);
    const detectedId = buildDetectedProcessId(port);

    if (availability.available) {
      this.removeDetectedEntry(detectedId, port);
      return;
    }

    if (this.isExplicitlyRegisteredPort(port)) {
      this.removeDetectedEntry(detectedId, port);
      return;
    }

    const existing = this.options.registry.get(detectedId);
    const detectedProcess = existing
      ? this.updateDetectedEntry(existing, availability, settings)
      : this.createDetectedEntry(detectedId, availability, settings);

    if (!this.notifiedPorts.has(port)) {
      this.notifiedPorts.add(port);
      this.detectedEvents.emit({ port, process: detectedProcess, availability });
    }
  }

  /** Creates a new registry row for an externally occupied watched port. */
  private createDetectedEntry(
    id: string,
    availability: PortAvailability,
    settings: PreferredPortWatchSettings,
  ): ManagedProcess {
    const owner = availability.owner;

    return this.options.registry.register(
      {
        pid: owner?.pid ?? 0,
        name: buildDetectedName(availability.port, owner),
        command: owner?.command ?? owner?.name ?? `External listener on ${availability.port}`,
        cwd: settings.cwd,
        requestedPort: availability.port,
        actualPort: availability.port,
        host: settings.host,
      },
      {
        id,
        status: "running",
        startedAt: this.now().toISOString(),
        errorMessage: availability.errorMessage,
        source: "detected",
      },
    );
  }

  /** Updates the existing detected row when PID, command, or diagnostics change. */
  private updateDetectedEntry(
    existing: ManagedProcess,
    availability: PortAvailability,
    settings: PreferredPortWatchSettings,
  ): ManagedProcess {
    const owner = availability.owner;

    return this.options.registry.update(existing.id, {
      pid: owner?.pid ?? existing.pid,
      name: buildDetectedName(availability.port, owner),
      command: owner?.command ?? owner?.name ?? existing.command,
      cwd: settings.cwd,
      actualPort: availability.port,
      status: "running",
      stoppedAt: undefined,
      errorMessage: availability.errorMessage,
      source: "detected",
    });
  }

  /**
   * Removes detected rows for ports that are no longer busy or no longer
   * watched. Explicit managed and registered rows are never removed here.
   */
  private removeStaleDetectedEntries(activeWatchedPorts: ReadonlySet<number>): void {
    for (const process of this.options.registry.list()) {
      if (process.source !== "detected") {
        continue;
      }

      if (!activeWatchedPorts.has(process.actualPort)) {
        this.removeDetectedEntry(process.id, process.actualPort);
      }
    }
  }

  /** Removes a detected row and allows a future occupancy event to notify again. */
  private removeDetectedEntry(id: string, port: number): void {
    const existing = this.options.registry.get(id);

    if (existing?.source !== "detected") {
      return;
    }

    this.options.registry.remove(id);
    this.notifiedPorts.delete(port);
  }

  /** Checks whether a port already belongs to a user-controlled registry row. */
  private isExplicitlyRegisteredPort(port: number): boolean {
    return this.options.registry.list().some((process) => {
      if (process.source === "detected" || process.status === "stopped") {
        return false;
      }

      return process.actualPort === port;
    });
  }
}

/** Builds a stable id so each watched port maps to at most one detected row. */
function buildDetectedProcessId(port: number): string {
  return `detected-port-${port}`;
}

/** Produces a readable label even when platform process details are unavailable. */
function buildDetectedName(port: number, owner: ProcessSnapshot | undefined): string {
  if (owner?.name) {
    return `${owner.name} :${port}`;
  }

  if (owner?.pid !== undefined) {
    return `PID ${owner.pid} :${port}`;
  }

  return `External port ${port}`;
}

/** Removes invalid and duplicate port values while preserving user order. */
function normalizeWatchedPorts(ports: readonly number[]): readonly number[] {
  const seenPorts = new Set<number>();
  const watchedPorts: number[] = [];

  for (const port of ports) {
    const normalizedPort = Math.trunc(port);

    if (!isValidPort(normalizedPort) || seenPorts.has(normalizedPort)) {
      continue;
    }

    seenPorts.add(normalizedPort);
    watchedPorts.push(normalizedPort);
  }

  return watchedPorts;
}

/** Validates the user-facing TCP port range. */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

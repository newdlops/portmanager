import { SimpleEventEmitter } from "../shared/events";
import type {
  DisposableLike,
  ManagedProcess,
  ProcessSource,
  ProcessStatus,
  RegisteredProcessInput,
} from "../shared/types";

/**
 * In-memory process registry for the core domain layer.
 *
 * The registry stores the requested-to-actual port mapping and emits snapshots
 * whenever that state changes. It does not launch or kill processes directly;
 * platform adapters own those low-level mechanics and call this registry to
 * reflect lifecycle changes.
 */

export type ManagedProcessRegistryEventType = "added" | "updated" | "stopped" | "removed";

export interface ManagedProcessRegistryEvent {
  /** Kind of state transition that caused this event. */
  readonly type: ManagedProcessRegistryEventType;
  /** Current or removed process associated with the transition. */
  readonly process: ManagedProcess;
  /** Previous state for transitions that mutate an existing entry. */
  readonly previousProcess?: ManagedProcess;
  /** Full registry snapshot after the transition has been applied. */
  readonly processes: readonly ManagedProcess[];
}

export interface ManagedProcessRegistryOptions {
  /** Supplies deterministic timestamps in tests and real wall-clock time in production. */
  readonly now?: () => Date;
  /** Allows command handlers or tests to provide stable process identifiers. */
  readonly idFactory?: () => string;
  /** Host used when a registered process input does not provide a URL directly. */
  readonly defaultHost?: string;
}

export interface RegisteredProcessOptions {
  /** Optional stable identifier; generated when omitted. */
  readonly id?: string;
  /** Initial lifecycle state for the external process. */
  readonly status?: ProcessStatus;
  /** ISO timestamp used instead of the registry clock. */
  readonly startedAt?: string;
  /** Optional stopped timestamp for pre-stopped external entries. */
  readonly stoppedAt?: string;
  /** Explicit URL, useful when a caller has custom host/protocol knowledge. */
  readonly url?: string;
  /** Initial error message when registering a known failed process. */
  readonly errorMessage?: string;
  /** Registry source for UI and command behavior. */
  readonly source?: ProcessSource;
}

export type ManagedProcessUpdate = Partial<Omit<ManagedProcess, "id" | "requestedPort">>;

/**
 * Stores managed process records by id and exposes lifecycle operations used by
 * commands and UI adapters. Public methods return clones so external mutation
 * cannot silently change registry state.
 */
export class ManagedProcessRegistry {
  /** Durable in-memory map for process records during the extension session. */
  private readonly processesById = new Map<string, ManagedProcess>();

  /** Synchronous event channel used by views to refresh after each state change. */
  private readonly events = new SimpleEventEmitter<ManagedProcessRegistryEvent>();

  /** Clock source for timestamps; injected to keep lifecycle tests deterministic. */
  private readonly now: () => Date;

  /** Identifier source; callers may inject one when IDs must align with saved state. */
  private readonly idFactory: () => string;

  /** Fallback host for URL construction when registering external processes. */
  private readonly defaultHost: string;

  /** Monotonic suffix used by the default id factory inside this registry instance. */
  private generatedIdSequence = 1;

  constructor(options: ManagedProcessRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `managed-process-${this.generatedIdSequence++}`);
    this.defaultHost = options.defaultHost ?? "localhost";
  }

  /**
   * Subscribes to registry changes. The emitter is synchronous so listeners see
   * changes in command order, which keeps the sidebar model predictable.
   */
  onDidChange(listener: (event: ManagedProcessRegistryEvent) => void): DisposableLike {
    return this.events.subscribe(listener);
  }

  /**
   * Adds a fully materialized managed process record. This path is useful after
   * a launcher has already resolved routing and process details.
   */
  add(process: ManagedProcess): ManagedProcess {
    const storedProcess = cloneProcess(process);
    this.ensureIdAvailable(storedProcess.id);
    this.processesById.set(storedProcess.id, storedProcess);
    this.emit("added", storedProcess);

    return cloneProcess(storedProcess);
  }

  /**
   * Registers an already running process using shared input fields. Requested
   * and actual ports are stored separately so routed mappings such as 3000 ->
   * 3001 remain visible to the UI.
   */
  register(input: RegisteredProcessInput, options: RegisteredProcessOptions = {}): ManagedProcess {
    const process: ManagedProcess = {
      id: options.id ?? this.idFactory(),
      pid: input.pid,
      name: input.name,
      command: input.command,
      cwd: input.cwd,
      requestedPort: input.requestedPort,
      actualPort: input.actualPort,
      status: options.status ?? "running",
      startedAt: options.startedAt ?? this.now().toISOString(),
      stoppedAt: options.stoppedAt,
      url: options.url ?? buildUrl(input.host || this.defaultHost, input.actualPort),
      errorMessage: options.errorMessage,
      source: options.source ?? "registered",
    };

    return this.add(process);
  }

  /**
   * Applies a lifecycle or display update to an existing process. The requested
   * port is intentionally immutable after registration because it represents
   * the user's original intent; actualPort may change after rerouting.
   */
  update(id: string, patch: ManagedProcessUpdate): ManagedProcess {
    const previousProcess = this.requireProcess(id);
    const sanitizedPatch = stripImmutableUpdateFields(patch);
    const nextProcess: ManagedProcess = {
      ...previousProcess,
      ...sanitizedPatch,
      id: previousProcess.id,
      requestedPort: previousProcess.requestedPort,
    };

    this.processesById.set(id, nextProcess);
    this.emit("updated", nextProcess, previousProcess);

    return cloneProcess(nextProcess);
  }

  /**
   * Marks a process as stopped. Actual process termination is performed outside
   * the core layer; this method records the resulting lifecycle state.
   */
  stop(id: string, stoppedAt: string = this.now().toISOString()): ManagedProcess {
    const previousProcess = this.requireProcess(id);
    const nextProcess: ManagedProcess = {
      ...previousProcess,
      status: "stopped",
      stoppedAt,
      url: undefined,
    };

    this.processesById.set(id, nextProcess);
    this.emit("stopped", nextProcess, previousProcess);

    return cloneProcess(nextProcess);
  }

  /**
   * Removes a process from the registry and emits the post-removal snapshot.
   * Missing IDs are treated as a no-op so repeated cleanup is safe.
   */
  remove(id: string): ManagedProcess | undefined {
    const existingProcess = this.processesById.get(id);

    if (!existingProcess) {
      return undefined;
    }

    this.processesById.delete(id);
    this.emit("removed", existingProcess, existingProcess);

    return cloneProcess(existingProcess);
  }

  /**
   * Returns a stored process by id. A clone is returned to protect registry
   * state from accidental mutation by UI models or command handlers.
   */
  get(id: string): ManagedProcess | undefined {
    const process = this.processesById.get(id);
    return process ? cloneProcess(process) : undefined;
  }

  /**
   * Returns processes in insertion order. Map ordering gives stable sidebar and
   * test behavior without adding a separate sort policy.
   */
  list(): readonly ManagedProcess[] {
    return [...this.processesById.values()].map(cloneProcess);
  }

  /**
   * Emits a registry event with a fresh snapshot so listeners can reconcile
   * their state from the event alone.
   */
  private emit(
    type: ManagedProcessRegistryEventType,
    process: ManagedProcess,
    previousProcess?: ManagedProcess,
  ): void {
    this.events.emit({
      type,
      process: cloneProcess(process),
      previousProcess: previousProcess ? cloneProcess(previousProcess) : undefined,
      processes: this.list(),
    });
  }

  /**
   * Looks up a process or raises a domain-level error that command handlers can
   * surface directly to the user.
   */
  private requireProcess(id: string): ManagedProcess {
    const process = this.processesById.get(id);

    if (!process) {
      throw new Error(`Managed process "${id}" is not registered.`);
    }

    return process;
  }

  /**
   * Prevents accidental replacement of process records. Callers should use
   * update when they intend to mutate an existing lifecycle entry.
   */
  private ensureIdAvailable(id: string): void {
    if (this.processesById.has(id)) {
      throw new Error(`Managed process "${id}" is already registered.`);
    }
  }
}

/**
 * Removes immutable keys from a runtime patch. The TypeScript type already
 * blocks these fields for normal callers, but this guard protects the registry
 * when data crosses from untyped command payloads or tests.
 */
function stripImmutableUpdateFields(patch: ManagedProcessUpdate): ManagedProcessUpdate {
  const runtimePatch = patch as Partial<ManagedProcess>;
  const { id: _ignoredId, requestedPort: _ignoredRequestedPort, ...mutablePatch } = runtimePatch;

  return mutablePatch;
}

/**
 * Creates the default user-facing URL from the host and actual port. The core
 * layer assumes HTTP for MVP development servers; richer protocol decisions can
 * be supplied through RegisteredProcessOptions.url.
 */
function buildUrl(host: string, actualPort: number): string {
  const normalizedHost = host.trim() || "localhost";
  return `http://${normalizedHost}:${actualPort}`;
}

/**
 * Produces a shallow clone for immutable domain records. ManagedProcess fields
 * are primitives today, so a shallow copy is enough to protect registry state.
 */
function cloneProcess(process: ManagedProcess): ManagedProcess {
  return { ...process };
}

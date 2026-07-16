import type {
  DisposableLike,
  AgentSnapshot,
  ManagedProcess,
  ManagedProcessStartInput,
  PortManagerSettings,
  RegisteredProcessInput,
} from "../shared/types";

/**
 * Extension-facing process service boundary.
 *
 * Commands and views use this interface instead of directly touching routing,
 * process launching, or platform scanning. The production implementation talks
 * to the single local agent shared across VS Code windows.
 */
export interface PortManagerProcessService {
  /** Connects to the local daemon, starting it when no socket is available. */
  start(): Promise<void>;
  /** Stops the local daemon without stopping already running application processes. */
  stopDaemon(): Promise<void>;
  /** Replaces the local daemon with the active extension build. */
  restartDaemon(options?: { readonly refreshSnapshot?: boolean }): Promise<void>;
  /** Returns the latest complete daemon snapshot known to the extension. */
  getSnapshot(): AgentSnapshot;
  /** Returns the latest agent snapshot rows in sidebar display order. */
  list(): readonly ManagedProcess[];
  /** Returns one process row by id from the latest snapshot. */
  get(id: string): ManagedProcess | undefined;
  /** Notifies UI and commands when the agent publishes a new snapshot. */
  onDidChange(listener: () => void): DisposableLike;
  /** Requests the current snapshot; normal daemon refreshes may reuse a recent listener observation. */
  refresh(): Promise<void>;
  /**
   * Forces a fresh listener scan and synchronously republishes generated route
   * files. Reserved for explicit recovery because it intentionally bypasses
   * the daemon's listener cache and route-table write coalescing.
   */
  repairRoutingState(): Promise<void>;
  /** Waits for the daemon's current in-memory routes to reach generated files without rescanning listeners. */
  flushRouteTables(): Promise<void>;
  /** Starts a managed process through the agent so routing state is centralized. */
  startManagedProcess(input: ManagedProcessStartInput, settings: PortManagerSettings): Promise<ManagedProcess>;
  /** Registers an already running process with the shared agent state. */
  registerExistingProcess(input: RegisteredProcessInput): Promise<ManagedProcess>;
  /** Stops a managed process when the agent owns its child process. */
  stopProcess(id: string, settings: PortManagerSettings): Promise<ManagedProcess | undefined>;
  /** Restarts a managed process through its agent-side launch profile. */
  restartProcess(id: string, settings: PortManagerSettings): Promise<ManagedProcess | undefined>;
  /** Removes a row from the shared agent registry or suppresses it from the view. */
  removeProcess(id: string): Promise<ManagedProcess | undefined>;
  /**
   * Routes a preformatted RESPAWN command to the first of `parentPids`
   * (nearest-first) that owns a hook control connection, so it relaunches an
   * escaped child as a true child of itself. Resolves even if no ancestor is
   * hooked yet (the daemon reports it and the detector retries).
   */
  requestRespawnChild(parentPids: readonly number[], networkId: string, line: string): Promise<void>;
  /** Releases sockets or event subscriptions during extension deactivation. */
  dispose(): void;
}

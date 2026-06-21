import type {
  DisposableLike,
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
  /** Returns the latest agent snapshot rows in sidebar display order. */
  list(): readonly ManagedProcess[];
  /** Returns one process row by id from the latest snapshot. */
  get(id: string): ManagedProcess | undefined;
  /** Notifies UI and commands when the agent publishes a new snapshot. */
  onDidChange(listener: () => void): DisposableLike;
  /** Forces the agent to rescan the OS listening-port table. */
  refresh(): Promise<void>;
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
  /** Releases sockets or event subscriptions during extension deactivation. */
  dispose(): void;
}

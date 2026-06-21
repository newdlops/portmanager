/**
 * Shared domain contracts for Port Manager.
 *
 * The file intentionally keeps framework-neutral types in one place so core,
 * platform, UI, and configuration modules can agree on the same vocabulary
 * without importing each other.
 */

export type ProcessStatus = "starting" | "running" | "stopped" | "error";

export type ScanDirection = "up" | "down" | "both";

export type PortInjectionMode = "env" | "template" | "argument";

export type ProcessKillSignal = NodeJS.Signals | "SIGKILL" | "SIGTERM";

export interface PortManagerSettings {
  /** Master switch used by command handlers before launching managed processes. */
  readonly enabled: boolean;
  /** Hostname used to build user-facing URLs for routed processes. */
  readonly defaultHost: string;
  /** Number of nearby candidate ports checked after the requested port is busy. */
  readonly scanRange: number;
  /** Direction used to build the candidate port sequence. */
  readonly scanDirection: ScanDirection;
  /** Common starting ports shown to the user by command prompts. */
  readonly preferredPorts: readonly number[];
  /** Whether a newly launched routed URL should be opened automatically. */
  readonly autoOpenBrowser: boolean;
  /** Whether conflict routing should show an informational notification. */
  readonly showConflictNotification: boolean;
  /** Signal used when stopping managed child processes. */
  readonly processKillSignal: ProcessKillSignal;
}

export interface ManagedProcess {
  /** Stable identifier used by commands and UI items even if a PID changes after restart. */
  readonly id: string;
  /** Operating system process identifier for the current child process. */
  readonly pid: number;
  /** Human-readable process name shown in the sidebar. */
  readonly name: string;
  /** Original command text entered by the user. */
  readonly command: string;
  /** Working directory used to launch or register the process. */
  readonly cwd: string;
  /** Logical port requested by the user or launch profile. */
  readonly requestedPort: number;
  /** Actual TCP port assigned to the running process. */
  readonly actualPort: number;
  /** Current lifecycle state tracked by the registry. */
  readonly status: ProcessStatus;
  /** ISO timestamp for the first start or latest restart. */
  readonly startedAt: string;
  /** ISO timestamp set when the process exits or is stopped. */
  readonly stoppedAt?: string;
  /** User-facing URL derived from host and actual port. */
  readonly url?: string;
  /** Last error associated with this process, if any. */
  readonly errorMessage?: string;
}

export interface ProcessSnapshot {
  /** PID reported by a platform port query. */
  readonly pid?: number;
  /** Process executable or command name when available. */
  readonly name?: string;
  /** Full command line when the platform can provide it. */
  readonly command?: string;
}

export interface PortAvailability {
  /** Port that was checked. */
  readonly port: number;
  /** True when the extension can bind to the port on the requested host. */
  readonly available: boolean;
  /** Best-effort details about the current listener when the port is busy. */
  readonly owner?: ProcessSnapshot;
  /** Error captured while checking details; availability may still be known. */
  readonly errorMessage?: string;
}

export interface PortAvailabilityProvider {
  /**
   * Checks whether a local TCP port can be used by a managed process.
   * Implementations belong to the platform layer because they touch sockets
   * or OS commands.
   */
  check(port: number, host?: string): Promise<PortAvailability>;
}

export interface PortRoutingRequest {
  /** Port the application wants to use before conflict resolution. */
  readonly requestedPort: number;
  /** Host passed to the port availability provider. */
  readonly host: string;
  /** Maximum number of nearby ports to consider after the requested port. */
  readonly scanRange: number;
  /** Candidate generation policy for nearby ports. */
  readonly scanDirection: ScanDirection;
}

export interface PortRoutingDecision {
  /** Requested logical port. This value is never rewritten by routing. */
  readonly requestedPort: number;
  /** Actual port that should be injected into the launched process. */
  readonly actualPort: number;
  /** True when `actualPort` differs from the requested port. */
  readonly routed: boolean;
  /** Availability result for the requested port. */
  readonly requestedPortStatus: PortAvailability;
  /** Candidate ports checked after a conflict, in the order they were tested. */
  readonly checkedCandidates: readonly PortAvailability[];
}

export interface ProcessLaunchRequest {
  /** Human-readable name shown in the sidebar; defaults to command when omitted. */
  readonly name?: string;
  /** Shell command entered by the user. */
  readonly command: string;
  /** Working directory for the managed process. */
  readonly cwd: string;
  /** Logical port requested by the user. */
  readonly requestedPort: number;
  /** Host used to build URLs and check local availability. */
  readonly host: string;
  /** Actual port chosen by the routing service. */
  readonly actualPort: number;
  /** How the actual port should be communicated to the process. */
  readonly injectionMode: PortInjectionMode;
}

export interface ProcessLaunchResult {
  /** PID returned by the child process launcher. */
  readonly pid: number;
  /** Original command after template expansion, if any. */
  readonly command: string;
}

export interface ProcessLauncher {
  /**
   * Starts a managed child process. The launcher owns low-level process
   * mechanics; registry state is handled by the core layer.
   */
  launch(request: ProcessLaunchRequest): Promise<ProcessLaunchResult>;
  /**
   * Attempts to stop a process that was started by this launcher. External
   * processes may not be known to the launcher.
   */
  stop(pid: number, signal: ProcessKillSignal): Promise<void>;
  /** Registers a callback for process exit events observed by the launcher. */
  onExit(listener: (pid: number, exitCode: number | null, signal: NodeJS.Signals | null) => void): DisposableLike;
}

export interface RegisteredProcessInput {
  /** PID for an already running process that should appear in the sidebar. */
  readonly pid: number;
  /** Display name for the registered external process. */
  readonly name: string;
  /** Command line if known. */
  readonly command: string;
  /** Working directory if known. */
  readonly cwd: string;
  /** Logical port associated with the external process. */
  readonly requestedPort: number;
  /** Actual port currently used by the external process. */
  readonly actualPort: number;
  /** Host used to build the user-facing URL. */
  readonly host: string;
}

export interface ManagedProcessStartInput {
  /** User-facing process name. */
  readonly name: string;
  /** Original command text entered by the user. */
  readonly command: string;
  /** Working directory for the process. */
  readonly cwd: string;
  /** Requested logical port. */
  readonly requestedPort: number;
  /** Host used for scanning and URL generation. */
  readonly host: string;
  /** Port injection strategy selected by command handlers. */
  readonly injectionMode: PortInjectionMode;
}

export interface DisposableLike {
  /** Releases event subscriptions or low-level handles. */
  dispose(): void;
}

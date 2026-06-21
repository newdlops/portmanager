/**
 * Shared domain contracts for Port Manager.
 *
 * The file intentionally keeps framework-neutral types in one place so core,
 * platform, UI, and configuration modules can agree on the same vocabulary
 * without importing each other.
 */

export type ProcessStatus = "starting" | "running" | "stopped" | "error";

export type ScanDirection = "up" | "down" | "both";

export type PortRoutingMode = "nearest" | "hashed";

export type PortInjectionMode = "env" | "template" | "argument";

export type ProcessKillSignal = NodeJS.Signals | "SIGKILL" | "SIGTERM";

export type ProcessSource = "managed" | "registered" | "detected";

export type PortProtocol = "tcp";

export interface PortManagerSettings {
  /** Master switch used by command handlers before launching managed processes. */
  readonly enabled: boolean;
  /** Hostname used to build user-facing URLs for routed processes. */
  readonly defaultHost: string;
  /** Number of nearby candidate ports checked after the requested port is busy. */
  readonly scanRange: number;
  /** Direction used to build the candidate port sequence. */
  readonly scanDirection: ScanDirection;
  /** Routing policy used to choose the actual bind port. */
  readonly routingMode: PortRoutingMode;
  /** First TCP port in the deterministic hashed actual-port range. */
  readonly virtualPortRangeStart: number;
  /** Last TCP port in the deterministic hashed actual-port range. */
  readonly virtualPortRangeEnd: number;
  /** Common starting ports shown to the user by command prompts. */
  readonly preferredPorts: readonly number[];
  /** Whether a newly launched routed URL should be opened automatically. */
  readonly autoOpenBrowser: boolean;
  /** Whether conflict routing should show an informational notification. */
  readonly showConflictNotification: boolean;
  /** Whether the extension should watch preferred ports even for external processes. */
  readonly watchPreferredPorts: boolean;
  /** Polling interval used by the preferred-port watcher. */
  readonly watchIntervalMs: number;
  /** Whether newly detected busy preferred ports should show a notification. */
  readonly notifyOnDetectedConflict: boolean;
  /** Whether the local agent should report every listening TCP port. */
  readonly monitorAllListeningPorts: boolean;
  /** Whether terminal output should be scanned for bind/listen failures. */
  readonly detectTerminalListenFailures: boolean;
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
  /** Origin of the registry entry, used to separate launched and detected processes. */
  readonly source?: ProcessSource;
}

export interface ProcessSnapshot {
  /** PID reported by a platform port query. */
  readonly pid?: number;
  /** Process executable or command name when available. */
  readonly name?: string;
  /** Full command line when the platform can provide it. */
  readonly command?: string;
}

export interface ListeningPort {
  /** Stable row id derived from protocol, address, port, and owning process. */
  readonly id: string;
  /** Network protocol monitored by the agent. */
  readonly protocol: PortProtocol;
  /** Local bind address reported by the operating system. */
  readonly localAddress: string;
  /** Local listening TCP port. */
  readonly port: number;
  /** PID that owns the listener when the OS exposes it. */
  readonly pid?: number;
  /** Process name that owns the listener when available. */
  readonly processName?: string;
  /** Full command or executable path when available. */
  readonly command?: string;
  /** Whether this listener belongs to an agent-launched process. */
  readonly source: "external" | "managed";
  /** ISO timestamp from the scan that produced this row. */
  readonly updatedAt: string;
}

export interface ListeningPortProvider {
  /**
   * Lists every local TCP listener the current user can inspect.
   * Implementations live in the platform layer because they execute OS tools.
   */
  list(): Promise<readonly ListeningPort[]>;
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
  /** Whether actual ports are chosen near the request or from a hashed virtual range. */
  readonly routingMode?: PortRoutingMode;
  /** Stable namespace used by hashed routing to isolate duplicate projects. */
  readonly routeScope?: string;
  /** First TCP port in the hashed actual-port range. */
  readonly virtualPortRangeStart?: number;
  /** Last TCP port in the hashed actual-port range. */
  readonly virtualPortRangeEnd?: number;
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
  /** Routing policy that produced the decision. */
  readonly routingMode?: PortRoutingMode;
}

export interface LogicalPortRoute {
  /** Logical port the application code or user-facing workflow refers to. */
  readonly logicalPort: number;
  /** Actual OS listening port assigned by Port Manager. */
  readonly actualPort: number;
  /** Host used for URLs and availability checks. */
  readonly host: string;
  /** Process row that owns this mapping when known. */
  readonly processId?: string;
  /** Human-readable process name for route table displays and env payloads. */
  readonly processName?: string;
  /** Current lifecycle state of the owning process. */
  readonly status: ProcessStatus;
  /** Origin of the route row. */
  readonly source: ProcessSource;
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
  /** Current logical routing table made available to the launched process. */
  readonly logicalRoutes?: readonly LogicalPortRoute[];
  /** Path to the dynamic JSON route table maintained by the local agent. */
  readonly logicalRoutesFile?: string;
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

export interface AgentStartManagedProcessRequest extends ManagedProcessStartInput {
  /** Number of nearby candidate ports checked after the requested port is busy. */
  readonly scanRange: number;
  /** Candidate generation policy used by the agent. */
  readonly scanDirection: ScanDirection;
  /** Routing policy used by the agent. */
  readonly routingMode?: PortRoutingMode;
  /** First TCP port in the hashed actual-port range. */
  readonly virtualPortRangeStart?: number;
  /** Last TCP port in the hashed actual-port range. */
  readonly virtualPortRangeEnd?: number;
}

export interface AgentSnapshot {
  /** PID of the single local agent process serving this snapshot. */
  readonly agentPid: number;
  /** Combined view rows for managed, registered, and externally detected ports. */
  readonly processes: readonly ManagedProcess[];
  /** Raw listening TCP ports observed by the agent. */
  readonly listeners: readonly ListeningPort[];
  /** Active logical-port to actual-port mappings known to the agent. */
  readonly routes: readonly LogicalPortRoute[];
  /** ISO timestamp for this snapshot. */
  readonly updatedAt: string;
}

export interface DisposableLike {
  /** Releases event subscriptions or low-level handles. */
  dispose(): void;
}

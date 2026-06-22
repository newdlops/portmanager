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

export type ProcessSource = "managed" | "registered" | "hooked" | "detected" | "allocated";

export type PortProtocol = "tcp";

export type LogicalPortRouteDirection = "listen" | "send";

export type NetworkPortProtocol = "tcp" | "udp";

export type LogicalNetworkStatus = "creating" | "running" | "stopped" | "error";

export type TerminalAttachmentStatus = "attached" | "detached" | "error";

export type TerminalAttachmentMode = "isolated" | "logical";

export type NetworkRuntimeKind = "container" | "linuxNamespace" | "nativeHelper" | "proxy";

export type HostPortExposureStatus = "opening" | "active" | "stopped" | "error";

export type HostAccessBindingStatus = "active" | "error";

export type ContainerRuntimePreference = "auto" | "docker" | "podman";

/**
 * A user-facing network scope where duplicated app-internal ports remain
 * meaningful. Runtime adapters decide whether this is backed by a container,
 * OS namespace, helper process, or proxy layer.
 */
export interface LogicalNetwork {
  /** Stable id used by terminal attachments and host exposure mappings. */
  readonly id: string;
  /** Human-readable name such as "A app" or "B app". */
  readonly name: string;
  /** Current lifecycle state reported by the selected runtime adapter. */
  readonly status: LogicalNetworkStatus;
  /** Runtime adapter kind responsible for enforcing the network behavior. */
  readonly runtimeKind: NetworkRuntimeKind;
  /** ISO timestamp from network creation. */
  readonly createdAt: string;
  /** Last runtime error or capability warning, if any. */
  readonly errorMessage?: string;
}

/**
 * Capability metadata keeps the UI honest about what an adapter can really do
 * on the current platform before a user expects same-port isolation to work.
 */
export interface NetworkRuntimeCapabilities {
  /** True when different networks can reuse internal ports without occupying host ports. */
  readonly supportsSameInternalPorts: boolean;
  /** True when a terminal can run inside the runtime's isolated socket namespace. */
  readonly supportsTerminalAttach: boolean;
  /** True when host ports can be exposed to network-internal ports. */
  readonly supportsHostExposure: boolean;
  /** True when privileged setup is required for this adapter. */
  readonly requiresPrivilegedHelper: boolean;
  /** True when Docker, Podman, Colima, or a similar runtime must be installed. */
  readonly requiresContainerRuntime: boolean;
}

export interface NetworkRuntimeDescriptor {
  /** Stable adapter id used in settings and stored network rows. */
  readonly id: string;
  /** Display name shown in runtime selection UI. */
  readonly name: string;
  /** Adapter implementation family. */
  readonly kind: NetworkRuntimeKind;
  /** Platform-specific behavior exposed to planning and UI layers. */
  readonly capabilities: NetworkRuntimeCapabilities;
}

/**
 * A terminal candidate discovered from VS Code or the OS process table.
 * Discovery is best-effort because terminals, shells, and permissions differ
 * significantly across platforms.
 */
export interface TerminalCandidate {
  /** PID of the shell or root terminal process that can be selected. */
  readonly pid: number;
  /** Parent process id when known from the platform scanner. */
  readonly parentPid?: number;
  /** Process group id used on POSIX platforms when available. */
  readonly processGroupId?: number;
  /** Terminal device path or Windows console/session identifier when known. */
  readonly terminalId?: string;
  /** User-visible terminal window/tab title when the platform exposes it. */
  readonly windowTitle?: string;
  /** Shell or terminal display name. */
  readonly name: string;
  /** Full command line when the platform exposes it. */
  readonly command?: string;
  /** Working directory when known. */
  readonly cwd?: string;
  /** True when this candidate came from VS Code's integrated terminal API. */
  readonly vscodeTerminal: boolean;
}

/**
 * User-facing terminal window/session grouped from one or more shell process
 * candidates. The UI selects windows first, while runtime adapters can still
 * use the root PID or process group underneath.
 */
export interface TerminalWindow {
  /** Stable id derived from VS Code terminal identity, tty, or process group. */
  readonly id: string;
  /** Short user-facing label for the terminal window or session. */
  readonly title: string;
  /** Whether this window was discovered through VS Code or the OS table. */
  readonly source: "vscode" | "os";
  /** Terminal device path or console/session id when available. */
  readonly terminalId?: string;
  /** Root shell PID selected for runtime attach attempts. */
  readonly rootPid: number;
  /** Process group id used on POSIX platforms when available. */
  readonly processGroupId?: number;
  /** Candidate shell/process PIDs grouped under this window. */
  readonly candidatePids: readonly number[];
  /** Number of terminal candidate processes grouped into this window. */
  readonly candidateCount: number;
  /** Representative command for diagnostics and tooltips. */
  readonly command?: string;
}

export interface TerminalAttachment {
  /** Stable attachment row id. */
  readonly id: string;
  /** Logical network that descendant processes should join. */
  readonly networkId: string;
  /** Selected terminal candidate root PID. */
  readonly rootPid: number;
  /** Process group used to apply runtime context where supported. */
  readonly processGroupId?: number;
  /** User-facing terminal window id selected for this attachment. */
  readonly terminalWindowId?: string;
  /** Title shown to the user when the terminal window was attached. */
  readonly terminalTitle?: string;
  /** Whether traffic is isolated. "logical" is retained only for legacy persisted rows. */
  readonly mode?: TerminalAttachmentMode;
  /** Current attachment lifecycle state. */
  readonly status: TerminalAttachmentStatus;
  /** ISO timestamp when the attachment was requested. */
  readonly attachedAt: string;
  /** Last attach failure or runtime warning, if any. */
  readonly errorMessage?: string;
}

export interface HostPortExposure {
  /** Stable exposure row id. */
  readonly id: string;
  /** Network that owns the target address and port. */
  readonly networkId: string;
  /** Host interface exposed to the user's browser or local clients. */
  readonly hostAddress: string;
  /** Host port chosen by the user. */
  readonly hostPort: number;
  /** Address inside the logical network. */
  readonly targetAddress: string;
  /** Port inside the logical network, for example 3004. */
  readonly targetPort: number;
  /** Transport protocol for the exposure. */
  readonly protocol: NetworkPortProtocol;
  /** Current host listener/proxy lifecycle state. */
  readonly status: HostPortExposureStatus;
  /** ISO timestamp when this exposure was requested. */
  readonly createdAt: string;
  /** Last bind/proxy failure, if any. */
  readonly errorMessage?: string;
}

export interface HostAccessBinding {
  /** Stable binding row id. */
  readonly id: string;
  /** Network whose attached terminal processes can use this host access rule. */
  readonly networkId: string;
  /** Network-local logical port that apps call, for example localhost:15432. */
  readonly logicalPort: number;
  /** Host-machine address the logical port should connect to. */
  readonly hostAddress: string;
  /** Host-machine TCP port reached from inside the logical network. */
  readonly hostPort: number;
  /** Transport protocol for the binding. */
  readonly protocol: NetworkPortProtocol;
  /** Current binding lifecycle state. */
  readonly status: HostAccessBindingStatus;
  /** ISO timestamp when this binding was requested. */
  readonly createdAt: string;
  /** Last binding error, if any. */
  readonly errorMessage?: string;
}

export interface NetworkSnapshot {
  /** Logical networks known to the current VS Code window. */
  readonly networks: readonly LogicalNetwork[];
  /** Latest best-effort terminal candidates from VS Code and the OS. */
  readonly terminalCandidates: readonly TerminalCandidate[];
  /** User-facing terminal windows grouped from terminal candidates. */
  readonly terminalWindows: readonly TerminalWindow[];
  /** Terminal-to-network attachment records. */
  readonly attachments: readonly TerminalAttachment[];
  /** Host port bindings owned by Port Manager. */
  readonly exposures: readonly HostPortExposure[];
  /** Network-to-host port bindings visible from attached terminals. */
  readonly hostAccessBindings: readonly HostAccessBinding[];
  /** Runtime adapters available on this platform/build. */
  readonly runtimes: readonly NetworkRuntimeDescriptor[];
  /** ISO timestamp for this snapshot. */
  readonly updatedAt: string;
}

export interface TerminalCandidateProvider {
  /**
   * Lists terminal-like shell processes visible to the current user.
   * Implementations belong to platform or extension layers because discovery
   * reads OS process tables or VS Code terminal APIs.
   */
  list(): Promise<readonly TerminalCandidate[]>;
}

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
  /** Ports whose protocol identity should not be auto-remapped by terminal hooks. */
  readonly fixedProtocolPorts: readonly number[];
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
  /** Whether explicit terminal port commands should be offered daemon routing at start. */
  readonly routeTerminalCommandsOnStart: boolean;
  /** Signal used when stopping managed child processes. */
  readonly processKillSignal: ProcessKillSignal;
}

export interface ContainerRuntimeSettings {
  /** Preferred local container CLI. "auto" probes Docker first, then Podman. */
  readonly containerRuntime: ContainerRuntimePreference;
  /** Lightweight image used only to keep one network namespace holder alive. */
  readonly containerImage: string;
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
  /** Logical network scope inherited from the terminal that launched the process. */
  readonly networkId?: string;
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
  /** Direction of this endpoint state: listener ownership or sender reservation. */
  readonly routeDirection?: LogicalPortRouteDirection;
  /** Host used for URLs and availability checks. */
  readonly host: string;
  /** Working directory that produced this route, used as a fallback scope when launcher metadata is missing. */
  readonly cwd?: string;
  /** Logical network scope this route belongs to, when allocated from an attached terminal. */
  readonly networkId?: string;
  /** Process row that owns this mapping when known. */
  readonly processId?: string;
  /** Human-readable process name for route table displays and env payloads. */
  readonly processName?: string;
  /** Current lifecycle state of the owning process. */
  readonly status: ProcessStatus;
  /** Origin of the route row. */
  readonly source: ProcessSource;
}

export interface AgentAllocateRouteRequest {
  /** Optional display name for a process that will use this allocation. */
  readonly name?: string;
  /** Optional shell command shown in diagnostics and future UI surfaces. */
  readonly command?: string;
  /** Working directory used as the default hashed route scope. */
  readonly cwd: string;
  /** Requested logical port. */
  readonly requestedPort: number;
  /** Host used for scanning and URL generation. */
  readonly host: string;
  /** Logical network scope inherited from an attached terminal window. */
  readonly networkId?: string;
  /** Whether this allocation is preparing a listener bind or a sender connect. */
  readonly routeDirection?: LogicalPortRouteDirection;
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

export interface PortRouteAllocation {
  /** Short-lived id used to release or replace the pending route; empty when reusing an active route. */
  readonly allocationId: string;
  /** Requested logical port. */
  readonly requestedPort: number;
  /** Actual TCP port assigned by the daemon. */
  readonly actualPort: number;
  /** Host associated with the route. */
  readonly host: string;
  /** True when the assigned actual port differs from the logical port. */
  readonly routed: boolean;
  /** Current logical routes plus this pending allocation. */
  readonly logicalRoutes: readonly LogicalPortRoute[];
  /** Path to the daemon-maintained dynamic route table. */
  readonly logicalRoutesFile: string;
  /** Expiration timestamp for the pending route if the client never registers. */
  readonly expiresAt: string;
}

export type AgentDaemonState = "starting" | "running" | "disconnected" | "error";
export type AgentDaemonVersionStatus = "current" | "stale" | "unknown";

export interface AgentDaemonStatus {
  /** Current extension-side view of the local daemon lifecycle. */
  readonly status: AgentDaemonState;
  /** PID of the single local agent process when connected. */
  readonly pid: number;
  /** ISO timestamp from daemon startup when known. */
  readonly startedAt?: string;
  /** ISO timestamp when the snapshot/status was produced. */
  readonly updatedAt: string;
  /** Dynamic route table JSON file path shared with managed processes. */
  readonly routeTablePath?: string;
  /** Compiled agent entrypoint path for detecting stale daemons after extension updates. */
  readonly agentMainPath?: string;
  /** Current extension's expected agent entrypoint, when known by the client. */
  readonly expectedAgentMainPath?: string;
  /** Whether the connected daemon matches the active extension build. */
  readonly versionStatus?: AgentDaemonVersionStatus;
  /** True when commands should restart the daemon before new terminal attaches. */
  readonly restartRequired?: boolean;
  /** Number of raw OS listeners in the latest daemon scan. */
  readonly listenerCount: number;
  /** Number of active logical route rows in the latest daemon snapshot. */
  readonly routeCount: number;
  /** Whether the daemon is scanning the OS listening table, not only managed rows. */
  readonly monitoringAllListeners: boolean;
  /** Last daemon or connection error if known. */
  readonly errorMessage?: string;
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
  /** Logical network scope inherited from an attached terminal window. */
  readonly networkId?: string;
  /** Optional pending route allocation that this running process consumes. */
  readonly allocationId?: string;
  /** Registration origin; native socket hook rows are managed by listener state. */
  readonly source?: "registered" | "hooked";
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
  /** Daemon lifecycle and monitoring metadata for UI/status surfaces. */
  readonly daemon: AgentDaemonStatus;
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

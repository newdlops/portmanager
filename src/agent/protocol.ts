import type {
  AgentAllocateRouteRequest,
  AgentSnapshot,
  AgentStartManagedProcessRequest,
  ManagedProcess,
  ProcessKillSignal,
  PortRouteAllocation,
  PortRoutingMode,
  RegisteredProcessInput,
  ScanDirection,
} from "../shared/types";

/**
 * Socket protocol contracts for Port Manager agent clients.
 *
 * The agent uses newline-delimited JSON so clients can keep one long-lived
 * socket and process both request responses and async snapshot events with a
 * tiny framing layer. Each request must include an id; snapshot events are
 * broadcast without an id because they are not responses to a specific call.
 */

export type AgentRequestMethod =
  | "listSnapshot"
  | "allocateRoute"
  | "releaseRouteAllocation"
  | "releaseProcessRoute"
  | "shutdownDaemon"
  | "startManagedProcess"
  | "registerExistingProcess"
  | "stopProcess"
  | "restartProcess"
  | "removeProcess"
  | "refreshSnapshot";

export type AgentRequestId = string | number;

export interface AgentRequestMessage<TPayload = unknown> {
  /** Correlation id copied to the response for this request. */
  readonly id: AgentRequestId;
  /** Request method understood by the agent dispatcher. */
  readonly method: AgentRequestMethod;
  /** Method-specific data. Empty requests may omit it. */
  readonly payload?: TPayload;
}

export interface AgentSuccessResponseMessage<TPayload = unknown> {
  /** Identifies the message as a response rather than a broadcast event. */
  readonly type: "response";
  /** Correlation id from the request. */
  readonly id: AgentRequestId;
  /** Request method that produced this response. */
  readonly method: AgentRequestMethod;
  /** True when the agent completed the request without throwing. */
  readonly ok: true;
  /** Method-specific result payload. */
  readonly payload: TPayload;
}

export interface AgentErrorResponseMessage {
  /** Identifies the message as a response rather than a broadcast event. */
  readonly type: "response";
  /** Correlation id from the request. */
  readonly id: AgentRequestId;
  /** Request method that failed. */
  readonly method: AgentRequestMethod;
  /** False when the request failed validation or execution. */
  readonly ok: false;
  /** Short error text suitable for VS Code notifications or logs. */
  readonly error: string;
}

export interface AgentSnapshotEventMessage {
  /** Async event delivered to every connected client after agent state changes. */
  readonly type: "snapshot";
  /** Complete current state; clients should reconcile from this payload. */
  readonly payload: AgentSnapshot;
}

export type AgentResponseMessage<TPayload = unknown> =
  | AgentSuccessResponseMessage<TPayload>
  | AgentErrorResponseMessage;

export type AgentOutboundMessage = AgentResponseMessage | AgentSnapshotEventMessage;

export interface StopProcessPayload {
  /** Registry id for the process row to stop. */
  readonly id: string;
  /** Optional signal supplied by the current VS Code settings. */
  readonly signal?: ProcessKillSignal;
}

export interface RestartProcessPayload {
  /** Registry id for the process row to restart from its launch profile. */
  readonly id: string;
  /** Optional current scan range override from VS Code settings. */
  readonly scanRange?: number;
  /** Optional current scan direction override from VS Code settings. */
  readonly scanDirection?: ScanDirection;
  /** Optional current routing mode override from VS Code settings. */
  readonly routingMode?: PortRoutingMode;
  /** Optional first TCP port in the hashed actual-port range. */
  readonly virtualPortRangeStart?: number;
  /** Optional last TCP port in the hashed actual-port range. */
  readonly virtualPortRangeEnd?: number;
  /** Optional signal used to stop the previous child before relaunching. */
  readonly signal?: ProcessKillSignal;
}

export interface RemoveProcessPayload {
  /** Registry or detected snapshot id to remove from the agent view. */
  readonly id: string;
}

export interface ReleaseRouteAllocationPayload {
  /** Pending allocation id returned by allocateRoute. */
  readonly allocationId: string;
}

export interface ReleaseProcessRoutePayload {
  /** PID of the hooked or registered process that owned the route. */
  readonly pid: number;
  /** Pending allocation id when the process exits before registration completes. */
  readonly allocationId?: string;
  /** Logical port originally requested by the process. */
  readonly requestedPort: number;
  /** Actual port the process bound after routing. */
  readonly actualPort: number;
  /** Logical network scope inherited by the process, when present. */
  readonly networkId?: string;
}

export type AgentRequestPayloadByMethod = {
  readonly listSnapshot: undefined;
  readonly allocateRoute: AgentAllocateRouteRequest;
  readonly releaseRouteAllocation: ReleaseRouteAllocationPayload;
  readonly releaseProcessRoute: ReleaseProcessRoutePayload;
  readonly shutdownDaemon: undefined;
  readonly startManagedProcess: AgentStartManagedProcessRequest;
  readonly registerExistingProcess: RegisteredProcessInput;
  readonly stopProcess: StopProcessPayload;
  readonly restartProcess: RestartProcessPayload;
  readonly removeProcess: RemoveProcessPayload;
  readonly refreshSnapshot: undefined;
};

export type AgentResponsePayloadByMethod = {
  readonly listSnapshot: AgentSnapshot;
  readonly allocateRoute: PortRouteAllocation;
  readonly releaseRouteAllocation: boolean;
  readonly releaseProcessRoute: boolean;
  readonly shutdownDaemon: boolean;
  readonly startManagedProcess: ManagedProcess;
  readonly registerExistingProcess: ManagedProcess;
  readonly stopProcess: ManagedProcess | undefined;
  readonly restartProcess: ManagedProcess | undefined;
  readonly removeProcess: ManagedProcess | undefined;
  readonly refreshSnapshot: AgentSnapshot;
};

/**
 * Encodes a protocol message as one NDJSON frame. JSON.stringify is the only
 * serialization rule; callers must keep payloads framework-neutral.
 */
export function encodeAgentMessage(message: AgentOutboundMessage | AgentRequestMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Parses one complete NDJSON line into an unknown JSON value.
 * Runtime validation is separate so tests and callers can inspect malformed
 * frames without coupling parsing to a specific request method.
 */
export function decodeAgentMessage(line: string): unknown {
  const trimmedLine = line.trim();

  if (trimmedLine.length === 0) {
    throw new Error("Cannot decode an empty Port Manager agent protocol frame.");
  }

  return JSON.parse(trimmedLine) as unknown;
}

/**
 * Incremental NDJSON decoder for socket data events.
 * TCP can split or coalesce writes arbitrarily, so the buffer keeps a trailing
 * partial line until the next chunk supplies its newline.
 */
export class NdjsonMessageBuffer {
  /** Incomplete trailing frame retained between socket data events. */
  private pendingText = "";

  /**
   * Appends a chunk and returns every complete decoded frame now available.
   * Empty lines are ignored so clients can safely write a final newline.
   */
  push(chunk: string | Buffer): readonly unknown[] {
    this.pendingText += chunk.toString();

    const lines = this.pendingText.split(/\r?\n/);
    this.pendingText = lines.pop() ?? "";

    const messages: unknown[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      messages.push(decodeAgentMessage(line));
    }

    return messages;
  }
}

/**
 * Structural guard used before dispatching socket input. The agent keeps this
 * deliberately small because each method validates its own payload shape.
 */
export function isAgentRequestMessage(value: unknown): value is AgentRequestMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AgentRequestMessage>;
  return isAgentRequestId(candidate.id) && isAgentRequestMethod(candidate.method);
}

/** Builds a successful response with the request correlation metadata. */
export function createSuccessResponse<TPayload>(
  request: AgentRequestMessage,
  payload: TPayload,
): AgentSuccessResponseMessage<TPayload> {
  return {
    type: "response",
    id: request.id,
    method: request.method,
    ok: true,
    payload,
  };
}

/** Builds a failed response with a normalized short error message. */
export function createErrorResponse(
  request: AgentRequestMessage,
  error: unknown,
): AgentErrorResponseMessage {
  return {
    type: "response",
    id: request.id,
    method: request.method,
    ok: false,
    error: toErrorMessage(error),
  };
}

/** Validates the small finite set of protocol request methods. */
function isAgentRequestMethod(value: unknown): value is AgentRequestMethod {
  return (
    value === "listSnapshot" ||
    value === "allocateRoute" ||
    value === "releaseRouteAllocation" ||
    value === "releaseProcessRoute" ||
    value === "shutdownDaemon" ||
    value === "startManagedProcess" ||
    value === "registerExistingProcess" ||
    value === "stopProcess" ||
    value === "restartProcess" ||
    value === "removeProcess" ||
    value === "refreshSnapshot"
  );
}

/** Request ids only need to be stable enough for a single client connection. */
function isAgentRequestId(value: unknown): value is AgentRequestId {
  return typeof value === "string" || typeof value === "number";
}

/** Converts unknown thrown values into transport-safe diagnostics. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { ManagedProcessRegistry } from "../core/process-registry";
import { PortRoutingService } from "../core/port-routing";
import { SimpleEventEmitter } from "../shared/events";
import { getDefaultRouteTablePath } from "./route-table";
import type {
  AgentAllocateRouteRequest,
  AgentSnapshot,
  AgentStartManagedProcessRequest,
  DisposableLike,
  AgentDaemonStatus,
  LogicalPortRoute,
  ListeningPort,
  ListeningPortProvider,
  ManagedProcess,
  ProcessKillSignal,
  ProcessLauncher,
  PortAvailabilityProvider,
  PortRouteAllocation,
  RegisteredProcessInput,
} from "../shared/types";
import {
  createErrorResponse,
  createSuccessResponse,
  encodeAgentMessage,
  isAgentRequestMessage,
  NdjsonMessageBuffer,
  type AgentRequestMessage,
  type RemoveProcessPayload,
  type RestartProcessPayload,
  type ReleaseRouteAllocationPayload,
  type StopProcessPayload,
} from "./protocol";

/**
 * Local Port Manager agent server.
 *
 * The agent is the single process-wide owner of routing state. VS Code windows
 * communicate with it through NDJSON over a local socket, while core routing
 * and platform process mechanics remain behind injected dependencies.
 */

const DEFAULT_KILL_SIGNAL: ProcessKillSignal = "SIGTERM";
const DETECTED_PROCESS_ID_PREFIX = "detected:";
const DEFAULT_LISTENER_SCAN_INTERVAL_MS = 3_000;
const DEFAULT_EXTERNAL_LISTENER_GRACE_MS = 60_000;
const DEFAULT_EXTERNAL_LISTENER_MISSING_SCAN_THRESHOLD = 3;
const ROUTE_ALLOCATION_TTL_MS = 30_000;

export interface PortManagerAgentOptions {
  /** Shared registry for managed and manually registered process rows. */
  readonly registry?: ManagedProcessRegistry;
  /** Low-level launcher used only for agent-owned child processes. */
  readonly processLauncher: ProcessLauncher;
  /** Provider used to scan whether a requested port can be bound. */
  readonly portAvailabilityProvider?: PortAvailabilityProvider;
  /** Full listening-port table provider for snapshot generation. */
  readonly listeningPortProvider: ListeningPortProvider;
  /** Optional prebuilt router, useful for tests that fake routing behavior. */
  readonly routingService?: PortRoutingService;
  /** Agent PID exposed in snapshots; injectable to keep tests deterministic. */
  readonly agentPid?: number;
  /** Supplies timestamps for registry updates and snapshot rows. */
  readonly now?: () => Date;
  /** Fallback signal when a request does not include settings-derived signal. */
  readonly defaultKillSignal?: ProcessKillSignal;
  /** Fallback host used to build detected listener URLs. */
  readonly defaultHost?: string;
  /** Fallback cwd for detected listeners that have no process working dir. */
  readonly defaultCwd?: string;
  /** JSON route table path shared with launched child processes. */
  readonly routeTablePath?: string;
  /** Compiled daemon entrypoint path used by clients to detect stale agents. */
  readonly agentMainPath?: string;
  /** Interval for daemon-side OS listener polling. */
  readonly listenerScanIntervalMs?: number;
  /** Grace period before hook/manual rows are stopped after a missing listener scan. */
  readonly externalListenerGraceMs?: number;
  /** Consecutive missing OS scans required before hook/manual rows can be stopped. */
  readonly externalListenerMissingScanThreshold?: number;
}

export interface BuildAgentSnapshotOptions {
  /** PID of the agent process that produced this snapshot. */
  readonly agentPid: number;
  /** Registry rows for managed and manually registered processes. */
  readonly registryProcesses: readonly ManagedProcess[];
  /** Short-lived routes allocated for external CLI launches before register. */
  readonly pendingRoutes?: readonly LogicalPortRoute[];
  /** Raw listener rows returned by the platform provider. */
  readonly listeners: readonly ListeningPort[];
  /** Snapshot timestamp shared by generated rows. */
  readonly updatedAt: string;
  /** Daemon startup timestamp exposed in sidebar/status UI. */
  readonly daemonStartedAt?: string;
  /** Dynamic JSON route table path shared with launched processes. */
  readonly routeTablePath?: string;
  /** Compiled daemon entrypoint path used by clients to detect stale agents. */
  readonly agentMainPath?: string;
  /** Detected listener row ids hidden by removeProcess. */
  readonly suppressedDetectedProcessIds?: ReadonlySet<string>;
  /** Host used when a listener address is not user-friendly for HTTP URLs. */
  readonly defaultHost?: string;
  /** CWD placeholder for detected rows, which usually cannot expose cwd. */
  readonly defaultCwd?: string;
}

interface AgentClientConnection {
  /** TCP or named-pipe socket for one connected VS Code client. */
  readonly socket: Socket;
  /** Per-client decoder because frames can be split differently per socket. */
  readonly buffer: NdjsonMessageBuffer;
}

interface PendingRouteAllocation {
  /** Opaque id returned to the client that requested the allocation. */
  readonly id: string;
  /** Route row visible until the launched process registers or TTL expires. */
  readonly route: LogicalPortRoute;
  /** Millisecond deadline after which the pending route is discarded. */
  readonly expiresAtMs: number;
}

interface MissingExternalListenerState {
  /** First background scan time when the registered listener was absent. */
  readonly sinceMs: number;
  /** Consecutive background scans that failed to observe the registered listener. */
  readonly scanCount: number;
}

interface BuildSnapshotRuntimeOptions {
  /**
   * True only for daemon background cleanup. Request/registration snapshots
   * must not let slow OS listener scans remove hook-owned routes.
   */
  readonly reconcileExternalListeners?: boolean;
}

/**
 * Serves Port Manager requests and broadcasts snapshots to connected clients.
 * Methods return domain objects so tests and future non-socket clients can use
 * the same implementation without going through the wire protocol.
 */
export class PortManagerAgent implements DisposableLike {
  /** Registry shared across every client connected to this agent process. */
  private readonly registry: ManagedProcessRegistry;

  /** Launcher owns only children created through startManagedProcess. */
  private readonly processLauncher: ProcessLauncher;

  /** Routing service maps requested ports to actual injected ports. */
  private readonly routingService: PortRoutingService;

  /** Provider used to merge all OS-level listeners into each snapshot. */
  private readonly listeningPortProvider: ListeningPortProvider;

  /** Saved profiles keyed by registry id; these are required for restart. */
  private readonly launchProfilesByProcessId = new Map<string, AgentStartManagedProcessRequest>();

  /** Detected listener rows hidden from process view after removeProcess. */
  private readonly suppressedDetectedProcessIds = new Set<string>();

  /** Short-lived route reservations created for external terminal wrappers. */
  private readonly pendingRouteAllocations = new Map<string, PendingRouteAllocation>();

  /** Last OS listener ports captured before or during route allocation. */
  private reservedListeningPorts = new Set<number>();

  /** Serializes route decisions so concurrent binds cannot reserve one actual port. */
  private routeOperationQueue: Promise<void> = Promise.resolve();

  /** Active socket clients that should receive snapshot broadcasts. */
  private readonly clients = new Set<AgentClientConnection>();

  /** Server-level errors are exposed so agent-main can terminate the daemon. */
  private readonly serverErrors = new SimpleEventEmitter<Error>();

  /** Disposables for registry and launcher subscriptions. */
  private readonly subscriptions: DisposableLike[] = [];

  /** Agent PID included in snapshots so clients can confirm daemon identity. */
  private readonly agentPid: number;

  /** Clock source used for lifecycle and snapshot timestamps. */
  private readonly now: () => Date;

  /** Timestamp captured when the daemon object is created. */
  private readonly startedAt: string;

  /** Default signal for stop/restart requests with no settings payload. */
  private readonly defaultKillSignal: ProcessKillSignal;

  /** Fallback host for generated detected listener URLs. */
  private readonly defaultHost: string;

  /** Fallback cwd for detected rows. */
  private readonly defaultCwd: string;

  /** JSON file path that stores the latest logical routing table. */
  private readonly routeTablePath: string;

  /** Compiled daemon entrypoint path for stale-daemon detection. */
  private readonly agentMainPath: string | undefined;

  /** Interval for rescanning the OS listening table while clients are attached. */
  private readonly listenerScanIntervalMs: number;

  /** Delay that absorbs short autoreload and process-table visibility gaps. */
  private readonly externalListenerGraceMs: number;

  /** Missing scan count required before external listener cleanup can stop rows. */
  private readonly externalListenerMissingScanThreshold: number;

  /** Timer that keeps OS Listening Ports fresh without manual refresh. */
  private listenerScanTimer: NodeJS.Timeout | undefined;

  /** Prevents overlapping lsof/netstat scans when an interval tick is slow. */
  private listenerScanInFlight = false;

  /** Background cleanup state for hook/manual rows absent from OS scans. */
  private readonly missingListenerStateByProcessId = new Map<string, MissingExternalListenerState>();

  /** Last broadcast signature, used to skip unchanged polling updates. */
  private lastSnapshotSignature = "";

  /** Last route table content signature, used to avoid timer-driven file churn. */
  private lastRouteTableSignature = "";

  /** Node net server once listen() has been called. */
  private server: Server | undefined;

  constructor(options: PortManagerAgentOptions) {
    this.registry =
      options.registry ??
      new ManagedProcessRegistry({
        now: options.now,
        defaultHost: options.defaultHost,
      });
    this.processLauncher = options.processLauncher;
    this.listeningPortProvider = options.listeningPortProvider;
    const portAvailabilityProvider = options.portAvailabilityProvider;
    this.routingService =
      options.routingService ??
      new PortRoutingService({
        check: async (port, host) => {
          if (this.isActualPortReserved(port)) {
            return {
              port,
              available: false,
              owner: {
                name: "Port Manager pending route allocation",
              },
            };
          }

          if (portAvailabilityProvider === undefined) {
            throw new Error("PortManagerAgent requires a portAvailabilityProvider or routingService.");
          }

          return portAvailabilityProvider.check(port, host);
        },
      });
    this.agentPid = options.agentPid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.startedAt = this.now().toISOString();
    this.defaultKillSignal = options.defaultKillSignal ?? DEFAULT_KILL_SIGNAL;
    this.defaultHost = options.defaultHost ?? "localhost";
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.routeTablePath = options.routeTablePath ?? getDefaultRouteTablePath();
    this.agentMainPath = options.agentMainPath;
    this.listenerScanIntervalMs = normalizeListenerScanInterval(options.listenerScanIntervalMs);
    this.externalListenerGraceMs = normalizeExternalListenerGraceMs(options.externalListenerGraceMs);
    this.externalListenerMissingScanThreshold = normalizeExternalListenerMissingScanThreshold(
      options.externalListenerMissingScanThreshold,
    );

    this.subscriptions.push(
      this.registry.onDidChange(() => {
        this.queueSnapshotBroadcast();
      }),
    );
    this.subscriptions.push(
      this.processLauncher.onExit((pid) => {
        this.markExitedProcessStopped(pid);
      }),
    );
  }

  /**
   * Starts the NDJSON socket server. The caller decides the socket path so a
   * separate launcher can enforce the "one agent per OS user" policy.
   */
  async listen(socketPath: string): Promise<void> {
    if (this.server !== undefined) {
      throw new Error("Port Manager agent is already listening.");
    }

    this.server = createServer((socket) => this.attachClient(socket));
    this.server.on("error", (error) => {
      this.serverErrors.emit(error);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === undefined) {
        reject(new Error("Port Manager agent server was not initialized."));
        return;
      }

      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });

    this.startListenerPolling();
  }

  /** Allows agent-main to exit if the underlying socket server fails. */
  onServerError(listener: (error: Error) => void): DisposableLike {
    return this.serverErrors.subscribe(listener);
  }

  /** Produces a complete snapshot by rescanning listening ports on demand. */
  async listSnapshot(): Promise<AgentSnapshot> {
    return this.buildSnapshot();
  }

  /**
   * Allocates an actual port for an external wrapper before it launches.
   * The pending route is short-lived so abandoned CLI attempts do not leave
   * stale logical mappings in the shared route table.
   */
  async allocateRoute(input: AgentAllocateRouteRequest): Promise<PortRouteAllocation> {
    return this.runExclusiveRouteOperation(async () => {
      this.cleanupExpiredRouteAllocations();

      const networkRouteScope = normalizeNetworkId(input.networkId);
      const decision = await this.routingService.route({
        requestedPort: input.requestedPort,
        host: input.host,
        scanRange: input.scanRange,
        scanDirection: input.scanDirection,
        routingMode: input.routingMode,
        routeScope: networkRouteScope ?? input.cwd,
        virtualPortRangeStart: input.virtualPortRangeStart,
        virtualPortRangeEnd: input.virtualPortRangeEnd,
      });
      const allocationId = `allocation:${randomUUID()}`;
      const expiresAtMs = this.now().getTime() + ROUTE_ALLOCATION_TTL_MS;
      const route = buildAllocatedLogicalRoute(input, decision.actualPort);

      this.pendingRouteAllocations.set(allocationId, {
        id: allocationId,
        route,
        expiresAtMs,
      });

      const logicalRoutes = this.buildCurrentLogicalRoutes();
      this.writeRouteTable(logicalRoutes);
      this.queueSnapshotBroadcast();

      return {
        allocationId,
        requestedPort: input.requestedPort,
        actualPort: decision.actualPort,
        host: input.host,
        routed: decision.routed,
        logicalRoutes,
        logicalRoutesFile: this.routeTablePath,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    });
  }

  /** Releases a pending route allocation that did not become a process row. */
  releaseRouteAllocation(allocationId: string): boolean {
    const released = this.pendingRouteAllocations.delete(allocationId);

    if (released) {
      this.writeRouteTable(this.buildCurrentLogicalRoutes());
      this.queueSnapshotBroadcast();
    }

    return released;
  }

  /**
   * Schedules daemon shutdown after the response frame has a chance to flush.
   * Running child processes are intentionally not killed here; the daemon is a
   * routing/control plane and Stop Process remains the explicit lifecycle tool.
   */
  shutdownDaemon(): boolean {
    setTimeout(() => {
      this.dispose();
    }, 25);

    return true;
  }

  /**
   * Starts a managed process after routing its requested port.
   * The launch profile is kept outside the public process model because it is
   * execution policy, not user-facing process state.
   */
  async startManagedProcess(input: AgentStartManagedProcessRequest): Promise<ManagedProcess> {
    return this.runExclusiveRouteOperation(() => this.startManagedProcessExclusive(input));
  }

  /** Starts a managed process while the route-decision lock is held. */
  private async startManagedProcessExclusive(input: AgentStartManagedProcessRequest): Promise<ManagedProcess> {
    await this.refreshReservedListeningPorts();

    const decision = await this.routingService.route({
      requestedPort: input.requestedPort,
      host: input.host,
      scanRange: input.scanRange,
      scanDirection: input.scanDirection,
      routingMode: input.routingMode,
      routeScope: input.cwd,
      virtualPortRangeStart: input.virtualPortRangeStart,
      virtualPortRangeEnd: input.virtualPortRangeEnd,
    });
    const pendingRoute = buildPendingLogicalRoute(input, decision.actualPort);

    const launchResult = await this.processLauncher.launch({
      name: input.name,
      command: input.command,
      cwd: input.cwd,
      requestedPort: input.requestedPort,
      host: input.host,
      actualPort: decision.actualPort,
      injectionMode: input.injectionMode,
      logicalRoutes: buildLogicalRoutes(this.registry.list(), [pendingRoute]),
      logicalRoutesFile: this.routeTablePath,
    });

    const process = this.registry.register(
      {
        pid: launchResult.pid,
        name: input.name,
        command: input.command,
        cwd: input.cwd,
        requestedPort: input.requestedPort,
        actualPort: decision.actualPort,
        host: input.host,
      },
      {
        source: "managed",
      },
    );

    this.launchProfilesByProcessId.set(process.id, { ...input });
    this.writeRouteTable(this.buildCurrentLogicalRoutes());
    return process;
  }

  /** Registers an already-running external process in the shared registry. */
  async registerExistingProcess(input: RegisteredProcessInput): Promise<ManagedProcess> {
    const allocation =
      input.allocationId !== undefined ? this.pendingRouteAllocations.get(input.allocationId) : undefined;

    if (input.allocationId !== undefined) {
      this.pendingRouteAllocations.delete(input.allocationId);
    }

    const registeredInput =
      input.networkId === undefined && allocation?.route.networkId !== undefined
        ? { ...input, networkId: allocation.route.networkId }
        : input;

    const process = this.upsertRegisteredProcess(
      registeredInput,
      input.source === "hooked" ? "hooked" : "registered",
    );
    this.missingListenerStateByProcessId.delete(process.id);
    this.writeRouteTable(this.buildCurrentLogicalRoutes());

    return process;
  }

  /**
   * Stops a process by registry id. The launcher no-ops for PIDs it did not
   * create, but the registry is still marked stopped so users can clear rows.
   */
  async stopProcess(id: string, signal: ProcessKillSignal = this.defaultKillSignal): Promise<ManagedProcess | undefined> {
    const process = this.registry.get(id);

    if (process === undefined) {
      return undefined;
    }

    if (process.status !== "stopped") {
      await this.processLauncher.stop(process.pid, signal);
    }

    const stoppedProcess = this.registry.stop(id, this.now().toISOString());
    this.missingListenerStateByProcessId.delete(id);
    this.writeRouteTable(this.buildCurrentLogicalRoutes());

    return stoppedProcess;
  }

  /**
   * Restarts a managed process from its saved profile while preserving the row
   * id. The requested logical port remains immutable; actualPort and PID may
   * change after routing.
   */
  async restartProcess(
    id: string,
    options: Omit<RestartProcessPayload, "id"> = {},
  ): Promise<ManagedProcess | undefined> {
    const process = this.registry.get(id);

    if (process === undefined) {
      return undefined;
    }

    const profile = this.launchProfilesByProcessId.get(id);
    if (profile === undefined) {
      throw new Error(`No launch profile is stored for process "${id}".`);
    }

    if (process.status !== "stopped") {
      await this.processLauncher.stop(process.pid, options.signal ?? this.defaultKillSignal);
      this.registry.stop(id, this.now().toISOString());
    }

    const nextProfile: AgentStartManagedProcessRequest = {
      ...profile,
      scanRange: options.scanRange ?? profile.scanRange,
      scanDirection: options.scanDirection ?? profile.scanDirection,
      routingMode: options.routingMode ?? profile.routingMode,
      virtualPortRangeStart: options.virtualPortRangeStart ?? profile.virtualPortRangeStart,
      virtualPortRangeEnd: options.virtualPortRangeEnd ?? profile.virtualPortRangeEnd,
    };

    return this.runExclusiveRouteOperation(async () => {
      await this.refreshReservedListeningPorts();

      const decision = await this.routingService.route({
        requestedPort: nextProfile.requestedPort,
        host: nextProfile.host,
        scanRange: nextProfile.scanRange,
        scanDirection: nextProfile.scanDirection,
        routingMode: nextProfile.routingMode,
        routeScope: nextProfile.cwd,
        virtualPortRangeStart: nextProfile.virtualPortRangeStart,
        virtualPortRangeEnd: nextProfile.virtualPortRangeEnd,
      });
      const pendingRoute = buildPendingLogicalRoute(nextProfile, decision.actualPort);

      const launchResult = await this.processLauncher.launch({
        name: nextProfile.name,
        command: nextProfile.command,
        cwd: nextProfile.cwd,
        requestedPort: nextProfile.requestedPort,
        host: nextProfile.host,
        actualPort: decision.actualPort,
        injectionMode: nextProfile.injectionMode,
        logicalRoutes: buildLogicalRoutes(
          this.registry.list().filter((candidate) => candidate.id !== id),
          [pendingRoute],
        ),
        logicalRoutesFile: this.routeTablePath,
      });

      this.launchProfilesByProcessId.set(id, nextProfile);

      const restartedProcess = this.registry.update(id, {
        pid: launchResult.pid,
        name: nextProfile.name,
        command: nextProfile.command,
        cwd: nextProfile.cwd,
        actualPort: decision.actualPort,
        status: "running",
        startedAt: this.now().toISOString(),
        stoppedAt: undefined,
        url: buildUrl(nextProfile.host, decision.actualPort),
        errorMessage: undefined,
        source: "managed",
      });
      this.writeRouteTable(this.buildCurrentLogicalRoutes());

      return restartedProcess;
    });
  }

  /**
   * Removes registry rows or suppresses detected listener rows from snapshots.
   * Detected rows have no registry entry because they are reconstructed from
   * the latest listening-port scan.
   */
  async removeProcess(id: string): Promise<ManagedProcess | undefined> {
    const removedProcess = this.registry.remove(id);
    this.launchProfilesByProcessId.delete(id);
    this.missingListenerStateByProcessId.delete(id);

    if (removedProcess !== undefined) {
      this.writeRouteTable(this.buildCurrentLogicalRoutes());
      return removedProcess;
    }

    if (id.startsWith(DETECTED_PROCESS_ID_PREFIX)) {
      this.suppressedDetectedProcessIds.add(id);
      this.queueSnapshotBroadcast();
    }

    return undefined;
  }

  /** Forces a rescan and broadcasts the resulting state to all clients. */
  async refreshSnapshot(): Promise<AgentSnapshot> {
    const snapshot = await this.buildSnapshot();
    this.lastSnapshotSignature = buildSnapshotSignature(snapshot);
    this.broadcastSnapshot(snapshot);
    return snapshot;
  }

  /** Releases sockets, event subscriptions, and server resources. */
  dispose(): void {
    for (const client of [...this.clients]) {
      client.socket.destroy();
    }
    this.clients.clear();

    if (this.server !== undefined) {
      this.server.close();
      this.server = undefined;
    }

    if (this.listenerScanTimer !== undefined) {
      clearInterval(this.listenerScanTimer);
      this.listenerScanTimer = undefined;
    }

    while (this.subscriptions.length > 0) {
      this.subscriptions.pop()?.dispose();
    }
  }

  /**
   * Connects socket lifecycle events to request dispatch. Each socket gets its
   * own NDJSON buffer because TCP chunking is per connection.
   */
  private attachClient(socket: Socket): void {
    const client: AgentClientConnection = {
      socket,
      buffer: new NdjsonMessageBuffer(),
    };
    this.clients.add(client);

    socket.on("data", (chunk) => {
      this.handleClientData(client, chunk);
    });
    socket.on("close", () => {
      this.clients.delete(client);
    });
    socket.on("error", () => {
      this.clients.delete(client);
    });
  }

  /**
   * Decodes every complete frame in a data chunk and dispatches valid requests.
   * Malformed JSON cannot be correlated to a request id, so the connection is
   * closed after returning the parse error as a socket-level failure.
   */
  private handleClientData(client: AgentClientConnection, chunk: Buffer): void {
    let decodedMessages: readonly unknown[];

    try {
      decodedMessages = client.buffer.push(chunk);
    } catch (error) {
      client.socket.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    for (const message of decodedMessages) {
      this.handleClientMessage(client, message);
    }
  }

  /**
   * Validates and handles one decoded request. The response is always written
   * to the same socket, while state changes are broadcast separately.
   */
  private handleClientMessage(client: AgentClientConnection, message: unknown): void {
    if (!isAgentRequestMessage(message)) {
      client.socket.destroy(new Error("Invalid Port Manager agent request message."));
      return;
    }

    void this.dispatchRequest(message)
      .then((payload) => {
        this.writeClientMessage(client, createSuccessResponse(message, payload));
      })
      .catch((error: unknown) => {
        this.writeClientMessage(client, createErrorResponse(message, error));
      });
  }

  /** Routes request methods to their domain operation. */
  private async dispatchRequest(request: AgentRequestMessage): Promise<unknown> {
    switch (request.method) {
      case "listSnapshot":
        return this.listSnapshot();
      case "allocateRoute":
        return this.allocateRoute(request.payload as AgentAllocateRouteRequest);
      case "releaseRouteAllocation": {
        const payload = request.payload as ReleaseRouteAllocationPayload;
        return this.releaseRouteAllocation(payload.allocationId);
      }
      case "shutdownDaemon":
        return this.shutdownDaemon();
      case "startManagedProcess":
        return this.startManagedProcess(request.payload as AgentStartManagedProcessRequest);
      case "registerExistingProcess":
        return this.registerExistingProcess(request.payload as RegisteredProcessInput);
      case "stopProcess": {
        const payload = request.payload as StopProcessPayload;
        return this.stopProcess(payload.id, payload.signal);
      }
      case "restartProcess": {
        const payload = request.payload as RestartProcessPayload;
        return this.restartProcess(payload.id, payload);
      }
      case "removeProcess": {
        const payload = request.payload as RemoveProcessPayload;
        return this.removeProcess(payload.id);
      }
      case "refreshSnapshot":
        return this.refreshSnapshot();
    }
  }

  /** Writes a framed protocol message unless the client has already closed. */
  private writeClientMessage(client: AgentClientConnection, message: Parameters<typeof encodeAgentMessage>[0]): void {
    if (client.socket.destroyed) {
      return;
    }

    client.socket.write(encodeAgentMessage(message));
  }

  /** Broadcasts a snapshot event to every currently connected client. */
  private broadcastSnapshot(snapshot: AgentSnapshot): void {
    this.lastSnapshotSignature = buildSnapshotSignature(snapshot);
    const message = encodeAgentMessage({
      type: "snapshot",
      payload: snapshot,
    });

    for (const client of [...this.clients]) {
      if (client.socket.destroyed) {
        this.clients.delete(client);
        continue;
      }

      client.socket.write(message);
    }
  }

  /**
   * Schedules an async snapshot broadcast after registry changes. Failures are
   * surfaced through the server error channel because clients cannot be tied to
   * a specific failed background scan.
   */
  private queueSnapshotBroadcast(): void {
    if (this.clients.size === 0) {
      return;
    }

    void this.buildSnapshot()
      .then((snapshot) => this.broadcastSnapshot(snapshot))
      .catch((error: unknown) => {
        this.serverErrors.emit(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * Runs a route decision and its immediate reservation as a critical section.
   * External shell hooks can bind many processes at once; without this queue,
   * two requests can observe the same candidate port as free before either
   * pending allocation is recorded.
   */
  private async runExclusiveRouteOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previousOperation = this.routeOperationQueue;
    let releaseCurrentOperation: () => void = () => undefined;

    this.routeOperationQueue = new Promise<void>((resolve) => {
      releaseCurrentOperation = resolve;
    });

    await previousOperation;

    try {
      return await operation();
    } finally {
      releaseCurrentOperation();
    }
  }

  /** Starts the daemon-side OS listener polling loop. */
  private startListenerPolling(): void {
    if (this.listenerScanTimer !== undefined) {
      return;
    }

    this.listenerScanTimer = setInterval(() => {
      void this.pollListeningPorts();
    }, this.listenerScanIntervalMs);
    this.listenerScanTimer.unref();
  }

  /**
   * Periodically rescans OS listeners and broadcasts only real table changes.
   * This is what removes stale OS Listening Ports after an external process
   * exits without any Port Manager command being invoked.
   */
  private async pollListeningPorts(): Promise<void> {
    if (this.listenerScanInFlight) {
      return;
    }

    this.listenerScanInFlight = true;

    try {
      const snapshot = await this.buildSnapshot({ reconcileExternalListeners: true });
      const nextSignature = buildSnapshotSignature(snapshot);

      if (this.clients.size > 0 && nextSignature !== this.lastSnapshotSignature) {
        this.broadcastSnapshot(snapshot);
      } else {
        this.lastSnapshotSignature = nextSignature;
      }
    } catch (error) {
      this.serverErrors.emit(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.listenerScanInFlight = false;
    }
  }

  /**
   * Builds a snapshot from the registry and a fresh listening-port scan.
   * The merge function is exported separately so the de-duplication policy is
   * unit-testable without a real child process or OS command.
   */
  private async buildSnapshot(options: BuildSnapshotRuntimeOptions = {}): Promise<AgentSnapshot> {
    this.cleanupExpiredRouteAllocations();

    const listeners = await this.listeningPortProvider.list();
    this.updateReservedListeningPorts(listeners);
    if (options.reconcileExternalListeners === true) {
      this.reconcileRegisteredProcessesWithListeners(listeners);
    }
    const snapshot = buildAgentSnapshot({
      agentPid: this.agentPid,
      registryProcesses: this.registry.list(),
      pendingRoutes: this.listPendingRoutes(),
      listeners,
      updatedAt: this.now().toISOString(),
      daemonStartedAt: this.startedAt,
      routeTablePath: this.routeTablePath,
      agentMainPath: this.agentMainPath,
      suppressedDetectedProcessIds: this.suppressedDetectedProcessIds,
      defaultHost: this.defaultHost,
      defaultCwd: this.defaultCwd,
    });

    this.writeRouteTable(snapshot.routes);
    return snapshot;
  }

  /** Marks hook-registered external processes stopped when their listener exits. */
  private reconcileRegisteredProcessesWithListeners(listeners: readonly ListeningPort[]): void {
    const activeListenerKeys = new Set(listeners.map((listener) => buildListenerKey(listener.pid, listener.port)));
    const nowMs = this.now().getTime();

    for (const process of this.registry.list()) {
      if (process.status !== "running" || !isListenerOwnedExternalProcess(process)) {
        this.missingListenerStateByProcessId.delete(process.id);
        continue;
      }

      if (activeListenerKeys.has(buildListenerKey(process.pid, process.actualPort))) {
        this.missingListenerStateByProcessId.delete(process.id);
        continue;
      }

      const previousState = this.missingListenerStateByProcessId.get(process.id);
      const missingState: MissingExternalListenerState = {
        sinceMs: previousState?.sinceMs ?? nowMs,
        scanCount: (previousState?.scanCount ?? 0) + 1,
      };
      this.missingListenerStateByProcessId.set(process.id, missingState);

      if (
        nowMs - missingState.sinceMs >= this.externalListenerGraceMs &&
        missingState.scanCount >= this.externalListenerMissingScanThreshold
      ) {
        this.registry.stop(process.id, this.now().toISOString());
        this.missingListenerStateByProcessId.delete(process.id);
      }
    }
  }

  /** Builds active routes from registry rows and short-lived allocations. */
  private buildCurrentLogicalRoutes(): readonly LogicalPortRoute[] {
    this.cleanupExpiredRouteAllocations();
    return buildLogicalRoutes(this.registry.list(), this.listPendingRoutes());
  }

  /** Lists pending route rows in a stable order for snapshots and env payloads. */
  private listPendingRoutes(): readonly LogicalPortRoute[] {
    return [...this.pendingRouteAllocations.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((allocation) => ({ ...allocation.route }));
  }

  /** True when a short-lived route allocation already owns this actual port. */
  private isActualPortReserved(port: number): boolean {
    this.cleanupExpiredRouteAllocations();
    if ([...this.pendingRouteAllocations.values()].some((allocation) => allocation.route.actualPort === port)) {
      return true;
    }

    /*
     * A listener can disappear briefly while a dev server reloads or while the
     * OS command table is catching up. Keep active registry ports reserved so
     * another concurrent bind cannot claim the same actual port during grace.
     */
    if (
      this.registry
        .list()
        .some((process) => process.status === "running" && process.source !== "detected" && process.actualPort === port)
    ) {
      return true;
    }

    return this.reservedListeningPorts.has(port);
  }

  /**
   * Refreshes OS listener reservations before route selection. This protects the
   * route policy when a low-level availability probe is affected by preload
   * state or process-table timing and incorrectly reports a busy port as free.
   */
  private async refreshReservedListeningPorts(): Promise<void> {
    try {
      this.updateReservedListeningPorts(await this.listeningPortProvider.list());
    } catch {
      // Availability probing remains the source of truth when lsof/netstat fail.
    }
  }

  /** Replaces the reservation cache with one coherent listener scan. */
  private updateReservedListeningPorts(listeners: readonly ListeningPort[]): void {
    this.reservedListeningPorts = new Set(
      listeners
        .map((listener) => listener.port)
        .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535),
    );
  }

  /** Removes abandoned route allocations after their TTL. */
  private cleanupExpiredRouteAllocations(): void {
    const nowMs = this.now().getTime();

    for (const [id, allocation] of this.pendingRouteAllocations) {
      if (allocation.expiresAtMs <= nowMs) {
        this.pendingRouteAllocations.delete(id);
      }
    }
  }

  /** Writes the latest dynamic route table for already-running children. */
  private writeRouteTable(routes: readonly LogicalPortRoute[]): void {
    const routeTableSignature = buildRouteTableSignature(routes);
    if (routeTableSignature === this.lastRouteTableSignature && fs.existsSync(this.routeTablePath)) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.routeTablePath), { recursive: true });
      fs.writeFileSync(
        this.routeTablePath,
        `${JSON.stringify({ updatedAt: this.now().toISOString(), routes }, null, 2)}\n`,
        "utf8",
      );
      this.lastRouteTableSignature = routeTableSignature;
    } catch {
      // Route table file updates are a convenience channel. Snapshot delivery
      // and managed process lifecycle should continue if the write fails.
    }
  }

  /**
   * Marks an agent-owned process as stopped when the launcher observes exit.
   * Missing or already stopped rows are ignored because remove/stop may have
   * won the race before the child emitted its exit event.
   */
  private markExitedProcessStopped(pid: number): void {
    const process = this.registry.list().find((candidate) => candidate.pid === pid);

    if (process === undefined || process.status === "stopped") {
      return;
    }

    this.registry.stop(process.id, this.now().toISOString());
    this.missingListenerStateByProcessId.delete(process.id);
  }

  /**
   * Native hooks can register the same logical route more than once during
   * autoreload or shebang handoff. Updating the existing row keeps route table
   * ownership stable instead of accumulating stale duplicate rows.
   */
  private upsertRegisteredProcess(input: RegisteredProcessInput, source: "hooked" | "registered"): ManagedProcess {
    const existingProcess = this.findRegisteredProcessForRoute(input, source);

    if (existingProcess === undefined) {
      return this.registry.register(input, { source });
    }

    return this.registry.update(existingProcess.id, {
      pid: input.pid,
      name: input.name,
      command: input.command,
      cwd: input.cwd,
      networkId: normalizeNetworkId(input.networkId),
      actualPort: input.actualPort,
      status: "running",
      startedAt: this.now().toISOString(),
      stoppedAt: undefined,
      url: buildUrl(input.host || this.defaultHost, input.actualPort),
      errorMessage: undefined,
      source,
    });
  }

  /** Finds the active row that owns the same route identity, ignoring PID churn. */
  private findRegisteredProcessForRoute(
    input: RegisteredProcessInput,
    source: "hooked" | "registered",
  ): ManagedProcess | undefined {
    const inputNetworkId = normalizeNetworkId(input.networkId);

    return this.registry.list().find((process) => {
      if (process.status !== "running" || process.source !== source) {
        return false;
      }

      return (
        process.requestedPort === input.requestedPort &&
        process.actualPort === input.actualPort &&
        normalizeNetworkId(process.networkId) === inputNetworkId
      );
    });
  }
}

/**
 * Hook/manual registrations are owned by OS listener state because the agent
 * did not spawn them and cannot rely on child-process exit events.
 */
function isListenerOwnedExternalProcess(process: ManagedProcess): boolean {
  return process.source === "registered" || process.source === "hooked";
}

/**
 * Merges registry state with raw listening ports into one client snapshot.
 * Registry rows win over raw listeners when PID and actual port match, because
 * those rows carry the logical requestedPort -> actualPort routing context.
 */
export function buildAgentSnapshot(options: BuildAgentSnapshotOptions): AgentSnapshot {
  const activeTrackedListenerKeys = buildActiveTrackedListenerKeys(options.registryProcesses);
  const normalizedListeners = dedupeListeners(options.listeners).map((listener) =>
    activeTrackedListenerKeys.has(buildListenerKey(listener.pid, listener.port))
      ? { ...listener, source: "managed" as const }
      : listener,
  );

  const detectedProcesses = normalizedListeners
    .filter((listener) => !activeTrackedListenerKeys.has(buildListenerKey(listener.pid, listener.port)))
    .map((listener) =>
      buildDetectedProcess(listener, {
        defaultHost: options.defaultHost ?? "localhost",
        defaultCwd: options.defaultCwd ?? "",
      }),
    )
    .filter((process) => !options.suppressedDetectedProcessIds?.has(process.id));

  const routes = buildLogicalRoutes(options.registryProcesses, options.pendingRoutes ?? []);
  const daemon = buildDaemonStatus({
    agentPid: options.agentPid,
    updatedAt: options.updatedAt,
    startedAt: options.daemonStartedAt,
    routeTablePath: options.routeTablePath,
    agentMainPath: options.agentMainPath,
    listenerCount: normalizedListeners.length,
    routeCount: routes.length,
  });

  return {
    agentPid: options.agentPid,
    daemon,
    processes: [...options.registryProcesses.map((process) => ({ ...process })), ...detectedProcesses],
    listeners: normalizedListeners,
    routes,
    updatedAt: options.updatedAt,
  };
}

/** Creates daemon metadata for status commands and sidebar display. */
function buildDaemonStatus(options: {
  readonly agentPid: number;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly routeTablePath?: string;
  readonly agentMainPath?: string;
  readonly listenerCount: number;
  readonly routeCount: number;
}): AgentDaemonStatus {
  return {
    status: "running",
    pid: options.agentPid,
    startedAt: options.startedAt,
    updatedAt: options.updatedAt,
    routeTablePath: options.routeTablePath,
    agentMainPath: options.agentMainPath,
    listenerCount: options.listenerCount,
    routeCount: options.routeCount,
    monitoringAllListeners: true,
  };
}

/**
 * Builds the logical routing table from active managed and registered rows.
 * Stopped rows are excluded because their previous actual port is no longer a
 * live target for process-to-process communication.
 */
function buildLogicalRoutes(
  processes: readonly ManagedProcess[],
  pendingRoutes: readonly LogicalPortRoute[] = [],
): readonly LogicalPortRoute[] {
  const routes = processes
    .filter((process) => process.status === "running" && process.source !== "detected")
    .map((process) => ({
      logicalPort: process.requestedPort,
      actualPort: process.actualPort,
      host: routeHostFromUrl(process.url),
      ...(process.networkId ? { networkId: process.networkId } : {}),
      processId: process.id,
      processName: process.name,
      status: process.status,
      source: process.source ?? "managed",
    }));

  return dedupeLogicalRoutes([...routes, ...pendingRoutes.map((route) => ({ ...route }))]);
}

/**
 * The native route lookup is keyed by logical port and network scope. If a dev
 * server re-registers during rapid restarts, only the newest mapping for that
 * identity should remain visible to child processes.
 */
function dedupeLogicalRoutes(routes: readonly LogicalPortRoute[]): readonly LogicalPortRoute[] {
  const routesByIdentity = new Map<string, LogicalPortRoute>();

  for (const route of routes) {
    const identity = buildLogicalRouteIdentity(route);

    if (routesByIdentity.has(identity)) {
      routesByIdentity.delete(identity);
    }

    routesByIdentity.set(identity, { ...route });
  }

  return [...routesByIdentity.values()];
}

/** Matches the native hook's lookup identity: network scope plus logical port. */
function buildLogicalRouteIdentity(route: LogicalPortRoute): string {
  return `${route.networkId ?? ""}:${route.logicalPort}`;
}

/** Creates the route row for a process before the registry has assigned an id. */
function buildPendingLogicalRoute(input: AgentStartManagedProcessRequest, actualPort: number): LogicalPortRoute {
  return {
    logicalPort: input.requestedPort,
    actualPort,
    host: input.host,
    processName: input.name,
    status: "running",
    source: "managed",
  };
}

/** Creates a route row for an external CLI process before it is spawned. */
function buildAllocatedLogicalRoute(input: AgentAllocateRouteRequest, actualPort: number): LogicalPortRoute {
  return {
    logicalPort: input.requestedPort,
    actualPort,
    host: input.host,
    ...logicalNetworkRouteScope(input.networkId),
    processName: input.name ?? input.command,
    status: "starting",
    source: "allocated",
  };
}

/** Normalizes absent or blank terminal network scope to the unscoped route path. */
function normalizeNetworkId(networkId: string | undefined): string | undefined {
  const normalized = networkId?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/** Adds network scope to a route only when the hook actually provided one. */
function logicalNetworkRouteScope(
  networkId: string | undefined,
): Pick<LogicalPortRoute, "networkId"> | Record<string, never> {
  const normalized = normalizeNetworkId(networkId);
  return normalized === undefined ? {} : { networkId: normalized };
}

/**
 * Builds match keys for registry rows that should suppress duplicate detected
 * process rows. Stopped rows are intentionally excluded so a still-listening
 * PID remains visible as an external listener if termination did not complete.
 */
function buildActiveTrackedListenerKeys(processes: readonly ManagedProcess[]): ReadonlySet<string> {
  const keys = new Set<string>();

  for (const process of processes) {
    if (process.status === "stopped") {
      continue;
    }

    keys.add(buildListenerKey(process.pid, process.actualPort));
  }

  return keys;
}

/** Creates a stable listener match key from the OS PID and TCP port. */
function buildListenerKey(pid: number | undefined, port: number): string {
  return `${pid ?? "unknown"}:${port}`;
}

/**
 * Removes exact duplicate listener ids while preserving platform scan order.
 * Providers should already produce stable ids, but this protects clients from
 * duplicated OS command rows.
 */
function dedupeListeners(listeners: readonly ListeningPort[]): readonly ListeningPort[] {
  const listenersById = new Map<string, ListeningPort>();

  for (const listener of listeners) {
    if (!listenersById.has(listener.id)) {
      listenersById.set(listener.id, { ...listener });
    }
  }

  return [...listenersById.values()];
}

/** Converts one raw listener into a synthetic process row for the sidebar. */
function buildDetectedProcess(
  listener: ListeningPort,
  defaults: { readonly defaultHost: string; readonly defaultCwd: string },
): ManagedProcess {
  const name = listener.processName ?? `Port ${listener.port}`;

  return {
    id: `${DETECTED_PROCESS_ID_PREFIX}${listener.id}`,
    pid: listener.pid ?? 0,
    name,
    command: listener.command ?? name,
    cwd: defaults.defaultCwd,
    requestedPort: listener.port,
    actualPort: listener.port,
    status: "running",
    startedAt: listener.updatedAt,
    url: buildUrl(normalizeListenerHost(listener.localAddress, defaults.defaultHost), listener.port),
    source: "detected",
  };
}

/** Builds the MVP HTTP URL from a host and actual local port. */
function buildUrl(host: string, actualPort: number): string {
  const normalizedHost = host.trim() || "localhost";
  return `http://${normalizedHost}:${actualPort}`;
}

/** Extracts a route host from a stored URL without making URL parsing fatal. */
function routeHostFromUrl(url: string | undefined): string {
  if (url === undefined) {
    return "localhost";
  }

  try {
    return new URL(url).hostname;
  } catch {
    return "localhost";
  }
}

/**
 * Converts wildcard bind addresses into a URL users can open in a browser.
 * OS tools often report 0.0.0.0 or :: for "all interfaces", but localhost is
 * the useful local development target.
 */
function normalizeListenerHost(localAddress: string, defaultHost: string): string {
  const trimmedAddress = localAddress.trim();

  if (
    trimmedAddress.length === 0 ||
    trimmedAddress === "*" ||
    trimmedAddress === "0.0.0.0" ||
    trimmedAddress === "::" ||
    trimmedAddress === "[::]"
  ) {
    return defaultHost;
  }

  return trimmedAddress;
}

/** Keeps daemon listener polling responsive without creating a tight loop. */
function normalizeListenerScanInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined || !Number.isFinite(intervalMs)) {
    return DEFAULT_LISTENER_SCAN_INTERVAL_MS;
  }

  return Math.max(1_000, Math.trunc(intervalMs));
}

/** Keeps external listener cleanup delayed enough for autoreload handoffs. */
function normalizeExternalListenerGraceMs(graceMs: number | undefined): number {
  if (graceMs === undefined || !Number.isFinite(graceMs)) {
    return DEFAULT_EXTERNAL_LISTENER_GRACE_MS;
  }

  return Math.max(0, Math.trunc(graceMs));
}

/** Requires repeated background misses before trusting listener disappearance. */
function normalizeExternalListenerMissingScanThreshold(threshold: number | undefined): number {
  if (threshold === undefined || !Number.isFinite(threshold)) {
    return DEFAULT_EXTERNAL_LISTENER_MISSING_SCAN_THRESHOLD;
  }

  return Math.max(1, Math.trunc(threshold));
}

/**
 * Builds a stable signature for real snapshot contents.
 * Volatile timestamps are excluded so the polling loop refreshes only when
 * listeners, routes, or process lifecycle rows actually change.
 */
function buildSnapshotSignature(snapshot: AgentSnapshot): string {
  const listenerRows = snapshot.listeners
    .map((listener) => [
      listener.id,
      listener.localAddress,
      listener.port,
      listener.pid ?? "",
      listener.processName ?? "",
      listener.command ?? "",
      listener.source,
    ])
    .sort(compareSignatureRows);
  const processRows = snapshot.processes
    .map((process) => [
      process.id,
      process.pid,
      process.requestedPort,
      process.actualPort,
      process.networkId ?? "",
      process.status,
      process.source ?? "",
    ])
    .sort(compareSignatureRows);
  return JSON.stringify({
    listeners: listenerRows,
    processes: processRows,
    routes: buildRouteSignatureRows(snapshot.routes),
  });
}

/** Builds a content-only route table signature for write de-duplication. */
function buildRouteTableSignature(routes: readonly LogicalPortRoute[]): string {
  return JSON.stringify(buildRouteSignatureRows(routes));
}

/** Normalizes route rows so snapshot and route-file signatures stay aligned. */
function buildRouteSignatureRows(routes: readonly LogicalPortRoute[]): readonly (readonly unknown[])[] {
  const routeRows = routes
    .map((route) => [
      route.logicalPort,
      route.actualPort,
      route.host,
      route.networkId ?? "",
      route.processId ?? "",
      route.status,
      route.source,
    ])
    .sort(compareSignatureRows);

  return routeRows;
}

/** Sorts signature rows by their serialized value for stable comparisons. */
function compareSignatureRows(left: readonly unknown[], right: readonly unknown[]): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

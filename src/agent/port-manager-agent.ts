import { createServer, type Server, type Socket } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagedProcessRegistry } from "../core/process-registry";
import { PortRoutingService } from "../core/port-routing";
import { SimpleEventEmitter } from "../shared/events";
import type {
  AgentSnapshot,
  AgentStartManagedProcessRequest,
  DisposableLike,
  LogicalPortRoute,
  ListeningPort,
  ListeningPortProvider,
  ManagedProcess,
  ProcessKillSignal,
  ProcessLauncher,
  PortAvailabilityProvider,
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
}

export interface BuildAgentSnapshotOptions {
  /** PID of the agent process that produced this snapshot. */
  readonly agentPid: number;
  /** Registry rows for managed and manually registered processes. */
  readonly registryProcesses: readonly ManagedProcess[];
  /** Raw listener rows returned by the platform provider. */
  readonly listeners: readonly ListeningPort[];
  /** Snapshot timestamp shared by generated rows. */
  readonly updatedAt: string;
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

  /** Default signal for stop/restart requests with no settings payload. */
  private readonly defaultKillSignal: ProcessKillSignal;

  /** Fallback host for generated detected listener URLs. */
  private readonly defaultHost: string;

  /** Fallback cwd for detected rows. */
  private readonly defaultCwd: string;

  /** JSON file path that stores the latest logical routing table. */
  private readonly routeTablePath: string;

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
    this.routingService =
      options.routingService ?? new PortRoutingService(requirePortAvailabilityProvider(options));
    this.agentPid = options.agentPid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.defaultKillSignal = options.defaultKillSignal ?? DEFAULT_KILL_SIGNAL;
    this.defaultHost = options.defaultHost ?? "localhost";
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.routeTablePath = options.routeTablePath ?? getDefaultRouteTablePath();

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
   * Starts a managed process after routing its requested port.
   * The launch profile is kept outside the public process model because it is
   * execution policy, not user-facing process state.
   */
  async startManagedProcess(input: AgentStartManagedProcessRequest): Promise<ManagedProcess> {
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
      logicalRoutes: buildLogicalRoutes(this.registry.list(), pendingRoute),
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
    return process;
  }

  /** Registers an already-running external process in the shared registry. */
  async registerExistingProcess(input: RegisteredProcessInput): Promise<ManagedProcess> {
    return this.registry.register(input, {
      source: "registered",
    });
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

    return this.registry.stop(id, this.now().toISOString());
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
        pendingRoute,
      ),
      logicalRoutesFile: this.routeTablePath,
    });

    this.launchProfilesByProcessId.set(id, nextProfile);

    return this.registry.update(id, {
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
  }

  /**
   * Removes registry rows or suppresses detected listener rows from snapshots.
   * Detected rows have no registry entry because they are reconstructed from
   * the latest listening-port scan.
   */
  async removeProcess(id: string): Promise<ManagedProcess | undefined> {
    const removedProcess = this.registry.remove(id);
    this.launchProfilesByProcessId.delete(id);

    if (removedProcess !== undefined) {
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
   * Builds a snapshot from the registry and a fresh listening-port scan.
   * The merge function is exported separately so the de-duplication policy is
   * unit-testable without a real child process or OS command.
   */
  private async buildSnapshot(): Promise<AgentSnapshot> {
    const listeners = await this.listeningPortProvider.list();
    const snapshot = buildAgentSnapshot({
      agentPid: this.agentPid,
      registryProcesses: this.registry.list(),
      listeners,
      updatedAt: this.now().toISOString(),
      suppressedDetectedProcessIds: this.suppressedDetectedProcessIds,
      defaultHost: this.defaultHost,
      defaultCwd: this.defaultCwd,
    });

    this.writeRouteTable(snapshot.routes);
    return snapshot;
  }

  /** Writes the latest dynamic route table for already-running children. */
  private writeRouteTable(routes: readonly LogicalPortRoute[]): void {
    try {
      fs.mkdirSync(path.dirname(this.routeTablePath), { recursive: true });
      fs.writeFileSync(
        this.routeTablePath,
        `${JSON.stringify({ updatedAt: this.now().toISOString(), routes }, null, 2)}\n`,
        "utf8",
      );
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
  }
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

  return {
    agentPid: options.agentPid,
    processes: [...options.registryProcesses.map((process) => ({ ...process })), ...detectedProcesses],
    listeners: normalizedListeners,
    routes: buildLogicalRoutes(options.registryProcesses),
    updatedAt: options.updatedAt,
  };
}

/**
 * Builds the logical routing table from active managed and registered rows.
 * Stopped rows are excluded because their previous actual port is no longer a
 * live target for process-to-process communication.
 */
function buildLogicalRoutes(
  processes: readonly ManagedProcess[],
  pendingRoute?: LogicalPortRoute,
): readonly LogicalPortRoute[] {
  const routes = processes
    .filter((process) => process.status === "running" && process.source !== "detected")
    .map((process) => ({
      logicalPort: process.requestedPort,
      actualPort: process.actualPort,
      host: routeHostFromUrl(process.url),
      processId: process.id,
      processName: process.name,
      status: process.status,
      source: process.source ?? "managed",
    }));

  return pendingRoute === undefined ? routes : [...routes, pendingRoute];
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

/** Ensures the router can be built when a prebuilt routing service is omitted. */
function requirePortAvailabilityProvider(options: PortManagerAgentOptions): PortAvailabilityProvider {
  if (options.portAvailabilityProvider === undefined) {
    throw new Error("PortManagerAgent requires a portAvailabilityProvider or routingService.");
  }

  return options.portAvailabilityProvider;
}

/** Builds the per-user route table file path shared by one local agent. */
function getDefaultRouteTablePath(): string {
  const userId = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `newdlops-portmanager-routes-${userId}.json`);
}

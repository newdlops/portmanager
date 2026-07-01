import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAgentSocketPath, getAgentStartupLockPath, removeStaleSocketFile } from "../agent/agent-socket";
import { getDefaultRouteTablePath, ROUTE_TABLE_TTL_SECONDS_ENV } from "../agent/route-table";
import { readPortManagerSettings } from "../config/vscode-settings";
import { buildNodeRuntimeEnvironment } from "../platform/process/node-runtime";
import { SimpleEventEmitter } from "../shared/events";
import { isKnownPortManagerPackageVersion, readPortManagerPackageVersion } from "../shared/package-version";
import type {
  AgentDaemonStatus,
  AgentSnapshot,
  DisposableLike,
  LogicalPortRoute,
  ManagedProcess,
  ManagedProcessStartInput,
  PortManagerSettings,
  RegisteredProcessInput,
} from "../shared/types";
import type { PortManagerProcessService } from "./process-service";

/**
 * VS Code extension client for the single local Port Manager agent.
 *
 * The client owns IPC mechanics only: locating the socket, starting the agent
 * when no process is listening, request/response correlation, and maintaining
 * the latest snapshot for the tree view.
 */

type AgentMethod =
  | "daemonStatus"
  | "listSnapshot"
  | "refreshSnapshot"
  | "shutdownDaemon"
  | "startManagedProcess"
  | "registerExistingProcess"
  | "stopProcess"
  | "restartProcess"
  | "removeProcess";

interface AgentRequest {
  /** Correlates one line-delimited request with its response. */
  readonly id: string;
  /** Command understood by the agent server. */
  readonly method: AgentMethod;
  /** Method-specific payload. */
  readonly payload?: unknown;
}

interface AgentResponse<T = unknown> {
  /** Identifies agent responses on the shared event/response stream. */
  readonly type: "response";
  /** Request id being answered. */
  readonly id: string;
  /** True when the method completed successfully. */
  readonly ok: boolean;
  /** Method result returned by the agent. */
  readonly payload?: T;
  /** Error message returned by the agent. */
  readonly error?: string;
}

interface AgentEvent {
  /** Event name. The MVP only streams snapshots. */
  readonly type: "snapshot";
  /** Latest shared agent state. */
  readonly payload: AgentSnapshot;
}

interface PendingRequest {
  /** Resolves when the response with the matching id arrives. */
  readonly resolve: (value: unknown) => void;
  /** Rejects on agent error, socket close, or timeout. */
  readonly reject: (error: Error) => void;
  /** Timeout guard so command promises do not hang forever. */
  readonly timer: NodeJS.Timeout;
}

const AGENT_STARTUP_LOCK_STALE_MS = 10_000;
const AGENT_STARTUP_LOCK_WAIT_MS = 5_000;
const AGENT_CONNECT_TIMEOUT_MS = 1_000;
const AGENT_RESTART_EXIT_WAIT_MS = 2_000;
const AGENT_RESTART_TERM_GRACE_MS = 500;
const CLIENT_CHANGE_EVENT_DEBOUNCE_MS = 50;

/**
 * Agent-backed process service used by commands and the sidebar provider.
 * Multiple VS Code windows can create clients; they all connect to the same
 * OS-user socket and receive the same snapshots.
 */
export class LocalAgentClient implements PortManagerProcessService {
  /** Last snapshot received from the agent; tree reads are served from here. */
  private snapshot: AgentSnapshot = createEmptySnapshot();

  /** Content signature for suppressing timestamp-only snapshot refresh events. */
  private snapshotSignature = buildClientSnapshotSignature(this.snapshot);

  /** Active socket connected to the local agent. */
  private socket: net.Socket | undefined;

  /** Agent child process started by this VS Code window, if any. */
  private childProcess: ChildProcess | undefined;

  /** Request promises waiting for an agent response. */
  private readonly pendingRequests = new Map<string, PendingRequest>();

  /** Event channel for sidebar refreshes after snapshot changes. */
  private readonly changeEvents = new SimpleEventEmitter<void>();

  /** Timer that coalesces snapshot bursts before notifying VS Code UI. */
  private changeEventTimer: NodeJS.Timeout | undefined;

  /** Buffered partial line data from the socket. */
  private incomingBuffer = "";

  /** Monotonic suffix used for request ids sent on this client connection. */
  private nextRequestId = 1;

  /** In-flight connect promise shared by concurrent commands. */
  private connecting: Promise<void> | undefined;

  /** Disposed clients should not reconnect after socket close. */
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Connects to the agent and loads the initial snapshot. */
  async start(): Promise<void> {
    await this.ensureConnected();
    await this.loadDaemonStatusForStartup();
    /*
     * Opening several VS Code windows must not make every UI client request an
     * immediate listener scan or restart a busy data-plane daemon. Stale daemon
     * builds are surfaced as warnings; the explicit Restart Daemon command is
     * the only path that may send SIGTERM during normal activation.
     */
  }

  /** Stops the singleton local agent and resets the extension-side snapshot. */
  async stopDaemon(): Promise<void> {
    const daemonPid = this.snapshot.daemon.pid;

    if (this.socket !== undefined && !this.socket.destroyed) {
      try {
        await this.request<boolean>("shutdownDaemon");
      } catch {
        if (daemonPid > 0 && daemonPid !== process.pid) {
          try {
            process.kill(daemonPid, "SIGTERM");
          } catch {
            // The daemon may already have exited or belong to another stale snapshot.
          }
        }
      }
    } else if (daemonPid > 0 && daemonPid !== process.pid) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // Treat missing daemon processes as already stopped.
      }
    }

    this.socket?.destroy();
    this.socket = undefined;
    this.childProcess = undefined;
    this.snapshot = createEmptySnapshot();
    this.snapshotSignature = buildClientSnapshotSignature(this.snapshot);
    this.queueChangeEvent();
  }

  /** Restarts the singleton daemon using this extension's compiled agent. */
  async restartDaemon(): Promise<void> {
    const previousPid = this.snapshot.daemon.pid;

    await this.stopDaemon();
    await this.waitForPreviousDaemonExit(previousPid);
    await this.terminateSiblingAgentProcesses(new Set([previousPid]));
    await this.ensureConnected();
    await this.loadDaemonStatus();

    if (this.snapshot.daemon.restartRequired) {
      throw new Error("Port Manager daemon restarted, but it still does not match the active extension build.");
    }

    this.refreshInBackground();
  }

  /**
   * Gives the previous daemon generation time to release the singleton socket.
   * Shutdown is cooperative first; if the old process lingers, send SIGTERM and
   * keep polling so the next connect does not accidentally reattach to it.
   */
  private async waitForPreviousDaemonExit(pid: number): Promise<void> {
    if (pid <= 0 || pid === process.pid || !isProcessAlive(pid)) {
      await delay(150);
      return;
    }

    const startedAtMs = Date.now();
    const termAfterMs = startedAtMs + AGENT_RESTART_TERM_GRACE_MS;
    const deadlineMs = startedAtMs + AGENT_RESTART_EXIT_WAIT_MS;
    let termSent = false;

    while (Date.now() < deadlineMs) {
      if (!isProcessAlive(pid)) {
        return;
      }

      if (!termSent && Date.now() >= termAfterMs) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          return;
        }
        termSent = true;
      }

      await delay(100);
    }
  }

  /** Returns the latest complete agent snapshot for status and tree sections. */
  getSnapshot(): AgentSnapshot {
    return this.snapshot;
  }

  /** Returns the current process rows in agent snapshot order. */
  list(): readonly ManagedProcess[] {
    const settings = readPortManagerSettings();
    if (settings.monitorAllListeningPorts) {
      return this.snapshot.processes;
    }

    const preferredPorts = new Set(settings.preferredPorts);
    return this.snapshot.processes.filter((process) => {
      if (process.source !== "detected") {
        return true;
      }

      return preferredPorts.has(process.actualPort);
    });
  }

  /** Returns the unfiltered process rows for command resolution. */
  private listAll(): readonly ManagedProcess[] {
    return this.snapshot.processes;
  }

  /** Returns a process row by id from the latest snapshot. */
  get(id: string): ManagedProcess | undefined {
    return this.listAll().find((process) => process.id === id);
  }

  /** Subscribes to snapshot changes. */
  onDidChange(listener: () => void): DisposableLike {
    return this.changeEvents.subscribe(listener);
  }

  /** Requests a fresh OS port scan from the agent. */
  async refresh(): Promise<void> {
    const snapshot = await this.request<AgentSnapshot>("refreshSnapshot");
    this.applySnapshot(snapshot);
  }

  /**
   * Loads daemon metadata without forcing the expensive listener scan. Extension
   * activation only needs to know whether the singleton daemon is compatible
   * with the active extension build; process rows can arrive later.
   */
  private async loadDaemonStatus(): Promise<void> {
    const daemon = await this.request<AgentDaemonStatus>("daemonStatus");
    this.applyDaemonStatus(daemon);
  }

  /**
   * Keeps extension activation resilient when a live daemon is busy with a slow
   * listener refresh. Older daemons that do not support daemonStatus are
   * restarted, but transient status timeouts become a warning instead of a
   * startup failure.
   */
  private async loadDaemonStatusForStartup(): Promise<void> {
    try {
      await this.loadDaemonStatus();
    } catch (error) {
      if (isUnsupportedDaemonStatusError(error)) {
        this.applyDaemonStatusError(
          new Error("Connected daemon does not expose daemonStatus metadata; use Restart Daemon after active terminals are stable."),
        );
        return;
      }

      this.applyDaemonStatusError(error);
    }
  }

  /** Refreshes process/listener rows without making extension activation fail. */
  private refreshInBackground(): void {
    void this.refresh().catch((error: unknown) => {
      this.applyDaemonStatusError(error);
    });
  }

  /** Starts a managed process through the agent's centralized routing service. */
  async startManagedProcess(
    input: ManagedProcessStartInput,
    settings: PortManagerSettings,
  ): Promise<ManagedProcess> {
    const process = await this.request<ManagedProcess>("startManagedProcess", {
      ...input,
      scanRange: settings.scanRange,
      scanDirection: settings.scanDirection,
      routingMode: settings.routingMode,
      virtualPortRangeStart: settings.virtualPortRangeStart,
      virtualPortRangeEnd: settings.virtualPortRangeEnd,
    });
    await this.refresh();

    return process;
  }

  /** Registers an existing external process with the agent. */
  async registerExistingProcess(input: RegisteredProcessInput): Promise<ManagedProcess> {
    const process = await this.request<ManagedProcess>("registerExistingProcess", input);
    this.upsertKnownProcess(process);
    this.refreshInBackground();

    return process;
  }

  /** Stops a process through the agent when it owns the child PID. */
  async stopProcess(id: string, settings: PortManagerSettings): Promise<ManagedProcess | undefined> {
    const process = await this.request<ManagedProcess | undefined>("stopProcess", {
      id,
      signal: settings.processKillSignal,
    });
    await this.refresh();

    return process;
  }

  /** Restarts a process through its agent-side launch profile. */
  async restartProcess(id: string, settings: PortManagerSettings): Promise<ManagedProcess | undefined> {
    const process = await this.request<ManagedProcess | undefined>("restartProcess", {
      id,
      signal: settings.processKillSignal,
      scanRange: settings.scanRange,
      scanDirection: settings.scanDirection,
      routingMode: settings.routingMode,
      virtualPortRangeStart: settings.virtualPortRangeStart,
      virtualPortRangeEnd: settings.virtualPortRangeEnd,
    });
    await this.refresh();

    return process;
  }

  /** Removes a process row from the shared agent state. */
  async removeProcess(id: string): Promise<ManagedProcess | undefined> {
    const process = await this.request<ManagedProcess | undefined>("removeProcess", { id });
    await this.refresh();

    return process;
  }

  /** Closes the socket and rejects pending requests. */
  dispose(): void {
    this.disposed = true;
    if (this.changeEventTimer !== undefined) {
      clearTimeout(this.changeEventTimer);
      this.changeEventTimer = undefined;
    }
    this.changeEvents.clear();
    this.rejectAllPending(new Error("Port Manager agent client disposed."));
    this.socket?.destroy();
    this.socket = undefined;
  }

  /**
   * Ensures a socket is connected. If no agent is listening, this client starts
   * one and retries the connection for a short window.
   */
  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connectWithAgentStartup().finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  /** Tries an existing socket first, then starts the agent and retries. */
  private async connectWithAgentStartup(): Promise<void> {
    let initialError: unknown;

    try {
      this.socket = await this.openSocket();
      this.attachSocketHandlers(this.socket);
      return;
    } catch (error) {
      initialError = error;
      // Fall through to the startup lock. Another VS Code window may already
      // be racing to create the singleton daemon.
    }

    const releaseStartupLock = await this.acquireAgentStartupLock();
    try {
      if (this.socket && !this.socket.destroyed) {
        return;
      }

      try {
        this.socket = await this.openSocket();
        this.attachSocketHandlers(this.socket);
        return;
      } catch (error) {
        if (isSocketConnectTimeoutError(error) || isSocketConnectTimeoutError(initialError)) {
          /*
           * A timeout means the socket path existed but the current daemon did
           * not accept quickly enough. Treating that as stale would unlink a
           * live socket and let another extension host create a second daemon.
           */
          await this.waitForExistingAgent();
          return;
        }

        this.startAgentProcess();
      }

      const deadline = Date.now() + 5000;
      let lastError: unknown;

      while (Date.now() < deadline) {
        await delay(150);

        try {
          this.socket = await this.openSocket();
          this.attachSocketHandlers(this.socket);
          return;
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError instanceof Error ? lastError : new Error("Failed to connect to Port Manager agent.");
    } finally {
      releaseStartupLock();
    }
  }

  /** Waits for a slow existing daemon without removing its socket path. */
  private async waitForExistingAgent(): Promise<void> {
    const deadline = Date.now() + AGENT_STARTUP_LOCK_WAIT_MS;
    let lastError: unknown;

    while (Date.now() < deadline) {
      await delay(150);

      try {
        this.socket = await this.openSocket();
        this.attachSocketHandlers(this.socket);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Timed out waiting for existing Port Manager agent.");
  }

  /** Serializes daemon startup across extension hosts in different VS Code windows. */
  private async acquireAgentStartupLock(): Promise<() => void> {
    const lockPath = getAgentStartupLockPath();
    const deadline = Date.now() + AGENT_STARTUP_LOCK_WAIT_MS;

    for (;;) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
        return () => {
          try {
            fs.closeSync(fd);
          } catch {
            // The descriptor may already have been closed during process teardown.
          }
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Another client may have cleaned a stale lock while this window exited.
          }
        };
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw error instanceof Error ? error : new Error(String(error));
        }

        await this.connectIfSocketAppeared().catch(() => undefined);
        if (this.socket && !this.socket.destroyed) {
          return () => undefined;
        }

        removeStaleStartupLock(lockPath);
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for Port Manager daemon startup lock: ${lockPath}`);
        }

        await delay(100);
      }
    }
  }

  /** Connects to a daemon that another VS Code window may have just started. */
  private async connectIfSocketAppeared(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }

    this.socket = await this.openSocket();
    this.attachSocketHandlers(this.socket);
  }

  /** Opens the OS-specific local socket used by the singleton agent. */
  private async openSocket(): Promise<net.Socket> {
    const socketPath = getAgentSocketPath();

    return new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(createSocketConnectTimeoutError(socketPath));
      }, AGENT_CONNECT_TIMEOUT_MS);

      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });

      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
  }

  /**
   * Starts the local agent as a detached native process when available. The
   * Node daemon remains the fallback for unsupported platforms or development
   * builds that have not produced the native binary yet.
   */
  private startAgentProcess(): void {
    const agentMainPath = this.getAgentMainPath();

    if (!fs.existsSync(agentMainPath)) {
      throw new Error(`Port Manager agent entrypoint is missing: ${agentMainPath}`);
    }

    const socketPath = getAgentSocketPath();
    this.terminateSiblingAgentProcessesSync(new Set());
    removeStaleSocketFile(socketPath);

    const nativeAgentPath = this.getNativeAgentPath();
    if (canRunNativeAgent(nativeAgentPath)) {
      this.childProcess = spawn(
        nativeAgentPath,
        ["--socket", socketPath, "--route-table", getDefaultRouteTablePath(), "--agent-main", agentMainPath],
        {
          detached: true,
          env: this.buildAgentEnvironment(),
          stdio: "ignore",
          windowsHide: true,
        },
      );
      this.childProcess.once("error", () => {
        this.startNodeAgentProcess(agentMainPath, socketPath);
      });
      this.childProcess.unref();
      return;
    }

    this.startNodeAgentProcess(agentMainPath, socketPath);
  }

  /** Starts the previous Node daemon implementation as a compatibility fallback. */
  private startNodeAgentProcess(agentMainPath: string, socketPath: string): void {
    this.childProcess = spawn(process.execPath, [agentMainPath, "--socket", socketPath, "--route-table", getDefaultRouteTablePath()], {
      detached: true,
      env: this.buildAgentEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    });
    this.childProcess.unref();
  }

  /** Mirrors VS Code settings into daemon env without inheriting terminal hook routing. */
  private buildAgentEnvironment(): NodeJS.ProcessEnv {
    const settings = readPortManagerSettings();
    return buildNodeRuntimeEnvironment({
      ...process.env,
      [ROUTE_TABLE_TTL_SECONDS_ENV]: String(settings.routeTableTtlSeconds),
    });
  }

  /** Returns the compiled agent entrypoint owned by this extension instance. */
  private getAgentMainPath(): string {
    return this.context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
  }

  /** Returns the packaged native daemon binary for macOS/Linux builds. */
  private getNativeAgentPath(): string {
    return this.context.asAbsolutePath(path.join("media", "native", "portmanager_agent"));
  }

  /**
   * Stops detached agent generations that still advertise the singleton socket.
   * VS Code extension upgrades can leave old native agents alive after the
   * socket file has moved or been recreated; those stale siblings can continue
   * rewriting route tables even after the active daemon has restarted.
   */
  private async terminateSiblingAgentProcesses(exemptPids: ReadonlySet<number>): Promise<void> {
    const terminatedPids = this.terminateSiblingAgentProcessesSync(exemptPids);

    if (terminatedPids.length === 0) {
      return;
    }

    const deadline = Date.now() + AGENT_RESTART_EXIT_WAIT_MS;
    while (Date.now() < deadline && terminatedPids.some((pid) => isProcessAlive(pid))) {
      await delay(100);
    }
  }

  /** Best-effort synchronous sibling cleanup used before creating a new socket owner. */
  private terminateSiblingAgentProcessesSync(exemptPids: ReadonlySet<number>): readonly number[] {
    const socketPath = getAgentSocketPath();
    const siblingPids = findSiblingAgentProcessIds(socketPath, exemptPids);
    const terminatedPids: number[] = [];

    for (const pid of siblingPids) {
      try {
        process.kill(pid, "SIGTERM");
        terminatedPids.push(pid);
      } catch {
        // Treat already-exited sibling agents as successfully cleaned up.
      }
    }

    return terminatedPids;
  }

  /** Wires line-delimited JSON handling for one socket connection. */
  private attachSocketHandlers(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(String(chunk)));
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }

      this.rejectAllPending(new Error("Port Manager agent connection closed."));
    });
    socket.on("error", (error) => {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /** Accumulates socket data until complete newline-delimited messages arrive. */
  private handleData(chunk: string): void {
    this.incomingBuffer += chunk;

    for (;;) {
      const newlineIndex = this.incomingBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.incomingBuffer.slice(0, newlineIndex).trim();
      this.incomingBuffer = this.incomingBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.handleMessage(line);
      }
    }
  }

  /** Dispatches one agent response or event. Malformed messages are ignored. */
  private handleMessage(line: string): void {
    const message = JSON.parse(line) as Partial<AgentResponse> & Partial<AgentEvent>;

    if (message.type === "response" && typeof message.id === "string") {
      this.handleResponse(message as AgentResponse);
      return;
    }

    if (message.type === "snapshot" && message.payload) {
      this.applySnapshot(message.payload);
    }
  }

  /** Resolves or rejects the request waiting for the response id. */
  private handleResponse(response: AgentResponse): void {
    const pending = this.pendingRequests.get(response.id);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    if (!response.ok) {
      pending.reject(new Error(response.error ?? "Port Manager agent request failed."));
      return;
    }

    pending.resolve(response.payload);
  }

  /** Sends one request and waits for the correlated response. */
  private async request<T>(method: AgentMethod, params?: unknown): Promise<T> {
    await this.ensureConnected();

    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("Port Manager agent is not connected.");
    }

    const id = `extension-${process.pid}-${this.nextRequestId++}`;
    const request: AgentRequest = { id, method, payload: params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Port Manager agent request timed out: ${method}`));
      }, 10_000);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  /** Stores a new snapshot and notifies tree subscribers. */
  private applySnapshot(snapshot: AgentSnapshot): void {
    const nextSnapshot = annotateDaemonCompatibility(normalizeAgentSnapshot(snapshot), this.getAgentMainPath());
    const nextSignature = buildClientSnapshotSignature(nextSnapshot);

    /*
     * Agent refreshes can arrive from request responses and cross-window
     * broadcasts. Only content changes should repaint the status bar/sidebar;
     * updatedAt churn would otherwise look like an endless state refresh.
     */
    if (nextSignature === this.snapshotSignature) {
      this.snapshot = nextSnapshot;
      return;
    }

    this.snapshot = nextSnapshot;
    this.snapshotSignature = nextSignature;
    this.queueChangeEvent();
  }

  /**
   * Route registration has already rewritten the daemon route table before the
   * response returns. Keep the extension snapshot in step immediately, while the
   * slower OS listener scan catches up in the background.
   */
  private upsertKnownProcess(process: ManagedProcess): void {
    const updatedAt = new Date().toISOString();
    const processes = upsertManagedProcess(this.snapshot.processes, process);
    const routes = upsertLogicalRouteForProcess(this.snapshot.routes, process);

    this.snapshot = annotateDaemonCompatibility(
      normalizeAgentSnapshot({
        ...this.snapshot,
        processes,
        routes,
        updatedAt,
        daemon: {
          ...this.snapshot.daemon,
          routeCount: routes.length,
          updatedAt,
        },
      }),
      this.getAgentMainPath(),
    );
    this.snapshotSignature = buildClientSnapshotSignature(this.snapshot);
    this.queueChangeEvent();
  }

  /** Notifies subscribers once for a burst of snapshot updates. */
  private queueChangeEvent(): void {
    if (this.disposed || this.changeEventTimer !== undefined) {
      return;
    }

    this.changeEventTimer = setTimeout(() => {
      this.changeEventTimer = undefined;
      if (!this.disposed) {
        this.changeEvents.emit();
      }
    }, CLIENT_CHANGE_EVENT_DEBOUNCE_MS);
    this.changeEventTimer.unref();
  }

  /** Stores lightweight daemon metadata while preserving the last known rows. */
  private applyDaemonStatus(daemon: AgentDaemonStatus): void {
    const updatedAt = daemon.updatedAt ?? new Date().toISOString();
    this.applySnapshot({
      ...this.snapshot,
      agentPid: daemon.pid,
      daemon,
      updatedAt,
    });
  }

  /** Records a non-fatal daemon refresh/status error on the current snapshot. */
  private applyDaemonStatusError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const updatedAt = new Date().toISOString();
    const connected = this.socket !== undefined && !this.socket.destroyed;
    this.applySnapshot({
      ...this.snapshot,
      daemon: {
        ...this.snapshot.daemon,
        status: connected ? "running" : "error",
        updatedAt,
        errorMessage: appendDaemonWarning(this.snapshot.daemon.errorMessage, message),
      },
      updatedAt,
    });
  }

  /** Rejects every pending command when the socket becomes unusable. */
  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}

/** Creates the pre-connection snapshot shown before the agent responds. */
function createEmptySnapshot(): AgentSnapshot {
  const updatedAt = new Date(0).toISOString();

  return {
    agentPid: 0,
    daemon: createDaemonStatus({
      status: "disconnected",
      pid: 0,
      updatedAt,
      listenerCount: 0,
      routeCount: 0,
      monitoringAllListeners: false,
    }),
    processes: [],
    listeners: [],
    routes: [],
    updatedAt,
  };
}

/**
 * Builds the UI-visible snapshot identity. Snapshot timestamps are intentionally
 * excluded because background refreshes may only confirm the same daemon state.
 */
function buildClientSnapshotSignature(snapshot: AgentSnapshot): string {
  const daemon = snapshot.daemon;
  const daemonRow = [
    daemon.status,
    daemon.pid,
    daemon.startedAt ?? "",
    daemon.routeTablePath ?? "",
    daemon.agentMainPath ?? "",
    daemon.version ?? "",
    daemon.expectedVersion ?? "",
    daemon.expectedAgentMainPath ?? "",
    daemon.versionStatus ?? "",
    daemon.restartRequired === true,
    daemon.listenerCount,
    daemon.routeCount,
    daemon.monitoringAllListeners,
    daemon.errorMessage ?? "",
  ];
  const listenerRows = snapshot.listeners
    .map((listener) => [
      listener.id,
      listener.protocol,
      listener.localAddress,
      listener.port,
      listener.pid ?? "",
      listener.processName ?? "",
      listener.command ?? "",
      listener.source,
    ])
    .sort(compareSnapshotSignatureRows);
  const processRows = snapshot.processes
    .map((process) => [
      process.id,
      process.pid,
      process.name,
      process.command,
      process.cwd,
      process.networkId ?? "",
      process.requestedPort,
      process.actualPort,
      process.status,
      process.startedAt,
      process.stoppedAt ?? "",
      process.url ?? "",
      process.errorMessage ?? "",
      process.source ?? "",
    ])
    .sort(compareSnapshotSignatureRows);

  return JSON.stringify({
    agentPid: snapshot.agentPid,
    daemon: daemonRow,
    listeners: listenerRows,
    processes: processRows,
    routes: buildClientRouteSignatureRows(snapshot.routes),
  });
}

/** Normalizes route rows so equal routing state has one stable signature. */
function buildClientRouteSignatureRows(routes: readonly LogicalPortRoute[]): readonly (readonly unknown[])[] {
  return routes
    .map((route) => [
      route.logicalPort,
      route.actualPort,
      normalizeClientRouteDirection(route.routeDirection),
      route.host,
      route.cwd ?? "",
      route.networkId ?? "",
      route.processId ?? "",
      route.processName ?? "",
      route.status,
      route.source,
    ])
    .sort(compareSnapshotSignatureRows);
}

function normalizeClientRouteDirection(routeDirection: LogicalPortRoute["routeDirection"]): "listen" | "send" {
  return routeDirection === "send" ? "send" : "listen";
}

/** Sorts signature rows by serialized content for stable comparisons. */
function compareSnapshotSignatureRows(left: readonly unknown[], right: readonly unknown[]): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function upsertManagedProcess(processes: readonly ManagedProcess[], process: ManagedProcess): readonly ManagedProcess[] {
  const nextProcesses = processes.filter(
    (existingProcess) =>
      existingProcess.id !== process.id &&
      !(
        existingProcess.source === "detected" &&
        existingProcess.pid === process.pid &&
        existingProcess.actualPort === process.actualPort
      ),
  );

  return [...nextProcesses, { ...process }];
}

function upsertLogicalRouteForProcess(
  routes: readonly LogicalPortRoute[],
  process: ManagedProcess,
): readonly LogicalPortRoute[] {
  const route = buildLogicalRouteForProcess(process);
  const nextRoutes = routes.filter(
    (existingRoute) =>
      existingRoute.processId !== process.id &&
      (route === undefined || buildLogicalRouteIdentity(existingRoute) !== buildLogicalRouteIdentity(route)),
  );

  return route === undefined ? nextRoutes : [...nextRoutes, route];
}

function buildLogicalRouteForProcess(process: ManagedProcess): LogicalPortRoute | undefined {
  if (process.status !== "running" || process.source === "detected") {
    return undefined;
  }

  return {
    logicalPort: process.requestedPort,
    actualPort: process.actualPort,
    routeDirection: "listen",
    host: routeHostFromUrl(process.url),
    cwd: process.cwd,
    ...(process.networkId ? { networkId: process.networkId } : {}),
    processId: process.id,
    processName: process.name,
    status: process.status,
    source: process.source ?? "managed",
  };
}

function buildLogicalRouteIdentity(route: Pick<LogicalPortRoute, "networkId" | "logicalPort" | "routeDirection">): string {
  return `${route.networkId ?? ""}:${route.logicalPort}:${route.routeDirection === "send" ? "send" : "listen"}`;
}

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
 * Accepts snapshots from current and older daemon versions.
 * Older daemons do not include daemon/routes metadata, so the extension derives
 * safe defaults instead of letting the tree or status command read undefined.
 */
function normalizeAgentSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  const runtimeSnapshot = snapshot as Partial<AgentSnapshot>;
  const updatedAt = runtimeSnapshot.updatedAt ?? new Date().toISOString();
  const processes = runtimeSnapshot.processes ?? [];
  const listeners = runtimeSnapshot.listeners ?? [];
  const routes = runtimeSnapshot.routes ?? [];
  const agentPid = runtimeSnapshot.agentPid ?? 0;

  return {
    agentPid,
    daemon:
      runtimeSnapshot.daemon ??
      createDaemonStatus({
        status: agentPid > 0 ? "running" : "disconnected",
        pid: agentPid,
        updatedAt,
        listenerCount: listeners.length,
        routeCount: routes.length,
        monitoringAllListeners: listeners.length > 0,
        errorMessage: runtimeSnapshot.daemon === undefined ? "Connected daemon does not expose status metadata." : undefined,
      }),
    processes,
    listeners,
    routes,
    updatedAt,
  };
}

/**
 * Adds extension-local daemon compatibility metadata to the daemon snapshot.
 * The daemon cannot judge this itself because stale processes may be running
 * code from a previous extension install at the same socket path.
 */
function annotateDaemonCompatibility(snapshot: AgentSnapshot, expectedAgentMainPath: string): AgentSnapshot {
  const daemon = snapshot.daemon;
  const expectedPath = normalizeAgentMainPath(expectedAgentMainPath);
  const actualPath = normalizeAgentMainPath(daemon.agentMainPath);
  const expectedRouteTablePath = normalizeDaemonPath(getDefaultRouteTablePath());
  const actualRouteTablePath = normalizeDaemonPath(daemon.routeTablePath);
  const expectedVersion = readPortManagerPackageVersion();

  if (daemon.status !== "running" || daemon.pid <= 0) {
    return {
      ...snapshot,
      daemon: {
        ...daemon,
        expectedVersion,
        expectedAgentMainPath: expectedPath,
        versionStatus: "unknown",
        restartRequired: false,
      },
    };
  }

  const missingAgentMetadata = actualPath === undefined;
  const missingVersionMetadata = !isKnownPortManagerPackageVersion(daemon.version);
  const versionMismatch =
    isKnownPortManagerPackageVersion(daemon.version) &&
    isKnownPortManagerPackageVersion(expectedVersion) &&
    daemon.version !== expectedVersion;
  const pathMismatch = actualPath !== undefined && actualPath !== expectedPath;
  const routeTablePathMismatch = actualRouteTablePath !== undefined && actualRouteTablePath !== expectedRouteTablePath;
  const olderThanCurrentBuild = isDaemonOlderThanAgentMain(daemon, expectedAgentMainPath);
  const restartRequired =
    missingAgentMetadata ||
    missingVersionMetadata ||
    versionMismatch ||
    pathMismatch ||
    routeTablePathMismatch ||
    olderThanCurrentBuild;
  const staleWarning = missingAgentMetadata
    ? "Connected daemon does not expose version metadata; restart it with the active extension build."
    : missingVersionMetadata
      ? "Connected daemon does not expose package version metadata; restart it with the active extension build."
      : versionMismatch
        ? `Connected daemon version ${daemon.version} does not match active extension version ${expectedVersion}; restart required.`
        : routeTablePathMismatch
          ? "Connected daemon publishes route tables outside the active extension storage; restart required."
          : "Connected daemon is older than the active extension build; restart required.";
  const warning = restartRequired
    ? appendDaemonWarning(daemon.errorMessage, staleWarning)
    : daemon.errorMessage;

  return {
    ...snapshot,
    daemon: {
      ...daemon,
      expectedVersion,
      expectedAgentMainPath: expectedPath,
      versionStatus: restartRequired ? "stale" : "current",
      restartRequired,
      errorMessage: warning,
    },
  };
}

/** Normalizes optional daemon paths before comparing extension instances. */
function normalizeAgentMainPath(agentMainPath: string | undefined): string | undefined {
  return normalizeDaemonPath(agentMainPath);
}

/** Normalizes optional daemon-owned filesystem paths before compatibility checks. */
function normalizeDaemonPath(filePath: string | undefined): string | undefined {
  if (filePath === undefined || filePath.trim().length === 0) {
    return undefined;
  }

  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * A daemon can survive extension file replacement while keeping the same path.
 * Compare startup time with the compiled entrypoint mtime so attach commands
 * do not keep talking to old in-memory routing code after a rebuild/install.
 */
function isDaemonOlderThanAgentMain(daemon: AgentDaemonStatus, agentMainPath: string): boolean {
  if (daemon.startedAt === undefined) {
    return false;
  }

  const daemonStartedAtMs = Date.parse(daemon.startedAt);
  if (!Number.isFinite(daemonStartedAtMs)) {
    return false;
  }

  try {
    const agentMainModifiedAtMs = fs.statSync(agentMainPath).mtimeMs;
    return daemonStartedAtMs + 1_000 < agentMainModifiedAtMs;
  } catch {
    return false;
  }
}

/** Builds daemon status objects with all required UI-safe defaults. */
function createDaemonStatus(status: AgentDaemonStatus): AgentDaemonStatus {
  return status;
}

/** Appends a warning without duplicating text across repeated snapshots. */
function appendDaemonWarning(existingMessage: string | undefined, warning: string): string {
  if (existingMessage === undefined || existingMessage.trim().length === 0) {
    return warning;
  }

  if (existingMessage.includes(warning)) {
    return existingMessage;
  }

  return `${existingMessage} ${warning}`;
}

/** Detects stale daemons old enough not to implement the lightweight status method. */
function isUnsupportedDaemonStatusError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bUnknown\b/.test(message) && message.includes("daemonStatus");
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function isSocketConnectTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ETIMEDOUT";
}

function createSocketConnectTimeoutError(socketPath: string): Error {
  const error = new Error(`Timed out connecting to Port Manager agent at ${socketPath}.`) as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    return code === "EPERM";
  }
}

/** Finds detached Port Manager agent processes that still target the singleton socket. */
function findSiblingAgentProcessIds(socketPath: string, exemptPids: ReadonlySet<number>): readonly number[] {
  if (process.platform === "win32") {
    return [];
  }

  let output: string;
  try {
    output = execFileSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }

  const siblingPids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+([\s\S]+)$/.exec(line);
    if (match === null) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      pid === process.pid ||
      exemptPids.has(pid) ||
      !isPortManagerAgentCommandForSocket(command, socketPath)
    ) {
      continue;
    }

    siblingPids.push(pid);
  }

  return siblingPids;
}

/** Matches only agent daemons, not extension hosts or user commands that merely mention Port Manager. */
function isPortManagerAgentCommandForSocket(command: string, socketPath: string): boolean {
  if (!command.includes(socketPath) || !command.includes("--socket")) {
    return false;
  }

  return /(?:^|[/\s])portmanager_agent(?:\s|$)/.test(command) || /\bagent-main\.js\b/.test(command);
}

function removeStaleStartupLock(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (shouldPreserveStartupLock(lockPath, stat)) {
      return;
    }

    fs.unlinkSync(lockPath);
  } catch {
    // Missing or inaccessible lock files are handled by the next acquire loop.
  }
}

function shouldPreserveStartupLock(lockPath: string, stat: fs.Stats): boolean {
  if (Date.now() - stat.mtimeMs >= AGENT_STARTUP_LOCK_STALE_MS) {
    return false;
  }

  /*
   * The regular startup lock is owned by VS Code clients only. If an attached
   * terminal shell PID leaks into this file, keeping it fresh blocks the control
   * plane behind a process that will never complete daemon startup.
   */
  const ownerPid = readStartupLockOwnerPid(lockPath);
  if (ownerPid === undefined) {
    return true;
  }

  if (!isProcessAlive(ownerPid)) {
    return false;
  }

  const ownerCommand = readProcessCommand(ownerPid);
  return ownerCommand === undefined || !isInteractiveShellStartupLockOwner(ownerCommand);
}

function readStartupLockOwnerPid(lockPath: string): number | undefined {
  try {
    const firstLine = fs.readFileSync(lockPath, "utf8").split(/\r?\n/, 1)[0]?.trim();
    const pid = Number.parseInt(firstLine ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function readProcessCommand(pid: number): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }

  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function isInteractiveShellStartupLockOwner(command: string): boolean {
  const firstToken = command.trim().split(/\s+/, 1)[0];
  if (firstToken === undefined || firstToken.length === 0) {
    return false;
  }

  const executableName = path.basename(firstToken).replace(/^-/, "");
  return /^(?:bash|zsh|fish|sh|dash|ksh|tcsh|csh)$/.test(executableName);
}

function canRunNativeAgent(nativeAgentPath: string): boolean {
  if (process.platform === "win32") {
    return false;
  }

  try {
    fs.accessSync(nativeAgentPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Small retry delay helper for agent startup polling. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

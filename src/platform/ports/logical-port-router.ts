import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { performance } from "node:perf_hooks";
import type { DisposableLike } from "../../shared/types";
import { buildNodeRuntimeEnvironment } from "../process/node-runtime";
import { defaultProxyNetworkResources, type NativeProxyReservation, type ProxyNetworkResources } from "./proxy-network-resources";
import type { ProxyResourceLease } from "../../core/networks/proxy-resource-budget";

export interface LogicalPortRouterConnection {
  /** Logical TCP port the local client connected to. */
  readonly logicalPort: number;
  /** Address that accepted the client connection. */
  readonly localAddress?: string;
  /** Accepted listener port, normally the same as logicalPort. */
  readonly localPort?: number;
  /** Client-side address reported by the OS socket. */
  readonly remoteAddress?: string;
  /** Client-side ephemeral TCP port used to identify the caller process. */
  readonly remotePort?: number;
  /**
   * Source attribution resolved natively by the router (protocol v2+). When
   * present the resolver can skip its own lsof-based peer lookup. Absent for a
   * v1 helper or when native resolution failed for this connection.
   */
  readonly clientPid?: number;
  /** Client process start time, used with clientPid to guard against PID reuse. */
  readonly clientStartTime?: string;
  /** Network id read from the client process environment by the native router. */
  readonly clientNetworkId?: string;
}

export interface LogicalPortRouterTarget {
  /** Concrete host the router should forward to. */
  readonly host: string;
  /** Concrete actual TCP port selected for the caller's logical network. */
  readonly port: number;
}

export interface LogicalPortRouterTargetResolver {
  /**
   * Resolves one accepted localhost connection to the current actual target.
   * The caller can inspect client PID, terminal attachment, and route state
   * without leaking those higher-level policies into this TCP adapter.
   */
  resolve(connection: LogicalPortRouterConnection): LogicalPortRouterTarget | Promise<LogicalPortRouterTarget>;
}

export interface NativeLogicalPortRouterQuery extends LogicalPortRouterConnection {
  /** Native helper request id that must be echoed in the route response. */
  readonly id: string;
}

export interface LogicalPortRouterOptions {
  readonly resources?: ProxyNetworkResources;
  /** Optional native TCP router helper used for the data plane. */
  readonly nativeRouterPath?: string;
  /** Startup timeout for one native listener process. */
  readonly nativeStartupTimeoutMs?: number;
  /** Grace window before closing routers that briefly disappear from route snapshots. */
  readonly retireDelayMs?: number;
}

interface LogicalPortRouterListenerHandle {
  /** True while the underlying listener is still expected to accept sockets. */
  isActive(): boolean;
  /** Closes the listener accept path for this logical port. */
  close(): Promise<void>;
}

interface NodeLogicalPortRouterListenerSet extends LogicalPortRouterListenerHandle {
  /** Loopback listeners for one logical port, normally IPv4 and IPv6. */
  readonly servers: readonly net.Server[];
  /** In-flight client and target sockets shared by every listener on the port. */
  readonly sockets: Set<net.Socket>;
}

interface LoopbackListenTarget {
  readonly host: string;
  readonly ipv6Only?: boolean;
}

const LOOPBACK_LISTEN_TARGETS: readonly LoopbackListenTarget[] = [
  { host: "127.0.0.1" },
  { host: "::1", ipv6Only: true },
];
const DEFAULT_NATIVE_STARTUP_TIMEOUT_MS = 1500;
const DEFAULT_RETIRE_DELAY_MS = 30_000;
const ROUTE_SETUP_TIMEOUT_MS = 5000;

/**
 * Opens real localhost listeners for logical ports and forwards per connection.
 *
 * Native bind hooks keep application servers off their requested logical ports.
 * This router occupies those logical ports instead, then chooses the actual
 * target from the client process' terminal/network context.
 */
export class LogicalPortRouterManager implements DisposableLike {
  /** Active loopback listener groups keyed by logical port. */
  private readonly listeners = new Map<number, LogicalPortRouterListenerHandle>();

  /** Shared native data-plane process that can own many logical listener ports. */
  private nativeRouter: NativeLogicalPortRouterProcess | undefined;

  /**
   * Invalidates a reconciliation that was already opening ports when another
   * VS Code window took ownership. Without this fence, a stale async `sync`
   * could reopen listeners after the handoff cleanup had completed.
   */
  private ownershipGeneration = 0;

  /** Extension shutdown is terminal, while owner handoff remains reusable. */
  private disposed = false;

  /** Delayed closes for ports that vanish during transient route-table refreshes. */
  private readonly retireTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly resources: ProxyNetworkResources;

  constructor(
    private readonly targetResolver: LogicalPortRouterTargetResolver,
    private readonly options: LogicalPortRouterOptions = {},
  ) { this.resources = options.resources ?? defaultProxyNetworkResources; }

  /** Reconciles active localhost routers with the latest logical route table. */
  async sync(logicalPorts: Iterable<number>): Promise<void> {
    if (this.disposed) {
      return;
    }

    const ownershipGeneration = this.ownershipGeneration;
    const desiredPorts = new Set([...logicalPorts].filter(isTcpPort));

    for (const [port, listener] of [...this.listeners]) {
      if (ownershipGeneration !== this.ownershipGeneration) {
        return;
      }

      if (!listener.isActive()) {
        await this.close(port);
        continue;
      }

      if (!desiredPorts.has(port)) {
        this.scheduleRetire(port);
      } else {
        this.cancelRetire(port);
      }
    }

    for (const port of desiredPorts) {
      if (ownershipGeneration !== this.ownershipGeneration) {
        return;
      }

      this.cancelRetire(port);
      try {
        await this.open(port);
        if (ownershipGeneration !== this.ownershipGeneration) {
          await this.close(port);
          return;
        }
      } catch {
        /*
         * Another VS Code window can already own one logical router port.
         * Reconciliation stays best-effort so later dynamic ports, including
         * debugger listeners, still become reachable.
         */
      }
    }
  }

  /** Opens one logical localhost listener if it is not already active. */
  async open(logicalPort: number): Promise<void> {
    if (this.listeners.has(logicalPort)) {
      return;
    }

    const nativeListener = await this.openNative(logicalPort);
    if (nativeListener !== undefined) {
      this.listeners.set(logicalPort, nativeListener);
      return;
    }

    const sockets = new Set<net.Socket>();
    const servers: net.Server[] = [];
    const errors: Error[] = [];

    for (const target of LOOPBACK_LISTEN_TARGETS) {
      const server = this.createServer(logicalPort, sockets);

      try {
        this.resources.reserveListener(server);
        await listen(server, logicalPort, target);
        servers.push(server);
      } catch (error) {
        await closeServer(server).catch(() => undefined);
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (servers.length === 0) {
      throw errors[0] ?? new Error(`Could not open localhost router for ${logicalPort}.`);
    }

    this.listeners.set(logicalPort, createNodeListenerHandle(servers, sockets));
  }

  /** Closes one logical localhost listener. */
  async close(logicalPort: number): Promise<void> {
    this.cancelRetire(logicalPort);
    const listenerSet = this.listeners.get(logicalPort);
    if (listenerSet === undefined) {
      return;
    }

    this.listeners.delete(logicalPort);
    await listenerSet.close();
  }

  /**
   * Immediately releases every listening port during a cross-window handoff.
   * The native helper stays warm so accepted streams and a later reacquisition
   * do not pay an unnecessary process restart; extension shutdown closes it.
   */
  async releaseAll(): Promise<void> {
    this.ownershipGeneration += 1;
    const ports = [...this.listeners.keys()];
    for (const port of [...this.retireTimers.keys()]) {
      this.cancelRetire(port);
    }
    await Promise.all(ports.map((port) => this.close(port)));
  }

  /** Closes every listener owned by this router. */
  dispose(): void {
    this.disposed = true;
    void this.releaseAll();
    const nativeRouter = this.nativeRouter;
    this.nativeRouter = undefined;
    void nativeRouter?.close();
  }

  /** Defers destructive close so refresh gaps do not tear down active TCP streams. */
  private scheduleRetire(logicalPort: number): void {
    if (this.retireTimers.has(logicalPort)) {
      return;
    }

    const timer = setTimeout(() => {
      this.retireTimers.delete(logicalPort);
      void this.close(logicalPort).catch(() => undefined);
    }, this.options.retireDelayMs ?? DEFAULT_RETIRE_DELAY_MS);
    timer.unref?.();
    this.retireTimers.set(logicalPort, timer);
  }

  private cancelRetire(logicalPort: number): void {
    const timer = this.retireTimers.get(logicalPort);
    if (timer === undefined) {
      return;
    }

    clearTimeout(timer);
    this.retireTimers.delete(logicalPort);
  }

  /** Builds one loopback listener for a logical port/address pair. */
  private createServer(logicalPort: number, sockets: Set<net.Socket>): net.Server {
    return net.createServer({ allowHalfOpen: true }, (incoming) => {
      if (!this.resources.admitClient(incoming)) return;
      sockets.add(incoming);
      incoming.once("close", () => sockets.delete(incoming));
      incoming.once("error", () => incoming.destroy());
      void this.forwardConnection(logicalPort, incoming, sockets);
    });
  }

  /** Starts the native data-plane router when the packaged helper is available. */
  private async openNative(logicalPort: number): Promise<LogicalPortRouterListenerHandle | undefined> {
    const nativeRouterPath = this.options.nativeRouterPath;
    if (nativeRouterPath === undefined || !isExecutableFile(nativeRouterPath)) {
      return undefined;
    }

    const router = this.getNativeRouter(nativeRouterPath);

    try {
      return await router.open(logicalPort);
    } catch {
      if (!router.isControlReady()) {
        await router.close().catch(() => undefined);
        if (this.nativeRouter === router) {
          this.nativeRouter = undefined;
        }
      }
      return undefined;
    }
  }

  private getNativeRouter(nativeRouterPath: string): NativeLogicalPortRouterProcess {
    if (this.nativeRouter?.isActive()) {
      return this.nativeRouter;
    }

    this.nativeRouter = new NativeLogicalPortRouterProcess(
      nativeRouterPath,
      this.targetResolver,
      this.options.nativeStartupTimeoutMs ?? DEFAULT_NATIVE_STARTUP_TIMEOUT_MS,
      this.resources,
    );
    return this.nativeRouter;
  }

  /** Resolves and pipes one accepted connection to its actual target. */
  private async forwardConnection(
    logicalPort: number,
    incoming: net.Socket,
    sockets: Set<net.Socket>,
  ): Promise<void> {
    let target: LogicalPortRouterTarget | undefined;
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    const routeDeadline = performance.now() + ROUTE_SETUP_TIMEOUT_MS;
    const routeTimer = setTimeout(() => { incoming.destroy(); cancel(); }, ROUTE_SETUP_TIMEOUT_MS);
    routeTimer.unref();
    incoming.once("close", cancel);

    try {
      target = await this.resources.awaitRoute(this.resources.runRoute(() => this.targetResolver.resolve({
        logicalPort,
        localAddress: incoming.localAddress,
        localPort: incoming.localPort,
        remoteAddress: incoming.remoteAddress,
        remotePort: incoming.remotePort,
      })), cancellation.signal);
    } catch {
      incoming.destroy();
      return;
    } finally {
      clearTimeout(routeTimer);
      incoming.off("close", cancel);
    }

    if (target === undefined || incoming.destroyed || performance.now() >= routeDeadline) {
      incoming.destroy();
      return;
    }

    let outgoing: net.Socket;
    const connectDeadline = performance.now() + ROUTE_SETUP_TIMEOUT_MS;
    try { outgoing = this.resources.connect({ host: target.host, port: target.port, allowHalfOpen: true }); }
    catch { incoming.destroy(); return; }
    sockets.add(outgoing);
    outgoing.once("close", () => sockets.delete(outgoing));
    const destroyBoth = () => { clearTimeout(timer); incoming.destroy(); outgoing.destroy(); };
    const timer = setTimeout(destroyBoth, Math.max(0, connectDeadline - performance.now()));
    timer.unref();
    incoming.once("error", destroyBoth);
    outgoing.once("error", destroyBoth);
    incoming.once("close", () => {
      if (!incoming.readableEnded || !incoming.writableFinished) destroyBoth();
    });
    outgoing.once("close", () => {
      clearTimeout(timer);
      if (!outgoing.readableEnded || !outgoing.writableFinished) destroyBoth();
    });
    outgoing.once("connect", () => {
      clearTimeout(timer);
      if (incoming.destroyed || outgoing.destroyed || performance.now() >= connectDeadline) { destroyBoth(); return; }
      incoming.pipe(outgoing);
      outgoing.pipe(incoming);
    });
  }
}

/**
 * Native data-plane router controlled by TypeScript routing policy.
 *
 * The helper owns localhost listeners and socket copying in C. It asks this
 * class for a target per accepted connection, preserving the existing
 * process/network resolution logic while keeping high-volume TCP payloads out of
 * Node streams.
 */
class NativeLogicalPortRouterProcess {
  /** Worker/DNS capacity stays reserved while accepted streams or the warm helper remain. */
  private reservation: NativeProxyReservation | undefined;
  private childCreated = false;
  private detachControlAvailable: (() => void) | undefined;
  /** Child process running the native router helper for many logical ports. */
  private child: ChildProcessWithoutNullStreams | undefined;

  /** Partial stdout line buffer for the helper control protocol. */
  private stdoutBuffer = "";

  /** Recent stderr text included in startup failures. */
  private stderrBuffer = "";

  /** Whether the helper has exited or been closed. */
  private closed = false;

  /** True only after the helper announces that its control protocol is ready. */
  private controlReady = false;

  /** Startup promise hooks resolved by the helper control READY line. */
  private startup:
    | {
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
        readonly timer: NodeJS.Timeout;
      }
    | undefined;

  private startupPromise: Promise<void> | undefined;

  /** Logical ports successfully owned by the shared native helper. */
  private readonly activePorts = new Set<number>();

  /** Per-port LISTEN requests awaiting READY/LISTEN_ERROR from the helper. */
  private readonly pendingListens = new Map<
    number,
    {
      readonly resolve: () => void;
      readonly reject: (error: Error) => void;
      readonly timer: NodeJS.Timeout;
      readonly promise: Promise<void>;
    }
  >();
  /** Each dual-stack LISTEN owns two units until LISTEN_ERROR/CLOSED or child exit. */
  private readonly portReservations = new Map<number, ProxyResourceLease>();
  /** Reopen waits for CLOSED so an old port-only reply cannot release the new lease. */
  private readonly pendingCloses = new Map<number, {
    readonly promise: Promise<void>; readonly resolve: () => void; readonly timer: NodeJS.Timeout; sent: boolean;
  }>();

  constructor(
    private readonly executablePath: string,
    private readonly targetResolver: LogicalPortRouterTargetResolver,
    private readonly startupTimeoutMs: number,
    private readonly resources: ProxyNetworkResources,
  ) {}

  /** Starts the shared helper and waits until it can accept LISTEN commands. */
  start(): Promise<void> {
    if (this.isActive() && this.startupPromise === undefined) {
      return Promise.resolve();
    }
    if (this.startupPromise !== undefined) {
      return this.startupPromise;
    }

    this.closed = false;
    this.controlReady = false;
    this.reservation = this.resources.reserveNative(256, 0);
    this.child = spawn(this.executablePath, ["--control"], {
      // The router's outbound target connection must not re-enter Port Manager's native hook.
      env: { ...buildNodeRuntimeEnvironment(),
        PORT_MANAGER_PROXY_MAX_CONNECTIONS: String(this.reservation.connections),
        PORT_MANAGER_PROXY_MAX_DNS_JOBS: String(this.reservation.dnsJobs) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.childCreated = this.child.pid !== undefined;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.rememberStderr(chunk));
    this.child.stdin.on("error", () => {});
    const retryCloses = () => {
      for (const [port, closing] of this.pendingCloses) {
        if (!closing.sent) closing.sent = this.writeControlLine(`CLOSE\t${port}\n`);
      }
    };
    this.child.stdin.on("drain", retryCloses);
    this.detachControlAvailable = this.resources.onControlAvailable(retryCloses);
    const child = this.child;
    this.child.once("error", (error) => {
      if (child.pid === undefined) { this.reservation?.release(); this.detachControlAvailable?.(); }
      this.rejectStartup(error);
    });
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.reservation?.release();
      this.detachControlAvailable?.();
      this.releasePortReservations();
      this.controlReady = false;
      this.activePorts.clear();
      this.rejectPendingListens(
        new Error(`Native logical router exited: ${formatNativeExit(code, signal)}${this.formatStderrSuffix()}`),
      );
      this.rejectStartup(new Error(`Native logical router exited before ready: ${formatNativeExit(code, signal)}${this.formatStderrSuffix()}`));
    });

    this.startupPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectStartup(new Error(`Native logical router timed out${this.formatStderrSuffix()}`));
      }, this.startupTimeoutMs);
      this.startup = { resolve, reject, timer };
    });
    return this.startupPromise;
  }

  async open(logicalPort: number): Promise<LogicalPortRouterListenerHandle> {
    await this.start();
    await this.pendingCloses.get(logicalPort)?.promise;
    if (!this.isControlReady()) throw new Error("Native logical router closed before LISTEN.");
    if (this.activePorts.has(logicalPort)) {
      return new NativeLogicalPortRouterPortHandle(this, logicalPort);
    }
    const existing = this.pendingListens.get(logicalPort);
    if (existing !== undefined) { await existing.promise; return new NativeLogicalPortRouterPortHandle(this, logicalPort); }
    const lease = this.resources.acquire({ listeners: 2 });
    this.portReservations.set(logicalPort, lease);
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      this.pendingListens.delete(logicalPort);
      reject(new Error(`Native logical router timed out opening ${logicalPort}${this.formatStderrSuffix()}`));
      void this.closePort(logicalPort).catch(() => undefined);
    }, this.startupTimeoutMs);
    this.pendingListens.set(logicalPort, { resolve, reject, timer, promise });
    if (!this.writeControlLine(`LISTEN\t${logicalPort}\n`)) {
      this.rejectListen(logicalPort, new Error("Native logical router control budget exhausted before LISTEN."));
    }
    await promise;

    return new NativeLogicalPortRouterPortHandle(this, logicalPort);
  }

  isActive(): boolean {
    return this.child !== undefined && !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  isControlReady(): boolean {
    return this.isActive() && this.controlReady;
  }

  isPortActive(logicalPort: number): boolean {
    return this.isActive() && this.activePorts.has(logicalPort);
  }

  /** Stops accepting new connections for one port while accepted native streams stay alive. */
  async closePort(logicalPort: number): Promise<void> {
    const closing = this.pendingCloses.get(logicalPort);
    if (closing !== undefined) return closing.promise;
    this.activePorts.delete(logicalPort);
    const pending = this.pendingListens.get(logicalPort);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Native logical router closed ${logicalPort}.`));
      this.pendingListens.delete(logicalPort);
    }
    if (!this.portReservations.has(logicalPort)) return;
    if (!this.isActive()) return; // Child exit returns the lease; issuing a kill is not completion.
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => reject(new Error(`Native logical router did not confirm CLOSE ${logicalPort}.`)), this.startupTimeoutMs);
    const entry = { promise, resolve, timer, sent: false };
    this.pendingCloses.set(logicalPort, entry);
    entry.sent = this.writeControlLine(`CLOSE\t${logicalPort}\n`);
    return promise;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controlReady = false;
    this.activePorts.clear();
    this.rejectPendingListens(new Error("Native logical router closed."));
    this.rejectStartup(new Error("Native logical router closed."));

    const child = this.child;
    this.child = undefined;
    if (child === undefined) {
      if (!this.childCreated) this.reservation?.release();
      return;
    }

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    for (;;) {
      const lineEnd = this.stdoutBuffer.indexOf("\n");
      if (lineEnd < 0) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      void this.handleProtocolLine(line);
    }
  }

  private async handleProtocolLine(line: string): Promise<void> {
    // Protocol v2 appends a version field ("READY\tcontrol\t2"); match by prefix
    // so both the versioned and the original bare form resolve startup.
    if (line === "READY\tcontrol" || line.startsWith("READY\tcontrol\t")) {
      this.resolveStartup();
      return;
    }

    const readyPort = parseNativeRouterPortStatusLine(line, "READY");
    if (readyPort !== undefined) {
      this.resolveListen(readyPort);
      return;
    }

    const failedPort = parseNativeRouterPortStatusLine(line, "LISTEN_ERROR");
    if (failedPort !== undefined) {
      this.rejectListen(failedPort, new Error(`Native logical router could not listen on ${failedPort}${this.formatStderrSuffix()}`));
      return;
    }

    const closedPort = parseNativeRouterPortStatusLine(line, "CLOSED");
    if (closedPort !== undefined) {
      this.activePorts.delete(closedPort);
      this.portReservations.get(closedPort)?.release();
      this.portReservations.delete(closedPort);
      const closing = this.pendingCloses.get(closedPort);
      if (closing !== undefined) { clearTimeout(closing.timer); closing.resolve(); this.pendingCloses.delete(closedPort); }
      return;
    }

    const query = parseNativeRouterQueryLine(line);
    if (query === undefined) {
      return;
    }

    try {
      const target = await this.resources.runRoute(() => this.targetResolver.resolve(query));
      this.writeResponse(`ROUTE\t${query.id}\t${target.host}\t${target.port}\n`);
    } catch {
      this.writeResponse(`ERROR\t${query.id}\n`);
    }
  }

  private writeResponse(line: string): void {
    this.writeControlLine(line);
  }

  private writeControlLine(line: string): boolean {
    if (this.child === undefined || this.child.stdin.destroyed) {
      return false;
    }

    return this.resources.writeControl(this.child.stdin, line);
  }

  private rememberStderr(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4000);
  }

  private resolveStartup(): void {
    this.controlReady = true;
    if (this.startup === undefined) {
      return;
    }

    clearTimeout(this.startup.timer);
    this.startup.resolve();
    this.startup = undefined;
    this.startupPromise = undefined;
  }

  private rejectStartup(error: Error): void {
    if (this.startup === undefined) {
      return;
    }

    clearTimeout(this.startup.timer);
    this.startup.reject(error);
    this.startup = undefined;
    this.startupPromise = undefined;
  }

  private resolveListen(logicalPort: number): void {
    const pending = this.pendingListens.get(logicalPort);
    this.activePorts.add(logicalPort);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingListens.delete(logicalPort);
    pending.resolve();
  }

  private rejectListen(logicalPort: number, error: Error): void {
    // A pending CLOSE retains the lease until its own acknowledgement, even
    // when this late LISTEN_ERROR belongs to the attempt that just timed out.
    if (!this.pendingCloses.has(logicalPort)) {
      this.portReservations.get(logicalPort)?.release();
      this.portReservations.delete(logicalPort);
    }
    const pending = this.pendingListens.get(logicalPort);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingListens.delete(logicalPort);
    pending.reject(error);
  }

  private rejectPendingListens(error: Error): void {
    for (const pending of this.pendingListens.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingListens.clear();
  }

  private releasePortReservations(): void {
    for (const lease of this.portReservations.values()) lease.release();
    this.portReservations.clear();
    for (const closing of this.pendingCloses.values()) { clearTimeout(closing.timer); closing.resolve(); }
    this.pendingCloses.clear();
  }

  private formatStderrSuffix(): string {
    const stderr = this.stderrBuffer.trim();
    return stderr.length === 0 ? "" : `: ${stderr}`;
  }
}

class NativeLogicalPortRouterPortHandle implements LogicalPortRouterListenerHandle {
  constructor(
    private readonly router: NativeLogicalPortRouterProcess,
    private readonly logicalPort: number,
  ) {}

  isActive(): boolean {
    return this.router.isPortActive(this.logicalPort);
  }

  close(): Promise<void> {
    return this.router.closePort(this.logicalPort);
  }
}

/** Parses one CONNECT request emitted by the native TCP router helper. */
export function parseNativeRouterQueryLine(line: string): NativeLogicalPortRouterQuery | undefined {
  const parts = line.split("\t");
  // v1 emits exactly 7 fields; v2 appends pid/startTime/networkId. Accept any
  // length >= 7 so a newer helper does not require a lockstep parser change.
  if (parts.length < 7 || parts[0] !== "CONNECT") {
    return undefined;
  }

  const logicalPort = parseTcpPort(parts[2]);
  const localPort = parseTcpPort(parts[4]);
  const remotePort = parseTcpPort(parts[6]);
  if (logicalPort === undefined) {
    return undefined;
  }

  const clientPid = parseNativeRouterField(parts[7]);
  const clientPidNumber = clientPid === undefined ? undefined : Number.parseInt(clientPid, 10);
  const clientStartTime = parseNativeRouterField(parts[8]);
  const clientNetworkId = parseNativeRouterField(parts[9]);

  return {
    id: parts[1] ?? "",
    logicalPort,
    localAddress: parts[3],
    ...(localPort === undefined ? {} : { localPort }),
    remoteAddress: parts[5],
    ...(remotePort === undefined ? {} : { remotePort }),
    ...(clientPidNumber === undefined || Number.isNaN(clientPidNumber) ? {} : { clientPid: clientPidNumber }),
    ...(clientStartTime === undefined ? {} : { clientStartTime }),
    ...(clientNetworkId === undefined ? {} : { clientNetworkId }),
  };
}

/** Reads an optional tab field, treating the "-" placeholder and empty string as absent. */
function parseNativeRouterField(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? undefined : trimmed;
}

function parseNativeRouterPortStatusLine(line: string, status: string): number | undefined {
  const parts = line.split("\t");
  if (parts.length !== 2 || parts[0] !== status) {
    return undefined;
  }

  return parseTcpPort(parts[1]);
}

/** Wraps the original Node stream router behind the same listener handle. */
function createNodeListenerHandle(
  servers: readonly net.Server[],
  sockets: Set<net.Socket>,
): NodeLogicalPortRouterListenerSet {
  return {
    servers,
    sockets,
    isActive: () => true,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await Promise.all(servers.map((server) => closeServer(server)));
    },
  };
}

function listen(server: net.Server, port: number, target: LoopbackListenTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      port,
      host: target.host,
      ...(target.ipv6Only === undefined ? {} : { ipv6Only: target.ipv6Only }),
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function parseTcpPort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }

  const port = Number.parseInt(value, 10);
  return isTcpPort(port) ? port : undefined;
}

function formatNativeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    return `signal ${signal}`;
  }

  return `exit code ${code ?? "unknown"}`;
}

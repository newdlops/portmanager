import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import type { DisposableLike } from "../../shared/types";
import { buildNodeRuntimeEnvironment } from "../process/node-runtime";

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
  /** Closes the listener and any sockets it owns. */
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

  /** Delayed closes for ports that vanish during transient route-table refreshes. */
  private readonly retireTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly targetResolver: LogicalPortRouterTargetResolver,
    private readonly options: LogicalPortRouterOptions = {},
  ) {}

  /** Reconciles active localhost routers with the latest logical route table. */
  async sync(logicalPorts: Iterable<number>): Promise<void> {
    const desiredPorts = new Set([...logicalPorts].filter(isTcpPort));

    for (const [port, listener] of [...this.listeners]) {
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
      this.cancelRetire(port);
      try {
        await this.open(port);
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
    if (this.listeners.size === 0) {
      await this.nativeRouter?.close().catch(() => undefined);
      this.nativeRouter = undefined;
    }
  }

  /** Closes every listener owned by this router. */
  dispose(): void {
    const ports = [...this.listeners.keys()];
    for (const port of [...this.retireTimers.keys()]) {
      this.cancelRetire(port);
    }
    void Promise.all(ports.map((port) => this.close(port)));
    void this.nativeRouter?.close();
    this.nativeRouter = undefined;
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
    return net.createServer((incoming) => {
      sockets.add(incoming);
      incoming.once("close", () => sockets.delete(incoming));
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
      if (!router.hasOpenWork()) {
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
    );
    return this.nativeRouter;
  }

  /** Resolves and pipes one accepted connection to its actual target. */
  private async forwardConnection(
    logicalPort: number,
    incoming: net.Socket,
    sockets: Set<net.Socket>,
  ): Promise<void> {
    let target: LogicalPortRouterTarget;

    try {
      target = await this.targetResolver.resolve({
        logicalPort,
        localAddress: incoming.localAddress,
        localPort: incoming.localPort,
        remoteAddress: incoming.remoteAddress,
        remotePort: incoming.remotePort,
      });
    } catch {
      incoming.destroy();
      return;
    }

    if (incoming.destroyed) {
      return;
    }

    const outgoing = net.createConnection({
      host: target.host,
      port: target.port,
    });
    sockets.add(outgoing);
    outgoing.once("close", () => sockets.delete(outgoing));
    incoming.once("close", () => outgoing.destroy());

    incoming.on("error", () => outgoing.destroy());
    outgoing.on("error", () => incoming.destroy());
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
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
  /** Child process running the native router helper for many logical ports. */
  private child: ChildProcessWithoutNullStreams | undefined;

  /** Partial stdout line buffer for the helper control protocol. */
  private stdoutBuffer = "";

  /** Recent stderr text included in startup failures. */
  private stderrBuffer = "";

  /** Whether the helper has exited or been closed. */
  private closed = false;

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
    }
  >();

  constructor(
    private readonly executablePath: string,
    private readonly targetResolver: LogicalPortRouterTargetResolver,
    private readonly startupTimeoutMs: number,
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
    this.child = spawn(this.executablePath, ["--control"], {
      // The router's outbound target connection must not re-enter Port Manager's native hook.
      env: buildNodeRuntimeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.rememberStderr(chunk));
    this.child.once("error", (error) => this.rejectStartup(error));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
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
    if (this.activePorts.has(logicalPort)) {
      return new NativeLogicalPortRouterPortHandle(this, logicalPort);
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingListens.delete(logicalPort);
        reject(new Error(`Native logical router timed out opening ${logicalPort}${this.formatStderrSuffix()}`));
      }, this.startupTimeoutMs);
      this.pendingListens.set(logicalPort, { resolve, reject, timer });
      this.writeControlLine(`LISTEN\t${logicalPort}\n`);
    });

    return new NativeLogicalPortRouterPortHandle(this, logicalPort);
  }

  isActive(): boolean {
    return this.child !== undefined && !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  isPortActive(logicalPort: number): boolean {
    return this.isActive() && this.activePorts.has(logicalPort);
  }

  /** True while the shared helper still owns or is opening at least one logical port. */
  hasOpenWork(): boolean {
    return this.activePorts.size > 0 || this.pendingListens.size > 0;
  }

  async closePort(logicalPort: number): Promise<void> {
    this.activePorts.delete(logicalPort);
    const pending = this.pendingListens.get(logicalPort);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Native logical router closed ${logicalPort}.`));
      this.pendingListens.delete(logicalPort);
    }
    if (this.isActive()) {
      this.writeControlLine(`CLOSE\t${logicalPort}\n`);
    }
    if (this.activePorts.size === 0 && this.pendingListens.size === 0) {
      await this.close();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.activePorts.clear();
    this.rejectPendingListens(new Error("Native logical router closed."));
    this.rejectStartup(new Error("Native logical router closed."));

    const child = this.child;
    this.child = undefined;
    if (child === undefined) {
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
    if (line === "READY\tcontrol") {
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
      return;
    }

    const query = parseNativeRouterQueryLine(line);
    if (query === undefined) {
      return;
    }

    try {
      const target = await this.targetResolver.resolve(query);
      this.writeResponse(`ROUTE\t${query.id}\t${target.host}\t${target.port}\n`);
    } catch {
      this.writeResponse(`ERROR\t${query.id}\n`);
    }
  }

  private writeResponse(line: string): void {
    this.writeControlLine(line);
  }

  private writeControlLine(line: string): void {
    if (this.child === undefined || this.child.stdin.destroyed) {
      return;
    }

    this.child.stdin.write(line, "utf8");
  }

  private rememberStderr(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4000);
  }

  private resolveStartup(): void {
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
  if (parts.length !== 7 || parts[0] !== "CONNECT") {
    return undefined;
  }

  const logicalPort = parseTcpPort(parts[2]);
  const localPort = parseTcpPort(parts[4]);
  const remotePort = parseTcpPort(parts[6]);
  if (logicalPort === undefined) {
    return undefined;
  }

  return {
    id: parts[1] ?? "",
    logicalPort,
    localAddress: parts[3],
    ...(localPort === undefined ? {} : { localPort }),
    remoteAddress: parts[5],
    ...(remotePort === undefined ? {} : { remotePort }),
  };
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

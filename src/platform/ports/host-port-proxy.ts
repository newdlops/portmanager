import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import type { HostPortExposure } from "../../shared/types";

export interface HostPortProxyTarget {
  /** Address the local proxy should connect to after resolving network scope. */
  readonly host: string;
  /** Actual TCP port the target process is listening on. */
  readonly port: number;
}

export interface HostPortProxyTargetResolver {
  /**
   * Resolves a persisted host binding to its current connection target.
   * Runtime adapters can map a network-local logical port to a live actual port
   * without leaking that policy into this socket-forwarding class.
   */
  resolve(exposure: HostPortExposure): HostPortProxyTarget | Promise<HostPortProxyTarget>;
}

export interface HostPortProxyOptions {
  /** Optional native host exposure helper used for the socket data plane. */
  readonly nativeProxyPath?: string;
  /** Startup timeout for one native host exposure listener. */
  readonly nativeStartupTimeoutMs?: number;
  /** Short-lived target cache for bursty clients; set to 0 to resolve every socket. */
  readonly targetCacheTtlMs?: number;
}

export interface NativeHostPortProxyQuery {
  /** Native helper request id that must be echoed in the route response. */
  readonly id: string;
  /** Address that accepted the client connection. */
  readonly localAddress?: string;
  /** Accepted listener port, normally the exposure host port. */
  readonly localPort?: number;
  /** Client-side address reported by the OS socket. */
  readonly remoteAddress?: string;
  /** Client-side ephemeral TCP port. */
  readonly remotePort?: number;
}

interface HostPortProxyListenerHandle {
  /** True while the listener process or server is still expected to accept sockets. */
  isActive(): boolean;
  /** Closes the listener and any sockets it owns. */
  close(): Promise<void>;
}

interface NodeHostPortProxyListenerHandle extends HostPortProxyListenerHandle {
  /** Node.js TCP server used when the native helper is unavailable. */
  readonly server: net.Server;
  /** In-flight client and target sockets for prompt teardown. */
  readonly sockets: Set<net.Socket>;
}

interface HostPortProxyTargetCacheEntry {
  /** Cached in-flight or fulfilled target resolution for one exposure burst. */
  readonly targetPromise: Promise<HostPortProxyTarget>;
  /** Wall-clock deadline after which the next connection re-resolves the target. */
  readonly expiresAtMs: number;
}

const DEFAULT_NATIVE_STARTUP_TIMEOUT_MS = 1500;
const DEFAULT_TARGET_CACHE_TTL_MS = 150;

/**
 * Owns local host listeners used by proxy-capable runtime adapters.
 *
 * This class is intentionally low-level: it binds sockets and forwards TCP
 * bytes, but it does not decide which exposures should exist. Domain and
 * extension layers validate user intent before calling it.
 */
export class HostPortProxyManager {
  /** Active TCP listeners keyed by host exposure id. */
  private readonly listeners = new Map<string, HostPortProxyListenerHandle>();

  /** Short-lived target cache keyed by exposure id to coalesce connection bursts. */
  private readonly targetCache = new Map<string, HostPortProxyTargetCacheEntry>();

  /** Effective cache TTL; zero keeps the original resolve-per-connection behavior. */
  private readonly targetCacheTtlMs: number;

  constructor(
    private readonly targetResolver: HostPortProxyTargetResolver = STATIC_TARGET_RESOLVER,
    private readonly options: HostPortProxyOptions = {},
  ) {
    this.targetCacheTtlMs = Math.max(0, options.targetCacheTtlMs ?? DEFAULT_TARGET_CACHE_TTL_MS);
  }

  /**
   * Opens a host listener and forwards each connection to the exposure target.
   * Successful resolution means the host port is reserved by Port Manager.
   */
  async open(exposure: HostPortExposure): Promise<void> {
    if (exposure.protocol !== "tcp") {
      throw new Error(`Host proxy only supports tcp exposures, got ${exposure.protocol}.`);
    }

    if (this.listeners.has(exposure.id)) {
      return;
    }

    const nativeListener = await this.openNative(exposure);
    if (nativeListener !== undefined) {
      this.listeners.set(exposure.id, nativeListener);
      return;
    }

    const sockets = new Set<net.Socket>();
    const server = net.createServer((incoming) => {
      sockets.add(incoming);
      incoming.once("close", () => sockets.delete(incoming));

      void this.forwardConnection(exposure, incoming, sockets);
    });

    await listen(server, exposure.hostPort, exposure.hostAddress);
    this.listeners.set(exposure.id, createNodeListenerHandle(server, sockets));
  }

  /** Closes one active host listener. */
  async close(exposureId: string): Promise<void> {
    const listener = this.listeners.get(exposureId);
    if (listener === undefined) {
      return;
    }

    this.listeners.delete(exposureId);
    this.targetCache.delete(exposureId);
    await listener.close();
  }

  /** Closes every listener during extension shutdown. */
  async dispose(): Promise<void> {
    const listeners = [...this.listeners.entries()];
    this.listeners.clear();
    this.targetCache.clear();
    await Promise.all(listeners.map(([, listener]) => listener.close()));
  }

  /** Starts the native data-plane proxy when the packaged helper is available. */
  private async openNative(exposure: HostPortExposure): Promise<NativeHostPortProxyProcess | undefined> {
    const nativeProxyPath = this.options.nativeProxyPath;
    if (nativeProxyPath === undefined || !isExecutableFile(nativeProxyPath)) {
      return undefined;
    }

    const proxy = new NativeHostPortProxyProcess(
      exposure,
      nativeProxyPath,
      {
        resolve: (currentExposure) => this.resolveTarget(currentExposure),
      },
      this.options.nativeStartupTimeoutMs ?? DEFAULT_NATIVE_STARTUP_TIMEOUT_MS,
    );

    try {
      await proxy.start();
      return proxy;
    } catch {
      await proxy.close().catch(() => undefined);
      return undefined;
    }
  }

  /** Resolves the current target and wires one inbound socket to it. */
  private async forwardConnection(
    exposure: HostPortExposure,
    incoming: net.Socket,
    sockets: Set<net.Socket>,
  ): Promise<void> {
    let target: HostPortProxyTarget;

    try {
      target = await this.resolveTarget(exposure);
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

  /** Resolves dynamic exposure targets while coalescing short connection bursts. */
  private resolveTarget(exposure: HostPortExposure): Promise<HostPortProxyTarget> {
    if (this.targetCacheTtlMs === 0) {
      return Promise.resolve(this.targetResolver.resolve(exposure));
    }

    const nowMs = Date.now();
    const cached = this.targetCache.get(exposure.id);
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return cached.targetPromise;
    }

    const targetPromise = Promise.resolve(this.targetResolver.resolve(exposure)).catch((error) => {
      if (this.targetCache.get(exposure.id)?.targetPromise === targetPromise) {
        this.targetCache.delete(exposure.id);
      }
      throw error;
    });
    this.targetCache.set(exposure.id, {
      targetPromise,
      expiresAtMs: nowMs + this.targetCacheTtlMs,
    });
    return targetPromise;
  }
}

/**
 * Native host exposure listener controlled by TypeScript target policy.
 *
 * The helper owns accept/connect/socket copying in C. It asks this class for a
 * target per accepted connection, preserving dynamic runtime target resolution
 * while moving high-volume payload forwarding out of Node streams.
 */
class NativeHostPortProxyProcess implements HostPortProxyListenerHandle {
  /** Child process running the native proxy helper for one exposure. */
  private child: ChildProcessWithoutNullStreams | undefined;

  /** Partial stdout line buffer for the helper control protocol. */
  private stdoutBuffer = "";

  /** Recent stderr text included in startup failures. */
  private stderrBuffer = "";

  /** Whether the helper has exited or been closed. */
  private closed = false;

  /** Startup promise hooks resolved by the helper READY line. */
  private startup:
    | {
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
        readonly timer: NodeJS.Timeout;
      }
    | undefined;

  constructor(
    private readonly exposure: HostPortExposure,
    private readonly executablePath: string,
    private readonly targetResolver: HostPortProxyTargetResolver,
    private readonly startupTimeoutMs: number,
  ) {}

  /** Starts the helper and waits until it has reserved the host exposure port. */
  start(): Promise<void> {
    if (this.child !== undefined && !this.closed) {
      return Promise.resolve();
    }

    this.closed = false;
    this.child = spawn(this.executablePath, [this.exposure.hostAddress, String(this.exposure.hostPort)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.rememberStderr(chunk));
    this.child.once("error", (error) => this.rejectStartup(error));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.rejectStartup(
        new Error(
          `Native host exposure proxy exited before ready for ${formatExposureEndpoint(this.exposure)}: ${formatNativeExit(code, signal)}${this.formatStderrSuffix()}`,
        ),
      );
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectStartup(
          new Error(`Native host exposure proxy timed out for ${formatExposureEndpoint(this.exposure)}${this.formatStderrSuffix()}`),
        );
      }, this.startupTimeoutMs);
      this.startup = { resolve, reject, timer };
    });
  }

  isActive(): boolean {
    return this.child !== undefined && !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectStartup(new Error(`Native host exposure proxy closed for ${formatExposureEndpoint(this.exposure)}.`));

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
    if (line === `READY\t${this.exposure.hostAddress}\t${this.exposure.hostPort}`) {
      this.resolveStartup();
      return;
    }

    const query = parseNativeHostProxyQueryLine(line);
    if (query === undefined) {
      return;
    }

    try {
      const target = await this.targetResolver.resolve(this.exposure);
      this.writeResponse(`ROUTE\t${query.id}\t${target.host}\t${target.port}\n`);
    } catch {
      this.writeResponse(`ERROR\t${query.id}\n`);
    }
  }

  private writeResponse(line: string): void {
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
  }

  private rejectStartup(error: Error): void {
    if (this.startup === undefined) {
      return;
    }

    clearTimeout(this.startup.timer);
    this.startup.reject(error);
    this.startup = undefined;
  }

  private formatStderrSuffix(): string {
    const stderr = this.stderrBuffer.trim();
    return stderr.length === 0 ? "" : `: ${stderr}`;
  }
}

const STATIC_TARGET_RESOLVER: HostPortProxyTargetResolver = {
  resolve: (exposure) => ({
    host: exposure.targetAddress,
    port: exposure.targetPort,
  }),
};

/** Parses one CONNECT request emitted by the native host exposure helper. */
export function parseNativeHostProxyQueryLine(line: string): NativeHostPortProxyQuery | undefined {
  const parts = line.split("\t");
  if (parts.length !== 6 || parts[0] !== "CONNECT") {
    return undefined;
  }

  const localPort = parseTcpPort(parts[3]);
  const remotePort = parseTcpPort(parts[5]);

  return {
    id: parts[1] ?? "",
    localAddress: parts[2],
    ...(localPort === undefined ? {} : { localPort }),
    remoteAddress: parts[4],
    ...(remotePort === undefined ? {} : { remotePort }),
  };
}

/** Wraps the original Node stream proxy behind the same listener handle. */
function createNodeListenerHandle(server: net.Server, sockets: Set<net.Socket>): NodeHostPortProxyListenerHandle {
  return {
    server,
    sockets,
    isActive: () => true,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await closeServer(server);
    },
  };
}

/** Converts Node's callback-based listen path into a precise promise. */
function listen(server: net.Server, port: number, host: string): Promise<void> {
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
    server.listen(port, host);
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

function parseTcpPort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }

  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function formatExposureEndpoint(exposure: HostPortExposure): string {
  return `${exposure.hostAddress}:${exposure.hostPort}`;
}

function formatNativeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    return `signal ${signal}`;
  }

  return `exit code ${code ?? "unknown"}`;
}

/** Closes a server and treats already-closed handles as success. */
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

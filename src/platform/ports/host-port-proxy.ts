import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { performance } from "node:perf_hooks";
import { buildNodeRuntimeEnvironment } from "../process/node-runtime";
import { defaultProxyNetworkResources, type NativeProxyReservation, type ProxyNetworkResources } from "./proxy-network-resources";
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
  /** Shared with browser/gateway/router owners; defaults to the process-wide proxy budget. */
  readonly resources?: ProxyNetworkResources;
  /** Optional native host exposure helper used for the socket data plane. */
  readonly nativeProxyPath?: string;
  /** Startup timeout for one native host exposure listener. */
  readonly nativeStartupTimeoutMs?: number;
  /** Short-lived target cache for bursty clients; set to 0 to resolve every socket. */
  readonly targetCacheTtlMs?: number;
  /** Bounds route preparation without imposing an idle timeout on established streams. */
  readonly resolveTimeoutMs?: number;
  /** Bounds TCP/DNS connection preparation, ending as soon as connect succeeds. */
  readonly connectTimeoutMs?: number;
  /** Per-listener admission limit, including clients still waiting for a target. */
  readonly maxConnectionsPerListener?: number;
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
  /** Monotonic deadline after which the next connection re-resolves the target. */
  expiresAtMs: number;
}

interface PendingHostPortProxyOpen {
  /** close/dispose invalidate the result before a slow bind can publish it. */
  canceled: boolean;
  promise: Promise<void>;
}

const DEFAULT_NATIVE_STARTUP_TIMEOUT_MS = 1500;
const DEFAULT_TARGET_CACHE_TTL_MS = 150;
const DEFAULT_SETUP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 256;

/** Keep overrides aligned with native setup limits and reject nonfinite timers. */
function setupTimeout(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(Math.ceil(value), 600_000) : DEFAULT_SETUP_TIMEOUT_MS;
}

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
  private readonly resolveTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxConnections: number;
  /** One bind attempt per exposure; close/dispose fence late readiness. */
  private readonly openingListeners = new Map<string, PendingHostPortProxyOpen>();
  private disposed = false;
  private readonly resources: ProxyNetworkResources;

  constructor(
    private readonly targetResolver: HostPortProxyTargetResolver = STATIC_TARGET_RESOLVER,
    private readonly options: HostPortProxyOptions = {},
  ) {
    this.resources = options.resources ?? defaultProxyNetworkResources;
    this.targetCacheTtlMs = Math.max(0, options.targetCacheTtlMs ?? DEFAULT_TARGET_CACHE_TTL_MS);
    this.resolveTimeoutMs = setupTimeout(options.resolveTimeoutMs);
    this.connectTimeoutMs = setupTimeout(options.connectTimeoutMs ?? Number(process.env.PORT_MANAGER_PROXY_CONNECT_TIMEOUT_MS));
    const maxConnections = options.maxConnectionsPerListener ?? Number(process.env.PORT_MANAGER_PROXY_MAX_CONNECTIONS);
    this.maxConnections = Number.isSafeInteger(maxConnections) && maxConnections > 0 && maxConnections <= 4096
      ? maxConnections : DEFAULT_MAX_CONNECTIONS;
  }

  /**
   * Opens a host listener and forwards each connection to the exposure target.
   * Successful resolution means the host port is reserved by Port Manager.
   */
  async open(exposure: HostPortExposure): Promise<void> {
    if (exposure.protocol !== "tcp") {
      throw new Error(`Host proxy only supports tcp exposures, got ${exposure.protocol}.`);
    }

    if (this.disposed) {
      throw new Error("Host proxy manager is disposed.");
    }
    if (this.listeners.get(exposure.id)?.isActive()) {
      return;
    }
    const current = this.openingListeners.get(exposure.id);
    if (current !== undefined) return current.promise;

    const pending: PendingHostPortProxyOpen = { canceled: false, promise: Promise.resolve() };
    this.openingListeners.set(exposure.id, pending);
    pending.promise = this.openListener(exposure).then(async (listener) => {
      if (pending.canceled || this.disposed) {
        await listener.close();
        throw new Error("Host proxy opening was canceled.");
      }
      this.listeners.set(exposure.id, listener);
    }).finally(() => {
      if (this.openingListeners.get(exposure.id) === pending) this.openingListeners.delete(exposure.id);
    });
    return pending.promise;
  }

  /** A new listener remains private until its bind completes in the current lifetime. */
  private async openListener(exposure: HostPortExposure): Promise<HostPortProxyListenerHandle> {
    const stale = this.listeners.get(exposure.id);
    if (stale !== undefined) {
      this.listeners.delete(exposure.id);
      this.targetCache.delete(exposure.id);
      await stale.close();
    }
    await terminateSiblingNativeHostProxyProcesses([exposure]);

    const nativeListener = await this.openNative(exposure);
    if (nativeListener !== undefined) {
      return nativeListener;
    }

    const sockets = new Set<net.Socket>();
    const server = net.createServer({ allowHalfOpen: true }, (incoming) => {
      if (!this.resources.admitClient(incoming)) return;
      sockets.add(incoming);
      incoming.once("close", () => sockets.delete(incoming));
      // Errors can arrive before route lookup returns, so install this before
      // the first await rather than leaving a pending client unhandled.
      incoming.once("error", () => incoming.destroy());
      // Leave kernel reads enabled so a reset cancels a pending lookup.
      // Without a consumer, Node's bounded readable buffer supplies pressure.
      void this.forwardConnection(exposure, incoming, sockets);
    });
    server.maxConnections = this.maxConnections;

    try {
      this.resources.reserveListener(server);
      await listen(server, exposure.hostPort, exposure.hostAddress);
    } catch (error) {
      // Invalid listen options can throw before Node emits error. Closing the
      // unbound server also returns its reservation through the close event.
      await closeServer(server).catch(() => undefined);
      throw error;
    }
    return createNodeListenerHandle(server, sockets);
  }

  /** Closes one active host listener. */
  async close(exposureId: string): Promise<void> {
    const listener = this.listeners.get(exposureId);
    const opening = this.openingListeners.get(exposureId);
    if (opening !== undefined) opening.canceled = true;
    this.listeners.delete(exposureId);
    this.targetCache.delete(exposureId);
    await Promise.all([listener?.close(), opening?.promise.catch(() => undefined)]);
  }

  /**
   * Reclaims an orphaned native helper for a concrete endpoint.
   * Browser-facing proxies use this during migration because an older extension
   * host may have opened the same DNS alias port as a raw TCP gateway.
   */
  async reclaimNativeEndpoint(hostAddress: string, hostPort: number): Promise<void> {
    await terminateSiblingNativeHostProxyProcesses([{ hostAddress, hostPort }]);
  }

  /**
   * Reclaims orphaned native helpers for many endpoints with one process-table
   * read. Reconciliation passes every endpoint it is about to bind here, so the
   * scan cost stays constant instead of growing per endpoint.
   */
  async reclaimNativeEndpoints(
    endpoints: readonly Pick<HostPortExposure, "hostAddress" | "hostPort">[],
  ): Promise<void> {
    await terminateSiblingNativeHostProxyProcesses(endpoints);
  }

  /** Closes every listener during extension shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const ids = new Set([...this.listeners.keys(), ...this.openingListeners.keys()]);
    this.targetCache.clear();
    await Promise.all([...ids].map((id) => this.close(id)));
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
      this.maxConnections,
      this.connectTimeoutMs,
      this.resolveTimeoutMs,
      this.resources,
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
      const resolved = await this.resolveIncomingTarget(exposure, incoming);
      if (resolved === undefined) return;
      target = resolved;
    } catch {
      incoming.destroy();
      return;
    }

    if (incoming.destroyed) {
      return;
    }

    const connectDeadline = performance.now() + this.connectTimeoutMs;
    let outgoing: net.Socket;
    try {
      outgoing = this.resources.connect({ host: target.host, port: target.port, allowHalfOpen: true });
    } catch {
      incoming.destroy();
      return;
    }
    sockets.add(outgoing);
    outgoing.once("close", () => sockets.delete(outgoing));
    const destroyBoth = () => { clearTimeout(timer); incoming.destroy(); outgoing.destroy(); };
    const timer = setTimeout(destroyBoth, Math.max(0, connectDeadline - performance.now()));
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      if (!incoming.destroyed || !outgoing.destroyed) return;
      incoming.off("error", destroyBoth);
      outgoing.off("error", destroyBoth);
      incoming.off("close", onIncomingClose);
      outgoing.off("close", onOutgoingClose);
      outgoing.off("connect", onConnect);
    };
    const onIncomingClose = () => {
      if (!incoming.readableEnded || !incoming.writableFinished) destroyBoth();
      cleanup();
    };
    const onOutgoingClose = () => {
      if (!outgoing.readableEnded || !outgoing.writableFinished) destroyBoth();
      cleanup();
    };
    const onConnect = () => {
      clearTimeout(timer);
      // A ready event may run ahead of an overdue timer after synchronous work.
      if (performance.now() >= connectDeadline || incoming.destroyed || outgoing.destroyed) { destroyBoth(); return; }
      incoming.pipe(outgoing);
      outgoing.pipe(incoming);
    };
    incoming.once("error", destroyBoth);
    outgoing.once("error", destroyBoth);
    incoming.once("close", onIncomingClose);
    outgoing.once("close", onOutgoingClose);
    outgoing.once("connect", onConnect);
  }

  /** Cancel this client's wait promptly while a shared lookup serves other clients. */
  private resolveIncomingTarget(exposure: HostPortExposure, incoming: net.Socket): Promise<HostPortProxyTarget | undefined> {
    if (incoming.destroyed) return Promise.resolve(undefined);
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    incoming.once("close", cancel);
    return this.resources.awaitRoute(this.resolveTarget(exposure), cancellation.signal)
      .then(target => incoming.destroyed ? undefined : target)
      .finally(() => incoming.off("close", cancel));
  }

  /** Resolves dynamic exposure targets while coalescing short connection bursts. */
  private resolveTarget(exposure: HostPortExposure): Promise<HostPortProxyTarget> {
    if (this.targetCacheTtlMs === 0) {
      return this.resolveTargetUncached(exposure);
    }

    const nowMs = performance.now();
    const cached = this.targetCache.get(exposure.id);
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return cached.targetPromise;
    }

    const targetPromise = this.resolveTargetUncached(exposure).then((target) => {
      const entry = this.targetCache.get(exposure.id);
      if (entry?.targetPromise === targetPromise) entry.expiresAtMs = performance.now() + this.targetCacheTtlMs;
      return target;
    }).catch((error) => {
      if (this.targetCache.get(exposure.id)?.targetPromise === targetPromise) {
        this.targetCache.delete(exposure.id);
      }
      throw error;
    });
    this.targetCache.set(exposure.id, {
      targetPromise,
      // A slow lookup remains shared; cache TTL starts only after completion.
      expiresAtMs: Infinity,
    });
    return targetPromise;
  }

  /** Both helpers and fallback consume late results without replaying a timed-out route. */
  private resolveTargetUncached(exposure: HostPortExposure): Promise<HostPortProxyTarget> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const deadline = performance.now() + this.resolveTimeoutMs;
      const finish = (target?: HostPortProxyTarget, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A busy extension host may run a Promise continuation before an
        // already overdue timer. Check elapsed time before admitting its target.
        if (target !== undefined && performance.now() >= deadline) reject(new Error("Host proxy target lookup timed out."));
        else if (target !== undefined) resolve(target);
        else reject(error ?? new Error("Host proxy target lookup failed."));
      };
      const timer = setTimeout(() => finish(undefined, new Error("Host proxy target lookup timed out.")), this.resolveTimeoutMs);
      timer.unref();
      this.resources.runRoute(() => this.targetResolver.resolve(exposure)).then(
        (target) => finish(target), (error: unknown) => finish(undefined, error),
      );
    });
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
  /** Conservative capacity stays held until the child actually exits. */
  private reservation: NativeProxyReservation | undefined;
  private childCreated = false;

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
    private readonly maxConnections: number,
    private readonly connectTimeoutMs: number,
    private readonly resolveTimeoutMs: number,
    private readonly resources: ProxyNetworkResources,
  ) {}

  /** Starts the helper and waits until it has reserved the host exposure port. */
  start(): Promise<void> {
    if (this.child !== undefined && !this.closed) {
      return Promise.resolve();
    }

    this.closed = false;
    this.reservation = this.resources.reserveNative(this.maxConnections, net.isIP(this.exposure.hostAddress) === 0 ? 8 : 1);
    this.child = spawn(this.executablePath, [this.exposure.hostAddress, String(this.exposure.hostPort)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        // Infrastructure sockets already carry their actual coordinates;
        // inheriting a terminal hook would route the proxy itself a second time.
        ...buildNodeRuntimeEnvironment(),
        PORT_MANAGER_PROXY_MAX_CONNECTIONS: String(this.reservation.connections),
        PORT_MANAGER_PROXY_MAX_DNS_JOBS: String(this.reservation.dnsJobs),
        PORT_MANAGER_PROXY_CONNECT_TIMEOUT_MS: String(this.connectTimeoutMs),
        PORT_MANAGER_PROXY_ROUTE_TIMEOUT_MS: String(this.resolveTimeoutMs),
      },
    });
    this.childCreated = this.child.pid !== undefined;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.rememberStderr(chunk));
    this.child.stdin.on("error", () => {
      // A helper may hit its setup/admission limit while a late response is
      // pending. Its closed control pipe must not crash the extension host.
    });
    const child = this.child;
    this.child.once("error", (error) => {
      if (child.pid === undefined) this.reservation?.release();
      this.rejectStartup(error);
    });
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.reservation?.release();
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
      // Another close may already be waiting on this live child. Only a
      // reservation whose spawn never happened can be returned here.
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
    if (this.closed || this.child === undefined || this.child.stdin.destroyed) {
      return;
    }

    // A route that cannot be enqueued expires in the helper; established data
    // streams remain independent of a slow control reader.
    this.resources.writeControl(this.child.stdin, line);
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

/**
 * Reclaims orphaned native helpers for the same endpoints before binding. A VS
 * Code extension reload can leave an old helper alive briefly; if it keeps the
 * port, the new owner cannot install its current target resolver. The process
 * table is read asynchronously and once per call: a synchronous per-endpoint
 * scan here used to freeze the extension host event loop for seconds, stalling
 * every proxy connection.
 */
async function terminateSiblingNativeHostProxyProcesses(
  exposures: readonly Pick<HostPortExposure, "hostAddress" | "hostPort">[],
): Promise<void> {
  const endpoints = exposures.filter((exposure) => exposure.hostPort > 0);
  if (process.platform === "win32" || endpoints.length === 0) {
    return;
  }

  const siblingPids = await findSiblingNativeHostProxyProcessIds(endpoints);
  if (siblingPids.length === 0) {
    return;
  }

  for (const pid of siblingPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already-exited helpers are treated as reclaimed.
    }
  }

  const deadline = Date.now() + 500;
  while (Date.now() < deadline && siblingPids.some(isProcessAlive)) {
    await delay(25);
  }
}

async function findSiblingNativeHostProxyProcessIds(
  exposures: readonly Pick<HostPortExposure, "hostAddress" | "hostPort">[],
): Promise<readonly number[]> {
  let output: string;
  try {
    output = await listProcessTable();
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+([\s\S]+)$/.exec(line);
    if (match === null) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    if (
      Number.isInteger(pid) &&
      pid > 0 &&
      pid !== process.pid &&
      exposures.some((exposure) => isNativeHostProxyCommandForEndpoint(command, exposure.hostAddress, exposure.hostPort))
    ) {
      pids.push(pid);
    }
  }

  return pids;
}

function listProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-Ao", "pid=,command="],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function isNativeHostProxyCommandForEndpoint(command: string, hostAddress: string, hostPort: number): boolean {
  if (!/(?:^|[/\s])portmanager_host_exposure_proxy(?:\s|$)/.test(command)) {
    return false;
  }

  return new RegExp(`\\s${escapeRegExp(hostAddress)}\\s+${hostPort}(?:\\s|$)`).test(command);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

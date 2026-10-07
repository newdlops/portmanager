import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import type { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { devLog, devLogPath } from "../dev-log";
import {
  ProxyResourceBudget, ProxyResourceLimitError,
  type ProxyResourceDemand, type ProxyResourceLease, type ProxyResource,
} from "../../core/networks/proxy-resource-budget";

export { ProxyResourceBudget, ProxyResourceLimitError };

type LookupCallback = Parameters<net.LookupFunction>[2];
/** The OS operation is injectable without replacing cancellation or accounting. */
export type ProxyDnsLookup = (host: string, options: dns.LookupOptions, callback: LookupCallback) => void;

export interface ProxyNetworkResourceOptions {
  readonly budget?: ProxyResourceBudget;
  readonly lookup?: ProxyDnsLookup;
  readonly maxNodeDnsJobs?: number;
  readonly nativeConnectionsPerHelper?: number;
  readonly nativeDnsJobsPerHelper?: number;
  readonly idleSocketTtlMs?: number;
}

export interface NativeProxyReservation extends ProxyResourceLease {
  readonly connections: number;
  readonly dnsJobs: number;
}

interface DnsJob {
  readonly lease: ProxyResourceLease;
  /** Canceling a socket removes its callback, while the OS job keeps its permit. */
  readonly waiters: Set<LookupCallback>;
}

interface IdleSocket {
  readonly lease: ProxyResourceLease;
  readonly expiresAt: number;
}

interface RouteResult { readonly value?: unknown; readonly error?: unknown; readonly failed: boolean }
interface RouteWaiters {
  result?: RouteResult;
  readonly callbacks: Set<(result: RouteResult) => void>;
}

/**
 * Resource ownership for every proxy in one extension host. DNS jobs are
 * shared only while running and stay counted after all clients cancel; socket
 * permits span idle pooling and are returned by close, never by destroy alone.
 */
export class ProxyNetworkResources {
  readonly budget: ProxyResourceBudget;
  private readonly lookupOperation: ProxyDnsLookup;
  private readonly maxNodeDnsJobs: number;
  private readonly nativeConnections: number;
  private readonly nativeDnsJobs: number;
  private readonly idleTtlMs: number;
  /** In-flight OS work only; completed DNS results never become a routing cache. */
  private readonly dnsJobs = new Map<string, DnsJob>();
  private readonly upstreams = new WeakSet<net.Socket>();
  private readonly clients = new WeakSet<net.Socket>();
  private readonly agents = new WeakSet<http.Agent>();
  /** One completion hook per shared Promise; canceled sockets leave no callback on it. */
  private readonly routeWaiters = new WeakMap<Promise<unknown>, RouteWaiters>();
  private routeWaiterCount = 0;
  /** A single timer serves all idle HTTP pools across listeners and origins. */
  private readonly idleSockets = new Map<net.Socket, IdleSocket>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Diagnostics are at most one record per resource/second, even under a burst. */
  private readonly lastLimitLog = new Map<ProxyResource, number>();
  /** Native cleanup retries when any owner's control backlog frees capacity. */
  private readonly controlAvailable = new Set<() => void>();

  constructor(options: ProxyNetworkResourceOptions = {}) {
    this.budget = options.budget ?? new ProxyResourceBudget();
    this.lookupOperation = options.lookup ?? ((host, dnsOptions, callback) => dns.lookup(host, dnsOptions, callback));
    this.maxNodeDnsJobs = positiveLimit(options.maxNodeDnsJobs, 4, 32);
    this.nativeConnections = positiveLimit(options.nativeConnectionsPerHelper, 32, 4096);
    this.nativeDnsJobs = positiveLimit(options.nativeDnsJobsPerHelper, 2, 4);
    this.idleTtlMs = positiveLimit(options.idleSocketTtlMs, 30_000, 600_000);
  }

  /** Reserve listener capacity before bind; return only after server close/failure. */
  reserveListener(server: net.Server): void {
    const lease = this.acquire({ listeners: 1 });
    server.once("close", () => lease.release());
    server.once("error", () => { if (!server.listening) lease.release(); });
  }

  /** Called before sniffing/route work so overloaded clients cannot start another job. */
  admitClient(socket: net.Socket): boolean {
    if (this.clients.has(socket)) return true;
    const lease = this.budget.tryAcquire({ connections: 1 });
    if (lease === undefined) {
      this.noteLimit("connections");
      socket.destroy();
      return false;
    }
    this.clients.add(socket);
    socket.once("close", () => { this.clients.delete(socket); lease.release(); });
    return true;
  }

  /** Reserve a child's worst-case capacity; release on exit, including startup failure. */
  reserveNative(requestedConnections: number, listeners: number): NativeProxyReservation {
    if (!Number.isSafeInteger(requestedConnections) || requestedConnections < 1 || requestedConnections > 4096) {
      throw new RangeError("Native connection capacity must be between 1 and 4096.");
    }
    if (this.budget.limits.controlBytes < 1024) throw new ProxyResourceLimitError("controlBytes");
    const connections = Math.min(requestedConnections, this.nativeConnections);
    const lease = this.acquire({ nativeHelpers: 1, connections, upstreams: connections,
      dnsJobs: this.nativeDnsJobs, listeners });
    return { ...lease, connections, dnsJobs: this.nativeDnsJobs };
  }

  /** Timed-out callers do not free work that their resolver is still doing. */
  runRoute<T>(operation: () => T | Promise<T>): Promise<T> {
    let lease: ProxyResourceLease;
    try { lease = this.acquire({ routeJobs: 1 }); }
    catch (error) { return Promise.reject(error); }
    try { return Promise.resolve(operation()).finally(() => lease.release()); }
    catch (error) { lease.release(); return Promise.reject(error); }
  }

  /** Detach a canceled client's wait without pretending its shared operation stopped. */
  awaitRoute<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
    let group = this.routeWaiters.get(work);
    if (group === undefined) {
      group = { callbacks: new Set() };
      this.routeWaiters.set(work, group);
      const shared = group;
      const complete = (result: RouteResult) => {
        shared.result = result;
        for (const callback of [...shared.callbacks]) callback(result);
        shared.callbacks.clear();
      };
      // Always consume a late rejection, including when every caller canceled.
      void work.then(value => complete({ value, failed: false }), error => complete({ error, failed: true }));
    }
    if (signal.aborted) return Promise.resolve(undefined);
    const shared = group;
    return new Promise((resolve, reject) => {
      const finish = (result?: RouteResult) => {
        signal.removeEventListener("abort", cancel);
        if (shared.callbacks.delete(deliver)) this.routeWaiterCount--;
        if (result?.failed) reject(result.error);
        else resolve(result?.value as T | undefined);
      };
      const cancel = () => finish();
      const deliver = (result: RouteResult) => finish(result);
      if (shared.result !== undefined) { deliver(shared.result); return; }
      shared.callbacks.add(deliver);
      this.routeWaiterCount++;
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  /** Net/TLS factories receive the bounded lookup while preserving address-family fallback. */
  connect(options: net.TcpNetConnectOpts & tls.ConnectionOptions, secure = false): net.Socket {
    return this.createUpstream((lookup) => secure
      ? tls.connect({ ...options, lookup })
      : net.createConnection({ ...options, lookup }));
  }

  /** Decorate each pool once; retain HTTPS Agent's original TLS session handling. */
  configureAgent(agent: http.Agent | https.Agent): void {
    if (this.agents.has(agent)) return;
    this.agents.add(agent);
    const create = agent.createConnection.bind(agent);
    agent.createConnection = (options: Parameters<http.Agent["createConnection"]>[0],
      callback: Parameters<http.Agent["createConnection"]>[1]) => {
      const lease = this.acquire({ upstreams: 1 });
      const cancellation = new AbortController();
      let owned: net.Socket | undefined;
      const adopt = (socket: net.Socket) => {
        if (owned === socket) return;
        owned = socket;
        this.ownUpstream(socket, lease, cancellation);
      };
      const failed = () => { cancellation.abort(); if (owned === undefined) lease.release(); else owned.destroy(); };
      try {
        // Custom Agents may return undefined and finish through the callback.
        // Their in-flight factory still consumes one permit until it finishes.
        const socket = create({ ...options, lookup: this.lookupFor(cancellation.signal) }, (error, stream) => {
          // The default HTTP factory is net.createConnection: its connect
          // listener later calls this with no arguments, after returning the
          // socket synchronously. Custom factories supply (error, stream).
          const created = stream ?? owned;
          if (error != null) { failed(); callback?.(error, stream); }
          else if (created !== undefined) { adopt(created as net.Socket); callback?.(null, created); }
          else {
            failed();
            callback?.(new Error("HTTP connection factory completed without a socket."), stream);
          }
        });
        if (socket !== undefined && socket !== null) adopt(socket as net.Socket);
        return socket;
      } catch (error) { failed(); throw error; }
    };
    const reuse = agent.reuseSocket.bind(agent);
    agent.reuseSocket = (socket, request) => { this.activateSocket(socket as net.Socket); reuse(socket, request); };
    agent.on("free", socket => this.keepIdle(socket));
  }

  /** Standalone transport users may supply an already connected/reused socket. */
  activateSocket(socket: net.Socket): void {
    const entry = this.idleSockets.get(socket);
    if (entry === undefined) return;
    this.idleSockets.delete(socket);
    entry.lease.release();
    this.scheduleIdleExpiry();
  }

  /** Acquire HTTP active/queued permits before constructing a ClientRequest. */
  acquire(demand: ProxyResourceDemand): ProxyResourceLease {
    try { return this.budget.acquire(demand); }
    catch (error) {
      if (error instanceof ProxyResourceLimitError) this.noteLimit(error.resource);
      throw error;
    }
  }

  /** Bound parent-to-native backlog too. Node owns partial writes and frame order. */
  writeControl(stream: Writable, line: string): boolean {
    const bytes = Buffer.byteLength(line);
    if (stream.destroyed || line.indexOf("\n") !== line.length - 1 || line.includes("\r") || bytes > 1024) return false;
    if (bytes + stream.writableLength > 64 * 1024) { this.noteLimit("controlBytes"); return false; }
    const lease = this.budget.tryAcquire({ controlBytes: bytes });
    if (lease === undefined) { this.noteLimit("controlBytes"); return false; }
    try { stream.write(line, "utf8", () => {
      lease.release();
      for (const callback of [...this.controlAvailable]) callback();
    }); }
    catch { lease.release(); return false; }
    return true;
  }

  onControlAvailable(callback: () => void): () => void {
    this.controlAvailable.add(callback);
    return () => { this.controlAvailable.delete(callback); };
  }

  /** Inspection distinguishes retained OS jobs from canceled client callbacks. */
  get pendingDnsWaiters(): number {
    return [...this.dnsJobs.values()].reduce((count, job) => count + job.waiters.size, 0);
  }
  get pendingRouteWaiters(): number { return this.routeWaiterCount; }

  private createUpstream(factory: (lookup: net.LookupFunction) => net.Socket): net.Socket {
    const lease = this.acquire({ upstreams: 1 });
    const cancellation = new AbortController();
    let socket: net.Socket;
    try { socket = factory(this.lookupFor(cancellation.signal)); }
    catch (error) { cancellation.abort(); lease.release(); throw error; }
    this.ownUpstream(socket, lease, cancellation);
    return socket;
  }

  private ownUpstream(socket: net.Socket, lease: ProxyResourceLease, cancellation: AbortController): void {
    this.upstreams.add(socket);
    socket.once("close", () => {
      this.upstreams.delete(socket);
      cancellation.abort();
      this.activateSocket(socket);
      lease.release();
    });
    // Stop retaining DNS waiters when destroy() is called, even if close is
    // deferred. A running OS lookup still owns its job permit until callback.
    const destroy = socket.destroy.bind(socket);
    socket.destroy = error => { cancellation.abort(); return destroy(error); };
  }

  /** A lookup callback is detached on abort; joining cannot add another OS job. */
  private lookupFor(signal: AbortSignal): net.LookupFunction {
    return (host, options, callback) => {
      if (signal.aborted) return;
      const key = JSON.stringify([host.toLowerCase(), options.family ?? 0, options.hints ?? 0,
        options.all ?? false, options.verbatim, options.order]);
      let job = this.dnsJobs.get(key);
      let start = false;
      if (job === undefined) {
        try {
          if (this.dnsJobs.size >= this.maxNodeDnsJobs) throw new ProxyResourceLimitError("dnsJobs");
          job = { lease: this.acquire({ dnsJobs: 1 }), waiters: new Set() };
        } catch (error) {
          if (error instanceof ProxyResourceLimitError) this.noteLimit(error.resource);
          queueMicrotask(() => { if (!signal.aborted) callback(error as NodeJS.ErrnoException, "", 4); });
          return;
        }
        this.dnsJobs.set(key, job);
        start = true;
      }
      const current = job;
      const cancel = () => { current.waiters.delete(deliver); signal.removeEventListener("abort", cancel); };
      const deliver: LookupCallback = (error, address, family) => {
        cancel();
        if (signal.aborted) return;
        callback(error, Array.isArray(address) ? address.map(row => ({ ...row })) : address, family);
      };
      current.waiters.add(deliver);
      signal.addEventListener("abort", cancel, { once: true });
      if (!start) return;
      let finished = false;
      const complete: LookupCallback = (error, address, family) => {
        if (finished) return;
        finished = true;
        // OS callbacks may be synchronous in a test adapter. Always deliver
        // after connect has installed its own error handlers.
        queueMicrotask(() => {
          this.dnsJobs.delete(key);
          current.lease.release();
          const bounded = Array.isArray(address) ? address.slice(0, 64) : address;
          for (const waiter of [...current.waiters]) waiter(error, bounded, family);
          current.waiters.clear();
        });
      };
      try { this.lookupOperation(host, options, complete); }
      catch (error) { complete((error instanceof Error ? error : new Error("Proxy DNS lookup failed.")) as NodeJS.ErrnoException, "", 4); }
    };
  }

  /** Only free HTTP sockets are evicted; SSE/raw/WebSocket sessions never enter this map. */
  private keepIdle(socket: net.Socket): void {
    if (!this.upstreams.has(socket) || socket.destroyed || this.idleSockets.has(socket)) return;
    let lease: ProxyResourceLease;
    try { lease = this.acquire({ idleSockets: 1 }); }
    catch (error) {
      if (!(error instanceof ProxyResourceLimitError)) throw error;
      socket.destroy();
      return;
    }
    this.idleSockets.set(socket, { lease, expiresAt: performance.now() + this.idleTtlMs });
    this.scheduleIdleExpiry();
  }

  private scheduleIdleExpiry(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const first = this.idleSockets.values().next().value;
    if (first === undefined) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      const now = performance.now();
      for (const [socket, entry] of this.idleSockets) {
        if (entry.expiresAt > now) break;
        this.activateSocket(socket);
        socket.destroy();
      }
      this.scheduleIdleExpiry();
    }, Math.max(0, first.expiresAt - performance.now()));
    this.idleTimer.unref();
  }

  private noteLimit(resource: ProxyResource): void {
    if (devLogPath() === undefined) return;
    const now = performance.now();
    if (now - (this.lastLimitLog.get(resource) ?? -Infinity) < 1000) return;
    this.lastLimitLog.set(resource, now);
    devLog("proxy-budget", `limit resource=${resource} used=${this.budget.used[resource]} max=${this.budget.limits[resource]}` +
      ` nodeDns=${this.dnsJobs.size}/${this.maxNodeDnsJobs}`);
  }
}

/** Every default manager in this process shares the same budget and lookup jobs. */
export const defaultProxyNetworkResources = new ProxyNetworkResources();

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

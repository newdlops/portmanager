import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { performance } from "node:perf_hooks";
import { devLog } from "../dev-log";
import type {
  ActiveBrowserNetworkProxyEndpoint,
  BrowserNetworkProxyOptions,
  BrowserNetworkProxyTarget,
  BrowserNetworkProxyTargetResolver,
} from "./browser-network-proxy";
import {
  buildUpgradeRequest,
  buildUpstreamMetadata,
  forwardUpstreamResponse,
  rewriteRequestHeaders,
  writeGatewayError,
  type BrowserNetworkProxyEndpointMetadata,
} from "./browser-network-proxy-http";

/** Match the agent RPC budget without leaving an unresolved route attached forever. */
const DEFAULT_RESOLVE_TIMEOUT_MS = 10_000;
/** Covers TCP connection and TLS handshake only, never application response time. */
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** An ambiguous raw prefix such as "G" must eventually reach its TCP backend. */
const DEFAULT_SNIFF_TIMEOUT_MS = 1_000;
const HTTP_METHOD_PREFIXES = ["GET ", "HEAD ", "POST ", "PUT ", "DELETE ", "OPTIONS ", "PATCH ", "CONNECT ", "TRACE "];
const MAX_SNIFF_BYTES = Math.max(...HTTP_METHOD_PREFIXES.map((method) => method.length));

/** Distinguishes bounded connection setup failures from ordinary unavailable targets. */
class BrowserProxyTimeoutError extends Error {}
class BrowserProxyOverloadError extends Error {}

/**
 * Owns per-request transport lifetimes. The manager owns listeners and pools;
 * this adapter cancels pending work with its client and stops setup deadlines
 * as soon as the transport is ready, preserving long-lived application streams.
 */
export class BrowserNetworkProxyTransport {
  /** Fixed policy per manager; each wait owns and clears its own timer. */
  private readonly resolveTimeoutMs: number;
  /** Applies only until transport readiness, including an upstream TLS handshake. */
  private readonly connectTimeoutMs: number;
  /** Admission happens before ClientRequest creation, so canceled work never enters Agent.requests. */
  private readonly httpQueues = new WeakMap<http.Agent, Map<string, HttpAdmissionQueue>>();
  private readonly queueTimeoutMs: number;
  private readonly maxConcurrentHttpRequests: number;
  private readonly maxQueuedHttpRequests: number;

  constructor(
    private readonly targetResolver: BrowserNetworkProxyTargetResolver,
    options: BrowserNetworkProxyOptions,
  ) {
    this.resolveTimeoutMs = positiveTimeout(options.resolveTimeoutMs, DEFAULT_RESOLVE_TIMEOUT_MS);
    this.connectTimeoutMs = positiveTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.queueTimeoutMs = positiveTimeout(options.queueTimeoutMs, 10_000);
    this.maxConcurrentHttpRequests = positiveInteger(options.maxConcurrentHttpRequests, 64);
    this.maxQueuedHttpRequests = positiveInteger(options.maxQueuedHttpRequests, 128);
  }

  /** Resolve each request afresh; no request, especially a POST, is replayed on failure. */
  async forwardHttp(
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    metadata: BrowserNetworkProxyEndpointMetadata,
    httpAgent: http.Agent,
    httpsAgent: https.Agent,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    let releaseAdmission: (() => void) | undefined;
    try {
      let target = await this.resolveTarget(endpoint, response);
      // Listener shutdown destroys its socket synchronously; IncomingMessage /
      // ServerResponse close flags may follow one turn later during owner handoff.
      if (target === undefined || request.aborted || request.socket.destroyed || response.destroyed) return;

      // A queued POST has sent no bytes yet. Recheck after waiting, and move
      // its permit if an autoreload changed the origin. All moves and lookups
      // share the original admission deadline, so route churn cannot extend it.
      const admissionDeadline = performance.now() + this.queueTimeoutMs;
      for (;;) {
        const agent = target.protocol === "https" ? httpsAgent : httpAgent;
        const admission = await this.admitHttp(endpoint, target, agent, request, response, admissionDeadline);
        if (admission === undefined) return;
        releaseAdmission = admission.release;
        if (!admission.waited) break;
        const current = await this.resolveTarget(endpoint, response, undefined, admissionDeadline);
        if (current === undefined) { releaseAdmission(); return; }
        if (performance.now() >= admissionDeadline) throw timeoutError(endpoint, "queue", this.queueTimeoutMs);
        const sameOrigin = normalizeTargetHost(current.host) === normalizeTargetHost(target.host)
          && current.port === target.port && (current.protocol === "https") === (target.protocol === "https");
        target = current;
        if (sameOrigin) break;
        releaseAdmission();
        releaseAdmission = undefined;
      }
      if (request.aborted || request.socket.destroyed || response.destroyed) { releaseAdmission(); return; }
      const protocol = target.protocol === "https" ? "https" : "http";
      const upstreamMetadata = buildUpstreamMetadata(endpoint, metadata, protocol);
      const requestOptions = {
        host: normalizeTargetHost(target.host), port: target.port,
        method: request.method, path: request.url ?? "/",
        headers: rewriteRequestHeaders(request.headers, upstreamMetadata),
      };
      const onResponse = (upstreamResponse: http.IncomingMessage) => {
        if (response.destroyed || response.writableEnded) upstreamResponse.destroy();
        else forwardUpstreamResponse(request, upstreamResponse, response, upstreamMetadata);
      };
      const upstream = protocol === "https"
        ? https.request({ ...requestOptions, agent: httpsAgent, rejectUnauthorized: false }, onResponse)
        : http.request({ ...requestOptions, agent: httpAgent }, onResponse);

      // The Agent frees/removes its socket during request close. Admit the next
      // request on the next turn, after that bookkeeping, never into its hidden queue.
      const release = releaseAdmission;
      releaseAdmission = undefined;
      upstream.once("close", () => setImmediate(release));

      // Agent queueing is distinct from connection setup. In particular, an
      // already connected keep-alive socket will not emit another ready event.
      let clearConnectionDeadline = () => {};
      const onSocket = (socket: net.Socket) => {
        if (isConnected(socket, protocol)) return;
        clearConnectionDeadline = connectionDeadline(socket, protocol === "https" ? "secureConnect" : "connect",
          this.connectTimeoutMs, () => {
            const error = timeoutError(endpoint, "connect", this.connectTimeoutMs);
            writeGatewayError(response, 504);
            request.unpipe(upstream);
            upstream.destroy(error);
          });
      };
      const cleanup = () => {
        clearConnectionDeadline();
        upstream.off("socket", onSocket);
        request.off("aborted", abortUpstream);
        response.off("close", abortUpstream);
      };
      const abortUpstream = () => {
        cleanup();
        if (!response.writableFinished) {
          request.unpipe(upstream);
          upstream.destroy();
        }
      };
      upstream.once("socket", onSocket);
      upstream.once("error", (error) => {
        cleanup();
        request.unpipe(upstream);
        writeGatewayError(response, error instanceof BrowserProxyTimeoutError ? 504 : 502);
      });
      upstream.once("close", cleanup);
      request.once("aborted", abortUpstream);
      response.once("close", abortUpstream);
      request.pipe(upstream);
    } catch (error) {
      releaseAdmission?.();
      writeGatewayError(response, error instanceof BrowserProxyTimeoutError ? 504 : error instanceof BrowserProxyOverloadError ? 503 : 502);
    }
  }

  /** Pool identity follows the listener and upstream origin; unrelated targets never share a waiting line. */
  private admitHttp(endpoint: ActiveBrowserNetworkProxyEndpoint, target: BrowserNetworkProxyTarget, agent: http.Agent,
    request: http.IncomingMessage, response: http.ServerResponse, deadline: number): Promise<HttpAdmission | undefined> {
    let queues = this.httpQueues.get(agent);
    if (queues === undefined) { queues = new Map(); this.httpQueues.set(agent, queues); }
    const key = JSON.stringify([normalizeTargetHost(target.host), target.port]);
    let queue = queues.get(key);
    if (queue === undefined) {
      const ownedQueues = queues;
      queue = new HttpAdmissionQueue(Math.min(this.maxConcurrentHttpRequests, agent.maxSockets), this.maxQueuedHttpRequests,
        () => ownedQueues.delete(key));
      queues.set(key, queue);
    }
    return queue.acquire(request, response, deadline, () => timeoutError(endpoint, "queue", this.queueTimeoutMs));
  }

  /** Rewrites the upgrade handshake once, then preserves the full-duplex stream. */
  async forwardUpgrade(
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    metadata: BrowserNetworkProxyEndpointMetadata,
    request: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    sockets: Set<net.Socket>,
  ): Promise<void> {
    try {
      const target = await this.resolveTarget(endpoint, socket);
      if (target === undefined || socket.destroyed) return;

      const host = normalizeTargetHost(target.host);
      const protocol = target.protocol === "https" ? "https" : "http";
      const upstreamMetadata = buildUpstreamMetadata(endpoint, metadata, protocol);
      const upstream = protocol === "https"
        ? tls.connect({ host, port: target.port, rejectUnauthorized: false,
            ...(net.isIP(host) === 0 ? { servername: host } : {}) })
        : net.createConnection({ host, port: target.port, allowHalfOpen: true });
      upstream.allowHalfOpen = true;
      this.forwardSockets(endpoint, socket, upstream, sockets, protocol === "https" ? "secureConnect" : "connect", () => {
        upstream.write(buildUpgradeRequest(request, upstreamMetadata));
        if (head.length > 0) upstream.write(head);
      });
    } catch {
      socket.destroy();
    }
  }

  /** Raw protocols share cancellation and connection bounds with HTTP, without an idle timeout. */
  async rawForward(
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    client: net.Socket,
    sockets: Set<net.Socket>,
    head?: Buffer,
  ): Promise<void> {
    try {
      const target = await this.resolveTarget(endpoint, client);
      if (target === undefined || client.destroyed) return;
      const upstream = net.createConnection({ host: normalizeTargetHost(target.host), port: target.port, allowHalfOpen: true });
      this.forwardSockets(endpoint, client, upstream, sockets, "connect", () => {
        // The sniffer may already have consumed FIN; unshift after end would
        // discard the prefix. Write these bounded bytes before piping the rest.
        if (head !== undefined && head.length > 0) upstream.write(head);
      });
    } catch {
      client.destroy();
    }
  }

  /**
   * An idle client may be waiting for a database/SMTP greeting. Connect without
   * sending bytes, and commit to raw forwarding only when the backend speaks.
   * First client bytes cancel this probe so delayed HTTP and TLS retain rewriting.
   */
  async probeServerGreeting(endpoint: ActiveBrowserNetworkProxyEndpoint, client: net.Socket, sockets: Set<net.Socket>,
    signal: AbortSignal, onGreeting: (forward: () => void) => void): Promise<void> {
    let upstream: net.Socket | undefined;
    let handedOff = false;
    let clearDeadline = () => {};
    const cancel = () => { clearDeadline(); upstream?.destroy(); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const target = await this.resolveTarget(endpoint, client, signal);
      if (target === undefined || client.destroyed || signal.aborted) return;
      upstream = net.createConnection({ host: normalizeTargetHost(target.host), port: target.port, allowHalfOpen: true });
      const peer = upstream;
      sockets.add(peer);
      client.once("close", cancel);
      peer.once("close", () => {
        clearDeadline();
        sockets.delete(peer);
        signal.removeEventListener("abort", cancel);
        client.off("close", cancel);
        if (!handedOff && !signal.aborted) client.destroy();
      });
      peer.once("error", () => { peer.destroy(); if (!signal.aborted) client.destroy(); });
      clearDeadline = connectionDeadline(peer, "connect", this.connectTimeoutMs, () => {
        timeoutError(endpoint, "connect", this.connectTimeoutMs);
        peer.destroy();
        if (!signal.aborted) client.destroy();
      });
      // Readable mode retains the greeting and subsequent bytes in order. A
      // silent established backend has no idle deadline, just like a raw stream.
      peer.once("readable", () => {
        if (peer.readableLength === 0 || signal.aborted || client.destroyed) { peer.destroy(); return; }
        clearDeadline();
        signal.removeEventListener("abort", cancel);
        client.off("close", cancel);
        handedOff = true;
        onGreeting(() => this.forwardSockets(endpoint, client, peer, sockets, "connect"));
      });
    } catch {
      if (!signal.aborted) client.destroy();
    } finally {
      if (upstream === undefined) signal.removeEventListener("abort", cancel);
    }
  }

  /**
   * Closing a client releases its wait immediately, even if the shared resolver
   * continues a refresh for other clients. Both late success and rejection are
   * consumed, and neither may open a socket after cancellation or timeout.
   */
  private resolveTarget(
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    client: net.Socket | http.ServerResponse,
    signal?: AbortSignal,
    admissionDeadline?: number,
  ): Promise<BrowserNetworkProxyTarget | undefined> {
    if (client.destroyed || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (target?: BrowserNetworkProxyTarget, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off("close", cancel);
        signal?.removeEventListener("abort", cancel);
        if (error !== undefined) reject(error);
        else resolve(target);
      };
      const cancel = () => finish();
      const remaining = admissionDeadline === undefined ? Infinity : admissionDeadline - performance.now();
      const queueLimited = remaining <= this.resolveTimeoutMs;
      const timer = setTimeout(() => finish(undefined, timeoutError(endpoint,
        queueLimited ? "queue" : "resolve", queueLimited ? this.queueTimeoutMs : this.resolveTimeoutMs)),
        Math.max(0, Math.min(this.resolveTimeoutMs, remaining)));
      timer.unref();
      client.once("close", cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        Promise.resolve(this.targetResolver.resolve(endpoint)).then(
          (target) => finish(target),
          (error: unknown) => finish(undefined, error ?? new Error("Browser proxy route lookup failed.")),
        );
      } catch (error) {
        finish(undefined, error ?? new Error("Browser proxy route lookup failed."));
      }
    });
  }

  /** FIN closes one direction; errors/reset close both. Normal close must let the peer flush its writes. */
  private forwardSockets(
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    client: net.Socket,
    upstream: net.Socket,
    sockets: Set<net.Socket>,
    readyEvent: "connect" | "secureConnect",
    beforePipe?: () => void,
  ): void {
    sockets.add(upstream);
    const destroyBoth = () => {
      clearDeadline();
      client.destroy();
      upstream.destroy();
    };
    const clearDeadline = connectionDeadline(upstream, readyEvent, this.connectTimeoutMs, () => {
      timeoutError(endpoint, "connect", this.connectTimeoutMs);
      destroyBoth();
    });
    const onReady = () => {
      if (client.destroyed) { destroyBoth(); return; }
      beforePipe?.();
      client.pipe(upstream);
      upstream.pipe(client);
    };
    client.once("error", destroyBoth);
    upstream.once("error", destroyBoth);
    const onClientClose = () => {
      if (!client.readableEnded || !client.writableFinished) destroyBoth();
      cleanup();
    };
    const onUpstreamClose = () => {
      if (!upstream.readableEnded || !upstream.writableFinished) destroyBoth();
      sockets.delete(upstream);
      upstream.off(readyEvent, onReady);
      cleanup();
    };
    const cleanup = () => {
      if (!client.destroyed || !upstream.destroyed) return;
      clearDeadline();
      sockets.delete(upstream);
      client.off("error", destroyBoth);
      client.off("close", onClientClose);
      upstream.off("error", destroyBoth);
      upstream.off("close", onUpstreamClose);
      upstream.off(readyEvent, onReady);
    };
    client.once("close", onClientClose);
    upstream.once("close", onUpstreamClose);
    if (isConnected(upstream, readyEvent === "secureConnect" ? "https" : "http")) { clearDeadline(); onReady(); }
    else upstream.once(readyEvent, onReady);
  }
}

/** Only requests that actually waited require a second route lookup. */
interface HttpAdmission { readonly release: () => void; readonly waited: boolean }

/** A FIFO admission queue owns cancellation; Node's Agent only sees admitted requests. */
class HttpAdmissionQueue {
  /** A permit remains occupied until the complete upstream request closes, including SSE. */
  private active = 0;
  /** Set insertion order provides FIFO admission and constant-time cancellation. */
  private readonly waiting = new Set<() => void>();

  constructor(private readonly limit: number, private readonly maxWaiting: number, private readonly onIdle: () => void) {}

  acquire(request: http.IncomingMessage, response: http.ServerResponse, deadline: number,
    expire: () => Error): Promise<HttpAdmission | undefined> {
    const canceled = () => request.aborted || request.socket.destroyed || response.destroyed;
    if (canceled()) { this.removeIfIdle(); return Promise.resolve(undefined); }
    if (performance.now() >= deadline) { this.removeIfIdle(); return Promise.reject(expire()); }
    if (this.active < this.limit) { this.active++; return Promise.resolve({ release: this.permit(), waited: false }); }
    if (this.waiting.size >= this.maxWaiting) return Promise.reject(new BrowserProxyOverloadError("HTTP admission queue is full."));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (admit: boolean, error?: Error) => {
        if (settled) return;
        settled = true;
        this.waiting.delete(grant);
        clearTimeout(timer);
        request.off("aborted", cancel);
        request.socket.off("close", cancel);
        response.off("close", cancel);
        if (admit && !canceled() && performance.now() >= deadline) reject(expire());
        else if (admit && !canceled()) { this.active++; resolve({ release: this.permit(), waited: true }); }
        else if (error !== undefined) reject(error);
        else resolve(undefined);
        this.removeIfIdle();
      };
      const grant = () => finish(true);
      const cancel = () => finish(false);
      const timer = setTimeout(() => finish(false, expire()), Math.max(0, deadline - performance.now()));
      timer.unref();
      this.waiting.add(grant);
      request.once("aborted", cancel);
      request.socket.once("close", cancel);
      response.once("close", cancel);
    });
  }

  /** Idempotent release keeps abort/error/close races from manufacturing extra capacity. */
  private permit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.active < this.limit && this.waiting.size > 0) this.waiting.values().next().value!();
      this.removeIfIdle();
    };
  }

  private removeIfIdle(): void {
    if (this.active === 0 && this.waiting.size === 0) this.onIdle();
  }
}

/**
 * Peek at most one method prefix and return every byte before dispatch. TCP
 * packet boundaries are arbitrary: "G" followed by "ET " still needs the HTTP
 * rewrite path. Idle sessions may probe for server-first greetings without
 * assuming that a delayed HTTP request or TLS ClientHello speaks raw TCP.
 */
export function sniffBrowserProxyConnection(
  socket: net.Socket,
  onHttp: () => void,
  onTls: () => void,
  onRaw: (head: Buffer) => void,
  hasTls: () => boolean,
  sniffTimeoutMs?: number,
  probeGreeting?: (signal: AbortSignal, onGreeting: (forward: () => void) => void) => void,
  serverGreetingDelayMs?: number,
): void {
  let prefix = Buffer.alloc(0);
  let dispatched = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const greeting = new AbortController();
  const greetingTimer = probeGreeting === undefined ? undefined : setTimeout(() => {
    if (!dispatched && !socket.destroyed && prefix.length === 0) probeGreeting(greeting.signal, (forward) => dispatch(forward));
  }, positiveTimeout(serverGreetingDelayMs, 100));
  greetingTimer?.unref();
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(greetingTimer);
    greeting.abort();
    socket.off("readable", onReadable);
    socket.off("end", onEnd);
    socket.off("close", cleanup);
  };
  const dispatch = (handler: () => void, restorePrefix = true) => {
    if (dispatched || socket.destroyed) return;
    dispatched = true;
    cleanup();
    if (restorePrefix && prefix.length > 0) socket.unshift(prefix);
    handler();
  };
  const dispatchRaw = () => dispatch(() => onRaw(prefix), false);
  const onReadable = () => {
    const count = Math.min(socket.readableLength, MAX_SNIFF_BYTES - prefix.length);
    if (count === 0) return;
    const chunk = socket.read(count) as Buffer | null;
    if (chunk === null) return;
    clearTimeout(greetingTimer);
    greeting.abort();
    prefix = Buffer.concat([prefix, chunk]);
    if (prefix[0] === 0x16 && hasTls()) { dispatch(onTls); return; }
    const text = prefix.toString("latin1");
    if (HTTP_METHOD_PREFIXES.some((method) => text.startsWith(method))) { dispatch(onHttp); return; }
    if (!HTTP_METHOD_PREFIXES.some((method) => method.startsWith(text))) { dispatchRaw(); return; }
    if (timer === undefined) {
      timer = setTimeout(dispatchRaw, positiveTimeout(sniffTimeoutMs, DEFAULT_SNIFF_TIMEOUT_MS));
      timer.unref();
    }
  };
  const onEnd = () => {
    if (prefix.length > 0) dispatchRaw();
    else { cleanup(); socket.destroy(); }
  };
  socket.on("readable", onReadable);
  socket.once("end", onEnd);
  socket.once("close", cleanup);
}

/** Unlike socket.setTimeout, this bounds only setup and cannot kill an idle SSE/WS/raw stream. */
function connectionDeadline(socket: net.Socket, readyEvent: "connect" | "secureConnect", delayMs: number, expire: () => void): () => void {
  const cleanup = () => {
    clearTimeout(timer);
    socket.off(readyEvent, cleanup);
    socket.off("close", cleanup);
  };
  const timer = setTimeout(() => { cleanup(); expire(); }, delayMs);
  timer.unref();
  socket.once(readyEvent, cleanup);
  socket.once("close", cleanup);
  return cleanup;
}

/** Queued requests may receive a reused TLS socket even when ClientRequest.reusedSocket is false. */
function isConnected(socket: net.Socket, protocol: "http" | "https"): boolean {
  if (socket.connecting) return false;
  if (protocol === "http") return true;
  const negotiated = socket instanceof tls.TLSSocket ? socket.getProtocol() : null;
  return negotiated !== null && negotiated !== "unknown";
}

/** Diagnostics include only route identity and phase, never request URLs or credentials. */
function timeoutError(endpoint: ActiveBrowserNetworkProxyEndpoint, phase: "resolve" | "connect" | "queue", timeoutMs: number): BrowserProxyTimeoutError {
  devLog("ts-browser-proxy", `timeout endpoint=${JSON.stringify(endpoint.id)} phase=${phase} timeoutMs=${timeoutMs}`);
  return new BrowserProxyTimeoutError(`Browser proxy ${phase} timed out after ${timeoutMs}ms.`);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(value, 2_147_483_647) : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeTargetHost(host: string): string {
  return host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
}

import {
  buildEndpointMetadata,
  type BrowserNetworkProxyEndpointMetadata,
} from "./browser-network-proxy-http";
export { rewriteBrowserProxyResponseTextForTest } from "./browser-network-proxy-http";
import { createHash } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { BrowserNetworkProxyTransport, sniffBrowserProxyConnection } from "./browser-network-proxy-transport";

export interface BrowserNetworkProxyEndpoint {
  /** Stable id for one network/logical-port browser entrypoint. */
  readonly id: string;
  /** Logical network that should receive browser traffic accepted here. */
  readonly networkId: string;
  /** Application port the web server should believe the browser requested. */
  readonly logicalPort: number;
  /** Network-specific loopback address exposed to the browser cookie jar. */
  readonly listenHost: string;
  /** Browser-facing hostname that resolves to listenHost when local DNS is configured. */
  readonly publicHost?: string;
  /**
   * Routed network loopback whose self-referential response URLs must return to
   * this endpoint's browser DNS alias. This intentionally differs from
   * listenHost: browser and routed loopback aliases use separate address bands.
   */
  readonly responseRewriteLoopbackHost?: string;
  /** Browser-facing protocol. HTTPS is used when the extension owns a trusted dev certificate. */
  readonly publicProtocol?: "http" | "https";
  /** Ports tried in order; the logical port is preferred when it is not already occupied. */
  readonly listenPorts: readonly number[];
}

export interface ActiveBrowserNetworkProxyEndpoint extends BrowserNetworkProxyEndpoint {
  /** Concrete public port selected from listenPorts. */
  readonly listenPort: number;
}

export interface BrowserNetworkProxyTarget {
  /** Current host where the real development server accepts sockets. */
  readonly host: string;
  /** Current actual port where the real development server accepts sockets. */
  readonly port: number;
  /** Upstream application protocol. HTTP remains the default for dev servers. */
  readonly protocol?: "http" | "https";
}

export interface BrowserNetworkProxyTargetResolver {
  /**
   * Resolves the live upstream target for every request. Actual ports can move
   * after daemon restart or hook recovery, so the listener does not cache them.
   */
  resolve(endpoint: ActiveBrowserNetworkProxyEndpoint): BrowserNetworkProxyTarget | Promise<BrowserNetworkProxyTarget>;
}

export interface BrowserNetworkProxyOptions {
  /** Maximum wait for a live route; defaults to the agent RPC budget of 10s. */
  readonly resolveTimeoutMs?: number;
  /** TCP/TLS setup budget after socket allocation, default 5s; established streams have no idle limit. */
  readonly connectTimeoutMs?: number;
  /** Maximum wait for an ambiguous partial HTTP method before raw forwarding, default 1s. */
  readonly sniffTimeoutMs?: number;
  /** Idle clients probe for a server-first greeting after 100ms, without committing HTTP/TLS to raw TCP. */
  readonly serverGreetingDelayMs?: number;
  /** Per upstream origin HTTP concurrency; defaults to 64. */
  readonly maxConcurrentHttpRequests?: number;
  /** Per upstream origin waiting requests; defaults to 128. Overflow receives 503. */
  readonly maxQueuedHttpRequests?: number;
  /** Admission wait budget, default 10s. Expiry receives 504 without sending the request upstream. */
  readonly queueTimeoutMs?: number;
  /** Initial bind retry delay; repeated failures grow up to 30s (or a larger initial delay). */
  readonly retryDelayMs?: number;
  /** Lets the owner refresh desired routes and validate its lease before a timed retry. */
  readonly onRetryDue?: () => Promise<void>;
  /** Grace window before closing endpoints that briefly disappear from route snapshots. */
  readonly retireDelayMs?: number;
  /** Supplies the dev TLS certificate used by HTTPS browser-facing endpoints. */
  readonly tlsCredentials?: BrowserNetworkProxyTlsCredentialsProvider;
}

export interface BrowserNetworkProxyTlsCredentials {
  /** PEM private key for the browser-facing HTTPS listener. */
  readonly key: string | Buffer;
  /** PEM certificate chain for the browser-facing HTTPS listener. */
  readonly cert: string | Buffer;
}

export interface BrowserNetworkProxyTlsCredentialsProvider {
  /**
   * Returns the active TLS identity once per sync/ensure. The next reconciliation
   * observes certificate rotation without repeatedly loading each listener's PEM.
   */
  getCredentials(): BrowserNetworkProxyTlsCredentials | undefined;
}

interface BrowserNetworkProxyListener {
  /** Active endpoint including the concrete listen port. */
  endpoint: ActiveBrowserNetworkProxyEndpoint;
  /** Precomputed host/origin strings reused by every request on this endpoint. */
  metadata: BrowserNetworkProxyEndpointMetadata;
  /** TLS-sniffing listener that owns the browser-facing socket. */
  readonly server: BrowserNetworkProxyServer;
  /** Inner HTTPS terminator for connections sniffed as TLS; absent without credentials. */
  tlsServer?: https.Server;
  /** Mutable TLS dispatch used by the sniffer for newly accepted ClientHellos. */
  readonly tlsDispatch: BrowserNetworkProxyTlsDispatch;
  /** Creates a TLS terminator after credentials become available post-bind. */
  readonly installTls: (credentials: BrowserNetworkProxyTlsCredentials) => https.Server;
  /** Upstream HTTP connection pool scoped to this browser-facing endpoint. */
  readonly httpAgent: http.Agent;
  /** Upstream HTTPS connection pool scoped to this browser-facing endpoint. */
  readonly httpsAgent: https.Agent;
  /** Client and upstream sockets closed together during reconciliation. */
  readonly sockets: Set<net.Socket>;
  /** Fingerprint of the TLS identity loaded when this HTTPS listener opened. */
  tlsCredentialsFingerprint?: string;
}

type BrowserNetworkProxyServer = net.Server;

interface BrowserNetworkProxyServerBuild {
  /** Outer listener that sniffs each connection and demultiplexes TLS from raw TCP. */
  readonly server: net.Server;
  /** Inner HTTPS terminator, fed sniffed TLS connections; absent without credentials. */
  readonly tlsServer?: https.Server;
  readonly tlsDispatch: BrowserNetworkProxyTlsDispatch;
  readonly installTls: (credentials: BrowserNetworkProxyTlsCredentials) => https.Server;
  readonly tlsCredentialsFingerprint?: string;
}

interface BrowserNetworkProxyTlsDispatch {
  server?: https.Server;
}

/** One reconciliation observes one TLS identity, including during certificate rotation. */
interface BrowserNetworkProxyTlsIdentity {
  readonly credentials: BrowserNetworkProxyTlsCredentials;
  readonly fingerprint: string;
}

interface BrowserNetworkProxyBindFailure {
  readonly endpoint: BrowserNetworkProxyEndpoint;
  readonly attempts: number;
  readonly retryAtMs: number;
}

const DEFAULT_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_CONCURRENT_OPENS = 8;
const DEFAULT_RETIRE_DELAY_MS = 30_000;
/** A blackholed loopback probe must not stall every endpoint in a serialized sync. */
const PORT_AVAILABILITY_TIMEOUT_MS = 250;
const UPSTREAM_KEEP_ALIVE_MAX_SOCKETS = 64;
const UPSTREAM_KEEP_ALIVE_MAX_FREE_SOCKETS = 16;
/**
 * Development-only browser isolation proxy.
 *
 * Browsers scope cookies by host, not by port. This proxy lets a browser see a
 * network-specific loopback host while rewriting request metadata so the web
 * server still observes a localhost development origin.
 */
export class BrowserNetworkProxyManager {
  /** Active browser entrypoints keyed by network/logical-port endpoint id. */
  private readonly listeners = new Map<string, BrowserNetworkProxyListener>();

  /** Only the latest desired endpoints may be resurrected by a timed bind retry. */
  private desiredEndpoints = new Map<string, BrowserNetworkProxyEndpoint>();

  /** Consecutive failures are scoped to immutable bind coordinates, not just endpoint IDs. */
  private readonly bindFailures = new Map<string, BrowserNetworkProxyBindFailure>();

  /** One wakeup serves all failed endpoints; neither the timer nor callbacks survive releaseAll. */
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryInFlight = false;

  /** Delayed closes for endpoints that vanished during a transient routing refresh. */
  private readonly retireTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Serializes refreshes so an older sync cannot retire a newer listener. */
  private mutationTail: Promise<void> = Promise.resolve();

  /** Once disposed, queued work must not resurrect a listener. */
  private disposed = false;

  /**
   * Cross-window owner handoff fence. A long endpoint reconciliation may still
   * be awaiting process or socket work when its lease is revoked; the fence
   * makes that stale operation close any listener it opened after revocation.
   */
  private ownershipGeneration = 0;

  /** Per-request setup and cancellation is independent of listener reconciliation. */
  private readonly transport: BrowserNetworkProxyTransport;

  constructor(
    targetResolver: BrowserNetworkProxyTargetResolver,
    private readonly options: BrowserNetworkProxyOptions = {},
  ) {
    this.transport = new BrowserNetworkProxyTransport(targetResolver, options);
  }

  /** Reconciles active browser proxies with the latest running web processes. */
  async sync(endpoints: Iterable<BrowserNetworkProxyEndpoint>): Promise<void> {
    const ownershipGeneration = this.ownershipGeneration;
    return this.serialize(() => this.syncExclusive(endpoints, ownershipGeneration));
  }

  private async syncExclusive(
    endpoints: Iterable<BrowserNetworkProxyEndpoint>,
    ownershipGeneration: number,
  ): Promise<void> {
    if (this.disposed || ownershipGeneration !== this.ownershipGeneration) {
      return;
    }
    const desired = new Map<string, BrowserNetworkProxyEndpoint>();
    for (const endpoint of endpoints) {
      if (isTcpPort(endpoint.logicalPort) && endpoint.listenPorts.some(isTcpPort)) {
        desired.set(endpoint.id, normalizeEndpoint(endpoint));
      }
    }
    this.desiredEndpoints = desired;
    for (const [id, failure] of this.bindFailures) {
      const endpoint = desired.get(id);
      if (endpoint === undefined || !sameBindCandidates(failure.endpoint, endpoint)) {
        this.bindFailures.delete(id);
      }
    }
    const tlsIdentity = desired.size === 0 ? undefined : this.readTlsIdentity();

    for (const [id, listener] of [...this.listeners]) {
      if (ownershipGeneration !== this.ownershipGeneration) {
        return;
      }

      const endpoint = desired.get(id);
      if (endpoint === undefined) {
        this.scheduleRetire(id);
        continue;
      }

      this.cancelRetire(id);
      if (!isEndpointBindCurrent(listener.endpoint, endpoint)) {
        await this.closeListener(id);
      } else {
        this.reconcileListener(listener, endpoint, tlsIdentity);
      }
    }

    await this.openPendingEndpoints([...desired.values()].filter((endpoint) =>
      !this.listeners.has(endpoint.id) && Date.now() >= (this.bindFailures.get(endpoint.id)?.retryAtMs ?? 0),
    ), ownershipGeneration, tlsIdentity);
    this.scheduleRetry();
  }

  /** Opens or returns one endpoint immediately, ignoring background retry backoff. */
  async ensure(endpoint: BrowserNetworkProxyEndpoint): Promise<ActiveBrowserNetworkProxyEndpoint | undefined> {
    const ownershipGeneration = this.ownershipGeneration;
    return this.serialize(() => this.ensureExclusive(endpoint, ownershipGeneration));
  }

  private async ensureExclusive(
    endpoint: BrowserNetworkProxyEndpoint,
    ownershipGeneration: number,
  ): Promise<ActiveBrowserNetworkProxyEndpoint | undefined> {
    if (this.disposed || ownershipGeneration !== this.ownershipGeneration) {
      return undefined;
    }
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    if (!isTcpPort(normalizedEndpoint.logicalPort) || normalizedEndpoint.listenPorts.length === 0) return undefined;
    this.desiredEndpoints.set(normalizedEndpoint.id, normalizedEndpoint);
    const tlsIdentity = this.readTlsIdentity();
    const listener = this.listeners.get(normalizedEndpoint.id);
    if (listener !== undefined && isEndpointBindCurrent(listener.endpoint, normalizedEndpoint)) {
      this.cancelRetire(normalizedEndpoint.id);
      this.reconcileListener(listener, normalizedEndpoint, tlsIdentity);
      return listener.endpoint;
    }

    this.bindFailures.delete(normalizedEndpoint.id);
    await this.closeListener(normalizedEndpoint.id);
    if (ownershipGeneration !== this.ownershipGeneration || !this.desiredEndpoints.has(normalizedEndpoint.id)) return undefined;

    try {
      const activeEndpoint = await this.open(normalizedEndpoint, tlsIdentity);
      if (ownershipGeneration !== this.ownershipGeneration || !this.desiredEndpoints.has(normalizedEndpoint.id)) {
        await this.closeListener(normalizedEndpoint.id);
        return undefined;
      }
      return activeEndpoint;
    } catch {
      if (ownershipGeneration === this.ownershipGeneration && this.desiredEndpoints.has(normalizedEndpoint.id)) {
        this.recordBindFailure(normalizedEndpoint);
      }
      return undefined;
    } finally {
      this.scheduleRetry();
    }
  }

  /** Returns the active endpoint for a previously opened network/logical-port pair. */
  get(networkId: string, logicalPort: number): ActiveBrowserNetworkProxyEndpoint | undefined {
    return this.listeners.get(browserNetworkProxyEndpointId(networkId, logicalPort))?.endpoint;
  }

  /** True when this manager already owns an open listener for the endpoint id. */
  has(endpointId: string): boolean {
    return this.listeners.has(endpointId);
  }

  /** Clears bind retry throttles when an external owner handoff may have freed the socket. */
  retryFailedEndpointsNow(): void {
    this.bindFailures.clear();
    this.cancelRetry();
  }

  /** Closes one browser proxy endpoint. */
  async close(endpointId: string): Promise<void> {
    this.desiredEndpoints.delete(endpointId);
    this.bindFailures.delete(endpointId);
    this.scheduleRetry();
    await this.closeListener(endpointId);
  }

  /** Internal rebinding preserves the latest desired endpoint and its retry history. */
  private async closeListener(endpointId: string): Promise<void> {
    this.cancelRetire(endpointId);
    const listener = this.listeners.get(endpointId);
    if (listener === undefined) {
      return;
    }

    this.listeners.delete(endpointId);

    for (const socket of listener.sockets) {
      socket.destroy();
    }
    listener.sockets.clear();
    listener.httpAgent.destroy();
    listener.httpsAgent.destroy();

    await closeServer(listener.server);
  }

  /**
   * Immediately frees every browser-facing bind without permanently disposing
   * the manager. This is distinct from ordinary sync retirement: a new owner
   * cannot take over while the old listener waits through the grace period.
   */
  async releaseAll(): Promise<void> {
    this.ownershipGeneration += 1;
    this.desiredEndpoints.clear();
    this.bindFailures.clear();
    this.cancelRetry();
    const ids = [...this.listeners.keys()];
    for (const id of [...this.retireTimers.keys()]) {
      this.cancelRetire(id);
    }
    await Promise.all(ids.map((id) => this.closeListener(id)));
  }

  /** Closes every browser proxy endpoint during extension shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const pendingMutations = this.mutationTail;
    await this.releaseAll();
    await pendingMutations;
    // An open that was already inside the kernel bind may have completed after
    // the first snapshot; the generation fence makes it visible for this pass.
    await this.releaseAll();
  }

  /** Queues public mutations without holding a lock across request handling. */
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  /** Defers destructive close so short-lived route-table holes do not kill WebSocket streams. */
  private scheduleRetire(endpointId: string): void {
    if (this.retireTimers.has(endpointId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.retireTimers.delete(endpointId);
      void this.close(endpointId).catch(() => undefined);
    }, this.options.retireDelayMs ?? DEFAULT_RETIRE_DELAY_MS);
    timer.unref?.();
    this.retireTimers.set(endpointId, timer);
  }

  private cancelRetire(endpointId: string): void {
    const timer = this.retireTimers.get(endpointId);
    if (timer === undefined) {
      return;
    }

    clearTimeout(timer);
    this.retireTimers.delete(endpointId);
  }

  /** Independent binds share a batch; every earlier overlapping candidate retains priority. */
  private async openPendingEndpoints(
    pending: readonly BrowserNetworkProxyEndpoint[],
    generation: number,
    tlsIdentity: BrowserNetworkProxyTlsIdentity | undefined,
  ): Promise<void> {
    while (pending.length > 0 && generation === this.ownershipGeneration && !this.disposed) {
      const batch: BrowserNetworkProxyEndpoint[] = [];
      const deferred: BrowserNetworkProxyEndpoint[] = [];
      const earlier: BrowserNetworkProxyEndpoint[] = [];
      for (const endpoint of pending) {
        if (batch.length < MAX_CONCURRENT_OPENS && !earlier.some((other) => shareBindCandidate(other, endpoint))) {
          batch.push(endpoint);
        } else {
          deferred.push(endpoint);
        }
        earlier.push(endpoint);
      }
      await Promise.all(batch.map(async (endpoint) => {
        if (!this.desiredEndpoints.has(endpoint.id)) return;
        this.cancelRetire(endpoint.id);
        try {
          await this.open(endpoint, tlsIdentity);
          if (generation !== this.ownershipGeneration || !this.desiredEndpoints.has(endpoint.id)) {
            await this.closeListener(endpoint.id);
          } else {
            this.bindFailures.delete(endpoint.id);
          }
        } catch {
          if (generation === this.ownershipGeneration && this.desiredEndpoints.has(endpoint.id)) {
            this.recordBindFailure(endpoint);
          }
        }
      }));
      pending = deferred;
    }
  }

  /** Short initial retries recover handoffs quickly; sustained failures remain cheap. */
  private recordBindFailure(endpoint: BrowserNetworkProxyEndpoint): void {
    const previous = this.bindFailures.get(endpoint.id);
    const attempts = Math.min((previous?.attempts ?? 0) + 1, 16);
    const initialDelay = Math.max(1, this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    const delay = Math.min(initialDelay * 2 ** (attempts - 1), Math.max(initialDelay, MAX_RETRY_DELAY_MS));
    this.bindFailures.set(endpoint.id, { endpoint, attempts, retryAtMs: Date.now() + delay });
  }

  /** A timed retry re-enters the same serialized reconciliation and ownership checks. */
  private scheduleRetry(): void {
    this.cancelRetry();
    if (this.disposed || this.retryInFlight || this.bindFailures.size === 0) return;
    const nextRetry = Math.min(...[...this.bindFailures.values()].map((failure) => failure.retryAtMs));
    const remainingDelay = nextRetry - Date.now();
    const generation = this.ownershipGeneration;
    // An owner refresh can fail before any bind; do not spin on an overdue deadline.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryInFlight = true;
      void Promise.resolve().then(async () => {
        if (this.disposed || generation !== this.ownershipGeneration) return;
        if (this.options.onRetryDue !== undefined) {
          await this.options.onRetryDue();
        } else {
          await this.serialize(() => this.syncExclusive(this.desiredEndpoints.values(), generation));
        }
      }).catch(() => undefined).finally(() => {
        this.retryInFlight = false;
        this.scheduleRetry();
      });
    }, remainingDelay <= 0 ? DEFAULT_RETRY_DELAY_MS : remainingDelay);
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** Read failures during rotation keep existing TLS contexts alive until the next sync. */
  private readTlsIdentity(): BrowserNetworkProxyTlsIdentity | undefined {
    try {
      const credentials = this.options.tlsCredentials?.getCredentials();
      return credentials === undefined ? undefined : { credentials, fingerprint: fingerprintTlsCredentials(credentials) };
    } catch {
      return undefined;
    }
  }

  /** Opens one endpoint on the first available preferred public port. */
  private async open(
    endpoint: BrowserNetworkProxyEndpoint,
    tlsIdentity?: BrowserNetworkProxyTlsIdentity,
  ): Promise<ActiveBrowserNetworkProxyEndpoint> {
    if (this.disposed) {
      throw new Error("Browser proxy manager is disposed.");
    }
    const errors: Error[] = [];

    for (const listenPort of endpoint.listenPorts) {
      const activeEndpoint: ActiveBrowserNetworkProxyEndpoint = {
        ...endpoint,
        listenPort,
      };
      const metadata = buildEndpointMetadata(activeEndpoint);
      const httpAgent = new http.Agent({
        keepAlive: true,
        maxSockets: UPSTREAM_KEEP_ALIVE_MAX_SOCKETS,
        maxFreeSockets: UPSTREAM_KEEP_ALIVE_MAX_FREE_SOCKETS,
      });
      const httpsAgent = new https.Agent({
        keepAlive: true,
        maxSockets: UPSTREAM_KEEP_ALIVE_MAX_SOCKETS,
        maxFreeSockets: UPSTREAM_KEEP_ALIVE_MAX_FREE_SOCKETS,
        rejectUnauthorized: false,
      });
      const sockets = new Set<net.Socket>();
      let serverBuild: BrowserNetworkProxyServerBuild;
      let listener: BrowserNetworkProxyListener | undefined;
      try {
        serverBuild = this.createServer(
          (request, response) => {
            if (listener !== undefined) {
              void this.transport.forwardHttp(listener.endpoint, listener.metadata, listener.httpAgent, listener.httpsAgent, request, response);
            }
          },
          (request, socket, head) => {
            if (listener !== undefined) {
              void this.transport.forwardUpgrade(listener.endpoint, listener.metadata, request, socket as net.Socket, head, listener.sockets);
            }
          },
          (socket, head) => {
            if (listener !== undefined) {
              void this.transport.rawForward(listener.endpoint, socket, listener.sockets, head);
            }
          },
          (socket, signal, onGreeting) => {
            if (listener !== undefined) {
              void this.transport.probeServerGreeting(listener.endpoint, socket, listener.sockets, signal, onGreeting);
            }
          },
          tlsIdentity,
        );
      } catch (error) {
        httpAgent.destroy();
        httpsAgent.destroy();
        errors.push(error instanceof Error ? error : new Error(String(error)));
        continue;
      }

      const { server, tlsServer, tlsDispatch, installTls, tlsCredentialsFingerprint } = serverBuild;
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });

      try {
        await assertPortAvailable(endpoint.listenHost, listenPort);
        await listen(server, listenPort, endpoint.listenHost);
        listener = {
          endpoint: activeEndpoint,
          metadata,
          server,
          ...(tlsServer === undefined ? {} : { tlsServer }),
          tlsDispatch,
          installTls,
          httpAgent,
          httpsAgent,
          sockets,
          tlsCredentialsFingerprint,
        };
        this.listeners.set(endpoint.id, listener);
        return activeEndpoint;
      } catch (error) {
        httpAgent.destroy();
        httpsAgent.destroy();
        await closeServer(server).catch(() => undefined);
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    throw errors[0] ?? new Error(`Could not open browser proxy for ${endpoint.id}.`);
  }

  /**
   * Builds a protocol-sniffing listener. Each accepted connection is peeked and
   * demultiplexed by its first bytes:
   *   - a TLS ClientHello (record type 0x16) is terminated with the dev
   *     certificate and proxied as HTTP (Host rewriting, response rewriting);
   *   - a plaintext HTTP request line is proxied as HTTP the same way;
   *   - anything else is forwarded as raw TCP (databases, other wire protocols).
   * This removes the need to guess whether a port speaks HTTP(S) or raw TCP —
   * the heuristic that classified ports ahead of time broke for containerized
   * (Docker Compose) web services, serving them plain so browsers rejected the
   * HTTPS handshake with ERR_SSL_PROTOCOL_ERROR.
   */
  private createServer(
    handler: http.RequestListener,
    onUpgrade: (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => void,
    onRawConnection: (socket: net.Socket, head: Buffer) => void,
    onServerGreeting: (socket: net.Socket, signal: AbortSignal, onGreeting: (forward: () => void) => void) => void,
    tlsIdentity: BrowserNetworkProxyTlsIdentity | undefined,
  ): BrowserNetworkProxyServerBuild {
    const httpServer = http.createServer(handler);
    httpServer.on("upgrade", (request, socket, head) => onUpgrade(request, socket as net.Socket, head));

    const tlsDispatch: BrowserNetworkProxyTlsDispatch = {};
    const installTls = (credentials: BrowserNetworkProxyTlsCredentials): https.Server => {
      const tlsServer = https.createServer(credentials, handler);
      tlsServer.on("upgrade", (request, socket, head) => onUpgrade(request, socket as net.Socket, head));
      tlsDispatch.server = tlsServer;
      return tlsServer;
    };
    let tlsServer: https.Server | undefined;
    let tlsCredentialsFingerprint: string | undefined;
    if (tlsIdentity !== undefined) {
      tlsServer = installTls(tlsIdentity.credentials);
      tlsCredentialsFingerprint = tlsIdentity.fingerprint;
    }

    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sniffBrowserProxyConnection(
        socket,
        () => httpServer.emit("connection", socket),
        () => tlsDispatch.server?.emit("connection", socket),
        (head) => onRawConnection(socket, head),
        () => tlsDispatch.server !== undefined,
        this.options.sniffTimeoutMs,
        (signal, onGreeting) => onServerGreeting(socket, signal, onGreeting),
        this.options.serverGreetingDelayMs,
      );
      socket.once("error", () => socket.destroy());
    });

    // httpServer/tlsServer are never listened on; they are fed sockets by the
    // sniffer and kept alive by its connection-listener closure.
    return {
      server,
      tlsDispatch,
      installTls,
      ...(tlsServer === undefined ? {} : { tlsServer }),
      ...(tlsCredentialsFingerprint === undefined ? {} : { tlsCredentialsFingerprint }),
    };
  }

  /** Updates aliases and certificates without taking down established sockets. */
  private reconcileListener(
    listener: BrowserNetworkProxyListener,
    desiredEndpoint: BrowserNetworkProxyEndpoint,
    tlsIdentity: BrowserNetworkProxyTlsIdentity | undefined,
  ): void {
    const credentials = tlsIdentity?.credentials;
    const needsTls = (desiredEndpoint.publicProtocol ?? "http") === "https";
    if (needsTls && credentials === undefined) {
      /*
       * Certificate renewal writes multiple files. Keep the old listener alive
       * during transient read gaps and rotate on the next successful read. The
       * sniffing listener still forwards raw TCP without credentials.
       */
      return;
    }
    try {
      if (tlsIdentity !== undefined) {
        const { credentials, fingerprint } = tlsIdentity;
        if (listener.tlsServer === undefined) {
          // Install before publishing HTTPS metadata so a failed certificate
          // parse cannot turn a working HTTP endpoint into unusable HTTPS.
          listener.tlsServer = listener.installTls(credentials);
          listener.tlsCredentialsFingerprint = fingerprint;
        } else if (fingerprint !== listener.tlsCredentialsFingerprint) {
          listener.tlsServer.setSecureContext(credentials);
          listener.tlsCredentialsFingerprint = fingerprint;
        }
      }
    } catch {
      // Keep the previous TLS context and public origin during file rotation.
      return;
    }
    listener.endpoint = { ...desiredEndpoint, listenPort: listener.endpoint.listenPort };
    listener.metadata = buildEndpointMetadata(listener.endpoint);
  }
}

export function browserNetworkProxyEndpointId(networkId: string, logicalPort: number): string {
  return `${networkId}:${logicalPort}`;
}

export function browserNetworkProxyFallbackPort(logicalPort: number): number {
  if (!isTcpPort(logicalPort)) {
    return 0;
  }

  const shiftedPort = logicalPort + 20_000;
  if (shiftedPort <= 65_535) {
    return shiftedPort;
  }

  return 10_000 + (logicalPort - 45_536);
}

export function formatBrowserNetworkProxyUrl(endpoint: ActiveBrowserNetworkProxyEndpoint): string {
  return `${buildEndpointMetadata(endpoint).publicOrigin}/`;
}

function normalizeEndpoint(endpoint: BrowserNetworkProxyEndpoint): BrowserNetworkProxyEndpoint {
  const listenPorts = [...new Set(endpoint.listenPorts.filter(isTcpPort))];
  return {
    ...endpoint,
    publicProtocol: endpoint.publicProtocol ?? "http",
    listenPorts,
  };
}

/** A fresh bind coordinate must never inherit an unrelated port's failure deadline. */
function sameBindCandidates(left: BrowserNetworkProxyEndpoint, right: BrowserNetworkProxyEndpoint): boolean {
  return left.networkId === right.networkId && left.logicalPort === right.logicalPort &&
    left.listenHost === right.listenHost && left.listenPorts.join(",") === right.listenPorts.join(",");
}

/** Distinct concrete IPv4 aliases are independent; wildcard/hostname/IPv6 overlap stays conservative. */
function shareBindCandidate(left: BrowserNetworkProxyEndpoint, right: BrowserNetworkProxyEndpoint): boolean {
  if (!left.listenPorts.some((port) => right.listenPorts.includes(port))) return false;
  return left.listenHost === right.listenHost || left.listenHost === "0.0.0.0" || right.listenHost === "0.0.0.0" ||
    net.isIP(left.listenHost) !== 4 || net.isIP(right.listenHost) !== 4;
}

function isEndpointBindCurrent(
  activeEndpoint: ActiveBrowserNetworkProxyEndpoint,
  desiredEndpoint: BrowserNetworkProxyEndpoint,
): boolean {
  /*
   * The outer listener coordinate is immutable. Alias and rewrite metadata is
   * read at request time, so its refresh must not close live HTTP or TCP flows.
   */
  return (
    activeEndpoint.networkId === desiredEndpoint.networkId &&
    activeEndpoint.logicalPort === desiredEndpoint.logicalPort &&
    activeEndpoint.listenHost === desiredEndpoint.listenHost &&
    desiredEndpoint.listenPorts.includes(activeEndpoint.listenPort)
  );
}

function listen(server: BrowserNetworkProxyServer, port: number, host: string): Promise<void> {
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

/** Detects an already-owned listener even on runtimes that permit a shared bind. */
function assertPortAvailable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection({ host, port });
    // An absent alias or stale packet-filter rule can silently drop SYNs.
    // Fail this candidate promptly; a timeout never proves a bind is free.
    probe.setTimeout(PORT_AVAILABILITY_TIMEOUT_MS, () => {
      probe.destroy();
      reject(new Error(`Browser proxy port check timed out: ${host}:${port}`));
    });
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error(`Browser proxy bind is already occupied: ${host}:${port}`));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH") {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function closeServer(server: BrowserNetworkProxyServer): Promise<void> {
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

function isTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function fingerprintTlsCredentials(credentials: BrowserNetworkProxyTlsCredentials): string {
  const hash = createHash("sha256");
  hash.update("key\0");
  hash.update(credentials.key);
  hash.update("\0cert\0");
  hash.update(credentials.cert);
  return hash.digest("hex");
}

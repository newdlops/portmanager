import { createHash } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";

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
  /** Backoff after a failed bind, keeping background sync from retrying hot loops. */
  readonly retryDelayMs?: number;
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
   * Returns the active TLS identity. The manager calls this when opening a
   * listener so certificate refreshes are picked up on the next reconciliation.
   */
  getCredentials(): BrowserNetworkProxyTlsCredentials | undefined;
}

interface BrowserNetworkProxyListener {
  /** Active endpoint including the concrete listen port. */
  readonly endpoint: ActiveBrowserNetworkProxyEndpoint;
  /** Precomputed host/origin strings reused by every request on this endpoint. */
  readonly metadata: BrowserNetworkProxyEndpointMetadata;
  /** TLS-sniffing listener that owns the browser-facing socket. */
  readonly server: BrowserNetworkProxyServer;
  /** Inner HTTPS terminator for connections sniffed as TLS; absent without credentials. */
  readonly tlsServer?: https.Server;
  /** Upstream HTTP connection pool scoped to this browser-facing endpoint. */
  readonly httpAgent: http.Agent;
  /** Upstream HTTPS connection pool scoped to this browser-facing endpoint. */
  readonly httpsAgent: https.Agent;
  /** Client and upstream sockets closed together during reconciliation. */
  readonly sockets: Set<net.Socket>;
  /** Fingerprint of the TLS identity loaded when this HTTPS listener opened. */
  readonly tlsCredentialsFingerprint?: string;
}

type BrowserNetworkProxyServer = net.Server;

/** First byte of a TLS record for a handshake (ContentType handshake = 22). */
const TLS_HANDSHAKE_RECORD_TYPE = 0x16;

/** HTTP request-line method prefixes used to sniff plaintext HTTP from raw TCP. */
const HTTP_REQUEST_METHOD_PREFIXES = [
  "GET ",
  "HEAD ",
  "POST ",
  "PUT ",
  "DELETE ",
  "OPTIONS ",
  "PATCH ",
  "CONNECT ",
  "TRACE ",
];

/** True when a peeked chunk begins with an HTTP request line (method + space). */
function looksLikeHttpRequestLine(chunk: Buffer): boolean {
  const prefix = chunk.subarray(0, 8).toString("latin1");
  return HTTP_REQUEST_METHOD_PREFIXES.some((method) => prefix.startsWith(method));
}

interface BrowserNetworkProxyServerBuild {
  /** Outer listener that sniffs each connection and demultiplexes TLS from raw TCP. */
  readonly server: net.Server;
  /** Inner HTTPS terminator, fed sniffed TLS connections; absent without credentials. */
  readonly tlsServer?: https.Server;
  readonly tlsCredentialsFingerprint?: string;
}

interface BrowserNetworkProxyEndpointMetadata {
  /** Browser-facing origin used in response rewrites. */
  readonly publicOrigin: string;
  /** Browser-facing protocol selected for HTTP URL rewrites. */
  readonly publicProtocol: "http" | "https";
  /** Browser-facing hostname formatted for URLs. */
  readonly publicHost: string;
  /** Concrete browser-facing port. The current logical port may use a fallback. */
  readonly publicPort: number;
  /** Current logical port whose localhost origin maps to publicPort. */
  readonly logicalPort: number;
  /** Localhost origin presented to development servers. */
  readonly upstreamOrigin: string;
  /** Host header value sent to development servers. */
  readonly upstreamHostHeader: string;
  /** Localhost variants that may appear in redirect/CORS headers. */
  readonly upstreamOrigins: readonly string[];
  /**
   * Network-specific loopback address the hooked dev server actually binds to
   * (e.g. 127.96.x). Apps that build self-URLs from their bound socket address
   * (Vite's HMR/"Network:" URL, `server.address()`) emit this IP, which the
   * localhost-only rewrite patterns miss — so it is rewritten to the public
   * alias too. Undefined when it is just a localhost variant already covered.
   */
  readonly upstreamLoopbackHost?: string;
}

const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_RETIRE_DELAY_MS = 30_000;
const LOCALHOST_UPSTREAM_HOST = "localhost";
const UPSTREAM_KEEP_ALIVE_MAX_SOCKETS = 64;
const UPSTREAM_KEEP_ALIVE_MAX_FREE_SOCKETS = 16;
const RESPONSE_ORIGIN_REWRITE_HEADER_NAMES = new Set([
  "location",
  "content-location",
  "refresh",
  "access-control-allow-origin",
  "link",
  "content-security-policy",
  "content-security-policy-report-only",
]);
const ABSOLUTE_LOCALHOST_ORIGIN_PATTERN =
  /\b(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?=\/|[?#"'`\s<);]|$)/gi;
const PROTOCOL_RELATIVE_LOCALHOST_ORIGIN_PATTERN =
  /(^|[^:])\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?=\/|[?#"'`\s<);]|$)/gi;

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

  /** Failed endpoint retries are throttled so missing macOS lo0 aliases stay cheap. */
  private readonly retryAfterById = new Map<string, number>();

  /** Delayed closes for endpoints that vanished during a transient routing refresh. */
  private readonly retireTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly targetResolver: BrowserNetworkProxyTargetResolver,
    private readonly options: BrowserNetworkProxyOptions = {},
  ) {}

  /** Reconciles active browser proxies with the latest running web processes. */
  async sync(endpoints: Iterable<BrowserNetworkProxyEndpoint>): Promise<void> {
    const desired = new Map<string, BrowserNetworkProxyEndpoint>();
    for (const endpoint of endpoints) {
      if (isTcpPort(endpoint.logicalPort) && endpoint.listenPorts.some(isTcpPort)) {
        desired.set(endpoint.id, normalizeEndpoint(endpoint));
      }
    }

    for (const [id, listener] of [...this.listeners]) {
      const endpoint = desired.get(id);
      if (endpoint === undefined) {
        this.scheduleRetire(id);
        continue;
      }

      this.cancelRetire(id);
      if (!isEndpointCurrent(listener.endpoint, endpoint) || !this.isTlsCredentialsCurrent(listener, endpoint)) {
        await this.close(id);
      }
    }

    for (const endpoint of desired.values()) {
      this.cancelRetire(endpoint.id);
      if (this.listeners.has(endpoint.id)) {
        continue;
      }

      const retryAfter = this.retryAfterById.get(endpoint.id) ?? 0;
      if (Date.now() < retryAfter) {
        continue;
      }

      await this.open(endpoint).catch(() => {
        this.retryAfterById.set(endpoint.id, Date.now() + (this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
      });
    }
  }

  /** Opens or returns one endpoint immediately, ignoring background retry backoff. */
  async ensure(endpoint: BrowserNetworkProxyEndpoint): Promise<ActiveBrowserNetworkProxyEndpoint | undefined> {
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    const listener = this.listeners.get(normalizedEndpoint.id);
    if (
      listener !== undefined &&
      isEndpointCurrent(listener.endpoint, normalizedEndpoint) &&
      this.isTlsCredentialsCurrent(listener, normalizedEndpoint)
    ) {
      this.cancelRetire(normalizedEndpoint.id);
      return listener.endpoint;
    }

    this.retryAfterById.delete(normalizedEndpoint.id);
    await this.close(normalizedEndpoint.id);

    try {
      return await this.open(normalizedEndpoint);
    } catch {
      this.retryAfterById.set(
        normalizedEndpoint.id,
        Date.now() + (this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS),
      );
      return undefined;
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
    this.retryAfterById.clear();
  }

  /** Closes one browser proxy endpoint. */
  async close(endpointId: string): Promise<void> {
    this.cancelRetire(endpointId);
    const listener = this.listeners.get(endpointId);
    if (listener === undefined) {
      return;
    }

    this.listeners.delete(endpointId);
    this.retryAfterById.delete(endpointId);

    for (const socket of listener.sockets) {
      socket.destroy();
    }
    listener.sockets.clear();
    listener.httpAgent.destroy();
    listener.httpsAgent.destroy();

    await closeServer(listener.server);
  }

  /** Closes every browser proxy endpoint during extension shutdown. */
  async dispose(): Promise<void> {
    const ids = [...this.listeners.keys()];
    for (const id of [...this.retireTimers.keys()]) {
      this.cancelRetire(id);
    }
    await Promise.all(ids.map((id) => this.close(id)));
    this.retryAfterById.clear();
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

  /** Opens one endpoint on the first available preferred public port. */
  private async open(endpoint: BrowserNetworkProxyEndpoint): Promise<ActiveBrowserNetworkProxyEndpoint> {
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
      try {
        serverBuild = this.createServer(
          activeEndpoint,
          (request, response) => {
            void this.forwardHttp(activeEndpoint, metadata, httpAgent, httpsAgent, request, response);
          },
          (request, socket, head) => {
            void this.forwardUpgrade(activeEndpoint, metadata, request, socket as net.Socket, head, sockets);
          },
          (socket) => {
            void this.rawForward(activeEndpoint, socket, sockets);
          },
        );
      } catch (error) {
        httpAgent.destroy();
        httpsAgent.destroy();
        errors.push(error instanceof Error ? error : new Error(String(error)));
        continue;
      }

      const { server, tlsServer, tlsCredentialsFingerprint } = serverBuild;
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });

      try {
        await listen(server, listenPort, endpoint.listenHost);
        this.listeners.set(endpoint.id, {
          endpoint: activeEndpoint,
          metadata,
          server,
          ...(tlsServer === undefined ? {} : { tlsServer }),
          httpAgent,
          httpsAgent,
          sockets,
          tlsCredentialsFingerprint,
        });
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

  /** Proxies one HTTP request while presenting localhost metadata upstream. */
  private async forwardHttp(
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    metadata: BrowserNetworkProxyEndpointMetadata,
    httpAgent: http.Agent,
    httpsAgent: https.Agent,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    let target: BrowserNetworkProxyTarget;

    try {
      target = await this.targetResolver.resolve(endpoint);
    } catch {
      writeGatewayError(response);
      return;
    }

    const upstreamProtocol = normalizeTargetProtocol(target.protocol);
    const upstreamMetadata = buildUpstreamMetadata(endpoint, metadata, upstreamProtocol);
    const requestOptions = {
      host: normalizeTargetHost(target.host),
      port: target.port,
      method: request.method,
      path: request.url ?? "/",
      headers: rewriteRequestHeaders(request.headers, upstreamMetadata),
    };
    const responseHandler = (upstreamResponse: http.IncomingMessage) => {
      forwardUpstreamResponse(request, upstreamResponse, response, upstreamMetadata);
    };
    const upstreamRequest =
      upstreamProtocol === "https"
        ? https.request({ ...requestOptions, agent: httpsAgent, rejectUnauthorized: false }, responseHandler)
        : http.request({ ...requestOptions, agent: httpAgent }, responseHandler);

    upstreamRequest.once("error", () => writeGatewayError(response));
    request.pipe(upstreamRequest);
  }

  /** Proxies a WebSocket upgrade after rewriting the handshake headers. */
  private async forwardUpgrade(
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    metadata: BrowserNetworkProxyEndpointMetadata,
    request: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    sockets: Set<net.Socket>,
  ): Promise<void> {
    let target: BrowserNetworkProxyTarget;

    try {
      target = await this.targetResolver.resolve(endpoint);
    } catch {
      socket.destroy();
      return;
    }

    const targetHost = normalizeTargetHost(target.host);
    const upstreamProtocol = normalizeTargetProtocol(target.protocol);
    const upstreamMetadata = buildUpstreamMetadata(endpoint, metadata, upstreamProtocol);
    const upstreamReadyEvent = upstreamProtocol === "https" ? "secureConnect" : "connect";
    const upstream =
      upstreamProtocol === "https"
        ? tls.connect({
            host: targetHost,
            port: target.port,
            rejectUnauthorized: false,
            ...(net.isIP(targetHost) === 0 ? { servername: targetHost } : {}),
          })
        : net.createConnection({
            host: targetHost,
            port: target.port,
          });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));

    const destroyBoth = () => {
      socket.destroy();
      upstream.destroy();
    };

    socket.once("error", destroyBoth);
    upstream.once("error", destroyBoth);
    socket.once("close", () => upstream.destroy());
    upstream.once(upstreamReadyEvent, () => {
      upstream.write(buildUpgradeRequest(request, upstreamMetadata));
      if (head.length > 0) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  }

  /**
   * Forwards a non-TLS connection to the upstream as raw TCP. This carries any
   * protocol transparently (plain HTTP, WebSocket, database wire protocols), so
   * a single per-port listener serves both HTTPS browsers and raw TCP clients
   * without classifying the port ahead of time.
   */
  private async rawForward(
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    clientSocket: net.Socket,
    sockets: Set<net.Socket>,
  ): Promise<void> {
    let target: BrowserNetworkProxyTarget;

    try {
      target = await this.targetResolver.resolve(endpoint);
    } catch {
      clientSocket.destroy();
      return;
    }

    const upstream = net.createConnection({ host: normalizeTargetHost(target.host), port: target.port });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));

    const destroyBoth = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    clientSocket.once("error", destroyBoth);
    upstream.once("error", destroyBoth);
    clientSocket.once("close", () => upstream.destroy());
    upstream.once("close", () => clientSocket.destroy());
    upstream.once("connect", () => {
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
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
    endpoint: ActiveBrowserNetworkProxyEndpoint,
    handler: http.RequestListener,
    onUpgrade: (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => void,
    onRawConnection: (socket: net.Socket) => void,
  ): BrowserNetworkProxyServerBuild {
    const credentials = this.options.tlsCredentials?.getCredentials();
    const httpServer = http.createServer(handler);
    httpServer.on("upgrade", (request, socket, head) => onUpgrade(request, socket as net.Socket, head));

    let tlsServer: https.Server | undefined;
    let tlsCredentialsFingerprint: string | undefined;
    if (credentials !== undefined) {
      tlsServer = https.createServer(credentials, handler);
      tlsServer.on("upgrade", (request, socket, head) => onUpgrade(request, socket as net.Socket, head));
      tlsCredentialsFingerprint = fingerprintTlsCredentials(credentials);
    }

    const server = net.createServer((socket) => {
      socket.once("readable", () => {
        const chunk = socket.read() as Buffer | null;
        if (chunk === null || chunk.length === 0) {
          // Nothing to sniff; let the upstream decide what an empty stream means.
          onRawConnection(socket);
          return;
        }

        socket.unshift(chunk);
        if (chunk[0] === TLS_HANDSHAKE_RECORD_TYPE && tlsServer !== undefined) {
          tlsServer.emit("connection", socket);
        } else if (looksLikeHttpRequestLine(chunk)) {
          httpServer.emit("connection", socket);
        } else {
          onRawConnection(socket);
        }
      });
      socket.once("error", () => socket.destroy());
    });

    // httpServer/tlsServer are never listened on; they are fed sockets by the
    // sniffer and kept alive by its connection-listener closure.
    return {
      server,
      ...(tlsServer === undefined ? {} : { tlsServer }),
      ...(tlsCredentialsFingerprint === undefined ? {} : { tlsCredentialsFingerprint }),
    };
  }

  /**
   * Browser certificates are regenerated when DNS aliases change. Existing
   * HTTPS servers keep their SecureContext, so reconciliation must reopen them
   * once the certificate files contain a different identity.
   */
  private isTlsCredentialsCurrent(
    listener: BrowserNetworkProxyListener,
    _desiredEndpoint: BrowserNetworkProxyEndpoint,
  ): boolean {
    const credentials = this.options.tlsCredentials?.getCredentials();
    if (credentials === undefined) {
      /*
       * Certificate renewal writes multiple files. Keep the old listener alive
       * during transient read gaps and rotate on the next successful read. The
       * sniffing listener still forwards raw TCP without credentials.
       */
      return true;
    }

    // The sniffing listener terminates TLS whenever credentials exist, so a
    // listener opened before the identity changed (or before any cert existed)
    // must reopen to pick up the new certificate.
    return fingerprintTlsCredentials(credentials) === listener.tlsCredentialsFingerprint;
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

function isEndpointCurrent(
  activeEndpoint: ActiveBrowserNetworkProxyEndpoint,
  desiredEndpoint: BrowserNetworkProxyEndpoint,
): boolean {
  /*
   * Request handlers capture the active endpoint when the socket opens. Rebind
   * whenever DNS-facing metadata changes so browser aliases do not keep stale
   * hosts or loopback addresses after a network rename or DNS startup.
   */
  return (
    activeEndpoint.networkId === desiredEndpoint.networkId &&
    activeEndpoint.logicalPort === desiredEndpoint.logicalPort &&
    activeEndpoint.listenHost === desiredEndpoint.listenHost &&
    activeEndpoint.publicHost === desiredEndpoint.publicHost &&
    (activeEndpoint.publicProtocol ?? "http") === (desiredEndpoint.publicProtocol ?? "http") &&
    desiredEndpoint.listenPorts.includes(activeEndpoint.listenPort)
  );
}

function rewriteRequestHeaders(headers: http.IncomingHttpHeaders, metadata: BrowserNetworkProxyEndpointMetadata): http.OutgoingHttpHeaders {
  const nextHeaders: http.OutgoingHttpHeaders = {
    ...headers,
    host: metadata.upstreamHostHeader,
    "accept-encoding": "identity",
  };

  const origin = rewriteHeaderOrigin(headers.origin, metadata.publicOrigin, metadata.upstreamOrigin);
  const referer = rewriteHeaderOrigin(headers.referer, metadata.publicOrigin, metadata.upstreamOrigin);
  if (origin !== undefined) {
    nextHeaders.origin = origin;
  }
  if (referer !== undefined) {
    nextHeaders.referer = referer;
  }

  return nextHeaders;
}

function rewriteResponseHeaders(headers: http.IncomingHttpHeaders, metadata: BrowserNetworkProxyEndpointMetadata): http.OutgoingHttpHeaders {
  const nextHeaders: http.OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (normalizedName === "set-cookie") {
      nextHeaders[name] = rewriteSetCookieHeader(value);
      continue;
    }

    nextHeaders[name] =
      RESPONSE_ORIGIN_REWRITE_HEADER_NAMES.has(normalizedName) || headerValueIncludesAny(value, metadata.upstreamOrigins)
        ? rewriteResponseHeaderValue(value, metadata)
        : value;
  }

  return nextHeaders;
}

function forwardUpstreamResponse(
  request: http.IncomingMessage,
  upstreamResponse: http.IncomingMessage,
  response: http.ServerResponse,
  metadata: BrowserNetworkProxyEndpointMetadata,
): void {
  const shouldRewriteBody = shouldRewriteResponseBody(request, upstreamResponse);

  if (!shouldRewriteBody) {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      rewriteResponseHeaders(upstreamResponse.headers, metadata),
    );
    upstreamResponse.pipe(response);
    return;
  }

  const chunks: Buffer[] = [];
  upstreamResponse.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  upstreamResponse.once("error", () => writeGatewayError(response));
  upstreamResponse.once("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const rewrittenBody = rewriteLocalhostOrigins(body, metadata);
    const rewrittenBodyBuffer = Buffer.from(rewrittenBody, "utf8");
    const headers = rewriteResponseHeaders(upstreamResponse.headers, metadata);

    removeHeader(headers, "content-length");
    removeHeader(headers, "transfer-encoding");
    headers["content-length"] = rewrittenBodyBuffer.byteLength;

    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
    response.end(rewrittenBodyBuffer);
  });
}

function rewriteResponseHeaderValue(
  value: string | string[],
  metadata: BrowserNetworkProxyEndpointMetadata,
): string | string[] {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteResponseHeaderString(item, metadata));
  }

  return rewriteResponseHeaderString(value, metadata);
}

function rewriteResponseHeaderString(value: string, metadata: BrowserNetworkProxyEndpointMetadata): string {
  if (!shouldRewriteLocalhostOrigins(value, metadata)) {
    return value;
  }

  return rewriteLocalhostOrigins(value, metadata);
}

function rewriteSetCookieHeader(value: string | string[]): string | string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (setCookieHasDomainAttribute(item) ? rewriteSetCookie(item) : item));
  }

  return setCookieHasDomainAttribute(value) ? rewriteSetCookie(value) : value;
}

function rewriteSetCookie(value: string): string {
  return value
    .split(";")
    .filter((part) => !part.trim().toLowerCase().startsWith("domain="))
    .join(";");
}

function headerValueIncludesAny(value: string | string[], needles: readonly string[]): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => stringIncludesAny(item, needles));
  }

  return stringIncludesAny(value, needles);
}

function stringIncludesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function shouldRewriteLocalhostOrigins(value: string, metadata: BrowserNetworkProxyEndpointMetadata): boolean {
  return (
    metadata.upstreamOrigins.some((origin) => value.includes(origin)) ||
    (metadata.upstreamLoopbackHost !== undefined && value.includes(metadata.upstreamLoopbackHost)) ||
    regexMatches(ABSOLUTE_LOCALHOST_ORIGIN_PATTERN, value) ||
    regexMatches(PROTOCOL_RELATIVE_LOCALHOST_ORIGIN_PATTERN, value)
  );
}

function regexMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

function rewriteLocalhostOrigins(value: string, metadata: BrowserNetworkProxyEndpointMetadata): string {
  ABSOLUTE_LOCALHOST_ORIGIN_PATTERN.lastIndex = 0;
  PROTOCOL_RELATIVE_LOCALHOST_ORIGIN_PATTERN.lastIndex = 0;

  const absoluteRewritten = value.replace(
    ABSOLUTE_LOCALHOST_ORIGIN_PATTERN,
    (_match, protocol: string, _host: string, portText: string) =>
      `${publicProtocolForLocalhostRewrite(protocol, metadata)}://${metadata.publicHost}:${publicPortForLocalhostRewrite(portText, metadata)}`,
  );

  const protocolRewritten = absoluteRewritten.replace(
    PROTOCOL_RELATIVE_LOCALHOST_ORIGIN_PATTERN,
    (match, prefix: string, _host: string, portText: string) => {
      const separator = match.startsWith("//") ? "" : prefix;
      return `${separator}//${metadata.publicHost}:${publicPortForLocalhostRewrite(portText, metadata)}`;
    },
  );

  return rewriteUpstreamLoopbackOrigins(protocolRewritten, metadata);
}

/**
 * Rewrites the network loopback address the dev server binds to (127.96.x),
 * which the hard-coded localhost patterns do not cover. The hook rewrites the
 * server's bind to this address, so apps that self-reference their bound socket
 * (Vite HMR, `server.address()`) leak it into links; map it to the public alias.
 */
function rewriteUpstreamLoopbackOrigins(value: string, metadata: BrowserNetworkProxyEndpointMetadata): string {
  const host = metadata.upstreamLoopbackHost;
  if (host === undefined || !value.includes(host)) {
    return value;
  }

  const escaped = escapeRegExpLiteral(host);
  const boundary = `(?=/|[?#"'\`\\s<);]|$)`;
  const absolute = new RegExp(`\\b(https?|wss?):\\/\\/${escaped}:(\\d{1,5})${boundary}`, "gi");
  const protocolRelative = new RegExp(`(^|[^:])\\/\\/${escaped}:(\\d{1,5})${boundary}`, "gi");

  const absoluteRewritten = value.replace(
    absolute,
    (_match, protocol: string, portText: string) =>
      `${publicProtocolForLocalhostRewrite(protocol, metadata)}://${metadata.publicHost}:${publicPortForLocalhostRewrite(portText, metadata)}`,
  );

  return absoluteRewritten.replace(protocolRelative, (match, prefix: string, portText: string) => {
    const separator = match.startsWith("//") ? "" : prefix;
    return `${separator}//${metadata.publicHost}:${publicPortForLocalhostRewrite(portText, metadata)}`;
  });
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function publicProtocolForLocalhostRewrite(
  protocol: string,
  metadata: BrowserNetworkProxyEndpointMetadata,
): "http" | "https" | "ws" | "wss" {
  const normalizedProtocol = protocol.toLowerCase();
  if (normalizedProtocol === "ws" || normalizedProtocol === "wss") {
    return metadata.publicProtocol === "https" ? "wss" : "ws";
  }

  return metadata.publicProtocol;
}

function publicPortForLocalhostRewrite(portText: string, metadata: BrowserNetworkProxyEndpointMetadata): number {
  const port = Number(portText);
  return port === metadata.logicalPort ? metadata.publicPort : port;
}

function setCookieHasDomainAttribute(value: string): boolean {
  return value.toLowerCase().includes("domain=");
}

function rewriteHeaderOrigin(
  value: string | undefined,
  fromOrigin: string,
  toOrigin: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.replaceAll(fromOrigin, toOrigin);
}

function buildUpgradeRequest(request: http.IncomingMessage, metadata: BrowserNetworkProxyEndpointMetadata): string {
  const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`];
  const headers = rewriteRequestHeaders(request.headers, metadata);

  for (const [name, value] of Object.entries(headers)) {
    appendHeaderLines(lines, name, value);
  }

  return `${lines.join("\r\n")}\r\n\r\n`;
}

function appendHeaderLines(lines: string[], name: string, value: number | string | readonly string[] | undefined): void {
  if (value === undefined) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      lines.push(`${name}: ${item}`);
    }
    return;
  }

  lines.push(`${name}: ${value}`);
}

function buildEndpointMetadata(endpoint: ActiveBrowserNetworkProxyEndpoint): BrowserNetworkProxyEndpointMetadata {
  const publicProtocol = endpoint.publicProtocol ?? "http";
  const publicHost = formatHostForUrl(endpoint.publicHost ?? endpoint.listenHost);
  const publicOrigin = `${publicProtocol}://${publicHost}:${endpoint.listenPort}`;
  const upstreamHostHeader = `${LOCALHOST_UPSTREAM_HOST}:${endpoint.logicalPort}`;
  const upstreamOrigin = `http://${upstreamHostHeader}`;
  const upstreamLoopbackHost = normalizeUpstreamLoopbackHost(endpoint.listenHost);

  return {
    publicOrigin,
    publicProtocol,
    publicHost,
    publicPort: endpoint.listenPort,
    logicalPort: endpoint.logicalPort,
    upstreamOrigin,
    upstreamHostHeader,
    upstreamOrigins: buildUpstreamOrigins(endpoint.logicalPort, upstreamLoopbackHost),
    upstreamLoopbackHost,
  };
}

/**
 * Test seam: applies the response origin rewrite (headers/body share the same
 * logic) for one endpoint, so the localhost + network-loopback rewrites can be
 * verified without binding a real network loopback alias.
 */
export function rewriteBrowserProxyResponseTextForTest(
  text: string,
  endpoint: ActiveBrowserNetworkProxyEndpoint,
): string {
  return rewriteLocalhostOrigins(text, buildEndpointMetadata(endpoint));
}

/** Browser-facing TLS and upstream application TLS are independent routing decisions. */
function buildUpstreamMetadata(
  endpoint: ActiveBrowserNetworkProxyEndpoint,
  metadata: BrowserNetworkProxyEndpointMetadata,
  protocol: "http" | "https",
): BrowserNetworkProxyEndpointMetadata {
  return {
    ...metadata,
    upstreamOrigin: `${protocol}://${metadata.upstreamHostHeader}`,
    upstreamOrigins: buildUpstreamOrigins(endpoint.logicalPort, metadata.upstreamLoopbackHost),
  };
}

function buildUpstreamOrigins(logicalPort: number, loopbackHost?: string): readonly string[] {
  return ["http", "https"].flatMap((protocol) => {
    const origins = [
      `${protocol}://${LOCALHOST_UPSTREAM_HOST}:${logicalPort}`,
      `${protocol}://127.0.0.1:${logicalPort}`,
      `${protocol}://[::1]:${logicalPort}`,
    ];
    if (loopbackHost !== undefined) {
      origins.push(`${protocol}://${loopbackHost}:${logicalPort}`);
    }
    return origins;
  });
}

/**
 * The network loopback address the dev server binds to (127.96.x) when it is a
 * distinct address, not a plain localhost variant already handled by the
 * localhost rewrite patterns. Returned undefined for localhost/127.0.0.1/::1.
 */
function normalizeUpstreamLoopbackHost(listenHost: string | undefined): string | undefined {
  const host = (listenHost ?? "").trim();
  if (host === "" || host === LOCALHOST_UPSTREAM_HOST || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return undefined;
  }
  return host;
}

function normalizeTargetProtocol(protocol: BrowserNetworkProxyTarget["protocol"]): "http" | "https" {
  return protocol === "https" ? "https" : "http";
}

function normalizeTargetHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }

  if (host === "::") {
    return "::1";
  }

  return host;
}

function fingerprintTlsCredentials(credentials: BrowserNetworkProxyTlsCredentials): string {
  const hash = createHash("sha256");
  hash.update("key\0");
  hash.update(credentials.key);
  hash.update("\0cert\0");
  hash.update(credentials.cert);
  return hash.digest("hex");
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function writeGatewayError(response: http.ServerResponse): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }

  response.writeHead(502, "Bad Gateway");
  response.end("Port Manager browser proxy could not reach the routed target.");
}

function shouldRewriteResponseBody(
  request: http.IncomingMessage,
  upstreamResponse: http.IncomingMessage,
): boolean {
  if (!responseMayHaveBody(request, upstreamResponse)) {
    return false;
  }

  if (!isIdentityEncoded(upstreamResponse.headers["content-encoding"])) {
    return false;
  }

  return isRewritableContentType(upstreamResponse.headers["content-type"]);
}

function responseMayHaveBody(request: http.IncomingMessage, upstreamResponse: http.IncomingMessage): boolean {
  if (request.method?.toUpperCase() === "HEAD") {
    return false;
  }

  const statusCode = upstreamResponse.statusCode ?? 200;
  return statusCode !== 204 && statusCode !== 304 && (statusCode < 100 || statusCode >= 200);
}

function isIdentityEncoded(value: string | string[] | undefined): boolean {
  const encoding = Array.isArray(value) ? value.join(",") : value;
  return encoding === undefined || encoding.trim().length === 0 || /^identity$/i.test(encoding.trim());
}

function isRewritableContentType(value: string | string[] | undefined): boolean {
  const contentType = Array.isArray(value) ? value[0] : value;
  if (contentType === undefined) {
    return false;
  }

  const parts = contentType.split(";").map((part) => part.trim().toLowerCase());
  const mediaType = parts[0] ?? "";
  if (mediaType === "text/event-stream") {
    return false;
  }

  const charset = parts.find((part) => part.startsWith("charset="))?.slice("charset=".length).replace(/^"|"$/g, "");
  if (charset !== undefined && charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii") {
    return false;
  }

  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/javascript" ||
    mediaType === "application/x-javascript" ||
    mediaType === "application/ecmascript" ||
    mediaType === "application/json" ||
    mediaType === "application/manifest+json" ||
    mediaType === "application/xml" ||
    mediaType === "application/xhtml+xml" ||
    mediaType === "image/svg+xml" ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml")
  );
}

function removeHeader(headers: http.OutgoingHttpHeaders, name: string): void {
  const normalizedName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalizedName) {
      delete headers[key];
    }
  }
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

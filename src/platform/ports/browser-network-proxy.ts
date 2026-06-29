import * as http from "node:http";
import * as net from "node:net";

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
}

interface BrowserNetworkProxyListener {
  /** Active endpoint including the concrete listen port. */
  readonly endpoint: ActiveBrowserNetworkProxyEndpoint;
  /** Precomputed host/origin strings reused by every request on this endpoint. */
  readonly metadata: BrowserNetworkProxyEndpointMetadata;
  /** HTTP/WebSocket server that owns the browser-facing socket. */
  readonly server: http.Server;
  /** Upstream HTTP connection pool scoped to this browser-facing endpoint. */
  readonly agent: http.Agent;
  /** Client and upstream sockets closed together during reconciliation. */
  readonly sockets: Set<net.Socket>;
}

interface BrowserNetworkProxyEndpointMetadata {
  /** Browser-facing origin used in response rewrites. */
  readonly publicOrigin: string;
  /** Localhost origin presented to development servers. */
  readonly upstreamOrigin: string;
  /** Host header value sent to development servers. */
  readonly upstreamHostHeader: string;
  /** Localhost variants that may appear in redirect/CORS headers. */
  readonly upstreamOrigins: readonly string[];
}

const DEFAULT_RETRY_DELAY_MS = 30_000;
const LOCALHOST_UPSTREAM_HOST = "localhost";
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

  /** Failed endpoint retries are throttled so missing macOS lo0 aliases stay cheap. */
  private readonly retryAfterById = new Map<string, number>();

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
      if (endpoint === undefined || !isEndpointCurrent(listener.endpoint, endpoint)) {
        await this.close(id);
      }
    }

    for (const endpoint of desired.values()) {
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
    if (listener !== undefined && isEndpointCurrent(listener.endpoint, normalizedEndpoint)) {
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

  /** Closes one browser proxy endpoint. */
  async close(endpointId: string): Promise<void> {
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
    listener.agent.destroy();

    await closeServer(listener.server);
  }

  /** Closes every browser proxy endpoint during extension shutdown. */
  async dispose(): Promise<void> {
    const ids = [...this.listeners.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
    this.retryAfterById.clear();
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
      const agent = new http.Agent({
        keepAlive: true,
        maxSockets: UPSTREAM_KEEP_ALIVE_MAX_SOCKETS,
        maxFreeSockets: UPSTREAM_KEEP_ALIVE_MAX_FREE_SOCKETS,
      });
      const sockets = new Set<net.Socket>();
      const server = http.createServer((request, response) => {
        void this.forwardHttp(activeEndpoint, metadata, agent, request, response);
      });

      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (request, socket, head) => {
        void this.forwardUpgrade(activeEndpoint, metadata, request, socket as net.Socket, head, sockets);
      });

      try {
        await listen(server, listenPort, endpoint.listenHost);
        this.listeners.set(endpoint.id, { endpoint: activeEndpoint, metadata, server, agent, sockets });
        return activeEndpoint;
      } catch (error) {
        agent.destroy();
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
    agent: http.Agent,
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

    const upstreamRequest = http.request(
      {
        host: normalizeTargetHost(target.host),
        port: target.port,
        agent,
        method: request.method,
        path: request.url ?? "/",
        headers: rewriteRequestHeaders(request.headers, metadata),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          rewriteResponseHeaders(upstreamResponse.headers, metadata),
        );
        upstreamResponse.pipe(response);
      },
    );

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

    const upstream = net.createConnection({
      host: normalizeTargetHost(target.host),
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
    upstream.once("connect", () => {
      upstream.write(buildUpgradeRequest(request, metadata));
      if (head.length > 0) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
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
    desiredEndpoint.listenPorts.includes(activeEndpoint.listenPort)
  );
}

function rewriteRequestHeaders(headers: http.IncomingHttpHeaders, metadata: BrowserNetworkProxyEndpointMetadata): http.OutgoingHttpHeaders {
  const nextHeaders: http.OutgoingHttpHeaders = {
    ...headers,
    host: metadata.upstreamHostHeader,
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

    if (name.toLowerCase() === "set-cookie") {
      nextHeaders[name] = rewriteSetCookieHeader(value);
      continue;
    }

    nextHeaders[name] = rewriteResponseHeaderValue(value, metadata);
  }

  return nextHeaders;
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
  if (!metadata.upstreamOrigins.some((origin) => value.includes(origin))) {
    return value;
  }

  let rewritten = value;
  for (const origin of metadata.upstreamOrigins) {
    rewritten = rewritten.replaceAll(origin, metadata.publicOrigin);
  }

  return rewritten;
}

function rewriteSetCookieHeader(value: string | string[]): string | string[] {
  if (Array.isArray(value)) {
    return value.map(rewriteSetCookie);
  }

  return rewriteSetCookie(value);
}

function rewriteSetCookie(value: string): string {
  return value
    .split(";")
    .filter((part) => !part.trim().toLowerCase().startsWith("domain="))
    .join(";");
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
  const publicOrigin = `http://${formatHostForUrl(endpoint.publicHost ?? endpoint.listenHost)}:${endpoint.listenPort}`;
  const upstreamHostHeader = `${LOCALHOST_UPSTREAM_HOST}:${endpoint.logicalPort}`;
  const upstreamOrigin = `http://${upstreamHostHeader}`;

  return {
    publicOrigin,
    upstreamOrigin,
    upstreamHostHeader,
    upstreamOrigins: [
      upstreamOrigin,
      `http://127.0.0.1:${endpoint.logicalPort}`,
      `http://[::1]:${endpoint.logicalPort}`,
    ],
  };
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

function listen(server: http.Server, port: number, host: string): Promise<void> {
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

function closeServer(server: http.Server): Promise<void> {
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

import * as http from "node:http";
import { Transform, pipeline, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ActiveBrowserNetworkProxyEndpoint } from "./browser-network-proxy";

/** HTTP origin translation is independent of listener binding and TLS lifecycle. */
export interface BrowserNetworkProxyEndpointMetadata {
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

const LOCALHOST_UPSTREAM_HOST = "localhost";
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
  /\b(https?|wss?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?=\/|[?#"'`\s<);]|$)/gi;
const PROTOCOL_RELATIVE_LOCALHOST_ORIGIN_PATTERN =
  /(^|[^:])\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?=\/|[?#"'`\s<);]|$)/gi;

export function rewriteRequestHeaders(headers: http.IncomingHttpHeaders, metadata: BrowserNetworkProxyEndpointMetadata): http.OutgoingHttpHeaders {
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

export function forwardUpstreamResponse(
  request: http.IncomingMessage,
  upstreamResponse: http.IncomingMessage,
  response: http.ServerResponse,
  metadata: BrowserNetworkProxyEndpointMetadata,
): void {
  const rewrite = shouldRewriteResponseBody(request, upstreamResponse);
  const headers = rewriteResponseHeaders(upstreamResponse.headers, metadata);
  if (rewrite) {
    removeHeader(headers, "content-length");
    removeHeader(headers, "transfer-encoding");
  }
  response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
  // pipeline propagates backpressure, source errors and browser cancellation
  // through the whole response. Headers have been committed; body failures
  // close the response rather than attempting a second status/header block.
  if (rewrite) pipeline(upstreamResponse, new BrowserProxyResponseTransform(metadata), response, () => {});
  else pipeline(upstreamResponse, response, () => {});
}

/**
 * Holds only an unfinished origin and UTF-8 code point between chunks. The raw
 * preceding character preserves regex word/colon boundaries across writes;
 * looking at the next character prevents a cut from inventing end-of-body.
 */
export class BrowserProxyResponseTransform extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private readonly passes: readonly OriginRewritePass[];

  constructor(metadata: BrowserNetworkProxyEndpointMetadata) {
    super();
    const local = ["localhost", "127.0.0.1", "[::1]"];
    this.passes = [
      new OriginRewritePass(local, false, metadata),
      new OriginRewritePass(local, true, metadata),
      ...(metadata.upstreamLoopbackHost === undefined ? [] : [
        new OriginRewritePass([metadata.upstreamLoopbackHost], false, metadata),
        new OriginRewritePass([metadata.upstreamLoopbackHost], true, metadata),
      ]),
    ];
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try { this.push(this.translate(this.decoder.write(chunk), false)); callback(); }
    catch (error) { callback(error as Error); }
  }

  override _flush(callback: TransformCallback): void {
    try { this.push(this.translate(this.decoder.end(), true)); callback(); }
    catch (error) { callback(error as Error); }
  }

  /** Each bounded pass sees exactly the output of its preceding rewrite rule. */
  private translate(text: string, final: boolean): string {
    for (const pass of this.passes) text = pass.write(text, final);
    return text;
  }
}

/** Preserves one global regex pass, including its consumed-prefix boundary. */
class OriginRewritePass {
  private pending = "";
  private previousCharacter = "";
  private previousConsumed = false;
  private readonly prefixes: readonly string[];
  private readonly maxOriginLength: number;
  private readonly pattern: RegExp;

  constructor(hosts: readonly string[], private readonly relative: boolean, private readonly metadata: BrowserNetworkProxyEndpointMetadata) {
    this.prefixes = hosts.flatMap((host) => (relative ? ["//"] : ["http://", "https://", "ws://", "wss://"])
      .map((prefix) => `${prefix}${host}`.toLowerCase()));
    this.maxOriginLength = Math.max(...this.prefixes.map((prefix) => prefix.length)) + 6;
    const authority = `(?:${hosts.map(escapeRegExpLiteral).join("|")})(?::(\\d{1,5}))?`;
    const boundary = "(?=/|[?#\"'`\\s<);]|$)";
    this.pattern = new RegExp((relative ? "(^|[^:])//" : "\\b(https?|wss?)://") + authority + boundary, "gi");
  }

  write(text: string, final: boolean): string {
    this.pending += text;
    const cut = final ? this.pending.length : this.findUnfinishedOrigin();
    if (cut === 0 && !final) return "";
    const complete = this.pending.slice(0, cut);
    const next = this.pending[cut];
    const sentinel = final ? "" : next !== undefined && /[/?#"'\`\s<);]/.test(next) ? next : "X";
    const input = this.previousCharacter + complete + sentinel;
    // Protocol-relative regexes consume their preceding character. Reusing a
    // character consumed by the previous chunk would allow overlapping matches.
    this.pattern.lastIndex = this.relative && this.previousConsumed ? this.previousCharacter.length : 0;
    let cursor = 0;
    let lastMatchEnd = -1;
    let result = "";
    let match: RegExpExecArray | null;
    while ((match = this.pattern.exec(input)) !== null) {
      const prefix = this.relative ? match[1]! : "";
      const scheme = this.relative ? "" : publicProtocolForLocalhostRewrite(match[1]!, this.metadata) + ":";
      result += input.slice(cursor, match.index) + prefix + scheme +
        `//${this.metadata.publicHost}:${publicPortForLocalhostRewrite(match[2], this.metadata)}`;
      cursor = this.pattern.lastIndex;
      lastMatchEnd = cursor;
    }
    result += input.slice(cursor);
    const output = result.slice(this.previousCharacter.length, sentinel ? -1 : undefined);
    if (complete.length > 0) {
      this.previousConsumed = lastMatchEnd === this.previousCharacter.length + complete.length;
      const last = complete.charCodeAt(complete.length - 1);
      this.previousCharacter = complete.slice(last >= 0xdc00 && last <= 0xdfff ? -2 : -1);
    }
    this.pending = this.pending.slice(cut);
    return output;
  }

  /** Authorities have at most five port digits; suffix storage never grows with the response. */
  private findUnfinishedOrigin(): number {
    const start = Math.max(0, this.pending.length - this.maxOriginLength);
    const suffix = this.pending.slice(start).toLowerCase();
    for (let index = 0; index < suffix.length; index++) {
      if (!"hw/".includes(suffix[index]!)) continue;
      const candidate = suffix.slice(index);
      if (this.prefixes.some((prefix) => prefix.startsWith(candidate) ||
        (candidate.startsWith(prefix) && /^:\d{0,5}$/.test(candidate.slice(prefix.length))))) return start + index;
    }
    return this.pending.length;
  }
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
    (_match, protocol: string, _host: string, portText: string | undefined) =>
      `${publicProtocolForLocalhostRewrite(protocol, metadata)}://${metadata.publicHost}:${publicPortForLocalhostRewrite(portText, metadata)}`,
  );

  const protocolRewritten = absoluteRewritten.replace(
    PROTOCOL_RELATIVE_LOCALHOST_ORIGIN_PATTERN,
    (match, prefix: string, _host: string, portText: string | undefined) => {
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
  const absolute = new RegExp(`\\b(https?|wss?):\\/\\/${escaped}(?::(\\d{1,5}))?${boundary}`, "gi");
  const protocolRelative = new RegExp(`(^|[^:])\\/\\/${escaped}(?::(\\d{1,5}))?${boundary}`, "gi");

  const absoluteRewritten = value.replace(
    absolute,
    (_match, protocol: string, portText: string | undefined) =>
      `${publicProtocolForLocalhostRewrite(protocol, metadata)}://${metadata.publicHost}:${publicPortForLocalhostRewrite(portText, metadata)}`,
  );

  return absoluteRewritten.replace(protocolRelative, (match, prefix: string, portText: string | undefined) => {
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

function publicPortForLocalhostRewrite(portText: string | undefined, metadata: BrowserNetworkProxyEndpointMetadata): number {
  if (portText === undefined) {
    return metadata.publicPort;
  }
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

export function buildUpgradeRequest(request: http.IncomingMessage, metadata: BrowserNetworkProxyEndpointMetadata): string {
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

export function buildEndpointMetadata(endpoint: ActiveBrowserNetworkProxyEndpoint): BrowserNetworkProxyEndpointMetadata {
  const publicProtocol = endpoint.publicProtocol ?? "http";
  const publicHost = formatHostForUrl(endpoint.publicHost ?? endpoint.listenHost);
  const publicOrigin = `${publicProtocol}://${publicHost}:${endpoint.listenPort}`;
  const upstreamHostHeader = `${LOCALHOST_UPSTREAM_HOST}:${endpoint.logicalPort}`;
  const upstreamOrigin = `http://${upstreamHostHeader}`;
  const upstreamLoopbackHost = normalizeUpstreamLoopbackHost(endpoint.responseRewriteLoopbackHost);

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
export function buildUpstreamMetadata(
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
function normalizeUpstreamLoopbackHost(responseRewriteLoopbackHost: string | undefined): string | undefined {
  const host = (responseRewriteLoopbackHost ?? "").trim();
  if (host === "" || host === LOCALHOST_UPSTREAM_HOST || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return undefined;
  }
  return host;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** A timeout can be followed by a socket error; never interrupt an error response already ending. */
export function writeGatewayError(response: http.ServerResponse, status: 502 | 503 | 504 = 502): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }

  response.writeHead(status, status === 504 ? "Gateway Timeout" : status === 503 ? "Service Unavailable" : "Bad Gateway");
  response.end(status === 504
    ? "Port Manager browser proxy timed out preparing the routed connection."
    : status === 503 ? "Port Manager browser proxy is busy. Try again shortly."
    : "Port Manager browser proxy could not reach the routed target.");
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

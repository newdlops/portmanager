import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared route-table path helpers.
 *
 * The daemon keeps routing state in memory and flushes sharded JSON files as a
 * fallback channel. Managed children receive these paths through environment
 * variables, and native socket hooks use them only when daemon memory/RPC cannot
 * answer a route immediately.
 */

let routeTableStorageDirectory: string | undefined;

/** Environment key shared with native readers and daemon processes. */
export const ROUTE_TABLE_TTL_SECONDS_ENV = "PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS";

/** Route files expire if the extension/daemon no longer refreshes generated state. */
export const ROUTE_TABLE_TTL_MS = 15_000;

/** Lowest supported TTL; shorter values create more agent round-trips than useful isolation. */
export const MIN_ROUTE_TABLE_TTL_MS = 5_000;

/** Highest supported TTL; stale route files should never outlive an ordinary dev-session restart window. */
export const MAX_ROUTE_TABLE_TTL_MS = 3_600_000;

/** Background convergence refreshes route files shortly before native readers reject them. */
export const ROUTE_TABLE_REFRESH_MARGIN_MS = 10_000;

/** Clamps user or environment-provided route cache TTLs to the reader-supported range. */
export function normalizeRouteTableTtlMs(value: number | undefined, fallback = ROUTE_TABLE_TTL_MS): number {
  if (value === undefined || !Number.isFinite(value)) {
    return normalizeRouteTableTtlMs(fallback, ROUTE_TABLE_TTL_MS);
  }

  return Math.min(MAX_ROUTE_TABLE_TTL_MS, Math.max(MIN_ROUTE_TABLE_TTL_MS, Math.round(value)));
}

/** Reads the route cache TTL from the process environment used by Node daemon fallbacks. */
export function routeTableTtlMsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const rawValue = environment[ROUTE_TABLE_TTL_SECONDS_ENV];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return ROUTE_TABLE_TTL_MS;
  }

  const seconds = Number(rawValue);
  return normalizeRouteTableTtlMs(Number.isFinite(seconds) ? seconds * 1000 : undefined);
}

/** Computes the rewrite margin from the active TTL so short-lived route caches refresh before expiry. */
export function routeTableRefreshMarginMs(ttlMs: number): number {
  const normalizedTtlMs = normalizeRouteTableTtlMs(ttlMs);
  return Math.min(ROUTE_TABLE_REFRESH_MARGIN_MS, Math.max(1_000, Math.floor(normalizedTtlMs / 2)));
}

/** Points extension-owned route tables at durable globalStorage instead of OS temp. */
export function configureRouteTableStorageDirectory(storageDirectory: string): void {
  const normalizedDirectory = storageDirectory.trim();
  routeTableStorageDirectory = normalizedDirectory.length > 0 ? normalizedDirectory : undefined;
}

/** Builds the per-user base path used to derive network and endpoint route shards. */
export function getDefaultRouteTablePath(): string {
  return path.join(getRouteTableStorageDirectory(), getDefaultRouteTableFileName());
}

/** Builds the legacy temp route-table path used before extension-owned storage. */
export function getLegacyDefaultRouteTablePath(): string {
  return path.join(os.tmpdir(), getDefaultRouteTableFileName());
}

function getRouteTableStorageDirectory(): string {
  return routeTableStorageDirectory ?? os.tmpdir();
}

function getDefaultRouteTableFileName(): string {
  const userId = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return `newdlops-portmanager-routes-${userId}.json`;
}

/**
 * Builds the route-table path for one logical network.
 *
 * Attached terminals read a smaller network-scoped file so unrelated concurrent
 * requests do not all depend on one JSON payload.
 */
export function getNetworkRouteTablePath(networkId: string, baseRouteTablePath = getDefaultRouteTablePath()): string {
  const parsedPath = path.parse(baseRouteTablePath);
  const extension = parsedPath.ext.length > 0 ? parsedPath.ext : ".json";

  return path.join(parsedPath.dir, `${parsedPath.name}-${sanitizeRouteTableScope(networkId)}${extension}`);
}

/** Returns the correct route table path for a network-aware or global process. */
export function getRouteTablePathForNetwork(
  networkId: string | undefined,
  baseRouteTablePath = getDefaultRouteTablePath(),
): string {
  const normalizedNetworkId = networkId?.trim();

  return normalizedNetworkId === undefined || normalizedNetworkId.length === 0
    ? baseRouteTablePath
    : getNetworkRouteTablePath(normalizedNetworkId, baseRouteTablePath);
}

/**
 * Builds the route-entry file for one logical endpoint.
 *
 * Native hooks read this first for logical-port connect/bind rewrites. It keeps
 * each polling sender/receiver pair on its own file instead of making unrelated
 * logical ports race on a shared network table.
 */
export function getRouteTablePathForLogicalPort(
  logicalPort: number,
  networkId: string | undefined,
  baseRouteTablePath = getDefaultRouteTablePath(),
): string {
  const scopedRouteTablePath = getRouteTablePathForNetwork(networkId, baseRouteTablePath);
  const parsedPath = path.parse(scopedRouteTablePath);
  const extension = parsedPath.ext.length > 0 ? parsedPath.ext : ".json";

  return path.join(parsedPath.dir, `${parsedPath.name}-port-${logicalPort}${extension}`);
}

/**
 * Builds the global compose claim index for one host-visible port.
 *
 * Compose publishes host ports outside Port Manager's socket hook. The hook
 * checks this small per-port file before touching real localhost so a foreign
 * network cannot reach another network's published container through either the
 * logical service port or the Docker-assigned host port.
 */
export function getRouteTablePathForComposeClaimPort(
  port: number,
  baseRouteTablePath = getDefaultRouteTablePath(),
): string {
  const parsedPath = path.parse(baseRouteTablePath);
  const extension = parsedPath.ext.length > 0 ? parsedPath.ext : ".json";

  return path.join(parsedPath.dir, `${parsedPath.name}-compose-claim-port-${port}${extension}`);
}

/** Builds the per-user network-to-host binding file path shared with native hooks. */
export function getDefaultHostAccessBindingsPath(): string {
  const userId = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `newdlops-portmanager-host-access-${userId}.json`);
}

function sanitizeRouteTableScope(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
  return sanitized.length > 0 ? sanitized : "network";
}

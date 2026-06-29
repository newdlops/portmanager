import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared route-table path helpers.
 *
 * The daemon writes this JSON file, managed children read it through
 * environment variables, and native socket hooks use it to translate logical
 * connect targets to actual listening ports.
 */

let routeTableStorageDirectory: string | undefined;

/** Points extension-owned route tables at durable globalStorage instead of OS temp. */
export function configureRouteTableStorageDirectory(storageDirectory: string): void {
  const normalizedDirectory = storageDirectory.trim();
  routeTableStorageDirectory = normalizedDirectory.length > 0 ? normalizedDirectory : undefined;
}

/** Builds the per-user route table file path shared by one local agent. */
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
 * The global table remains for terminals that have not joined a network yet,
 * but attached terminals can read a smaller network-scoped file so unrelated
 * concurrent requests do not all depend on the same JSON payload.
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

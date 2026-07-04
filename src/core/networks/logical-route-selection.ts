import * as path from "node:path";
import type { LogicalPortRoute } from "../../shared/types";

/**
 * Selects active routes whose recorded process cwd matches the client cwd.
 *
 * Logical-port router clients can lose explicit network metadata when a runtime
 * refuses native library injection or daemonizes away from its terminal. The
 * cwd comparison is intentionally scoped to the same logical port and live
 * routes so it can only narrow an already relevant candidate set, including
 * Compose endpoints whose hidden host ports are still owned by the project.
 */
export function findRoutesMatchingClientCwd(
  routes: readonly LogicalPortRoute[],
  logicalPort: number,
  clientCwd: string,
): readonly LogicalPortRoute[] {
  const normalizedClientCwd = normalizeComparablePath(clientCwd);

  if (normalizedClientCwd === undefined) {
    return [];
  }

  const candidates = routes.filter(
    (route) =>
      route.logicalPort === logicalPort &&
      route.actualPort !== route.logicalPort &&
      (route.routeDirection === undefined || route.routeDirection === "listen") &&
      route.cwd !== undefined &&
      route.status === "running",
  );
  const exactMatches = candidates.filter((route) => {
    const routeCwd = normalizeComparablePath(route.cwd);
    return routeCwd !== undefined && routeCwd === normalizedClientCwd;
  });

  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return candidates.filter((route) => {
    const routeCwd = normalizeComparablePath(route.cwd);
    return routeCwd !== undefined && pathsShareDirectoryScope(routeCwd, normalizedClientCwd);
  });
}

/**
 * Selects the network-less relocated listen route that owns a logical port.
 *
 * A non-network server that wanted a gateway-owned port is relocated to a high
 * port and registered as a listen route with no network id. That row is the
 * real 127.0.0.1 coordinate the logical port gateway passes non-network clients
 * through to. When sibling non-network servers share a logical port, the client
 * cwd disambiguates; an ambiguous or empty set returns undefined so the gateway
 * refuses rather than leaking an unrelated server.
 */
export function selectNonNetworkOwnerRoute(
  routes: readonly LogicalPortRoute[],
  logicalPort: number,
  clientCwd: string | undefined,
): LogicalPortRoute | undefined {
  const candidates = routes.filter(
    (route) =>
      route.logicalPort === logicalPort &&
      route.networkId === undefined &&
      (route.routeDirection === undefined || route.routeDirection === "listen") &&
      route.status === "running",
  );

  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 0 || clientCwd === undefined) {
    return undefined;
  }

  const cwdMatches = findRoutesMatchingClientCwd(candidates, logicalPort, clientCwd);
  return cwdMatches.length === 1 ? cwdMatches[0] : undefined;
}

/**
 * Returns true when two paths describe the same directory scope.
 *
 * Either side may be the direct project root while the other is a child working
 * directory spawned by package scripts. Sibling projects do not match.
 */
export function pathsShareDirectoryScope(firstPath: string, secondPath: string): boolean {
  return isSameOrChildPath(firstPath, secondPath) || isSameOrChildPath(secondPath, firstPath);
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  if (parentPath === childPath) {
    return true;
  }

  const relative = path.relative(parentPath, childPath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeComparablePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  const resolved = path.normalize(path.resolve(trimmed));
  const root = path.parse(resolved).root;
  const normalized = resolved === root ? resolved : resolved.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

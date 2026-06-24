import * as path from "node:path";
import type { LogicalPortRoute } from "../../shared/types";

/**
 * Selects active routes whose recorded process cwd matches the client cwd.
 *
 * Logical-port router clients can lose explicit network metadata when a runtime
 * refuses native library injection. The cwd comparison is intentionally scoped
 * to the same logical port and live routes so it can only narrow an already
 * relevant candidate set.
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
      route.source !== "compose" &&
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

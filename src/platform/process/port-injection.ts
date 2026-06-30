import { ROUTE_TABLE_TTL_SECONDS_ENV } from "../../agent/route-table";
import type { LogicalPortRoute, PortInjectionMode } from "../../shared/types";

/**
 * Port injection helpers shared by daemon-owned launches and external CLI
 * launches. Keeping this contract in one place prevents the shell wrapper and
 * VS Code command path from diverging.
 */

export interface InjectedCommandRequest {
  /** Original command entered by the user or wrapper. */
  readonly command: string;
  /** Actual TCP port chosen by the daemon route allocation. */
  readonly actualPort: number;
  /** Strategy used to pass the actual port into the child process. */
  readonly injectionMode: PortInjectionMode;
}

export interface PortManagerEnvironmentRequest {
  /** Base environment inherited by the launched process. */
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Logical port requested by the user or application profile. */
  readonly requestedPort: number;
  /** Actual TCP port assigned by the daemon. */
  readonly actualPort: number;
  /** Current logical routing table made available to the process. */
  readonly logicalRoutes?: readonly LogicalPortRoute[];
  /** Path to the daemon-maintained dynamic route table. */
  readonly logicalRoutesFile?: string;
  /** Route-table cache TTL mirrored from the extension or daemon setting. */
  readonly routeTableTtlSeconds?: number;
}

/**
 * Applies the selected port injection strategy to the shell command.
 * Template mode rewrites every `${port}` placeholder, argument mode appends a
 * conventional `--port` flag, and env mode leaves command text unchanged.
 */
export function buildInjectedCommand(request: InjectedCommandRequest): string {
  const port = String(request.actualPort);

  if (request.injectionMode === "template") {
    return request.command.replaceAll("${port}", port);
  }

  if (request.injectionMode === "argument") {
    return `${request.command.trimEnd()} --port ${port}`;
  }

  return request.command;
}

/**
 * Builds the environment contract consumed by routed development processes.
 * `PORT` stays compatible with common dev servers, while `PORT_MANAGER_*`
 * exposes the logical routing table to code that wants explicit awareness.
 */
export function buildPortManagerEnvironment(request: PortManagerEnvironmentRequest): NodeJS.ProcessEnv {
  return {
    ...request.baseEnv,
    PORT: String(request.actualPort),
    PORT_MANAGER_ACTUAL_PORT: String(request.actualPort),
    PORT_MANAGER_LOGICAL_PORT: String(request.requestedPort),
    PORT_MANAGER_ROUTES: JSON.stringify(request.logicalRoutes ?? []),
    PORT_MANAGER_ROUTES_FILE: request.logicalRoutesFile ?? "",
    [ROUTE_TABLE_TTL_SECONDS_ENV]: String(request.routeTableTtlSeconds ?? request.baseEnv[ROUTE_TABLE_TTL_SECONDS_ENV] ?? 30),
  };
}

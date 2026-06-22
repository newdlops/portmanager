import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LogicalPortRouterConnection } from "./logical-port-router";

const execFileAsync = promisify(execFile);

export interface TcpConnectionProcess {
  /** PID that owns the client side of an accepted TCP connection. */
  readonly pid: number;
  /** Short process name from the OS table, used only for diagnostics. */
  readonly processName?: string;
}

interface CommandResult {
  readonly stdout: string | Buffer;
}

type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

interface TcpConnectionProcessResolverOptions {
  /** Injectable command boundary so tests do not depend on host lsof output. */
  readonly commandRunner?: CommandRunner;
}

interface LsofProcessContext {
  pid?: number;
  processName?: string;
}

interface ParsedConnectionEndpoint {
  readonly address: string;
  readonly port: number;
}

interface ParsedConnection {
  readonly local: ParsedConnectionEndpoint;
  readonly remote: ParsedConnectionEndpoint;
}

/**
 * Resolves the process that initiated a local TCP connection.
 *
 * Node does not expose peer PID for TCP sockets. This adapter stays below the
 * app layer by looking up the accepted socket tuple in the OS connection table.
 */
export class NodeTcpConnectionProcessResolver {
  private readonly runCommand: CommandRunner;

  constructor(options: TcpConnectionProcessResolverOptions = {}) {
    this.runCommand = options.commandRunner ?? runExecFile;
  }

  /** Returns the client process for a router connection, when the OS exposes it. */
  async resolveClientProcess(connection: LogicalPortRouterConnection): Promise<TcpConnectionProcess | undefined> {
    if (!isTcpPort(connection.localPort) || !isTcpPort(connection.remotePort)) {
      return undefined;
    }

    const { stdout } = await this.runCommand("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpcn"]);
    return parseClientProcessFromLsof(toText(stdout), connection);
  }
}

/** Parses lsof field output and finds the client-side owner of a socket tuple. */
export function parseClientProcessFromLsof(
  output: string,
  connection: LogicalPortRouterConnection,
): TcpConnectionProcess | undefined {
  const current: LsofProcessContext = {};

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const fieldType = line[0];
    const value = line.slice(1);

    if (fieldType === "p") {
      current.pid = parsePositiveInteger(value);
      current.processName = undefined;
      continue;
    }

    if (fieldType === "c") {
      current.processName = value.length > 0 ? value : undefined;
      continue;
    }

    if (fieldType !== "n" || current.pid === undefined) {
      continue;
    }

    const parsed = parseLsofTcpConnection(value);
    if (parsed === undefined) {
      continue;
    }

    if (isClientSideConnection(parsed, connection)) {
      return {
        pid: current.pid,
        processName: current.processName,
      };
    }
  }

  return undefined;
}

/** Parses one lsof TCP name field shaped like a:b->c:d. */
export function parseLsofTcpConnection(value: string): ParsedConnection | undefined {
  const endpoint = value
    .trim()
    .replace(/^TCP\s+/i, "")
    .replace(/\s+\(.+\)$/, "");
  const arrowIndex = endpoint.indexOf("->");

  if (arrowIndex < 0) {
    return undefined;
  }

  const local = parseEndpoint(endpoint.slice(0, arrowIndex));
  const remote = parseEndpoint(endpoint.slice(arrowIndex + 2));

  return local !== undefined && remote !== undefined ? { local, remote } : undefined;
}

function parseEndpoint(value: string): ParsedConnectionEndpoint | undefined {
  const trimmed = value.trim();
  let address: string;
  let portText: string;

  if (trimmed.startsWith("[")) {
    const bracketEnd = trimmed.indexOf("]:");
    if (bracketEnd < 0) {
      return undefined;
    }

    address = trimmed.slice(1, bracketEnd);
    portText = trimmed.slice(bracketEnd + 2);
  } else {
    const colonIndex = trimmed.lastIndexOf(":");
    if (colonIndex < 0) {
      return undefined;
    }

    address = trimmed.slice(0, colonIndex);
    portText = trimmed.slice(colonIndex + 1);
  }

  const port = Number.parseInt(portText, 10);
  return isTcpPort(port) ? { address, port } : undefined;
}

function isClientSideConnection(
  parsed: ParsedConnection,
  connection: LogicalPortRouterConnection,
): boolean {
  return parsed.local.port === connection.remotePort && parsed.remote.port === connection.localPort;
}

function parsePositiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isTcpPort(port: number | undefined): port is number {
  return Number.isInteger(port) && port !== undefined && port >= 1 && port <= 65_535;
}

function toText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

async function runExecFile(file: string, args: readonly string[]): Promise<CommandResult> {
  return execFileAsync(file, [...args], {
    maxBuffer: 1024 * 1024,
    timeout: 1000,
  });
}

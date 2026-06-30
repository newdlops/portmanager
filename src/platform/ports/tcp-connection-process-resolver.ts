import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeProcessLookupProvider } from "../process/native-process-lookup";
import type { LogicalPortRouterConnection } from "./logical-port-router";
import type { EstablishedTcpConnection, EstablishedTcpConnectionProvider } from "../../shared/types";

const execFileAsync = promisify(execFile);
const ESTABLISHED_CONNECTION_SNAPSHOT_TTL_MS = 250;
const PROCESS_CWD_CACHE_TTL_MS = 5000;

export interface TcpConnectionProcess {
  /** PID that owns the client side of an accepted TCP connection. */
  readonly pid: number;
  /** Short process name from the OS table, used only for diagnostics. */
  readonly processName?: string;
  /** Working directory used to disambiguate identical logical ports across projects. */
  readonly cwd?: string;
}

interface CommandResult {
  readonly stdout: string | Buffer;
}

type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

interface TcpConnectionProcessResolverOptions {
  /** Injectable command boundary so tests do not depend on host lsof output. */
  readonly commandRunner?: CommandRunner;
  /** Optional native helper used before the cwd lsof fallback. */
  readonly nativeLookupProvider?: NativeProcessLookupProvider;
  /** Packaged native helper path passed by the VS Code extension context. */
  readonly nativeLookupPath?: string;
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

interface EstablishedConnectionSnapshot {
  readonly output: string;
  readonly expiresAtMs: number;
}

interface ProcessCwdSnapshot {
  readonly cwd?: string;
  readonly expiresAtMs: number;
}

/**
 * Resolves the process that initiated a local TCP connection.
 *
 * Node does not expose peer PID for TCP sockets. This adapter stays below the
 * app layer by looking up the accepted socket tuple in the OS connection table.
 */
export class NodeTcpConnectionProcessResolver {
  private readonly runCommand: CommandRunner;
  /** Optional C helper for cwd lookup after lsof identifies the client PID. */
  private readonly nativeLookupProvider?: NativeProcessLookupProvider;
  /**
   * Point-in-time TCP table shared by router connections accepted in the same
   * burst. Without this, polling clients can spawn one global lsof per socket.
   */
  private establishedConnectionsSnapshot?: EstablishedConnectionSnapshot;

  /** In-flight global lsof call reused by concurrent socket resolutions. */
  private establishedConnectionsRequest?: Promise<string>;

  /** Short-lived cwd cache keyed by PID; process cwd is stable for this use. */
  private readonly cwdSnapshotsByPid = new Map<number, ProcessCwdSnapshot>();

  /** In-flight cwd lookups keyed by PID, preventing duplicate narrow lsof calls. */
  private readonly cwdRequestsByPid = new Map<number, Promise<string | undefined>>();

  constructor(options: TcpConnectionProcessResolverOptions = {}) {
    this.runCommand = options.commandRunner ?? runExecFile;
    this.nativeLookupProvider =
      options.nativeLookupProvider ??
      (options.commandRunner === undefined || options.nativeLookupPath !== undefined
        ? new NativeProcessLookupProvider({ helperPath: options.nativeLookupPath })
        : undefined);
  }

  /** Returns the client process for a router connection, when the OS exposes it. */
  async resolveClientProcess(connection: LogicalPortRouterConnection): Promise<TcpConnectionProcess | undefined> {
    if (!isTcpPort(connection.localPort) || !isTcpPort(connection.remotePort)) {
      return undefined;
    }

    const establishedConnections = await this.readEstablishedConnections();
    const clientProcess = parseClientProcessFromLsof(establishedConnections, connection);

    if (clientProcess === undefined) {
      return undefined;
    }

    const cwd = await this.resolveProcessCwd(clientProcess.pid).catch(() => undefined);
    return cwd === undefined ? clientProcess : { ...clientProcess, cwd };
  }

  /**
   * Reads cwd in a second, narrow lsof call.
   *
   * Process environment and terminal ancestry can be hidden by macOS privacy
   * boundaries. cwd is still commonly visible for same-user tools such as
   * wait-on, and gives the router a stable fallback scope.
   */
  private async resolveProcessCwd(pid: number): Promise<string | undefined> {
    const now = Date.now();
    const cached = this.cwdSnapshotsByPid.get(pid);

    if (cached !== undefined) {
      if (cached.expiresAtMs > now) {
        return cached.cwd;
      }

      this.cwdSnapshotsByPid.delete(pid);
    }

    const currentRequest = this.cwdRequestsByPid.get(pid);
    if (currentRequest !== undefined) {
      return currentRequest;
    }

    let request: Promise<string | undefined>;
    request = this.resolveProcessCwdUncached(pid)
      .then((cwd) => {
        this.cwdSnapshotsByPid.set(pid, {
          cwd,
          expiresAtMs: Date.now() + PROCESS_CWD_CACHE_TTL_MS,
        });
        return cwd;
      })
      .finally(() => {
        if (this.cwdRequestsByPid.get(pid) === request) {
          this.cwdRequestsByPid.delete(pid);
        }
      });

    this.cwdRequestsByPid.set(pid, request);
    return request;
  }

  /** Reads native cwd first and falls back to the previous narrow lsof query. */
  private async resolveProcessCwdUncached(pid: number): Promise<string | undefined> {
    if (this.nativeLookupProvider !== undefined) {
      const nativeCwd = (await this.nativeLookupProvider.inspectProcess(pid))?.cwd;
      if (nativeCwd !== undefined) {
        return nativeCwd;
      }
    }

    const { stdout } = await this.runCommand("lsof", ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return parseProcessCwdFromLsof(toText(stdout));
  }

  /**
   * Reads established TCP sockets through one shared snapshot.
   *
   * The logical router accepts many short-lived connections when tools poll a
   * server port. A small TTL is enough to cover that burst while still keeping
   * tuple data fresh for the next accepted socket.
   */
  private async readEstablishedConnections(): Promise<string> {
    const now = Date.now();

    if (
      this.establishedConnectionsSnapshot !== undefined &&
      this.establishedConnectionsSnapshot.expiresAtMs > now
    ) {
      return this.establishedConnectionsSnapshot.output;
    }

    if (this.establishedConnectionsRequest !== undefined) {
      return this.establishedConnectionsRequest;
    }

    let request: Promise<string>;
    request = this.runCommand("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpcn"])
      .then(({ stdout }) => {
        const output = toText(stdout);
        this.establishedConnectionsSnapshot = {
          output,
          expiresAtMs: Date.now() + ESTABLISHED_CONNECTION_SNAPSHOT_TTL_MS,
        };
        return output;
      })
      .finally(() => {
        if (this.establishedConnectionsRequest === request) {
          this.establishedConnectionsRequest = undefined;
        }
      });

    this.establishedConnectionsRequest = request;
    return request;
  }
}

/** Lists established TCP tuples for route-cache liveness checks. */
export class NodeEstablishedTcpConnectionProvider implements EstablishedTcpConnectionProvider {
  private readonly runCommand: CommandRunner;
  private establishedConnectionsSnapshot?: EstablishedConnectionSnapshot;
  private establishedConnectionsRequest?: Promise<string>;

  constructor(options: Pick<TcpConnectionProcessResolverOptions, "commandRunner"> = {}) {
    this.runCommand = options.commandRunner ?? runExecFile;
  }

  async list(): Promise<readonly EstablishedTcpConnection[]> {
    try {
      return parseEstablishedTcpConnectionsFromLsof(await this.readEstablishedConnections());
    } catch {
      return [];
    }
  }

  private async readEstablishedConnections(): Promise<string> {
    const now = Date.now();

    if (
      this.establishedConnectionsSnapshot !== undefined &&
      this.establishedConnectionsSnapshot.expiresAtMs > now
    ) {
      return this.establishedConnectionsSnapshot.output;
    }

    if (this.establishedConnectionsRequest !== undefined) {
      return this.establishedConnectionsRequest;
    }

    let request: Promise<string>;
    request = this.runCommand("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpcn"])
      .then(({ stdout }) => {
        const output = toText(stdout);
        this.establishedConnectionsSnapshot = {
          output,
          expiresAtMs: Date.now() + ESTABLISHED_CONNECTION_SNAPSHOT_TTL_MS,
        };
        return output;
      })
      .finally(() => {
        if (this.establishedConnectionsRequest === request) {
          this.establishedConnectionsRequest = undefined;
        }
      });

    this.establishedConnectionsRequest = request;
    return request;
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

/** Parses every established TCP tuple from lsof field output. */
export function parseEstablishedTcpConnectionsFromLsof(output: string): readonly EstablishedTcpConnection[] {
  const connections: EstablishedTcpConnection[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line[0] !== "n") {
      continue;
    }

    const parsed = parseLsofTcpConnection(line.slice(1));
    if (parsed === undefined) {
      continue;
    }

    connections.push({
      localAddress: parsed.local.address,
      localPort: parsed.local.port,
      remoteAddress: parsed.remote.address,
      remotePort: parsed.remote.port,
    });
  }

  return connections;
}

/** Parses the first lsof file-name field from a cwd-only query. */
export function parseProcessCwdFromLsof(output: string): string | undefined {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line[0] !== "n") {
      continue;
    }

    const cwd = line.slice(1).trim();
    if (cwd.length > 0) {
      return cwd;
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

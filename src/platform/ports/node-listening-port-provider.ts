import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { ListeningPort, ListeningPortProvider } from "../../shared/types";

const execFileAsync = promisify(execFile);

const posixListeningPortArgs = ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"] as const;

type CommandResult = {
  /** Standard output from the platform command; parser helpers consume this text. */
  readonly stdout: string | Buffer;
  /** Standard error is intentionally not surfaced to callers because command failure is non-fatal. */
  readonly stderr?: string | Buffer;
};

type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

interface NodeListeningPortProviderOptions {
  /** OS command executor, injectable so adapter tests can avoid running host tools. */
  readonly commandRunner?: CommandRunner;
  /** Platform selector captured once so the provider uses one OS strategy for its lifetime. */
  readonly currentPlatform?: NodeJS.Platform;
  /** Timestamp source used to stamp all rows from the same scan consistently. */
  readonly now?: () => Date;
}

interface ParsedEndpoint {
  /** Local bind address exactly as reported by the OS command, normalized only for syntax noise. */
  readonly localAddress: string;
  /** Numeric TCP port extracted from the local listener endpoint. */
  readonly port: number;
}

interface PosixProcessContext {
  /** Current process id from the most recent lsof `p` field. */
  pid?: number;
  /** Current process command name from the most recent lsof `c` field. */
  processName?: string;
  /** Best-effort command text; lsof field output usually only exposes the command name. */
  command?: string;
}

/**
 * Lists every local TCP listener visible to the current user.
 *
 * This adapter is deliberately fail-soft: the local agent should keep running
 * even when lsof, PowerShell, or process permissions are unavailable. Higher
 * layers can treat an empty list as "no observable listeners" for that scan.
 */
export class NodeListeningPortProvider implements ListeningPortProvider {
  /** Low-level command execution boundary used by the OS-specific list methods. */
  private readonly runCommand: CommandRunner;

  /** Platform strategy chosen once to keep per-scan behavior predictable. */
  private readonly currentPlatform: NodeJS.Platform;

  /** Clock used to assign one scan timestamp to all returned listener rows. */
  private readonly now: () => Date;

  constructor(options: NodeListeningPortProviderOptions = {}) {
    this.runCommand = options.commandRunner ?? runExecFile;
    this.currentPlatform = options.currentPlatform ?? platform();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Returns every visible local listening TCP port for the current OS.
   * Command and parse failures are contained here so a broken scan never
   * crashes the single local agent process.
   */
  async list(): Promise<readonly ListeningPort[]> {
    // Every row from one command run receives the same timestamp so snapshots
    // can be compared without per-row clock drift.
    const updatedAt = this.now().toISOString();

    try {
      if (this.currentPlatform === "win32") {
        return await this.listWindows(updatedAt);
      }

      return await this.listPosix(updatedAt);
    } catch {
      return [];
    }
  }

  /**
   * Returns visible listeners for one TCP port using the narrowest platform
   * command available. Route allocation paths call this instead of sharing a
   * potentially slow global scan.
   */
  async listByPort(port: number): Promise<readonly ListeningPort[]> {
    if (!isValidTcpPort(port)) {
      return [];
    }

    const updatedAt = this.now().toISOString();

    try {
      if (this.currentPlatform === "win32") {
        return await this.listWindows(updatedAt, port);
      }

      return await this.listPosix(updatedAt, port);
    } catch {
      return [];
    }
  }

  /** Runs lsof's field-output mode and parses process-scoped listener records. */
  private async listPosix(updatedAt: string, port?: number): Promise<readonly ListeningPort[]> {
    const args = port === undefined ? posixListeningPortArgs : ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"];
    const { stdout } = await this.runCommand("lsof", args);

    return parsePosixLsofListeningPorts(toText(stdout), updatedAt);
  }

  /** Runs a PowerShell object query so localized netstat text never enters parsing. */
  private async listWindows(updatedAt: string, port?: number): Promise<readonly ListeningPort[]> {
    const { stdout } = await this.runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      buildWindowsListeningPortScript(port),
    ]);

    return parseWindowsListeningPortsJson(toText(stdout), updatedAt);
  }
}

/**
 * Parses `lsof -Fpcn` output into listener rows.
 *
 * lsof emits process fields followed by one or more name fields. The parser
 * carries the latest process context forward so every `n` endpoint can inherit
 * its PID and process name without relying on column positions.
 */
export function parsePosixLsofListeningPorts(output: string, updatedAt = new Date().toISOString()): readonly ListeningPort[] {
  const listenersById = new Map<string, ListeningPort>();
  const currentProcess: PosixProcessContext = {};

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    const fieldType = line[0];
    const value = line.slice(1);

    if (fieldType === "p") {
      currentProcess.pid = parseOptionalPositiveInteger(value);
      currentProcess.processName = undefined;
      currentProcess.command = undefined;
      continue;
    }

    if (fieldType === "c") {
      currentProcess.processName = value.length > 0 ? value : undefined;
      currentProcess.command = currentProcess.processName;
      continue;
    }

    if (fieldType !== "n") {
      continue;
    }

    const endpoint = parseLsofLocalEndpoint(value);

    if (endpoint === undefined) {
      continue;
    }

    const listener = buildListeningPort({
      localAddress: endpoint.localAddress,
      port: endpoint.port,
      pid: currentProcess.pid,
      processName: currentProcess.processName,
      command: currentProcess.command,
      updatedAt,
    });

    listenersById.set(listener.id, listener);
  }

  return [...listenersById.values()];
}

/**
 * Parses the JSON emitted by the Windows PowerShell listener query.
 *
 * ConvertTo-Json returns a single object when there is one row and an array for
 * multiple rows, so both shapes are accepted. Malformed JSON is treated like an
 * empty scan because adapter callers care more about agent liveness than the
 * specific command-output error.
 */
export function parseWindowsListeningPortsJson(output: string, updatedAt = new Date().toISOString()): readonly ListeningPort[] {
  const trimmedOutput = output.trim();

  if (trimmedOutput.length === 0) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmedOutput);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const listenersById = new Map<string, ListeningPort>();

  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }

    const port = readNumber(row, ["port", "localPort", "LocalPort"]);

    if (!isValidTcpPort(port)) {
      continue;
    }

    const protocol = readString(row, ["protocol", "Protocol"]);

    if (protocol !== undefined && protocol.toLowerCase() !== "tcp") {
      continue;
    }

    const listener = buildListeningPort({
      localAddress: readString(row, ["localAddress", "LocalAddress"]) ?? "*",
      port,
      pid: readNumber(row, ["pid", "owningProcess", "OwningProcess"]),
      processName: readString(row, ["processName", "ProcessName", "name", "Name"]),
      command: readString(row, ["command", "path", "Path"]),
      updatedAt,
    });

    listenersById.set(listener.id, listener);
  }

  return [...listenersById.values()];
}

/**
 * Extracts the local endpoint from lsof's network name field.
 * The field can appear as `*:3000`, `TCP 127.0.0.1:3000 (LISTEN)`, or an IPv6
 * bracket form like `[::1]:5173`; all forms reduce to address plus port.
 */
export function parseLsofLocalEndpoint(value: string): ParsedEndpoint | undefined {
  let endpoint = value.trim();

  if (endpoint.length === 0) {
    return undefined;
  }

  endpoint = endpoint.replace(/^TCP\s+/i, "").trim();

  const stateMarkerIndex = endpoint.indexOf(" (");

  if (stateMarkerIndex >= 0) {
    endpoint = endpoint.slice(0, stateMarkerIndex).trim();
  }

  const remoteSeparatorIndex = endpoint.indexOf("->");

  if (remoteSeparatorIndex >= 0) {
    endpoint = endpoint.slice(0, remoteSeparatorIndex).trim();
  }

  const bracketMatch = endpoint.match(/^\[([^\]]+)\]:(\d+)$/);

  if (bracketMatch !== null) {
    return buildParsedEndpoint(bracketMatch[1] ?? "", bracketMatch[2] ?? "");
  }

  const portSeparatorIndex = endpoint.lastIndexOf(":");

  if (portSeparatorIndex < 0) {
    return undefined;
  }

  const address = endpoint.slice(0, portSeparatorIndex) || "*";
  const portText = endpoint.slice(portSeparatorIndex + 1);

  return buildParsedEndpoint(address, portText);
}

/** Bridges Node's callback-based execFile API into the provider command runner contract. */
async function runExecFile(file: string, args: readonly string[]): Promise<CommandResult> {
  return await execFileAsync(file, [...args]);
}

/** Builds the PowerShell query used to avoid locale-sensitive text parsing on Windows. */
function buildWindowsListeningPortScript(port?: number): string {
  const connectionQuery =
    port === undefined ? "Get-NetTCPConnection -State Listen" : `Get-NetTCPConnection -LocalPort ${port} -State Listen`;

  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$connections = ${connectionQuery}`,
    "$rows = foreach ($connection in $connections) {",
    "  $process = Get-Process -Id $connection.OwningProcess",
    "  [pscustomobject]@{",
    "    protocol = 'tcp'",
    "    localAddress = $connection.LocalAddress",
    "    port = [int]$connection.LocalPort",
    "    pid = [int]$connection.OwningProcess",
    "    processName = $process.ProcessName",
    "    command = $process.Path",
    "  }",
    "}",
    "$rows | ConvertTo-Json -Compress",
  ].join("\n");
}

/** Creates a domain listener row and keeps optional process fields absent when unknown. */
function buildListeningPort(input: {
  readonly localAddress: string;
  readonly port: number;
  readonly pid?: number;
  readonly processName?: string;
  readonly command?: string;
  readonly updatedAt: string;
}): ListeningPort {
  return {
    id: buildListeningPortId(input.localAddress, input.port, input.pid),
    protocol: "tcp",
    localAddress: input.localAddress,
    port: input.port,
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.processName !== undefined ? { processName: input.processName } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
    source: "external",
    updatedAt: input.updatedAt,
  };
}

/** Uses every identity-bearing field so duplicate command rows collapse safely. */
function buildListeningPortId(localAddress: string, port: number, pid: number | undefined): string {
  return `tcp:${localAddress}:${port}:${pid ?? "unknown"}`;
}

/** Converts lsof endpoint text into a validated address/port pair. */
function buildParsedEndpoint(address: string, portText: string): ParsedEndpoint | undefined {
  if (!/^\d+$/.test(portText)) {
    return undefined;
  }

  const port = Number.parseInt(portText, 10);

  if (!isValidTcpPort(port)) {
    return undefined;
  }

  return {
    localAddress: address.length > 0 ? address : "*",
    port,
  };
}

/** Reads a non-empty string from the first matching object key. */
function readString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];

    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

/** Reads an integer from numeric or numeric-string JSON fields. */
function readNumber(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];

    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }

    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number.parseInt(value, 10);
    }
  }

  return undefined;
}

/** Parses positive process identifiers while letting permission gaps remain undefined. */
function parseOptionalPositiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Keeps generated listener rows inside the TCP userland range. */
function isValidTcpPort(port: number | undefined): port is number {
  return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** Narrowing helper for untyped JSON values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalizes Buffer/string stdout without leaking command-runner details into parsers. */
function toText(output: string | Buffer): string {
  return typeof output === "string" ? output : output.toString("utf8");
}

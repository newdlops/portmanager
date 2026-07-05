import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProcessTableRow } from "./node-process-table";

const execFileAsync = promisify(execFile);
const NATIVE_PROCESS_LOOKUP_TIMEOUT_MS = 1000;

interface CommandResult {
  readonly stdout: string | Buffer;
}

type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

interface NativeProcessLookupProviderOptions {
  /** Packaged helper path. Extension code should pass context.asAbsolutePath. */
  readonly helperPath?: string;
  /** Injectable command boundary for native JSON parser tests. */
  readonly commandRunner?: CommandRunner;
}

export interface NativeProcessLookupDetails {
  /** Process table row for the inspected PID, when the process still exists. */
  readonly row?: ProcessTableRow;
  /** Parent chain from direct parent up to the visible root. */
  readonly ancestorPids: readonly number[];
  /** Current working directory if the OS allows this caller to read it. */
  readonly cwd?: string;
  /** Port Manager routing network inherited through process environment. */
  readonly networkId?: string;
  /** Full argument vector (only populated by captureProcess). */
  readonly argv?: readonly string[];
  /** Full environment as KEY=VALUE entries (only populated by captureProcess). */
  readonly env?: readonly string[];
}

/**
 * Thin adapter around the optional C process lookup helper.
 *
 * The helper avoids repeated shell-command parsing on hot logical-router paths,
 * but it is deliberately best-effort. macOS privacy settings, Linux /proc
 * permissions, missing packaged binaries, or short-lived processes can all hide
 * fields, so callers keep their previous ps/lsof fallback behavior.
 */
export class NativeProcessLookupProvider {
  private readonly helperPath: string;
  private readonly runCommand: CommandRunner;
  /** Once the helper is missing or unusable, avoid retrying it for every socket. */
  private disabled = false;

  constructor(options: NativeProcessLookupProviderOptions = {}) {
    this.helperPath = options.helperPath ?? resolveDefaultProcessLookupHelperPath();
    this.runCommand = options.commandRunner ?? runExecFile;
  }

  /** Returns native process-table rows, or undefined when fallback should run. */
  async listProcessTableRows(): Promise<readonly ProcessTableRow[] | undefined> {
    if (this.disabled || process.platform === "win32") {
      return undefined;
    }

    try {
      const { stdout } = await this.runCommand(this.helperPath, ["list"]);
      return parseNativeProcessTableRows(toText(stdout));
    } catch {
      this.disabled = true;
      return undefined;
    }
  }

  /** Returns native details for one PID, or undefined when fallback should run. */
  async inspectProcess(pid: number): Promise<NativeProcessLookupDetails | undefined> {
    if (this.disabled || process.platform === "win32" || !isPositiveInteger(pid)) {
      return undefined;
    }

    try {
      const { stdout } = await this.runCommand(this.helperPath, ["inspect", String(pid)]);
      return parseNativeProcessLookupDetails(toText(stdout));
    } catch {
      this.disabled = true;
      return undefined;
    }
  }

  /**
   * Like inspectProcess but also captures the exact argv and environment, used
   * to compose a faithful respawn of an escaped (unhooked) server. Kept separate
   * so the hot inspect path stays compact.
   */
  async captureProcess(pid: number): Promise<NativeProcessLookupDetails | undefined> {
    if (this.disabled || process.platform === "win32" || !isPositiveInteger(pid)) {
      return undefined;
    }

    try {
      const { stdout } = await this.runCommand(this.helperPath, ["capture", String(pid)]);
      return parseNativeProcessLookupDetails(toText(stdout));
    } catch {
      this.disabled = true;
      return undefined;
    }
  }
}

export function getProcessLookupHelperRelativePath(): string {
  return path.join("media", "native", "portmanager_process_lookup");
}

export function parseNativeProcessTableRows(output: string): readonly ProcessTableRow[] {
  const parsed = JSON.parse(output) as unknown;
  const rows = asRecord(parsed)?.rows;

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map(parseNativeProcessTableRow).filter((row): row is ProcessTableRow => row !== undefined);
}

export function parseNativeProcessLookupDetails(output: string): NativeProcessLookupDetails {
  const parsed = asRecord(JSON.parse(output) as unknown);
  const row = parseNativeProcessTableRow(parsed?.row);
  const ancestorPids = Array.isArray(parsed?.ancestorPids)
    ? parsed.ancestorPids.filter(isPositiveInteger)
    : [];
  const cwd = parseNonEmptyString(parsed?.cwd);
  const networkId = parseNonEmptyString(parsed?.networkId);
  const argv = Array.isArray(parsed?.argv)
    ? parsed.argv.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const env = Array.isArray(parsed?.env)
    ? parsed.env.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    ...(row === undefined ? {} : { row }),
    ancestorPids,
    ...(cwd === undefined ? {} : { cwd }),
    ...(networkId === undefined ? {} : { networkId }),
    ...(argv === undefined ? {} : { argv }),
    ...(env === undefined ? {} : { env }),
  };
}

function parseNativeProcessTableRow(value: unknown): ProcessTableRow | undefined {
  const row = asRecord(value);
  if (row === undefined) {
    return undefined;
  }

  const pid = row?.pid;
  const parentPid = row?.parentPid;
  const processGroupId = row?.processGroupId;

  if (
    !isPositiveInteger(pid) ||
    typeof parentPid !== "number" ||
    !Number.isInteger(parentPid) ||
    typeof processGroupId !== "number" ||
    !Number.isInteger(processGroupId)
  ) {
    return undefined;
  }

  const terminalId = parseNonEmptyString(row.terminalId);

  return {
    pid,
    parentPid,
    processGroupId,
    ...(terminalId === undefined ? {} : { terminalId }),
  };
}

function resolveDefaultProcessLookupHelperPath(): string {
  return path.resolve(__dirname, "..", "..", "..", "..", getProcessLookupHelperRelativePath());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function toText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

async function runExecFile(file: string, args: readonly string[]): Promise<CommandResult> {
  return execFileAsync(file, [...args], {
    maxBuffer: 1024 * 1024,
    timeout: NATIVE_PROCESS_LOOKUP_TIMEOUT_MS,
  });
}

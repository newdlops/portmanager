import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeProcessLookupProvider } from "./native-process-lookup";

const execFileAsync = promisify(execFile);
const PROCESS_TABLE_SNAPSHOT_TTL_MS = 250;

export interface ProcessTableRow {
  /** OS process id. */
  readonly pid: number;
  /** Parent process id used to walk from app process back to terminal shell. */
  readonly parentPid: number;
  /** POSIX process group id when available. */
  readonly processGroupId?: number;
  /** Controlling terminal id, normalized without /dev/. */
  readonly terminalId?: string;
}

export interface ProcessTreeContext {
  /** Process table row for the client or listener process. */
  readonly row: ProcessTableRow;
  /** Parent chain from direct parent up to the visible root. */
  readonly ancestorPids: readonly number[];
}

interface CommandResult {
  readonly stdout: string | Buffer;
}

type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

interface NodeProcessTableProviderOptions {
  /** Injectable command boundary so unit tests can use fixed process tables. */
  readonly commandRunner?: CommandRunner;
  /** Optional native helper used before the shell-command fallback. */
  readonly nativeLookupProvider?: NativeProcessLookupProvider;
  /** Packaged native helper path passed by the VS Code extension context. */
  readonly nativeLookupPath?: string;
}

interface ProcessTableSnapshot {
  readonly rows: readonly ProcessTableRow[];
  readonly expiresAtMs: number;
}

/**
 * Reads the local process table needed to map arbitrary processes to terminals.
 *
 * This adapter intentionally exposes only PID, PPID, PGID, and TTY. Higher
 * layers decide what those identifiers mean for network attachment state.
 */
export class NodeProcessTableProvider {
  private readonly runCommand: CommandRunner;
  /** Optional C helper for low-latency process table snapshots. */
  private readonly nativeLookupProvider?: NativeProcessLookupProvider;
  /** Point-in-time process table shared by router connections in the same burst. */
  private snapshot?: ProcessTableSnapshot;

  /** In-flight ps call reused by concurrent ancestry checks. */
  private request?: Promise<readonly ProcessTableRow[]>;

  constructor(options: NodeProcessTableProviderOptions = {}) {
    this.runCommand = options.commandRunner ?? runExecFile;
    this.nativeLookupProvider =
      options.nativeLookupProvider ??
      (options.commandRunner === undefined || options.nativeLookupPath !== undefined
        ? new NativeProcessLookupProvider({ helperPath: options.nativeLookupPath })
        : undefined);
  }

  /** Returns one process-table snapshot for terminal ancestry checks. */
  async list(): Promise<readonly ProcessTableRow[]> {
    if (process.platform === "win32") {
      return [];
    }

    const now = Date.now();

    if (this.snapshot !== undefined && this.snapshot.expiresAtMs > now) {
      return this.snapshot.rows;
    }

    if (this.request !== undefined) {
      return this.request;
    }

    let request: Promise<readonly ProcessTableRow[]>;
    request = this.readRows()
      .then((rows) => {
        this.snapshot = {
          rows,
          expiresAtMs: Date.now() + PROCESS_TABLE_SNAPSHOT_TTL_MS,
        };
        return rows;
      })
      .finally(() => {
        if (this.request === request) {
          this.request = undefined;
        }
      });

    this.request = request;
    return request;
  }

  /** Reads native rows first, preserving the previous ps implementation as fallback. */
  private async readRows(): Promise<readonly ProcessTableRow[]> {
    if (this.nativeLookupProvider !== undefined) {
      const nativeRows = await this.nativeLookupProvider.listProcessTableRows();
      if (nativeRows !== undefined) {
        return nativeRows;
      }
    }

    const { stdout } = await this.runCommand("ps", ["-Ao", "pid=,ppid=,pgid=,tty="]);
    return parsePosixProcessTable(toText(stdout));
  }
}

/** Parses POSIX ps output containing pid, ppid, pgid, and tty columns. */
export function parsePosixProcessTable(output: string): readonly ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) {
      continue;
    }

    const [, pidText, parentPidText, processGroupIdText, terminalIdText] = match;
    const pid = Number.parseInt(pidText, 10);
    const parentPid = Number.parseInt(parentPidText, 10);
    const processGroupId = Number.parseInt(processGroupIdText, 10);

    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || !Number.isInteger(processGroupId)) {
      continue;
    }

    rows.push({
      pid,
      parentPid,
      processGroupId,
      terminalId: terminalIdText === "?" ? undefined : terminalIdText.replace(/^\/dev\//, ""),
    });
  }

  return rows;
}

/** Builds ancestry context for one process from a point-in-time table. */
export function buildProcessTreeContext(
  rows: readonly ProcessTableRow[],
  pid: number,
): ProcessTreeContext | undefined {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const row = byPid.get(pid);
  const ancestorPids: number[] = [];
  const seen = new Set<number>([pid]);

  if (row === undefined) {
    return undefined;
  }

  let cursor: ProcessTableRow = row;

  while (cursor.parentPid > 0 && !seen.has(cursor.parentPid)) {
    const parent = byPid.get(cursor.parentPid);
    if (parent === undefined) {
      break;
    }

    ancestorPids.push(parent.pid);
    seen.add(parent.pid);
    cursor = parent;
  }

  return { row, ancestorPids };
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

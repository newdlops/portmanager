import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalCandidate, TerminalCandidateProvider } from "../../shared/types";

const execFileAsync = promisify(execFile);

/**
 * Best-effort terminal discovery backed by the local OS process table.
 *
 * The provider favors shell processes because those are the stable roots whose
 * descendants launch development servers. Platform differences and permission
 * limits mean cwd/tty/process group are optional rather than guaranteed.
 */
export class NodeTerminalCandidateProvider implements TerminalCandidateProvider {
  /** Lists terminal-like processes for the current platform. */
  async list(): Promise<readonly TerminalCandidate[]> {
    if (process.platform === "win32") {
      return listWindowsTerminals();
    }

    return listPosixTerminals();
  }
}

interface PosixProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly terminalId?: string;
  readonly name: string;
  readonly command?: string;
}

interface WindowsProcessRow {
  readonly ProcessId?: number;
  readonly ParentProcessId?: number;
  readonly Name?: string;
  readonly CommandLine?: string;
}

/** Uses ps so macOS and Linux share one process scanner path. */
async function listPosixTerminals(): Promise<readonly TerminalCandidate[]> {
  const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,pgid=,tty=,comm=,args="], {
    maxBuffer: 1024 * 1024,
  });

  return stdout
    .split(/\r?\n/)
    .map(parsePosixProcessRow)
    .filter((row): row is PosixProcessRow => row !== undefined)
    .filter(isTerminalLikePosixRow)
    .map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      processGroupId: row.processGroupId,
      terminalId: row.terminalId,
      name: row.name,
      command: row.command,
      vscodeTerminal: false,
    }));
}

/** Parses the fixed leading ps columns while preserving spaces in args. */
function parsePosixProcessRow(line: string): PosixProcessRow | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (match === null) {
    return undefined;
  }

  const [, pidText, parentPidText, processGroupIdText, terminalId, commandName, command] = match;
  const pid = Number.parseInt(pidText, 10);
  const parentPid = Number.parseInt(parentPidText, 10);
  const processGroupId = Number.parseInt(processGroupIdText, 10);

  if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || !Number.isInteger(processGroupId)) {
    return undefined;
  }

  return {
    pid,
    parentPid,
    processGroupId,
    terminalId: terminalId === "?" ? undefined : terminalId,
    name: basename(commandName),
    command,
  };
}

/** Shell roots are the actionable terminal candidates for network attach. */
function isTerminalLikePosixRow(row: PosixProcessRow): boolean {
  const name = row.name.toLowerCase();
  const command = row.command?.toLowerCase() ?? "";

  return (
    POSIX_SHELL_NAMES.has(name) ||
    name.endsWith("sh") ||
    command.includes(" vscode-shell-integration") ||
    command.includes("shellintegration")
  );
}

/** Uses PowerShell's process API on Windows where ps output is not portable. */
async function listWindowsTerminals(): Promise<readonly TerminalCandidate[]> {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    maxBuffer: 1024 * 1024,
  });

  const rows = parseWindowsProcessRows(stdout);

  return rows
    .filter(isTerminalLikeWindowsRow)
    .map((row) => ({
      pid: row.ProcessId ?? 0,
      parentPid: row.ParentProcessId,
      name: row.Name ?? `Process ${row.ProcessId ?? "unknown"}`,
      command: row.CommandLine,
      vscodeTerminal: false,
    }))
    .filter((candidate) => candidate.pid > 0);
}

/** Handles PowerShell's single-object and array JSON shapes. */
function parseWindowsProcessRows(rawJson: string): readonly WindowsProcessRow[] {
  if (rawJson.trim().length === 0) {
    return [];
  }

  const parsed = JSON.parse(rawJson) as WindowsProcessRow | WindowsProcessRow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isTerminalLikeWindowsRow(row: WindowsProcessRow): boolean {
  const name = (row.Name ?? "").toLowerCase();
  const command = (row.CommandLine ?? "").toLowerCase();

  return WINDOWS_SHELL_NAMES.has(name) || command.includes("windows terminal") || command.includes("wsl.exe");
}

/** Keeps process display names compact across absolute executable paths. */
function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? value : normalized.slice(index + 1);
}

const POSIX_SHELL_NAMES = new Set([
  "bash",
  "dash",
  "fish",
  "ksh",
  "nu",
  "pwsh",
  "sh",
  "tcsh",
  "zsh",
]);

const WINDOWS_SHELL_NAMES = new Set([
  "bash.exe",
  "cmd.exe",
  "nu.exe",
  "powershell.exe",
  "pwsh.exe",
  "wsl.exe",
]);

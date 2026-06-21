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

interface TerminalTitleRow {
  /** Normalized tty id such as ttys003. */
  readonly terminalId: string;
  /** Title reported by Terminal.app or iTerm2. */
  readonly title: string;
}

interface WindowsProcessRow {
  readonly ProcessId?: number;
  readonly ParentProcessId?: number;
  readonly Name?: string;
  readonly CommandLine?: string;
}

/** Uses ps so macOS and Linux share one process scanner path. */
async function listPosixTerminals(): Promise<readonly TerminalCandidate[]> {
  const [{ stdout }, titleByTerminalId] = await Promise.all([
    execFileAsync("ps", ["-Ao", "pid=,ppid=,pgid=,tty=,comm=,args="], {
      maxBuffer: 1024 * 1024,
    }),
    listTerminalTitlesByTty(),
  ]);

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
      windowTitle: row.terminalId === undefined ? undefined : titleByTerminalId.get(row.terminalId),
      name: row.name,
      command: row.command,
      vscodeTerminal: false,
    }));
}

/** Returns terminal window/tab titles keyed by tty when the platform exposes them. */
async function listTerminalTitlesByTty(): Promise<ReadonlyMap<string, string>> {
  if (process.platform !== "darwin") {
    return new Map();
  }

  const [terminalRows, itermRows] = await Promise.all([listMacTerminalAppTitles(), listMacItermTitles()]);
  const titles = new Map<string, string>();

  for (const row of [...terminalRows, ...itermRows]) {
    if (row.title.trim().length === 0 || titles.has(row.terminalId)) {
      continue;
    }

    titles.set(row.terminalId, row.title.trim());
  }

  return titles;
}

/** Reads Terminal.app tab titles. The app check avoids launching Terminal. */
async function listMacTerminalAppTitles(): Promise<readonly TerminalTitleRow[]> {
  if (!(await isMacApplicationRunning("Terminal"))) {
    return [];
  }

  const script = `
tell application "Terminal"
  set outputText to ""
  repeat with windowItem in windows
    repeat with tabItem in tabs of windowItem
      set titleText to ""
      try
        set titleText to custom title of tabItem
      end try
      if titleText is missing value or titleText is "" then
        try
          set titleText to name of windowItem
        end try
      end if
      set outputText to outputText & (tty of tabItem) & tab & titleText & linefeed
    end repeat
  end repeat
  return outputText
end tell
`;

  return runMacTerminalTitleScript(script);
}

/** Reads iTerm2 session titles. The app check avoids launching iTerm2. */
async function listMacItermTitles(): Promise<readonly TerminalTitleRow[]> {
  if (!(await isMacApplicationRunning("iTerm2"))) {
    return [];
  }

  const script = `
tell application "iTerm2"
  set outputText to ""
  repeat with windowItem in windows
    repeat with tabItem in tabs of windowItem
      repeat with sessionItem in sessions of tabItem
        set titleText to ""
        try
          set titleText to name of sessionItem
        end try
        set outputText to outputText & (tty of sessionItem) & tab & titleText & linefeed
      end repeat
    end repeat
  end repeat
  return outputText
end tell
`;

  return runMacTerminalTitleScript(script);
}

/** Checks running apps without activating or launching them. */
async function isMacApplicationRunning(processName: string): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-x", processName], {
      maxBuffer: 64 * 1024,
      timeout: 500,
    });
    return true;
  } catch {
    return false;
  }
}

/** Runs one AppleScript title query and parses tty/title rows. */
async function runMacTerminalTitleScript(script: string): Promise<readonly TerminalTitleRow[]> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      maxBuffer: 256 * 1024,
      timeout: 1000,
    });

    return parseTerminalTitleRows(stdout);
  } catch {
    return [];
  }
}

/** Parses osascript output shaped as tty<TAB>title. */
function parseTerminalTitleRows(output: string): readonly TerminalTitleRow[] {
  return output
    .split(/\r?\n/)
    .map((line) => {
      const [terminalId, ...titleParts] = line.split("\t");
      const normalizedTerminalId = normalizeTerminalId(terminalId);
      const title = titleParts.join("\t").trim();

      if (normalizedTerminalId.length === 0 || title.length === 0) {
        return undefined;
      }

      return {
        terminalId: normalizedTerminalId,
        title,
      };
    })
    .filter((row): row is TerminalTitleRow => row !== undefined);
}

/** Normalizes /dev/ttys003 and ttys003 to the same key used by ps. */
function normalizeTerminalId(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }

  return value.trim().replace(/^\/dev\//, "");
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

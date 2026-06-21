import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { PortAvailability, PortAvailabilityProvider, ProcessSnapshot } from "../../shared/types";

const execFileAsync = promisify(execFile);

/**
 * Node-based TCP port scanner for the platform layer.
 *
 * Availability is determined by asking Node to bind a temporary server to the
 * target port. Owner details are intentionally a second best-effort step so a
 * missing OS command does not prevent core routing from receiving a useful
 * busy/free answer.
 */
export class NodePortScanner implements PortAvailabilityProvider {
  /**
   * Checks whether Node can bind to the requested TCP port on the given host.
   * A busy port remains a valid result even when platform owner lookup fails.
   */
  async check(port: number, host = "127.0.0.1"): Promise<PortAvailability> {
    if (!isValidPort(port)) {
      return {
        port,
        available: false,
        errorMessage: `Port must be an integer between 1 and 65535: ${port}`,
      };
    }

    const bindResult = await checkBindAvailability(port, host);

    if (bindResult.available) {
      return { port, available: true };
    }

    const ownerResult = await findPortOwner(port);

    return {
      port,
      available: false,
      owner: ownerResult.owner,
      errorMessage: mergeMessages(bindResult.errorMessage, ownerResult.errorMessage),
    };
  }
}

interface BindAvailabilityResult {
  /** True when a short-lived Node TCP server successfully claimed the port. */
  readonly available: boolean;
  /** Bind failure details retained for permission and invalid-host diagnostics. */
  readonly errorMessage?: string;
}

interface OwnerLookupResult {
  /** Best-effort listener process details returned by a platform command. */
  readonly owner?: ProcessSnapshot;
  /** Command failure details kept separate from the availability signal. */
  readonly errorMessage?: string;
}

/**
 * Tries to bind a temporary server and immediately closes it on success.
 * Binding is the most reliable low-level signal because it mirrors what the
 * managed child process will need to do when it starts.
 */
async function checkBindAvailability(port: number, host: string): Promise<BindAvailabilityResult> {
  const server = createServer();

  return new Promise<BindAvailabilityResult>((resolve) => {
    let resolved = false;

    const finish = (result: BindAvailabilityResult) => {
      if (resolved) {
        return;
      }

      resolved = true;
      server.removeAllListeners();
      resolve(result);
    };

    server.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        available: false,
        errorMessage: error.code === "EADDRINUSE" ? undefined : error.message,
      });
    });

    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => {
        finish({
          available: !error,
          errorMessage: error?.message,
        });
      });
    });
  });
}

/**
 * Dispatches owner lookup to the current operating system.
 * Failures are converted to optional diagnostics instead of thrown because the
 * routing decision only requires the availability boolean.
 */
async function findPortOwner(port: number): Promise<OwnerLookupResult> {
  try {
    if (platform() === "win32") {
      return { owner: await findWindowsPortOwner(port) };
    }

    return { owner: await findPosixPortOwner(port) };
  } catch (error) {
    return { errorMessage: toErrorMessage(error) };
  }
}

/**
 * Uses lsof's field output so parsing does not depend on column spacing.
 * The command can still fail when lsof is absent or permissions hide details.
 */
async function findPosixPortOwner(port: number): Promise<ProcessSnapshot | undefined> {
  const { stdout } = await execFileAsync("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-Fpnc",
  ]);

  return parseLsofFieldOutput(stdout);
}

/**
 * Uses PowerShell's TCP connection table and joins it with process metadata.
 * ConvertTo-Json gives a stable parse target across localized Windows output.
 */
async function findWindowsPortOwner(port: number): Promise<ProcessSnapshot | undefined> {
  const script = [
    `$connection = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if ($null -eq $connection) { return }",
    "$process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue",
    "[pscustomobject]@{",
    "  pid = $connection.OwningProcess;",
    "  name = $process.ProcessName;",
    "  command = $process.Path",
    "} | ConvertTo-Json -Compress",
  ].join("; ");

  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);

  return parseWindowsOwnerJson(stdout);
}

/**
 * Parses lsof's `-F` records. Each listener starts with a `p` PID record and
 * may be followed by command/name fields; the first complete process is enough.
 */
function parseLsofFieldOutput(output: string): ProcessSnapshot | undefined {
  let pid: number | undefined;
  let name: string | undefined;
  let command: string | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    const fieldType = line[0];
    const value = line.slice(1);

    if (fieldType === "p") {
      const parsedPid = Number.parseInt(value, 10);

      if (Number.isInteger(parsedPid)) {
        pid = parsedPid;
      }
    }

    if (fieldType === "c") {
      name = value || undefined;
      command = value || command;
    }

    if (pid !== undefined && name !== undefined) {
      return { pid, name, command };
    }
  }

  return pid === undefined ? undefined : { pid, name, command };
}

/**
 * Parses the compact JSON produced by the Windows owner lookup script.
 * Empty output simply means the port became unavailable to inspect.
 */
function parseWindowsOwnerJson(output: string): ProcessSnapshot | undefined {
  const trimmedOutput = output.trim();

  if (trimmedOutput.length === 0) {
    return undefined;
  }

  const parsed = JSON.parse(trimmedOutput) as {
    pid?: unknown;
    name?: unknown;
    command?: unknown;
  };

  const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
  const name = typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : undefined;
  const command = typeof parsed.command === "string" && parsed.command.length > 0 ? parsed.command : undefined;

  return pid === undefined && name === undefined && command === undefined ? undefined : { pid, name, command };
}

/** Ensures invalid input becomes a domain result instead of a thrown Node error. */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Converts unknown platform command failures into short diagnostics. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Preserves both bind and owner diagnostics without hiding the busy result. */
function mergeMessages(first?: string, second?: string): string | undefined {
  if (first === undefined) {
    return second;
  }

  if (second === undefined) {
    return first;
  }

  return `${first}; ${second}`;
}

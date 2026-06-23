import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeProcessLookupProvider } from "./native-process-lookup";

const execFileAsync = promisify(execFile);
const PROCESS_ENVIRONMENT_CACHE_TTL_MS = 5000;

const ROUTING_NETWORK_VARIABLES = [
  "PORT_MANAGER_NETWORK_ID",
  "PORT_MANAGER_BORROWED_NETWORK_ID",
  "NEWDLOPS_PM_NETWORK_ID",
  "NEWDLOPS_PM_BORROWED_NETWORK_ID",
] as const;

interface CommandResult {
  readonly stdout: string | Buffer;
}

type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

interface NodeProcessEnvironmentProviderOptions {
  /** Injectable command boundary so tests can parse fixed process output. */
  readonly commandRunner?: CommandRunner;
  /** Optional native helper used before the shell-command fallback. */
  readonly nativeLookupProvider?: NativeProcessLookupProvider;
  /** Packaged native helper path passed by the VS Code extension context. */
  readonly nativeLookupPath?: string;
}

interface ProcessEnvironmentSnapshot {
  readonly networkId?: string;
  readonly expiresAtMs: number;
}

/**
 * Reads Port Manager routing scope from another local process.
 *
 * Logical-port router clients can be short-lived tools such as wait-on. Their
 * parent terminal may be hard to map from persisted attachment state, but the
 * native hook script gives descendants an explicit network id in environment.
 */
export class NodeProcessEnvironmentProvider {
  private readonly runCommand: CommandRunner;
  /** Optional C helper for same-user environment lookup without ps parsing. */
  private readonly nativeLookupProvider?: NativeProcessLookupProvider;
  /** Short-lived per-PID routing-scope cache for bursty logical router clients. */
  private readonly snapshotsByPid = new Map<number, ProcessEnvironmentSnapshot>();

  /** In-flight per-PID environment reads so duplicate router connections share one ps call. */
  private readonly requestsByPid = new Map<number, Promise<string | undefined>>();

  constructor(options: NodeProcessEnvironmentProviderOptions = {}) {
    this.runCommand = options.commandRunner ?? runExecFile;
    this.nativeLookupProvider =
      options.nativeLookupProvider ??
      (options.commandRunner === undefined || options.nativeLookupPath !== undefined
        ? new NativeProcessLookupProvider({ helperPath: options.nativeLookupPath })
        : undefined);
  }

  /** Returns the inherited logical network id for a process, when visible. */
  async readRoutingNetworkId(pid: number): Promise<string | undefined> {
    if (!isPositiveInteger(pid) || process.platform === "win32") {
      return undefined;
    }

    const now = Date.now();
    const cached = this.snapshotsByPid.get(pid);

    if (cached !== undefined) {
      if (cached.expiresAtMs > now) {
        return cached.networkId;
      }

      this.snapshotsByPid.delete(pid);
    }

    const currentRequest = this.requestsByPid.get(pid);
    if (currentRequest !== undefined) {
      return currentRequest;
    }

    let request: Promise<string | undefined>;
    request = this.readNetworkId(pid)
      .then((networkId) => {
        this.snapshotsByPid.set(pid, {
          networkId,
          expiresAtMs: Date.now() + PROCESS_ENVIRONMENT_CACHE_TTL_MS,
        });
        return networkId;
      })
      .finally(() => {
        if (this.requestsByPid.get(pid) === request) {
          this.requestsByPid.delete(pid);
        }
      });

    this.requestsByPid.set(pid, request);
    return request;
  }

  /** Reads native environment first, preserving ps output parsing as fallback. */
  private async readNetworkId(pid: number): Promise<string | undefined> {
    if (this.nativeLookupProvider !== undefined) {
      const nativeNetworkId = (await this.nativeLookupProvider.inspectProcess(pid))?.networkId;
      if (nativeNetworkId !== undefined) {
        return nativeNetworkId;
      }
    }

    const { stdout } = await this.runCommand("ps", ["eww", "-p", String(pid)]);
    return parseRoutingNetworkIdFromProcessEnvironment(toText(stdout));
  }
}

/** Extracts the routing network id from `ps eww` output. */
export function parseRoutingNetworkIdFromProcessEnvironment(output: string): string | undefined {
  for (const variable of ROUTING_NETWORK_VARIABLES) {
    const match = new RegExp(`(?:^|\\s)${escapeRegExp(variable)}=([^\\s]+)`).exec(output);
    const value = match?.[1]?.trim();

    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

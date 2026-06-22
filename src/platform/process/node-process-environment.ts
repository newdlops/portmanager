import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

  constructor(options: NodeProcessEnvironmentProviderOptions = {}) {
    this.runCommand = options.commandRunner ?? runExecFile;
  }

  /** Returns the inherited logical network id for a process, when visible. */
  async readRoutingNetworkId(pid: number): Promise<string | undefined> {
    if (!isPositiveInteger(pid) || process.platform === "win32") {
      return undefined;
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

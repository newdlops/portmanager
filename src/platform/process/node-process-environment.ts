import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ListeningPort, RegisteredProcessInput } from "../../shared/types";
import { NativeProcessLookupProvider } from "./native-process-lookup";

const execFileAsync = promisify(execFile);
const PROCESS_ENVIRONMENT_CACHE_TTL_MS = 5000;

const ROUTING_NETWORK_VARIABLES = [
  "PORT_MANAGER_NETWORK_ID",
  "PORT_MANAGER_BORROWED_NETWORK_ID",
  "NEWDLOPS_PM_NETWORK_ID",
  "NEWDLOPS_PM_BORROWED_NETWORK_ID",
] as const;
const HOOK_MARKER_VARIABLES = [
  "PORT_MANAGER_HOOK",
  "PORT_MANAGER_DYLD_INSERT_LIBRARIES",
  "PORT_MANAGER_AGENT_SOCKET",
  "PORT_MANAGER_ROUTES_FILE",
] as const;

interface CommandResult {
  readonly stdout: string | Buffer;
}

type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;
type NativeProcessInspector = Pick<NativeProcessLookupProvider, "inspectProcess">;

interface NodeProcessEnvironmentProviderOptions {
  /** Injectable command boundary so tests can parse fixed process output. */
  readonly commandRunner?: CommandRunner;
  /** Optional native helper used before the shell-command fallback. */
  readonly nativeLookupProvider?: NativeProcessInspector;
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
  private readonly nativeLookupProvider?: NativeProcessInspector;
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

  /**
   * Rebuilds a hook-owned listener registration for an already-running process.
   * This is used only after daemon restart, when the in-memory registry is gone
   * but the process still carries Port Manager environment and owns a routed
   * actual listening port.
   */
  async recoverHookRoute(listener: ListeningPort): Promise<RegisteredProcessInput | undefined> {
    const pid = listener.pid;
    if (!isPositiveInteger(pid) || process.platform === "win32") {
      return undefined;
    }

    const [nativeDetails, environmentOutput, commandOutput] = await Promise.all([
      this.nativeLookupProvider?.inspectProcess(pid).catch(() => undefined),
      this.readProcessEnvironmentText(pid).catch(() => undefined),
      this.readProcessCommandText(pid).catch(() => undefined),
    ]);

    if (environmentOutput === undefined || !hasPortManagerHookEnvironment(environmentOutput)) {
      return undefined;
    }

    const command = normalizeCommandText(commandOutput) ?? listener.command ?? listener.processName ?? `pid ${pid}`;
    if (isHookRecoveryHelperCommand(command)) {
      return undefined;
    }

    const requestedPort = inferRequestedPortFromCommand(command, listener.port);
    if (requestedPort === undefined || requestedPort === listener.port) {
      return undefined;
    }

    const cwd =
      nativeDetails?.cwd ??
      parseProcessEnvironmentValue(environmentOutput, ["PWD", "INIT_CWD"]) ??
      "";
    const networkId = nativeDetails?.networkId ?? parseRoutingNetworkIdFromProcessEnvironment(environmentOutput);

    return {
      pid,
      name: listener.processName ?? inferProcessName(command),
      command,
      cwd,
      requestedPort,
      actualPort: listener.port,
      host: normalizeListeningHost(listener.localAddress),
      ...(networkId === undefined ? {} : { networkId }),
      source: "hooked",
    };
  }

  /** Reads native environment first, preserving ps output parsing as fallback. */
  private async readNetworkId(pid: number): Promise<string | undefined> {
    if (this.nativeLookupProvider !== undefined) {
      const nativeNetworkId = (await this.nativeLookupProvider.inspectProcess(pid))?.networkId;
      if (nativeNetworkId !== undefined) {
        return nativeNetworkId;
      }
    }

    return parseRoutingNetworkIdFromProcessEnvironment(await this.readProcessEnvironmentText(pid));
  }

  private async readProcessEnvironmentText(pid: number): Promise<string> {
    const { stdout } = await this.runCommand("ps", ["eww", "-p", String(pid)]);
    return toText(stdout);
  }

  private async readProcessCommandText(pid: number): Promise<string> {
    const { stdout } = await this.runCommand("ps", ["-o", "command=", "-p", String(pid)]);
    return toText(stdout);
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

/** Infers the logical port still present in the process command line. */
export function inferRequestedPortFromCommand(command: string, actualPort?: number): number | undefined {
  const candidates: number[] = [];

  for (const pattern of [
    /(?:^|\s)(?:--(?:port|listen-port|http-port|server-port))(?:=|\s+)(?:[^\s:]+:)?(\d{1,5})(?=$|\s|\/)/gi,
    /(?:^|\s)-p\s+(?:[^\s:]+:)?(\d{1,5})(?=$|\s|\/)/gi,
    /(?:^|\s)(?:runserver|serve|http\.server)\s+(?:[^\s:]+:)?(\d{1,5})(?=$|\s|\/)/gi,
    /(?:^|\s)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\*)[:=](\d{1,5})(?=$|\s|\/)/gi,
  ]) {
    for (const match of command.matchAll(pattern)) {
      pushValidPort(candidates, match[1]);
    }
  }

  if (candidates.length === 0) {
    for (const match of command.matchAll(/(?:^|[^\w.-])(\d{2,5})(?=$|[^\w.-])/g)) {
      const port = parseTcpPort(match[1]);
      if (port !== undefined && port >= 1024) {
        candidates.push(port);
      }
    }
  }

  return [...candidates].reverse().find((port) => actualPort === undefined || port !== actualPort);
}

function hasPortManagerHookEnvironment(output: string): boolean {
  return HOOK_MARKER_VARIABLES.some((variable) => parseProcessEnvironmentValue(output, [variable]) !== undefined);
}

function isHookRecoveryHelperCommand(command: string): boolean {
  const normalized = command.toLowerCase();

  /*
   * Debug adapters inherit the terminal hook and often listen on transient
   * coordination ports. They are not user-facing application listeners, so
   * rehydrating them would open localhost routers for debugger internals.
   */
  return normalized.includes("debugpy/adapter") || normalized.includes("debugpy.adapter");
}

function parseProcessEnvironmentValue(output: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const match = new RegExp(`(?:^|\\s)${escapeRegExp(name)}=([^\\s]+)`).exec(output);
    const value = match?.[1]?.trim();

    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function normalizeCommandText(output: string | undefined): string | undefined {
  const command = output?.trim();
  return command && command.length > 0 ? command : undefined;
}

function inferProcessName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0];
  return firstToken && firstToken.length > 0 ? firstToken : "hooked process";
}

function normalizeListeningHost(localAddress: string): string {
  if (localAddress === "*" || localAddress === "::" || localAddress === "0.0.0.0") {
    return "127.0.0.1";
  }

  return localAddress;
}

function pushValidPort(ports: number[], value: string | undefined): void {
  const port = parseTcpPort(value);
  if (port !== undefined) {
    ports.push(port);
  }
}

function parseTcpPort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined;
  }

  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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

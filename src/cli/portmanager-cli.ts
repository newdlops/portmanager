#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getAgentSocketPath, removeStaleSocketFile } from "../agent/agent-socket";
import { getDefaultRouteTablePath } from "../agent/route-table";
import {
  encodeAgentMessage,
  NdjsonMessageBuffer,
  type AgentRequestMethod,
  type AgentRequestMessage,
} from "../agent/protocol";
import { buildReroutableCommand } from "../core/terminal-conflict-parser";
import { buildInjectedCommand, buildPortManagerEnvironment } from "../platform/process/port-injection";
import { buildNodeRuntimeEnvironment } from "../platform/process/node-runtime";
import { DEFAULT_PORT_MANAGER_SETTINGS } from "../shared/default-settings";
import type {
  AgentAllocateRouteRequest,
  ManagedProcess,
  PortInjectionMode,
  PortRouteAllocation,
  PortRoutingMode,
  ScanDirection,
} from "../shared/types";

/**
 * External terminal CLI for Port Manager.
 *
 * VS Code terminal events cannot see commands launched from Terminal.app,
 * iTerm, Windows Terminal, or other OS shells. This wrapper gives those
 * commands an explicit daemon-managed launch path.
 */

type CliCommand = "run" | "status" | "help";
type InjectionOption = PortInjectionMode | "auto";

interface ParsedCli {
  /** Top-level CLI command selected by the user. */
  readonly command: CliCommand;
  /** Options only present for the run command. */
  readonly run?: RunOptions;
}

interface RunOptions {
  /** Logical port the wrapped application expects to use. */
  readonly requestedPort: number;
  /** Host used for availability checks and route metadata. */
  readonly host: string;
  /** Working directory for the child process. */
  readonly cwd: string;
  /** User-facing process label registered with the daemon. */
  readonly name: string;
  /** Original command before actual-port injection. */
  readonly command: string;
  /** Injection strategy, or auto-detect from the command text. */
  readonly injectionMode: InjectionOption;
  /** Number of candidates to inspect when routing. */
  readonly scanRange: number;
  /** Candidate scan direction for nearest routing. */
  readonly scanDirection: ScanDirection;
  /** Routing policy used by the daemon. */
  readonly routingMode: PortRoutingMode;
  /** First actual port in hashed routing mode. */
  readonly virtualPortRangeStart: number;
  /** Last actual port in hashed routing mode. */
  readonly virtualPortRangeEnd: number;
}

interface AgentResponse<T = unknown> {
  /** Agent protocol response marker. */
  readonly type: "response";
  /** Correlates the response with one request. */
  readonly id: string;
  /** Whether the agent accepted and completed the request. */
  readonly ok: boolean;
  /** Successful method payload. */
  readonly payload?: T;
  /** Failure message returned by the daemon. */
  readonly error?: string;
}

interface PendingRequest {
  /** Resolves one in-flight request. */
  readonly resolve: (value: unknown) => void;
  /** Rejects one in-flight request. */
  readonly reject: (error: Error) => void;
  /** Timeout guard for daemon requests. */
  readonly timer: NodeJS.Timeout;
}

void main(process.argv.slice(2));

/** Runs the selected CLI command and maps failures to process exit codes. */
async function main(args: readonly string[]): Promise<void> {
  try {
    const parsed = parseCli(args);

    if (parsed.command === "help") {
      printUsage();
      return;
    }

    const client = new AgentCliClient(resolveAgentMainPath(), resolveNativeAgentPath());
    await client.connectOrStart();

    if (parsed.command === "status") {
      const snapshot = await client.request<{ agentPid: number; daemon?: { listenerCount: number; routeCount: number } }>(
        "refreshSnapshot",
      );
      console.log(
        `Port Manager daemon pid ${snapshot.agentPid}; listeners ${snapshot.daemon?.listenerCount ?? 0}; routes ${snapshot.daemon?.routeCount ?? 0}`,
      );
      client.dispose();
      return;
    }

    if (parsed.run === undefined) {
      throw new Error("Missing run options.");
    }

    await runManagedCommand(client, parsed.run);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/** Allocates a route through the daemon and runs the command in this terminal. */
async function runManagedCommand(client: AgentCliClient, options: RunOptions): Promise<void> {
  const effectiveCommand = buildEffectiveCommand(options);
  const allocation = await client.request<PortRouteAllocation>("allocateRoute", buildAllocationRequest(options));
  const injectedCommand = buildInjectedCommand({
    command: effectiveCommand.command,
    actualPort: allocation.actualPort,
    injectionMode: effectiveCommand.injectionMode,
  });
  const environment = buildPortManagerEnvironment({
    baseEnv: process.env,
    requestedPort: allocation.requestedPort,
    actualPort: allocation.actualPort,
    logicalRoutes: allocation.logicalRoutes,
    logicalRoutesFile: allocation.logicalRoutesFile,
  });

  console.error(
    `[portmanager] ${allocation.requestedPort} -> ${allocation.actualPort} (${options.routingMode})`,
  );

  const child = spawn(injectedCommand, {
    cwd: options.cwd,
    env: environment,
    shell: true,
    stdio: "inherit",
  });

  let processId: string | undefined;
  let cleaned = false;

  child.once("spawn", () => {
    void client
      .request<ManagedProcess>("registerExistingProcess", {
        pid: requireChildPid(child),
        name: options.name,
        command: options.command,
        cwd: options.cwd,
        requestedPort: allocation.requestedPort,
        actualPort: allocation.actualPort,
        host: allocation.host,
        allocationId: allocation.allocationId,
      })
      .then((process) => {
        processId = process.id;
      })
      .catch((error: unknown) => {
        console.error(`[portmanager] failed to register process: ${toErrorMessage(error)}`);
      });
  });

  child.once("error", async (error) => {
    if (!cleaned) {
      cleaned = true;
      await client.request<boolean>("releaseRouteAllocation", { allocationId: allocation.allocationId }).catch(() => false);
      client.dispose();
    }

    console.error(`[portmanager] failed to start command: ${error.message}`);
    process.exit(1);
  });

  forwardSignals(child);

  await new Promise<void>((resolve) => {
    child.once("close", async (exitCode, signal) => {
      if (!cleaned) {
        cleaned = true;

        if (processId !== undefined) {
          await client.request("removeProcess", { id: processId }).catch(() => undefined);
        } else {
          await client
            .request<boolean>("releaseRouteAllocation", { allocationId: allocation.allocationId })
            .catch(() => false);
        }

        client.dispose();
      }

      process.exitCode = exitCode ?? signalToExitCode(signal);
      resolve();
    });
  });
}

/** Small daemon client used by the external terminal wrapper. */
class AgentCliClient {
  /** Active local socket connected to the singleton daemon. */
  private socket: net.Socket | undefined;

  /** Per-connection NDJSON decoder. */
  private readonly buffer = new NdjsonMessageBuffer();

  /** Request promises waiting for matching daemon responses. */
  private readonly pendingRequests = new Map<string, PendingRequest>();

  /** Monotonic id suffix for this CLI process. */
  private nextRequestId = 1;

  constructor(
    private readonly agentMainPath: string,
    private readonly nativeAgentPath: string,
  ) {}

  /** Connects to an existing daemon or starts one from this extension package. */
  async connectOrStart(): Promise<void> {
    try {
      this.socket = await openSocket();
      this.attachSocketHandlers(this.socket);
      return;
    } catch {
      this.startAgentProcess();
    }

    const deadline = Date.now() + 5000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      await delay(150);

      try {
        this.socket = await openSocket();
        this.attachSocketHandlers(this.socket);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to connect to Port Manager daemon.");
  }

  /** Sends one daemon request and waits for its response. */
  async request<T>(method: AgentRequestMethod, payload?: unknown): Promise<T> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new Error("Port Manager daemon is not connected.");
    }

    const id = `cli-${process.pid}-${this.nextRequestId++}`;
    const request: AgentRequestMessage = { id, method, payload };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Port Manager daemon request timed out: ${method}`));
      }, 10_000);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      socket.write(encodeAgentMessage(request));
    });
  }

  /** Closes the socket and rejects pending requests. */
  dispose(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.rejectAllPending(new Error("Port Manager CLI client disposed."));
  }

  /** Starts the local daemon, preferring the native implementation when packaged. */
  private startAgentProcess(): void {
    const socketPath = getAgentSocketPath();
    removeStaleSocketFile(socketPath);

    if (canRunNativeAgent(this.nativeAgentPath)) {
      const child = spawn(
        this.nativeAgentPath,
        ["--socket", socketPath, "--route-table", getDefaultRouteTablePath(), "--agent-main", this.agentMainPath],
        {
          detached: true,
          env: buildNodeRuntimeEnvironment(),
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.once("error", () => {
        this.startNodeAgentProcess(socketPath);
      });
      child.unref();
      return;
    }

    this.startNodeAgentProcess(socketPath);
  }

  /** Starts the previous Node daemon when the native binary cannot be used. */
  private startNodeAgentProcess(socketPath: string): void {
    const child = spawn(process.execPath, [this.agentMainPath, "--socket", socketPath], {
      detached: true,
      env: buildNodeRuntimeEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  /** Attaches line-delimited protocol handling to one socket. */
  private attachSocketHandlers(socket: net.Socket): void {
    socket.on("data", (chunk) => {
      for (const message of this.buffer.push(chunk)) {
        this.handleMessage(message);
      }
    });
    socket.on("close", () => {
      this.rejectAllPending(new Error("Port Manager daemon connection closed."));
    });
    socket.on("error", (error) => {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
    });
  }

  /** Dispatches one decoded daemon protocol frame. Snapshot events are ignored. */
  private handleMessage(message: unknown): void {
    if (!isAgentResponse(message)) {
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);

    if (!message.ok) {
      pending.reject(new Error(message.error ?? "Port Manager daemon request failed."));
      return;
    }

    pending.resolve(message.payload);
  }

  /** Rejects all outstanding requests when the socket is no longer usable. */
  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}

/** Parses the top-level CLI command. */
function parseCli(args: readonly string[]): ParsedCli {
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    return { command: "help" };
  }

  if (command === "status") {
    return { command: "status" };
  }

  if (command === "run") {
    return { command: "run", run: parseRunOptions(args.slice(1)) };
  }

  throw new Error(`Unknown Port Manager CLI command: ${command}`);
}

/** Parses run options and the wrapped command after `--`. */
function parseRunOptions(args: readonly string[]): RunOptions {
  let requestedPort: number | undefined;
  let host = DEFAULT_PORT_MANAGER_SETTINGS.defaultHost;
  let cwd = process.cwd();
  let name: string | undefined;
  let command: string | undefined;
  let injectionMode: InjectionOption = "auto";
  let scanRange = DEFAULT_PORT_MANAGER_SETTINGS.scanRange;
  let scanDirection = DEFAULT_PORT_MANAGER_SETTINGS.scanDirection;
  let routingMode = DEFAULT_PORT_MANAGER_SETTINGS.routingMode;
  let virtualPortRangeStart = DEFAULT_PORT_MANAGER_SETTINGS.virtualPortRangeStart;
  let virtualPortRangeEnd = DEFAULT_PORT_MANAGER_SETTINGS.virtualPortRangeEnd;

  const commandSeparatorIndex = args.indexOf("--");
  const optionArgs = commandSeparatorIndex >= 0 ? args.slice(0, commandSeparatorIndex) : args;
  const commandArgs = commandSeparatorIndex >= 0 ? args.slice(commandSeparatorIndex + 1) : [];

  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];

    switch (option) {
      case "--port":
      case "-p":
        requestedPort = parsePort(requireOptionValue(optionArgs, index));
        index += 1;
        break;
      case "--host":
        host = requireOptionValue(optionArgs, index);
        index += 1;
        break;
      case "--cwd":
        cwd = path.resolve(requireOptionValue(optionArgs, index));
        index += 1;
        break;
      case "--name":
        name = requireOptionValue(optionArgs, index);
        index += 1;
        break;
      case "--command":
        command = requireOptionValue(optionArgs, index);
        index += 1;
        break;
      case "--inject":
        injectionMode = parseInjectionMode(requireOptionValue(optionArgs, index));
        index += 1;
        break;
      case "--routing":
        routingMode = parseRoutingMode(requireOptionValue(optionArgs, index));
        index += 1;
        break;
      case "--scan-range":
        scanRange = parseInteger(requireOptionValue(optionArgs, index), "scan range");
        index += 1;
        break;
      case "--scan-direction":
        scanDirection = parseScanDirection(requireOptionValue(optionArgs, index));
        index += 1;
        break;
      case "--virtual-range": {
        const virtualRange = parseVirtualRange(requireOptionValue(optionArgs, index));
        virtualPortRangeStart = virtualRange.start;
        virtualPortRangeEnd = virtualRange.end;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown run option: ${option}`);
    }
  }

  if (requestedPort === undefined) {
    throw new Error("portmanager run requires --port <port>.");
  }

  const commandText = command ?? commandArgs.map(shellEscape).join(" ");
  if (commandText.trim().length === 0) {
    throw new Error("portmanager run requires a command after -- or --command <command>.");
  }

  return {
    requestedPort,
    host,
    cwd,
    name: name ?? deriveProcessName(commandText, cwd),
    command: commandText,
    injectionMode,
    scanRange,
    scanDirection,
    routingMode,
    virtualPortRangeStart,
    virtualPortRangeEnd,
  };
}

/** Builds the daemon route allocation request from CLI options. */
function buildAllocationRequest(options: RunOptions): AgentAllocateRouteRequest {
  return {
    name: options.name,
    command: options.command,
    cwd: options.cwd,
    requestedPort: options.requestedPort,
    host: options.host,
    scanRange: options.scanRange,
    scanDirection: options.scanDirection,
    routingMode: options.routingMode,
    virtualPortRangeStart: options.virtualPortRangeStart,
    virtualPortRangeEnd: options.virtualPortRangeEnd,
  };
}

/** Resolves auto injection by rewriting known requested-port occurrences. */
function buildEffectiveCommand(options: RunOptions): {
  readonly command: string;
  readonly injectionMode: PortInjectionMode;
} {
  if (options.injectionMode !== "auto") {
    return {
      command: options.command,
      injectionMode: options.injectionMode,
    };
  }

  return buildReroutableCommand(options.command, options.requestedPort);
}

/** Opens the singleton local agent socket. */
function openSocket(): Promise<net.Socket> {
  const socketPath = getAgentSocketPath();

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to Port Manager daemon at ${socketPath}.`));
    }, 1000);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

/** Finds the compiled daemon entrypoint relative to this compiled CLI file. */
function resolveAgentMainPath(): string {
  return path.resolve(__dirname, "..", "agent", "agent-main.js");
}

/** Finds the packaged native daemon binary relative to the compiled CLI file. */
function resolveNativeAgentPath(): string {
  return path.resolve(__dirname, "..", "..", "..", "media", "native", "portmanager_agent");
}

function canRunNativeAgent(nativeAgentPath: string): boolean {
  if (process.platform === "win32") {
    return false;
  }

  try {
    fs.accessSync(nativeAgentPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Returns the child PID after Node has emitted spawn. */
function requireChildPid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error("Child process spawned without a PID.");
  }

  return child.pid;
}

/** Forwards terminal signals to the wrapped child process. */
function forwardSignals(child: ChildProcess): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }
}

/** Converts common terminating signals to shell-compatible exit codes. */
function signalToExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  if (signal === "SIGHUP") {
    return 129;
  }

  return 1;
}

/** Returns one required option value from an argv array. */
function requireOptionValue(args: readonly string[], optionIndex: number): string {
  const value = args[optionIndex + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${args[optionIndex]}.`);
  }

  return value;
}

/** Parses and validates a TCP port number. */
function parsePort(value: string): number {
  const port = parseInteger(value, "port");

  if (port < 1 || port > 65_535) {
    throw new Error(`Port ${value} is outside the TCP range 1-65535.`);
  }

  return port;
}

/** Parses a finite integer option. */
function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

/** Parses the CLI injection option. */
function parseInjectionMode(value: string): InjectionOption {
  if (value === "auto" || value === "env" || value === "template" || value === "argument") {
    return value;
  }

  throw new Error(`Invalid injection mode: ${value}`);
}

/** Parses the CLI routing option. */
function parseRoutingMode(value: string): PortRoutingMode {
  if (value === "hashed" || value === "nearest") {
    return value;
  }

  throw new Error(`Invalid routing mode: ${value}`);
}

/** Parses the CLI scan direction option. */
function parseScanDirection(value: string): ScanDirection {
  if (value === "up" || value === "down" || value === "both") {
    return value;
  }

  throw new Error(`Invalid scan direction: ${value}`);
}

/** Parses a virtual range in `start-end` form. */
function parseVirtualRange(value: string): { readonly start: number; readonly end: number } {
  const [startText, endText] = value.split("-");
  const start = parsePort(startText ?? "");
  const end = parsePort(endText ?? "");

  if (start > end) {
    throw new Error(`Invalid virtual range ${value}: start must be <= end.`);
  }

  return { start, end };
}

/** Escapes argv tokens so the shell command preserves spaces and metacharacters. */
function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Uses workspace folder name as a stable default process label. */
function deriveProcessName(command: string, cwd: string): string {
  const commandName = command.split(/\s+/)[0];
  const folderName = path.basename(cwd);
  return folderName.length > 0 ? folderName : commandName || "Managed Process";
}

/** Runtime guard for daemon response frames. */
function isAgentResponse(value: unknown): value is AgentResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AgentResponse>;
  return candidate.type === "response" && typeof candidate.id === "string" && typeof candidate.ok === "boolean";
}

/** Promise-based timeout helper for daemon startup retry loops. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Converts thrown values to CLI-safe text. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Prints a compact usage guide for external shells. */
function printUsage(): void {
  console.log(`Usage:
  portmanager status
  portmanager run --port <port> [options] -- <command ...>

Options:
  --host <host>                 Host for route metadata, default localhost
  --cwd <path>                  Working directory, default current directory
  --name <name>                 Sidebar process name
  --command <shell-command>     Shell command string instead of argv after --
  --inject <auto|env|template|argument>
  --routing <hashed|nearest>
  --scan-range <count>
  --scan-direction <up|down|both>
  --virtual-range <start-end>

Examples:
  portmanager run --port 8000 -- daphne -b 127.0.0.1 -p 8000 myapp.asgi:application
  portmanager run --port 3000 -- npm run dev
  portmanager run --port 8000 --command "PORT=8000 npm run dev"
`);
}

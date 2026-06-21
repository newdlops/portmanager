import { spawn, type ChildProcess } from "node:child_process";
import { SimpleEventEmitter } from "../../shared/events";
import type {
  DisposableLike,
  ProcessKillSignal,
  ProcessLauncher,
  ProcessLaunchRequest,
  ProcessLaunchResult,
} from "../../shared/types";

interface ProcessExitEvent {
  /** PID captured at launch time so exit events remain stable after cleanup. */
  readonly pid: number;
  /** Numeric exit code from Node, or null when a signal ended the process. */
  readonly exitCode: number | null;
  /** Termination signal reported by Node, or null for normal exits. */
  readonly signal: NodeJS.Signals | null;
}

/**
 * Node child-process adapter for managed process execution.
 *
 * The launcher deliberately owns only low-level mechanics: command expansion,
 * environment injection, PID tracking, and process termination. Core modules
 * decide when a process should be started or stopped.
 */
export class NodeProcessLauncher implements ProcessLauncher {
  /** Child processes started by this adapter, keyed by OS PID for stop lookup. */
  private readonly childrenByPid = new Map<number, ChildProcess>();

  /** Exit notifications observed from child processes and exposed to core. */
  private readonly exitEvents = new SimpleEventEmitter<ProcessExitEvent>();

  /**
   * Starts the command through the user's shell and injects the routed port.
   * The promise resolves after Node confirms that the child process spawned.
   */
  async launch(request: ProcessLaunchRequest): Promise<ProcessLaunchResult> {
    const command = buildInjectedCommand(request);

    // PORT remains the common development-server convention; the route env
    // values let duplicate app instances resolve logical ports explicitly.
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(request.actualPort),
      PORT_MANAGER_ACTUAL_PORT: String(request.actualPort),
      PORT_MANAGER_LOGICAL_PORT: String(request.requestedPort),
      PORT_MANAGER_ROUTES: JSON.stringify(request.logicalRoutes ?? []),
      PORT_MANAGER_ROUTES_FILE: request.logicalRoutesFile ?? "",
    };

    const child = spawn(command, {
      cwd: request.cwd,
      env: environment,
      shell: true,
      stdio: "ignore",
    });

    return new Promise<ProcessLaunchResult>((resolve, reject) => {
      let settled = false;

      const pid = child.pid;

      if (pid === undefined) {
        reject(new Error(`Failed to spawn process for command: ${request.command}`));
        return;
      }

      this.childrenByPid.set(pid, child);
      this.attachLifecycleHandlers(child, pid);

      child.once("spawn", () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve({ pid, command });
      });

      child.once("error", (error) => {
        this.childrenByPid.delete(pid);

        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      });
    });
  }

  /**
   * Sends the configured signal to a known child process.
   * Unknown PIDs are ignored because external processes are outside this
   * adapter's lifecycle ownership.
   */
  async stop(pid: number, signal: ProcessKillSignal): Promise<void> {
    const child = this.childrenByPid.get(pid);

    if (child === undefined) {
      return;
    }

    const signalDelivered = child.kill(signal);

    if (!signalDelivered) {
      throw new Error(`Failed to send ${signal} to process ${pid}`);
    }
  }

  /**
   * Subscribes to process exit events. The shared emitter keeps the platform
   * adapter free of VS Code APIs while still supporting registry updates.
   */
  onExit(listener: (pid: number, exitCode: number | null, signal: NodeJS.Signals | null) => void): DisposableLike {
    return this.exitEvents.subscribe((event) => {
      listener(event.pid, event.exitCode, event.signal);
    });
  }

  /**
   * Wires child cleanup and event publication exactly once per spawned process.
   * PID is captured before the process exits because the map entry is removed.
   */
  private attachLifecycleHandlers(child: ChildProcess, pid: number): void {
    child.once("exit", (exitCode, signal) => {
      this.childrenByPid.delete(pid);
      this.exitEvents.emit({ pid, exitCode, signal });
    });
  }
}

/**
 * Applies the selected port injection strategy to the shell command.
 * Template mode rewrites every `${port}` placeholder, argument mode appends a
 * conventional `--port` flag, and env mode leaves command text unchanged.
 */
function buildInjectedCommand(request: ProcessLaunchRequest): string {
  const port = String(request.actualPort);

  if (request.injectionMode === "template") {
    return request.command.replaceAll("${port}", port);
  }

  if (request.injectionMode === "argument") {
    return `${request.command.trimEnd()} --port ${port}`;
  }

  return request.command;
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getAgentSocketPath } from "../agent/agent-socket";
import { getDefaultRouteTablePath } from "../agent/route-table";
import { LogicalNetworkRegistry, type LogicalNetworkRegistryState } from "../core/networks/logical-network-registry";
import { HostPortProxyManager } from "../platform/ports/host-port-proxy";
import { NodeTerminalCandidateProvider } from "../platform/process/node-terminal-candidate-provider";
import type {
  DisposableLike,
  HostPortExposure,
  LogicalNetwork,
  NetworkRuntimeDescriptor,
  NetworkRuntimeKind,
  NetworkSnapshot,
  PortManagerSettings,
  TerminalAttachment,
  TerminalCandidate,
  TerminalCandidateProvider,
  TerminalWindow,
} from "../shared/types";
import {
  getAsdfShimLauncherRelativePath,
  getHookLibraryRelativePath,
  prepareAsdfShimLauncherDirectory,
  shouldInjectTerminalHook,
} from "./terminal-hook-environment";

const NETWORK_STATE_KEY = "portManager.logicalNetworkState.v1";
const execFileAsync = promisify(execFile);

/**
 * Extension-side application service for the Logical Network mode.
 *
 * The service owns VS Code persistence and composes platform adapters, while
 * the registry keeps pure domain state. Runtime behavior is deliberately
 * capability-driven so unsupported attach/isolation paths fail before giving a
 * false impression that a terminal was moved into a network.
 */
export class PortManagerNetworkService implements DisposableLike {
  /** Pure domain store for networks, attachments, exposures, and terminal rows. */
  private readonly registry: LogicalNetworkRegistry;

  /** OS process-table terminal scanner. */
  private readonly terminalCandidateProvider: TerminalCandidateProvider;

  /** Local TCP proxy runtime used for concrete host exposure support. */
  private readonly proxyManager: HostPortProxyManager;

  /** VS Code event subscriptions owned by this service. */
  private readonly disposables: DisposableLike[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.terminalCandidateProvider = new NodeTerminalCandidateProvider();
    this.proxyManager = new HostPortProxyManager();
    this.registry = new LogicalNetworkRegistry(DEFAULT_RUNTIMES, this.loadState());
    this.disposables.push(this.registry.onDidChange(() => this.saveState()));
  }

  /** Loads terminal candidates and reopens persisted host exposures. */
  async start(): Promise<void> {
    this.disposables.push(
      vscode.window.onDidOpenTerminal(() => {
        void this.refreshTerminals();
      }),
      vscode.window.onDidCloseTerminal(() => {
        void this.refreshTerminals();
      }),
    );

    await this.reopenPersistedExposures();
    await this.refreshTerminals();
  }

  /** Returns the latest logical network snapshot for the sidebar. */
  getSnapshot(): NetworkSnapshot {
    return this.registry.getSnapshot();
  }

  /** Subscribes to logical network state changes. */
  onDidChange(listener: () => void): DisposableLike {
    return this.registry.onDidChange(listener);
  }

  /** Creates a network row for the selected runtime adapter. */
  createNetwork(name: string, runtimeKind: NetworkRuntimeKind = "proxy"): LogicalNetwork {
    const runtime = DEFAULT_RUNTIMES.find((item) => item.kind === runtimeKind);
    if (runtime === undefined) {
      throw new Error(`Unknown network runtime: ${runtimeKind}`);
    }

    return this.registry.addNetwork({
      id: createId("network"),
      name,
      status: "running",
      runtimeKind: runtime.kind,
      createdAt: new Date().toISOString(),
    });
  }

  /** Removes a network and closes any host exposures that belonged to it. */
  async removeNetwork(networkId: string): Promise<LogicalNetwork | undefined> {
    const snapshot = this.registry.getSnapshot();
    const exposures = snapshot.exposures.filter((exposure) => exposure.networkId === networkId);

    for (const exposure of exposures) {
      await this.proxyManager.close(exposure.id);
    }

    return this.registry.removeNetwork(networkId);
  }

  /** Refreshes VS Code and external OS terminal windows. */
  async refreshTerminals(): Promise<readonly TerminalWindow[]> {
    const [vscodeCandidates, osCandidates] = await Promise.all([
      listVscodeTerminalCandidates(),
      this.terminalCandidateProvider.list().catch(() => []),
    ]);
    const candidates = [...vscodeCandidates, ...osCandidates];
    this.registry.setTerminalCandidates(candidates);

    return this.registry.getSnapshot().terminalWindows;
  }

  /**
   * Attaches a terminal candidate to a network. Runtimes without terminal
   * isolation support still record a logical association so the UI can bind
   * user intent before a stronger adapter is installed.
   */
  attachTerminal(networkId: string, terminalPid: number): TerminalAttachment {
    const network = requireNetwork(this.registry.getNetwork(networkId), networkId);
    const runtime = requireRuntime(network.runtimeKind);
    const candidate = this.registry.getSnapshot().terminalCandidates.find((item) => item.pid === terminalPid);
    if (candidate === undefined) {
      throw new Error(`Unknown terminal process: ${terminalPid}`);
    }

    return this.registry.addAttachment({
      id: createId("attachment"),
      networkId,
      rootPid: candidate.pid,
      processGroupId: candidate.processGroupId,
      terminalTitle: candidate.windowTitle ?? candidate.name,
      mode: runtime.capabilities.supportsTerminalAttach ? "isolated" : "logical",
      status: "attached",
      errorMessage: runtime.capabilities.supportsTerminalAttach
        ? undefined
        : `${runtime.name} records this terminal but does not isolate its network traffic yet.`,
      attachedAt: new Date().toISOString(),
    });
  }

  /** Attaches a user-facing terminal window by resolving it to its root process. */
  attachTerminalWindow(networkId: string, terminalWindowId: string): TerminalAttachment {
    const network = requireNetwork(this.registry.getNetwork(networkId), networkId);
    const runtime = requireRuntime(network.runtimeKind);
    const terminalWindow = this.registry
      .getSnapshot()
      .terminalWindows.find((window) => window.id === terminalWindowId);

    if (terminalWindow === undefined) {
      throw new Error(`Unknown terminal window: ${terminalWindowId}`);
    }

    return this.registry.addAttachment({
      id: createId("attachment"),
      networkId,
      rootPid: terminalWindow.rootPid,
      processGroupId: terminalWindow.processGroupId,
      terminalWindowId: terminalWindow.id,
      terminalTitle: terminalWindow.title,
      mode: runtime.capabilities.supportsTerminalAttach ? "isolated" : "logical",
      status: "attached",
      errorMessage: runtime.capabilities.supportsTerminalAttach
        ? undefined
        : `${runtime.name} records this terminal window but does not isolate its network traffic yet.`,
      attachedAt: new Date().toISOString(),
    });
  }

  /**
   * Injects routing variables into the selected terminal window's current shell.
   * The command affects only processes launched after the attach action, which
   * matches the pre-bind constraint of the native socket hook.
   */
  async injectRoutingIntoTerminalWindow(
    terminalWindowId: string,
    networkId: string,
    settings: PortManagerSettings,
  ): Promise<TerminalRoutingInjectionResult> {
    requireNetwork(this.registry.getNetwork(networkId), networkId);

    const terminalWindow = this.registry
      .getSnapshot()
      .terminalWindows.find((window) => window.id === terminalWindowId);

    if (terminalWindow === undefined) {
      throw new Error(`Unknown terminal window: ${terminalWindowId}`);
    }

    if (!settings.enabled) {
      return { injected: false, reason: "Port Manager is disabled in settings." };
    }

    if (!shouldInjectTerminalHook(settings)) {
      return {
        injected: false,
        reason: `Native terminal routing is not supported on ${process.platform}.`,
      };
    }

    const script = this.buildTerminalRoutingScript(networkId, settings);
    if (terminalWindow.source === "vscode" && (await sendRoutingScriptToVscodeTerminal(terminalWindow, script))) {
      return { injected: true };
    }

    if (await sendRoutingScriptToExternalTerminalWindow(terminalWindow, script)) {
      return { injected: true };
    }

    return {
      injected: false,
      reason: `Could not find a controllable terminal session for "${terminalWindow.title}".`,
    };
  }

  /** Creates and opens a host TCP exposure through the concrete proxy runtime. */
  async createExposure(input: HostPortExposureInput): Promise<HostPortExposure> {
    const network = requireNetwork(this.registry.getNetwork(input.networkId), input.networkId);
    const runtime = requireRuntime(network.runtimeKind);

    if (!runtime.capabilities.supportsHostExposure) {
      throw new Error(`${runtime.name} does not support host port exposure.`);
    }

    ensureNoExposureConflict(this.registry.getSnapshot().exposures, input);

    const exposure: HostPortExposure = {
      id: createId("exposure"),
      networkId: input.networkId,
      hostAddress: input.hostAddress,
      hostPort: input.hostPort,
      targetAddress: input.targetAddress,
      targetPort: input.targetPort,
      protocol: "tcp",
      status: "opening",
      createdAt: new Date().toISOString(),
    };

    try {
      await this.proxyManager.open(exposure);
      return this.registry.addExposure({
        ...exposure,
        status: "active",
      });
    } catch (error) {
      await this.proxyManager.close(exposure.id);
      throw new Error(`Failed to expose ${input.hostAddress}:${input.hostPort}: ${formatError(error)}`);
    }
  }

  /** Closes and removes one host exposure. */
  async removeExposure(exposureId: string): Promise<HostPortExposure | undefined> {
    await this.proxyManager.close(exposureId);
    return this.registry.removeExposure(exposureId);
  }

  /** Returns one exposure row from the latest snapshot. */
  getExposure(exposureId: string): HostPortExposure | undefined {
    return this.registry.getSnapshot().exposures.find((exposure) => exposure.id === exposureId);
  }

  /** Releases listeners and event subscriptions. */
  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    this.registry.dispose();
    void this.proxyManager.dispose();
  }

  /** Reads persisted logical network state from VS Code global storage. */
  private loadState(): LogicalNetworkRegistryState | undefined {
    return this.context.globalState.get<LogicalNetworkRegistryState>(NETWORK_STATE_KEY);
  }

  /** Persists durable logical network state. */
  private saveState(): void {
    void this.context.globalState.update(NETWORK_STATE_KEY, this.registry.getPersistedState());
  }

  /**
   * Restores active proxy listeners after extension reload. If a host port is
   * now occupied, the exposure remains visible with an error status.
   */
  private async reopenPersistedExposures(): Promise<void> {
    for (const exposure of this.registry.getSnapshot().exposures) {
      if (exposure.status !== "active") {
        continue;
      }

      try {
        await this.proxyManager.open(exposure);
      } catch (error) {
        this.registry.updateExposure({
          ...exposure,
          status: "error",
          errorMessage: formatError(error),
        });
      }
    }
  }

  /** Builds the shell commands that make later child processes join one logical network scope. */
  private buildTerminalRoutingScript(networkId: string, settings: PortManagerSettings): string {
    const hookLibraryPath = this.context.asAbsolutePath(getHookLibraryRelativePath());
    const asdfShimLauncherPath = this.context.asAbsolutePath(getAsdfShimLauncherRelativePath());
    const asdfShimDirectory = prepareAsdfShimLauncherDirectory(
      this.context.globalStorageUri.fsPath,
      asdfShimLauncherPath,
    );
    const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
    const commands = [
      shellExport("PORT_MANAGER_HOOK", "1"),
      shellExport("PORT_MANAGER_NETWORK_ID", networkId),
      shellExport("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath()),
      shellExport("PORT_MANAGER_ROUTES_FILE", getDefaultRouteTablePath()),
      shellExport("PORT_MANAGER_SCAN_RANGE", String(settings.scanRange)),
      shellExport("PORT_MANAGER_ROUTING_MODE", settings.routingMode),
      shellExport("PORT_MANAGER_VIRTUAL_PORT_START", String(settings.virtualPortRangeStart)),
      shellExport("PORT_MANAGER_VIRTUAL_PORT_END", String(settings.virtualPortRangeEnd)),
      shellExport("PORT_MANAGER_FIXED_PROTOCOL_PORTS", settings.fixedProtocolPorts.join(",")),
      shellPrependLibrary(preloadVariable, hookLibraryPath),
    ];

    if (asdfShimDirectory !== undefined) {
      commands.push(`export PATH=${shellQuote(asdfShimDirectory)}:"$PATH"`);
    }

    commands.push(
      `printf '%s\\n' ${shellQuote(
        `Port Manager routing active for ${networkId}. Restart servers launched before attach.`,
      )}`,
    );

    return commands.join("; ");
  }
}

export interface TerminalRoutingInjectionResult {
  /** True when the command was sent to the selected terminal shell. */
  readonly injected: boolean;
  /** User-facing explanation when automatic injection is unavailable. */
  readonly reason?: string;
}

export interface HostPortExposureInput {
  /** Existing logical network id. */
  readonly networkId: string;
  /** Host interface exposed to users, commonly 127.0.0.1. */
  readonly hostAddress: string;
  /** Host TCP port selected by the user. */
  readonly hostPort: number;
  /** Runtime target address. For proxy runtime this is a local or reachable host. */
  readonly targetAddress: string;
  /** Runtime target TCP port. */
  readonly targetPort: number;
}

/** Includes VS Code integrated terminals in the same model as OS-discovered shells. */
async function listVscodeTerminalCandidates(): Promise<readonly TerminalCandidate[]> {
  const terminals: Array<TerminalCandidate | undefined> = await Promise.all(
    vscode.window.terminals.map(async (terminal) => {
      let pid: number | undefined;

      try {
        pid = await terminal.processId;
      } catch {
        pid = undefined;
      }

      if (pid === undefined) {
        return undefined;
      }

      return {
        pid,
        name: terminal.name,
        windowTitle: terminal.name,
        command: terminal.name,
        vscodeTerminal: true,
      } satisfies TerminalCandidate;
    }),
  );

  return terminals.filter((candidate): candidate is TerminalCandidate => candidate !== undefined);
}

function requireNetwork(network: LogicalNetwork | undefined, networkId: string): LogicalNetwork {
  if (network === undefined) {
    throw new Error(`Unknown logical network: ${networkId}`);
  }

  return network;
}

function requireRuntime(runtimeKind: NetworkRuntimeKind): NetworkRuntimeDescriptor {
  const runtime = DEFAULT_RUNTIMES.find((item) => item.kind === runtimeKind);
  if (runtime === undefined) {
    throw new Error(`No runtime adapter registered for ${runtimeKind}.`);
  }

  return runtime;
}

/** Prevents duplicate exposure rows before the platform bind call. */
function ensureNoExposureConflict(
  exposures: readonly HostPortExposure[],
  input: HostPortExposureInput,
): void {
  const conflictingExposure = exposures.find(
    (exposure) =>
      exposure.protocol === "tcp" &&
      exposure.hostAddress === input.hostAddress &&
      exposure.hostPort === input.hostPort,
  );

  if (conflictingExposure !== undefined) {
    throw new Error(`Host port already exposed: ${input.hostAddress}:${input.hostPort}`);
  }
}

function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sends a routing script into an integrated terminal without relying on OS window automation. */
async function sendRoutingScriptToVscodeTerminal(
  terminalWindow: TerminalWindow,
  script: string,
): Promise<boolean> {
  for (const terminal of vscode.window.terminals) {
    let processId: number | undefined;

    try {
      processId = await terminal.processId;
    } catch {
      processId = undefined;
    }

    if (processId === undefined || !terminalWindow.candidatePids.includes(processId)) {
      continue;
    }

    terminal.sendText(script, true);
    return true;
  }

  return false;
}

/** Sends a routing script into Terminal.app or iTerm2 sessions selected by tty. */
async function sendRoutingScriptToExternalTerminalWindow(
  terminalWindow: TerminalWindow,
  script: string,
): Promise<boolean> {
  if (process.platform !== "darwin" || terminalWindow.terminalId === undefined) {
    return false;
  }

  const tty = normalizeTerminalTty(terminalWindow.terminalId);
  return (await runTerminalAppleScript(tty, script)) || (await runITermAppleScript(tty, script));
}

/** Terminal.app exposes tty on each tab, which lets us target a window without matching titles. */
async function runTerminalAppleScript(tty: string, script: string): Promise<boolean> {
  const escapedScript = appleScriptString(script);
  const escapedTty = appleScriptString(tty);
  const appleScript = `
if application "Terminal" is not running then return "missing"
tell application "Terminal"
  repeat with windowItem in windows
    repeat with tabItem in tabs of windowItem
      if (tty of tabItem) is "${escapedTty}" then
        do script "${escapedScript}" in tabItem
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "missing"
`;

  return runAppleScript(appleScript);
}

/** iTerm2 exposes tty on sessions, so session selection does not depend on mutable titles. */
async function runITermAppleScript(tty: string, script: string): Promise<boolean> {
  const escapedScript = appleScriptString(script);
  const escapedTty = appleScriptString(tty);
  const appleScript = `
if application "iTerm2" is not running then return "missing"
tell application "iTerm2"
  repeat with windowItem in windows
    repeat with tabItem in tabs of windowItem
      repeat with sessionItem in sessions of tabItem
        if (tty of sessionItem) is "${escapedTty}" then
          tell sessionItem to write text "${escapedScript}"
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "missing"
`;

  return runAppleScript(appleScript);
}

async function runAppleScript(script: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 1500 });
    return stdout.trim() === "ok";
  } catch {
    return false;
  }
}

function normalizeTerminalTty(terminalId: string): string {
  return terminalId.startsWith("/dev/") ? terminalId : path.join("/dev", terminalId);
}

function shellExport(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

function shellPrependLibrary(name: string, libraryPath: string): string {
  return `export ${name}=${shellQuote(libraryPath)}\${${name}:+":$${name}"}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const DEFAULT_RUNTIMES: readonly NetworkRuntimeDescriptor[] = [
  {
    id: "local-proxy",
    name: "Local TCP Proxy",
    kind: "proxy",
    capabilities: {
      supportsSameInternalPorts: false,
      supportsTerminalAttach: false,
      supportsHostExposure: true,
      requiresPrivilegedHelper: false,
      requiresContainerRuntime: false,
    },
  },
];

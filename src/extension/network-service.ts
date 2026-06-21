import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
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
  TerminalAttachment,
  TerminalCandidate,
  TerminalCandidateProvider,
} from "../shared/types";

const NETWORK_STATE_KEY = "portManager.logicalNetworkState.v1";

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

  /** Refreshes VS Code and external OS terminal candidates. */
  async refreshTerminals(): Promise<readonly TerminalCandidate[]> {
    const [vscodeCandidates, osCandidates] = await Promise.all([
      listVscodeTerminalCandidates(),
      this.terminalCandidateProvider.list().catch(() => []),
    ]);
    const candidates = [...vscodeCandidates, ...osCandidates];
    this.registry.setTerminalCandidates(candidates);

    return candidates;
  }

  /**
   * Attaches a terminal to a network when the selected runtime can actually do
   * it. The current proxy runtime intentionally rejects this path because it
   * cannot move existing processes into an isolated namespace.
   */
  attachTerminal(networkId: string, terminalPid: number): TerminalAttachment {
    const network = requireNetwork(this.registry.getNetwork(networkId), networkId);
    const runtime = requireRuntime(network.runtimeKind);

    if (!runtime.capabilities.supportsTerminalAttach) {
      throw new Error(
        `${runtime.name} cannot attach an existing terminal to an isolated network. Use a runtime adapter with terminal attach support.`,
      );
    }

    const candidate = this.registry.getSnapshot().terminalCandidates.find((item) => item.pid === terminalPid);
    if (candidate === undefined) {
      throw new Error(`Unknown terminal process: ${terminalPid}`);
    }

    return this.registry.addAttachment({
      id: createId("attachment"),
      networkId,
      rootPid: candidate.pid,
      processGroupId: candidate.processGroupId,
      status: "attached",
      attachedAt: new Date().toISOString(),
    });
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

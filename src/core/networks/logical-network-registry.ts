import { SimpleEventEmitter } from "../../shared/events";
import type {
  DisposableLike,
  HostPortExposure,
  LogicalNetwork,
  NetworkRuntimeDescriptor,
  NetworkSnapshot,
  TerminalAttachment,
  TerminalCandidate,
} from "../../shared/types";

/**
 * Pure state store for the logical network model.
 *
 * Runtime adapters perform OS/container/proxy work outside this class and then
 * commit the resulting state here. Keeping the registry free of platform calls
 * makes it reusable by the extension host, a future daemon, and unit tests.
 */
export class LogicalNetworkRegistry implements DisposableLike {
  /** Long-lived network rows keyed by stable id. */
  private readonly networks = new Map<string, LogicalNetwork>();

  /** Attachments are records of a terminal root/process group assigned to a network. */
  private readonly attachments = new Map<string, TerminalAttachment>();

  /** Host listener/proxy rows keyed by exposure id. */
  private readonly exposures = new Map<string, HostPortExposure>();

  /** Latest transient terminal discovery results. */
  private terminalCandidates: readonly TerminalCandidate[] = [];

  /** Runtime descriptors available to the current extension session. */
  private runtimes: readonly NetworkRuntimeDescriptor[];

  /** Event stream used by the sidebar and commands to refresh after mutations. */
  private readonly changeEvents = new SimpleEventEmitter<void>();

  constructor(runtimes: readonly NetworkRuntimeDescriptor[], initialState?: LogicalNetworkRegistryState) {
    this.runtimes = [...runtimes];

    for (const network of initialState?.networks ?? []) {
      this.networks.set(network.id, network);
    }

    for (const attachment of initialState?.attachments ?? []) {
      this.attachments.set(attachment.id, attachment);
    }

    for (const exposure of initialState?.exposures ?? []) {
      this.exposures.set(exposure.id, exposure);
    }
  }

  /** Subscribes to any registry mutation. */
  onDidChange(listener: () => void): DisposableLike {
    return this.changeEvents.subscribe(listener);
  }

  /** Returns a complete immutable snapshot for UI rendering and persistence. */
  getSnapshot(): NetworkSnapshot {
    return {
      networks: [...this.networks.values()],
      terminalCandidates: this.terminalCandidates,
      attachments: [...this.attachments.values()],
      exposures: [...this.exposures.values()],
      runtimes: this.runtimes,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Returns the persistable subset. Terminal candidates are intentionally transient. */
  getPersistedState(): LogicalNetworkRegistryState {
    return {
      networks: [...this.networks.values()],
      attachments: [...this.attachments.values()],
      exposures: [...this.exposures.values()],
    };
  }

  /** Replaces runtime descriptors after platform capability checks. */
  setRuntimes(runtimes: readonly NetworkRuntimeDescriptor[]): void {
    this.runtimes = [...runtimes];
    this.emitChange();
  }

  /** Replaces the transient terminal discovery list. */
  setTerminalCandidates(candidates: readonly TerminalCandidate[]): void {
    this.terminalCandidates = dedupeTerminalCandidates(candidates);
    this.emitChange();
  }

  /** Creates a logical network row. Runtime startup happens before this call. */
  addNetwork(network: LogicalNetwork): LogicalNetwork {
    if (this.networks.has(network.id)) {
      throw new Error(`Logical network already exists: ${network.id}`);
    }

    this.networks.set(network.id, network);
    this.emitChange();
    return network;
  }

  /** Removes a network and all state that depends on it. */
  removeNetwork(networkId: string): LogicalNetwork | undefined {
    const network = this.networks.get(networkId);
    if (network === undefined) {
      return undefined;
    }

    this.networks.delete(networkId);

    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.networkId === networkId) {
        this.attachments.delete(attachmentId);
      }
    }

    for (const [exposureId, exposure] of this.exposures) {
      if (exposure.networkId === networkId) {
        this.exposures.delete(exposureId);
      }
    }

    this.emitChange();
    return network;
  }

  /** Returns one network by id. */
  getNetwork(networkId: string): LogicalNetwork | undefined {
    return this.networks.get(networkId);
  }

  /** Stores a terminal attachment after the runtime adapter accepts or rejects it. */
  addAttachment(attachment: TerminalAttachment): TerminalAttachment {
    if (!this.networks.has(attachment.networkId)) {
      throw new Error(`Unknown logical network: ${attachment.networkId}`);
    }

    this.attachments.set(attachment.id, attachment);
    this.emitChange();
    return attachment;
  }

  /** Removes an attachment row without touching the external terminal process. */
  removeAttachment(attachmentId: string): TerminalAttachment | undefined {
    const attachment = this.attachments.get(attachmentId);
    if (attachment === undefined) {
      return undefined;
    }

    this.attachments.delete(attachmentId);
    this.emitChange();
    return attachment;
  }

  /** Stores a host exposure after its listener/proxy has been prepared. */
  addExposure(exposure: HostPortExposure): HostPortExposure {
    if (!this.networks.has(exposure.networkId)) {
      throw new Error(`Unknown logical network: ${exposure.networkId}`);
    }

    const conflictingExposure = [...this.exposures.values()].find(
      (item) =>
        item.id !== exposure.id &&
        item.protocol === exposure.protocol &&
        item.hostAddress === exposure.hostAddress &&
        item.hostPort === exposure.hostPort,
    );

    if (conflictingExposure !== undefined) {
      throw new Error(
        `Host exposure already exists: ${exposure.hostAddress}:${exposure.hostPort}/${exposure.protocol}`,
      );
    }

    this.exposures.set(exposure.id, exposure);
    this.emitChange();
    return exposure;
  }

  /** Updates a stored exposure after runtime status changes. */
  updateExposure(exposure: HostPortExposure): HostPortExposure {
    if (!this.exposures.has(exposure.id)) {
      throw new Error(`Unknown host exposure: ${exposure.id}`);
    }

    this.exposures.set(exposure.id, exposure);
    this.emitChange();
    return exposure;
  }

  /** Removes a host exposure row after the platform listener has closed. */
  removeExposure(exposureId: string): HostPortExposure | undefined {
    const exposure = this.exposures.get(exposureId);
    if (exposure === undefined) {
      return undefined;
    }

    this.exposures.delete(exposureId);
    this.emitChange();
    return exposure;
  }

  /** Releases registry listeners. */
  dispose(): void {
    this.changeEvents.clear();
  }

  private emitChange(): void {
    this.changeEvents.emit();
  }
}

export interface LogicalNetworkRegistryState {
  /** Persisted logical networks. */
  readonly networks: readonly LogicalNetwork[];
  /** Persisted terminal attachment records. */
  readonly attachments: readonly TerminalAttachment[];
  /** Persisted host exposure rows. */
  readonly exposures: readonly HostPortExposure[];
}

/** Keeps one row per visible terminal root while preserving discovery order. */
function dedupeTerminalCandidates(candidates: readonly TerminalCandidate[]): readonly TerminalCandidate[] {
  const seen = new Set<string>();
  const deduped: TerminalCandidate[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.pid}:${candidate.terminalId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

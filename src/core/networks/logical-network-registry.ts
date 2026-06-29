import { SimpleEventEmitter } from "../../shared/events";
import type {
  ComposeAttachment,
  ContainerServiceCandidate,
  DisposableLike,
  HostAccessBinding,
  HostPortExposure,
  LogicalNetwork,
  NetworkRuntimeDescriptor,
  NetworkSnapshot,
  TerminalAttachment,
  TerminalCandidate,
  TerminalWindow,
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

  /** Network-to-host binding rows keyed by binding id. */
  private readonly hostAccessBindings = new Map<string, HostAccessBinding>();

  /** Compose project endpoint rows keyed by attachment id. */
  private readonly composeAttachments = new Map<string, ComposeAttachment>();

  /** Latest transient terminal discovery results. */
  private terminalCandidates: readonly TerminalCandidate[] = [];

  /** User-facing terminal windows grouped from transient process candidates. */
  private terminalWindows: readonly TerminalWindow[] = [];

  /** Latest transient Docker/Podman published-port candidates. */
  private containerServiceCandidates: readonly ContainerServiceCandidate[] = [];

  /** Runtime descriptors available to the current extension session. */
  private runtimes: readonly NetworkRuntimeDescriptor[];

  /** Event stream used by the sidebar and commands to refresh after mutations. */
  private readonly changeEvents = new SimpleEventEmitter<void>();

  constructor(runtimes: readonly NetworkRuntimeDescriptor[], initialState?: LogicalNetworkRegistryState) {
    this.runtimes = [...runtimes];

    for (const network of initialState?.networks ?? []) {
      this.networks.set(network.id, network);
    }

    for (const attachment of sortTerminalAttachmentsByAttachedAt(initialState?.attachments ?? [])) {
      this.setAttachment(attachment);
    }

    for (const exposure of initialState?.exposures ?? []) {
      this.exposures.set(exposure.id, exposure);
    }

    for (const binding of initialState?.hostAccessBindings ?? []) {
      this.hostAccessBindings.set(binding.id, binding);
    }

    for (const attachment of sortComposeAttachmentsByAttachedAt(initialState?.composeAttachments ?? [])) {
      this.setPersistedComposeAttachment(attachment);
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
      terminalWindows: this.terminalWindows,
      attachments: [...this.attachments.values()],
      exposures: [...this.exposures.values()],
      hostAccessBindings: [...this.hostAccessBindings.values()],
      composeAttachments: [...this.composeAttachments.values()],
      containerServiceCandidates: this.containerServiceCandidates,
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
      hostAccessBindings: [...this.hostAccessBindings.values()],
      composeAttachments: [...this.composeAttachments.values()],
    };
  }

  /**
   * Replaces only durable state loaded from the cross-window shared store.
   *
   * Runtime descriptors and discovery candidates are intentionally left intact
   * because each VS Code window observes its own terminals and platform tools,
   * while networks, bindings, and compose routes must be host-global.
   */
  replacePersistedState(state: LogicalNetworkRegistryState): void {
    this.networks.clear();
    this.attachments.clear();
    this.exposures.clear();
    this.hostAccessBindings.clear();
    this.composeAttachments.clear();

    for (const network of state.networks) {
      this.networks.set(network.id, network);
    }

    for (const attachment of sortTerminalAttachmentsByAttachedAt(state.attachments)) {
      this.setAttachment(attachment);
    }

    for (const exposure of state.exposures) {
      this.exposures.set(exposure.id, exposure);
    }

    for (const binding of state.hostAccessBindings ?? []) {
      this.hostAccessBindings.set(binding.id, binding);
    }

    for (const attachment of sortComposeAttachmentsByAttachedAt(state.composeAttachments ?? [])) {
      this.setPersistedComposeAttachment(attachment);
    }

    this.emitChange();
  }

  /** Replaces runtime descriptors after platform capability checks. */
  setRuntimes(runtimes: readonly NetworkRuntimeDescriptor[]): void {
    const nextRuntimes = [...runtimes];
    if (sameJsonList(this.runtimes, nextRuntimes)) {
      return;
    }

    this.runtimes = nextRuntimes;
    this.emitChange();
  }

  /** Replaces the transient terminal discovery list. */
  setTerminalCandidates(candidates: readonly TerminalCandidate[]): void {
    const nextTerminalCandidates = dedupeTerminalCandidates(candidates);
    const nextTerminalWindows = groupTerminalWindows(nextTerminalCandidates);
    if (
      sameJsonList(this.terminalCandidates, nextTerminalCandidates) &&
      sameJsonList(this.terminalWindows, nextTerminalWindows)
    ) {
      return;
    }

    this.terminalCandidates = nextTerminalCandidates;
    this.terminalWindows = nextTerminalWindows;
    this.emitChange();
  }

  /** Replaces transient Docker/Podman service candidates shown in the UI. */
  setContainerServiceCandidates(candidates: readonly ContainerServiceCandidate[]): void {
    const nextCandidates = dedupeContainerServiceCandidates(candidates);
    if (sameJsonList(this.containerServiceCandidates, nextCandidates)) {
      return;
    }

    this.containerServiceCandidates = nextCandidates;
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

    for (const [bindingId, binding] of this.hostAccessBindings) {
      if (binding.networkId === networkId) {
        this.hostAccessBindings.delete(bindingId);
      }
    }

    for (const [attachmentId, attachment] of this.composeAttachments) {
      if (attachment.networkId === networkId) {
        this.composeAttachments.delete(attachmentId);
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

    this.setAttachment(attachment);
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

  /** Stores a network-to-host access binding after validating its network scope. */
  addHostAccessBinding(binding: HostAccessBinding): HostAccessBinding {
    if (!this.networks.has(binding.networkId)) {
      throw new Error(`Unknown logical network: ${binding.networkId}`);
    }

    const conflictingBinding = [...this.hostAccessBindings.values()].find(
      (item) =>
        item.id !== binding.id &&
        item.networkId === binding.networkId &&
        item.protocol === binding.protocol &&
        item.logicalPort === binding.logicalPort,
    );

    if (conflictingBinding !== undefined) {
      throw new Error(`Host access binding already exists for logical port ${binding.logicalPort}.`);
    }

    this.hostAccessBindings.set(binding.id, binding);
    this.emitChange();
    return binding;
  }

  /** Removes one network-to-host access binding. */
  removeHostAccessBinding(bindingId: string): HostAccessBinding | undefined {
    const binding = this.hostAccessBindings.get(bindingId);
    if (binding === undefined) {
      return undefined;
    }

    this.hostAccessBindings.delete(bindingId);
    this.emitChange();
    return binding;
  }

  /** Stores a compose project attachment after its published ports become route rows. */
  addComposeAttachment(attachment: ComposeAttachment): ComposeAttachment {
    if (!this.networks.has(attachment.networkId)) {
      throw new Error(`Unknown logical network: ${attachment.networkId}`);
    }

    if (this.composeAttachments.has(attachment.id)) {
      throw new Error(`Compose attachment already exists: ${attachment.id}`);
    }

    this.ensureNoComposePortConflict(attachment);
    this.ensureNoComposeRuntimeOwnerConflict(attachment);
    this.composeAttachments.set(attachment.id, attachment);
    this.emitChange();
    return attachment;
  }

  /** Updates a compose attachment after endpoint route rows change. */
  updateComposeAttachment(attachment: ComposeAttachment): ComposeAttachment {
    if (!this.composeAttachments.has(attachment.id)) {
      throw new Error(`Unknown compose attachment: ${attachment.id}`);
    }

    this.ensureNoComposePortConflict(attachment);
    this.ensureNoComposeRuntimeOwnerConflict(attachment);
    this.composeAttachments.set(attachment.id, attachment);
    this.emitChange();
    return attachment;
  }

  /** Removes a compose attachment row after its route rows have been removed. */
  removeComposeAttachment(attachmentId: string): ComposeAttachment | undefined {
    const attachment = this.composeAttachments.get(attachmentId);
    if (attachment === undefined) {
      return undefined;
    }

    this.composeAttachments.delete(attachmentId);
    this.emitChange();
    return attachment;
  }

  /** Releases registry listeners. */
  dispose(): void {
    this.changeEvents.clear();
  }

  private emitChange(): void {
    this.changeEvents.emit();
  }

  /**
   * Commits one terminal attachment while preserving the product invariant that
   * one visible terminal root can belong to only one logical network. This runs
   * during persisted-state load too, so stale duplicate rows converge without a
   * user-triggered detach.
   */
  private setAttachment(attachment: TerminalAttachment): void {
    this.removeConflictingTerminalAttachments(attachment);
    this.attachments.set(attachment.id, attachment);
  }

  /** Removes previous network labels for the same terminal identity. */
  private removeConflictingTerminalAttachments(attachment: TerminalAttachment): void {
    for (const [attachmentId, existing] of this.attachments) {
      if (attachmentId !== attachment.id && terminalAttachmentsShareIdentity(existing, attachment)) {
        this.attachments.delete(attachmentId);
      }
    }
  }

  /**
   * Restores persisted compose rows while converging stale cross-network owners.
   *
   * Docker/Podman lifecycle commands operate on the real runtime project, not
   * Port Manager's logical network id. Keeping one runtime project attached to
   * multiple networks can make a stop/kill command in one network terminate the
   * same hidden clone from another network. Persisted rows are loaded
   * oldest-first so the most recent owner wins after older extension versions
   * left duplicates behind.
   */
  private setPersistedComposeAttachment(attachment: ComposeAttachment): void {
    this.removeConflictingPersistedComposeRuntimeOwners(attachment);
    this.composeAttachments.set(attachment.id, attachment);
  }

  /** Drops older persisted owners for the same real compose runtime project. */
  private removeConflictingPersistedComposeRuntimeOwners(attachment: ComposeAttachment): void {
    const ownerKeys = composeRuntimeOwnerKeys(attachment);
    if (ownerKeys.length === 0) {
      return;
    }

    const ownerKeySet = new Set(ownerKeys);
    for (const [attachmentId, existing] of this.composeAttachments) {
      if (attachmentId === attachment.id || existing.networkId === attachment.networkId) {
        continue;
      }

      if (composeRuntimeOwnerKeys(existing).some((ownerKey) => ownerKeySet.has(ownerKey))) {
        this.composeAttachments.delete(attachmentId);
      }
    }
  }

  /**
   * A logical network can shadow a host port with one compose service endpoint,
   * but two active compose endpoints for the same logical port would make
   * routing nondeterministic.
   */
  private ensureNoComposePortConflict(attachment: ComposeAttachment): void {
    const seenPorts = new Set<string>();

    for (const port of attachment.ports) {
      const key = `${attachment.networkId}:${port.protocol}:${port.logicalPort}`;
      if (seenPorts.has(key)) {
        throw new Error(`Compose attachment has duplicate logical port ${port.logicalPort}.`);
      }

      seenPorts.add(key);
    }

    for (const existing of this.composeAttachments.values()) {
      if (existing.id === attachment.id || existing.networkId !== attachment.networkId) {
        continue;
      }

      for (const existingPort of existing.ports) {
        const conflict = attachment.ports.find(
          (port) => port.protocol === existingPort.protocol && port.logicalPort === existingPort.logicalPort,
        );

        if (conflict !== undefined) {
          throw new Error(`Compose route already exists for logical port ${conflict.logicalPort}.`);
        }
      }
    }
  }

  /**
   * Prevents one physical compose project from becoming active in two logical
   * networks. This guards lifecycle commands (`stop`, `kill`, `restart`) that
   * target Docker/Podman's project/container names instead of Port Manager's
   * virtual network ids.
   */
  private ensureNoComposeRuntimeOwnerConflict(attachment: ComposeAttachment): void {
    const ownerKeys = composeRuntimeOwnerKeys(attachment);
    if (ownerKeys.length === 0) {
      return;
    }

    const ownerKeySet = new Set(ownerKeys);
    for (const existing of this.composeAttachments.values()) {
      if (existing.id === attachment.id || existing.networkId === attachment.networkId) {
        continue;
      }

      const conflictKey = composeRuntimeOwnerKeys(existing).find((ownerKey) => ownerKeySet.has(ownerKey));
      if (conflictKey !== undefined) {
        throw new Error(
          `Compose project is already attached to another logical network: ${formatComposeRuntimeOwnerKey(conflictKey)}.`,
        );
      }
    }
  }
}

export interface LogicalNetworkRegistryState {
  /** Persisted logical networks. */
  readonly networks: readonly LogicalNetwork[];
  /** Persisted terminal attachment records. */
  readonly attachments: readonly TerminalAttachment[];
  /** Persisted host exposure rows. */
  readonly exposures: readonly HostPortExposure[];
  /** Persisted network-to-host access rows. */
  readonly hostAccessBindings?: readonly HostAccessBinding[];
  /** Persisted compose project endpoint rows. */
  readonly composeAttachments?: readonly ComposeAttachment[];
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

/** Keeps one row per runtime/container id while preserving discovery order. */
function dedupeContainerServiceCandidates(
  candidates: readonly ContainerServiceCandidate[],
): readonly ContainerServiceCandidate[] {
  const seen = new Set<string>();
  const deduped: ContainerServiceCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      continue;
    }

    seen.add(candidate.id);
    deduped.push(candidate);
  }

  return deduped;
}

function sameJsonList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Returns true when two attachment rows describe the same user-facing terminal
 * identity. Matching on any stable terminal key lets VS Code, OS discovery,
 * pasted hook scripts, and process-only attach rows converge to one network.
 */
export function terminalAttachmentsShareIdentity(left: TerminalAttachment, right: TerminalAttachment): boolean {
  if (left.terminalSessionId !== undefined || right.terminalSessionId !== undefined) {
    return left.terminalSessionId !== undefined && left.terminalSessionId === right.terminalSessionId;
  }

  if (left.terminalWindowId !== undefined && left.terminalWindowId === right.terminalWindowId) {
    return true;
  }

  if (left.rootPid === right.rootPid) {
    return true;
  }

  return left.processGroupId !== undefined && left.processGroupId === right.processGroupId;
}

/** Applies persisted attachment rows oldest-first so the newest terminal label wins conflicts. */
function sortTerminalAttachmentsByAttachedAt(attachments: readonly TerminalAttachment[]): readonly TerminalAttachment[] {
  return [...attachments].sort(
    (left, right) => parseAttachmentTime(left.attachedAt) - parseAttachmentTime(right.attachedAt),
  );
}

/** Applies persisted compose rows oldest-first so the newest runtime owner wins conflicts. */
function sortComposeAttachmentsByAttachedAt(attachments: readonly ComposeAttachment[]): readonly ComposeAttachment[] {
  return [...attachments].sort(
    (left, right) => parseAttachmentTime(left.attachedAt) - parseAttachmentTime(right.attachedAt),
  );
}

function parseAttachmentTime(attachedAt: string): number {
  const parsed = Date.parse(attachedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Returns the physical runtime project identities that a compose attachment can
 * own. Old persisted rows may not have stored the runtime, so those rows are
 * treated as ambiguous across Docker and Podman until the next runtime refresh.
 */
function composeRuntimeOwnerKeys(attachment: ComposeAttachment): readonly string[] {
  if (attachment.status !== "attached" && attachment.status !== "error") {
    return [];
  }

  const mutation = attachment.mutation;
  if (mutation !== undefined && mutation.attachedProjectName.trim().length > 0) {
    return [composeRuntimeOwnerKey(mutation.runtime, mutation.attachedProjectName)];
  }

  if (attachment.projectName.trim().length === 0) {
    return [];
  }

  if (attachment.runtime !== undefined) {
    return [composeRuntimeOwnerKey(attachment.runtime, attachment.projectName)];
  }

  return [
    composeRuntimeOwnerKey("docker", attachment.projectName),
    composeRuntimeOwnerKey("podman", attachment.projectName),
  ];
}

function composeRuntimeOwnerKey(runtime: "docker" | "podman", projectName: string): string {
  return `${runtime}:${projectName}`;
}

function formatComposeRuntimeOwnerKey(ownerKey: string): string {
  const separatorIndex = ownerKey.indexOf(":");
  if (separatorIndex < 0) {
    return ownerKey;
  }

  return `${ownerKey.slice(0, separatorIndex)} compose project "${ownerKey.slice(separatorIndex + 1)}"`;
}

/** Groups noisy process-level shell candidates into user-facing terminal windows. */
function groupTerminalWindows(candidates: readonly TerminalCandidate[]): readonly TerminalWindow[] {
  const groups = new Map<string, TerminalCandidate[]>();

  for (const candidate of candidates) {
    const key = terminalWindowGroupKey(candidate);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, [candidate]);
      continue;
    }

    existing.push(candidate);
  }

  return [...groups.entries()].map(([id, group]) => {
    const root = selectTerminalRoot(group);
    const source = group.some((candidate) => candidate.vscodeTerminal) ? "vscode" : "os";
    const terminalId = root.terminalId ?? group.find((candidate) => candidate.terminalId)?.terminalId;
    const windowTitle = selectTerminalWindowTitle(group);

    return {
      id,
      title: buildTerminalWindowTitle(source, root, terminalId, windowTitle),
      source,
      terminalId,
      rootPid: root.pid,
      processGroupId: root.processGroupId,
      candidatePids: group.map((candidate) => candidate.pid),
      candidateCount: group.length,
      command: root.command,
    };
  });
}

/** Chooses the grouping key that best represents a terminal window on each platform. */
function terminalWindowGroupKey(candidate: TerminalCandidate): string {
  if (candidate.terminalId !== undefined) {
    return `tty:${candidate.terminalId}`;
  }

  if (candidate.processGroupId !== undefined) {
    return `pgid:${candidate.processGroupId}`;
  }

  if (candidate.vscodeTerminal) {
    return `vscode:${candidate.pid}`;
  }

  return `pid:${candidate.pid}`;
}

/**
 * Finds the root shell for a terminal window. POSIX shells often use the
 * process-group leader as the actionable root; otherwise the oldest PID is the
 * least surprising representative for UI and attach attempts.
 */
function selectTerminalRoot(group: readonly TerminalCandidate[]): TerminalCandidate {
  const processGroupLeader = group.find(
    (candidate) => candidate.processGroupId !== undefined && candidate.pid === candidate.processGroupId,
  );

  if (processGroupLeader !== undefined) {
    return processGroupLeader;
  }

  return [...group].sort((left, right) => left.pid - right.pid)[0];
}

/** Chooses the user-visible terminal title collected from VS Code or the OS. */
function selectTerminalWindowTitle(group: readonly TerminalCandidate[]): string | undefined {
  const titledCandidate = group.find((candidate) => candidate.windowTitle?.trim());
  return titledCandidate?.windowTitle?.trim();
}

/** Builds a concise label that helps users distinguish terminal windows. */
function buildTerminalWindowTitle(
  source: TerminalWindow["source"],
  root: TerminalCandidate,
  terminalId: string | undefined,
  windowTitle: string | undefined,
): string {
  if (windowTitle !== undefined && windowTitle.length > 0) {
    return windowTitle;
  }

  if (source === "vscode") {
    return `VS Code: ${root.name}`;
  }

  if (terminalId !== undefined) {
    return `Terminal ${terminalId}`;
  }

  return `Terminal PID ${root.pid}`;
}

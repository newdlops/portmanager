import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ComposeContainerMutationMapping,
  ComposePortMutationState,
  ComposePublishedPort,
  ContainerRuntimePreference,
  ContainerRuntimeSettings,
  ContainerServiceCandidate,
  PortManagerCloneCandidateMetadata,
} from "../../shared/types";
import type { ContainerCommandResult, ContainerCommandRunner } from "./container-runtime";

/**
 * Discovers running Docker/Podman containers that publish host ports.
 *
 * This adapter does not mutate containers or compose projects. It only turns
 * runtime CLI rows into attach candidates so the extension can register their
 * host-published endpoints as logical-network routes.
 */

const execFileAsync = promisify(execFile);
const LIST_TIMEOUT_MS = 5_000;
const CONTAINER_ALIAS_SERVICE_PREFIX = "__portmanager_alias__:";

export interface ContainerServiceDiscoveryOptions {
  /** Injected command runner used by unit tests to avoid real Docker calls. */
  readonly runCommand?: ContainerCommandRunner;
}

export class ContainerServiceDiscoveryAdapter {
  /** Low-level command runner; production uses child_process.execFile. */
  private readonly runCommand: ContainerCommandRunner;

  constructor(options: ContainerServiceDiscoveryOptions = {}) {
    this.runCommand = options.runCommand ?? runContainerCommand;
  }

  /** Lists published-port candidates from the first responsive configured runtime. */
  async list(settings: ContainerRuntimeSettings): Promise<readonly ContainerServiceCandidate[]> {
    for (const executable of runtimeCandidates(settings.containerRuntime)) {
      try {
        const runningRows = await this.listRuntimeRows(executable, false);
        const contextRows = await this.listRuntimeRows(executable, true).catch(() => runningRows);
        return parseContainerRows(executable, runningRows, contextRows);
      } catch {
        // Try the next configured runtime. UI refresh should not fail just
        // because Docker/Podman is absent or not running.
      }
    }

    return [];
  }

  /**
   * Repairs logical ports for a Port Manager-generated compose clone.
   *
   * Older persisted attachments may have been created from the clone project
   * itself, so their logical port equals Docker's hidden host port. Docker
   * Desktop keeps the original project's published port labels on stopped
   * containers; those labels let us restore the user-facing logical port while
   * preserving the clone's current hidden actual port.
   */
  async recoverPortManagerClonePorts(
    settings: ContainerRuntimeSettings,
    composeFiles: readonly string[],
    ports: readonly ComposePublishedPort[],
  ): Promise<readonly ComposePublishedPort[]> {
    if (!hasPortManagerOverrideFile(composeFiles)) {
      return ports;
    }

    for (const executable of runtimeCandidates(settings.containerRuntime)) {
      try {
        const contextRows = await this.listRuntimeRows(executable, true);
        const context = buildPortRecoveryContext(contextRows);
        return recoverPortsFromContext(context, composeFiles, ports);
      } catch {
        // Try the next configured runtime.
      }
    }

    return ports;
  }

  /**
   * Refreshes Docker-assigned host ports for an attached compose project.
   *
   * Hidden clone projects publish container ports with an empty HostPort, so
   * Docker can assign a different concrete localhost port every time compose
   * recreates or starts a container. Persisted attachments keep the stable
   * logical port and use this refresh to chase only the live actual endpoint.
   */
  async refreshComposePublishedPorts(
    settings: ContainerRuntimeSettings,
    projectName: string,
    composeFiles: readonly string[],
    ports: readonly ComposePublishedPort[],
  ): Promise<readonly ComposePublishedPort[]> {
    if (ports.length === 0 || projectName.trim().length === 0) {
      return ports;
    }

    for (const executable of runtimeCandidates(settings.containerRuntime)) {
      try {
        const runningRows = await this.listRuntimeRows(executable, false);
        const contextRows = await this.listRuntimeRows(executable, true).catch(() => runningRows);
        const candidates = parseContainerRows(executable, runningRows, contextRows);
        return refreshPortsFromCandidates(projectName, composeFiles, ports, candidates);
      } catch {
        // Try the next configured runtime.
      }
    }

    return ports;
  }

  /**
   * Refreshes service-to-container rewrites for a hidden compose clone.
   *
   * Docker gives recreated containers a new id. The shell-side Docker wrapper
   * must keep routing both original project tokens and stale clone hashes to
   * the currently running clone container, otherwise lifecycle commands can
   * escape back to the host project or target a deleted container id.
   */
  async refreshComposeContainerMappings(
    settings: ContainerRuntimeSettings,
    originalProjectName: string,
    attachedProjectName: string,
    composeFiles: readonly string[],
    services: readonly string[],
    currentMappings: readonly ComposeContainerMutationMapping[],
  ): Promise<readonly ComposeContainerMutationMapping[]> {
    if (attachedProjectName.trim().length === 0 || currentMappings.length === 0) {
      return currentMappings;
    }

    for (const executable of runtimeCandidates(settings.containerRuntime)) {
      try {
        const rows = await this.listRuntimeRows(executable, true);
        return refreshContainerMappingsFromIdentities(
          originalProjectName,
          attachedProjectName,
          composeFiles,
          services,
          currentMappings,
          parseComposeContainerIdentities(await this.enrichRuntimeRowsWithInspectNames(executable, rows)),
        );
      } catch {
        // Try the next configured runtime.
      }
    }

    return currentMappings;
  }

  /** Reads JSON rows from `docker container ls` or `podman container ls`. */
  private async listRuntimeRows(
    executable: "docker" | "podman",
    includeStopped: boolean,
  ): Promise<readonly RuntimeContainerRow[]> {
    const result = await this.runCommand(
      executable,
      ["container", "ls", ...(includeStopped ? ["-a"] : []), "--format", "{{json .}}"],
      { timeoutMs: LIST_TIMEOUT_MS },
    );

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseRuntimeContainerRow)
      .filter((row): row is RuntimeContainerRow => row !== undefined);
  }

  /**
   * Fills container names from inspect when `container ls` omits or normalizes
   * them differently. Routing maps use names as stable command targets, so this
   * repair keeps recreated compose containers addressable after id churn.
   */
  private async enrichRuntimeRowsWithInspectNames(
    executable: "docker" | "podman",
    rows: readonly RuntimeContainerRow[],
  ): Promise<readonly RuntimeContainerRow[]> {
    const containerIds = uniqueStrings(
      rows
        .map((row) => readFirstString(row.ID, row.Id))
        .filter((id): id is string => id !== undefined),
    );
    if (containerIds.length === 0) {
      return rows;
    }

    try {
      const result = await this.runCommand(executable, ["container", "inspect", ...containerIds], {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      return mergeRuntimeContainerRowsWithInspectNames(rows, parseRuntimeContainerInspectIdentityRows(result.stdout));
    } catch {
      return rows;
    }
  }
}

export interface RuntimeContainerRow {
  readonly ID?: string;
  readonly Id?: string;
  readonly Names?: string;
  readonly Name?: string;
  readonly Image?: string;
  readonly Status?: string;
  readonly Ports?: string;
  readonly Labels?: string;
}

export interface RuntimeContainerInspectIdentityRow {
  readonly ID?: string;
  readonly Id?: string;
  readonly Name?: string;
}

interface ComposeContainerIdentity {
  readonly id: string;
  readonly name: string;
  readonly composeProject: string;
  readonly composeService: string;
  readonly composeConfigFiles: readonly string[];
}

interface OriginalCloneSource {
  readonly id: string;
  readonly name: string;
  readonly composeProject: string;
  readonly composeService: string;
  readonly composeConfigFiles: readonly string[];
}

/** Converts an already-running Port Manager clone candidate back into durable attach state. */
export function buildExistingCloneMutationFromCandidate(
  candidate: ContainerServiceCandidate,
): ComposePortMutationState | undefined {
  const clone = candidate.portManagerClone;
  if (clone === undefined || candidate.ports.length === 0) {
    return undefined;
  }

  const services = uniqueStrings(candidate.ports.map((port) => port.serviceName));
  if (services.length === 0) {
    return undefined;
  }

  return {
    mode: "clone",
    runtime: candidate.runtime,
    originalProjectName: clone.originalProjectName,
    attachedProjectName: clone.attachedProjectName,
    ...(candidate.composeWorkingDirectory !== undefined ? { workingDirectory: candidate.composeWorkingDirectory } : {}),
    composeFiles: clone.composeFiles,
    services,
    overrideFile: clone.overrideFile,
    originalPorts: clone.originalPorts ?? candidate.ports.map(toBestEffortOriginalPort),
    hiddenPorts: candidate.ports.map(dropComposeProcessId),
    ...(clone.containerMappings !== undefined && clone.containerMappings.length > 0
      ? { containerMappings: clone.containerMappings }
      : {}),
  };
}

/** Converts runtime JSON rows into attachable service candidates. */
export function parseContainerRows(
  runtime: "docker" | "podman",
  rows: readonly RuntimeContainerRow[],
  contextRows: readonly RuntimeContainerRow[] = rows,
): readonly ContainerServiceCandidate[] {
  const context = buildPortRecoveryContext(contextRows);

  return rows
    .map((row) => toContainerServiceCandidate(runtime, row, context))
    .filter((candidate): candidate is ContainerServiceCandidate => candidate !== undefined);
}

function toContainerServiceCandidate(
  runtime: "docker" | "podman",
  row: RuntimeContainerRow,
  context: PortRecoveryContext,
): ContainerServiceCandidate | undefined {
  const containerId = readFirstString(row.ID, row.Id);
  const containerName = normalizeContainerName(readFirstString(row.Names, row.Name));
  if (containerId === undefined || containerName === undefined) {
    return undefined;
  }

  const labels = parseLabels(row.Labels);
  const composeProject = readLabel(labels, "com.docker.compose.project", "io.podman.compose.project");
  const composeService = readLabel(labels, "com.docker.compose.service", "io.podman.compose.service");
  const composeWorkingDirectory = readLabel(
    labels,
    "com.docker.compose.project.working_dir",
    "io.podman.compose.project.working_dir",
  );
  const composeConfigFiles = parseComposeConfigFiles(
    readLabel(labels, "com.docker.compose.project.config_files", "io.podman.compose.project.config_files"),
  );
  const serviceName = composeService ?? containerName;
  const logicalPortOverrides = readPortManagerLogicalPortLabels(labels);
  const parsedPorts = parsePublishedPorts(row.Ports ?? "", serviceName, logicalPortOverrides);
  const ports = hasPortManagerOverrideFile(composeConfigFiles)
    ? parsedPorts.map((port) => ({ ...port, logicalPort: port.containerPort }))
    : parsedPorts;
  const portManagerClone = buildPortManagerCloneCandidateMetadata(
    context,
    containerId,
    containerName,
    composeProject,
    composeService,
    composeConfigFiles,
    ports,
  );

  if (ports.length === 0) {
    return undefined;
  }

  return {
    id: `${runtime}:${containerId}`,
    runtime,
    containerId,
    containerName,
    ...(row.Image ? { image: row.Image } : {}),
    ...(row.Status ? { status: row.Status } : {}),
    ...(composeProject ? { composeProject } : {}),
    ...(composeService ? { composeService } : {}),
    ...(composeWorkingDirectory ? { composeWorkingDirectory } : {}),
    ...(composeConfigFiles.length > 0 ? { composeConfigFiles } : {}),
    ...(portManagerClone !== undefined ? { portManagerClone } : {}),
    ports,
  };
}

function parseComposeContainerIdentities(rows: readonly RuntimeContainerRow[]): readonly ComposeContainerIdentity[] {
  return rows
    .map((row) => {
      const id = readFirstString(row.ID, row.Id);
      const name = normalizeContainerName(readFirstString(row.Names, row.Name));
      const labels = parseLabels(row.Labels);
      const composeProject = readLabel(labels, "com.docker.compose.project", "io.podman.compose.project");
      const composeService = readLabel(labels, "com.docker.compose.service", "io.podman.compose.service");
      if (id === undefined || name === undefined || composeProject === undefined || composeService === undefined) {
        return undefined;
      }

      return {
        id,
        name,
        composeProject,
        composeService,
        composeConfigFiles: parseComposeConfigFiles(
          readLabel(labels, "com.docker.compose.project.config_files", "io.podman.compose.project.config_files"),
        ),
      };
    })
    .filter((identity): identity is ComposeContainerIdentity => identity !== undefined);
}

/** Parses Docker/Podman `Ports` text into host-published TCP endpoints. */
function parsePublishedPorts(
  portsText: string,
  serviceName: string,
  logicalPortOverrides: ReadonlyMap<string, number>,
): readonly ComposePublishedPort[] {
  const portsByIdentity = new Map<string, ComposePublishedPort>();

  for (const token of portsText.split(",")) {
    const parsedPort = parsePublishedPortToken(token.trim(), serviceName, logicalPortOverrides);
    if (parsedPort === undefined) {
      continue;
    }

    const identity = `${parsedPort.actualHostAddress}:${parsedPort.actualHostPort}:${parsedPort.containerPort}:${parsedPort.protocol}`;
    if (!portsByIdentity.has(identity)) {
      portsByIdentity.set(identity, parsedPort);
    }
  }

  return [...portsByIdentity.values()];
}

function parsePublishedPortToken(
  token: string,
  serviceName: string,
  logicalPortOverrides: ReadonlyMap<string, number>,
): ComposePublishedPort | undefined {
  const arrowIndex = token.indexOf("->");
  if (arrowIndex < 0) {
    return undefined;
  }

  const left = token.slice(0, arrowIndex);
  const right = token.slice(arrowIndex + 2);
  const slashIndex = right.lastIndexOf("/");
  if (slashIndex < 0) {
    return undefined;
  }

  const protocol = right.slice(slashIndex + 1);
  if (protocol !== "tcp") {
    return undefined;
  }

  const containerPort = Number.parseInt(right.slice(0, slashIndex), 10);
  const hostEndpoint = parseHostEndpoint(left);
  if (!isTcpPort(containerPort) || hostEndpoint === undefined) {
    return undefined;
  }

  return {
    serviceName,
    logicalPort: logicalPortOverrides.get(buildPortOverrideKey(containerPort, protocol)) ?? hostEndpoint.port,
    actualHostAddress: normalizeHostAddress(hostEndpoint.host),
    actualHostPort: hostEndpoint.port,
    containerPort,
    protocol: "tcp",
    protocolName: inferProtocolName(containerPort),
  };
}

function parseHostEndpoint(value: string): { readonly host: string; readonly port: number } | undefined {
  if (value.startsWith("[")) {
    const endBracket = value.indexOf("]");
    if (endBracket < 0 || value[endBracket + 1] !== ":") {
      return undefined;
    }

    const port = Number.parseInt(value.slice(endBracket + 2), 10);
    return isTcpPort(port) ? { host: value.slice(1, endBracket), port } : undefined;
  }

  const separatorIndex = value.lastIndexOf(":");
  if (separatorIndex < 0) {
    const port = Number.parseInt(value, 10);
    return isTcpPort(port) ? { host: "127.0.0.1", port } : undefined;
  }

  const port = Number.parseInt(value.slice(separatorIndex + 1), 10);
  return isTcpPort(port) ? { host: value.slice(0, separatorIndex), port } : undefined;
}

function normalizeHostAddress(host: string): string {
  if (host.length === 0 || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }

  return host;
}

export function parseRuntimeContainerRow(line: string): RuntimeContainerRow | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as RuntimeContainerRow) : undefined;
  } catch {
    return undefined;
  }
}

export function parseRuntimeContainerInspectIdentityRows(value: string): readonly RuntimeContainerInspectIdentityRow[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RuntimeContainerInspectIdentityRow => typeof item === "object" && item !== null)
      : [];
  } catch {
    return [];
  }
}

export function mergeRuntimeContainerRowsWithInspectNames(
  rows: readonly RuntimeContainerRow[],
  inspectedRows: readonly RuntimeContainerInspectIdentityRow[],
): readonly RuntimeContainerRow[] {
  return rows.map((row) => {
    const containerId = readFirstString(row.ID, row.Id);
    const inspectedName =
      containerId === undefined ? undefined : findInspectedContainerName(inspectedRows, containerId);
    if (inspectedName === undefined) {
      return row;
    }

    return {
      ...row,
      Names: inspectedName,
      Name: inspectedName,
    };
  });
}

function parseLabels(value: string | undefined): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  let currentKey: string | undefined;

  for (const rawLabel of value?.split(",") ?? []) {
    const separatorIndex = rawLabel.indexOf("=");
    if (separatorIndex <= 0) {
      if (currentKey !== undefined) {
        labels.set(currentKey, `${labels.get(currentKey) ?? ""},${rawLabel}`);
      }
      continue;
    }

    currentKey = rawLabel.slice(0, separatorIndex);
    labels.set(currentKey, rawLabel.slice(separatorIndex + 1));
  }

  return labels;
}

interface PortRecoveryContext {
  readonly originalPortsByComposeContext: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly originalCloneSourcesByComposeContext: ReadonlyMap<string, readonly OriginalCloneSource[]>;
}

function buildPortRecoveryContext(rows: readonly RuntimeContainerRow[]): PortRecoveryContext {
  const portsByContext = new Map<string, Map<string, number | undefined>>();
  const originalCloneSourcesByComposeContext = new Map<string, OriginalCloneSource[]>();

  for (const row of rows) {
    const containerId = readFirstString(row.ID, row.Id);
    const containerName = normalizeContainerName(readFirstString(row.Names, row.Name));
    const labels = parseLabels(row.Labels);
    const composeProject = readLabel(labels, "com.docker.compose.project", "io.podman.compose.project");
    const composeService = readLabel(labels, "com.docker.compose.service", "io.podman.compose.service");
    const composeConfigFiles = parseComposeConfigFiles(
      readLabel(labels, "com.docker.compose.project.config_files", "io.podman.compose.project.config_files"),
    );

    if (composeService === undefined || composeConfigFiles.length === 0 || hasPortManagerOverrideFile(composeConfigFiles)) {
      continue;
    }

    const contextKey = buildOriginalPortContextKey(composeConfigFiles, composeService);
    if (composeProject !== undefined && containerId !== undefined && containerName !== undefined) {
      const source: OriginalCloneSource = {
        id: containerId,
        name: containerName,
        composeProject,
        composeService,
        composeConfigFiles,
      };
      const existingSources = originalCloneSourcesByComposeContext.get(contextKey) ?? [];
      if (!existingSources.some((item) => sameOriginalCloneSource(item, source))) {
        originalCloneSourcesByComposeContext.set(contextKey, [...existingSources, source]);
      }
    }

    const ports = portsByContext.get(contextKey) ?? new Map<string, number | undefined>();
    for (const [key, hostPort] of readDockerDesktopPublishedPortLabels(labels)) {
      if (!ports.has(key)) {
        ports.set(key, hostPort);
        continue;
      }

      const existing = ports.get(key);
      ports.set(key, existing === hostPort ? hostPort : undefined);
    }
    portsByContext.set(contextKey, ports);
  }

  const originalPortsByComposeContext = new Map<string, ReadonlyMap<string, number>>();
  for (const [contextKey, ports] of portsByContext) {
    const resolvedPorts = new Map<string, number>();
    for (const [portKey, hostPort] of ports) {
      if (hostPort !== undefined) {
        resolvedPorts.set(portKey, hostPort);
      }
    }
    if (resolvedPorts.size > 0) {
      originalPortsByComposeContext.set(contextKey, resolvedPorts);
    }
  }

  return { originalPortsByComposeContext, originalCloneSourcesByComposeContext };
}

function buildPortManagerCloneCandidateMetadata(
  context: PortRecoveryContext,
  containerId: string,
  containerName: string,
  composeProject: string | undefined,
  composeService: string | undefined,
  composeConfigFiles: readonly string[],
  ports: readonly ComposePublishedPort[],
): PortManagerCloneCandidateMetadata | undefined {
  const overrideFile = findPortManagerOverrideFile(composeConfigFiles);
  if (
    composeProject === undefined ||
    composeService === undefined ||
    overrideFile === undefined ||
    ports.length === 0
  ) {
    return undefined;
  }

  const sourceComposeFiles = composeConfigFiles.filter((file) => !isPortManagerOverrideFile(file));
  const originalSource = findOriginalCloneSourceForClone(context, sourceComposeFiles, composeService);
  if (sourceComposeFiles.length === 0 || originalSource === undefined) {
    return undefined;
  }

  const originalPortOverrides =
    context.originalPortsByComposeContext.get(buildOriginalPortContextKey(sourceComposeFiles, composeService)) ?? new Map();
  const originalPorts = ports.map((port) => {
    const originalHostPort = originalPortOverrides.get(buildPortOverrideKey(port.containerPort, port.protocol));
    return {
      ...port,
      logicalPort: port.containerPort,
      actualHostPort: originalHostPort ?? port.actualHostPort,
    };
  });

  return {
    originalProjectName: originalSource.composeProject,
    attachedProjectName: composeProject,
    composeFiles: sourceComposeFiles,
    overrideFile,
    originalPorts,
    containerMappings: [
      {
        serviceName: composeService,
        originalContainerId: originalSource.id,
        originalContainerName: originalSource.name,
        attachedContainerId: containerId,
        attachedContainerName: containerName,
      },
    ],
  };
}

function findOriginalCloneSourceForClone(
  context: PortRecoveryContext,
  sourceComposeFiles: readonly string[],
  composeService: string,
): OriginalCloneSource | undefined {
  const sources = context.originalCloneSourcesByComposeContext.get(
    buildOriginalPortContextKey(sourceComposeFiles, composeService),
  );
  if (sources === undefined || sources.length !== 1) {
    return undefined;
  }

  return sources[0];
}

function recoverPortsFromContext(
  context: PortRecoveryContext,
  composeFiles: readonly string[],
  ports: readonly ComposePublishedPort[],
): readonly ComposePublishedPort[] {
  if (!hasPortManagerOverrideFile(composeFiles)) {
    return ports;
  }

  void context;
  return ports.map((port) => ({ ...port, logicalPort: port.containerPort }));
}

function refreshPortsFromCandidates(
  projectName: string,
  composeFiles: readonly string[],
  ports: readonly ComposePublishedPort[],
  candidates: readonly ContainerServiceCandidate[],
): readonly ComposePublishedPort[] {
  const livePortsByKey = new Map<string, ComposePublishedPort | undefined>();

  for (const candidate of candidates) {
    if (
      candidate.composeProject !== projectName ||
      !composeCandidateMatchesFiles(candidate.composeConfigFiles ?? [], composeFiles)
    ) {
      continue;
    }

    for (const livePort of candidate.ports) {
      const key = buildComposeEndpointKey(livePort);
      const existingPort = livePortsByKey.get(key);
      if (!livePortsByKey.has(key)) {
        livePortsByKey.set(key, livePort);
        continue;
      }

      livePortsByKey.set(key, samePublishedEndpoint(existingPort, livePort) ? existingPort : undefined);
    }
  }

  return ports.map((port) => {
    const livePort = livePortsByKey.get(buildComposeEndpointKey(port));
    if (livePort === undefined) {
      return port;
    }

    return {
      ...port,
      logicalPort: resolveRefreshedLogicalPort(port, livePort),
      actualHostAddress: livePort.actualHostAddress,
      actualHostPort: livePort.actualHostPort,
      ...(port.protocolName === undefined && livePort.protocolName !== undefined
        ? { protocolName: livePort.protocolName }
        : {}),
    };
  });
}

function refreshContainerMappingsFromIdentities(
  originalProjectName: string,
  attachedProjectName: string,
  composeFiles: readonly string[],
  services: readonly string[],
  currentMappings: readonly ComposeContainerMutationMapping[],
  identities: readonly ComposeContainerIdentity[],
): readonly ComposeContainerMutationMapping[] {
  const sourceComposeFiles = composeFiles.filter((file) => !isPortManagerOverrideFile(file));
  const originalByService = groupIdentitiesByService(
    identities.filter(
      (identity) =>
        identity.composeProject === originalProjectName &&
        composeCandidateMatchesFiles(identity.composeConfigFiles, sourceComposeFiles),
    ),
  );
  const attachedByService = groupIdentitiesByService(
    identities.filter(
      (identity) =>
        identity.composeProject === attachedProjectName &&
        composeCandidateMatchesFiles(identity.composeConfigFiles, sourceComposeFiles),
    ),
  );
  const currentCanonicalByService = new Map(
    currentMappings
      .filter((mapping) => !isContainerAliasMapping(mapping))
      .map((mapping) => [mapping.serviceName, mapping]),
  );
  const serviceNames = uniqueStrings([
    ...services,
    ...currentCanonicalByService.keys(),
    ...originalByService.keys(),
    ...attachedByService.keys(),
  ]);
  const canonicalMappings: ComposeContainerMutationMapping[] = [];

  for (const serviceName of serviceNames) {
    const currentMapping = currentCanonicalByService.get(serviceName);
    const original = singleIdentity(originalByService.get(serviceName));
    const attached = singleIdentity(attachedByService.get(serviceName));
    const attachedContainerId = attached?.id ?? currentMapping?.attachedContainerId;
    const attachedContainerName = attached?.name ?? currentMapping?.attachedContainerName;
    if (attachedContainerId === undefined || attachedContainerName === undefined) {
      continue;
    }

    canonicalMappings.push({
      serviceName,
      originalContainerId: original?.id ?? currentMapping?.originalContainerId ?? attachedContainerId,
      originalContainerName: original?.name ?? currentMapping?.originalContainerName ?? attachedContainerName,
      attachedContainerId,
      attachedContainerName,
    });
  }

  if (canonicalMappings.length === 0) {
    return currentMappings;
  }

  const nextByService = new Map(canonicalMappings.map((mapping) => [mapping.serviceName, mapping]));
  const currentServiceByAttachedId = new Map(
    [...currentCanonicalByService.values()].map((mapping) => [mapping.attachedContainerId, mapping.serviceName]),
  );
  const aliasMappings: ComposeContainerMutationMapping[] = [];
  const aliasKeys = new Set<string>();

  for (const currentMapping of currentMappings) {
    const serviceName =
      !isContainerAliasMapping(currentMapping)
        ? currentMapping.serviceName
        : currentServiceByAttachedId.get(currentMapping.attachedContainerId);
    const nextMapping = serviceName === undefined ? undefined : nextByService.get(serviceName);
    if (nextMapping === undefined) {
      continue;
    }

    if (currentMapping.attachedContainerId !== nextMapping.attachedContainerId) {
      pushContainerAlias(aliasMappings, aliasKeys, currentMapping.attachedContainerId, "", nextMapping);
    }

    if (isContainerAliasMapping(currentMapping) && currentMapping.originalContainerId !== nextMapping.attachedContainerId) {
      pushContainerAlias(
        aliasMappings,
        aliasKeys,
        currentMapping.originalContainerId,
        currentMapping.originalContainerName,
        nextMapping,
      );
    }
  }

  return [...canonicalMappings, ...aliasMappings];
}

function pushContainerAlias(
  aliases: ComposeContainerMutationMapping[],
  keys: Set<string>,
  sourceId: string,
  sourceName: string,
  target: ComposeContainerMutationMapping,
): void {
  if (sourceId.length === 0 || sourceId === target.attachedContainerId || sourceId === target.originalContainerId) {
    return;
  }

  const key = `${sourceId}\0${target.attachedContainerId}`;
  if (keys.has(key)) {
    return;
  }

  keys.add(key);
  aliases.push({
    serviceName: `${CONTAINER_ALIAS_SERVICE_PREFIX}${target.serviceName}`,
    originalContainerId: sourceId,
    originalContainerName: sourceName.length === 0 || sourceName === target.attachedContainerName ? sourceId : sourceName,
    attachedContainerId: target.attachedContainerId,
    attachedContainerName: target.attachedContainerName,
  });
}

function isContainerAliasMapping(mapping: ComposeContainerMutationMapping): boolean {
  return mapping.serviceName.length === 0 || mapping.serviceName.startsWith(CONTAINER_ALIAS_SERVICE_PREFIX);
}

function groupIdentitiesByService(
  identities: readonly ComposeContainerIdentity[],
): ReadonlyMap<string, readonly ComposeContainerIdentity[]> {
  const grouped = new Map<string, ComposeContainerIdentity[]>();

  for (const identity of identities) {
    grouped.set(identity.composeService, [...(grouped.get(identity.composeService) ?? []), identity]);
  }

  return grouped;
}

function singleIdentity(identities: readonly ComposeContainerIdentity[] | undefined): ComposeContainerIdentity | undefined {
  return identities?.length === 1 ? identities[0] : undefined;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (value.length === 0 || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function resolveRefreshedLogicalPort(storedPort: ComposePublishedPort, livePort: ComposePublishedPort): number {
  if (livePort.logicalPort !== livePort.actualHostPort || storedPort.logicalPort === storedPort.actualHostPort) {
    return livePort.logicalPort;
  }

  return storedPort.logicalPort;
}

function composeCandidateMatchesFiles(
  candidateFiles: readonly string[],
  expectedFiles: readonly string[],
): boolean {
  if (candidateFiles.length === 0 || expectedFiles.length === 0) {
    return true;
  }

  const candidateFileSet = new Set(candidateFiles.map(normalizeComposeFileKey));
  return expectedFiles.map(normalizeComposeFileKey).every((file) => candidateFileSet.has(file));
}

function samePublishedEndpoint(
  left: ComposePublishedPort | undefined,
  right: ComposePublishedPort,
): left is ComposePublishedPort {
  return (
    left !== undefined &&
    left.logicalPort === right.logicalPort &&
    left.actualHostAddress === right.actualHostAddress &&
    left.actualHostPort === right.actualHostPort
  );
}

function readPortManagerLogicalPortLabels(labels: ReadonlyMap<string, string>): ReadonlyMap<string, number> {
  const ports = new Map<string, number>();
  const prefix = "newdlops.portmanager.logical-port.";

  for (const [label, value] of labels) {
    if (!label.startsWith(prefix)) {
      continue;
    }

    const parts = label.slice(prefix.length).split(".");
    const containerPort = Number.parseInt(parts[0] ?? "", 10);
    const protocol = parts[1] ?? "";
    const logicalPort = Number.parseInt(value, 10);
    if (isTcpPort(containerPort) && isTcpPort(logicalPort) && protocol === "tcp") {
      ports.set(buildPortOverrideKey(containerPort, protocol), logicalPort);
    }
  }

  return ports;
}

function readDockerDesktopPublishedPortLabels(labels: ReadonlyMap<string, string>): ReadonlyMap<string, number> {
  const ports = new Map<string, number>();
  const prefix = "desktop.docker.io/ports/";

  for (const [label, value] of labels) {
    if (!label.startsWith(prefix)) {
      continue;
    }

    const parts = label.slice(prefix.length).split("/");
    const containerPort = Number.parseInt(parts[0] ?? "", 10);
    const protocol = parts[1] ?? "";
    const hostPort = Number.parseInt(value.replace(/^.*:/, ""), 10);
    if (isTcpPort(containerPort) && isTcpPort(hostPort) && protocol === "tcp") {
      ports.set(buildPortOverrideKey(containerPort, protocol), hostPort);
    }
  }

  return ports;
}

function buildOriginalPortContextKey(composeConfigFiles: readonly string[], composeService: string): string {
  return `${composeConfigFiles.map(normalizeComposeFileKey).sort().join("\0")}\0${composeService}`;
}

function hasPortManagerOverrideFile(composeConfigFiles: readonly string[]): boolean {
  return composeConfigFiles.some(isPortManagerOverrideFile);
}

function findPortManagerOverrideFile(composeConfigFiles: readonly string[]): string | undefined {
  return composeConfigFiles.find(isPortManagerOverrideFile);
}

function isPortManagerOverrideFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return normalized.includes("/compose-overrides/") && normalized.endsWith(".ports.override.yaml");
}

function normalizeComposeFileKey(file: string): string {
  return file.trim().replace(/\\/g, "/");
}

function sameOriginalCloneSource(left: OriginalCloneSource, right: OriginalCloneSource): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.composeProject === right.composeProject &&
    left.composeService === right.composeService &&
    composeCandidateMatchesFiles(left.composeConfigFiles, right.composeConfigFiles) &&
    composeCandidateMatchesFiles(right.composeConfigFiles, left.composeConfigFiles)
  );
}

function buildPortOverrideKey(containerPort: number, protocol: string): string {
  return `${containerPort}/${protocol}`;
}

function dropComposeProcessId(port: ComposePublishedPort): ComposePublishedPort {
  const { processId: _processId, ...rest } = port;
  return rest;
}

function toBestEffortOriginalPort(port: ComposePublishedPort): ComposePublishedPort {
  const { processId: _processId, ...rest } = port;
  return {
    ...rest,
    actualHostPort: port.logicalPort,
  };
}

function buildComposeEndpointKey(port: ComposePublishedPort): string {
  return `${port.serviceName}:${port.containerPort}:${port.protocol}`;
}

function parseComposeConfigFiles(value: string | undefined): readonly string[] {
  return (
    value
      ?.split(",")
      .map((file) => file.trim())
      .filter((file) => file.length > 0) ?? []
  );
}

function readLabel(labels: ReadonlyMap<string, string>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = labels.get(key);
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function readFirstString(...values: readonly (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => value !== undefined && value.length > 0);
}

function normalizeContainerName(value: string | undefined): string | undefined {
  const normalized = value?.split(",")[0]?.trim().replace(/^\/+/, "");
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function findInspectedContainerName(
  inspectedRows: readonly RuntimeContainerInspectIdentityRow[],
  containerId: string,
): string | undefined {
  for (const row of inspectedRows) {
    const inspectedId = readFirstString(row.ID, row.Id);
    if (inspectedId === undefined || !sameContainerId(inspectedId, containerId)) {
      continue;
    }

    const name = normalizeContainerName(row.Name);
    if (name !== undefined) {
      return name;
    }
  }

  return undefined;
}

function sameContainerId(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function inferProtocolName(port: number): string | undefined {
  switch (port) {
    case 5432:
    case 15432:
      return "postgresql";
    case 3306:
    case 13306:
      return "mysql";
    case 6379:
    case 16379:
      return "redis";
    case 5672:
    case 15672:
      return "rabbitmq";
    default:
      return undefined;
  }
}

function isTcpPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

async function runContainerCommand(
  executable: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly cwd?: string } = {},
): Promise<ContainerCommandResult> {
  try {
    const result = await execFileAsync(executable, [...args], {
      timeout: options.timeoutMs ?? LIST_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${executable} ${args.join(" ")} failed: ${detail}`);
  }
}

function runtimeCandidates(preference: ContainerRuntimePreference): readonly ("docker" | "podman")[] {
  switch (preference) {
    case "docker":
      return ["docker"];
    case "podman":
      return ["podman"];
    case "auto":
      return ["docker", "podman"];
  }
}

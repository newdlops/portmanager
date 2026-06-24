import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ComposePublishedPort,
  ContainerRuntimePreference,
  ContainerRuntimeSettings,
  ContainerServiceCandidate,
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
  const logicalPortOverrides = mergePortOverrides(
    readPortManagerLogicalPortLabels(labels),
    findOriginalLogicalPortsForClone(context, composeConfigFiles, composeService),
  );
  const ports = parsePublishedPorts(row.Ports ?? "", serviceName, logicalPortOverrides);

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
    ports,
  };
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
}

function buildPortRecoveryContext(rows: readonly RuntimeContainerRow[]): PortRecoveryContext {
  const portsByContext = new Map<string, Map<string, number | undefined>>();

  for (const row of rows) {
    const labels = parseLabels(row.Labels);
    const composeService = readLabel(labels, "com.docker.compose.service", "io.podman.compose.service");
    const composeConfigFiles = parseComposeConfigFiles(
      readLabel(labels, "com.docker.compose.project.config_files", "io.podman.compose.project.config_files"),
    );

    if (composeService === undefined || composeConfigFiles.length === 0 || hasPortManagerOverrideFile(composeConfigFiles)) {
      continue;
    }

    const contextKey = buildOriginalPortContextKey(composeConfigFiles, composeService);
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

  return { originalPortsByComposeContext };
}

function findOriginalLogicalPortsForClone(
  context: PortRecoveryContext,
  composeConfigFiles: readonly string[],
  composeService: string | undefined,
): ReadonlyMap<string, number> {
  if (composeService === undefined || !hasPortManagerOverrideFile(composeConfigFiles)) {
    return new Map();
  }

  const originalConfigFiles = composeConfigFiles.filter((file) => !isPortManagerOverrideFile(file));
  if (originalConfigFiles.length === 0) {
    return new Map();
  }

  return context.originalPortsByComposeContext.get(buildOriginalPortContextKey(originalConfigFiles, composeService)) ?? new Map();
}

function recoverPortsFromContext(
  context: PortRecoveryContext,
  composeFiles: readonly string[],
  ports: readonly ComposePublishedPort[],
): readonly ComposePublishedPort[] {
  if (!hasPortManagerOverrideFile(composeFiles)) {
    return ports;
  }

  return ports.map((port) => {
    const overrides = findOriginalLogicalPortsForClone(context, composeFiles, port.serviceName);
    const logicalPort = overrides.get(buildPortOverrideKey(port.containerPort, port.protocol));
    return logicalPort === undefined ? port : { ...port, logicalPort };
  });
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

function mergePortOverrides(...maps: readonly ReadonlyMap<string, number>[]): ReadonlyMap<string, number> {
  const merged = new Map<string, number>();

  for (const map of maps) {
    for (const [key, value] of map) {
      merged.set(key, value);
    }
  }

  return merged;
}

function buildOriginalPortContextKey(composeConfigFiles: readonly string[], composeService: string): string {
  return `${composeConfigFiles.map(normalizeComposeFileKey).sort().join("\0")}\0${composeService}`;
}

function hasPortManagerOverrideFile(composeConfigFiles: readonly string[]): boolean {
  return composeConfigFiles.some(isPortManagerOverrideFile);
}

function isPortManagerOverrideFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return normalized.includes("/compose-overrides/") && normalized.endsWith(".ports.override.yaml");
}

function normalizeComposeFileKey(file: string): string {
  return file.trim().replace(/\\/g, "/");
}

function buildPortOverrideKey(containerPort: number, protocol: string): string {
  return `${containerPort}/${protocol}`;
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

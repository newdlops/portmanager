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
        return parseContainerRows(executable, await this.listRuntimeRows(executable));
      } catch {
        // Try the next configured runtime. UI refresh should not fail just
        // because Docker/Podman is absent or not running.
      }
    }

    return [];
  }

  /** Reads JSON rows from `docker container ls` or `podman container ls`. */
  private async listRuntimeRows(executable: "docker" | "podman"): Promise<readonly RuntimeContainerRow[]> {
    const result = await this.runCommand(
      executable,
      ["container", "ls", "--format", "{{json .}}"],
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

interface RuntimeContainerRow {
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
): readonly ContainerServiceCandidate[] {
  return rows
    .map((row) => toContainerServiceCandidate(runtime, row))
    .filter((candidate): candidate is ContainerServiceCandidate => candidate !== undefined);
}

function toContainerServiceCandidate(
  runtime: "docker" | "podman",
  row: RuntimeContainerRow,
): ContainerServiceCandidate | undefined {
  const containerId = readFirstString(row.ID, row.Id);
  const containerName = normalizeContainerName(readFirstString(row.Names, row.Name));
  if (containerId === undefined || containerName === undefined) {
    return undefined;
  }

  const labels = parseLabels(row.Labels);
  const composeProject = readLabel(labels, "com.docker.compose.project", "io.podman.compose.project");
  const composeService = readLabel(labels, "com.docker.compose.service", "io.podman.compose.service");
  const serviceName = composeService ?? containerName;
  const ports = parsePublishedPorts(row.Ports ?? "", serviceName);

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
    ports,
  };
}

/** Parses Docker/Podman `Ports` text into host-published TCP endpoints. */
function parsePublishedPorts(portsText: string, serviceName: string): readonly ComposePublishedPort[] {
  const portsByIdentity = new Map<string, ComposePublishedPort>();

  for (const token of portsText.split(",")) {
    const parsedPort = parsePublishedPortToken(token.trim(), serviceName);
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

function parsePublishedPortToken(token: string, serviceName: string): ComposePublishedPort | undefined {
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
    // UI attach flows let users override this. The discovered host port is the
    // least surprising default because it is what compose currently exposes.
    logicalPort: hostEndpoint.port,
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

function parseRuntimeContainerRow(line: string): RuntimeContainerRow | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as RuntimeContainerRow) : undefined;
  } catch {
    return undefined;
  }
}

function parseLabels(value: string | undefined): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const rawLabel of value?.split(",") ?? []) {
    const separatorIndex = rawLabel.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    labels.set(rawLabel.slice(0, separatorIndex), rawLabel.slice(separatorIndex + 1));
  }

  return labels;
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
  options: { readonly timeoutMs?: number } = {},
): Promise<ContainerCommandResult> {
  try {
    const result = await execFileAsync(executable, [...args], {
      timeout: options.timeoutMs ?? LIST_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
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

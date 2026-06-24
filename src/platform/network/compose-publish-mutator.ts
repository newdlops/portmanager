import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ComposeContainerMutationMapping,
  ComposePortMutationMode,
  ComposePortMutationState,
  ComposePublishedPort,
  ContainerServiceCandidate,
} from "../../shared/types";
import type { ContainerCommandRunner } from "./container-runtime";
import {
  parseContainerRows,
  parseRuntimeContainerRow,
  type RuntimeContainerRow,
} from "./container-service-discovery";

/**
 * Rehomes a Compose service set into a hidden, network-scoped project.
 *
 * Docker publish rules are immutable for a running container, so attach cannot
 * truly hide a published port by editing Port Manager route tables alone. This
 * adapter creates a temporary compose override that replaces service `ports`
 * with Docker-allocated localhost ports, starts a hidden clone under a project
 * name derived from the logical network, and then stops the original project
 * services so the host port can be reused.
 */

const COMPOSE_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 5_000;
const VOLUME_COPY_TIMEOUT_MS = 120_000;
const VOLUME_COPY_IMAGE = "alpine:3.20";
const DEFAULT_COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export interface ComposePublishMutationInput {
  /** Clone creates a network-scoped project; in-place recreates the original project. */
  readonly mode?: ComposePortMutationMode;
  /** Explicit operator confirmation for cloning services that look stateful. */
  readonly allowStatefulClone?: boolean;
  /** Runtime CLI that owns the source compose project. */
  readonly runtime: "docker" | "podman";
  /** Logical network name used as the leading segment of the hidden project. */
  readonly networkName: string;
  /** Compose project that currently publishes the host ports. */
  readonly originalProjectName: string;
  /** Directory where compose should resolve relative paths and defaults. */
  readonly workingDirectory?: string;
  /** Compose files discovered from runtime labels or user input. */
  readonly composeFiles?: readonly string[];
  /** Published endpoints selected for attach. */
  readonly ports: readonly ComposePublishedPort[];
}

export interface ComposePublishMutationResult {
  /** Same logical ports as input, but pointing at Docker's hidden host ports. */
  readonly ports: readonly ComposePublishedPort[];
  /** Durable state required to restore the original compose project. */
  readonly state: ComposePortMutationState;
}

export interface ComposePublishMutatorOptions {
  /** Directory where generated compose override files are stored. */
  readonly storageDirectory: string;
  /** Injected command runner used by unit tests to avoid real Docker calls. */
  readonly runCommand: ContainerCommandRunner;
}

interface ComposeCommandContext {
  readonly runtime: "docker" | "podman";
  readonly projectName: string;
  readonly workingDirectory?: string;
  readonly composeFiles: readonly string[];
}

interface ComposeServiceContainer {
  readonly id: string;
  readonly name: string;
  readonly serviceName: string;
}

interface RuntimeContainerInspectRow {
  readonly Id?: string;
  readonly Name?: string;
  readonly Config?: {
    readonly Labels?: Record<string, string>;
  };
  readonly Mounts?: readonly RuntimeContainerMount[];
}

interface RuntimeContainerMount {
  readonly Type?: string;
  readonly Name?: string;
  readonly Source?: string;
  readonly Destination?: string;
  readonly RW?: boolean;
}

type ComposeServiceMount = ComposeVolumeMount | ComposeBindMount | ComposeTmpfsMount;

interface ComposeVolumeMount {
  readonly type: "volume";
  readonly sourceKey: string;
  readonly volumeName: string;
  readonly originalVolumeName: string;
  readonly target: string;
  readonly readOnly: boolean;
}

interface ComposeBindMount {
  readonly type: "bind";
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

interface ComposeTmpfsMount {
  readonly type: "tmpfs";
  readonly target: string;
  readonly readOnly: boolean;
}

interface VolumeClonePlan {
  readonly sourceVolumeName: string;
  readonly targetVolumeName: string;
}

/**
 * Low-level adapter for mutating Docker/Podman Compose projects.
 *
 * The extension service decides whether a candidate should be mutated. This
 * class only knows how to perform and later undo the Compose CLI operations.
 */
export class ComposePublishMutator {
  /** Directory that survives VS Code restarts so restore can reuse overrides. */
  private readonly storageDirectory: string;

  /** Low-level container runtime command runner. */
  private readonly runCommand: ContainerCommandRunner;

  constructor(options: ComposePublishMutatorOptions) {
    this.storageDirectory = options.storageDirectory;
    this.runCommand = options.runCommand;
  }

  /** Starts a hidden attached clone and stops the original published services. */
  async hidePublishedPorts(input: ComposePublishMutationInput): Promise<ComposePublishMutationResult> {
    if (input.ports.length === 0) {
      throw new Error("At least one compose published port is required.");
    }

    const mode = input.mode ?? "clone";
    const originalProjectName = assertNonEmptyString(input.originalProjectName, "Compose project name");
    const attachedProjectName =
      mode === "clone" ? buildAttachedProjectName(input.networkName, originalProjectName) : originalProjectName;
    const composeFiles = this.removeGeneratedOverrideFiles(
      await this.resolveComposeFiles(input.workingDirectory, input.composeFiles ?? []),
    );
    if (composeFiles.length === 0) {
      throw new Error("Compose attach needs the original compose files; generated Port Manager overrides cannot be used alone.");
    }
    const requestedServices = uniqueStrings(input.ports.map((port) => port.serviceName));
    const originalContext: ComposeCommandContext = {
      runtime: input.runtime,
      projectName: originalProjectName,
      workingDirectory: input.workingDirectory,
      composeFiles,
    };

    const definedServices = await this.listDefinedComposeServices(originalContext);
    const services = this.filterDefinedComposeServices(originalContext.projectName, requestedServices, definedServices);
    const overrideServices = mode === "clone" ? definedServices : services;
    const disabledOverrideServices =
      mode === "clone" ? definedServices.filter((service) => !services.includes(service)) : [];
    const ports = input.ports.filter((port) => services.includes(port.serviceName));
    const originalContainers = await this.listComposeServiceContainers(input.runtime, originalProjectName, services);
    const originalServiceMounts = await this.inspectServiceMounts(input.runtime, originalContainers);
    const statefulCloneServices = findStatefulCloneServices(ports, originalServiceMounts);
    if (mode === "clone" && statefulCloneServices.length > 0 && input.allowStatefulClone !== true) {
      throw new Error(
        `Clone attach includes stateful service${statefulCloneServices.length === 1 ? "" : "s"} with persistent mounts: ${statefulCloneServices.join(", ")}. Confirm stateful clone explicitly or use Attach as-is.`,
      );
    }
    const volumeClonePlan =
      mode === "clone"
        ? buildVolumeClonePlan(attachedProjectName, randomUUID().slice(0, 8), originalServiceMounts)
        : { serviceMounts: originalServiceMounts, volumeClones: [] };
    const overrideFile = await this.writeHiddenPortsOverride(
      attachedProjectName,
      overrideServices,
      ports,
      volumeClonePlan.serviceMounts,
      {
        resetContainerName: mode === "clone",
        isolatedNetwork: mode === "clone" ? "pm_isolated" : undefined,
        disabledServices: disabledOverrideServices,
      },
    );
    const hiddenContext: ComposeCommandContext = {
      runtime: input.runtime,
      projectName: attachedProjectName,
      workingDirectory: input.workingDirectory,
      composeFiles: appendUniqueComposeFile(composeFiles, overrideFile),
    };
    let originalStopped = false;
    let hiddenStarted = false;
    let clonedVolumesCreated = false;

    try {
      if (mode === "clone") {
        await this.runCompose(originalContext, ["stop", ...services]);
        originalStopped = true;
        await this.copyVolumes(input.runtime, volumeClonePlan.volumeClones);
        clonedVolumesCreated = true;
      }
      await this.runCompose(hiddenContext, ["up", "-d", "--force-recreate", "--no-deps", ...services]);
      hiddenStarted = true;
      const hiddenCandidates = await this.discoverHiddenComposeCandidates(input.runtime, attachedProjectName);
      const hiddenPorts = resolveHiddenPorts(attachedProjectName, ports, hiddenCandidates);
      assertHiddenPortsAreIsolated(hiddenPorts);
      const containerMappings =
        mode === "clone" ? buildContainerCloneMappings(originalContainers, hiddenCandidates) : [];

      return {
        ports: hiddenPorts,
        state: {
          mode,
          runtime: input.runtime,
          originalProjectName,
          attachedProjectName,
          ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
          composeFiles,
          services,
          overrideFile,
          originalPorts: ports.map((port) => ({ ...port })),
          hiddenPorts,
          ...(containerMappings.length > 0 ? { containerMappings } : {}),
          clonedVolumeNames: volumeClonePlan.volumeClones.map((volume) => volume.targetVolumeName),
        },
      };
    } catch (error) {
      if (hiddenStarted && mode === "clone") {
        await this.runCompose(hiddenContext, ["down", "--remove-orphans"]).catch(() => undefined);
      }
      if (hiddenStarted && mode === "in-place") {
        await this.runCompose(originalContext, ["up", "-d", "--force-recreate", "--no-deps", ...services]).catch(() => undefined);
      }
      if (originalStopped) {
        await this.runCompose(originalContext, ["up", "-d", ...services]).catch(() => undefined);
      }
      if (clonedVolumesCreated) {
        await this.removeVolumes(input.runtime, volumeClonePlan.volumeClones.map((volume) => volume.targetVolumeName));
      }
      await fs.rm(overrideFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Stops the hidden clone before restoring the original project.
   *
   * Hidden clones can intentionally reuse the original volumes. They must not
   * run concurrently with the restored project, especially for database data
   * directories. If the original cannot start, the hidden clone is restarted so
   * the attachment remains testable and removable.
   */
  async restorePublishedPorts(state: ComposePortMutationState): Promise<void> {
    const originalContext: ComposeCommandContext = {
      runtime: state.runtime,
      projectName: state.originalProjectName,
      workingDirectory: state.workingDirectory,
      composeFiles: state.composeFiles,
    };
    const hiddenContext: ComposeCommandContext = {
      runtime: state.runtime,
      projectName: state.attachedProjectName,
      workingDirectory: state.workingDirectory,
      composeFiles: [...state.composeFiles, state.overrideFile],
    };
    let hiddenStopped = false;

    if (state.mode === "in-place") {
      try {
        await this.runCompose(originalContext, ["up", "-d", "--force-recreate", "--no-deps", ...state.services]);
        await fs.rm(state.overrideFile, { force: true }).catch(() => undefined);
      } catch (error) {
        await this.runCompose(hiddenContext, ["up", "-d", "--force-recreate", "--no-deps", ...state.services]).catch(
          () => undefined,
        );
        throw error;
      }
      return;
    }

    try {
      await this.runCompose(hiddenContext, ["stop", ...state.services]);
      hiddenStopped = true;
      await this.runCompose(originalContext, ["up", "-d", ...state.services]);
      await this.runCompose(hiddenContext, ["down", "--remove-orphans"]);
      // Clone volumes are intentionally preserved on detach because they may
      // contain divergent database state created while the clone was attached.
      await fs.rm(state.overrideFile, { force: true }).catch(() => undefined);
    } catch (error) {
      if (hiddenStopped) {
        await this.runCompose(hiddenContext, ["start", ...state.services]).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Resolves default compose files when labels do not include config_files. */
  private async resolveComposeFiles(
    workingDirectory: string | undefined,
    composeFiles: readonly string[],
  ): Promise<readonly string[]> {
    const explicitFiles = composeFiles.map((file) => file.trim()).filter((file) => file.length > 0);
    if (explicitFiles.length > 0) {
      return uniqueStrings(explicitFiles);
    }

    if (workingDirectory === undefined) {
      throw new Error("Compose attach needs compose file labels or a working directory.");
    }

    const discoveredFiles: string[] = [];
    for (const fileName of DEFAULT_COMPOSE_FILES) {
      const filePath = path.join(workingDirectory, fileName);
      if (await fileExists(filePath)) {
        discoveredFiles.push(filePath);
      }
    }

    if (discoveredFiles.length === 0) {
      throw new Error(`No compose file was found in ${workingDirectory}.`);
    }

    return discoveredFiles;
  }

  /**
   * Docker labels on a previously attached clone can include Port Manager's
   * generated override. Treat it as runtime state, not as a source compose file,
   * so a later mutation cannot stack the same `-f` file onto itself.
   */
  private removeGeneratedOverrideFiles(composeFiles: readonly string[]): readonly string[] {
    const storageDirectory = normalizeComparablePath(this.storageDirectory);

    return composeFiles.filter((file) => {
      const normalizedFile = normalizeComparablePath(file);
      return (
        normalizedFile === undefined ||
        storageDirectory === undefined ||
        path.dirname(normalizedFile) !== storageDirectory ||
        !path.basename(normalizedFile).endsWith(".ports.override.yaml")
      );
    });
  }

  /** Writes a Compose override whose only job is to replace published ports. */
  private async writeHiddenPortsOverride(
    attachedProjectName: string,
    services: readonly string[],
    ports: readonly ComposePublishedPort[],
    serviceMounts: ReadonlyMap<string, readonly ComposeServiceMount[]>,
    options: {
      readonly resetContainerName: boolean;
      readonly isolatedNetwork?: string;
      readonly disabledServices?: readonly string[];
    },
  ): Promise<string> {
    await fs.mkdir(this.storageDirectory, { recursive: true });
    const overrideFile = path.join(this.storageDirectory, `${attachedProjectName}.ports.override.yaml`);
    const portsByService = groupPortsByService(ports);
    const disabledServices = new Set(options.disabledServices ?? []);
    const lines = ["services:"];

    for (const serviceName of uniqueStrings(services)) {
      const servicePorts = portsByService.get(serviceName) ?? [];
      lines.push(`  ${quoteYamlString(serviceName)}:`);
      if (options.resetContainerName) {
        lines.push("    container_name: !reset null");
        lines.push("    network_mode: !reset null");
        lines.push("    links: !reset []");
        lines.push("    external_links: !reset []");
      }
      if (disabledServices.has(serviceName)) {
        lines.push("    profiles: !override");
        lines.push("      - 'pm_unattached'");
      }
      if (options.isolatedNetwork !== undefined) {
        lines.push("    networks: !override");
        lines.push(`      - ${quoteYamlString(options.isolatedNetwork)}`);
      }
      if (servicePorts.length === 0) {
        lines.push("    ports: !override []");
      } else {
        lines.push("    labels:");
        lines.push("      newdlops.portmanager.compose-clone-service: '1'");
        for (const port of servicePorts) {
          lines.push(
            `      ${quoteYamlString(buildLogicalPortLabelKey(port.containerPort, port.protocol))}: ${quoteYamlString(String(port.logicalPort))}`,
          );
        }
        lines.push("    ports: !override");
        for (const port of servicePorts) {
          lines.push(`      - ${quoteYamlString(`127.0.0.1::${port.containerPort}/${port.protocol}`)}`);
        }
      }

      const mounts = serviceMounts.get(serviceName) ?? [];
      if (mounts.length > 0) {
        lines.push("    volumes: !override");
        for (const mount of mounts) {
          appendServiceMount(lines, mount);
        }
      }
    }

    const volumeNames = collectVolumeNames(serviceMounts);
    if (volumeNames.size > 0) {
      lines.push("volumes:");
      for (const [sourceKey, volumeName] of volumeNames) {
        lines.push(`  ${quoteYamlString(sourceKey)}:`);
        lines.push("    external: true");
        lines.push(`    name: ${quoteYamlString(volumeName)}`);
      }
    }
    if (options.isolatedNetwork !== undefined) {
      lines.push("networks:");
      lines.push(`  ${quoteYamlString(options.isolatedNetwork)}:`);
      lines.push("    labels:");
      lines.push("      newdlops.portmanager.compose-clone: '1'");
      lines.push(`      newdlops.portmanager.compose-project: ${quoteYamlString(attachedProjectName)}`);
    }

    await fs.writeFile(overrideFile, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    return overrideFile;
  }

  /** Finds the original running service containers before they are stopped. */
  private async listComposeServiceContainers(
    runtime: "docker" | "podman",
    originalProjectName: string,
    services: readonly string[],
  ): Promise<readonly ComposeServiceContainer[]> {
    const serviceSet = new Set(services);
    const result = await this.runCommand(runtime, ["container", "ls", "--no-trunc", "--format", "{{json .}}"], {
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const rows = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseRuntimeContainerRow)
      .filter((row): row is RuntimeContainerRow => row !== undefined);
    const candidates = parseContainerRows(runtime, rows).filter(
      (candidate) =>
        candidate.composeProject === originalProjectName &&
        candidate.composeService !== undefined &&
        serviceSet.has(candidate.composeService),
    );

    return candidates.map((candidate) => ({
      id: candidate.containerId,
      name: candidate.containerName,
      serviceName: candidate.composeService!,
    }));
  }

  /** Converts Docker inspect mount rows into exact hidden-project overrides. */
  private async inspectServiceMounts(
    runtime: "docker" | "podman",
    containers: readonly ComposeServiceContainer[],
  ): Promise<ReadonlyMap<string, readonly ComposeServiceMount[]>> {
    if (containers.length === 0) {
      throw new Error("No running compose service containers were found for attach.");
    }

    const result = await this.runCommand(runtime, ["container", "inspect", ...containers.map((container) => container.id)], {
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const inspected = parseContainerInspectRows(result.stdout);
    if (inspected.length === 0) {
      throw new Error("Container inspect did not return mount metadata for compose attach.");
    }

    const serviceByContainerId = new Map(containers.map((container) => [container.id, container.serviceName]));
    const grouped = new Map<string, readonly ComposeServiceMount[]>();

    for (const row of inspected) {
      const serviceName = findInspectServiceName(row) ?? serviceByContainerId.get(row.Id ?? "");
      if (serviceName === undefined) {
        continue;
      }

      const mounts = parseContainerMounts(serviceName, row.Mounts ?? []);
      const existingMounts = grouped.get(serviceName);
      if (existingMounts !== undefined && (existingMounts.length > 0 || mounts.length > 0)) {
        throw new Error(`Scaled compose service ${serviceName} has volume mounts and cannot be safely attached.`);
      }

      grouped.set(serviceName, mounts);
    }

    return grouped;
  }

  /** Lists services from the current compose file set before mutating runtime containers. */
  private async listDefinedComposeServices(
    context: ComposeCommandContext,
  ): Promise<readonly string[]> {
    const result = await this.runCommand(context.runtime, this.buildComposeArgs(context, ["config", "--services"]), {
      timeoutMs: COMPOSE_TIMEOUT_MS,
      ...(context.workingDirectory !== undefined ? { cwd: context.workingDirectory } : {}),
    });
    return uniqueStrings(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  }

  /** Drops stale runtime-label services before mutating current compose services. */
  private filterDefinedComposeServices(
    projectName: string,
    services: readonly string[],
    definedServicesList: readonly string[],
  ): readonly string[] {
    const definedServices = new Set(definedServicesList);
    const missingServices = services.filter((service) => !definedServices.has(service));
    const matchedServices = services.filter((service) => definedServices.has(service));

    if (matchedServices.length === 0) {
      throw new Error(
        `Compose file set for project ${projectName} does not define any selected service. Missing service${missingServices.length === 1 ? "" : "s"}: ${missingServices.join(", ")}.`,
      );
    }

    return matchedServices;
  }

  /** Copies Docker volumes after the source service has been stopped. */
  private async copyVolumes(runtime: "docker" | "podman", volumeClones: readonly VolumeClonePlan[]): Promise<void> {
    for (const volume of volumeClones) {
      await this.runCommand(runtime, ["volume", "create", volume.targetVolumeName], {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      await this.runCommand(
        runtime,
        [
          "run",
          "--rm",
          "-v",
          `${volume.sourceVolumeName}:/from:ro`,
          "-v",
          `${volume.targetVolumeName}:/to`,
          VOLUME_COPY_IMAGE,
          "sh",
          "-lc",
          "cd /from && cp -a . /to",
        ],
        { timeoutMs: VOLUME_COPY_TIMEOUT_MS },
      );
    }
  }

  /** Best-effort rollback for cloned volumes created before a failed attach. */
  private async removeVolumes(runtime: "docker" | "podman", volumeNames: readonly string[]): Promise<void> {
    for (const volumeName of volumeNames) {
      await this.runCommand(runtime, ["volume", "rm", "-f", volumeName], {
        timeoutMs: LIST_TIMEOUT_MS,
      }).catch(() => undefined);
    }
  }

  /** Reads Docker's current hidden compose containers after recreate. */
  private async discoverHiddenComposeCandidates(
    runtime: "docker" | "podman",
    attachedProjectName: string,
  ): Promise<readonly ContainerServiceCandidate[]> {
    const result = await this.runCommand(runtime, ["container", "ls", "--no-trunc", "--format", "{{json .}}"], {
      timeoutMs: LIST_TIMEOUT_MS,
    });
    const rows = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseRuntimeContainerRow)
      .filter((row): row is RuntimeContainerRow => row !== undefined);
    return parseContainerRows(runtime, rows).filter((candidate) => candidate.composeProject === attachedProjectName);
  }

  /** Runs `docker compose` or `podman compose` with persisted cwd/file context. */
  private async runCompose(context: ComposeCommandContext, args: readonly string[]): Promise<void> {
    await this.runCommand(context.runtime, this.buildComposeArgs(context, args), {
      timeoutMs: COMPOSE_TIMEOUT_MS,
      ...(context.workingDirectory !== undefined ? { cwd: context.workingDirectory } : {}),
    });
  }

  private buildComposeArgs(context: ComposeCommandContext, args: readonly string[]): readonly string[] {
    return [
      "compose",
      "-p",
      context.projectName,
      ...context.composeFiles.flatMap((file) => ["-f", file]),
      ...args,
    ];
  }
}

function groupPortsByService(
  ports: readonly ComposePublishedPort[],
): ReadonlyMap<string, readonly ComposePublishedPort[]> {
  const grouped = new Map<string, ComposePublishedPort[]>();
  const seen = new Set<string>();

  for (const port of ports) {
    const serviceName = assertNonEmptyString(port.serviceName, "Compose service name");
    const key = `${serviceName}:${port.containerPort}:${port.protocol}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    grouped.set(serviceName, [...(grouped.get(serviceName) ?? []), port]);
  }

  return grouped;
}

function buildPortKey(port: ComposePublishedPort): string {
  return `${port.serviceName}:${port.containerPort}:${port.protocol}`;
}

function buildLogicalPortLabelKey(containerPort: number, protocol: string): string {
  return `newdlops.portmanager.logical-port.${containerPort}.${protocol}`;
}

function resolveHiddenPorts(
  attachedProjectName: string,
  originalPorts: readonly ComposePublishedPort[],
  candidates: readonly ContainerServiceCandidate[],
): readonly ComposePublishedPort[] {
  const hiddenPortsByKey = new Map<string, ComposePublishedPort>();

  for (const candidate of candidates) {
    for (const port of candidate.ports) {
      hiddenPortsByKey.set(buildPortKey(port), port);
    }
  }

  return originalPorts.map((originalPort) => {
    const hiddenPort = hiddenPortsByKey.get(buildPortKey(originalPort));
    if (hiddenPort === undefined) {
      throw new Error(
        `Hidden compose project ${attachedProjectName} did not publish ${originalPort.serviceName}:${originalPort.containerPort}/${originalPort.protocol}.`,
      );
    }

    return {
      ...originalPort,
      actualHostAddress: hiddenPort.actualHostAddress,
      actualHostPort: hiddenPort.actualHostPort,
    };
  });
}

function buildContainerCloneMappings(
  originalContainers: readonly ComposeServiceContainer[],
  hiddenCandidates: readonly ContainerServiceCandidate[],
): readonly ComposeContainerMutationMapping[] {
  const originalByService = groupBy(originalContainers, (container) => container.serviceName);
  const hiddenByService = groupBy(
    hiddenCandidates.filter((candidate) => candidate.composeService !== undefined),
    (candidate) => candidate.composeService!,
  );
  const mappings: ComposeContainerMutationMapping[] = [];

  for (const [serviceName, originals] of originalByService) {
    const hidden = hiddenByService.get(serviceName) ?? [];
    if (originals.length !== 1 || hidden.length !== 1) {
      continue;
    }

    mappings.push({
      serviceName,
      originalContainerId: originals[0]!.id,
      originalContainerName: originals[0]!.name,
      attachedContainerId: hidden[0]!.containerId,
      attachedContainerName: hidden[0]!.containerName,
    });
  }

  return mappings;
}

function groupBy<T>(values: readonly T[], keyForValue: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const value of values) {
    const key = keyForValue(value);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }

  return grouped;
}

function buildAttachedProjectName(networkName: string, originalProjectName: string): string {
  const networkSegment = sanitizeComposeProjectSegment(networkName) ?? "network";
  const originalSegment = sanitizeComposeProjectSegment(originalProjectName) ?? "compose";
  const hash = createHash("sha1").update(`${networkName}\0${originalProjectName}`).digest("hex").slice(0, 8);
  const prefix = trimProjectName(`${networkSegment}-${originalSegment}`, 52);

  // Network name stays first for Docker UI discoverability; the hash prevents
  // two original projects attached to the same network from sharing a project.
  return `${prefix}-${hash}`;
}

function appendServiceMount(lines: string[], mount: ComposeServiceMount): void {
  switch (mount.type) {
    case "volume":
      lines.push("      - type: volume");
      lines.push(`        source: ${quoteYamlString(mount.sourceKey)}`);
      lines.push(`        target: ${quoteYamlString(mount.target)}`);
      if (mount.readOnly) {
        lines.push("        read_only: true");
      }
      return;
    case "bind":
      lines.push("      - type: bind");
      lines.push(`        source: ${quoteYamlString(mount.source)}`);
      lines.push(`        target: ${quoteYamlString(mount.target)}`);
      if (mount.readOnly) {
        lines.push("        read_only: true");
      }
      return;
    case "tmpfs":
      lines.push("      - type: tmpfs");
      lines.push(`        target: ${quoteYamlString(mount.target)}`);
      if (mount.readOnly) {
        lines.push("        read_only: true");
      }
      return;
  }
}

function collectVolumeNames(
  serviceMounts: ReadonlyMap<string, readonly ComposeServiceMount[]>,
): ReadonlyMap<string, string> {
  const volumeNames = new Map<string, string>();

  for (const mounts of serviceMounts.values()) {
    for (const mount of mounts) {
      if (mount.type === "volume") {
        volumeNames.set(mount.sourceKey, mount.volumeName);
      }
    }
  }

  return volumeNames;
}

function buildVolumeClonePlan(
  attachedProjectName: string,
  cloneRunId: string,
  serviceMounts: ReadonlyMap<string, readonly ComposeServiceMount[]>,
): {
  readonly serviceMounts: ReadonlyMap<string, readonly ComposeServiceMount[]>;
  readonly volumeClones: readonly VolumeClonePlan[];
} {
  const clonedBySource = new Map<string, string>();
  const volumeClones: VolumeClonePlan[] = [];
  const clonedServiceMounts = new Map<string, readonly ComposeServiceMount[]>();

  for (const [serviceName, mounts] of serviceMounts) {
    clonedServiceMounts.set(
      serviceName,
      mounts.map((mount) => {
        if (mount.type !== "volume") {
          return mount;
        }

        let targetVolumeName = clonedBySource.get(mount.originalVolumeName);
        if (targetVolumeName === undefined) {
          targetVolumeName = buildClonedVolumeName(attachedProjectName, mount.originalVolumeName, cloneRunId);
          clonedBySource.set(mount.originalVolumeName, targetVolumeName);
          volumeClones.push({
            sourceVolumeName: mount.originalVolumeName,
            targetVolumeName,
          });
        }

        return {
          ...mount,
          volumeName: targetVolumeName,
        };
      }),
    );
  }

  return {
    serviceMounts: clonedServiceMounts,
    volumeClones,
  };
}

function buildClonedVolumeName(attachedProjectName: string, originalVolumeName: string, cloneRunId: string): string {
  const projectSegment = sanitizeComposeProjectSegment(attachedProjectName) ?? "compose";
  const hash = createHash("sha1").update(originalVolumeName).digest("hex").slice(0, 12);

  return trimProjectName(`pm-${projectSegment}-${hash}-${cloneRunId}`, 120);
}

function findStatefulCloneServices(
  ports: readonly ComposePublishedPort[],
  serviceMounts: ReadonlyMap<string, readonly ComposeServiceMount[]>,
): readonly string[] {
  const riskyServices = new Set<string>();

  for (const port of ports) {
    const mounts = serviceMounts.get(port.serviceName) ?? [];
    if (mounts.length === 0) {
      continue;
    }

    if (looksStatefulService(port)) {
      riskyServices.add(port.serviceName);
    }
  }

  return [...riskyServices].sort();
}

function assertHiddenPortsAreIsolated(hiddenPorts: readonly ComposePublishedPort[]): void {
  const leakedPorts = hiddenPorts.filter(
    (port) => port.actualHostPort === port.logicalPort && isLocalHostAddress(port.actualHostAddress),
  );

  if (leakedPorts.length === 0) {
    return;
  }

  throw new Error(
    `Compose hidden port mutation kept Docker-published host port${leakedPorts.length === 1 ? "" : "s"} equal to the logical port: ${leakedPorts.map(formatLeakedPort).join(", ")}. Attach would route to the host namespace, so the compose project was restored.`,
  );
}

function isLocalHostAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function formatLeakedPort(port: ComposePublishedPort): string {
  return `${port.serviceName}:${port.logicalPort}->${port.actualHostAddress}:${port.actualHostPort}`;
}

function looksStatefulService(port: ComposePublishedPort): boolean {
  const serviceName = port.serviceName.toLowerCase();
  const protocolName = port.protocolName?.toLowerCase();
  const statefulProtocols = new Set([
    "postgresql",
    "postgres",
    "mysql",
    "mariadb",
    "redis",
    "rabbitmq",
    "mongodb",
    "mongo",
    "weaviate",
    "elasticsearch",
    "opensearch",
  ]);
  const statefulPorts = new Set([5432, 3306, 33060, 6379, 5672, 15672, 27017, 9200, 9300, 7000, 8080, 50051]);

  return (
    (protocolName !== undefined && statefulProtocols.has(protocolName)) ||
    /\b(db|database|postgres|postgresql|mysql|mariadb|redis|rabbitmq|mongo|mongodb|weaviate|elastic|opensearch)\b/.test(
      serviceName.replace(/[-_]+/g, " "),
    ) ||
    statefulPorts.has(port.containerPort) ||
    statefulPorts.has(port.logicalPort)
  );
}

function parseContainerInspectRows(value: string): readonly RuntimeContainerInspectRow[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RuntimeContainerInspectRow => typeof item === "object" && item !== null)
      : [];
  } catch {
    return [];
  }
}

function findInspectServiceName(row: RuntimeContainerInspectRow): string | undefined {
  return readObjectLabel(row.Config?.Labels, "com.docker.compose.service", "io.podman.compose.service");
}

function parseContainerMounts(
  serviceName: string,
  mounts: readonly RuntimeContainerMount[],
): readonly ComposeServiceMount[] {
  return mounts.map((mount) => parseContainerMount(serviceName, mount));
}

function parseContainerMount(serviceName: string, mount: RuntimeContainerMount): ComposeServiceMount {
  const type = assertNonEmptyString(mount.Type ?? "", `Mount type for ${serviceName}`);
  const target = assertNonEmptyString(mount.Destination ?? "", `Mount target for ${serviceName}`);
  const readOnly = mount.RW === false;

  switch (type) {
    case "volume": {
      const volumeName = assertNonEmptyString(mount.Name ?? "", `Volume name for ${serviceName}:${target}`);
      return {
        type: "volume",
        sourceKey: buildVolumeSourceKey(volumeName),
        volumeName,
        originalVolumeName: volumeName,
        target,
        readOnly,
      };
    }
    case "bind":
      return {
        type: "bind",
        source: assertNonEmptyString(mount.Source ?? "", `Bind source for ${serviceName}:${target}`),
        target,
        readOnly,
      };
    case "tmpfs":
      return {
        type: "tmpfs",
        target,
        readOnly,
      };
    default:
      throw new Error(`Compose service ${serviceName} uses unsupported mount type ${type}.`);
  }
}

function buildVolumeSourceKey(volumeName: string): string {
  return `pm_volume_${createHash("sha1").update(volumeName).digest("hex").slice(0, 12)}`;
}

function readObjectLabel(labels: Record<string, string> | undefined, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = labels?.[key];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function sanitizeComposeProjectSegment(value: string): string | undefined {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_]+$/g, "");

  return sanitized.length === 0 ? undefined : sanitized;
}

function trimProjectName(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/[-_]+$/g, "") || "network";
}

function quoteYamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function appendUniqueComposeFile(composeFiles: readonly string[], overrideFile: string): readonly string[] {
  const overridePath = normalizeComparablePath(overrideFile);
  const existingFiles = composeFiles.filter((file) => normalizeComparablePath(file) !== overridePath);
  return [...existingFiles, overrideFile];
}

function normalizeComparablePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return path.normalize(path.resolve(trimmed));
}

function assertNonEmptyString(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required.`);
  }

  return trimmed;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

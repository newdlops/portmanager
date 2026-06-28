import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ComposeContainerMutationMapping,
  ComposePortMutationMode,
  ComposePortMutationState,
  ComposePublishedPort,
  ComposeVolumeMutationMapping,
  ContainerServiceCandidate,
} from "../../shared/types";
import type { ContainerCommandRunner } from "./container-runtime";
import { mergeComposeContainerMappingLineage } from "./compose-container-mappings";
import {
  mergeRuntimeContainerRowsWithInspectNames,
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
const HIDDEN_PORT_DISCOVERY_ATTEMPTS = 8;
const HIDDEN_PORT_DISCOVERY_DELAY_MS = 250;
const VOLUME_COPY_IMAGE = "alpine:3.20";
const DEFAULT_COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export interface ComposePublishMutationInput {
  /** Clone creates a network-scoped project; in-place recreates the original project. */
  readonly mode?: ComposePortMutationMode;
  /** Explicit operator confirmation for cloning services that look stateful. */
  readonly allowStatefulClone?: boolean;
  /** Optional exact Compose project name for the hidden clone. */
  readonly attachedProjectName?: string;
  /** Runtime CLI that owns the source compose project. */
  readonly runtime: "docker" | "podman";
  /** Logical network name used as the leading segment of the hidden project. */
  readonly networkName: string;
  /** Stable logical network identity used to separate copied networks with the same display name. */
  readonly networkId?: string;
  /** Compose project that currently publishes the host ports. */
  readonly originalProjectName: string;
  /** Directory where compose should resolve relative paths and defaults. */
  readonly workingDirectory?: string;
  /** Compose files discovered from runtime labels or user input. */
  readonly composeFiles?: readonly string[];
  /** Previous clone mapping lineage that must continue to route into this new clone. */
  readonly sourceContainerMappings?: readonly ComposeContainerMutationMapping[];
  /** Copy every defined service into the hidden project, including stopped/no-port services. */
  readonly copyStoppedServices?: boolean;
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
  readonly status?: string;
  readonly hasPublishedPorts: boolean;
  /** True when the container appears in the runtime's running-only list. */
  readonly isRunning: boolean;
}

interface ComposeServiceContainerList {
  readonly containers: readonly ComposeServiceContainer[];
  readonly inspectedRows: readonly RuntimeContainerInspectRow[];
}

interface ComposeServiceContainerListOptions {
  /** Include stopped/created containers so copy mode preserves dormant services. */
  readonly includeStopped?: boolean;
  /** Compose project label used to keep Docker/Podman list and inspect work scoped. */
  readonly composeProjectName?: string;
  /** Optional service label set used after runtime listing to avoid inspecting unrelated services. */
  readonly composeServices?: readonly string[];
}

interface HiddenPortResolutionOptions {
  /**
   * Copy/rename flows may intentionally create services that are not running
   * yet. Running containers are still preferred; stopped rows are only a final
   * fallback so Docker's control-plane lag does not fail a valid copy.
   */
  readonly includeStoppedFallback?: boolean;
}

interface RuntimeContainerInspectRow {
  readonly ID?: string;
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

interface RuntimeNameReservations {
  /** Docker/Podman container names are global and block explicit clone names. */
  readonly containerNames: ReadonlySet<string>;
  /** Compose project names already materialized in the runtime, even if their override file was deleted. */
  readonly composeProjectNames: ReadonlySet<string>;
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
  readonly sourceKind: "volume" | "bind";
  readonly sourceName: string;
  readonly targetVolumeName: string;
}

interface VolumeCloneMapping {
  readonly serviceName: string;
  readonly sourceKind: "volume" | "bind";
  readonly sourceName: string;
  readonly targetVolumeName: string;
  readonly containerPath: string;
  readonly readOnly: boolean;
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
    const createsHiddenProject = mode === "clone" || mode === "copy";
    if (!createsHiddenProject && input.attachedProjectName !== undefined && input.attachedProjectName.trim().length > 0) {
      throw new Error("Custom Compose project names are only supported for clone or copy attach.");
    }
    const requestedProjectName = assertNonEmptyString(input.originalProjectName, "Compose project name");
    const requestedAttachedProjectName =
      createsHiddenProject ? parseRequestedComposeProjectName(input.attachedProjectName) : undefined;
    const resolvedComposeFiles = await this.resolveComposeFiles(input.workingDirectory, input.composeFiles ?? []);
    const originalProjectName = requestedProjectName;
    const composeFiles = this.removeGeneratedOverrideFiles(resolvedComposeFiles);
    if (composeFiles.length === 0) {
      throw new Error("Compose attach needs the original compose files; generated Port Manager overrides cannot be used alone.");
    }
    const attachedProjectSourceName =
      createsHiddenProject
        ? await this.resolveAttachedProjectSourceName(requestedProjectName, input.workingDirectory, composeFiles)
        : originalProjectName;
    const requestedServices = uniqueStrings(input.ports.map((port) => port.serviceName));

    const originalContext: ComposeCommandContext = {
      runtime: input.runtime,
      projectName: originalProjectName,
      workingDirectory: input.workingDirectory,
      composeFiles,
    };

    const copyStoppedServices = createsHiddenProject && input.copyStoppedServices === true;
    const definedServices = await this.listDefinedComposeServices(originalContext);
    const existingServices =
      copyStoppedServices
        ? await this.listExistingComposeServices(originalContext).catch(() => [])
        : [];
    const availableServices = uniqueStrings([...definedServices, ...existingServices]);
    const requestedRouteServices = this.filterAvailableComposeServices(
      originalContext.projectName,
      requestedServices,
      availableServices,
    );
    const copiedServices = copyStoppedServices ? availableServices : requestedRouteServices;
    const originalContainerList = await this.listComposeServiceContainers(input.runtime, originalProjectName, copiedServices, {
      includeStopped: copyStoppedServices,
    });
    const originalContainers = originalContainerList.containers;
    const runningOriginalServices = new Set(
      originalContainers
        .filter(isRunningComposeServiceContainer)
        .map((container) => container.serviceName),
    );
    const services =
      mode === "copy" && copyStoppedServices
        ? requestedRouteServices.filter((service) => runningOriginalServices.has(service))
        : requestedRouteServices;
    const ports = input.ports.filter((port) => services.includes(port.serviceName));
    const overrideServices = createsHiddenProject ? (copyStoppedServices ? copiedServices : definedServices) : services;
    const disabledOverrideServices =
      mode === "clone" && !copyStoppedServices
        ? definedServices.filter((service) => !services.includes(service))
        : [];
    const originalServiceMounts = await this.inspectServiceMounts(
      input.runtime,
      originalContainers,
      originalContainerList.inspectedRows,
    );
    const serviceContainerNameSot =
      createsHiddenProject ? await readComposeServiceContainerNames(composeFiles) : new Map<string, string>();
    const statefulCloneServices = findStatefulCloneServices(ports, originalServiceMounts);
    if (createsHiddenProject && statefulCloneServices.length > 0 && input.allowStatefulClone !== true) {
      throw new Error(
        `Clone attach includes stateful service${statefulCloneServices.length === 1 ? "" : "s"} with persistent mounts: ${statefulCloneServices.join(", ")}. Confirm stateful clone explicitly or use Attach as-is.`,
      );
    }
    const statefulServiceNames = new Set(statefulCloneServices);
    const runtimeReservations =
      createsHiddenProject
        ? await this.readRuntimeNameReservations(input.runtime)
        : emptyRuntimeNameReservations();
    const attachedProjectName =
      !createsHiddenProject
        ? originalProjectName
        : requestedAttachedProjectName ??
          (await this.resolveGeneratedAttachedProjectName(
            buildAttachedProjectName(input.networkName, attachedProjectSourceName, input.networkId),
            originalProjectName,
            runtimeReservations.composeProjectNames,
          ));
    const volumeClonePlan =
      createsHiddenProject
        ? await buildVolumeClonePlan(attachedProjectName, randomUUID().slice(0, 8), originalServiceMounts, statefulServiceNames)
        : { serviceMounts: originalServiceMounts, volumeClones: [], volumeMappings: [] };
    const occupiedContainerNames =
      createsHiddenProject
        ? await this.findOccupiedCloneContainerNames(input.runtime, originalContainers, serviceContainerNameSot, runtimeReservations)
        : new Set<string>();
    const cloneContainerNames =
      createsHiddenProject
        ? buildCloneContainerNames(
            originalProjectName,
            attachedProjectName,
            originalContainers,
            serviceContainerNameSot,
            occupiedContainerNames,
          )
        : new Map<string, string>();
    const overrideFile = await this.writeHiddenPortsOverride(
      attachedProjectName,
      overrideServices,
      ports,
      volumeClonePlan.serviceMounts,
      {
        resetContainerName: createsHiddenProject,
        cloneContainerNames,
        isolatedNetwork: createsHiddenProject ? "pm_isolated" : undefined,
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
    let hiddenCreated = false;
    let clonedVolumesCreated = false;

    try {
      if (mode === "clone" && services.length > 0) {
        await this.runCompose(originalContext, ["stop", ...services]);
        originalStopped = true;
      }
      if (createsHiddenProject) {
        await this.copyVolumes(input.runtime, volumeClonePlan.volumeClones);
        clonedVolumesCreated = true;
      }
      if (services.length > 0) {
        await this.runCompose(hiddenContext, ["up", "-d", "--force-recreate", "--no-deps", ...services]);
        hiddenStarted = true;
      }
      const stoppedCopyServices = copyStoppedServices
        ? copiedServices.filter((service) => !services.includes(service))
        : [];
      if (stoppedCopyServices.length > 0) {
        await this.runCompose(hiddenContext, ["create", "--no-recreate", ...stoppedCopyServices]);
        hiddenCreated = true;
      }
      const hiddenPorts = await this.resolveHiddenPortsAfterComposeUp(input.runtime, attachedProjectName, ports, {
        includeStoppedFallback: copyStoppedServices,
      });
      assertHiddenPortsAreIsolated(hiddenPorts, ports);
      const hiddenContainerList =
        createsHiddenProject
          ? await this.listComposeServiceContainers(input.runtime, attachedProjectName, copiedServices, {
              includeStopped: copyStoppedServices,
            })
          : { containers: [], inspectedRows: [] };
      const containerMappings =
        createsHiddenProject
          ? mergeComposeContainerMappingLineage(
              input.sourceContainerMappings ?? [],
              buildContainerCloneMappings(originalContainers, hiddenContainerList.containers),
            )
          : [];
      const clonedVolumes = buildVolumeMutationMappings(volumeClonePlan.volumeMappings);

      return {
        ports: hiddenPorts,
        state: {
          mode,
          runtime: input.runtime,
          originalProjectName,
          attachedProjectName,
          ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
          composeFiles,
          services: copiedServices,
          overrideFile,
          originalPorts: ports.map((port) => ({ ...port })),
          hiddenPorts,
          ...(containerMappings.length > 0 ? { containerMappings } : {}),
          clonedVolumeNames: volumeClonePlan.volumeClones.map((volume) => volume.targetVolumeName),
          ...(clonedVolumes.length > 0 ? { clonedVolumes } : {}),
        },
      };
    } catch (error) {
      if ((hiddenStarted || hiddenCreated) && createsHiddenProject) {
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

    if (state.mode === "copy") {
      try {
        await this.runCompose(hiddenContext, ["stop", ...state.services]);
        hiddenStopped = true;
        await this.runCompose(hiddenContext, ["down", "--remove-orphans"]);
        await fs.rm(state.overrideFile, { force: true }).catch(() => undefined);
      } catch (error) {
        if (hiddenStopped) {
          await this.runCompose(hiddenContext, ["start", ...state.services]).catch(() => undefined);
        }
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

  /**
   * Recreates the generated override for a persisted mutation when VS Code's
   * globalStorage was cleaned while the hidden compose project kept running.
   *
   * The persisted mutation is the source of truth for the attached project name,
   * selected services, cloned volumes, and container-name lineage. Static compose
   * service discovery is repeated so no-port services with global container_name
   * values are still disabled in the restored override.
   */
  async restoreHiddenPortsOverride(state: ComposePortMutationState): Promise<string> {
    if (await fileIsReadable(state.overrideFile)) {
      return state.overrideFile;
    }

    const sourceContext: ComposeCommandContext = {
      runtime: state.runtime,
      projectName: state.originalProjectName,
      workingDirectory: state.workingDirectory,
      composeFiles: state.composeFiles,
    };
    const definedServices = await this.listDefinedComposeServices(sourceContext).catch(() => []);
    const overrideServices = buildRestoredOverrideServices(state, definedServices);
    const disabledServices = buildRestoredDisabledOverrideServices(state, overrideServices);
    const createsHiddenProject = state.mode === "clone" || state.mode === "copy";

    await this.writeHiddenPortsOverride(
      state.attachedProjectName,
      overrideServices,
      state.originalPorts,
      buildServiceMountsFromPersistedCloneVolumes(state.clonedVolumes),
      {
        resetContainerName: createsHiddenProject,
        cloneContainerNames: buildCloneContainerNameMapFromMutation(state),
        isolatedNetwork: createsHiddenProject ? "pm_isolated" : undefined,
        disabledServices,
        overrideFile: state.overrideFile,
      },
    );

    return state.overrideFile;
  }

  /**
   * Recreates an existing hidden clone under a new Compose project name.
   *
   * Compose project names are runtime identity, not a mutable label, so rename
   * is implemented as stop-old, start-new, refresh route state, then best-effort
   * cleanup of the previous hidden project. Volume mounts are inspected from
   * the running clone so stateful cloned volumes are reused rather than copied
   * again.
   */
  async renameAttachedProject(
    state: ComposePortMutationState,
    nextAttachedProjectName: string,
  ): Promise<ComposePublishMutationResult> {
    if (state.mode !== "clone") {
      throw new Error("Only cloned Compose attachments can change the hidden project name.");
    }

    const attachedProjectName = requireComposeProjectName(nextAttachedProjectName);
    if (attachedProjectName === state.attachedProjectName) {
      return {
        ports: state.hiddenPorts,
        state,
      };
    }

    const currentHiddenContext: ComposeCommandContext = {
      runtime: state.runtime,
      projectName: state.attachedProjectName,
      workingDirectory: state.workingDirectory,
      composeFiles: appendUniqueComposeFile([...state.composeFiles], state.overrideFile),
    };
    const sourceContext: ComposeCommandContext = {
      runtime: state.runtime,
      projectName: state.originalProjectName,
      workingDirectory: state.workingDirectory,
      composeFiles: state.composeFiles,
    };
    const currentContainerList = await this.listComposeServiceContainers(
      state.runtime,
      state.attachedProjectName,
      state.services,
    );
    const currentServiceMounts = await this.inspectServiceMounts(
      state.runtime,
      currentContainerList.containers,
      currentContainerList.inspectedRows,
    );
    const serviceContainerNameSot = await readComposeServiceContainerNames(state.composeFiles);
    const originalContainerSources = buildRenameContainerNameSources(state, currentContainerList.containers);
    const definedServices = await this.listDefinedComposeServices(sourceContext);
    const overrideServices = definedServices.length > 0 ? definedServices : state.services;
    const disabledOverrideServices = overrideServices.filter((service) => !state.services.includes(service));
    const runtimeReservations = await this.readRuntimeNameReservations(state.runtime);
    const occupiedContainerNames = await this.findOccupiedCloneContainerNames(
      state.runtime,
      originalContainerSources,
      serviceContainerNameSot,
      runtimeReservations,
    );
    const cloneContainerNames = buildCloneContainerNames(
      state.originalProjectName,
      attachedProjectName,
      originalContainerSources,
      serviceContainerNameSot,
      occupiedContainerNames,
    );
    const overrideFile = await this.writeHiddenPortsOverride(
      attachedProjectName,
      overrideServices,
      state.originalPorts,
      currentServiceMounts,
      {
        resetContainerName: true,
        cloneContainerNames,
        isolatedNetwork: "pm_isolated",
        disabledServices: disabledOverrideServices,
      },
    );
    const nextHiddenContext: ComposeCommandContext = {
      runtime: state.runtime,
      projectName: attachedProjectName,
      workingDirectory: state.workingDirectory,
      composeFiles: appendUniqueComposeFile([...state.composeFiles], overrideFile),
    };
    let currentStopped = false;
    let nextStarted = false;

    try {
      await this.runCompose(currentHiddenContext, ["stop", ...state.services]);
      currentStopped = true;
      await this.runCompose(nextHiddenContext, ["up", "-d", "--force-recreate", "--no-deps", ...state.services]);
      nextStarted = true;
      const hiddenPorts = await this.resolveHiddenPortsAfterComposeUp(state.runtime, attachedProjectName, state.originalPorts, {
        includeStoppedFallback: true,
      });
      assertHiddenPortsAreIsolated(hiddenPorts, state.originalPorts);
      const hiddenContainerList = await this.listComposeServiceContainers(state.runtime, attachedProjectName, state.services, {
        includeStopped: true,
      });
      const containerMappings = buildContainerCloneMappings(originalContainerSources, hiddenContainerList.containers);

      await this.runCompose(currentHiddenContext, ["down", "--remove-orphans"]).catch(() => undefined);
      await fs.rm(state.overrideFile, { force: true }).catch(() => undefined);

      return {
        ports: hiddenPorts,
        state: buildRenamedMutationState(state, attachedProjectName, overrideFile, hiddenPorts, containerMappings),
      };
    } catch (error) {
      if (nextStarted) {
        await this.runCompose(nextHiddenContext, ["down", "--remove-orphans"]).catch(() => undefined);
      }
      if (currentStopped) {
        await this.runCompose(currentHiddenContext, ["start", ...state.services]).catch(() => undefined);
      }
      await fs.rm(overrideFile, { force: true }).catch(() => undefined);
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
      return !isGeneratedOverridePath(normalizedFile, storageDirectory);
    });
  }

  /**
   * Chooses the destination clone's source name without changing the source project.
   *
   * Docker's current project name identifies the runtime source to stop/copy
   * from. The clone name instead follows Compose's own source of truth: top-level
   * `name:` in the original files, then the project directory fallback. That
   * keeps repeated copies stable even when the selected runtime project is
   * already a generated Port Manager clone or was started with an overridden
   * project name.
   */
  private async resolveAttachedProjectSourceName(
    requestedProjectName: string,
    workingDirectory: string | undefined,
    composeFiles: readonly string[],
  ): Promise<string> {
    return (await this.resolveComposeProjectNameFromFiles(workingDirectory, composeFiles)) ?? requestedProjectName;
  }

  /** Reads Compose's file-defined project name, falling back to its default project directory name. */
  private async resolveComposeProjectNameFromFiles(
    workingDirectory: string | undefined,
    composeFiles: readonly string[],
  ): Promise<string | undefined> {
    for (const composeFile of [...composeFiles].reverse()) {
      const configuredName = await readComposeConfiguredProjectName(composeFile);
      if (configuredName !== undefined) {
        return configuredName;
      }
    }

    const projectDirectory = workingDirectory?.trim() || path.dirname(composeFiles[0] ?? "");
    const projectName = path.basename(path.resolve(projectDirectory)).trim();
    return projectName.length === 0 ? undefined : projectName;
  }

  /**
   * Keeps generated clone names stable until they would overwrite an existing
   * generated override or target the source project itself. Same-network copies
   * can share the same deterministic base name, so collisions receive a short
   * per-copy suffix while explicit user-supplied project names remain exact.
   */
  private async resolveGeneratedAttachedProjectName(
    baseName: string,
    originalProjectName: string,
    runtimeComposeProjectNames: ReadonlySet<string>,
  ): Promise<string> {
    if (!(await this.generatedAttachedProjectNameCollides(baseName, originalProjectName, runtimeComposeProjectNames))) {
      return baseName;
    }

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = buildAttachedProjectCollisionName(baseName, randomUUID().replace(/-/g, "").slice(0, 8));
      if (!(await this.generatedAttachedProjectNameCollides(candidate, originalProjectName, runtimeComposeProjectNames))) {
        return candidate;
      }
    }

    return buildAttachedProjectCollisionName(baseName, randomUUID().replace(/-/g, "").slice(0, 12));
  }

  private async generatedAttachedProjectNameCollides(
    projectName: string,
    originalProjectName: string,
    runtimeComposeProjectNames: ReadonlySet<string>,
  ): Promise<boolean> {
    if (projectName === originalProjectName) {
      return true;
    }

    if (runtimeComposeProjectNames.has(projectName)) {
      return true;
    }

    return fileExists(this.getHiddenPortsOverridePath(projectName));
  }

  private getHiddenPortsOverridePath(attachedProjectName: string): string {
    return path.join(this.storageDirectory, `${attachedProjectName}.ports.override.yaml`);
  }

  /** Writes a Compose override whose only job is to replace published ports. */
  private async writeHiddenPortsOverride(
    attachedProjectName: string,
    services: readonly string[],
    ports: readonly ComposePublishedPort[],
    serviceMounts: ReadonlyMap<string, readonly ComposeServiceMount[]>,
    options: {
      readonly resetContainerName: boolean;
      readonly cloneContainerNames?: ReadonlyMap<string, string>;
      readonly isolatedNetwork?: string;
      readonly disabledServices?: readonly string[];
      readonly overrideFile?: string;
    },
  ): Promise<string> {
    await fs.mkdir(this.storageDirectory, { recursive: true });
    const overrideFile = options.overrideFile ?? this.getHiddenPortsOverridePath(attachedProjectName);
    const portsByService = groupPortsByService(ports);
    const disabledServices = new Set(options.disabledServices ?? []);
    const lines = ["services:"];

    for (const serviceName of uniqueStrings(services)) {
      const servicePorts = portsByService.get(serviceName) ?? [];
      lines.push(`  ${quoteYamlString(serviceName)}:`);
      if (options.resetContainerName) {
        const cloneContainerName = options.cloneContainerNames?.get(serviceName);
        if (cloneContainerName === undefined) {
          lines.push("    container_name: !reset null");
        } else {
          lines.push(`    container_name: ${quoteYamlString(cloneContainerName)}`);
        }
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

  /** Finds the original service containers before mutation; copy mode also needs stopped containers. */
  private async listComposeServiceContainers(
    runtime: "docker" | "podman",
    originalProjectName: string,
    services: readonly string[],
    options: ComposeServiceContainerListOptions = {},
  ): Promise<ComposeServiceContainerList> {
    const serviceSet = new Set(services);
    const { rows, inspectedRows } = await this.listRuntimeRowsWithInspectNames(runtime, {
      includeStopped: options.includeStopped === true,
      composeProjectName: originalProjectName,
      composeServices: services,
    });
    const runningContainerIds =
      options.includeStopped === true
        ? await this.listRunningContainerIds(runtime, {
            composeProjectName: originalProjectName,
            composeServices: services,
          }).catch(() => undefined)
        : undefined;
    const containers = selectCurrentComposeServiceContainers(parseComposeServiceContainerRows(rows, inspectedRows))
      .filter(
        (candidate) =>
          candidate.composeProject === originalProjectName &&
          serviceSet.has(candidate.serviceName),
      )
      .map((container) => ({
        ...container,
        isRunning: runningContainerIds?.has(container.id) ?? container.isRunning,
      }));

    return {
      containers,
      inspectedRows,
    };
  }

  /** Converts Docker inspect mount rows into exact hidden-project overrides. */
  private async inspectServiceMounts(
    runtime: "docker" | "podman",
    containers: readonly ComposeServiceContainer[],
    inspectedRows: readonly RuntimeContainerInspectRow[] = [],
  ): Promise<ReadonlyMap<string, readonly ComposeServiceMount[]>> {
    if (containers.length === 0) {
      throw new Error("No running compose service containers were found for attach.");
    }

    const inspected =
      inspectedRows.length > 0
        ? inspectedRows
        : parseContainerInspectRows(
            (
              await this.runCommand(runtime, ["container", "inspect", ...containers.map((container) => container.id)], {
                timeoutMs: LIST_TIMEOUT_MS,
              })
            ).stdout,
          );
    if (inspected.length === 0) {
      throw new Error("Container inspect did not return mount metadata for compose attach.");
    }

    const grouped = new Map<string, readonly ComposeServiceMount[]>();

    for (const row of inspected) {
      const selectedContainer = findInspectedServiceContainer(row, containers);
      if (selectedContainer === undefined) {
        continue;
      }

      const serviceName = findInspectServiceName(row) ?? selectedContainer.serviceName;
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

  /**
   * Lists services that already have compose containers, including stopped
   * profile services. Copy attach preserves the user's materialized stack, so
   * this runtime view is merged with static config service names.
   */
  private async listExistingComposeServices(
    context: ComposeCommandContext,
  ): Promise<readonly string[]> {
    const result = await this.runCommand(context.runtime, this.buildComposeArgs(context, ["ps", "--all", "--services"]), {
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

  /** Reads the runtime's running-only container ids for lifecycle classification. */
  private async listRunningContainerIds(
    runtime: "docker" | "podman",
    options: ComposeServiceContainerListOptions = {},
  ): Promise<ReadonlySet<string>> {
    const rows = await this.listRuntimeRows(runtime, {
      composeProjectName: options.composeProjectName,
      composeServices: options.composeServices,
    });
    return new Set(rows.map(readRuntimeContainerId).filter((id): id is string => id !== undefined));
  }

  /** Drops stale runtime-label services before mutating current compose services. */
  private filterAvailableComposeServices(
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
      const sourceMount = volume.sourceKind === "volume" ? `${volume.sourceName}:/from:ro` : `${volume.sourceName}:/from:ro`;
      await this.runCommand(runtime, ["volume", "create", volume.targetVolumeName], {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      await this.runCommand(
        runtime,
        [
          "run",
          "--rm",
          "-v",
          sourceMount,
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
    options: ComposeServiceContainerListOptions = {},
  ): Promise<readonly ContainerServiceCandidate[]> {
    const { rows } = await this.listRuntimeRowsWithInspectNames(runtime, {
      includeStopped: options.includeStopped === true,
      composeProjectName: attachedProjectName,
    });
    return parseContainerRows(runtime, rows).filter((candidate) => candidate.composeProject === attachedProjectName);
  }

  /**
   * Waits briefly for Docker/Podman to expose the hidden project's published
   * ports after `compose up`. Runtime list output can lag behind compose's
   * return, so attach treats route publication as a convergence step.
   */
  private async resolveHiddenPortsAfterComposeUp(
    runtime: "docker" | "podman",
    attachedProjectName: string,
    ports: readonly ComposePublishedPort[],
    options: HiddenPortResolutionOptions = {},
  ): Promise<readonly ComposePublishedPort[]> {
    let lastCandidates: readonly ContainerServiceCandidate[] = [];
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < HIDDEN_PORT_DISCOVERY_ATTEMPTS; attempt += 1) {
      lastCandidates = await this.discoverHiddenComposeCandidates(runtime, attachedProjectName);
      try {
        return resolveHiddenPorts(attachedProjectName, ports, lastCandidates);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt + 1 < HIDDEN_PORT_DISCOVERY_ATTEMPTS) {
        await sleep(HIDDEN_PORT_DISCOVERY_DELAY_MS);
      }
    }

    if (options.includeStoppedFallback === true) {
      const stoppedCandidates = await this.discoverHiddenComposeCandidates(runtime, attachedProjectName, {
        includeStopped: true,
      });
      return resolveHiddenPorts(attachedProjectName, ports, stoppedCandidates);
    }

    throw lastError ?? new Error(`Hidden compose project ${attachedProjectName} did not publish selected ports.`);
  }

  /**
   * Finds selected service container names that Docker already reserves.
   *
   * Compose `container_name` is global, not project-scoped. A stopped original
   * container can still block a clone, so explicit SOT names are checked by
   * container name before the hidden override is written.
   */
  private async findOccupiedCloneContainerNames(
    runtime: "docker" | "podman",
    sourceContainers: readonly ComposeServiceContainer[],
    serviceContainerNameSot: ReadonlyMap<string, string>,
    reservations: RuntimeNameReservations,
  ): Promise<ReadonlySet<string>> {
    const occupiedNames = new Set(reservations.containerNames);
    for (const container of sourceContainers) {
      const containerName = normalizeContainerNameText(container.name);
      if (containerName.length > 0) {
        occupiedNames.add(containerName);
      }
    }
    const sourceServices = new Set(sourceContainers.map((container) => container.serviceName));
    const sotNames = uniqueStrings(
      [...serviceContainerNameSot]
        .filter(([serviceName]) => sourceServices.has(serviceName))
        .map(([, containerName]) => normalizeContainerNameText(containerName))
        .filter((name) => name.length > 0),
    );

    for (const containerName of sotNames) {
      if (occupiedNames.has(containerName)) {
        continue;
      }

      try {
        await this.runCommand(runtime, ["container", "inspect", containerName], {
          timeoutMs: LIST_TIMEOUT_MS,
        });
        occupiedNames.add(containerName);
      } catch {
        // Missing names are the normal path; the clone can keep the SOT exactly.
      }
    }

    return occupiedNames;
  }

  /**
   * Reads Docker/Podman's global name reservation table.
   *
   * Container names are globally reserved, while Compose project names can
   * remain materialized in Docker/Podman after Port Manager's generated override
   * file was deleted. Both identities must be treated as collisions before a
   * new hidden clone writes its override and starts containers.
   */
  private async readRuntimeNameReservations(runtime: "docker" | "podman"): Promise<RuntimeNameReservations> {
    try {
      const result = await this.runCommand(
        runtime,
        ["container", "ps", "--all", "--no-trunc", "--format", "{{json .}}"],
        { timeoutMs: LIST_TIMEOUT_MS },
      );
      const rows = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(parseRuntimeContainerRow)
        .filter((row): row is RuntimeContainerRow => row !== undefined);

      return {
        containerNames: new Set(rows.map(readRuntimeContainerName).filter((name): name is string => name !== undefined)),
        composeProjectNames: new Set(
          rows
            .map((row) => readRuntimeLabel(parseRuntimeLabels(row.Labels), "com.docker.compose.project", "io.podman.compose.project"))
            .filter((name): name is string => name !== undefined),
        ),
      };
    } catch {
      return emptyRuntimeNameReservations();
    }
  }

  /**
   * Reads runtime list rows and repairs container names from inspect.
   *
   * Docker/Podman summary rows are optimized for display and can omit names in
   * edge cases. Attach state needs the exact runtime name because later Docker
   * lifecycle commands are rewritten to that stable target instead of a stale id.
   */
  private async listRuntimeRowsWithInspectNames(
    runtime: "docker" | "podman",
    options: ComposeServiceContainerListOptions = {},
  ): Promise<{
    readonly rows: readonly RuntimeContainerRow[];
    readonly inspectedRows: readonly RuntimeContainerInspectRow[];
  }> {
    const rows = await this.listRuntimeRows(runtime, options);
    const containerIds = uniqueStrings(rows.map((row) => readRuntimeContainerId(row)).filter((id): id is string => id !== undefined));
    if (containerIds.length === 0) {
      return { rows, inspectedRows: [] };
    }

    try {
      const inspectResult = await this.runCommand(runtime, ["container", "inspect", ...containerIds], {
        timeoutMs: LIST_TIMEOUT_MS,
      });
      const inspectedRows = parseContainerInspectRows(inspectResult.stdout);
      return {
        rows: mergeRuntimeContainerRowsWithInspectNames(rows, inspectedRows),
        inspectedRows,
      };
    } catch {
      return { rows, inspectedRows: [] };
    }
  }

  /**
   * Reads Docker/Podman container summary rows without inspect repair.
   *
   * Compose attach can run while many unrelated containers exist on Docker
   * Desktop. Project filters are pushed into the runtime command so expensive
   * inspect repair only touches containers that can influence this mutation.
   */
  private async listRuntimeRows(
    runtime: "docker" | "podman",
    options: ComposeServiceContainerListOptions = {},
  ): Promise<readonly RuntimeContainerRow[]> {
    const result = await this.runCommand(
      runtime,
      buildRuntimeContainerListArgs(runtime, options),
      {
        timeoutMs: LIST_TIMEOUT_MS,
      },
    );
    const rows = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseRuntimeContainerRow)
      .filter((row): row is RuntimeContainerRow => row !== undefined);

    return filterRuntimeRowsForComposeServices(rows, options.composeServices);
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

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
      logicalPort: originalPort.logicalPort,
      actualHostAddress: hiddenPort.actualHostAddress,
      actualHostPort: hiddenPort.actualHostPort,
    };
  });
}

function buildContainerCloneMappings(
  originalContainers: readonly ComposeServiceContainer[],
  hiddenContainers: readonly ComposeServiceContainer[],
): readonly ComposeContainerMutationMapping[] {
  const originalByService = groupBy(originalContainers, (container) => container.serviceName);
  const hiddenByService = groupBy(hiddenContainers, (container) => container.serviceName);
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
      attachedContainerId: hidden[0]!.id,
      attachedContainerName: hidden[0]!.name,
    });
  }

  return mappings;
}

function isRunningComposeServiceContainer(container: ComposeServiceContainer): boolean {
  return container.isRunning;
}

function isRunningStatus(value: string | undefined): boolean {
  const status = value?.trim().toLowerCase();
  if (status === undefined || status.length === 0) {
    return true;
  }

  if (
    status.startsWith("exited") ||
    status.startsWith("created") ||
    status.startsWith("dead") ||
    status.startsWith("removing")
  ) {
    return false;
  }

  return status.startsWith("up") || status.includes("running");
}

function buildRenameContainerNameSources(
  state: ComposePortMutationState,
  currentContainers: readonly ComposeServiceContainer[],
): readonly ComposeServiceContainer[] {
  const serviceSet = new Set(state.services);
  const mappingSources =
    state.containerMappings
      ?.filter(
        (mapping) =>
          serviceSet.has(mapping.serviceName) &&
          !mapping.serviceName.startsWith("__portmanager_alias__:") &&
          mapping.originalContainerId.trim().length > 0 &&
          mapping.originalContainerName.trim().length > 0,
      )
      .map((mapping) => ({
        id: mapping.originalContainerId,
        name: mapping.originalContainerName,
        serviceName: mapping.serviceName,
        hasPublishedPorts: false,
        isRunning: true,
      })) ?? [];

  return mappingSources.length > 0 ? mappingSources : currentContainers;
}

function buildRenamedMutationState(
  state: ComposePortMutationState,
  attachedProjectName: string,
  overrideFile: string,
  hiddenPorts: readonly ComposePublishedPort[],
  containerMappings: readonly ComposeContainerMutationMapping[],
): ComposePortMutationState {
  const mergedContainerMappings = mergeComposeContainerMappingLineage(
    state.containerMappings ?? [],
    containerMappings,
  );

  return {
    mode: state.mode,
    runtime: state.runtime,
    originalProjectName: state.originalProjectName,
    attachedProjectName,
    ...(state.workingDirectory !== undefined ? { workingDirectory: state.workingDirectory } : {}),
    composeFiles: state.composeFiles,
    services: state.services,
    overrideFile,
    originalPorts: state.originalPorts,
    hiddenPorts,
    ...(mergedContainerMappings.length > 0 ? { containerMappings: mergedContainerMappings } : {}),
    ...(state.clonedVolumeNames !== undefined ? { clonedVolumeNames: state.clonedVolumeNames } : {}),
    ...(state.clonedVolumes !== undefined ? { clonedVolumes: state.clonedVolumes } : {}),
  };
}

function buildRestoredOverrideServices(
  state: ComposePortMutationState,
  definedServices: readonly string[],
): readonly string[] {
  if (state.mode === "in-place") {
    return uniqueStrings(state.services);
  }

  return uniqueStrings([...definedServices, ...state.services]);
}

function buildRestoredDisabledOverrideServices(
  state: ComposePortMutationState,
  overrideServices: readonly string[],
): readonly string[] {
  if (state.mode === "in-place") {
    return [];
  }

  const attachedServices = new Set(state.services);
  return overrideServices.filter((service) => !attachedServices.has(service));
}

function buildCloneContainerNameMapFromMutation(
  state: ComposePortMutationState,
): ReadonlyMap<string, string> {
  const cloneContainerNames = new Map<string, string>();

  for (const mapping of state.containerMappings ?? []) {
    if (
      mapping.serviceName.startsWith("__portmanager_alias__:") ||
      mapping.attachedContainerName.trim().length === 0
    ) {
      continue;
    }

    cloneContainerNames.set(mapping.serviceName, mapping.attachedContainerName);
  }

  return cloneContainerNames;
}

function buildServiceMountsFromPersistedCloneVolumes(
  clonedVolumes: readonly ComposeVolumeMutationMapping[] | undefined,
): ReadonlyMap<string, readonly ComposeServiceMount[]> {
  const serviceMounts = new Map<string, ComposeServiceMount[]>();

  for (const mapping of clonedVolumes ?? []) {
    const mounts = serviceMounts.get(mapping.serviceName) ?? [];
    mounts.push({
      type: "volume",
      sourceKey: buildVolumeSourceKey(mapping.targetVolumeName),
      volumeName: mapping.targetVolumeName,
      originalVolumeName: mapping.sourceName,
      target: mapping.containerPath,
      readOnly: mapping.readOnly,
    });
    serviceMounts.set(mapping.serviceName, mounts);
  }

  return serviceMounts;
}

function buildCloneContainerNames(
  originalProjectName: string,
  attachedProjectName: string,
  originalContainers: readonly ComposeServiceContainer[],
  serviceContainerNameSot: ReadonlyMap<string, string>,
  occupiedContainerNames: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const reservedNames = new Set(
    [...occupiedContainerNames]
      .map((name) => normalizeContainerNameText(name))
      .filter((name) => name.length > 0),
  );
  const names = new Map<string, string>();
  for (const [serviceName, containerName] of serviceContainerNameSot) {
    const normalizedSotName = normalizeContainerNameText(containerName);
    if (normalizedSotName.length === 0) {
      continue;
    }

    const cloneContainerName = reservedNames.has(normalizedSotName)
      ? buildAvailableConflictingCloneContainerName(normalizedSotName, attachedProjectName, reservedNames)
      : normalizedSotName;
    names.set(serviceName, cloneContainerName);
    reservedNames.add(normalizeContainerNameText(cloneContainerName));
  }
  const originalByService = groupBy(originalContainers, (container) => container.serviceName);

  for (const [serviceName, containers] of originalByService) {
    if (names.has(serviceName)) {
      continue;
    }
    if (containers.length !== 1) {
      continue;
    }

    const cloneContainerName = buildCloneContainerName(
      originalProjectName,
      attachedProjectName,
      containers[0]!.name,
      serviceContainerNameSot.get(serviceName),
      reservedNames,
    );
    if (cloneContainerName !== undefined) {
      names.set(serviceName, cloneContainerName);
      reservedNames.add(normalizeContainerNameText(cloneContainerName));
    }
  }

  return names;
}

function buildCloneContainerName(
  originalProjectName: string,
  attachedProjectName: string,
  originalContainerName: string,
  serviceContainerNameSot: string | undefined,
  occupiedContainerNames: ReadonlySet<string>,
): string | undefined {
  const normalizedOriginalName = normalizeContainerNameText(originalContainerName);
  if (serviceContainerNameSot !== undefined) {
    const normalizedSotName = normalizeContainerNameText(serviceContainerNameSot);
    if (normalizedSotName.length === 0) {
      return undefined;
    }

    return occupiedContainerNames.has(normalizedSotName)
      ? buildAvailableConflictingCloneContainerName(normalizedSotName, attachedProjectName, occupiedContainerNames)
      : normalizedSotName;
  }

  if (normalizedOriginalName.length === 0 || isGeneratedComposeContainerName(normalizedOriginalName, originalProjectName)) {
    return undefined;
  }

  // If runtime labels did not include readable compose files, a non-generated
  // container name is the best available SOT. Docker reserves stopped container
  // names globally, so the hidden clone receives a compose-project suffix only
  // when it would otherwise collide with the source container.
  return buildAvailableConflictingCloneContainerName(normalizedOriginalName, attachedProjectName, occupiedContainerNames);
}

function isGeneratedComposeContainerName(
  containerName: string,
  originalProjectName: string,
): boolean {
  const normalizedName = containerName.trim().replace(/^\/+/, "");
  const originalProject = sanitizeContainerNameSegment(originalProjectName);
  if (normalizedName.length === 0 || originalProject === undefined) {
    return false;
  }

  for (const separator of ["-", "_"]) {
    const prefix = `${originalProject}${separator}`;
    if (normalizedName.startsWith(prefix)) {
      const generatedSuffix = normalizedName.slice(prefix.length);
      if (isComposeGeneratedContainerSuffix(generatedSuffix)) {
        return true;
      }
    }
  }

  return false;
}

function normalizeContainerNameText(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

function buildConflictingCloneContainerName(containerName: string, attachedProjectName: string): string {
  const suffixSegment = sanitizeContainerNameSegment(attachedProjectName) ?? "compose";
  const suffix = `-${suffixSegment}`;
  const maxLength = 120;
  const baseLength = Math.max(1, maxLength - suffix.length);
  const baseName = trimContainerName(containerName, baseLength).replace(/[_.-]+$/g, "") || "compose-container";

  return trimContainerName(`${baseName}${suffix}`, maxLength);
}

function buildAvailableConflictingCloneContainerName(
  containerName: string,
  attachedProjectName: string,
  occupiedContainerNames: ReadonlySet<string>,
): string {
  const candidate = buildConflictingCloneContainerName(containerName, attachedProjectName);
  if (!occupiedContainerNames.has(candidate)) {
    return candidate;
  }

  // The network/project suffix can collide when a cloned project is copied to a
  // second network with the same attached project name. Keep the readable base
  // and add the smallest deterministic ordinal that Docker has not reserved.
  for (let ordinal = 2; ordinal < 1000; ordinal += 1) {
    const ordinalCandidate = appendContainerNameCollisionOrdinal(candidate, ordinal);
    if (!occupiedContainerNames.has(ordinalCandidate)) {
      return ordinalCandidate;
    }
  }

  const fallbackOrdinal = createHash("sha1")
    .update(`${containerName}\0${attachedProjectName}\0${[...occupiedContainerNames].sort().join("\0")}`)
    .digest("hex")
    .slice(0, 8);
  return appendContainerNameCollisionOrdinal(candidate, fallbackOrdinal);
}

function appendContainerNameCollisionOrdinal(containerName: string, ordinal: number | string): string {
  const suffix = `-${ordinal}`;
  const maxLength = 120;
  const baseLength = Math.max(1, maxLength - suffix.length);
  const baseName = trimContainerName(containerName, baseLength).replace(/[_.-]+$/g, "") || "compose-container";

  return trimContainerName(`${baseName}${suffix}`, maxLength);
}

function isComposeGeneratedContainerSuffix(value: string): boolean {
  const hyphenReplicaSeparatorIndex = value.lastIndexOf("-");
  const underscoreReplicaSeparatorIndex = value.lastIndexOf("_");
  const replicaSeparatorIndex = Math.max(hyphenReplicaSeparatorIndex, underscoreReplicaSeparatorIndex);
  if (replicaSeparatorIndex <= 0) {
    return false;
  }

  return /^[1-9][0-9]*$/.test(value.slice(replicaSeparatorIndex + 1));
}

function groupBy<T>(values: readonly T[], keyForValue: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const value of values) {
    const key = keyForValue(value);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }

  return grouped;
}

function buildAttachedProjectName(
  networkName: string,
  originalProjectName: string,
  networkIdentity?: string,
): string {
  const networkSegment = sanitizeComposeProjectSegment(networkName) ?? "network";
  const originalSegment = sanitizeComposeProjectSegment(originalProjectName) ?? "compose";
  const hashSource = networkIdentity === undefined ? networkName : `${networkName}\0${networkIdentity}`;
  const hash = createHash("sha1").update(`${hashSource}\0${originalProjectName}`).digest("hex").slice(0, 8);
  const prefix = trimProjectName(`${networkSegment}-${originalSegment}`, 52);

  // Network name stays first for Docker UI discoverability; the hash prevents
  // copied networks and duplicate source projects from sharing a project.
  return `${prefix}-${hash}`;
}

function buildAttachedProjectCollisionName(baseName: string, suffix: string): string {
  return `${trimProjectName(baseName, 52)}-${suffix}`;
}

async function readComposeConfiguredProjectName(composeFile: string): Promise<string | undefined> {
  const text = await fs.readFile(composeFile, "utf8").catch(() => undefined);
  if (text === undefined) {
    return undefined;
  }

  return parseComposeConfiguredProjectName(text);
}

async function readComposeServiceContainerNames(
  composeFiles: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();

  for (const composeFile of composeFiles) {
    const text = await fs.readFile(composeFile, "utf8").catch(() => undefined);
    if (text === undefined) {
      continue;
    }

    for (const [serviceName, containerName] of parseComposeServiceContainerNames(text)) {
      if (containerName === undefined) {
        names.delete(serviceName);
        continue;
      }

      names.set(serviceName, containerName);
    }
  }

  return names;
}

function parseComposeConfiguredProjectName(text: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s/.test(rawLine)) {
      continue;
    }

    const match = /^name\s*:\s*(.*)$/.exec(rawLine);
    if (match === null) {
      continue;
    }

    return parseYamlScalarString(match[1] ?? "");
  }

  return undefined;
}

function parseComposeServiceContainerNames(text: string): ReadonlyMap<string, string | undefined> {
  const names = new Map<string, string | undefined>();
  let inServices = false;
  let serviceIndent: number | undefined;
  let currentService: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(rawLine)) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();
    if (indent === 0) {
      inServices = /^services\s*:\s*(?:#.*)?$/.test(trimmed);
      serviceIndent = undefined;
      currentService = undefined;
      continue;
    }
    if (!inServices) {
      continue;
    }

    const separatorIndex = rawLine.indexOf(":", indent);
    if (separatorIndex < 0) {
      continue;
    }

    if (serviceIndent === undefined) {
      serviceIndent = indent;
    }
    if (indent === serviceIndent) {
      currentService = parseYamlMapKey(rawLine.slice(indent, separatorIndex));
      continue;
    }
    if (currentService === undefined || indent <= serviceIndent) {
      continue;
    }

    const key = parseYamlMapKey(rawLine.slice(indent, separatorIndex));
    if (key !== "container_name") {
      continue;
    }

    names.set(currentService, parseYamlScalarString(rawLine.slice(separatorIndex + 1)));
  }

  return names;
}

function parseYamlMapKey(value: string): string | undefined {
  return parseYamlScalarString(value);
}

function parseYamlScalarString(value: string): string | undefined {
  const scalar = stripYamlInlineComment(value).trim();
  if (scalar.length === 0 || scalar === "~" || /^null$/i.test(scalar)) {
    return undefined;
  }

  if (scalar.startsWith("'")) {
    const closingIndex = scalar.indexOf("'", 1);
    return closingIndex <= 0 ? undefined : scalar.slice(1, closingIndex).replace(/''/g, "'").trim() || undefined;
  }

  if (scalar.startsWith('"')) {
    const closingIndex = findClosingDoubleQuote(scalar);
    if (closingIndex <= 0) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(scalar.slice(0, closingIndex + 1));
      return typeof parsed === "string" && parsed.trim().length > 0 ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  if (/^[>|[{]/.test(scalar)) {
    return undefined;
  }

  return scalar.trim();
}

function stripYamlInlineComment(value: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const previous = index === 0 ? "" : value[index - 1];
    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (character === '"' && !inSingleQuote && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (character === "#" && !inSingleQuote && !inDoubleQuote && (index === 0 || /\s/.test(previous))) {
      return value.slice(0, index);
    }
  }

  return value;
}

function findClosingDoubleQuote(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '"' && value[index - 1] !== "\\") {
      return index;
    }
  }

  return -1;
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

async function buildVolumeClonePlan(
  attachedProjectName: string,
  cloneRunId: string,
  serviceMounts: ReadonlyMap<string, readonly ComposeServiceMount[]>,
  statefulServiceNames: ReadonlySet<string>,
): Promise<{
  readonly serviceMounts: ReadonlyMap<string, readonly ComposeServiceMount[]>;
  readonly volumeClones: readonly VolumeClonePlan[];
  readonly volumeMappings: readonly VolumeCloneMapping[];
}> {
  const clonedBySource = new Map<string, string>();
  const volumeClones: VolumeClonePlan[] = [];
  const volumeMappings: VolumeCloneMapping[] = [];
  const clonedServiceMounts = new Map<string, readonly ComposeServiceMount[]>();

  for (const [serviceName, mounts] of serviceMounts) {
    const shouldCloneBindMounts = statefulServiceNames.has(serviceName);
    clonedServiceMounts.set(
      serviceName,
      await Promise.all(
        mounts.map(async (mount) => {
          if (mount.type === "volume") {
            const clonedMount = cloneVolumeBackedMount(
              attachedProjectName,
              cloneRunId,
              mount,
              serviceName,
              "volume",
              mount.originalVolumeName,
              clonedBySource,
              volumeClones,
              volumeMappings,
            );

            return clonedMount;
          }

          if (mount.type === "bind" && shouldCloneBindMounts) {
            await assertCloneableBindMount(serviceName, mount);
            return cloneVolumeBackedMount(
              attachedProjectName,
              cloneRunId,
              {
                type: "volume",
                sourceKey: buildVolumeSourceKey(mount.source),
                volumeName: mount.source,
                originalVolumeName: mount.source,
                target: mount.target,
                readOnly: mount.readOnly,
              },
              serviceName,
              "bind",
              mount.source,
              clonedBySource,
              volumeClones,
              volumeMappings,
            );
          }

          return mount;
        }),
      ),
    );
  }

  return {
    serviceMounts: clonedServiceMounts,
    volumeClones,
    volumeMappings,
  };
}

function cloneVolumeBackedMount(
  attachedProjectName: string,
  cloneRunId: string,
  mount: ComposeVolumeMount,
  serviceName: string,
  sourceKind: "volume" | "bind",
  sourceName: string,
  clonedBySource: Map<string, string>,
  volumeClones: VolumeClonePlan[],
  volumeMappings: VolumeCloneMapping[],
): ComposeVolumeMount {
  const sourceIdentity = `${sourceKind}:${sourceName}`;
  let targetVolumeName = clonedBySource.get(sourceIdentity);
  if (targetVolumeName === undefined) {
    targetVolumeName = buildClonedVolumeName(attachedProjectName, sourceIdentity, cloneRunId);
    clonedBySource.set(sourceIdentity, targetVolumeName);
    volumeClones.push({
      sourceKind,
      sourceName,
      targetVolumeName,
    });
  }

  volumeMappings.push({
    serviceName,
    sourceKind,
    sourceName,
    targetVolumeName,
    containerPath: mount.target,
    readOnly: mount.readOnly,
  });

  return {
    ...mount,
    sourceKey: buildVolumeSourceKey(targetVolumeName),
    volumeName: targetVolumeName,
  };
}

async function assertCloneableBindMount(serviceName: string, mount: ComposeBindMount): Promise<void> {
  const stat = await fs.stat(mount.source).catch(() => undefined);
  if (stat === undefined) {
    throw new Error(`Compose service ${serviceName} bind mount ${mount.source} does not exist and cannot be safely cloned.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Compose service ${serviceName} bind mount ${mount.source} targets ${mount.target}, but file bind mounts cannot be safely cloned into an isolated volume.`,
    );
  }
}

function buildVolumeMutationMappings(volumeMappings: readonly VolumeCloneMapping[]): readonly ComposeVolumeMutationMapping[] {
  return volumeMappings.map((mapping) => ({ ...mapping }));
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

function assertHiddenPortsAreIsolated(
  hiddenPorts: readonly ComposePublishedPort[],
  originalPorts: readonly ComposePublishedPort[],
): void {
  const originalPortsByKey = new Map(originalPorts.map((port) => [buildPortKey(port), port]));
  const leakedPorts = hiddenPorts.filter((port) => {
    if (!isLocalHostAddress(port.actualHostAddress)) {
      return false;
    }

    const originalPort = originalPortsByKey.get(buildPortKey(port));
    return port.actualHostPort === port.logicalPort || port.actualHostPort === originalPort?.actualHostPort;
  });

  if (leakedPorts.length === 0) {
    return;
  }

  throw new Error(
    `Compose hidden port mutation kept Docker-published host port${leakedPorts.length === 1 ? "" : "s"} on a visible logical/original port: ${leakedPorts.map(formatLeakedPort).join(", ")}. Attach would route to the host namespace, so the compose project was restored.`,
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

function findInspectedServiceContainer(
  row: RuntimeContainerInspectRow,
  containers: readonly ComposeServiceContainer[],
): ComposeServiceContainer | undefined {
  const inspectedId = (row.Id ?? row.ID)?.trim();
  if (inspectedId === undefined || inspectedId.length === 0) {
    return undefined;
  }

  return containers.find((container) => sameContainerId(container.id, inspectedId));
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

export function isValidComposeProjectName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && /^[a-z0-9][a-z0-9_-]*$/.test(trimmed);
}

function parseRequestedComposeProjectName(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return requireComposeProjectName(value);
}

function requireComposeProjectName(value: string): string {
  const trimmed = value.trim();
  if (!isValidComposeProjectName(trimmed)) {
    throw new Error(
      "Compose project name must be 1-120 characters, use lowercase letters, digits, dashes, or underscores, and start with a letter or digit.",
    );
  }

  return trimmed;
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

function sanitizeContainerNameSegment(value: string): string | undefined {
  const sanitized = value
    .trim()
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[_.-]+$/g, "");

  return sanitized.length === 0 ? undefined : sanitized;
}

function trimProjectName(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/[-_]+$/g, "") || "network";
}

function trimContainerName(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/[_.-]+$/g, "") || "pm-container";
}

function isGeneratedOverridePath(normalizedFile: string | undefined, storageDirectory: string | undefined): boolean {
  return (
    normalizedFile !== undefined &&
    storageDirectory !== undefined &&
    path.dirname(normalizedFile) === storageDirectory &&
    path.basename(normalizedFile).endsWith(".ports.override.yaml")
  );
}

function quoteYamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readRuntimeContainerId(row: RuntimeContainerRow): string | undefined {
  const id = (row.ID ?? row.Id)?.trim();
  return id === undefined || id.length === 0 ? undefined : id;
}

function buildRuntimeContainerListArgs(
  runtime: "docker" | "podman",
  options: ComposeServiceContainerListOptions,
): readonly string[] {
  const args = ["container", "ls", ...(options.includeStopped === true ? ["--all"] : []), "--no-trunc"];
  if (options.composeProjectName !== undefined && options.composeProjectName.length > 0) {
    const labelName = runtime === "podman" ? "io.podman.compose.project" : "com.docker.compose.project";
    args.push("--filter", `label=${labelName}=${options.composeProjectName}`);
  }
  args.push("--format", "{{json .}}");
  return args;
}

function filterRuntimeRowsForComposeServices(
  rows: readonly RuntimeContainerRow[],
  composeServices: readonly string[] | undefined,
): readonly RuntimeContainerRow[] {
  const serviceSet = new Set(composeServices ?? []);
  if (serviceSet.size === 0) {
    return rows;
  }

  return rows.filter((row) => {
    const labels = parseRuntimeLabels(row.Labels);
    const composeService = readRuntimeLabel(labels, "com.docker.compose.service", "io.podman.compose.service");
    return composeService === undefined || serviceSet.has(composeService);
  });
}

function readRuntimeContainerName(row: RuntimeContainerRow): string | undefined {
  const name = normalizeContainerNameText(row.Names ?? row.Name ?? "");
  return name.length === 0 ? undefined : name;
}

function emptyRuntimeNameReservations(): RuntimeNameReservations {
  return {
    containerNames: new Set(),
    composeProjectNames: new Set(),
  };
}

function parseComposeServiceContainerRows(
  rows: readonly RuntimeContainerRow[],
  inspectedRows: readonly RuntimeContainerInspectRow[] = [],
): readonly (ComposeServiceContainer & { readonly composeProject: string })[] {
  return rows
    .map((row) => {
      const id = readRuntimeContainerId(row);
      const inspected = id === undefined ? undefined : findInspectedRuntimeContainer(inspectedRows, id);
      const name = readRuntimeContainerName(row) ?? normalizeContainerNameText(inspected?.Name ?? "");
      const labels = mergeRuntimeLabels(parseRuntimeLabels(row.Labels), inspected?.Config?.Labels);
      const composeProject = readRuntimeLabel(labels, "com.docker.compose.project", "io.podman.compose.project");
      const composeService = readRuntimeLabel(labels, "com.docker.compose.service", "io.podman.compose.service");
      if (id === undefined || name === undefined || composeProject === undefined || composeService === undefined) {
        return undefined;
      }

      return {
        id,
        name,
        composeProject,
        serviceName: composeService,
        hasPublishedPorts: (row.Ports ?? "").trim().length > 0,
        isRunning: isRunningStatus(row.Status),
        ...(row.Status !== undefined ? { status: row.Status } : {}),
      };
    })
    .filter((container): container is ComposeServiceContainer & { readonly composeProject: string } => container !== undefined);
}

function findInspectedRuntimeContainer(
  inspectedRows: readonly RuntimeContainerInspectRow[],
  containerId: string,
): RuntimeContainerInspectRow | undefined {
  return inspectedRows.find((row) => {
    const inspectedId = row.ID ?? row.Id;
    return inspectedId !== undefined && sameContainerId(inspectedId, containerId);
  });
}

function mergeRuntimeLabels(
  rowLabels: ReadonlyMap<string, string>,
  inspectedLabels: Record<string, string> | undefined,
): ReadonlyMap<string, string> {
  const labels = new Map(inspectedLabels === undefined ? [] : Object.entries(inspectedLabels));
  for (const [key, value] of rowLabels) {
    labels.set(key, value);
  }
  return labels;
}

function selectCurrentComposeServiceContainers(
  containers: readonly (ComposeServiceContainer & { readonly composeProject: string })[],
): readonly (ComposeServiceContainer & { readonly composeProject: string })[] {
  const hasPublishedContainerByService = new Set(
    containers
      .filter((container) => container.hasPublishedPorts)
      .map((container) => `${container.composeProject}:${container.serviceName}`),
  );

  return containers.filter(
    (container) =>
      container.hasPublishedPorts ||
      !hasPublishedContainerByService.has(`${container.composeProject}:${container.serviceName}`),
  );
}

function parseRuntimeLabels(value: string | undefined): ReadonlyMap<string, string> {
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

function readRuntimeLabel(labels: ReadonlyMap<string, string>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = labels.get(key);
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function sameContainerId(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
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

async function fileIsReadable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

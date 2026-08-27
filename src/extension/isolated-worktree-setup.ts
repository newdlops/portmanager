import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildWorktreeDirectoryName,
  NodeGitWorktreeManager,
  type GitWorktreeInspection,
} from "../platform/workspace/git-worktree";
import type {
  BrowserDnsResolverStatus,
  ComposeAttachment,
  ContainerServiceCandidate,
  LogicalNetwork,
  NetworkRuntimeKind,
} from "../shared/types";
import {
  isPathInsideWorkspace,
  remapWorkspacePath,
  type WorkspacePathMapping,
} from "../shared/workspace-path";
import type { PortManagerTreeProvider } from "../ui/sidebar/port-manager-tree";
import { ensureLocalGitExclude } from "./terminal-hook-environment";
import type { PortManagerNetworkService } from "./network-service";

export const WORKTREE_INITIALIZATION_STATE_KEY = "portManager.worktreeInitialization.v1";
const ISOLATED_WORKTREE_SETUPS_KEY = "portManager.isolatedWorktreeSetups.v1";

export interface WorktreeInitializationState {
  /** Schema version keeps workspaceState migrations explicit. */
  readonly version: 1;
  /** Folder URI prevents a copied workspaceState record from binding another worktree. */
  readonly workspaceUri: string;
  /** Global logical network reused when initialization is retried. */
  readonly networkId: string;
  /** Last user-facing name retained for diagnostics if the network is later removed. */
  readonly networkName: string;
  /** Successful completion time; absent while a retryable initialization is partial. */
  readonly initializedAt?: string;
}

interface PendingIsolatedWorktreeSetup {
  readonly version: 1;
  readonly sourceRepositoryRoot: string;
  readonly targetWorktreeRoot: string;
  readonly targetWorkspacePath: string;
  readonly branchName: string;
  readonly networkName: string;
  readonly networkId?: string;
  readonly createdAt: string;
}

interface PendingIsolatedWorktreeSetupStore {
  readonly version: 1;
  readonly setups: readonly PendingIsolatedWorktreeSetup[];
}

type ComposeCopySource = AttachmentCopySource | CandidateCopySource;

interface AttachmentCopySource {
  readonly kind: "attachment";
  readonly key: string;
  readonly label: string;
  readonly attachment: ComposeAttachment;
}

interface CandidateCopySource {
  readonly kind: "candidate";
  readonly key: string;
  readonly label: string;
  readonly candidate: ContainerServiceCandidate;
}

interface ComposeCopyDiscovery {
  readonly sources: readonly ComposeCopySource[];
  readonly unavailableLabels: readonly string[];
}

export interface IsolatedWorktreeSetupDependencies {
  readonly context: vscode.ExtensionContext;
  readonly networkService: PortManagerNetworkService;
  readonly treeProvider: PortManagerTreeProvider;
  /** Verifies packaged runtime support and installs/repairs pm shell integration. */
  readonly prepareRuntime: () => Promise<NetworkRuntimeKind>;
  /** Test seam for the low-level Git adapter; production uses NodeGitWorktreeManager. */
  readonly gitWorktrees?: Pick<
    NodeGitWorktreeManager,
    "inspect" | "validateBranchName" | "createOrReuse"
  >;
}

/**
 * Coordinates the user's real isolation unit as one retryable transaction:
 * Git worktree, Logical Network, Compose copy, browser access, and target-window
 * terminal binding. Low-level Git and Compose mechanics remain in adapters.
 */
export class IsolatedWorktreeSetupController {
  private readonly gitWorktrees: Pick<
    NodeGitWorktreeManager,
    "inspect" | "validateBranchName" | "createOrReuse"
  >;
  private creationInFlight: Promise<void> | undefined;
  private resumeInFlight: Promise<void> | undefined;

  constructor(private readonly dependencies: IsolatedWorktreeSetupDependencies) {
    this.gitWorktrees = dependencies.gitWorktrees ?? new NodeGitWorktreeManager();
  }

  /** Creates a sibling worktree and opens it after every shared resource is ready. */
  create(sourceAttachment?: ComposeAttachment): Promise<void> {
    if (this.creationInFlight !== undefined) {
      return this.creationInFlight;
    }
    const operation = this.createExclusive(sourceAttachment).finally(() => {
      if (this.creationInFlight === operation) {
        this.creationInFlight = undefined;
      }
    });
    this.creationInFlight = operation;
    return operation;
  }

  /** Completes the cross-window handoff left by the source worktree. */
  resumePending(): Promise<void> {
    if (this.resumeInFlight !== undefined) {
      return this.resumeInFlight;
    }
    const operation = this.resumePendingExclusive().finally(() => {
      if (this.resumeInFlight === operation) {
        this.resumeInFlight = undefined;
      }
    });
    this.resumeInFlight = operation;
    return operation;
  }

  private async createExclusive(sourceAttachment?: ComposeAttachment): Promise<void> {
    const workspaceFolder = getPrimaryFileWorkspaceFolder();
    if (workspaceFolder === undefined) {
      throw new Error("Open a folder inside a Git worktree before creating an isolated worktree.");
    }

    const inspection = await this.gitWorktrees.inspect(workspaceFolder.uri.fsPath);
    const branchName = await this.promptForBranchName(inspection);
    if (branchName === undefined) {
      return;
    }

    const workspaceRelativePath = path.relative(inspection.repositoryRoot, workspaceFolder.uri.fsPath);
    if (workspaceRelativePath.startsWith("..") || path.isAbsolute(workspaceRelativePath)) {
      throw new Error("The active workspace folder is outside the detected Git worktree.");
    }

    const pendingForBranch = readPendingSetups(this.dependencies.context).find(
      (setup) =>
        samePath(setup.sourceRepositoryRoot, inspection.repositoryRoot) && setup.branchName === branchName,
    );
    const defaultTargetRoot =
      pendingForBranch?.targetWorktreeRoot ??
      inspection.worktrees.find((row) => row.branch === branchName)?.path ??
      path.join(
        path.dirname(inspection.repositoryRoot),
        buildWorktreeDirectoryName(path.basename(inspection.repositoryRoot), branchName),
      );
    const composeDiscovery = await this.discoverComposeCopySources(
      inspection.repositoryRoot,
      sourceAttachment,
    );
    const confirmation = await this.confirmCreation(
      inspection,
      branchName,
      defaultTargetRoot,
      composeDiscovery,
    );
    if (confirmation === undefined) {
      return;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating isolated worktree ${branchName}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Checking Port Manager runtime…" });
        const runtimeKind = await this.dependencies.prepareRuntime();

        progress.report({ message: "Creating Git worktree…" });
        const worktree = await this.gitWorktrees.createOrReuse({
          sourceDirectory: inspection.repositoryRoot,
          branchName,
          targetDirectory: confirmation.targetRoot,
        });
        ensureLocalGitExclude(worktree.targetDirectory);
        const targetWorkspacePath = path.join(worktree.targetDirectory, workspaceRelativePath);
        await seedComposeDotenvFiles(composeDiscovery.sources, {
          sourceRoot: inspection.repositoryRoot,
          targetRoot: worktree.targetDirectory,
        });

        const previousPending = findPendingSetup(this.dependencies.context, targetWorkspacePath);
        const networkName =
          previousPending?.networkName ??
          buildUniqueNetworkName(path.basename(worktree.targetDirectory), this.dependencies.networkService.getSnapshot().networks);
        let pending: PendingIsolatedWorktreeSetup =
          previousPending ?? {
            version: 1,
            sourceRepositoryRoot: inspection.repositoryRoot,
            targetWorktreeRoot: worktree.targetDirectory,
            targetWorkspacePath,
            branchName,
            networkName,
            createdAt: new Date().toISOString(),
          };
        await upsertPendingSetup(this.dependencies.context, pending);

        progress.report({ message: "Creating dedicated Logical Network…" });
        let network = findPendingNetwork(pending, this.dependencies.networkService.getSnapshot().networks);
        if (network === undefined) {
          network = await this.dependencies.networkService.createNetwork(networkName, runtimeKind);
          pending = { ...pending, networkId: network.id };
          // Persist immediately so a cancelled administrator prompt or Docker
          // failure resumes against the same network instead of leaking another.
          await upsertPendingSetup(this.dependencies.context, pending);
        }

        let copiedComposeCount = 0;
        if (confirmation.copyCompose) {
          const mapping: WorkspacePathMapping = {
            sourceRoot: inspection.repositoryRoot,
            targetRoot: worktree.targetDirectory,
          };
          for (const source of composeDiscovery.sources) {
            progress.report({ message: `Copying Compose project ${source.label}…` });
            await this.copyComposeSource(source, network.id, mapping);
            copiedComposeCount += 1;
          }
        }

        progress.report({ message: "Installing and verifying Local DNS/TLS…" });
        await this.dependencies.networkService.installBrowserDnsResolvers({
          triggerDescription: `isolated worktree "${branchName}" creation was requested`,
        });
        assertBrowserAccessReady(await this.dependencies.networkService.verifyBrowserAccessReadiness());

        this.dependencies.treeProvider.refresh();
        return { worktree, network, copiedComposeCount, targetWorkspacePath };
      },
    );

    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(result.targetWorkspacePath),
      { forceNewWindow: true },
    );
    await vscode.window.showInformationMessage(
      `Created isolated worktree "${result.worktree.branchName}" with network "${result.network.name}"${
        result.copiedComposeCount > 0
          ? ` and ${result.copiedComposeCount} Compose project${result.copiedComposeCount === 1 ? "" : "s"}`
          : ""
      }. The new VS Code window will finish terminal attachment automatically.`,
    );
  }

  private async resumePendingExclusive(): Promise<void> {
    const workspaceFolder = getPrimaryFileWorkspaceFolder();
    if (workspaceFolder === undefined) {
      return;
    }
    const pending = findPendingSetup(this.dependencies.context, workspaceFolder.uri.fsPath);
    if (pending === undefined) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Finishing Port Manager setup for ${pending.branchName}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Loading the dedicated Logical Network…" });
        const network = findPendingNetwork(pending, this.dependencies.networkService.getSnapshot().networks);
        if (network === undefined) {
          throw new Error(
            `The prepared Logical Network "${pending.networkName}" is missing. Return to the source worktree and run Create Isolated Worktree again.`,
          );
        }

        progress.report({ message: "Applying network routing to this VS Code window…" });
        await this.dependencies.networkService.attachVscodeWindowTerminalsToNetwork(network.id);

        progress.report({ message: "Verifying browser access…" });
        assertBrowserAccessReady(await this.dependencies.networkService.verifyBrowserAccessReadiness());

        await this.dependencies.context.workspaceState.update(WORKTREE_INITIALIZATION_STATE_KEY, {
          version: 1,
          workspaceUri: workspaceFolder.uri.toString(),
          networkId: network.id,
          networkName: network.name,
          initializedAt: new Date().toISOString(),
        } satisfies WorktreeInitializationState);
        this.dependencies.treeProvider.refresh();

        const terminal = vscode.window.createTerminal({
          name: `Port Manager: ${network.name}`,
          cwd: workspaceFolder.uri,
        });
        terminal.show();
        await removePendingSetup(this.dependencies.context, pending.targetWorkspacePath);
        await vscode.window.showInformationMessage(
          `Isolated worktree "${pending.branchName}" is ready. New terminals use "${network.name}" automatically.`,
        );
      },
    );
  }

  private async promptForBranchName(inspection: GitWorktreeInspection): Promise<string | undefined> {
    const suggested = buildSuggestedBranchName(inspection.currentBranch);
    const value = await vscode.window.showInputBox({
      title: "Create Isolated Worktree",
      prompt: "Existing branch to open, or new branch to create from the current HEAD",
      value: suggested,
      placeHolder: "feature/my-isolated-worktree",
      ignoreFocusOut: true,
      validateInput: (candidate) => this.gitWorktrees.validateBranchName(inspection.repositoryRoot, candidate),
    });
    return value === undefined ? undefined : value.trim();
  }

  private async confirmCreation(
    inspection: GitWorktreeInspection,
    branchName: string,
    initialTargetRoot: string,
    compose: ComposeCopyDiscovery,
  ): Promise<{ readonly targetRoot: string; readonly copyCompose: boolean } | undefined> {
    let targetRoot = initialTargetRoot;
    while (true) {
      const composeSummary =
        compose.sources.length === 0
          ? "No copyable running Compose project was found."
          : `Compose copy: ${compose.sources.map((source) => source.label).join(", ")}. Local Compose .env files are seeded without overwriting target files; persistent data is copied as a point-in-time clone.`;
      const unavailableSummary =
        compose.unavailableLabels.length === 0
          ? ""
          : ` ${compose.unavailableLabels.join(", ")} cannot be copied because Compose file metadata is missing.`;
      const dirtySummary = inspection.dirty
        ? " Uncommitted and untracked source changes are not copied by Git worktree."
        : "";
      const buttons = compose.sources.length > 0
        ? (["Create Isolated Worktree", "Without Compose", "Choose Parent Folder"] as const)
        : (["Create Isolated Worktree", "Choose Parent Folder"] as const);
      const selected = await vscode.window.showWarningMessage(
        `Create branch/worktree "${branchName}" at ${targetRoot}, create one dedicated Logical Network, and open it in a new VS Code window? ${composeSummary}${unavailableSummary}${dirtySummary}`,
        { modal: true },
        ...buttons,
      );
      if (selected === undefined) {
        return undefined;
      }
      if (selected === "Without Compose") {
        return { targetRoot, copyCompose: false };
      }
      if (selected === "Create Isolated Worktree") {
        return { targetRoot, copyCompose: compose.sources.length > 0 };
      }

      const picked = await vscode.window.showOpenDialog({
        title: "Choose Parent Folder for Isolated Worktree",
        defaultUri: vscode.Uri.file(path.dirname(targetRoot)),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Use Parent Folder",
      });
      if (picked === undefined || picked.length === 0) {
        continue;
      }
      targetRoot = path.join(picked[0].fsPath, buildWorktreeDirectoryName(path.basename(inspection.repositoryRoot), branchName));
    }
  }

  private async discoverComposeCopySources(
    sourceRepositoryRoot: string,
    explicitAttachment: ComposeAttachment | undefined,
  ): Promise<ComposeCopyDiscovery> {
    if (explicitAttachment !== undefined) {
      return {
        sources: [toAttachmentSource(explicitAttachment)],
        unavailableLabels: [],
      };
    }

    await this.dependencies.networkService.refreshContainerServices({ force: true });
    const snapshot = this.dependencies.networkService.getSnapshot();
    const activeNetworkId = snapshot.vscodeWindowTerminalBinding?.networkId;
    const attachments = snapshot.composeAttachments
      .filter(
        (attachment) =>
          attachment.status === "attached" &&
          attachment.networkId === activeNetworkId &&
          composeContextBelongsToWorkspace(attachment.workingDirectory, attachment.composeFiles, sourceRepositoryRoot),
      )
      .map(toAttachmentSource);
    const attachedProjectNames = new Set(
      attachments.flatMap(({ attachment }) => [
        attachment.projectName,
        attachment.mutation?.originalProjectName,
        attachment.mutation?.attachedProjectName,
      ].filter((value): value is string => value !== undefined)),
    );
    const groupedCandidates = aggregateComposeCandidates(
      snapshot.containerServiceCandidates.filter(
        (candidate) =>
          candidate.composeProject !== undefined &&
          !attachedProjectNames.has(candidate.composeProject) &&
          composeContextBelongsToWorkspace(
            candidate.composeWorkingDirectory,
            candidate.composeConfigFiles ?? [],
            sourceRepositoryRoot,
          ),
      ),
    );
    const copyable = groupedCandidates.filter((candidate) => (candidate.composeConfigFiles?.length ?? 0) > 0);
    const unavailableLabels = groupedCandidates
      .filter((candidate) => (candidate.composeConfigFiles?.length ?? 0) === 0)
      .map((candidate) => `${candidate.runtime}/${candidate.composeProject ?? candidate.containerName}`);

    return {
      sources: [
        ...attachments,
        ...copyable.map((candidate): CandidateCopySource => ({
          kind: "candidate",
          key: `candidate:${candidate.id}`,
          label: `${candidate.runtime}/${candidate.composeProject ?? candidate.containerName}`,
          candidate,
        })),
      ],
      unavailableLabels,
    };
  }

  private async copyComposeSource(
    source: ComposeCopySource,
    networkId: string,
    mapping: WorkspacePathMapping,
  ): Promise<void> {
    if (source.kind === "attachment") {
      const composeFiles = source.attachment.composeFiles
        .filter((composeFile) => !composeFile.endsWith(".ports.override.yaml"))
        .map((composeFile) => remapWorkspacePath(composeFile, mapping));
      const workingDirectory = source.attachment.workingDirectory === undefined
        ? mapping.targetRoot
        : remapWorkspacePath(source.attachment.workingDirectory, mapping);
      const copied = await this.dependencies.networkService.copyComposeAttachment({
        attachmentId: source.attachment.id,
        networkId,
        workingDirectory,
        composeFiles,
        workspacePathMapping: mapping,
      });
      if (copied === undefined) {
        throw new Error(`Compose attachment "${source.label}" disappeared during worktree setup.`);
      }
      return;
    }

    const candidate = source.candidate;
    const composeFiles = (candidate.composeConfigFiles ?? []).map((composeFile) =>
      remapWorkspacePath(composeFile, mapping),
    );
    const workingDirectory = candidate.composeWorkingDirectory === undefined
      ? mapping.targetRoot
      : remapWorkspacePath(candidate.composeWorkingDirectory, mapping);
    await this.dependencies.networkService.attachComposePublishedPorts({
      networkId,
      projectName: candidate.portManagerClone?.attachedProjectName ?? candidate.composeProject ?? candidate.containerName,
      runtime: candidate.runtime,
      cwd: workingDirectory,
      composeFiles,
      composeMutation: {
        mode: "copy",
        allowStatefulClone: true,
        runtime: candidate.runtime,
        workingDirectory,
        composeFiles,
        copyStoppedServices: true,
        workspacePathMapping: mapping,
        ...(candidate.portManagerClone?.containerMappings !== undefined
          ? { sourceContainerMappings: candidate.portManagerClone.containerMappings }
          : {}),
      },
      ports: candidate.ports.map((port) => ({
        serviceName: port.serviceName,
        logicalPort: port.logicalPort,
        actualHostAddress: port.actualHostAddress,
        actualHostPort: port.actualHostPort,
        containerPort: port.containerPort,
        protocolName: port.protocolName,
      })),
    });
  }
}

function aggregateComposeCandidates(
  candidates: readonly ContainerServiceCandidate[],
): readonly ContainerServiceCandidate[] {
  const groups = new Map<string, ContainerServiceCandidate[]>();
  for (const candidate of candidates) {
    const key = [
      candidate.runtime,
      candidate.composeProject,
      candidate.composeWorkingDirectory ?? "",
      ...(candidate.composeConfigFiles ?? []),
    ].join("\u0000");
    const rows = groups.get(key) ?? [];
    rows.push(candidate);
    groups.set(key, rows);
  }

  return [...groups.values()].map((rows) => {
    const first = rows[0];
    const projectName = first.composeProject ?? first.containerName;
    return {
      ...first,
      id: `workspace-compose:${first.runtime}:${projectName}:${first.composeWorkingDirectory ?? ""}`,
      containerId: projectName,
      containerName: projectName,
      ports: uniqueBy(
        rows.flatMap((candidate) => [...candidate.ports]),
        (port) => `${port.serviceName}:${port.logicalPort}:${port.actualHostAddress}:${port.actualHostPort}`,
      ),
      composeConfigFiles: uniqueStrings(rows.flatMap((candidate) => [...(candidate.composeConfigFiles ?? [])])),
    };
  });
}

function toAttachmentSource(attachment: ComposeAttachment): AttachmentCopySource {
  return {
    kind: "attachment",
    key: `attachment:${attachment.id}`,
    label: `${attachment.runtime ?? attachment.mutation?.runtime ?? "compose"}/${attachment.mutation?.attachedProjectName ?? attachment.projectName}`,
    attachment,
  };
}

function composeContextBelongsToWorkspace(
  workingDirectory: string | undefined,
  composeFiles: readonly string[],
  workspaceRoot: string,
): boolean {
  return (
    (workingDirectory !== undefined && isPathInsideWorkspace(workingDirectory, workspaceRoot)) ||
    composeFiles.some((composeFile) => path.isAbsolute(composeFile) && isPathInsideWorkspace(composeFile, workspaceRoot))
  );
}

/**
 * Git worktrees intentionally omit ignored/untracked files, while Compose uses
 * a working-directory `.env` before it can even render config. Seed only that
 * standard local file, never overwrite a target, and leave arbitrary ignored
 * credentials/configuration under explicit user control.
 */
async function seedComposeDotenvFiles(
  sources: readonly ComposeCopySource[],
  mapping: WorkspacePathMapping,
): Promise<void> {
  const directories = uniqueStrings([
    mapping.sourceRoot,
    ...sources.flatMap((source) => {
      if (source.kind === "attachment") {
        return source.attachment.workingDirectory === undefined ? [] : [source.attachment.workingDirectory];
      }
      return source.candidate.composeWorkingDirectory === undefined ? [] : [source.candidate.composeWorkingDirectory];
    }),
  ]).filter((directory) => isPathInsideWorkspace(directory, mapping.sourceRoot));

  for (const sourceDirectory of directories) {
    const sourceDotenv = path.join(sourceDirectory, ".env");
    const targetDotenv = remapWorkspacePath(sourceDotenv, mapping);
    try {
      await fs.copyFile(sourceDotenv, targetDotenv, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EEXIST")) {
        continue;
      }
      throw new Error(`Could not seed Compose environment file ${targetDotenv}: ${formatUnknownError(error)}`);
    }
  }
}

function assertBrowserAccessReady(status: BrowserDnsResolverStatus): void {
  if (!status.supported) {
    return;
  }
  if (!status.dnsRunning) {
    throw new Error("The Local DNS responder is not running. Run Repair Local DNS and retry setup.");
  }
  if (status.missingCount > 0) {
    throw new Error(
      status.tlsTrustState === "untrusted"
        ? status.tlsTrustDetail ?? "macOS Keychain does not trust the Port Manager CA."
        : `${status.missingCount} browser DNS/TLS setup item${status.missingCount === 1 ? " is" : "s are"} incomplete.`,
    );
  }
}

function findPendingNetwork(
  pending: PendingIsolatedWorktreeSetup,
  networks: readonly LogicalNetwork[],
): LogicalNetwork | undefined {
  return pending.networkId === undefined
    ? networks.find((network) => network.name === pending.networkName)
    : networks.find((network) => network.id === pending.networkId);
}

function buildUniqueNetworkName(baseName: string, networks: readonly LogicalNetwork[]): string {
  const normalized = baseName.trim() || "worktree";
  const names = new Set(networks.map((network) => network.name));
  if (!names.has(normalized)) {
    return normalized;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${normalized}-${suffix}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not allocate a unique Logical Network name for "${normalized}".`);
}

function buildSuggestedBranchName(currentBranch: string | undefined): string {
  if (currentBranch === undefined || currentBranch === "main" || currentBranch === "master") {
    return "feature/isolated-worktree";
  }
  return `${currentBranch}-isolated`;
}

function getPrimaryFileWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri === undefined ? undefined : vscode.workspace.getWorkspaceFolder(activeUri);
  return activeFolder?.uri.scheme === "file"
    ? activeFolder
    : (vscode.workspace.workspaceFolders ?? []).find((folder) => folder.uri.scheme === "file");
}

function readPendingSetups(context: vscode.ExtensionContext): readonly PendingIsolatedWorktreeSetup[] {
  const stored = context.globalState.get<PendingIsolatedWorktreeSetupStore>(ISOLATED_WORKTREE_SETUPS_KEY);
  return stored?.version === 1 && Array.isArray(stored.setups)
    ? stored.setups.filter(isPendingSetup)
    : [];
}

function findPendingSetup(
  context: vscode.ExtensionContext,
  targetWorkspacePath: string,
): PendingIsolatedWorktreeSetup | undefined {
  return readPendingSetups(context).find((setup) => samePath(setup.targetWorkspacePath, targetWorkspacePath));
}

async function upsertPendingSetup(
  context: vscode.ExtensionContext,
  pending: PendingIsolatedWorktreeSetup,
): Promise<void> {
  const remaining = readPendingSetups(context).filter(
    (setup) => !samePath(setup.targetWorkspacePath, pending.targetWorkspacePath),
  );
  await context.globalState.update(ISOLATED_WORKTREE_SETUPS_KEY, {
    version: 1,
    setups: [...remaining, pending],
  } satisfies PendingIsolatedWorktreeSetupStore);
}

async function removePendingSetup(context: vscode.ExtensionContext, targetWorkspacePath: string): Promise<void> {
  const remaining = readPendingSetups(context).filter(
    (setup) => !samePath(setup.targetWorkspacePath, targetWorkspacePath),
  );
  await context.globalState.update(ISOLATED_WORKTREE_SETUPS_KEY, {
    version: 1,
    setups: remaining,
  } satisfies PendingIsolatedWorktreeSetupStore);
}

function isPendingSetup(value: unknown): value is PendingIsolatedWorktreeSetup {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<PendingIsolatedWorktreeSetup>;
  return (
    candidate.version === 1 &&
    typeof candidate.sourceRepositoryRoot === "string" &&
    typeof candidate.targetWorktreeRoot === "string" &&
    typeof candidate.targetWorkspacePath === "string" &&
    typeof candidate.branchName === "string" &&
    typeof candidate.networkName === "string" &&
    typeof candidate.createdAt === "string"
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

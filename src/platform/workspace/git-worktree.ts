import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export interface GitWorktreeRow {
  /** Absolute directory registered with Git. */
  readonly path: string;
  /** Checked-out local branch without refs/heads/, absent for detached worktrees. */
  readonly branch?: string;
  /** Commit checked out by the worktree. */
  readonly head?: string;
}

export interface GitWorktreeInspection {
  /** Root of the current linked or primary worktree. */
  readonly repositoryRoot: string;
  /** Current local branch, absent when HEAD is detached. */
  readonly currentBranch?: string;
  /** Commit used as the default start point for a new branch. */
  readonly head: string;
  /** Uncommitted or untracked changes are not copied by `git worktree add`. */
  readonly dirty: boolean;
  /** Every worktree registered in the repository's common Git directory. */
  readonly worktrees: readonly GitWorktreeRow[];
}

export interface CreateGitWorktreeInput {
  /** Any directory inside the source Git worktree. */
  readonly sourceDirectory: string;
  /** Existing local branch to check out, or a new branch created from source HEAD. */
  readonly branchName: string;
  /** New worktree root. An already registered matching worktree is reusable. */
  readonly targetDirectory: string;
}

export interface CreateGitWorktreeResult {
  readonly repositoryRoot: string;
  readonly targetDirectory: string;
  readonly branchName: string;
  /** True when a previous partial onboarding run already created this worktree. */
  readonly reused: boolean;
}

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable low-level runner keeps Git policy independently testable. */
export type GitCommandRunner = (
  args: readonly string[],
  options?: { readonly cwd?: string },
) => Promise<GitCommandResult>;

/**
 * Executes Git worktree operations without a shell. User-controlled branch and
 * path values are always argv entries, so spaces and shell metacharacters do
 * not become commands.
 */
export class NodeGitWorktreeManager {
  constructor(private readonly runGit: GitCommandRunner = runGitCommand) {}

  /** Reads repository identity, dirty state, and all registered worktrees. */
  async inspect(sourceDirectory: string): Promise<GitWorktreeInspection> {
    const repositoryRoot = path.resolve(
      (await this.git(["-C", sourceDirectory, "rev-parse", "--show-toplevel"])).stdout.trim(),
    );
    const [headResult, branchResult, statusResult, worktreeResult] = await Promise.all([
      this.git(["-C", repositoryRoot, "rev-parse", "HEAD"]),
      this.git(["-C", repositoryRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
      this.git(["-C", repositoryRoot, "status", "--porcelain=v1"]),
      this.git(["-C", repositoryRoot, "worktree", "list", "--porcelain"]),
    ]);
    const branch = branchResult.stdout.trim();

    return {
      repositoryRoot,
      ...(branch.length > 0 && branch !== "HEAD" ? { currentBranch: branch } : {}),
      head: headResult.stdout.trim(),
      dirty: statusResult.stdout.trim().length > 0,
      worktrees: parseGitWorktreeList(worktreeResult.stdout),
    };
  }

  /** Uses Git's own ref parser instead of maintaining a weaker local grammar. */
  async validateBranchName(repositoryRoot: string, branchName: string): Promise<string | undefined> {
    const normalized = branchName.trim();
    if (normalized.length === 0) {
      return "Branch name is required.";
    }

    try {
      await this.git(["-C", repositoryRoot, "check-ref-format", "--branch", normalized]);
      return undefined;
    } catch {
      return `Git does not accept branch name "${normalized}".`;
    }
  }

  /** Returns whether a local branch already exists in the shared repository. */
  async branchExists(repositoryRoot: string, branchName: string): Promise<boolean> {
    try {
      await this.runGit([
        "-C",
        repositoryRoot,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
      ]);
      return true;
    } catch (error) {
      if (gitExitCode(error) === 1) {
        return false;
      }
      throw formatGitError(error);
    }
  }

  /** Creates a worktree or reuses the exact same registered branch/path pair. */
  async createOrReuse(input: CreateGitWorktreeInput): Promise<CreateGitWorktreeResult> {
    const inspection = await this.inspect(input.sourceDirectory);
    const branchName = input.branchName.trim();
    const branchError = await this.validateBranchName(inspection.repositoryRoot, branchName);
    if (branchError !== undefined) {
      throw new Error(branchError);
    }

    const targetDirectory = await canonicalizeProspectivePath(input.targetDirectory);
    const sourceRoot = path.resolve(inspection.repositoryRoot);
    if (samePath(targetDirectory, sourceRoot)) {
      throw new Error("The isolated worktree folder must differ from the current Git worktree.");
    }

    const existingAtTarget = inspection.worktrees.find((row) => samePath(row.path, targetDirectory));
    if (existingAtTarget !== undefined) {
      if (existingAtTarget.branch === branchName) {
        if (!(await pathExists(path.join(targetDirectory, ".git")))) {
          throw new Error(
            `Git registered ${targetDirectory} for branch "${branchName}", but the worktree folder is missing or incomplete. Repair or prune that Git worktree before retrying.`,
          );
        }
        return {
          repositoryRoot: sourceRoot,
          targetDirectory,
          branchName,
          reused: true,
        };
      }
      throw new Error(
        `Git already registered ${targetDirectory} for ${existingAtTarget.branch ?? "a detached HEAD"}. Choose another branch or folder.`,
      );
    }

    const branchWorktree = inspection.worktrees.find((row) => row.branch === branchName);
    if (branchWorktree !== undefined) {
      throw new Error(`Branch "${branchName}" is already checked out at ${branchWorktree.path}.`);
    }

    if (await pathExists(targetDirectory)) {
      throw new Error(`Target folder already exists and is not the requested Git worktree: ${targetDirectory}`);
    }

    const exists = await this.branchExists(sourceRoot, branchName);
    const args = exists
      ? ["-C", sourceRoot, "worktree", "add", targetDirectory, branchName]
      : ["-C", sourceRoot, "worktree", "add", "-b", branchName, targetDirectory, inspection.head];
    await this.git(args);

    // Never report success from the command exit alone. Re-read Git's durable
    // registry and require the exact branch/path pair that onboarding needs.
    const verified = await this.inspect(sourceRoot);
    const created = verified.worktrees.find((row) => samePath(row.path, targetDirectory));
    if (created?.branch !== branchName) {
      throw new Error(`Git did not register worktree ${targetDirectory} for branch "${branchName}".`);
    }

    return {
      repositoryRoot: sourceRoot,
      targetDirectory,
      branchName,
      reused: false,
    };
  }

  private async git(args: readonly string[]): Promise<GitCommandResult> {
    try {
      return await this.runGit(args);
    } catch (error) {
      throw formatGitError(error);
    }
  }
}

/** Parses the blank-line-delimited porcelain format without depending on locale. */
export function parseGitWorktreeList(output: string): readonly GitWorktreeRow[] {
  const rows: GitWorktreeRow[] = [];
  let current: { path?: string; branch?: string; head?: string } = {};
  const flush = (): void => {
    if (current.path !== undefined) {
      rows.push({
        path: path.resolve(current.path),
        ...(current.branch !== undefined ? { branch: current.branch } : {}),
        ...(current.head !== undefined ? { head: current.head } : {}),
      });
    }
    current = {};
  };

  for (const line of `${output}\n`.split("\n")) {
    if (line.length === 0) {
      flush();
    } else if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }

  return rows;
}

/** Builds a filesystem-safe sibling directory while preserving branch meaning. */
export function buildWorktreeDirectoryName(repositoryName: string, branchName: string): string {
  const suffix = branchName
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "isolated";
  return `${repositoryName}-${suffix}`;
}

async function runGitCommand(args: readonly string[]): Promise<GitCommandResult> {
  const result = await execFileAsync("git", [...args], {
    encoding: "utf8",
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    env: process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Git canonicalizes macOS aliases such as /var -> /private/var in its worktree
 * registry. Canonicalize the closest existing parent before comparing or
 * persisting a not-yet-created target path.
 */
async function canonicalizeProspectivePath(candidate: string): Promise<string> {
  const resolved = path.resolve(candidate);
  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const canonicalParent = await fs.realpath(path.dirname(resolved));
  return path.join(canonicalParent, path.basename(resolved));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function gitExitCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
}

function formatGitError(error: unknown): Error {
  if (error instanceof Error && !("stderr" in error)) {
    return error;
  }
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  const message = stderr.length > 0 ? stderr : error instanceof Error ? error.message : String(error);
  return new Error(`Git worktree operation failed: ${message}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

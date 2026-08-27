import * as path from "node:path";

/**
 * Maps host paths from one Git worktree into the corresponding location in
 * another worktree. Paths outside the source worktree are intentionally left
 * alone because they represent shared machine resources, not repository files.
 */
export interface WorkspacePathMapping {
  /** Absolute root of the source Git worktree. */
  readonly sourceRoot: string;
  /** Absolute root of the destination Git worktree. */
  readonly targetRoot: string;
}

/** Returns true when candidate is the root itself or one of its descendants. */
export function isPathInsideWorkspace(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Preserves the path relative to sourceRoot under targetRoot. External paths
 * stay unchanged so shared credentials and machine-level mounts keep working.
 */
export function remapWorkspacePath(candidate: string, mapping: WorkspacePathMapping): string {
  if (!path.isAbsolute(candidate) || !isPathInsideWorkspace(candidate, mapping.sourceRoot)) {
    return candidate;
  }

  const relative = path.relative(path.resolve(mapping.sourceRoot), path.resolve(candidate));
  return path.join(path.resolve(mapping.targetRoot), relative);
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildWorktreeDirectoryName,
  NodeGitWorktreeManager,
  parseGitWorktreeList,
} from "../../src/platform/workspace/git-worktree";

test("parses branch and detached rows from git worktree porcelain output", () => {
  const rows = parseGitWorktreeList([
    "worktree /tmp/repo",
    "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /tmp/repo-feature",
    "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "detached",
    "",
  ].join("\n"));

  assert.deepEqual(rows, [
    {
      path: path.resolve("/tmp/repo"),
      branch: "main",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    {
      path: path.resolve("/tmp/repo-feature"),
      head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  ]);
});

test("worktree directory names preserve readable branch identity without path separators", () => {
  assert.equal(buildWorktreeDirectoryName("captain", "feature/user login"), "captain-feature-user-login");
  assert.equal(buildWorktreeDirectoryName("captain", "///"), "captain-isolated");
});

test("creates a branch worktree and safely reuses only the exact branch/path pair", async (context) => {
  if (!gitIsAvailable()) {
    context.skip("git is unavailable");
    return;
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-worktree-test-"));
  context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const repositoryRoot = path.join(fixtureRoot, "repository");
  const targetRoot = path.join(fixtureRoot, "repository-feature");
  fs.mkdirSync(repositoryRoot, { recursive: true });
  runGit(repositoryRoot, ["init", "--quiet"]);
  runGit(repositoryRoot, ["config", "user.name", "Port Manager Test"]);
  runGit(repositoryRoot, ["config", "user.email", "portmanager@example.invalid"]);
  runGit(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repositoryRoot, "README.md"), "fixture\n");
  runGit(repositoryRoot, ["add", "README.md"]);
  runGit(repositoryRoot, ["commit", "-m", "fixture"]);

  const manager = new NodeGitWorktreeManager();
  const created = await manager.createOrReuse({
    sourceDirectory: repositoryRoot,
    branchName: "feature/isolated",
    targetDirectory: targetRoot,
  });
  assert.equal(created.reused, false);
  assert.equal(fs.existsSync(path.join(targetRoot, "README.md")), true);
  assert.equal(runGit(targetRoot, ["branch", "--show-current"]).trim(), "feature/isolated");

  const reused = await manager.createOrReuse({
    sourceDirectory: repositoryRoot,
    branchName: "feature/isolated",
    targetDirectory: targetRoot,
  });
  assert.equal(reused.reused, true);

  await assert.rejects(
    manager.createOrReuse({
      sourceDirectory: repositoryRoot,
      branchName: "feature/other",
      targetDirectory: targetRoot,
    }),
    /already registered/,
  );

  fs.rmSync(targetRoot, { recursive: true, force: true });
  await assert.rejects(
    manager.createOrReuse({
      sourceDirectory: repositoryRoot,
      branchName: "feature/isolated",
      targetDirectory: targetRoot,
    }),
    /missing or incomplete/,
  );
});

function gitIsAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { isPathInsideWorkspace, remapWorkspacePath } from "../../src/shared/workspace-path";

test("remaps only absolute paths owned by the source worktree", () => {
  const sourceRoot = path.resolve("/tmp/captain-main");
  const targetRoot = path.resolve("/tmp/captain-feature");
  const mapping = { sourceRoot, targetRoot };

  assert.equal(
    remapWorkspacePath(path.join(sourceRoot, "docker", "compose.yaml"), mapping),
    path.join(targetRoot, "docker", "compose.yaml"),
  );
  assert.equal(remapWorkspacePath("./compose.yaml", mapping), "./compose.yaml");
  assert.equal(remapWorkspacePath("/var/lib/shared", mapping), "/var/lib/shared");
  assert.equal(isPathInsideWorkspace(`${sourceRoot}-other/file`, sourceRoot), false);
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/**
 * Regression checks for the native Docker/Podman PATH shim source.
 *
 * The binary is exercised by build:hook. These source-level checks protect the
 * resolver policy that prevents multiple Port Manager runtime-shim directories
 * from selecting each other's hard-linked docker aliases as the real runtime.
 */

test("docker shim skips hard-linked Port Manager aliases while resolving the real runtime", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/docker-shim/portmanager_docker_shim.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("left_stat.st_dev == right_stat.st_dev"), true);
  assert.equal(source.includes("left_stat.st_ino == right_stat.st_ino"), true);
  assert.equal(source.includes("pm_candidate_is_current_shim(candidate, self_path)"), true);
  assert.equal(source.includes("pm_resolve_self_path(runtime_executable, argv, self_path"), true);
  assert.equal(source.includes("pm_find_runtime_on_path(runtime_executable, resolved_self_path"), true);
  assert.equal(source.includes("pm_path_without_shim_directory(runtime_executable, resolved_self_path)"), true);
});

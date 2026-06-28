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

test("docker shim refreshes terminal markers after compose lifecycle commands", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/docker-shim/portmanager_docker_shim.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("PM_TERMINAL_ATTACHMENT_DIR_ENV"), true);
  assert.equal(source.includes("pm_compose_command_may_change_endpoints"), true);
  assert.equal(source.includes("pm_spawn_and_signal_on_success"), true);
  assert.equal(source.includes("pm_signal_terminal_attachment_changed();"), true);
});

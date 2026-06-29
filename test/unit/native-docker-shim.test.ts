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

test("docker shim prefers scoped route table network over stale compose routing file", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/docker-shim/portmanager_docker_shim.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const networkStart = source.indexOf("static const char *pm_network_id(void)");
  const networkEnd = source.indexOf("static void pm_default_global_route_table_path", networkStart);
  const networkBody = source.slice(networkStart, networkEnd);
  const matcherStart = source.indexOf("static int pm_route_network_matches");
  const matcherEnd = source.indexOf("static int pm_find_compose_route_from_route_table", matcherStart);
  const matcherBody = source.slice(matcherStart, matcherEnd);

  assert.notEqual(networkStart, -1);
  assert.notEqual(matcherStart, -1);
  assert.equal(
    networkBody.indexOf("pm_network_id_from_route_table_path()") <
      networkBody.indexOf("pm_network_id_from_compose_routing_file()"),
    true,
    "current scoped route table must outrank an inherited stale compose TSV",
  );
  assert.equal(matcherBody.includes("return 1;"), false);
  assert.equal(matcherBody.includes("return 0;"), true);
});

test("docker shim requires generated override for rewritten compose projects", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/docker-shim/portmanager_docker_shim.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("char override_file[PM_MAX_PATH];"), true);
  assert.equal(source.includes('strcmp(row->kind, "project") == 0 || strcmp(row->kind, "file") == 0'), true);
  assert.equal(source.includes("pm_copy(row->override_file, sizeof(row->override_file), fields[6]);"), true);
  assert.equal(source.includes("pm_copy(search->override_file, search->override_size, row.override_file);"), true);
  assert.equal(source.includes("int rewrites_project = original_project[0] != '\\0'"), true);
  assert.equal(source.includes("missing generated Compose override for attached project"), true);
  assert.equal(source.includes("refusing unsafe project rewrite"), true);
});

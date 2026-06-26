import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/**
 * Regression checks for the native asdf launcher source.
 *
 * The binary is exercised by build:hook, while this test protects the policy
 * that prevents asdf's own resolver helpers from re-entering Port Manager
 * runtime shims before the requested runtime can be exec'd.
 */

test("asdf resolver runs outside Port Manager hook and runtime shim PATH", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/asdf-shim/portmanager_asdf_shim.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes('setenv("PORT_MANAGER_HOOK_DISABLED", "1", 1);'), true);
  assert.equal(source.includes("unsetenv(PM_PRELOAD_ENV);"), true);
  assert.equal(source.includes("unsetenv(PM_PRELOAD_HINT_ENV);"), true);
  assert.equal(source.includes('unsetenv("BASH_ENV");'), true);
  assert.equal(source.includes("pm_path_without_runtime_shims(tool_name, self_path)"), true);
  assert.equal(source.includes("pm_candidate_is_current_shim(candidate, self_path)"), true);
});

test("asdf shim fallback skips hard-linked Port Manager aliases", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/asdf-shim/portmanager_asdf_shim.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("left_stat.st_dev == right_stat.st_dev"), true);
  assert.equal(source.includes("left_stat.st_ino == right_stat.st_ino"), true);
  assert.equal(source.includes("pm_resolve_self_path(tool_name, argv[0], self_path"), true);
  assert.equal(source.includes("pm_resolve_tool(tool_name, resolved_self_path"), true);
});

test("asdf nodejs npm wrapper receives canonical npm path", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/asdf-shim/portmanager_asdf_shim.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("pm_prepare_asdf_nodejs_npm_wrapper(tool_name, executable_path, resolved_self_path);"), true);
  assert.equal(source.includes('setenv("ASDF_NODEJS_CANON_NPM_PATH", canonical_npm, 1);'), true);
  assert.equal(source.includes("pm_find_on_path_excluding(\"npm\", self_path, executable_path"), true);
  assert.equal(source.includes("pm_is_asdf_shim_candidate(candidate)"), true);
});

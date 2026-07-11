import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/**
 * Regression checks for the native runtime launcher source.
 *
 * The launcher is installed on PATH under runtime names (node, python, ...) so
 * that when a protected launcher (`/usr/bin/env`, `/bin/sh`) strips DYLD, the
 * next `env node` re-enters this launcher, which restores the preload and execs
 * the REAL runtime. It must be runtime-manager agnostic: the real runtime is
 * simply the next PATH entry of its own name — no asdf/nvm/Homebrew probing and
 * no script parsing.
 */

const sourcePath = path.resolve(__dirname, "../../../native/asdf-shim/portmanager_asdf_shim.c");

test("runtime launcher resolves the real runtime as the next PATH entry, manager agnostic", () => {
  const source = fs.readFileSync(sourcePath, "utf8");

  // Resolution is pure next-in-PATH: skip our own shim dir and our own file.
  assert.equal(source.includes("static int pm_resolve_tool("), true);
  assert.equal(source.includes("pm_same_directory(directory, shim_directory)"), true);
  assert.equal(source.includes("pm_candidate_is_current_shim(candidate, self_path)"), true);
  assert.equal(source.includes("pm_is_executable_file(candidate)"), true);
  assert.equal(source.includes("pm_resolve_tool(tool_name, resolved_self_path"), true);

  // No manager-specific probing or script parsing survives.
  assert.equal(source.includes("pm_asdf_which"), false, "must not shell out to `asdf which`");
  assert.equal(source.includes("pm_is_asdf_shim_candidate"), false, "must not special-case asdf shim paths");
  assert.equal(source.includes("ASDF_NODEJS_CANON_NPM_PATH"), false, "must not carry asdf-nodejs npm wrapper logic");
  assert.equal(source.includes("pm_prepare_asdf_nodejs_npm_wrapper"), false);
  assert.equal(source.includes("pm_disable_hook_for_tool_resolution"), false);
  assert.equal(source.includes("pm_read_shebang"), false, "must not parse script shebangs");
  assert.equal(source.includes("exec \\\""), false, "must not parse exec lines from scripts");
});

test("runtime launcher restores preload and network scope then execs the real runtime", () => {
  const source = fs.readFileSync(sourcePath, "utf8");

  // Skips its own hard-linked aliases by device/inode identity.
  assert.equal(source.includes("left_stat.st_dev == right_stat.st_dev"), true);
  assert.equal(source.includes("left_stat.st_ino == right_stat.st_ino"), true);
  assert.equal(source.includes("pm_resolve_self_path(tool_name, argv[0], self_path"), true);

  // Restores the preload + network scope, then execs the resolved real runtime.
  assert.equal(source.includes("pm_restore_network_scope();"), true);
  assert.equal(source.includes("pm_restore_dyld();"), true);
  assert.equal(source.includes("execv(executable_path, next_argv);"), true);
});

test("runtime launcher fails open when an upgraded extension removed the hinted hook", () => {
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("pm_preload_segment_is_portmanager_hook"), true);
  assert.equal(source.includes("pm_without_portmanager_preloads"), true);
  assert.equal(source.includes("if (access(hook, R_OK) != 0)"), true);
  assert.equal(source.includes('unsetenv(PM_PRELOAD_ENV);'), true);
  assert.equal(source.includes('setenv("PORT_MANAGER_HOOK", "0", 1);'), true);
  assert.equal(source.includes("Never pass a missing dylib to dyld"), true);
});

test("runtime launcher guards against a resolution loop", () => {
  const source = fs.readFileSync(sourcePath, "utf8");

  // A depth counter caps re-entry when the next PATH entry is itself a shim.
  assert.equal(source.includes("PM_RUNTIME_SHIM_DEPTH_ENV"), true);
  assert.equal(source.includes("depth >= PM_RUNTIME_SHIM_DEPTH_LIMIT"), true);
  assert.equal(source.includes("runtime resolution loop"), true);
});

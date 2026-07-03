import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { DEFAULT_PORT_MANAGER_SETTINGS } from "../../src/shared/default-settings";

/**
 * Regression checks for terminal hook shell bootstrap generation.
 *
 * The extension module imports vscode directly, so these tests inspect the
 * source template without loading the extension host. The behavior guarded here
 * is intentionally narrow: runtime shims must be promoted to the front of PATH
 * even when they are already present later in the inherited shell environment.
 */

test("BASH_ENV restore script promotes runtime shims ahead of inherited PATH entries", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(
    source.includes('case ":\\${PATH:-}:"'),
    false,
    "runtime shim restore must not skip PATH repair just because the shim directory is already present",
  );
  assert.equal(source.includes('for __pm_path_entry in \\${PATH:-}; do'), true);
  assert.equal(
    source.includes('if [ "\\${__pm_path_entry}" = "\\${PORT_MANAGER_RUNTIME_SHIM_DIR}" ]; then'),
    true,
  );
  assert.equal(
    source.includes('export PATH="\\${PORT_MANAGER_RUNTIME_SHIM_DIR}\\${__pm_path_rest:+:$__pm_path_rest}"'),
    true,
  );
  assert.equal(source.includes("export PORT_MANAGER_RUNTIME_SHIM_READY=0"), true);
  assert.equal(source.includes("for __pm_shim_name in ${TERMINAL_RUNTIME_SHIM_READY_CHECK_NAMES.join(\" \")}"), true);
  assert.equal(source.includes('export PATH="\\${__pm_path_rest}"'), true);
});

test("terminal hook preload entries are normalized across multiple VS Code windows", () => {
  const terminalHookEnvironmentPath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const nativeHookPath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const nativeAsdfShimPath = path.resolve(__dirname, "../../../native/asdf-shim/portmanager_asdf_shim.c");
  const terminalHookEnvironmentSource = fs.readFileSync(terminalHookEnvironmentPath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const nativeHookSource = fs.readFileSync(nativeHookPath, "utf8");
  const nativeAsdfShimSource = fs.readFileSync(nativeAsdfShimPath, "utf8");
  const applyStart = terminalHookEnvironmentSource.indexOf("export function applyTerminalHookEnvironment");
  const applyEnd = terminalHookEnvironmentSource.indexOf("/** Mirrors the per-network bind hosts", applyStart);
  const applyBody = terminalHookEnvironmentSource.slice(applyStart, applyEnd);
  const attachStart = networkServiceSource.indexOf("private buildTerminalRoutingScriptBody");
  const detachStart = networkServiceSource.indexOf("private buildTerminalDetachScriptBody");
  const attachBody = networkServiceSource.slice(attachStart, detachStart);
  const detachBody = networkServiceSource.slice(detachStart, networkServiceSource.indexOf("export interface", detachStart));

  assert.equal(applyBody.includes("collection.prepend(preloadVariable"), false);
  assert.equal(applyBody.includes("prependUniquePathListEntry(hookLibraryPath, process.env[preloadVariable])"), true);
  assert.equal(applyBody.includes("collection.replace(preloadHintVariable, hookLibraryPath"), true);
  assert.equal(terminalHookEnvironmentSource.includes('collection.replace(\n      "PATH"'), false);
  assert.equal(
    terminalHookEnvironmentSource.includes('collection.prepend("PATH", `${launcherDirectory}${path.delimiter}`, TERMINAL_MUTATOR_OPTIONS);'),
    true,
  );
  assert.equal(terminalHookEnvironmentSource.includes('process.platform === "darwin" ? "PORT_MANAGER_DYLD_INSERT_LIBRARIES" : "PORT_MANAGER_LD_PRELOAD"'), true);
  assert.equal(terminalHookEnvironmentSource.includes("function prependUniquePathListEntry"), true);
  assert.equal(terminalHookEnvironmentSource.includes("function buildShellPrependVariablePathListEntry"), true);
  assert.equal(attachBody.includes("shellPrependLibrary(preloadVariable, hookLibraryPath)"), true);
  assert.equal(attachBody.includes("shellPrependPathListEntry(\"PATH\", runtimeShimDirectory)"), true);
  assert.equal(detachBody.includes("shellRemovePathListEntry(preloadVariable, hookLibraryPath)"), true);
  assert.equal(detachBody.includes("shellRemovePathListEntry(\"PATH\", runtimeShimDirectory)"), true);
  assert.equal(networkServiceSource.includes("function shellPrependPathListEntry"), true);
  assert.equal(networkServiceSource.includes("function shellRemovePathListEntry"), true);
  assert.equal(networkServiceSource.includes('"PORT_MANAGER_LD_PRELOAD"'), true);
  assert.equal(nativeHookSource.includes("static int pm_preload_value_is_normalized"), true);
  assert.equal(nativeHookSource.includes("static void pm_normalize_process_preload_env"), true);
  assert.equal(nativeHookSource.includes("pm_normalize_process_preload_env();"), true);
  assert.equal(nativeHookSource.includes("pm_preload_value_is_normalized(current_preload, hook_path)"), true);
  assert.equal(nativeAsdfShimSource.includes("static int pm_preload_value_is_normalized"), true);
  assert.equal(nativeAsdfShimSource.includes("static char *pm_make_preload_value"), true);
  assert.equal(nativeAsdfShimSource.includes("setenv(PM_PRELOAD_ENV, merged, 1);"), true);
});

test("experimental route ownership env is opt-in and cleaned from legacy paths", () => {
  const terminalHookEnvironmentPath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const nodeRuntimePath = path.resolve(__dirname, "../../../src/platform/process/node-runtime.ts");
  const terminalHookEnvironmentSource = fs.readFileSync(terminalHookEnvironmentPath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const nodeRuntimeSource = fs.readFileSync(nodeRuntimePath, "utf8");

  assert.equal(terminalHookEnvironmentSource.includes("PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE"), true);
  assert.equal(terminalHookEnvironmentSource.includes('settings.experimentalRouteOwnershipMode !== "process"'), true);
  assert.equal(terminalHookEnvironmentSource.includes("shouldExposeNetworkLoopbackHost(settings)"), true);
  assert.equal(terminalHookEnvironmentSource.includes("unset ${EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV}"), true);
  assert.equal(networkServiceSource.includes("EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV"), true);
  assert.equal(commandsSource.includes("EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV"), true);
  assert.equal(nodeRuntimeSource.includes('"PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE"'), true);
});

test("package command shims rerun client tools without native runtime alias semantics", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const launcherList = /const PRELOAD_RUNTIME_LAUNCHER_NAMES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const packageCommandList = /const PRELOAD_PACKAGE_COMMAND_NAMES(?::[^=]+)? = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const packageManagerList = /const PRELOAD_PACKAGE_MANAGER_NAMES(?::[^=]+)? = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const packageManagerShimStart = source.indexOf("function buildPreloadPackageManagerCommandShimScript");
  const packageManagerShimEnd = source.indexOf("function shellEnvRestoreFileName", packageManagerShimStart);
  const packageManagerShim = source.slice(packageManagerShimStart, packageManagerShimEnd);
  const packageManagerProjectCommandStart = packageManagerShim.indexOf("if __pm_package_manager_command_runs_project_code");
  const packageManagerProjectCommandEnd = packageManagerShim.indexOf('exec "\\${__pm_target}" "$@"', packageManagerProjectCommandStart);
  const packageManagerProjectCommandBlock = packageManagerShim.slice(
    packageManagerProjectCommandStart,
    packageManagerProjectCommandEnd,
  );
  const preloadedManagerStart = source.indexOf("function buildPreloadedPackageManagerEntrypointShell");
  const preloadedManagerEnd = source.indexOf("function buildPreloadPackageCommandShimScript", preloadedManagerStart);
  const preloadedManagerBlock = source.slice(preloadedManagerStart, preloadedManagerEnd);
  const hookedManagerStart = source.indexOf("function buildHookedPackageManagerEntrypointShell");
  const hookedManagerEnd = source.indexOf("function buildPreloadedPackageManagerEntrypointShell", hookedManagerStart);
  const hookedManagerBlock = source.slice(hookedManagerStart, hookedManagerEnd);
  const viteHostNarrowingStart = source.indexOf("function buildViteHostNarrowingShell");
  const viteHostNarrowingEnd = source.indexOf("/**\n * Protected shebang launchers", viteHostNarrowingStart);
  const viteHostNarrowingBlock = source.slice(viteHostNarrowingStart, viteHostNarrowingEnd);
  const nodeEntrypointBypassStart = source.indexOf("function buildPreloadNodeEntrypointBypassShell");
  const nodeEntrypointBypassEnd = source.indexOf("function buildCleanPackageManagerEntrypointShell", nodeEntrypointBypassStart);
  const nodeEntrypointBypassBlock = source.slice(nodeEntrypointBypassStart, nodeEntrypointBypassEnd);

  for (const packageBinary of ["concurrently", "wait-on", "retry", "vite", "dotenv", "celery", "uvicorn", "gunicorn", "daphne"]) {
    assert.equal(
      launcherList.includes(`"${packageBinary}"`),
      false,
      `${packageBinary} must not use the native runtime launcher argv semantics`,
    );
    assert.equal(
      packageCommandList.includes(`"${packageBinary}"`),
      true,
      `${packageBinary} must use the command-capturing preload shim`,
    );
  }

  for (const packageManager of ["npm", "npx", "pnpm", "pnpx", "corepack", "uv", "uvx", "yarn", "yarnpkg"]) {
    assert.equal(
      launcherList.includes(`"${packageManager}"`),
      false,
      `${packageManager} must not be hooked as a runtime launcher`,
    );
    assert.equal(
      packageCommandList.includes(`"${packageManager}"`),
      false,
      `${packageManager} must not be hooked as a package command shim`,
    );
    assert.equal(
      packageManagerList.includes(`"${packageManager}"`),
      true,
      `${packageManager} must use the package-manager project-command detector shim`,
    );
  }

  assert.equal(source.includes("buildPreloadPackageCommandShimScript"), true);
  assert.equal(source.includes("buildPreloadPackageManagerCommandShimScript"), true);
  assert.equal(source.includes("writePreloadPackageManagerCommandShims"), true);
  assert.equal(source.includes("__pm_package_manager_command_runs_project_code()"), true);
  assert.equal(source.includes("__pm_dependency_command_name()"), true);
  assert.equal(source.includes("run|tool|x|uvx) return 0"), true);
  assert.equal(source.includes("install|i|ci|add|remove|rm|uninstall|unlink|link"), true);
  assert.equal(source.includes("preinstall|install:clean|postinstall|prepare"), true);
  assert.equal(source.includes("__pm_text_looks_like_dev_server()"), true);
  assert.equal(source.includes("__pm_package_script_text()"), true);
  assert.equal(source.includes("*vite*"), true);
  assert.equal(source.includes("*celery*"), true);
  assert.equal(source.includes("*uvicorn*"), true);
  assert.equal(source.includes("removeLegacyPreloadPackageManagerShims"), false);
  assert.equal(source.includes("PRELOAD_PACKAGE_MANAGER_NAMES.includes(entry.name)"), true);
  assert.equal(source.includes("__pm_is_package_command_shim()"), true);
  assert.equal(source.includes("export PORT_MANAGER_PRELOAD_REPAIR=1"), true);
  assert.equal(
    source.includes('collection.replace("PORT_MANAGER_COMPOSE_LOGICAL_PORTS", composeLogicalPorts, TERMINAL_MUTATOR_OPTIONS);'),
    true,
    "terminal env collection must clear stale compose logical ports when the current network has none",
  );
  assert.equal(
    source.includes("const composeLogicalPortsExport = `export PORT_MANAGER_COMPOSE_LOGICAL_PORTS=${shellQuote(composeLogicalPorts)}`;"),
    true,
    "BASH_ENV restore must clear stale compose logical ports when the current network has none",
  );
  assert.equal(
    source.includes(
      'if [ "\\${PORT_MANAGER_HOOK_DISABLED:-}" != "1" ] && [ "\\${PORT_MANAGER_HOOK:-1}" != "0" ] && [ "\\${PORT_MANAGER_PRELOAD_REPAIR:-}" = "1" ] && [ -n "\\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then',
    ),
    true,
    "BASH_ENV must repair DYLD only while the Port Manager hook remains enabled",
  );
  assert.equal(source.includes("unset BASH_ENV PORT_MANAGER_PRELOAD_REPAIR PORT_MANAGER_DYLD_INSERT_LIBRARIES"), true);
  assert.equal(source.includes("PORT_MANAGER_COMPOSE_LOGICAL_PORTS"), true);
  assert.equal(source.includes("PORT_MANAGER_TERMINAL_ATTACHMENT_DIR"), true);
  assert.equal(
    source.includes('if __pm_is_package_command_shim "\\${__pm_candidate}"; then'),
    true,
    "package command shim must skip sibling Port Manager package shims in later PATH entries",
  );
  assert.equal(source.includes('exec "\\${__pm_node}" "\\${__pm_unwrapped}" "$@"'), true);
  assert.equal(
    source.includes('__pm_exec_script="$(sed -n'),
    true,
    "package command shim must parse Yarn temporary wrappers that exec node plus a JS entrypoint",
  );
  assert.equal(
    source.includes('exec "\\${__pm_node}" "\\${__pm_exec_script}" "$@"'),
    true,
    "package command shim must bypass temporary shell wrappers before they strip DYLD again",
  );
  assert.equal(
    source.includes("function buildPreloadNodeEntrypointBypassShell"),
    true,
    "package-bin shims must keep the Node entrypoint bypass for protected shebangs",
  );
  assert.equal(
    source.includes("function buildViteHostNarrowingShell"),
    true,
    "Vite package-bin shims must constrain unsafe --host forms to localhost",
  );
  assert.equal(
    nodeEntrypointBypassBlock.includes("${buildViteHostNarrowingShell()}"),
    true,
    "package-bin shims must normalize Vite args before executing protected Node entrypoints",
  );
  assert.equal(
    viteHostNarrowingBlock.includes('[ "\\${__pm_name:-}" = "vite" ]'),
    true,
    "host narrowing must apply only to Vite command shims",
  );
  assert.equal(
    viteHostNarrowingBlock.includes('__pm_vite_host="localhost"'),
    true,
    "host narrowing must keep Vite listening as localhost",
  );
  assert.equal(
    viteHostNarrowingBlock.includes("PORT_MANAGER_NETWORK_DNS_ALIAS"),
    true,
    "host narrowing must fold the active DNS alias back to localhost",
  );
  assert.equal(
    source.includes("function buildViteAllowedHostsExport"),
    true,
    "network DNS aliases must be registered as Vite safe hosts in attached terminals",
  );
  assert.equal(
    source.includes("PORT_MANAGER_VITE_ALLOWED_HOSTS"),
    true,
    "Port Manager-owned safe host entries must be tracked separately from user Vite hosts",
  );
  assert.equal(
    source.includes("${viteAllowedHostsExport}"),
    true,
    "BASH_ENV restore must publish DNS aliases to the Vite safe-host environment",
  );
  assert.equal(
    viteHostNarrowingBlock.includes("--host=|--host=0.0.0.0|--host=::|--host=\\\\*)"),
    true,
    "wildcard --host forms must be rewritten to localhost",
  );
  assert.equal(
    viteHostNarrowingBlock.includes('set -- "$@" "\\${__pm_vite_host}" "\\${__pm_arg}"'),
    true,
    "bare --host before another option must insert localhost before preserving that option",
  );
  assert.equal(
    source.includes("function buildCleanPackageManagerEntrypointShell"),
    true,
    "package-manager shims must clean-run manager layers before child runtime shims restore preload",
  );
  assert.equal(
    source.includes("function buildHookedPackageManagerEntrypointShell"),
    true,
    "script-based package managers must keep native exec interception for absolute node_modules/.bin launches",
  );
  assert.equal(
    source.includes("function buildPreloadedPackageManagerEntrypointShell"),
    true,
    "package-manager shims must preserve preload for managers that exec runtimes by absolute path",
  );
  assert.equal(
    source.includes("__pm_package_manager_requires_preload_parent()"),
    true,
    "package-manager shim must classify managers that need parent preload",
  );
  assert.equal(
    source.includes("uv|uvx) return 0"),
    true,
    "uv and uvx must stay preloaded so uv-run Python children keep routing hooks",
  );
  assert.equal(
    source.includes("npm|npx|pnpm|pnpx|corepack|yarn|yarnpkg) return 0"),
    true,
    "Node package managers must keep the parent hook during project scripts so Yarn shell launches can be rewritten",
  );
  assert.equal(
    source.includes("__pm_package_manager_is_native_binary()"),
    true,
    "package-manager shim must keep native binaries out of script parsing",
  );
  assert.equal(
    packageManagerProjectCommandBlock.includes("${buildCleanPackageManagerEntrypointShell()}"),
    true,
    "package-manager project commands must keep a clean fallback for Node manager layers",
  );
  assert.equal(
    packageManagerProjectCommandBlock.includes("${buildPreloadedPackageManagerEntrypointShell()}"),
    true,
    "package-manager project commands must preserve preload before clean fallback when needed",
  );
  assert.equal(
    packageManagerProjectCommandBlock.includes("${buildHookedPackageManagerEntrypointShell()}"),
    true,
    "package-manager project commands must run script-based managers with a hooked parent",
  );
  assert.equal(
    packageManagerProjectCommandBlock.includes("__pm_package_manager_is_native_binary"),
    true,
    "package-manager project commands must avoid Node wrapper parsing for native package managers",
  );
  assert.equal(
    packageManagerProjectCommandBlock.includes("export PORT_MANAGER_PRELOAD_REPAIR=1"),
    true,
    "package-manager shim must repair runtime commands while keeping dependency lifecycle commands clean",
  );
  assert.equal(
    source.includes('buildShellPrependVariablePathListEntry("DYLD_INSERT_LIBRARIES", "PORT_MANAGER_DYLD_INSERT_LIBRARIES")'),
    true,
    "preload-parent package managers must restore macOS DYLD before running project code",
  );
  assert.equal(
    hookedManagerBlock.includes("buildPreloadNodeEntrypointBypassShell"),
    true,
    "hooked script package managers must bypass protected Node shebangs while preserving preload",
  );
  assert.equal(
    preloadedManagerBlock.includes('exec "\\${__pm_target}" "$@"`;'),
    true,
    "preload-parent package managers should exec the native manager directly instead of parsing it as a Node wrapper",
  );
  assert.equal(
    preloadedManagerBlock.includes("buildPreloadNodeEntrypointBypassShell"),
    false,
    "preload-parent package managers must not parse native binaries with the Node wrapper bypass",
  );
  assert.equal(
    source.includes("Darwin) unset DYLD_INSERT_LIBRARIES ;;"),
    true,
    "package-manager clean exec should remove macOS DYLD only from the manager layer",
  );
});

test("runtime shim directory preserves active command paths while rewriting shims", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const prepareStart = source.indexOf("export function prepareRuntimeShimLauncherDirectory");
  const prepareEnd = source.indexOf("/** Compatibility wrapper", prepareStart);
  const prepareBody = source.slice(prepareStart, prepareEnd);
  const cleanupStart = source.indexOf("function removeStaleRuntimeShimArtifacts");
  const cleanupEnd = source.indexOf("function isStaleGeneratedRuntimeShim", cleanupStart);
  const cleanupBody = source.slice(cleanupStart, cleanupEnd);
  const staleCheckStart = source.indexOf("function isStaleGeneratedRuntimeShim");
  const staleCheckEnd = source.indexOf("/**\n * Creates a bash startup fragment", staleCheckStart);
  const staleCheckBody = source.slice(staleCheckStart, staleCheckEnd);

  assert.equal(
    prepareBody.indexOf("removeStaleRuntimeShimArtifacts(targetDirectory);") <
      prepareBody.indexOf("writePreloadPackageManagerCommandShims(targetDirectory);"),
    true,
    "stale unrelated artifacts must be cleaned before stable package-manager shims are rewritten",
  );
  assert.equal(cleanupBody.includes('path.join(targetDirectory, ".portmanager-node")'), true);
  assert.equal(cleanupBody.includes("fs.readdirSync(targetDirectory, { withFileTypes: true })"), true);
  assert.equal(cleanupBody.includes("currentGeneratedShimNames"), true);
  assert.equal(cleanupBody.includes("RUNTIME_COMMAND_SHIM_NAMES"), true);
  assert.equal(cleanupBody.includes("PRELOAD_PACKAGE_MANAGER_NAMES"), true);
  assert.equal(cleanupBody.includes("PRELOAD_PACKAGE_COMMAND_NAMES"), true);
  assert.equal(cleanupBody.includes("isPortManagerGeneratedRuntimeShim(shimPath)"), true);
  assert.equal(cleanupBody.includes("existingPath.isSymbolicLink()"), true);
  assert.equal(cleanupBody.includes("Never unlink active command names"), true);
  assert.equal(cleanupBody.includes("currentGeneratedShimNames.has(entry.name)) {\n      /*"), true);
  assert.equal(cleanupBody.includes("isStaleGeneratedRuntimeShim(shimPath)"), false);
  assert.equal(source.includes("function temporarySiblingPath"), true);
  assert.equal(source.includes("function replacePathAtomically"), true);
  assert.equal(source.includes("fs.renameSync(tempPath, filePath)"), true);
  assert.equal(
    source.includes('fs.rmSync(filePath, { recursive: true, force: true });\n  fs.writeFileSync(filePath'),
    false,
    "runtime shim rewrites must not expose a missing executable between unlink and recreate",
  );
  assert.equal(staleCheckBody.includes('"Generated by Port Manager."'), true);
  assert.equal(source.includes('const VITE_ADDITIONAL_ALLOWED_HOSTS_ENV = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";'), true);
  assert.equal(staleCheckBody.includes("VITE_ADDITIONAL_ALLOWED_HOSTS_ENV"), true);
  assert.equal(staleCheckBody.includes('".portmanager-node"'), true);
  assert.equal(staleCheckBody.includes('"PORT_MANAGER_HOOK_DISABLED"'), true);
  assert.equal(staleCheckBody.includes('"__pm_package_manager_command_should_run_clean"'), true);
  assert.equal(staleCheckBody.includes('"__pm_exec_without_port_manager_preload"'), true);
});

test("global storage cleanup preserves live terminal hook assets", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes('const RUNTIME_SHIM_DIRECTORY_NAME = "runtime-shims";'), true);
  assert.equal(source.includes("function isLiveTerminalHookStorageEntry"), true);
  assert.equal(source.includes("entryName === RUNTIME_SHIM_DIRECTORY_NAME"), true);
  assert.equal(source.includes("entryName === TERMINAL_HOOK_SCRIPT_DIRECTORY_NAME"), true);
  assert.equal(source.includes('entryName.startsWith("portmanager-bash-env")'), true);
  assert.equal(source.includes("if (isLiveTerminalHookStorageEntry(entry.name))"), true);
});

test("global shell hook keeps no-network shells out of native preload routing", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const hookStart = source.indexOf("return `# Port Manager shell hook");
  const hookEnd = source.indexOf("/** Appends one line to a shell profile", hookStart);
  const hookTemplate = source.slice(hookStart, hookEnd);

  assert.equal(hookTemplate.includes('if [ -n "\\${PORT_MANAGER_NETWORK_ID:-}" ]'), true);
  assert.equal(hookTemplate.includes("unset PORT_MANAGER_HOOK_DISABLED\n  export PORT_MANAGER_HOOK=1"), true);
  assert.equal(hookTemplate.includes("export PORT_MANAGER_HOOK=0"), true);
  assert.equal(hookTemplate.includes("export PORT_MANAGER_HOOK_DISABLED=1"), true);
  assert.equal(hookTemplate.includes("export PORT_MANAGER_HOOK_DAEMON_STARTED=0"), true);
  assert.equal(hookTemplate.includes("export PORT_MANAGER_RUNTIME_SHIM_READY=0"), true);
  assert.equal(hookTemplate.includes("unset PORT_MANAGER_DYLD_INSERT_LIBRARIES"), true);
  assert.equal(hookTemplate.includes("PORT_MANAGER_LD_PRELOAD"), true);
  const preloadRepairExport = hookTemplate.indexOf("export PORT_MANAGER_DYLD_INSERT_LIBRARIES");
  assert.notEqual(preloadRepairExport, -1);
  assert.notEqual(hookTemplate.lastIndexOf('if [ "\\${PORT_MANAGER_HOOK:-0}" = "1" ]; then', preloadRepairExport), -1);
  assert.equal(hookTemplate.includes("__pm_load_native_hook()"), true);
  assert.equal(hookTemplate.includes("__pm_runtime_shim_check()"), true);
  assert.equal(hookTemplate.includes("Port Manager routing unavailable: runtime shim check failed."), true);
  assert.equal(
    hookTemplate.includes(
      'if [ -n "\\${PORT_MANAGER_RUNTIME_SHIM_DIR:-}" ] && [ "\\${PORT_MANAGER_RUNTIME_SHIM_READY:-0}" != "1" ]; then',
    ),
    true,
  );
  assert.equal(hookTemplate.includes('if [ "\\${PORT_MANAGER_HOOK:-0}" != "1" ] || [ ! -f "${escapedHookLibraryPath}" ]; then'), true);
  assert.equal(hookTemplate.includes('shellPrependPathListEntry("DYLD_INSERT_LIBRARIES", options.hookLibraryPath)'), true);
  assert.equal(hookTemplate.includes('shellPrependPathListEntry("LD_PRELOAD", options.hookLibraryPath)'), true);
  assert.equal(hookTemplate.includes("removeNativeHookPreloadScript"), true);
  assert.equal(source.includes('shellRemovePathListEntry("DYLD_INSERT_LIBRARIES", options.hookLibraryPath)'), true);
  assert.equal(source.includes('shellRemovePathListEntry("LD_PRELOAD", options.hookLibraryPath)'), true);
  assert.equal(hookTemplate.includes("export PORT_MANAGER_HOOK=1\nexport PORT_MANAGER_AGENT_SOCKET"), false);
  assert.equal(hookTemplate.includes("__pm_agent_required()"), true);
  assert.equal(hookTemplate.includes('export ${AGENT_REQUIRED_ENV}="${agentRequired ? "1" : "0"}"'), true);
  assert.equal(hookTemplate.includes('if __pm_agent_required; then\n    __pm_agent_ensure'), true);
  assert.equal(
    hookTemplate.includes('if [ "\\${PORT_MANAGER_HOOK:-0}" = "1" ]; then\n  __pm_agent_ensure'),
    false,
    "global shell hook must not start the daemon without checking whether this routing mode needs it",
  );
});

test("terminal attach and detach commands source generated script files", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes('const TERMINAL_HOOK_SCRIPT_DIRECTORY_NAME = "terminal-hook-scripts";'), true);
  assert.equal(source.includes("private writeTerminalHookScript(fileName: string, contents: string): string"), true);
  assert.equal(
    source.includes('private buildTerminalHookScriptFileName(kind: "attach" | "detach", scope: string, contents: string): string'),
    true,
  );
  assert.equal(source.includes('return `${kind}-${sanitizeRouteFileScope(scope)}-${hash}.sh`;'), true);
  assert.equal(source.includes('this.buildTerminalHookScriptFileName("attach", network.id, scriptBody)'), true);
  assert.equal(source.includes('this.buildTerminalHookScriptFileName("detach", "global", scriptBody)'), true);
  assert.equal(source.includes('writeTerminalHookScript("detach.sh"'), false);
  assert.equal(source.includes("return `. ${shellQuote(scriptPath)}`;"), true);
  assert.equal(
    source.includes("return commands.join(\"; \");"),
    false,
    "terminal injection must not inline the full bootstrap as one long command",
  );
  assert.equal(
    source.includes("buildTerminalAttachmentMarkerRemoveShell(): string"),
    true,
    "detach script must remove the shell marker through a generated helper",
  );
  assert.equal(
    source.includes('].join("\\n");'),
    true,
    "detach marker removal must be multiline so `then` is not followed by an invalid semicolon",
  );
});

test("terminal attach markers are scoped by terminal session id", () => {
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const composeRoutingPath = path.resolve(__dirname, "../../../src/extension/compose-project-routing.ts");
  const registryPath = path.resolve(__dirname, "../../../src/core/networks/logical-network-registry.ts");
  const commandSourcePath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const composeRoutingSource = fs.readFileSync(composeRoutingPath, "utf8");
  const registrySource = fs.readFileSync(registryPath, "utf8");
  const commandSource = fs.readFileSync(commandSourcePath, "utf8");

  assert.equal(networkServiceSource.includes("function buildTerminalSessionIsolationShell(): string"), true);
  assert.equal(networkServiceSource.includes("PORT_MANAGER_TERMINAL_SESSION_ID"), true);
  assert.equal(networkServiceSource.includes("PORT_MANAGER_TERMINAL_PROCESS_GROUP_ID"), true);
  assert.equal(networkServiceSource.includes("buildTerminalSessionIsolationShell()"), true);
  assert.equal(
    networkServiceSource.includes(
      "printf \\'%s\\\\t%s\\\\t%s\\\\t%s\\\\t%s\\\\t%s\\\\n\\' \"$PORT_MANAGER_NETWORK_ID\"",
    ),
    true,
  );
  assert.equal(networkServiceSource.includes('attachment.terminalSessionId ?? (terminalId.length > 0'), true);
  assert.equal(networkServiceSource.includes("normalizeTerminalSessionId"), true);
  assert.equal(composeRoutingSource.includes("__pm_signal_identity=\"\\${PORT_MANAGER_TERMINAL_SESSION_ID:-"), true);
  assert.equal(composeRoutingSource.includes("printf '%s\\\\t%s\\\\t%s\\\\t%s\\\\t%s\\\\t%s\\\\n'"), true);
  assert.equal(
    registrySource.includes(
      "left.terminalSessionId !== undefined &&\n    right.terminalSessionId !== undefined &&",
    ),
    true,
  );
  assert.equal(commandSource.includes("__pm_marker_identity=\"\\${PORT_MANAGER_TERMINAL_SESSION_ID:-"), true);
  assert.equal(commandSource.includes("PORT_MANAGER_TERMINAL_PROCESS_GROUP_ID"), true);
});

test("external pm shell function selects a network and sources its attach script", () => {
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const commandSourcePath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const terminalHookEnvironmentPath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const commandSource = fs.readFileSync(commandSourcePath, "utf8");
  const terminalHookEnvironmentSource = fs.readFileSync(terminalHookEnvironmentPath, "utf8");
  const attachBodyStart = networkServiceSource.indexOf("private buildTerminalRoutingScriptBody");
  const attachBodyEnd = networkServiceSource.indexOf("  /** Builds a one-line shell command", attachBodyStart);
  const attachBody = networkServiceSource.slice(attachBodyStart, attachBodyEnd);
  const daemonReadyGuardIndex = attachBody.indexOf(
    'if [ "\\${PORT_MANAGER_HOOK_DAEMON_STARTED:-0}" != "1" ]; then return 1 2>/dev/null || exit 1; fi',
  );
  const shimReadyCheckIndex = attachBody.indexOf("buildRuntimeShimReadinessShell(runtimeShimDirectory)");
  const shimReadyGuardIndex = attachBody.indexOf(
    'if [ "\\${PORT_MANAGER_RUNTIME_SHIM_READY:-0}" != "1" ]; then return 1 2>/dev/null || exit 1; fi',
  );
  const titleWriteIndex = attachBody.indexOf("buildTerminalTitleShell(buildPortManagerTerminalTitle(networkName))");
  const markerWriteIndex = attachBody.indexOf("buildTerminalAttachmentMarkerWriteShell()");

  assert.equal(networkServiceSource.includes('const TERMINAL_NETWORK_SELECTION_FILE_NAME = "terminal-networks.tsv";'), true);
  assert.equal(networkServiceSource.includes("private async writeTerminalNetworkSelectionFile(): Promise<void>"), true);
  assert.equal(networkServiceSource.includes("const serviceSummary = buildTerminalNetworkServiceSummary"), true);
  assert.equal(networkServiceSource.includes("serializeTerminalNetworkSelectionRow(network.id, network.name, scriptPath, serviceSummary)"), true);
  assert.equal(networkServiceSource.includes("void this.writeTerminalNetworkSelectionFile();"), true);
  assert.equal(networkServiceSource.includes("await this.writeTerminalNetworkSelectionFile().catch(() => undefined);"), true);
  assert.equal(networkServiceSource.includes("private terminalNetworkSelectionWriteInFlight"), true);
  assert.equal(networkServiceSource.includes("private terminalNetworkSelectionWriteQueued = false;"), true);
  assert.equal(networkServiceSource.includes("private async writeTerminalNetworkSelectionFileSerially(): Promise<void>"), true);
  assert.equal(networkServiceSource.includes("private async writeTerminalNetworkSelectionFileExclusive(): Promise<void>"), true);
  assert.equal(networkServiceSource.includes("await writeTextFileAtomically(filePath"), true);
  assert.equal(networkServiceSource.includes("await fs.rename(tempPath, filePath)"), true);
  assert.equal(networkServiceSource.includes('const TERMINAL_NETWORK_SERVICE_ENTRY_SEPARATOR = " || ";'), true);
  assert.equal(networkServiceSource.includes("buildTerminalNetworkServiceSummary(network.id, snapshot)"), true);
  assert.equal(networkServiceSource.includes('item.status === "attached" || item.status === "error"'), true);
  assert.equal(networkServiceSource.includes("formatTerminalNetworkServiceEntry(\"compose\""), true);
  assert.equal(networkServiceSource.includes("isContainerStyleComposeAttachment(attachment)"), true);
  assert.equal(networkServiceSource.includes("formatTerminalNetworkServiceEntry(\"container\""), true);
  assert.equal(networkServiceSource.includes('shellExport("PORT_MANAGER_NETWORK_NAME", networkName)'), true);
  assert.equal(networkServiceSource.includes("NETWORK_DNS_ALIAS_ENV"), true);
  assert.equal(networkServiceSource.includes("normalizeBrowserDnsHostname(networkName)"), true);
  assert.equal(networkServiceSource.includes("buildTerminalTitleShell(buildPortManagerTerminalTitle(networkName))"), true);
  assert.equal(daemonReadyGuardIndex >= 0, true);
  assert.equal(shimReadyCheckIndex > daemonReadyGuardIndex, true);
  assert.equal(shimReadyGuardIndex > shimReadyCheckIndex, true);
  assert.equal(titleWriteIndex > daemonReadyGuardIndex, true);
  assert.equal(markerWriteIndex > daemonReadyGuardIndex, true);
  assert.equal(titleWriteIndex > shimReadyGuardIndex, true);
  assert.equal(markerWriteIndex > shimReadyGuardIndex, true);
  assert.equal(networkServiceSource.includes("TERMINAL_RUNTIME_SHIM_READY_CHECK_NAMES"), true);
  assert.equal(networkServiceSource.includes("Port Manager routing unavailable: runtime shim check failed."), true);
  assert.equal(networkServiceSource.includes('buildTerminalTitleShell("Port Manager: detached")'), true);
  assert.equal(terminalHookEnvironmentSource.includes("readonly networkName?: string;"), true);
  assert.equal(terminalHookEnvironmentSource.includes("readonly networkDnsAlias?: string;"), true);
  assert.equal(terminalHookEnvironmentSource.includes('collection.replace("PORT_MANAGER_NETWORK_NAME", scope.networkName'), true);
  assert.equal(terminalHookEnvironmentSource.includes("collection.replace(NETWORK_DNS_ALIAS_ENV, networkDnsAlias"), true);
  assert.equal(commandSource.includes("readonly terminalNetworkSelectionFilePath: string;"), true);
  assert.equal(commandSource.includes('export PORT_MANAGER_NETWORKS_FILE="'), true);
  assert.equal(commandSource.includes("__pm_networks_file_path()"), true);
  assert.equal(commandSource.includes('export PORT_MANAGER_NETWORKS_FILE="$__pm_candidate"'), true);
  assert.equal(
    commandSource.includes(
      '$HOME/Library/Application Support/Code/User/globalStorage/newdlops.portmanager/terminal-networks.tsv',
    ),
    true,
  );
  assert.equal(
    commandSource.includes('$HOME/.config/Code/User/globalStorage/newdlops.portmanager/terminal-networks.tsv'),
    true,
  );
  assert.equal(commandSource.includes('__pm_networks_file="$(__pm_networks_file_path 2>/dev/null || true)"'), true);
  assert.equal(commandSource.includes("Port Manager has no exported networks in %s."), true);
  assert.equal(commandSource.includes("PORT_MANAGER_NETWORK_NAME"), true);
  assert.equal(commandSource.includes("PORT_MANAGER_NETWORK_DNS_ALIAS"), true);
  assert.equal(commandSource.includes("Port Manager: \\${PORT_MANAGER_NETWORK_NAME}"), true);
  assert.equal(commandSource.includes("pm() {"), true);
  assert.equal(commandSource.includes('"pm current"'), true);
  assert.equal(commandSource.includes('"pm version"'), true);
  assert.equal(commandSource.includes('"pm clean"'), true);
  assert.equal(commandSource.includes('= "current"'), true);
  assert.equal(commandSource.includes('= "status"'), true);
  assert.equal(commandSource.includes('__pm_agent_version()'), true);
  assert.equal(commandSource.includes("__pm_worker_env_check()"), true);
  assert.equal(commandSource.includes("__pm_worker_env_clean()"), true);
  assert.equal(commandSource.includes("PORT_MANAGER_EXPECTED_VERSION"), true);
  assert.equal(commandSource.includes('method:"daemonStatus"'), true);
  assert.equal(commandSource.includes("Worker env check:"), true);
  assert.equal(commandSource.includes("Worker clean:"), true);
  assert.equal(commandSource.includes("PORT_MANAGER_WORKER_ENV_SCAN=1"), true);
  assert.equal(commandSource.includes("process.kill(Number(item.pid),signal)"), true);
  assert.equal(commandSource.includes("clean SIGTERM"), true);
  assert.equal(commandSource.includes("stale-version"), true);
  assert.equal(commandSource.includes("Port Manager shell network: none"), true);
  assert.equal(commandSource.includes('__pm_current_id="\\${PORT_MANAGER_NETWORK_ID:-}"'), true);
  assert.equal(commandSource.includes("Select Port Manager network:"), true);
  assert.equal(commandSource.includes("const networkPrintScript = ["), true);
  assert.equal(commandSource.includes("summary.split(/\\\\s+\\\\|\\\\|\\\\s+/)"), true);
  assert.equal(commandSource.includes('console.error("     "+entry.trim())'), true);
  assert.equal(commandSource.includes('summary = (NF >= 4 && $4 != "" ? " - " $4 : " - no services")'), false);
  assert.equal(commandSource.includes('. \"$__pm_attach_script\"'), true);
  assert.equal(
    networkServiceSource.includes(
      'if [ "\\${PORT_MANAGER_HOOK_DAEMON_STARTED:-0}" != "1" ]; then return 1 2>/dev/null || exit 1; fi',
    ),
    true,
  );
  assert.equal(commandSource.includes("__pm_routing_ready()"), true);
  assert.equal(commandSource.includes("if __pm_agent_required && [ \"\\${PORT_MANAGER_HOOK_DAEMON_STARTED:-0}\" != \"1\" ]; then"), true);
  assert.equal(commandSource.includes("Port Manager attach did not activate routing"), true);
});

test("external pm shell function exposes doctor routes and detach diagnostics", () => {
  const commandSourcePath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const commandSource = fs.readFileSync(commandSourcePath, "utf8");

  assert.equal(commandSource.includes("routeCountScript"), true);
  assert.equal(commandSource.includes("routePrintScript"), true);
  assert.equal(commandSource.includes("agentVersionScript"), true);
  assert.equal(commandSource.includes("workerEnvScript"), true);
  assert.equal(commandSource.includes('if [ "\\${1:-}" = "version" ]'), true);
  assert.equal(commandSource.includes('if [ "\\${1:-}" = "status" ]; then'), true);
  assert.equal(commandSource.includes('"doctor"'), true);
  assert.equal(commandSource.includes('"routes"'), true);
  assert.equal(commandSource.includes('"repair"'), true);
  assert.equal(commandSource.includes('"clean"'), true);
  assert.equal(commandSource.includes('"detach"'), true);
  assert.equal(commandSource.includes("Daemon readiness flag:"), true);
  assert.equal(commandSource.includes("Runtime shim readiness flag:"), true);
  assert.equal(commandSource.includes("Runtime shim dir:"), true);
  assert.equal(commandSource.includes("Routing mode:"), true);
  assert.equal(commandSource.includes("Network loopback host:"), true);
  assert.equal(commandSource.includes("Actual loopback host:"), true);
  assert.equal(commandSource.includes("Route table:"), true);
  assert.equal(commandSource.includes("Route sources:"), true);
  assert.equal(commandSource.includes("Route warning: current network has no app/server route rows."), true);
  assert.equal(commandSource.includes("Process routing check:"), true);
  assert.equal(commandSource.includes("hook-disabled"), true);
  assert.equal(commandSource.includes("other-network"), true);
  assert.equal(commandSource.includes("manage\\\\.py\\\\s+runserver"), true);
  assert.equal(commandSource.includes("uvicorn|gunicorn|daphne|celery|webpack-dev-server"), true);
  assert.equal(commandSource.includes("PORT_MANAGER_NETWORK_LOOPBACK_HOST"), true);
  assert.equal(commandSource.includes("PORT_MANAGER_ACTUAL_LOOPBACK_HOST"), true);
  assert.equal(commandSource.includes("Network selection file:"), true);
  assert.equal(commandSource.includes("Host access:"), true);
  assert.equal(commandSource.includes("Port Manager routes:"), true);
  assert.equal(commandSource.includes("Port Manager repair complete"), true);
  assert.equal(
    commandSource.includes("Port Manager repair cannot reapply routing because this shell is not attached to a network."),
    true,
  );
  assert.equal(commandSource.includes("Port Manager repair did not activate routing"), true);
  assert.equal(commandSource.includes("__pm_repair()"), true);
  assert.equal(commandSource.includes("__pm_current_network_id()"), true);
  assert.equal(commandSource.includes("__pm_routing_ready()"), true);
  assert.equal(commandSource.includes("__pm_agent_ensure()"), true);
  assert.equal(commandSource.includes("__pm_load_native_hook()"), true);
  assert.equal(commandSource.includes("__pm_runtime_shim_check()"), true);
  assert.equal(commandSource.includes("PORT_MANAGER_RUNTIME_SHIM_READY"), true);
  assert.equal(commandSource.includes("Port Manager: detached"), true);
  assert.equal(commandSource.includes('rm -f "$PORT_MANAGER_TERMINAL_ATTACHMENT_DIR/$__pm_marker_key.tsv"'), true);
  assert.equal(commandSource.includes("Port Manager routing detached from this shell."), true);
  assert.equal(commandSource.includes("shellPrependPathListEntry"), true);
  assert.equal(commandSource.includes("shellRemovePathListEntry"), true);
});

test("extension auto-refreshes shell hook assets without auto-mutating profiles", () => {
  const activatePath = path.resolve(__dirname, "../../../src/extension/activate.ts");
  const commandSourcePath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const activateSource = fs.readFileSync(activatePath, "utf8");
  const commandSource = fs.readFileSync(commandSourcePath, "utf8");
  const ensureStart = commandSource.indexOf("async ensureShellHookAssets");
  const installStart = commandSource.indexOf("private async installShellHook", ensureStart);
  const ensureBody = commandSource.slice(ensureStart, installStart);
  const installEnd = commandSource.indexOf("private async writeShellHookAssets", installStart);
  const installBody = commandSource.slice(installStart, installEnd);

  assert.equal(activateSource.includes("void commandController.ensureShellHookAssets(context).catch(() => undefined);"), true);
  assert.equal(commandSource.includes("private async writeShellHookAssets"), true);
  assert.equal(ensureBody.includes("await this.writeShellHookAssets(context);"), true);
  assert.equal(ensureBody.includes("appendLineOnce"), false);
  assert.equal(installBody.includes("appendLineOnce"), true);
});

test("agent client startup avoids blocking on full listener refresh", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/local-agent-client.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const startBody = /async start\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? "";
  const refreshBody = /private refreshInBackground\(\): void \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? "";
  const registerBody = /async registerExistingProcess\(input: RegisteredProcessInput\): Promise<ManagedProcess> \{([\s\S]*?)\n  \}/.exec(
    source,
  )?.[1] ?? "";

  assert.equal(startBody.includes("await this.ensureConnected();"), true);
  assert.equal(startBody.includes("await this.loadDaemonStatusForStartup();"), true);
  assert.equal(startBody.includes("await this.restartDaemon();"), false);
  assert.equal(startBody.includes("await this.refresh();"), false);
  assert.equal(startBody.includes("this.refreshInBackground();"), false);
  assert.equal(startBody.includes("immediate listener scan"), true);
  assert.equal(startBody.includes("the only path that may send SIGTERM during normal activation"), true);
  assert.equal(source.includes('const daemon = await this.request<AgentDaemonStatus>("daemonStatus");'), true);
  assert.equal(
    source.includes(
      "Connected daemon does not expose daemonStatus metadata; use Restart Daemon after active terminals are stable.",
    ),
    true,
  );
  assert.equal(source.includes('const snapshot = await this.request<AgentSnapshot>("refreshSnapshot");'), true);
  assert.equal(source.includes("const id = `extension-${process.pid}-${this.nextRequestId++}`;"), true);
  assert.equal(refreshBody.includes("void this.refresh().catch"), true);
  assert.equal(registerBody.includes('await this.request<ManagedProcess>("registerExistingProcess", input);'), true);
  assert.equal(registerBody.includes("this.upsertKnownProcess(process);"), true);
  assert.equal(registerBody.includes("this.refreshInBackground();"), true);
  assert.equal(registerBody.includes("await this.refresh();"), false);
  assert.equal(source.includes("function upsertLogicalRouteForProcess"), true);
  assert.equal(source.includes("isUnsupportedDaemonStatusError"), true);
});

test("agent client suppresses unchanged snapshot change events", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/local-agent-client.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const applyStart = source.indexOf("private applySnapshot(snapshot: AgentSnapshot): void");
  const applyEnd = source.indexOf("private upsertKnownProcess", applyStart);
  const applyBody = source.slice(applyStart, applyEnd);
  const signatureStart = source.indexOf("function buildClientSnapshotSignature");
  const signatureEnd = source.indexOf("function upsertManagedProcess", signatureStart);
  const signatureBody = source.slice(signatureStart, signatureEnd);

  assert.equal(source.includes("private snapshotSignature = buildClientSnapshotSignature(this.snapshot);"), true);
  assert.equal(applyBody.includes("const nextSignature = buildClientSnapshotSignature(nextSnapshot);"), true);
  assert.equal(applyBody.includes("if (nextSignature === this.snapshotSignature)"), true);
  assert.equal(applyBody.includes("this.snapshot = nextSnapshot;"), true);
  assert.equal(applyBody.includes("this.snapshotSignature = nextSignature;"), true);
  assert.equal(signatureBody.includes("daemon.updatedAt"), false);
  assert.equal(signatureBody.includes("snapshot.updatedAt"), false);
  assert.equal(signatureBody.includes("function buildClientRouteSignatureRows"), true);
});

test("agent compatibility rejects daemons with stale route table storage", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/local-agent-client.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compatibilityStart = source.indexOf("function annotateDaemonCompatibility");
  const compatibilityEnd = source.indexOf("function normalizeAgentMainPath", compatibilityStart);
  const compatibilityBody = source.slice(compatibilityStart, compatibilityEnd);

  assert.notEqual(compatibilityStart, -1);
  assert.equal(compatibilityBody.includes("getDefaultRouteTablePath()"), true);
  assert.equal(compatibilityBody.includes("routeTablePathMismatch"), true);
  assert.equal(compatibilityBody.includes("missingVersionMetadata"), true);
  assert.equal(compatibilityBody.includes("versionMismatch"), true);
  assert.equal(compatibilityBody.includes("routeTablePathMismatch"), true);
  assert.equal(compatibilityBody.includes("olderThanCurrentBuild"), true);
});

test("network removal restores compose attachments before deleting the network", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const removeNetworkBody = /async removeNetwork\(networkId: string\): Promise<LogicalNetwork \| undefined> \{([\s\S]*?)\n  \}/.exec(
    source,
  )?.[1] ?? "";

  assert.equal(removeNetworkBody.includes("await this.removeComposeAttachment(attachment.id);"), true);
  assert.equal(
    removeNetworkBody.includes("for (const port of attachment.ports)"),
    false,
    "network removal must use the compose mutation restore path, not just delete route processes",
  );
});

test("background routing refresh polls terminals and containers", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const burstStart = source.indexOf("private async runTerminalAttachmentRefreshBurstStep");
  const burstEnd = source.indexOf("private async readTerminalAttachmentMarkerSignature", burstStart);
  const burstBody = source.slice(burstStart, burstEnd);
  const refreshStart = source.indexOf("private async refreshRoutingSignalsExclusive");
  const refreshEnd = source.indexOf("private async convergeAfterComposeAttachmentChange", refreshStart);
  const refreshBody = source.slice(refreshStart, refreshEnd);

  assert.equal(source.includes("private startRoutingSignalRefreshLoop(): void"), true);
  assert.equal(source.includes("this.refreshTerminals().catch(() => [])"), true);
  assert.equal(source.includes("private readonly terminalAttachmentComposeRefreshNetworkIds = new Set<string>();"), true);
  assert.equal(source.includes("this.terminalAttachmentComposeRefreshNetworkIds.add(networkId);"), true);
  assert.equal(burstBody.includes("const refreshNetworkIds = [...this.terminalAttachmentComposeRefreshNetworkIds];"), true);
  assert.equal(burstBody.includes("this.terminalAttachmentComposeRefreshNetworkIds.clear();"), true);
  assert.equal(burstBody.includes("if (refreshNetworkIds.length > 0) {"), true);
  assert.equal(
    burstBody.includes("networkIds: refreshNetworkIds,"),
    true,
  );
  assert.equal(
    burstBody.includes("await this.reconcileComposeAttachmentPublishedPorts({"),
    true,
  );
  assert.equal(
    burstBody.includes("await this.writeComposeProjectRoutingFile({"),
    true,
  );
  assert.equal(
    burstBody.indexOf("this.terminalAttachmentComposeRefreshNetworkIds.clear();") <
      burstBody.indexOf("await this.reconcileComposeAttachmentPublishedPorts({"),
    true,
  );
  assert.equal(
    burstBody.indexOf("await this.reconcileComposeAttachmentPublishedPorts({") <
      burstBody.indexOf("await this.writeComposeProjectRoutingFile({"),
    true,
  );
  assert.equal(
    burstBody.indexOf("await this.writeComposeProjectRoutingFile({") <
      burstBody.indexOf("await this.refreshTerminals().catch(() => []);"),
    true,
  );
  assert.equal(source.includes("this.refreshContainerServices({ background: true }).catch(() => [])"), true);
  assert.equal(source.includes("await this.reconcileComposeAttachmentPublishedPorts({ background: true }).catch(() => undefined);"), false);
  assert.equal(source.includes("await this.reconcileComposeAttachmentPublishedPorts({ background: true, force: true }).catch(() => undefined);"), true);
  assert.equal(source.includes("FORCED_COMPOSE_RECONCILE_COALESCE_MS = 750"), true);
  assert.equal(source.includes("forceComposeOverrideRefresh: true,"), true);
  assert.equal(source.includes("await this.convergeDaemonAndRoutingState();"), true);
  assert.equal(refreshBody.includes("this.syncLogicalPortRouters().catch(() => undefined),"), true);
  assert.equal(refreshBody.includes("this.syncBrowserNetworkProxies().catch(() => undefined),"), true);
  assert.equal(source.includes("ROUTING_SIGNAL_REFRESH_INTERVAL_MS = 10_000"), true);
  assert.equal(source.includes("BACKGROUND_CONTAINER_REFRESH_INTERVAL_MS = 60_000"), true);
  assert.equal(source.includes("tryAcquireSharedBackgroundContainerRefreshSlot()"), true);
});

test("compose reconcile preserves persisted routes when live runtime discovery is empty", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const reconcileStart = source.indexOf("private async reconcileComposeAttachmentPublishedPortsExclusive");
  const reconcileEnd = source.indexOf("private async refreshComposeContainerMappings", reconcileStart);
  const reconcileBody = source.slice(reconcileStart, reconcileEnd);
  const publishedPortPolicyStart = source.indexOf("function shouldRefreshComposePublishedPortsFromRuntime");
  const publishedPortPolicyEnd = source.indexOf("function shouldRefreshComposeContainerMappingsFromRuntime", publishedPortPolicyStart);
  const publishedPortPolicyBody = source.slice(publishedPortPolicyStart, publishedPortPolicyEnd);
  const mappingPolicyStart = source.indexOf("function shouldRefreshComposeContainerMappingsFromRuntime");
  const mappingPolicyEnd = source.indexOf("function composeRouteCopyFiles", mappingPolicyStart);
  const mappingPolicyBody = source.slice(mappingPolicyStart, mappingPolicyEnd);
  const mergeStart = source.indexOf("function mergeComposePortsWithLiveRoutes");
  const mergeEnd = source.indexOf("function composeAttachmentRuntimeStateChanged", mergeStart);
  const mergeBody = source.slice(mergeStart, mergeEnd);
  const replaceStart = source.indexOf("private async replaceComposeRouteProcesses");
  const replaceEnd = source.indexOf("private async ensureComposeRouteProcessesForAttachments", replaceStart);
  const replaceBody = source.slice(replaceStart, replaceEnd);
  const ensureStart = source.indexOf("private async ensureComposeRouteProcesses");
  const ensureEnd = source.indexOf("  /** Refreshes clone container id rewrites", ensureStart);
  const ensureBody = source.slice(ensureStart, ensureEnd);
  const registerIndex = replaceBody.indexOf("await this.processService.registerExistingProcess(");
  const emptyLiveIndex = replaceBody.indexOf("if (livePorts.length === 0) {");
  const emptyLiveFallbackIndex = replaceBody.indexOf(
    "return this.ensureComposeRouteProcesses(attachment, attachment.ports);",
    emptyLiveIndex,
  );
  const preserveIndex = replaceBody.indexOf("const registeredProcessIds = new Set<string>();");
  const staleRemoveIndex = replaceBody.indexOf("await this.removeComposeRouteProcesses(attachment, attachment.ports, registeredProcessIds);");

  assert.equal(reconcileBody.includes("shouldRefreshComposePublishedPortsFromRuntime(attachment, options)"), true);
  assert.equal(reconcileBody.includes("this.containerServiceDiscovery.createSession(runtimeSettings)"), true);
  assert.equal(reconcileBody.includes(".listLiveComposePublishedPorts("), true);
  assert.equal(reconcileBody.includes("this.containerServiceDiscovery.listLiveComposePublishedPorts("), false);
  assert.equal(reconcileBody.includes("reconcileComposeOverrideFileForAttachment("), true);
  assert.equal(reconcileBody.includes('if (overrideRestoredAttachment.status === "error")'), true);
  assert.equal(reconcileBody.includes("replaceComposeRouteProcesses(overrideRestoredAttachment, livePorts)"), true);
  assert.equal(reconcileBody.includes("ensureComposeRouteProcesses(overrideRestoredAttachment, overrideRestoredAttachment.ports)"), true);
  assert.equal(reconcileBody.includes("mergeComposePortsWithLiveRoutes("), true);
  assert.equal(reconcileBody.includes("shouldRefreshComposeContainerMappingsFromRuntime(attachment, options)"), true);
  assert.equal(reconcileBody.includes("refreshComposeContainerMappings(attachment, discoverySession)"), true);
  assert.equal(reconcileBody.includes(": attachment.mutation;"), true);
  assert.equal(publishedPortPolicyBody.includes("return options.force === true || options.background !== true;"), true);
  assert.equal(publishedPortPolicyBody.includes("isContainerStyleComposeAttachment"), false);
  assert.equal(mappingPolicyBody.includes("if (attachment.mutation === undefined)"), true);
  assert.equal(mappingPolicyBody.includes("return options.force === true || options.background !== true;"), true);
  assert.equal(mergeBody.includes("for (const livePort of livePorts)"), true);
  assert.equal(mergeBody.includes("mergedPorts.push(livePort)"), true);
  assert.equal(emptyLiveIndex >= 0, true);
  assert.equal(emptyLiveFallbackIndex > emptyLiveIndex, true);
  assert.equal(emptyLiveFallbackIndex < registerIndex, true);
  assert.equal(registerIndex >= 0, true);
  assert.equal(preserveIndex > registerIndex, true);
  assert.equal(staleRemoveIndex > preserveIndex, true);
  assert.equal(source.includes("private async ensureComposeRouteProcessesForAttachments"), true);
  assert.equal(source.includes("daemon restart the attachment object can be unchanged"), true);
  assert.equal(ensureBody.includes("findComposeProcessForPort(snapshotProcesses, attachment, port)"), true);
  assert.equal(ensureBody.includes("buildComposeRegisteredProcessInput(attachment, port, cwd)"), true);
  assert.equal(ensureBody.includes("await this.removeComposeRouteProcesses(attachment, attachment.ports, registeredProcessIds);"), true);
  assert.equal(replaceBody.includes("await this.removeComposeRouteProcesses(attachment, attachment.ports);\n      return [];"), false);
  assert.equal(replaceBody.includes("await this.removeComposeRouteProcesses(attachment, attachment.ports);\n    if (livePorts.length === 0)"), false);
  assert.equal(source.includes("private async restorePersistedComposeRoutesIfMissing"), false);
  assert.equal(source.includes("private async restorePersistedComposeRoutes("), false);
});

test("browser proxy target resolution uses a snapshot route index before refresh fallback", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const resolveStart = source.indexOf("private async resolveBrowserNetworkProxyTarget");
  const resolveEnd = source.indexOf("  /** Resolves the common browser proxy path", resolveStart);
  const resolveBody = source.slice(resolveStart, resolveEnd);
  const indexStart = source.indexOf("private findBrowserProxyRouteTarget");
  const indexEnd = source.indexOf("  /**\n   * Package managers sometimes launch dev servers", indexStart);
  const indexBody = source.slice(indexStart, indexEnd);

  assert.notEqual(resolveStart, -1);
  assert.notEqual(indexStart, -1);
  assert.equal(source.includes("private browserProxyRouteTargetSnapshot: AgentSnapshot | undefined;"), true);
  assert.equal(source.includes("private browserProxyRouteTargetByEndpointId = new Map<string, BrowserNetworkProxyTarget>();"), true);
  assert.equal(source.includes("private browserProxyGeneratedRouteTargetByEndpointId = new Map<string, BrowserNetworkProxyTarget>();"), true);
  assert.equal(source.includes("private async readGeneratedRouteTableRoutesForNetworks"), true);
  assert.equal(source.includes("collectBrowserProxyRouteEndpoints(routes, networks, dnsRunning, routeHintTextByEndpointId, processEndpoints)"), true);
  assert.equal(source.includes("mergeLogicalPortRoutes("), true);
  assert.equal(
    resolveBody.indexOf("const indexedTarget = this.findBrowserProxyRouteTarget(endpoint.networkId, endpoint.logicalPort);") <
      resolveBody.indexOf("const route = await this.findNetworkRoute(endpoint.networkId, endpoint.logicalPort);"),
    true,
  );
  assert.equal(resolveBody.includes("await this.findBrowserProxyFallbackListenerTarget(endpoint.networkId, endpoint.logicalPort)"), true);
  assert.equal(indexBody.includes("snapshot !== this.browserProxyRouteTargetSnapshot"), true);
  assert.equal(indexBody.includes("buildBrowserProxyRouteTargetIndex(snapshot.routes, snapshot.processes)"), true);
  assert.equal(indexBody.includes("this.browserProxyGeneratedRouteTargetByEndpointId.get(endpointId)"), true);
  assert.equal(source.includes("function buildBrowserProxyRouteTargetIndex("), true);
  assert.equal(source.includes("browserProxyTargetProtocolFromUrl"), true);
  assert.equal(source.includes('new URL(url).protocol === "https:" ? "https" : undefined'), true);
});

test("terminal daemon ensure serializes agent startup and preserves slow live sockets", () => {
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const networkSource = fs.readFileSync(networkServicePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");

  for (const source of [networkSource, commandsSource]) {
    assert.equal(source.includes('__pm_agent_lock="\\${PORT_MANAGER_AGENT_SOCKET}.startup.lock"'), true);
    assert.equal(source.includes('if mkdir "$__pm_agent_lock" 2>/dev/null; then'), true);
    assert.equal(source.includes('method:"daemonStatus"'), true);
    assert.equal(source.includes("probe-shutdown"), false);
    assert.equal(source.includes("function shutdownStale"), false);
    assert.equal(source.includes('const staleLockScript = ['), true);
    assert.equal(source.includes("age>15000?0:1"), true);
    assert.equal(source.includes('timer=setTimeout(()=>finish(1,false),350);'), true);
    assert.equal(source.includes('socket.once("error",()=>finish(1,false));'), true);
    assert.equal(
      source.includes('if [ -S "$PORT_MANAGER_AGENT_SOCKET" ]; then'),
      true,
      "daemon ensure should skip expensive Node probes when no socket exists yet",
    );
    assert.equal(source.includes('rm -f "$PORT_MANAGER_AGENT_SOCKET" 2>/dev/null || true'), true);
    assert.equal(source.includes('rmdir "$__pm_agent_lock" 2>/dev/null || true'), true);
    assert.equal(source.includes("while [ $__pm_agent_wait_count -lt 20 ]; do"), true);
    assert.equal(source.includes("daemonUnsetVariables"), true);
    assert.equal(source.includes('"BASH_ENV"'), true);
    assert.equal(source.includes('"PORT_MANAGER_ROUTE_TABLE_NETWORK_ID"'), true);
    assert.equal(source.includes('"PORT_MANAGER_ROUTES_FILE"'), true);
    assert.equal(source.includes('"PORT_MANAGER_TERMINAL_ATTACHMENT_DIR"'), true);
    assert.equal(source.includes("command -v setsid >/dev/null 2>&1"), true);
    assert.equal(source.includes("</dev/null >/tmp/newdlops-portmanager-agent.log 2>&1 &"), true);
  }
  assert.equal(commandsSource.includes("__pm_agent_required()"), true);
  assert.equal(commandsSource.includes('if __pm_agent_required; then\n    __pm_agent_ensure'), true);
  assert.equal(commandsSource.includes('__pm_repair\n    return $?'), true);
});

test("background routing refresh converges daemon version and generated route files", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const agentClientPath = path.resolve(__dirname, "../../../src/extension/local-agent-client.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const agentClientSource = fs.readFileSync(agentClientPath, "utf8");
  const convergeStart = source.indexOf("private async convergeDaemonAndRoutingStateExclusive");
  const convergeEnd = source.indexOf("private async ensureCurrentProcessDaemon", convergeStart);
  const convergeBody = source.slice(convergeStart, convergeEnd);
  const ensureStart = source.indexOf("private async ensureCurrentProcessDaemon");
  const ensureEnd = source.indexOf("private watchTerminalAttachmentMarkers", ensureStart);
  const ensureBody = source.slice(ensureStart, ensureEnd);

  assert.equal(source.includes("DAEMON_RESTART_BACKOFF_MS = 30_000"), true);
  assert.equal(convergeBody.includes("this.ensureSharedNetworkStateFileMaterialized();"), true);
  assert.equal(convergeBody.includes("await this.ensureCurrentProcessDaemon().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.writeHostAccessBindingsFile().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.writeComposeProjectRoutingFile().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("restorePersistedComposeRoutesIfMissing"), false);
  assert.equal(convergeBody.includes("not force an additional full listener scan every minute"), true);
  assert.equal(convergeBody.includes("await this.ensureDaemonRouteTablesMaterialized().catch(() => undefined);"), true);
  assert.equal(
    convergeBody.includes("await this.rehydrateBrowserDnsAndProxies().catch(() => undefined);"),
    true,
  );
  assert.equal(convergeBody.includes("await this.processService.refresh().catch(() => undefined);"), false);
  assert.equal(convergeBody.includes("await this.syncLogicalPortRouters().catch(() => undefined);"), true);
  assert.equal(ensureBody.includes('daemon.status !== "running"'), true);
  assert.equal(ensureBody.includes("usesLoopbackAddressOnlyRouting(readPortManagerSettings())"), true);
  assert.equal(ensureBody.includes("await this.processService.start();"), true);
  assert.equal(ensureBody.includes("daemon.restartRequired"), true);
  assert.equal(ensureBody.includes("await this.processService.restartDaemon();"), true);
  assert.equal(agentClientSource.includes("const previousPid = this.snapshot.daemon.pid;"), true);
  assert.equal(agentClientSource.includes("await this.waitForPreviousDaemonExit(previousPid);"), true);
  assert.equal(agentClientSource.includes("await this.terminateSiblingAgentProcesses(new Set([previousPid]));"), true);
  assert.equal(agentClientSource.includes("this.terminateSiblingAgentProcessesSync(new Set());"), true);
  assert.equal(agentClientSource.includes("function findSiblingAgentProcessIds("), true);
  assert.equal(agentClientSource.includes("function isPortManagerAgentCommandForSocket("), true);
  assert.equal(agentClientSource.includes('execFileSync("ps", ["-Ao", "pid=,command="]'), true);
  assert.equal(agentClientSource.includes('!command.includes(socketPath) || !command.includes("--socket")'), true);
  assert.equal(agentClientSource.includes('/(?:^|[/\\s])portmanager_agent(?:\\s|$)/.test(command)'), true);
  assert.equal(agentClientSource.includes('/\\bagent-main\\.js\\b/.test(command)'), true);
  assert.equal(agentClientSource.includes('process.kill(pid, "SIGTERM");'), true);
  assert.equal(agentClientSource.includes('process.kill(pid, "SIGKILL");'), false);
  assert.equal(agentClientSource.includes("function isProcessAlive(pid: number): boolean"), true);
});

test("global storage cleanup rehydrates generated routing from live attachment state", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const rehydrateStart = source.indexOf("private async rehydrateRoutingFiles");
  const rehydrateEnd = source.indexOf("private async collectMatchingFiles", rehydrateStart);
  const rehydrateBody = source.slice(rehydrateStart, rehydrateEnd);
  const terminalRehydrateStart = source.indexOf("private async rehydrateTerminalHookFiles");
  const terminalRehydrateEnd = source.indexOf("private async collectMatchingFiles", terminalRehydrateStart);
  const terminalRehydrateBody = source.slice(terminalRehydrateStart, terminalRehydrateEnd);
  const materializeStart = source.indexOf("private async ensureDaemonRouteTablesMaterialized");
  const materializeEnd = source.indexOf("private async reapplyRoutingToAttachedTerminalWindows", materializeStart);
  const materializeBody = source.slice(materializeStart, materializeEnd);
  const reapplyStart = source.indexOf("private async reapplyRoutingToAttachedTerminalWindows");
  const reapplyEnd = source.indexOf("private watchTerminalAttachmentMarkers", reapplyStart);
  const reapplyBody = source.slice(reapplyStart, reapplyEnd);
  const reconcileStart = source.indexOf("private async reconcileComposeOverrideFileForAttachment");
  const reconcileEnd = source.indexOf("private async reconcileMutationlessComposeOverrideFile", reconcileStart);
  const reconcileBody = source.slice(reconcileStart, reconcileEnd);

  assert.notEqual(rehydrateStart, -1);
  assert.notEqual(terminalRehydrateStart, -1);
  assert.notEqual(materializeStart, -1);
  assert.notEqual(reapplyStart, -1);
  assert.notEqual(reconcileStart, -1);
  assert.equal(rehydrateBody.includes("this.ensureSharedNetworkStateFileMaterialized();"), true);
  assert.equal(rehydrateBody.includes("await this.rehydrateTerminalHookFiles().catch(() => undefined);"), true);
  assert.equal(
    rehydrateBody.indexOf("await this.rehydrateTerminalHookFiles().catch(() => undefined);") <
      rehydrateBody.indexOf("const restoredComposeOverrideCount = await this.reconcileComposeOverrideFiles"),
    true,
  );
  assert.equal(
    rehydrateBody.indexOf("await this.reconcileComposeAttachmentPublishedPorts({ force: true }).catch(() => undefined);") <
      rehydrateBody.indexOf("await this.ensureDaemonRouteTablesMaterialized({"),
    true,
  );
  assert.equal(
    rehydrateBody.indexOf("await this.ensureDaemonRouteTablesMaterialized({") <
      rehydrateBody.indexOf(
        "await this.writeComposeProjectRoutingFile({ forceComposeOverrideRefresh: true }).catch(() => undefined);",
      ),
    true,
  );
  assert.equal(
    rehydrateBody.indexOf("await this.writeTerminalNetworkSelectionFile().catch(() => undefined);") <
      rehydrateBody.indexOf("await this.rehydrateBrowserDnsAndProxies().catch(() => undefined);"),
    true,
  );
  assert.equal(source.includes("private async rehydrateBrowserDnsAndProxies(): Promise<void>"), true);
  assert.equal(source.includes("await this.startBrowserDnsServer().catch(() => undefined);"), true);
  assert.equal(source.includes("this.syncBrowserDnsRecords();"), true);
  assert.equal(source.includes("this.maybeAutoInstallBrowserDnsResolvers();"), true);
  assert.equal(source.includes("await this.syncBrowserNetworkProxies().catch(() => undefined);"), true);
  assert.equal(rehydrateBody.includes("await this.refreshVscodeWindowTerminalEnvironment({ interactive: false }).catch(() => undefined);"), true);
  assert.equal(source.includes("private shouldPreserveComposeHiddenPublishedHostPorts(): boolean"), true);
  assert.equal(
    source.includes('return resolveTerminalLoopbackAddressRoutingMode(readPortManagerSettings()) !== "high-port";'),
    true,
  );
  assert.equal(reconcileBody.includes("preservePublishedHostPorts:"), true);
  assert.equal(reconcileBody.includes("this.shouldPreserveComposeHiddenPublishedHostPorts()"), true);
  assert.equal(terminalRehydrateBody.includes("await this.writeTerminalNetworkSelectionFile();"), true);
  assert.equal(terminalRehydrateBody.includes("await this.refreshVscodeWindowTerminalEnvironment({ interactive: false });"), true);
  assert.equal(terminalRehydrateBody.includes("await this.reapplyRoutingToAttachedTerminalWindows();"), true);
  assert.equal(materializeBody.includes("getDefaultRouteTablePath()"), false);
  assert.equal(materializeBody.includes("getRouteTablePathForNetwork(networkId)"), true);
  assert.equal(materializeBody.includes("this.registry.getSnapshot().networks.map((network) => network.id)"), true);
  assert.equal(
    materializeBody.includes("Promise.all(routeTablePaths.map((routeTablePath) => routeTableFileIsFresh(routeTablePath, routeTableTtlMs)))"),
    true,
  );
  assert.equal(source.includes("async function routeTableFileIsFresh"), true);
  assert.equal(materializeBody.includes("usesLoopbackAddressOnlyRouting(readPortManagerSettings())"), true);
  assert.equal(materializeBody.includes("await this.processService.start();"), true);
  assert.equal(materializeBody.includes("await this.processService.refresh();"), true);
  assert.equal(source.includes("missing marker"), true);
  assert.equal(reapplyBody.includes('network?.runtimeKind !== "nativeHelper"'), true);
  assert.equal(reapplyBody.includes("this.injectRoutingIntoTerminalWindow("), true);
  assert.equal(reapplyBody.includes("await this.refreshTerminals()"), false);
});

test("logical port routers use a single cross-window owner lease", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const syncStart = source.indexOf("private async syncLogicalPortRouters(): Promise<void>");
  const syncEnd = source.indexOf("private async findClientNetworkForRouter", syncStart);
  const syncBody = source.slice(syncStart, syncEnd);
  const browserSyncStart = source.indexOf("private async syncBrowserNetworkProxiesExclusive(): Promise<void>");
  const browserSyncEnd = source.indexOf("private async readBrowserProxyProcessCommandTexts", browserSyncStart);
  const browserSyncBody = source.slice(browserSyncStart, browserSyncEnd);
  const browserCommandCacheStart = source.indexOf("private async readBrowserProxyProcessCommandTexts");
  const browserCommandCacheEnd = source.indexOf("private pruneBrowserProxyProcessCommandTextCache", browserCommandCacheStart);
  const browserCommandCacheBody = source.slice(browserCommandCacheStart, browserCommandCacheEnd);
  const ownerWatchStart = source.indexOf("private watchOwnerLeaseFiles(): DisposableLike");
  const ownerWatchEnd = source.indexOf("private refreshOwnerLeaseFromFileSignal", ownerWatchStart);
  const ownerWatchBody = source.slice(ownerWatchStart, ownerWatchEnd);
  const ownerSignalStart = source.indexOf("private refreshOwnerLeaseFromFileSignal");
  const ownerSignalEnd = source.indexOf("private startTerminalAttachmentMarkerPolling", ownerSignalStart);
  const ownerSignalBody = source.slice(ownerSignalStart, ownerSignalEnd);

  assert.equal(source.includes("Owner lease must outlive the routing refresh interval"), true);
  assert.equal(source.includes("LOGICAL_ROUTER_OWNER_LEASE_MS = 120_000"), true);
  assert.equal(source.includes("LOGICAL_ROUTER_OWNER_LOCK_STALE_MS = 30_000"), true);
  assert.equal(source.includes("OWNER_LEASE_HANDOFF_RETRY_DELAY_MS = 1_000"), true);
  assert.equal(source.includes('function buildLogicalRouterOwnerControlPath(kind: "owner" | "lock"): string'), true);
  assert.equal(source.includes("function tryAcquireLogicalRouterOwnerLease(): boolean"), true);
  assert.equal(source.includes("function isActiveLogicalRouterOwner"), true);
  assert.equal(source.includes("return isProcessAlive(owner.pid);"), true);
  assert.equal(source.includes("private ownsLogicalRouterLease = false;"), true);
  assert.notEqual(ownerWatchStart, -1);
  assert.equal(source.includes("this.watchOwnerLeaseFiles()"), true);
  assert.equal(ownerWatchBody.includes("LOGICAL_ROUTER_OWNER_PATH"), true);
  assert.equal(ownerWatchBody.includes("BROWSER_NETWORK_PROXY_OWNER_PATH"), true);
  assert.equal(ownerWatchBody.includes("syncFs.watch(directoryPath"), true);
  assert.equal(ownerSignalBody.includes("!this.ownsLogicalRouterLease"), true);
  assert.equal(ownerSignalBody.includes("!isActiveLogicalRouterOwner(readLogicalRouterOwner(), Date.now())"), true);
  assert.equal(ownerSignalBody.includes("void this.syncLogicalPortRouters();"), true);
  assert.equal(ownerSignalBody.includes("this.scheduleOwnerLeaseHandoffRetry(shouldRefreshLogical, shouldRefreshBrowser);"), true);
  assert.equal(ownerSignalBody.includes("private scheduleOwnerLeaseHandoffRetry"), true);
  assert.equal(ownerSignalBody.includes("setTimeout(() =>"), true);
  assert.equal(syncBody.includes("this.logicalRouterSyncInFlight !== undefined"), true);
  assert.equal(syncBody.includes("this.logicalRouterSyncQueued = true;"), true);
  assert.equal(syncBody.includes("if (!tryAcquireLogicalRouterOwnerLease())"), true);
  assert.equal(syncBody.includes("if (this.ownsLogicalRouterLease)"), true);
  assert.equal(syncBody.includes("this.ownsLogicalRouterLease = false;"), true);
  assert.equal(syncBody.includes("this.ownsLogicalRouterLease = true;"), true);
  assert.equal(syncBody.includes("await this.logicalPortRouter.sync(logicalPorts).catch(() => undefined);"), true);
  assert.equal(source.includes("releaseLogicalRouterOwnerLease();"), true);
  assert.equal(source.includes("BROWSER_NETWORK_PROXY_OWNER_LEASE_MS = 120_000"), true);
  assert.equal(source.includes('function buildBrowserNetworkProxyOwnerControlPath(kind: "owner" | "lock"): string'), true);
  assert.equal(source.includes("function tryAcquireBrowserNetworkProxyOwnerLease(): boolean"), true);
  assert.equal(source.includes("private ownsBrowserNetworkProxyLease = false;"), true);
  assert.equal(ownerSignalBody.includes("!this.ownsBrowserNetworkProxyLease"), true);
  assert.equal(ownerSignalBody.includes("!isActiveBrowserNetworkProxyOwner(readBrowserNetworkProxyOwner(), Date.now())"), true);
  assert.equal(ownerSignalBody.includes("this.browserNetworkProxy.retryFailedEndpointsNow();"), true);
  assert.equal(ownerSignalBody.includes("void this.syncBrowserNetworkProxies();"), true);
  assert.equal(browserSyncBody.includes("if (!tryAcquireBrowserNetworkProxyOwnerLease())"), true);
  assert.equal(browserSyncBody.includes("if (this.ownsBrowserNetworkProxyLease)"), true);
  assert.equal(browserSyncBody.includes("this.ownsBrowserNetworkProxyLease = false;"), true);
  assert.equal(browserSyncBody.includes("this.ownsBrowserNetworkProxyLease = true;"), true);
  assert.equal(browserSyncBody.includes("await this.browserNetworkProxy.sync(endpoints).catch(() => undefined);"), true);
  assert.equal(source.includes("BROWSER_PROXY_COMMAND_TEXT_CACHE_TTL_MS = 600_000"), true);
  assert.equal(source.includes("BROWSER_PROXY_COMMAND_TEXT_MISS_CACHE_TTL_MS = 15_000"), true);
  assert.equal(source.includes("browserProxyProcessCommandTextCache"), true);
  assert.equal(source.includes("pruneBrowserProxyProcessCommandTextCache"), true);
  assert.equal(
    browserCommandCacheBody.indexOf("this.browserProxyProcessCommandTextCache.get(process.pid)") <
      browserCommandCacheBody.indexOf("this.processEnvironmentProvider.readProcessCommand(process.pid)"),
    true,
    "browser proxy command classification must reuse burst-local process command reads before polling the OS again",
  );
  assert.match(
    browserCommandCacheBody,
    /command === undefined \? BROWSER_PROXY_COMMAND_TEXT_MISS_CACHE_TTL_MS : BROWSER_PROXY_COMMAND_TEXT_CACHE_TTL_MS/,
  );
  assert.equal(source.includes("releaseBrowserNetworkProxyOwnerLease();"), true);
});

test("automatic control plane side effects use a single cross-window owner lease", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const startStart = source.indexOf("async start(): Promise<void>");
  const startEnd = source.indexOf("  /** Attempts to become the single automatic control-plane owner", startStart);
  const startBody = source.slice(startStart, startEnd);
  const ownerServicesStart = source.indexOf("private async startControlPlaneOwnerServices(): Promise<void>");
  const ownerServicesEnd = source.indexOf("  /** Runs registry side effects only", ownerServicesStart);
  const ownerServicesBody = source.slice(ownerServicesStart, ownerServicesEnd);
  const ownerWatcherStart = source.indexOf("private async startControlPlaneOwnerWatchers(): Promise<void>");
  const ownerWatcherEnd = source.indexOf("  /** Runs startup convergence only", ownerWatcherStart);
  const ownerWatcherBody = source.slice(ownerWatcherStart, ownerWatcherEnd);
  const registrySideEffectStart = source.indexOf("private async runControlPlaneRegistrySideEffects(): Promise<void>");
  const registrySideEffectEnd = source.indexOf("  /** Stops owner-only watchers", registrySideEffectStart);
  const registrySideEffectBody = source.slice(registrySideEffectStart, registrySideEffectEnd);
  const demoteStart = source.indexOf("private demoteControlPlaneOwner(): void");
  const demoteEnd = source.indexOf("  /** Returns the latest logical network snapshot", demoteStart);
  const demoteBody = source.slice(demoteStart, demoteEnd);
  const applyStart = source.indexOf("private applyVscodeWindowTerminalEnvironment(): void");
  const applyEnd = source.indexOf("  /**\n   * Prepares the loopback host", applyStart);
  const applyBody = source.slice(applyStart, applyEnd);
  const windowAttachStart = source.indexOf("async attachVscodeWindowTerminalsToNetwork(networkId: string)");
  const windowAttachEnd = source.indexOf("  /** Clears the current VS Code window", windowAttachStart);
  const windowAttachBody = source.slice(windowAttachStart, windowAttachEnd);
  const windowDetachStart = source.indexOf("async detachVscodeWindowTerminalsFromNetwork()");
  const windowDetachEnd = source.indexOf("  /** Returns true when", windowDetachStart);
  const windowDetachBody = source.slice(windowDetachStart, windowDetachEnd);
  const vscodeProcessSyncStart = source.indexOf("private syncVscodeWindowProcessAttachment(): void");
  const vscodeProcessSyncEnd = source.indexOf("  /**\n   * Injects routing variables", vscodeProcessSyncStart);
  const vscodeProcessSyncBody = source.slice(vscodeProcessSyncStart, vscodeProcessSyncEnd);
  const refreshRuntimeStart = source.indexOf("private async refreshRuntimeDescriptors(");
  const refreshRuntimeEnd = source.indexOf("  /** Looks up the latest route", refreshRuntimeStart);
  const refreshRuntimeBody = source.slice(refreshRuntimeStart, refreshRuntimeEnd);
  const refreshContainerStart = source.indexOf("async refreshContainerServices(");
  const refreshContainerEnd = source.indexOf("  /** Forces generated network routing artifacts", refreshContainerStart);
  const refreshContainerBody = source.slice(refreshContainerStart, refreshContainerEnd);
  const reconcileComposeStart = source.indexOf("private async reconcileComposeAttachmentPublishedPorts(");
  const reconcileComposeEnd = source.indexOf("private async reconcileComposeAttachmentPublishedPortsSerially", reconcileComposeStart);
  const reconcileComposeBody = source.slice(reconcileComposeStart, reconcileComposeEnd);
  const ownerSignalStart = source.indexOf("private refreshOwnerLeaseFromFileSignal");
  const ownerSignalEnd = source.indexOf("private startTerminalAttachmentMarkerPolling", ownerSignalStart);
  const ownerSignalBody = source.slice(ownerSignalStart, ownerSignalEnd);
  const routingConvergeIndex = ownerServicesBody.indexOf("await this.convergeDaemonAndRoutingState();");
  const deferredProbeIndex = ownerServicesBody.indexOf("this.scheduleDeferredOwnerStartupProbes();");
  const terminalEnvironmentRefreshIndex = ownerServicesBody.indexOf(
    "await this.refreshVscodeWindowTerminalEnvironment({ interactive: false });",
  );
  const persistedExposureIndex = ownerServicesBody.indexOf("await this.reopenPersistedExposures();");
  const composeRepairIndex = ownerServicesBody.indexOf(
    "await this.repairPersistedPortManagerCloneComposeAttachments();",
  );
  const composePublishedPortsIndex = ownerServicesBody.indexOf(
    "await this.reconcileComposeAttachmentPublishedPorts({ force: true });",
  );
  const routingSignalIndex = ownerServicesBody.indexOf("this.startRoutingSignalRefreshLoop();");
  const markerPollingIndex = ownerServicesBody.indexOf("this.startTerminalAttachmentMarkerPolling();");

  assert.equal(source.includes("CONTROL_PLANE_OWNER_LEASE_MS = 120_000"), true);
  assert.equal(source.includes("CONTROL_PLANE_OWNER_LOCK_STALE_MS = 30_000"), true);
  assert.equal(source.includes('function buildControlPlaneOwnerControlPath(kind: "owner" | "lock"): string'), true);
  assert.equal(source.includes("CONTROL_PLANE_OWNER_UI_REQUEST_PATH"), false);
  assert.equal(source.includes("OWNER_UI_REQUEST_POLL_INTERVAL_MS"), false);
  assert.equal(source.includes("function tryAcquireControlPlaneOwnerLease(): boolean"), true);
  assert.equal(source.includes("function isActiveControlPlaneOwner"), true);
  assert.equal(source.includes("workspaceUri: buildCurrentVsCodeProjectUri()"), true);
  assert.equal(source.includes("openControlPlaneOwnerWorkspace(controlPlane.ownerWorkspaceUri)"), true);
  assert.equal(source.includes("private ownsControlPlaneLease = false;"), true);
  assert.equal(source.includes("private readonly controlPlaneOwnerDisposables"), true);
  assert.equal(source.includes("focusControlPlaneOwnerWindow(): Promise<boolean>"), true);
  assert.equal(source.includes("private controlPlaneOwnerStartupInFlight: Promise<boolean> | undefined;"), true);
  assert.equal(source.includes("void this.runControlPlaneRegistrySideEffects();"), true);
  assert.equal(source.includes("if (this.ownsControlPlaneLease) {\n            void this.syncLogicalPortRouters();"), true);
  assert.equal(startBody.includes("this.watchOwnerLeaseFiles()"), true);
  assert.equal(startBody.includes("await this.refreshRuntimeDescriptors({ includeContainerRuntime: false });"), true);
  assert.equal(startBody.includes("await this.refreshVscodeWindowTerminalEnvironment({ interactive: false });"), true);
  assert.equal(startBody.includes("await this.startControlPlaneOwnerIfAvailable();"), true);
  assert.equal(startBody.includes("this.startRoutingSignalRefreshLoop();"), false);
  assert.equal(startBody.includes("this.startTerminalAttachmentMarkerPolling();"), false);
  assert.equal(ownerWatcherBody.includes("vscode.workspace.createFileSystemWatcher"), true);
  assert.equal(ownerWatcherBody.includes("this.watchOwnerUiFocusRequests(ownerUiRequestDirectory)"), false);
  assert.equal(ownerWatcherBody.includes("this.startOwnerUiRequestPolling();"), false);
  assert.equal(ownerWatcherBody.includes("ownerUiRequestWatcher.onDidChange"), false);
  assert.equal(ownerWatcherBody.includes("void this.openOwnerUiFromFocusRequest();"), false);
  assert.equal(ownerWatcherBody.includes("this.controlPlaneOwnerDisposables.push("), true);
  /*
   * Container-runtime probing and candidate discovery are deferred out of the
   * owner's activation chain: `scheduleDeferredOwnerStartupProbes` runs the
   * `docker info`/`container ls` work after the cold-start burst settles, and
   * initial terminal discovery goes through the background consumer gate.
   */
  assert.equal(ownerServicesBody.includes("this.scheduleDeferredOwnerStartupProbes();"), true);
  assert.equal(
    ownerServicesBody.includes("void this.refreshRuntimeDescriptors({ includeContainerRuntime: true })"),
    true,
  );
  assert.equal(ownerServicesBody.includes("void this.refreshContainerServices({ background: true }).catch(() => []);"), true);
  assert.equal(ownerServicesBody.includes("OWNER_STARTUP_CONTAINER_PROBE_DELAY_MS"), true);
  assert.equal(ownerServicesBody.includes("await this.refreshTerminals({ background: true });"), true);
  assert.equal(ownerServicesBody.includes("await this.refreshVscodeWindowTerminalEnvironment({ interactive: false });"), true);
  assert.equal(ownerServicesBody.includes("await this.convergeDaemonAndRoutingState();"), true);
  assert.equal(ownerServicesBody.includes("this.startRoutingSignalRefreshLoop();"), true);
  assert.equal(ownerServicesBody.includes("this.startTerminalAttachmentMarkerPolling();"), true);
  assert.equal(ownerServicesBody.includes("Terminal hook agent calls have a short startup budget."), true);
  assert.equal(routingConvergeIndex < deferredProbeIndex, true);
  assert.equal(routingSignalIndex < deferredProbeIndex, true);
  assert.equal(markerPollingIndex < deferredProbeIndex, true);
  assert.equal(terminalEnvironmentRefreshIndex < deferredProbeIndex, true);
  assert.equal(routingConvergeIndex < persistedExposureIndex, true);
  assert.equal(routingConvergeIndex < composeRepairIndex, true);
  assert.equal(routingConvergeIndex < composePublishedPortsIndex, true);
  assert.equal(routingSignalIndex < composeRepairIndex, true);
  assert.equal(markerPollingIndex < composeRepairIndex, true);
  assert.equal(composePublishedPortsIndex < deferredProbeIndex, true);
  assert.equal(registrySideEffectBody.includes("!this.ownsControlPlaneLease || !tryAcquireControlPlaneOwnerLease()"), true);
  assert.equal(registrySideEffectBody.includes("void this.writeHostAccessBindingsFile();"), true);
  assert.equal(applyBody.includes("if (!this.ownsControlPlaneLease)"), false);
  assert.equal(applyBody.includes("networkId === undefined\n        ? undefined"), true);
  assert.equal(refreshRuntimeBody.includes("options.includeContainerRuntime !== false"), true);
  assert.equal(refreshRuntimeBody.includes("this.containerRuntime.getDescriptor()"), true);
  assert.equal(refreshContainerBody.includes("options.background === true && !this.ownsControlPlaneLease"), true);
  assert.equal(reconcileComposeBody.includes("options.background === true && !this.ownsControlPlaneLease"), true);
  assert.equal(ownerSignalBody.includes("CONTROL_PLANE_OWNER_PATH"), true);
  assert.equal(ownerSignalBody.includes("void this.startControlPlaneOwnerIfAvailable();"), true);
  assert.equal(demoteBody.includes("for (const disposable of this.controlPlaneOwnerDisposables.splice(0))"), true);
  assert.equal(demoteBody.includes("this.applyVscodeWindowTerminalEnvironment();"), true);
  assert.equal(demoteBody.includes("this.context.environmentVariableCollection.clear();"), false);
  assert.equal(demoteBody.includes("releaseControlPlaneOwnerLease();"), true);
  assert.equal(demoteBody.includes("this.proxyManager.dispose();"), false);
  assert.equal(demoteBody.includes("this.browserNetworkProxy.dispose();"), false);
  assert.equal(demoteBody.includes("this.browserDnsServer.dispose();"), false);
  assert.equal(demoteBody.includes("this.logicalPortRouter.dispose();"), false);
  assert.equal(demoteBody.includes("releaseLogicalRouterOwnerLease();"), false);
  assert.equal(demoteBody.includes("releaseBrowserNetworkProxyOwnerLease();"), false);
  assert.equal(source.includes("data-plane brokers alive"), true);
  assert.equal(windowAttachBody.includes("Another Port Manager window owns terminal routing control."), false);
  assert.equal(windowAttachBody.includes("this.syncVscodeWindowProcessAttachment();"), true);
  assert.equal(windowDetachBody.includes("this.syncVscodeWindowProcessAttachment();"), true);
  assert.notEqual(vscodeProcessSyncStart, -1);
  assert.equal(source.includes('VSCODE_WINDOW_PROCESS_ATTACHMENT_ID_PREFIX = "vscode-window-process:"'), true);
  assert.equal(vscodeProcessSyncBody.includes("createVscodeWindowProcessAttachmentId(process.pid)"), true);
  assert.equal(vscodeProcessSyncBody.includes("rootPid: process.pid"), true);
  assert.equal(source.includes("A VS Code window can act as a host-side client"), true);
  assert.equal(source.includes("Another Port Manager window owns Compose routing control."), true);
});

test("compose attach waits for routing convergence before returning", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const attachStart = source.indexOf("async attachComposePublishedPorts(input: ComposePublishedPortsInput)");
  const attachEnd = source.indexOf("async detachComposeAttachment", attachStart);
  const attachBody = source.slice(attachStart, attachEnd);
  const convergeStart = source.indexOf("private async convergeAfterComposeAttachmentChange");
  const convergeEnd = source.indexOf("private async convergeDaemonAndRoutingState", convergeStart);
  const convergeBody = source.slice(convergeStart, convergeEnd);

  assert.equal(attachBody.includes("await this.convergeAfterComposeAttachmentChange([refreshedAttachment]);"), true);
  assert.equal(attachBody.includes("await this.convergeAfterComposeAttachmentChange([updatedAttachment]);"), true);
  assert.equal(
    convergeBody.includes(
      "await this.writeComposeProjectRoutingFile({ forceComposeOverrideRefresh: true }).catch(() => undefined);",
    ),
    true,
  );
  assert.equal(convergeBody.includes("await this.writeTerminalNetworkSelectionFile().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.reconcileComposeAttachmentPublishedPorts({ force: true }).catch(() => undefined);"), true);
  assert.equal(
    convergeBody.indexOf("await this.reconcileComposeAttachmentPublishedPorts({ force: true }).catch(() => undefined);") <
      convergeBody.indexOf(
        "await this.writeComposeProjectRoutingFile({ forceComposeOverrideRefresh: true }).catch(() => undefined);",
      ),
    true,
  );
  assert.equal(convergeBody.includes("await this.ensureDaemonRouteTablesMaterialized({"), true);
  assert.equal(convergeBody.includes("networkIds: attachments.map((attachment) => attachment.networkId),"), true);
  assert.equal(convergeBody.includes("await this.convergeDaemonAndRoutingState();"), true);
  assert.equal(convergeBody.includes("await this.refreshVscodeWindowTerminalEnvironment({ interactive: false }).catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.reapplyRoutingToAttachedTerminalWindows().catch(() => 0);"), true);
  assert.equal(convergeBody.includes("await this.refreshContainerServices().catch(() => []);"), true);
  assert.equal(convergeBody.includes("this.localChangeEvents.emit();"), true);
});

test("compose routing rows merge explicit and inferred container mappings", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("function mergeComposeRoutingContainerMappings"), true);
  assert.equal(source.includes("const inferredContainerMappings = inferContainerMappingsFromComposeRoutingFiles"), true);
  assert.equal(source.includes("const containerMappings = mergeComposeRoutingContainerMappings("), true);
  assert.equal(source.includes("composeFiles: [mutation.overrideFile, ...mutation.composeFiles]"), true);
  assert.equal(source.includes("mergeComposeContainerMappingLineage(primaryMappings, fallbackMappings)"), true);
  assert.equal(source.includes("CONTAINER_ALIAS_SERVICE_PREFIX"), true);
  assert.equal(source.includes("function composeRoutingContainerMappingTargetServiceName"), true);
});

test("terminal hook markers refresh attached UI state without manual refresh", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const refreshStart = source.indexOf("private async refreshTerminalsExclusive");
  const refreshEnd = source.indexOf("async refreshContainerServices", refreshStart);
  const refreshBody = source.slice(refreshStart, refreshEnd);
  const restoreStart = source.indexOf("private async restoreMissingManualTerminalAttachmentMarkers");
  const restoreEnd = source.indexOf("private syncProcessAttachmentLiveness", restoreStart);
  const restoreBody = source.slice(restoreStart, restoreEnd);
  const livenessStart = source.indexOf("private syncProcessAttachmentLiveness");
  const livenessEnd = source.indexOf("  /** Reads all manually pasted", livenessStart);
  const livenessBody = source.slice(livenessStart, livenessEnd);

  assert.equal(source.includes("TERMINAL_ATTACHMENT_MARKER_POLL_INTERVAL_MS = 500"), true);
  assert.equal(source.includes("private watchTerminalAttachmentMarkers(directoryPath: string): DisposableLike"), true);
  assert.equal(source.includes("syncFs.watch(directoryPath"), true);
  assert.equal(source.includes("private scheduleTerminalAttachmentRefreshBurst(networkIds: readonly string[] = []): void"), true);
  assert.equal(source.includes("private async refreshTerminalAttachmentsWhenMarkersChanged(): Promise<void>"), true);
  assert.notEqual(restoreStart, -1);
  assert.notEqual(livenessStart, -1);
  assert.equal(
    refreshBody.indexOf("await this.restoreMissingManualTerminalAttachmentMarkers(processRows).catch(() => undefined);") <
      refreshBody.indexOf("await this.syncManualTerminalAttachmentMarkers(processRows).catch(() => undefined);"),
    true,
  );
  assert.equal(restoreBody.includes("attachment.id.startsWith(MANUAL_TERMINAL_ATTACHMENT_ID_PREFIX)"), true);
  assert.equal(livenessBody.includes("VSCODE_WINDOW_PROCESS_ATTACHMENT_ID_PREFIX"), true);
  assert.equal(restoreBody.includes("writeManualTerminalAttachmentMarker"), true);
  assert.equal(restoreBody.includes("await writeTextFileAtomically(markerPath"), true);
  assert.equal(source.includes("selectLatestTerminalAttachmentMarkerCandidates"), true);
  assert.equal(source.includes("terminalAttachmentsShareIdentity"), true);
  assert.equal(source.includes("selectedMarkerPaths"), true);
  assert.equal(source.includes("this.terminalRefreshInFlight !== undefined"), true);
  assert.equal(source.includes("this.terminalRefreshQueued = true"), true);
  assert.equal(source.includes("this.startTerminalAttachmentMarkerPolling();"), true);
});

test("terminal refresh scans only from the control-plane owner window", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const refreshStart = source.indexOf("async refreshTerminals(options: BackgroundRefreshOptions = {})");
  const refreshEnd = source.indexOf("private async refreshTerminalsSerially", refreshStart);
  const refreshBody = source.slice(refreshStart, refreshEnd);

  assert.notEqual(refreshStart, -1);
  assert.equal(refreshBody.includes("if (!this.ownsControlPlaneLease) {"), true);
  assert.equal(refreshBody.includes("await this.startControlPlaneOwnerIfAvailable();"), true);
  assert.equal(refreshBody.includes("return this.registry.getSnapshot().terminalWindows;"), true);
  assert.equal(
    refreshBody.indexOf("return this.registry.getSnapshot().terminalWindows;") <
      refreshBody.indexOf("this.terminalRefreshInFlight = this.refreshTerminalsSerially()"),
    true,
  );
});

test("terminal reveal focuses injected VS Code and external terminal windows", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("async revealTerminalWindow(terminalWindowId: string): Promise<boolean>"), true);
  assert.equal(source.includes("function findMatchingVscodeTerminal"), true);
  assert.equal(source.includes("terminal.show(false);"), true);
  assert.equal(source.includes("function revealExternalTerminalWindow"), true);
  assert.equal(source.includes("function revealTerminalAppleScript"), true);
  assert.equal(source.includes("set selected tab of windowItem to tabItem"), true);
  assert.equal(source.includes("function revealITermAppleScript"), true);
  assert.equal(source.includes("select sessionItem"), true);
});

test("compose route reconciliation rehydrates persisted attachment routes", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const reconcileStart = source.indexOf("private async reconcileComposeAttachmentPublishedPortsExclusive");
  const reconcileEnd = source.indexOf("private async refreshComposeContainerMappings", reconcileStart);
  const reconcileBody = source.slice(reconcileStart, reconcileEnd);
  const attachStart = source.indexOf("async attachComposePublishedPorts");
  const attachEnd = source.indexOf("  /**\n   * Detaches a compose attachment", attachStart);
  const attachBody = source.slice(attachStart, attachEnd);
  const renameStart = source.indexOf("async renameComposeAttachment");
  const renameEnd = source.indexOf("  /** Captures the selected network", renameStart);
  const renameBody = source.slice(renameStart, renameEnd);

  assert.equal(source.includes("function isRestorableComposeAttachment"), true);
  assert.equal(source.includes('attachment.status === "attached" || attachment.status === "error"'), true);
  assert.equal(reconcileBody.includes(".composeAttachments.filter(isRestorableComposeAttachment)"), true);
  assert.equal(reconcileBody.includes("const targetAttachments = filterComposeAttachmentsByNetworkIds(attachments, options.networkIds);"), true);
  assert.equal(reconcileBody.includes("for (const attachment of targetAttachments)"), true);
  assert.equal(
    reconcileBody.indexOf("await this.removeOrphanComposeRouteProcesses(attachments);") <
      reconcileBody.indexOf("const targetAttachments = filterComposeAttachmentsByNetworkIds(attachments, options.networkIds);"),
    true,
    "orphan cleanup must keep using the full desired attachment set",
  );
  assert.equal(reconcileBody.includes(".listLiveComposePublishedPorts("), true);
  assert.equal(reconcileBody.includes("let livePorts: readonly ComposePublishedPort[] | undefined;"), true);
  assert.equal(reconcileBody.includes("containerRuntimeSettingsForAttachment(settings, attachment)"), true);
  assert.equal(reconcileBody.includes("shouldRefreshPorts && livePorts !== undefined"), true);
  assert.equal(reconcileBody.includes(".catch(() => [])"), false);
  assert.equal(reconcileBody.includes("liveDiscoveryError"), true);
  assert.equal(reconcileBody.includes("this.replaceComposeRouteProcesses(overrideRestoredAttachment, livePorts)"), true);
  assert.equal(reconcileBody.includes("this.ensureComposeRouteProcesses(overrideRestoredAttachment"), true);
  assert.equal(attachBody.includes(".listLiveComposePublishedPorts("), true);
  assert.equal(attachBody.includes("this.replaceComposeRouteProcesses(registeredAttachment, livePorts)"), true);
  assert.equal(renameBody.includes(".listLiveComposePublishedPorts("), true);
  assert.equal(renameBody.includes("this.replaceComposeRouteProcesses(nextAttachment, livePorts)"), true);
  assert.equal(renameBody.includes("this.replaceComposeRouteProcesses(nextAttachment, mutationResult.ports)"), false);
  assert.equal(source.includes("private async replaceComposeRouteProcesses("), true);
  assert.equal(source.includes("private async ensureComposeRouteProcessesForAttachments("), true);
  assert.equal(source.includes("private async ensureComposeRouteProcesses("), true);
  assert.equal(source.includes("private async restorePersistedComposeRoutesIfMissing"), false);
  assert.equal(source.includes("private async restorePersistedComposeRoutes("), false);
  assert.equal(source.includes("attachment.ports.length > 0"), true);
  assert.equal(source.includes("process.actualPort === port.actualHostPort"), true);
  assert.equal(source.includes("function findComposeProcessForPort("), true);
  assert.equal(source.includes("await this.processService.registerExistingProcess("), true);
  assert.equal(source.includes("function hasComposePublishedPortListener"), false);
  assert.equal(source.includes("const hasRuntimeListener = hasComposePublishedPortListener"), false);
  assert.equal(source.includes("await this.removeComposeRouteProcesses(attachment, [port]);"), false);
});

test("compose project routing files are published as a serialized atomic generation", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const writeStart = source.indexOf("private async writeComposeProjectRoutingFile(");
  const writeEnd = source.indexOf("private async reconcileComposeOverrideFiles", writeStart);
  const writeBody = source.slice(writeStart, writeEnd);
  const rowStart = source.indexOf("function buildComposeProjectRoutingRows");
  const rowEnd = source.indexOf("function mergeComposeRoutingContainerMappings", rowStart);
  const rowBody = source.slice(rowStart, rowEnd);

  assert.equal(source.includes("private composeProjectRoutingWriteInFlight"), true);
  assert.equal(source.includes("private composeProjectRoutingWriteQueued = false;"), true);
  assert.equal(source.includes("private composeProjectRoutingForceOverrideRefreshQueued = false;"), true);
  assert.equal(source.includes("private async writeComposeProjectRoutingFileSerially(): Promise<void>"), true);
  assert.equal(source.includes("private async writeComposeProjectRoutingFileExclusive("), true);
  assert.equal(rowBody.includes("!isRoutableComposeAttachment(attachment)"), true);
  assert.equal(rowBody.includes("inferOriginalComposeProjectNameForRouting("), true);
  assert.equal(rowBody.includes("routingFiles.overrideFile === undefined"), true);
  assert.equal(source.includes("function parseComposeConfiguredProjectNameForRouting"), true);
  assert.equal(writeBody.includes("this.composeProjectRoutingForceOverrideRefreshQueued = true;"), true);
  assert.equal(writeBody.includes("this.composeProjectRoutingForceOverrideRefreshNetworkIds.add(networkId);"), true);
  assert.equal(writeBody.includes("this.composeProjectRoutingWriteQueued = true;"), true);
  assert.equal(writeBody.includes("await withSharedFileGenerationLock(this.getComposeProjectRoutingLockPath(networkId), async () => {"), true);
  assert.equal(writeBody.includes("const overrideAttachments = filterComposeAttachmentsByNetworkIds"), true);
  assert.equal(writeBody.includes("await this.reconcileComposeOverrideFiles(overrideAttachments, {"), true);
  assert.equal(writeBody.includes('await writeTextFileAtomicallyOrTouch(globalFilePath, "");'), false);
  assert.equal(writeBody.includes('await writeTextFileAtomicallyOrTouch(networkFilePath, "");'), false);
  assert.equal(writeBody.includes("const aggregateRowsByNetworkId = new Map<string, ComposeProjectRoutingRow[]>();"), true);
  assert.equal(writeBody.includes("const rowsByScopedFileByNetworkId = new Map<string, Map<string, ComposeProjectRoutingRow[]>>();"), true);
  assert.equal(
    writeBody.includes("await writeTextFileAtomicallyOrTouch(networkFilePath, serializeComposeProjectRoutingRows(aggregateRows));"),
    true,
  );
  assert.equal(writeBody.includes("rowsByScopedFilePath.set(scopedFilePath, [row]);"), true);
  assert.equal(writeBody.includes("scopedRows.push(row);"), true);
  assert.equal(writeBody.includes("await writeTextFileAtomicallyOrTouch(scopedFilePath, serializeComposeProjectRoutingRows(scopedRows));"), true);
  assert.equal(writeBody.includes("await this.removeStaleComposeProjectRoutingFiles(networkId, currentScopedPaths);"), true);
  assert.equal(source.includes("async function writeTextFileAtomicallyOrTouch"), true);
  assert.equal(writeBody.includes("serializeComposeProjectRoutingRows([row])"), false);
  assert.equal(writeBody.includes("await fs.writeFile(scopedFilePath"), false);
  assert.equal(source.includes("COMPOSE_PROJECT_ROUTING_WRITE_LOCK_STALE_MS"), true);
  assert.equal(source.includes("function acquireSharedFileGenerationLock"), true);
  assert.equal(source.includes("function removeStaleSharedFileGenerationLock"), true);
});

test("compose override yaml is force-refreshed on attach startup and repair", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const attachStart = source.indexOf("async attachComposePublishedPorts(input: ComposePublishedPortsInput)");
  const attachEnd = source.indexOf("async detachComposeAttachment", attachStart);
  const attachBody = source.slice(attachStart, attachEnd);
  const startStart = source.indexOf("async start(): Promise<void>");
  const startEnd = source.indexOf("  /** Returns the latest logical network snapshot", startStart);
  const startBody = source.slice(startStart, startEnd);
  const reloadStart = source.indexOf("private async reloadSharedNetworkState");
  const reloadEnd = source.indexOf("private loadVscodeWindowTerminalBinding", reloadStart);
  const reloadBody = source.slice(reloadStart, reloadEnd);
  const repairStart = source.indexOf("async fixStaleRouting()");
  const repairEnd = source.indexOf("  /** Releases listeners", repairStart);
  const repairBody = source.slice(repairStart, repairEnd);
  const terminalAttachStart = source.indexOf("async attachTerminalWindow(networkId: string, terminalWindowId: string)");
  const terminalAttachEnd = source.indexOf("  /** Brings a discovered terminal window", terminalAttachStart);
  const terminalAttachBody = source.slice(terminalAttachStart, terminalAttachEnd);
  const windowAttachStart = source.indexOf("async attachVscodeWindowTerminalsToNetwork(networkId: string)");
  const windowAttachEnd = source.indexOf("  /** Clears the current VS Code window", windowAttachStart);
  const windowAttachBody = source.slice(windowAttachStart, windowAttachEnd);
  const scriptStart = source.indexOf("async createTerminalRoutingScript(networkId: string)");
  const scriptEnd = source.indexOf("  /** Returns the shell snippet", scriptStart);
  const scriptBody = source.slice(scriptStart, scriptEnd);
  const helperStart = source.indexOf("private async reconcileComposeOverrideFiles");
  const helperEnd = source.indexOf("private getComposeProjectRoutingFilePath", helperStart);
  const helperBody = source.slice(helperStart, helperEnd);

  assert.equal(attachBody.includes("force: input.composeMutation !== undefined || input.existingMutation !== undefined"), true);
  assert.equal(attachBody.includes("await this.composePublishMutator.hidePublishedPorts({"), true);
  assert.equal(attachBody.includes("await this.composePublishMutator.restoreHiddenPortsOverride(input.existingMutation, {"), true);
  assert.equal(startBody.includes("await this.writeComposeProjectRoutingFile({ forceComposeOverrideRefresh: true });"), true);
  assert.equal(startBody.includes("await this.reconcileComposeOverrideFiles(undefined, { force: true });"), true);
  assert.equal(reloadBody.includes("await this.writeComposeProjectRoutingFile({ forceComposeOverrideRefresh: true });"), true);
  assert.equal(reloadBody.includes("await this.reconcileComposeOverrideFiles(undefined, { force: true });"), true);
  assert.equal(
    repairBody.includes("await this.writeComposeProjectRoutingFile({ forceComposeOverrideRefresh: true }).catch(() => undefined);"),
    true,
  );
  assert.equal(terminalAttachBody.includes("await this.ensureNetworkComposeRoutingArtifacts(networkId);"), true);
  assert.equal(windowAttachBody.includes("await this.ensureNetworkComposeRoutingArtifacts(networkId);"), true);
  assert.equal(windowAttachBody.includes("await this.reloadSharedNetworkState();"), true);
  assert.equal(windowAttachBody.includes("startControlPlaneOwnerIfAvailable"), false);
  assert.equal(scriptBody.includes("await this.ensureNetworkComposeRoutingArtifacts(networkId);"), true);
  assert.equal(helperBody.includes("private async reconcileComposeOverrideFileForAttachment("), true);
  assert.equal(helperBody.includes("recoverToStorageDirectory: true"), true);
  assert.equal(helperBody.includes("buildMutationlessComposeOverrideRecoveryState(attachment)"), true);
  assert.equal(helperBody.includes("status: \"error\""), true);
  assert.equal(helperBody.includes("await this.removeComposeRouteProcesses(nextAttachment, nextAttachment.ports).catch(() => undefined);"), true);
  assert.equal(helperBody.includes("this.registry.updateComposeAttachment({"), true);
});

test("compose detach and remove regenerate yaml and routing artifacts from the latest registry", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const detachStart = source.indexOf("async detachComposeAttachment(attachmentId: string)");
  const detachEnd = source.indexOf("async removeComposeAttachment", detachStart);
  const detachBody = source.slice(detachStart, detachEnd);
  const removeStart = source.indexOf("async removeComposeAttachment(attachmentId: string)");
  const removeEnd = source.indexOf("  /** Returns one compose attachment", removeStart);
  const removeBody = source.slice(removeStart, removeEnd);
  const removalConvergeStart = source.indexOf("private async convergeAfterComposeAttachmentRemoval");
  const removalConvergeEnd = source.indexOf("  /** Ensures an attached hidden Compose project", removalConvergeStart);
  const removalConvergeBody = source.slice(removalConvergeStart, removalConvergeEnd);
  const artifactStart = source.indexOf("private async ensureNetworkComposeRoutingArtifacts");
  const artifactEnd = source.indexOf("private async convergeDaemonAndRoutingState", artifactStart);
  const artifactBody = source.slice(artifactStart, artifactEnd);

  assert.notEqual(detachStart, -1);
  assert.notEqual(removeStart, -1);
  assert.notEqual(removalConvergeStart, -1);
  assert.notEqual(removalConvergeEnd, -1);
  assert.notEqual(artifactStart, -1);
  assert.notEqual(artifactEnd, -1);
  assert.equal(detachBody.includes("await this.convergeAfterComposeAttachmentRemoval([attachment.networkId]);"), true);
  assert.equal(
    removeBody.includes("await this.convergeAfterComposeAttachmentRemoval([attachmentToRemove.networkId]);"),
    true,
  );
  assert.equal(removalConvergeBody.includes("const uniqueNetworkIds = [...new Set(networkIds)];"), true);
  assert.equal(
    removalConvergeBody.includes("await this.reconcileComposeAttachmentPublishedPorts({ force: true }).catch(() => undefined);"),
    true,
  );
  assert.equal(
    removalConvergeBody.includes(
      "await this.writeComposeProjectRoutingFile({ forceComposeOverrideRefresh: true }).catch(() => undefined);",
    ),
    true,
  );
  assert.equal(removalConvergeBody.includes("await this.writeTerminalNetworkSelectionFile().catch(() => undefined);"), true);
  assert.equal(
    removalConvergeBody.includes("await this.ensureDaemonRouteTablesMaterialized({ force: true, networkIds: uniqueNetworkIds }).catch("),
    true,
  );
  assert.equal(removalConvergeBody.includes("await this.convergeDaemonAndRoutingState();"), true);
  assert.equal(
    removalConvergeBody.includes("await this.refreshVscodeWindowTerminalEnvironment({ interactive: false }).catch(() => undefined);"),
    true,
  );
  assert.equal(removalConvergeBody.includes("await this.reapplyRoutingToAttachedTerminalWindows().catch(() => 0);"), true);
  assert.equal(removalConvergeBody.includes("await this.refreshContainerServices().catch(() => []);"), true);
  assert.equal(removalConvergeBody.includes("this.localChangeEvents.emit();"), true);
  assert.equal(artifactBody.includes("if (attachments.length === 0) {\n      return;\n    }"), false);
  assert.equal(artifactBody.includes("if (attachments.length > 0) {"), true);
  assert.equal(
    artifactBody.includes("await this.reconcileComposeOverrideFiles(attachments, { force: true });"),
    true,
  );
  assert.equal(
    artifactBody.includes("await this.reconcileComposeAttachmentPublishedPorts({ force: true }).catch(() => undefined);"),
    true,
  );
  assert.equal(
    artifactBody.includes(
      "await this.writeComposeProjectRoutingFile({ forceComposeOverrideRefresh: attachments.length > 0 }).catch(",
    ),
    true,
  );
  assert.equal(artifactBody.includes("await this.writeTerminalNetworkSelectionFile().catch(() => undefined);"), true);
  assert.equal(
    artifactBody.includes("await this.ensureDaemonRouteTablesMaterialized({ force: true, networkIds: [networkId] }).catch(() => undefined);"),
    true,
  );
});

test("manual refresh commands reconcile generated network routing state", () => {
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const refreshServicesStart = commandsSource.indexOf("private async refreshContainerServices(): Promise<void>");
  const refreshServicesEnd = commandsSource.indexOf("  /** Attaches a selected terminal", refreshServicesStart);
  const refreshServicesBody = commandsSource.slice(refreshServicesStart, refreshServicesEnd);
  const refreshStart = commandsSource.indexOf("private async refresh(): Promise<void>");
  const refreshEnd = commandsSource.indexOf("  /** Opens the status bar command menu", refreshStart);
  const refreshBody = commandsSource.slice(refreshStart, refreshEnd);

  assert.equal(refreshServicesBody.includes("this.dependencies.networkService.refreshContainerServices();"), true);
  assert.equal(refreshServicesBody.includes("await this.dependencies.networkService.refreshNetworkRoutingState();"), true);
  assert.equal(refreshBody.includes("this.dependencies.networkService.refreshContainerServices()"), true);
  assert.equal(refreshBody.includes("await this.dependencies.networkService.refreshNetworkRoutingState();"), true);
});

test("container attach resolves candidates from a fresh Docker discovery pass", () => {
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const attachStart = commandsSource.indexOf("private async attachContainerToNetwork");
  const attachEnd = commandsSource.indexOf("  /** Attaches published ports", attachStart);
  const attachBody = commandsSource.slice(attachStart, attachEnd);
  const resolveStart = commandsSource.indexOf("private async resolveContainerServiceCandidateArgument");
  const resolveEnd = commandsSource.indexOf("  /** Resolves a terminal attachment", resolveStart);
  const resolveBody = commandsSource.slice(resolveStart, resolveEnd);

  assert.equal(attachBody.includes("directInput?.containerService === undefined"), true);
  assert.equal(attachBody.includes("directInput.containerService,"), true);
  assert.equal(resolveBody.includes("await this.dependencies.networkService.refreshContainerServices({ force: true });"), true);
  assert.equal(resolveBody.includes("return resolveLatestContainerServiceCandidate(candidates, candidate);"), true);
  assert.equal(resolveBody.includes("getSnapshot().containerServiceCandidates"), false);
});

test("background routing convergence does not rewrite unchanged generated files", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const atomicStart = source.indexOf("async function writeTextFileAtomically");
  const atomicEnd = source.indexOf("function composeProjectRoutingRowScope", atomicStart);
  const atomicBody = source.slice(atomicStart, atomicEnd);
  const hostStart = source.indexOf("private async writeHostAccessBindingsFile");
  const hostEnd = source.indexOf("private async writeComposeProjectRoutingFile", hostStart);
  const hostBody = source.slice(hostStart, hostEnd);
  const scriptStart = source.indexOf("private writeTerminalHookScript(fileName: string, contents: string): string");
  const scriptEnd = source.indexOf("private async writeTerminalNetworkSelectionFile", scriptStart);
  const scriptBody = source.slice(scriptStart, scriptEnd);

  assert.equal(atomicBody.includes("if (await textFileAlreadyMatches(filePath, contents))"), true);
  assert.equal(atomicBody.includes("syncTextFileAlreadyMatches"), true);
  assert.equal(atomicBody.includes("readHostAccessBindingsDocument"), true);
  assert.equal(hostBody.includes("const previousDocument = await readHostAccessBindingsDocument(filePath);"), true);
  assert.equal(hostBody.includes("? previousDocument.updatedAt"), true);
  assert.equal(scriptBody.includes("const nextContents = `${contents.trimEnd()}\\n`;"), true);
  assert.equal(scriptBody.includes("if (syncTextFileAlreadyMatches(scriptPath, nextContents))"), true);
  assert.equal(scriptBody.includes("ensureExecutableScriptMode(scriptPath);"), true);
});

test("route tables are stored in extension global storage and legacy temp files are cleaned", () => {
  const activatePath = path.resolve(__dirname, "../../../src/extension/activate.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const agentMainPath = path.resolve(__dirname, "../../../src/agent/agent-main.ts");
  const agentPath = path.resolve(__dirname, "../../../src/agent/port-manager-agent.ts");
  const activateSource = fs.readFileSync(activatePath, "utf8");
  const networkSource = fs.readFileSync(networkServicePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");
  const agentMainSource = fs.readFileSync(agentMainPath, "utf8");
  const agentSource = fs.readFileSync(agentPath, "utf8");
  const cleanupStart = networkSource.indexOf("private async collectRoutingFileCleanupPaths");
  const cleanupEnd = networkSource.indexOf("private async collectGlobalStorageCleanupPaths", cleanupStart);
  const cleanupBody = networkSource.slice(cleanupStart, cleanupEnd);
  const networkCleanupStart = networkSource.indexOf("private async collectNetworkRoutingFileCleanupPaths");
  const networkCleanupEnd = networkSource.indexOf("private async rehydrateRoutingFiles", networkCleanupStart);
  const networkCleanupBody = networkSource.slice(networkCleanupStart, networkCleanupEnd);

  assert.equal(
    activateSource.includes('configureRouteTableStorageDirectory(path.join(context.globalStorageUri.fsPath, "route-tables"))'),
    true,
  );
  assert.equal(cleanupBody.includes("getLegacyDefaultRouteTablePath()"), true);
  assert.equal(networkCleanupBody.includes("getLegacyDefaultRouteTablePath()"), true);
  assert.equal(commandsSource.includes('--route-table "$PORT_MANAGER_GLOBAL_ROUTES_FILE"'), true);
  assert.equal(agentMainSource.includes("parsedArguments.routeTablePath ?? process.env.PORT_MANAGER_GLOBAL_ROUTES_FILE"), true);
  assert.equal(agentSource.includes("acquireRouteTableGenerationLock("), false);
  assert.equal(agentSource.includes("ROUTE_TABLE_GENERATION_BACKGROUND_LOCK_ATTEMPTS"), false);
  assert.equal(agentSource.includes("writeRouteTableFile(this.routeTablePath"), false);
  assert.equal(agentSource.includes("getNetworkRouteTablePath(networkId, this.routeTablePath)"), true);
  assert.equal(agentSource.includes("private writeRouteTableGeneration("), true);
  assert.equal(agentSource.includes("generation: RouteTableGeneration"), true);
  assert.equal(agentSource.includes("isRouteTableGenerationNewer"), true);
});

test("terminal attach script prepares actual loopback routing only after alias readiness", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("buildLoopbackAddressRoutingShell"), true);
  assert.equal(source.includes("sudo -n ifconfig lo0 alias"), true);
  assert.equal(source.includes('sudo ifconfig lo0 alias "$__pm_loopback_host" 255.255.255.255 >/dev/null'), true);
  assert.equal(source.includes("portManager.loopbackAddressRoutingMode"), true);
  assert.equal(source.includes("Port Manager high-port loopback IP routing unavailable; attach aborted."), true);
  assert.equal(source.includes("Port Manager loopback IP routing unavailable; attach aborted."), true);
  assert.equal(source.includes("export PORT_MANAGER_HOOK_DISABLED=1"), true);
  assert.equal(source.includes("return 1 2>/dev/null || exit 1"), true);
  assert.equal(source.includes("ACTUAL_LOOPBACK_HOST_ENV"), true);
  assert.equal(source.includes("NETWORK_LOOPBACK_HOST_ENV"), true);
  assert.equal(source.includes("ensureLoopbackAddressRoutingHostReady"), true);
  assert.equal(source.includes("refreshVscodeWindowTerminalEnvironment"), true);
  assert.equal(source.includes('binding?.status === "attached"'), true);
  assert.equal(source.includes("VS Code terminal default not applied."), true);
});

test("terminal attach does not require durable compose routes before reporting active", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const scriptStart = source.indexOf("private buildTerminalRoutingScriptBody");
  const scriptEnd = source.indexOf("private buildTerminalDetachScript", scriptStart);
  const scriptBody = source.slice(scriptStart, scriptEnd);

  assert.notEqual(scriptStart, -1);
  assert.notEqual(scriptEnd, -1);
  assert.equal(source.includes("interface ComposeRouteReadinessRow"), false);
  assert.equal(source.includes("buildExpectedComposeRouteReadinessRows(networkId)"), false);
  assert.equal(source.includes("function buildComposeRouteReadinessShell"), false);
  assert.equal(source.includes("compose routes did not become ready"), false);
  assert.equal(
    scriptBody.indexOf("buildTerminalAttachmentMarkerWriteShell()") <
      scriptBody.indexOf("Port Manager routing active for"),
    true,
  );
  assert.equal(
    scriptBody.indexOf("buildRuntimeShimReadinessShell(runtimeShimDirectory)") <
      scriptBody.indexOf("buildTerminalAttachmentMarkerWriteShell()"),
    true,
  );
  assert.equal(
    scriptBody.indexOf('if [ "\\${PORT_MANAGER_RUNTIME_SHIM_READY:-0}" != "1" ]; then return 1 2>/dev/null || exit 1; fi') <
      scriptBody.indexOf("buildTerminalAttachmentMarkerWriteShell()"),
    true,
  );
});

test("native hook preserves listener ports only for explicit overrides", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const defaultPorts = source
    .match(/#define PM_DEFAULT_FIXED_PROTOCOL_PORTS "([^"]+)"/)?.[1]
    ?.split(",")
    .map((value) => Number(value));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
    contributes?: {
      configuration?: {
        properties?: {
          "portManager.fixedProtocolPorts"?: {
            default?: readonly number[];
          };
        };
      };
    };
  };

  assert.equal(source.includes("return pm_is_preserved_listen_port(logical_port);"), true);
  assert.equal(source.includes("pm_current_process_looks_like_browser_dev_server"), false);
  assert.equal(source.includes("stable browser alias"), true);
  assert.deepEqual(defaultPorts, DEFAULT_PORT_MANAGER_SETTINGS.fixedProtocolPorts);
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.["portManager.fixedProtocolPorts"]?.default,
    DEFAULT_PORT_MANAGER_SETTINGS.fixedProtocolPorts,
  );
});

test("native hook binds high-port routes on dedicated actual loopback hosts", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const bindStart = source.indexOf("static int pm_bind_hook");
  const loopbackStart = source.indexOf("loopback_host = pm_network_loopback_host();");
  const allocationStart = source.indexOf("pm_allocate_route(logical_port, bind_host, NULL, \"listen\"");
  const loopbackBind = source.slice(loopbackStart, allocationStart);
  const highPortBind = source.slice(allocationStart, source.indexOf("static int pm_connect_hook", allocationStart));
  const matchLevelStart = source.indexOf("static int pm_cached_route_network_match_level");
  const matchLevelEnd = source.indexOf("static int pm_cached_route_matches_cwd", matchLevelStart);
  const matchLevelBody = source.slice(matchLevelStart, matchLevelEnd);
  const connectStart = source.indexOf("static int pm_connect_hook");
  const connectEnd = source.indexOf("static int pm_getsockname_hook", connectStart);
  const connectBody = source.slice(connectStart, connectEnd);
  const ephemeralHelperStart = source.indexOf("static int pm_bind_ephemeral_local_port");
  const ephemeralHelperEnd = source.indexOf("static int pm_bind_hook", ephemeralHelperStart);
  const ephemeralHelperBody = source.slice(ephemeralHelperStart, ephemeralHelperEnd);
  const addressOnlyBindStart = source.indexOf("if (pm_loopback_address_only_mode())", bindStart);
  const ephemeralBindStart = source.indexOf("if (logical_port == 0)", bindStart);
  const addressOnlyConnectStart = connectBody.indexOf("if (pm_loopback_address_only_mode())");
  const addressOnlyConnectEnd = connectBody.indexOf("target_host[0] = '\\0';", addressOnlyConnectStart);
  const addressOnlyConnectBlock = connectBody.slice(addressOnlyConnectStart, addressOnlyConnectEnd);

  assert.notEqual(loopbackStart, -1);
  assert.notEqual(bindStart, -1);
  assert.notEqual(allocationStart, -1);
  assert.notEqual(matchLevelStart, -1);
  assert.notEqual(connectStart, -1);
  assert.notEqual(ephemeralHelperStart, -1);
  assert.notEqual(ephemeralBindStart, -1);
  assert.notEqual(addressOnlyBindStart, -1);
  assert.notEqual(addressOnlyConnectStart, -1);
  assert.equal(
    matchLevelBody.includes(
      "return route->has_network_id ? 0 : 2;",
    ),
    true,
    "the native connect hook must fail closed when scoped network identity is missing",
  );
  assert.equal(loopbackStart < allocationStart, true);
  assert.equal(loopbackBind.includes("pm_set_sockaddr_host((struct sockaddr *)&rewritten, loopback_host);"), true);
  assert.equal(loopbackBind.includes("pm_remember_route(logical_port, logical_port, loopback_host, \"\", 0);"), true);
  assert.equal(loopbackBind.includes("pm_register_process(logical_port, logical_port, loopback_host, \"\");"), true);
  assert.equal(source.includes('PM_ACTUAL_LOOPBACK_HOST_ENV "PORT_MANAGER_ACTUAL_LOOPBACK_HOST"'), true);
  assert.equal(source.includes("actual_loopback_host = pm_actual_loopback_host();"), true);
  assert.equal(highPortBind.includes("pm_set_sockaddr_host((struct sockaddr *)&rewritten, bind_host);"), true);
  assert.equal(highPortBind.includes("pm_register_process(logical_port, actual_port, bind_host, allocation_id);"), true);
  assert.equal(source.includes("actual_host_payload"), true);
  assert.equal(source.includes('\\"actualHost\\":\\"%s\\"'), true);
  assert.equal(connectBody.includes("pm_allocate_route("), true);
  assert.equal(connectBody.includes("actual_loopback_host,\n          \"send\""), true);
  assert.equal(connectBody.includes("target_host,\n          sizeof(target_host)"), true);
  assert.equal(source.includes('pm_json_string(response, "host", allocated_host, allocated_host_size)'), true);
  assert.equal(source.includes("actual_port != logical_port && actual_loopback_host != NULL"), false);
  assert.equal(connectBody.includes("falling back to route resolution"), true);
  assert.equal(connectBody.includes("loopback_connect_errno != ECONNREFUSED"), true);
  assert.equal(source.includes('PM_LOOPBACK_ADDRESS_ONLY_MODE "loopback-address-only"'), true);
  assert.equal(source.includes("pm_bind_ephemeral_local_port"), true);
  assert.equal(source.includes("uses an ephemeral loopback coordination port must stay inside the attached"), true);
  assert.equal(source.includes("Hookless host clients attached by PID still dial localhost"), true);
  assert.equal(ephemeralHelperBody.includes("pm_real_getsockname(sockfd"), true);
  assert.equal(ephemeralHelperBody.includes("pm_remember_route(actual_port, actual_port, loopback_host, \"\", 0);"), true);
  assert.equal(ephemeralHelperBody.includes("pm_register_process(actual_port, actual_port, loopback_host, \"\");"), true);
  assert.equal(source.includes("errno = EADDRNOTAVAIL;\n      return -1;"), true);
  assert.equal(ephemeralBindStart < addressOnlyBindStart, true);
  assert.equal(source.includes("bind address-only logical=%d host=%s"), true);
  assert.equal(addressOnlyBindStart < allocationStart, true);
  assert.equal(addressOnlyConnectBlock.includes("pm_allocate_route("), false);
  assert.equal(addressOnlyConnectBlock.includes("pm_set_sockaddr_host((struct sockaddr *)&rewritten, loopback_host);"), true);
});

test("native agent adopts previous route files before first startup write", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/agent/portmanager_agent_state.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const adoptStart = source.indexOf("static void pm_adopt_previous_generation_route_files");
  const initStart = source.indexOf("void pm_state_init");
  const initBody = source.slice(initStart, source.indexOf("void pm_state_dispose", initStart));
  const adoptBody = source.slice(adoptStart, initStart);

  assert.notEqual(adoptStart, -1);
  assert.notEqual(initStart, -1);
  assert.equal(adoptBody.includes("state->written_entry_paths"), true);
  assert.equal(adoptBody.includes("state->written_network_ids"), true);
  assert.equal(adoptBody.includes("unlink(file_path);"), false);
  assert.equal(initBody.includes("pm_adopt_previous_generation_route_files(state);"), true);
  assert.equal(initBody.includes("if (pm_write_route_tables(state, 1) == 0)"), true);
  assert.equal(initBody.includes("state->route_table_refreshed_at = time(NULL);"), true);
  assert.equal(source.includes("pm_acquire_route_table_write_lock("), false);
  assert.equal(source.includes("PM_ROUTE_TABLE_WRITE_LOCK_BACKGROUND_ATTEMPTS"), false);
  assert.equal(source.includes("PM_ROUTE_TABLE_WRITE_LOCK_STALE_SECONDS"), false);
  assert.equal(source.includes("pm_route_table_generation_is_newer_for_publish"), true);
});

test("native preload repair is opt-in at runtime shim boundaries", () => {
  const hookSourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const asdfShimSourcePath = path.resolve(__dirname, "../../../native/asdf-shim/portmanager_asdf_shim.c");
  const hookSource = fs.readFileSync(hookSourcePath, "utf8");
  const asdfShimSource = fs.readFileSync(asdfShimSourcePath, "utf8");

  assert.equal(hookSource.includes('!pm_envp_value_is(envp, "PORT_MANAGER_PRELOAD_REPAIR", "1")'), true);
  assert.equal(hookSource.includes("Runtime/package-bin shims opt into repair"), true);
  assert.equal(asdfShimSource.includes('setenv("PORT_MANAGER_PRELOAD_REPAIR", "1", 1);'), true);
});

test("logical routers expose host-client networks without taking unrelated network ports", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const collectStart = source.indexOf("function collectLogicalRouterPorts");
  const collectEnd = source.indexOf("function isPortManagerLogicalRouterListener", collectStart);
  const collectLogicalRouterPorts = source.slice(collectStart, collectEnd);
  const routeNeedsStart = source.indexOf("function routeNeedsLogicalRouter");
  const routeNeedsEnd = source.indexOf("function listenerCoversLogicalRouterHost", routeNeedsStart);
  const routeNeedsLogicalRouter = source.slice(routeNeedsStart, routeNeedsEnd);
  const syncStart = source.indexOf("private async syncLogicalPortRoutersExclusive(): Promise<void>");
  const syncEnd = source.indexOf("private async findClientNetworkForRouter", syncStart);
  const syncBody = source.slice(syncStart, syncEnd);

  assert.equal(source.includes("collectLogicalRouterPorts(\n      snapshot?.routes ?? [],\n      snapshot?.listeners ?? [],"), true);
  assert.equal(source.includes("Host loopback belongs to processes outside logical networks"), true);
  assert.equal(source.includes("Host-side client attachments are the exception"), true);
  assert.equal(collectLogicalRouterPorts.includes('route.source === "compose"'), false);
  assert.equal(collectLogicalRouterPorts.includes("routeNeedsLogicalRouter(route)"), true);
  assert.equal(collectLogicalRouterPorts.includes("route.networkId === undefined || hostClientNetworkIds.has(route.networkId)"), true);
  assert.equal(source.includes("function collectHostClientAttachmentNetworkIds"), true);
  assert.equal(source.includes("function isHooklessHostClientAttachment"), true);
  assert.equal(source.includes("attachment.id.startsWith(PROCESS_TERMINAL_ATTACHMENT_ID_PREFIX)"), true);
  assert.equal(source.includes("attachment.id.startsWith(VSCODE_WINDOW_PROCESS_ATTACHMENT_ID_PREFIX)"), true);
  assert.equal(source.includes("function isDetachedNetworkRoute"), false);
  assert.equal(collectLogicalRouterPorts.includes("!externallyOwnedPorts.has(route.logicalPort)"), true);
  assert.equal(routeNeedsLogicalRouter.includes("route.actualPort !== route.logicalPort"), true);
  assert.equal(routeNeedsLogicalRouter.includes("!listenerCoversLogicalRouterHost(route.host)"), true);
  assert.equal(collectLogicalRouterPorts.includes("listenerCoversLogicalRouterHost(listener.localAddress)"), true);
  assert.equal(source.includes("function listenerCoversLogicalRouterHost"), true);
  assert.equal(source.includes("function endpointHostMatches"), true);
  assert.equal(source.includes("function isGeneratedLoopbackHost"), true);
  assert.equal(
    syncBody.includes("await this.logicalPortRouter.sync(logicalPorts).catch(() => undefined);"),
    true,
    "unscoped host routes can still use a localhost TCP router fallback",
  );
});

test("logical router classifies clients by process tree label before hook environment fallback", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const methodStart = source.indexOf("private async findClientNetworkForRouter");
  const methodEnd = source.indexOf("private async findNetworkRouteForRouter", methodStart);
  const findClientNetworkForRouter = source.slice(methodStart, methodEnd);
  const networkRouteStart = source.indexOf("private async findNetworkRouteForRouter");
  const networkRouteEnd = source.indexOf("private async findUniqueRouteForRouter", networkRouteStart);
  const findNetworkRouteForRouter = source.slice(networkRouteStart, networkRouteEnd);
  const uniqueRouteStart = source.indexOf("private async findUniqueRouteForRouter");
  const uniqueRouteEnd = source.indexOf("private findClientCwdRouteForRouter", uniqueRouteStart);
  const findUniqueRouteForRouter = source.slice(uniqueRouteStart, uniqueRouteEnd);
  const cwdRouteStart = source.indexOf("private findClientCwdRouteForRouter");
  const cwdRouteEnd = source.indexOf("private findAttachedNetworkForPid", cwdRouteStart);
  const findClientCwdRouteForRouter = source.slice(cwdRouteStart, cwdRouteEnd);

  assert.equal(source.includes('from "../core/process-network-labels"'), true);
  assert.equal(
    findClientNetworkForRouter.indexOf("this.findAttachedNetworkForPid(pid, processRows)") <
      findClientNetworkForRouter.indexOf("this.processEnvironmentProvider.readRoutingNetworkId(pid)"),
    true,
    "process tree labels must be the primary router signal; inherited hook env remains fallback",
  );
  assert.equal(findClientNetworkForRouter.includes("return environmentNetworkId;"), true);
  assert.equal(
    findNetworkRouteForRouter.includes("return candidates.length === 1 ? candidates[0] : undefined;"),
    false,
    "known-network router clients must not fall back to another network's sole route",
  );
  assert.equal(source.includes("explicit unscoped host routes"), true);
  assert.equal(findUniqueRouteForRouter.includes("route.networkId === undefined"), true);
  assert.equal(findUniqueRouteForRouter.includes("candidates.filter((route) => !isNetworkScopedComposeRoute(route))"), false);
  assert.equal(source.includes("function isNetworkScopedComposeRoute"), false);
  assert.equal(source.includes("findSingleAttachedRouteForRouter"), false);
  assert.equal(findUniqueRouteForRouter.includes("return undefined;"), true);
  assert.equal(findClientCwdRouteForRouter.includes("return undefined;"), true);
  assert.equal(
    findClientCwdRouteForRouter.includes(".attachments.filter((attachment) => attachment.status === \"attached\")"),
    false,
  );
});

test("compose reconciliation removes orphan daemon route rows before runtime refresh", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const reconcileStart = source.indexOf("private async reconcileComposeAttachmentPublishedPortsExclusive");
  const reconcileEnd = source.indexOf("private async removeOrphanComposeRouteProcesses", reconcileStart);
  const reconcileBody = source.slice(reconcileStart, reconcileEnd);
  const cleanupStart = source.indexOf("private async removeOrphanComposeRouteProcesses");
  const cleanupEnd = source.indexOf("private async replaceComposeRouteProcesses", cleanupStart);
  const cleanupBody = source.slice(cleanupStart, cleanupEnd);

  assert.notEqual(reconcileStart, -1);
  assert.notEqual(cleanupStart, -1);
  assert.equal(source.includes("private async refreshComposeRouteProcessSnapshot(): Promise<void>"), true);
  assert.equal(reconcileBody.includes("await this.refreshComposeRouteProcessSnapshot();"), true);
  assert.equal(
    reconcileBody.indexOf("await this.refreshComposeRouteProcessSnapshot();") <
      reconcileBody.indexOf("await this.removeOrphanComposeRouteProcesses(attachments);"),
    true,
    "daemon snapshot must be loaded before stale compose process rows are removed",
  );
  assert.equal(source.includes("await this.processService.start().catch(() => undefined);"), true);
  assert.equal(source.includes("await this.processService.refresh().catch(() => undefined);"), true);
  assert.equal(reconcileBody.includes("await this.removeOrphanComposeRouteProcesses(attachments);"), true);
  assert.equal(
    reconcileBody.indexOf("await this.removeOrphanComposeRouteProcesses(attachments);") <
      reconcileBody.indexOf("if (targetAttachments.length === 0)"),
    true,
    "stale compose daemon rows must be removed even when no persisted compose attachment remains",
  );
  assert.equal(cleanupBody.includes('process.source === "compose"'), true);
  assert.equal(cleanupBody.includes("composeRouteProcessKey(process.networkId, process.requestedPort)"), true);
  assert.equal(cleanupBody.includes("this.processService!.removeProcess(processId)"), true);
});

test("logical network service persists registry-normalized shared state", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const constructorStart = source.indexOf("constructor(");
  const constructorEnd = source.indexOf("  /** Loads terminal candidates", constructorStart);
  const constructorBody = source.slice(constructorStart, constructorEnd);
  const reloadStart = source.indexOf("private async reloadSharedNetworkState");
  const reloadEnd = source.indexOf("private loadVscodeWindowTerminalBinding", reloadStart);
  const reloadBody = source.slice(reloadStart, reloadEnd);
  const helperStart = source.indexOf("private saveNormalizedPersistedStateIfChanged");
  const helperEnd = source.indexOf("private async reloadSharedNetworkState", helperStart);
  const helperBody = source.slice(helperStart, helperEnd);

  assert.notEqual(helperStart, -1);
  assert.equal(constructorBody.includes("const loadedState = this.loadState();"), true);
  assert.equal(constructorBody.includes("this.saveNormalizedPersistedStateIfChanged();"), true);
  assert.equal(reloadBody.includes("this.saveNormalizedPersistedStateIfChanged();"), true);
  assert.equal(reloadBody.includes("this.syncVscodeWindowProcessAttachment();"), true);
  assert.equal(helperBody.includes("this.registry.getPersistedState()"), true);
  assert.equal(helperBody.includes("this.saveState({ force: true });"), true);
});

test("compose mutation publishes hidden ports on the network loopback host", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const attachStart = source.indexOf("async attachComposePublishedPorts");
  const attachEnd = source.indexOf("private async runTerminalAttachmentRefreshBurstStep", attachStart);
  const attachBody = source.slice(attachStart, attachEnd);

  assert.notEqual(attachStart, -1);
  assert.equal(attachBody.includes("const hiddenHostAddress = loopbackAddressForNetwork(network.id);"), true);
  // Interactive attach goes through the consolidated setup so one admin
  // approval prepares aliases for every network, not just the attached one.
  assert.equal(attachBody.includes("await this.ensureTerminalRoutingHostReadyForNetwork(network, loopbackMode);"), true);
  assert.equal(attachBody.includes("resolveTerminalLoopbackAddressRoutingMode(portSettings)"), true);
  assert.equal(attachBody.includes("hiddenHostAddress,"), true);
});

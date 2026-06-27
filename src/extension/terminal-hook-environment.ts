import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAgentSocketPath } from "../agent/agent-socket";
import {
  getDefaultHostAccessBindingsPath,
  getDefaultRouteTablePath,
  getRouteTablePathForNetwork,
} from "../agent/route-table";
import { readPortManagerSettings } from "../config/vscode-settings";
import type { DisposableLike, PortManagerSettings } from "../shared/types";
import {
  buildComposeProjectRoutingFunctionScript,
  buildRuntimeCommandShimScript,
} from "./compose-project-routing";

/**
 * Keeps new VS Code terminals on the pre-bind routing path.
 *
 * The terminal conflict monitor is only a recovery path after a process has
 * already failed. This module injects the native hook and daemon settings into
 * terminal environments so non-fixed protocol ports can be allocated before
 * bind() reaches the operating system.
 */

const TERMINAL_MUTATOR_OPTIONS: vscode.EnvironmentVariableMutatorOptions = {
  applyAtProcessCreation: true,
  applyAtShellIntegration: true,
};

export const RUNTIME_SHIM_DIRECTORY_ENV = "PORT_MANAGER_RUNTIME_SHIM_DIR";
export const DOCKER_SHIM_PATH_ENV = "PORT_MANAGER_DOCKER_SHIM";
const PRELOAD_PACKAGE_MANAGER_NAMES = ["npm", "npx", "pnpm", "pnpx", "corepack", "uv", "uvx", "yarn", "yarnpkg"];
// These names are project-bin commands that commonly bind or probe dev ports.
// Package managers are intentionally excluded so install/link lifecycle work
// does not inherit socket routing unless the invoked tool crosses a runtime
// shim boundary later.
const PRELOAD_PACKAGE_COMMAND_NAMES = [
  "celery",
  "vite",
  "uvicorn",
  "gunicorn",
  "daphne",
  "concurrently",
  "dotenv",
  "wait-on",
  "retry",
];

export interface TerminalHookEnvironmentScope {
  /** Logical network applied to every new VS Code terminal in this extension host. */
  readonly networkId: string;
  /** Display name used by shell startup hooks to label attached terminals. */
  readonly networkName?: string;
  /** Dynamic Compose/container routing map consumed by Docker/Podman shims. */
  readonly composeRoutingFilePath?: string;
}

/** Applies and refreshes terminal environment variables owned by Port Manager. */
export function configureTerminalHookEnvironment(
  context: vscode.ExtensionContext,
  scopeProvider: () => TerminalHookEnvironmentScope | undefined = () => undefined,
): DisposableLike {
  const applyEnvironment = () => {
    applyTerminalHookEnvironment(context, scopeProvider());
  };
  const configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("portManager")) {
      applyEnvironment();
    }
  });

  applyEnvironment();

  return {
    dispose: () => {
      configurationSubscription.dispose();
      context.environmentVariableCollection.clear();
    },
  };
}

/** Replaces the extension-owned terminal env collection from current settings. */
export function applyTerminalHookEnvironment(
  context: vscode.ExtensionContext,
  scope: TerminalHookEnvironmentScope | undefined,
): void {
  const collection = context.environmentVariableCollection;
  const settings = readPortManagerSettings();

  collection.clear();
  collection.persistent = false;
  collection.description = "Port Manager routes terminal TCP binds through the local daemon.";

  if (scope === undefined) {
    return;
  }

  if (!shouldInjectTerminalHook(settings)) {
    return;
  }

  const hookLibraryPath = context.asAbsolutePath(getHookLibraryRelativePath());
  const agentMainPath = context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
  const nativeAgentPath = context.asAbsolutePath(path.join("media", "native", "portmanager_agent"));
  const nativeContainerMapPath = context.asAbsolutePath(path.join("media", "native", "portmanager_container_map"));
  const asdfShimLauncherPath = context.asAbsolutePath(getAsdfShimLauncherRelativePath());
  const runtimeCommandShimPath = context.asAbsolutePath(getRuntimeCommandShimRelativePath());
  const shellEnvRestorePath = prepareShellEnvRestoreScript(context.globalStorageUri.fsPath, hookLibraryPath, {
    networkId: scope.networkId,
    agentSocketPath: getAgentSocketPath(),
    agentMainPath,
    agentExecutablePath: nativeAgentPath,
    containerMapHelperPath: nativeContainerMapPath,
    globalRouteTablePath: getDefaultRouteTablePath(),
    hostAccessFilePath: getDefaultHostAccessBindingsPath(),
    settings,
    composeRoutingFilePath: scope.composeRoutingFilePath,
    dockerShimPath: runtimeCommandShimPath,
  });
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";

  collection.replace("PORT_MANAGER_HOOK", "1", TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  if (scope.networkName !== undefined) {
    collection.replace("PORT_MANAGER_NETWORK_NAME", scope.networkName, TERMINAL_MUTATOR_OPTIONS);
  }
  collection.replace("PORT_MANAGER_ROUTE_TABLE_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_BORROWED_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("NEWDLOPS_PM_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("NEWDLOPS_PM_BORROWED_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath(), TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_MAIN", agentMainPath, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_EXECUTABLE", nativeAgentPath, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_CONTAINER_MAP_HELPER", nativeContainerMapPath, TERMINAL_MUTATOR_OPTIONS);
  collection.replace(DOCKER_SHIM_PATH_ENV, runtimeCommandShimPath, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_ROUTES_FILE", getRouteTablePathForNetwork(scope.networkId), TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_GLOBAL_ROUTES_FILE", getDefaultRouteTablePath(), TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_HOST_ACCESS_FILE", getDefaultHostAccessBindingsPath(), TERMINAL_MUTATOR_OPTIONS);
  if (scope.composeRoutingFilePath !== undefined) {
    collection.replace("PORT_MANAGER_COMPOSE_ROUTING_FILE", scope.composeRoutingFilePath, TERMINAL_MUTATOR_OPTIONS);
  }
  applyRoutingSettings(collection, settings);
  collection.prepend(preloadVariable, `${hookLibraryPath}${path.delimiter}`, TERMINAL_MUTATOR_OPTIONS);
  applyRuntimeShimLauncherPath(collection, context.globalStorageUri.fsPath, asdfShimLauncherPath, runtimeCommandShimPath);

  if (shellEnvRestorePath !== undefined) {
    collection.replace("PORT_MANAGER_DYLD_INSERT_LIBRARIES", hookLibraryPath, TERMINAL_MUTATOR_OPTIONS);
    collection.replace("BASH_ENV", shellEnvRestorePath, TERMINAL_MUTATOR_OPTIONS);
  }
}

/** Mirrors user routing policy into the native hook's simple env contract. */
function applyRoutingSettings(
  collection: vscode.EnvironmentVariableCollection,
  settings: PortManagerSettings,
): void {
  collection.replace("PORT_MANAGER_SCAN_RANGE", String(settings.scanRange), TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_ROUTING_MODE", settings.routingMode, TERMINAL_MUTATOR_OPTIONS);
  collection.replace(
    "PORT_MANAGER_VIRTUAL_PORT_START",
    String(settings.virtualPortRangeStart),
    TERMINAL_MUTATOR_OPTIONS,
  );
  collection.replace(
    "PORT_MANAGER_VIRTUAL_PORT_END",
    String(settings.virtualPortRangeEnd),
    TERMINAL_MUTATOR_OPTIONS,
  );
  collection.replace(
    "PORT_MANAGER_FIXED_PROTOCOL_PORTS",
    settings.fixedProtocolPorts.join(","),
    TERMINAL_MUTATOR_OPTIONS,
  );
  collection.replace(
    "PORT_MANAGER_PRESERVE_LISTEN_PORTS",
    settings.preservedListenPorts.join(","),
    TERMINAL_MUTATOR_OPTIONS,
  );
}

/** True when the current terminal platform can do pre-bind hook routing. */
export function shouldInjectTerminalHook(settings: PortManagerSettings): boolean {
  return settings.enabled && isNativeTerminalHookSupported();
}

/**
 * Creates a PATH directory that shadows only commands which need routing-aware
 * launch behavior. Generic runtime names such as node stay off this PATH so
 * arbitrary package tools with /usr/bin/env shebangs do not inherit routing.
 *
 * This is not part of routing policy. It only keeps the preload hook present at
 * selected command boundaries so bind/connect can still be routed for servers.
 */
export function prepareRuntimeShimLauncherDirectory(
  baseDirectory: string,
  launcherPath: string,
  runtimeCommandShimPath?: string,
): string | undefined {
  const targetDirectory = path.join(baseDirectory, "runtime-shims");
  fs.mkdirSync(targetDirectory, { recursive: true });
  removeLegacyPreloadPackageManagerShims(targetDirectory, launcherPath);
  removeStaleBroadRuntimeLauncherAliases(targetDirectory, launcherPath);
  writeRuntimeCommandShims(targetDirectory, runtimeCommandShimPath);
  writePreloadPackageManagerCommandShims(targetDirectory);
  writePreloadPackageCommandShims(targetDirectory);

  return targetDirectory;
}

/**
 * Older builds generated package-manager shims that always repaired preload.
 * Replace only extension-owned copies so dependency lifecycle commands stay
 * outside routing unless the script positively looks like a dev server.
 */
function removeLegacyPreloadPackageManagerShims(targetDirectory: string, launcherPath: string): void {
  for (const commandName of PRELOAD_PACKAGE_MANAGER_NAMES) {
    const shimPath = path.join(targetDirectory, commandName);
    if (isExtensionOwnedPreloadShim(shimPath, launcherPath)) {
      fs.rmSync(shimPath, { force: true });
    }
  }
}

function isExtensionOwnedPreloadShim(filePath: string, launcherPath: string): boolean {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      const target = fs.readlinkSync(filePath);
      return target === launcherPath || path.resolve(path.dirname(filePath), target) === launcherPath;
    }

    const existing = fs.statSync(filePath);
    if (fs.existsSync(launcherPath)) {
      const launcher = fs.statSync(launcherPath);
      if (existing.dev === launcher.dev && existing.ino === launcher.ino) {
        return true;
      }
    }

    const contents = fs.readFileSync(filePath, "utf8");
    return contents.includes("# Generated by Port Manager. Keeps package-bin client tools on the preload path.");
  } catch {
    return false;
  }
}

/**
 * Older builds mirrored almost every asdf shim into runtime-shims. That made
 * ordinary package tools such as vsce inherit the native preload launcher during
 * install/package work. Keep only explicit runtime names on the native launcher.
 */
function removeStaleBroadRuntimeLauncherAliases(targetDirectory: string, launcherPath: string): void {
  for (const entry of fs.readdirSync(targetDirectory, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".") ||
      PRELOAD_PACKAGE_MANAGER_NAMES.includes(entry.name) ||
      PRELOAD_PACKAGE_COMMAND_NAMES.includes(entry.name) ||
      ["docker", "podman", "docker-compose", "podman-compose"].includes(entry.name)
    ) {
      continue;
    }

    const shimPath = path.join(targetDirectory, entry.name);
    if (isExecutableAliasTo(shimPath, launcherPath)) {
      fs.rmSync(shimPath, { force: true });
    }
  }
}

function isExecutableAliasTo(filePath: string, targetPath: string): boolean {
  try {
    const file = fs.lstatSync(filePath);
    if (file.isDirectory() && !file.isSymbolicLink()) {
      return false;
    }

    if (file.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(filePath);
      return linkTarget === targetPath || path.resolve(path.dirname(filePath), linkTarget) === targetPath;
    }

    const target = fs.statSync(targetPath);
    const existing = fs.statSync(filePath);
    return existing.dev === target.dev && existing.ino === target.ino;
  } catch {
    return false;
  }
}

/** Compatibility wrapper for older call sites and external imports. */
export function prepareAsdfShimLauncherDirectory(
  baseDirectory: string,
  launcherPath: string,
): string | undefined {
  return prepareRuntimeShimLauncherDirectory(baseDirectory, launcherPath);
}

/**
 * Creates a bash startup fragment that restores DYLD for non-interactive
 * project scripts. macOS strips DYLD_* when a shebang goes through protected
 * tools such as /usr/bin/env; BASH_ENV survives that boundary.
 */
export interface ShellEnvRestoreScope {
  /** Logical network scope that must survive protected shebang and bash boundaries. */
  readonly networkId?: string;
  /** Singleton daemon socket path; losing this can point native hooks at a different temp directory. */
  readonly agentSocketPath?: string;
  /** Agent entrypoint used by child-side readiness probes. */
  readonly agentMainPath?: string;
  /** Native daemon executable used when a child needs to start the singleton. */
  readonly agentExecutablePath?: string;
  /** Native helper used by runtime/container shims. */
  readonly containerMapHelperPath?: string;
  /** Global route table shared by all logical networks for this OS user. */
  readonly globalRouteTablePath?: string;
  /** Host access bindings shared by hook connect routing. */
  readonly hostAccessFilePath?: string;
  /** Routing settings mirrored into native hook environment variables. */
  readonly settings?: PortManagerSettings;
  /** Compose/container routing map needed by Docker/Podman shims in child scripts. */
  readonly composeRoutingFilePath?: string;
  /** Native Docker/Podman shim used when the preload hook catches absolute runtime paths. */
  readonly dockerShimPath?: string;
}

export function prepareShellEnvRestoreScript(
  baseDirectory: string,
  hookLibraryPath: string,
  scope: ShellEnvRestoreScope = {},
): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  const targetPath = path.join(baseDirectory, shellEnvRestoreFileName(scope));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buildShellEnvRestoreScript(scope, targetPath), "utf8");
  return targetPath;
}

/** Adds generated runtime launchers ahead of protected runtime entrypoints. */
function applyRuntimeShimLauncherPath(
  collection: vscode.EnvironmentVariableCollection,
  baseDirectory: string,
  launcherPath: string,
  runtimeCommandShimPath: string,
): void {
  const launcherDirectory = prepareRuntimeShimLauncherDirectory(baseDirectory, launcherPath, runtimeCommandShimPath);

  if (launcherDirectory !== undefined) {
    collection.replace(RUNTIME_SHIM_DIRECTORY_ENV, launcherDirectory, TERMINAL_MUTATOR_OPTIONS);
    collection.prepend("PATH", `${launcherDirectory}${path.delimiter}`, TERMINAL_MUTATOR_OPTIONS);
  }
}

/** The native hook currently ships only for POSIX preload mechanisms. */
function isNativeTerminalHookSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

/** Returns the packaged native hook library for the current OS. */
export function getHookLibraryRelativePath(): string {
  if (process.platform === "darwin") {
    return path.join("media", "native", "libportmanager_hook.dylib");
  }

  return path.join("media", "native", "libportmanager_hook.so");
}

/** Returns the packaged native launcher used to bypass macOS asdf shim scripts. */
export function getAsdfShimLauncherRelativePath(): string {
  return path.join("media", "native", "portmanager_asdf_shim");
}

/** Returns the packaged native Docker/Podman PATH shim. */
export function getRuntimeCommandShimRelativePath(): string {
  return path.join("media", "native", "portmanager_docker_shim");
}

/**
 * Creates an executable alias that preserves argv[0] even when child launchers
 * resolve PATH entries through realpath before exec. A symlink loses the tool
 * name in that flow, while a hard link keeps the invoked basename.
 */
function ensureExecutableAlias(linkPath: string, targetPath: string): void {
  try {
    const targetStat = fs.statSync(targetPath);
    const existingPath = fs.lstatSync(linkPath);
    if (existingPath.isDirectory() && !existingPath.isSymbolicLink()) {
      return;
    }

    if (!existingPath.isSymbolicLink()) {
      const existingStat = fs.statSync(linkPath);
      if (existingStat.dev === targetStat.dev && existingStat.ino === targetStat.ino) {
        return;
      }
    }
  } catch {
    // Missing aliases and inaccessible stale entries are replaced below.
  }

  fs.rmSync(linkPath, { force: true });
  try {
    fs.linkSync(targetPath, linkPath);
  } catch {
    fs.symlinkSync(targetPath, linkPath);
  }
}

/** Replaces stale extension-owned symlinks while leaving matching links alone. */
function ensureSymlink(linkPath: string, targetPath: string): void {
  try {
    if (fs.readlinkSync(linkPath) === targetPath) {
      return;
    }
  } catch {
    // Missing or non-symlink paths are replaced inside the extension-owned dir.
  }

  try {
    const existingPath = fs.lstatSync(linkPath);
    if (existingPath.isDirectory() && !existingPath.isSymbolicLink()) {
      return;
    }
  } catch {
    // The desired link does not exist yet.
  }

  fs.rmSync(linkPath, { force: true });
  fs.symlinkSync(targetPath, linkPath);
}

function writeRuntimeCommandShims(targetDirectory: string, runtimeCommandShimPath: string | undefined): void {
  if (runtimeCommandShimPath !== undefined && fs.existsSync(runtimeCommandShimPath)) {
    ensureExecutableAlias(path.join(targetDirectory, "docker"), runtimeCommandShimPath);
    ensureExecutableAlias(path.join(targetDirectory, "podman"), runtimeCommandShimPath);
    ensureExecutableAlias(path.join(targetDirectory, "docker-compose"), runtimeCommandShimPath);
    ensureExecutableAlias(path.join(targetDirectory, "podman-compose"), runtimeCommandShimPath);
    return;
  }

  writeRuntimeCommandShim(path.join(targetDirectory, "docker"), buildRuntimeCommandShimScript("docker"));
  writeRuntimeCommandShim(path.join(targetDirectory, "podman"), buildRuntimeCommandShimScript("podman"));
  writeRuntimeCommandShim(path.join(targetDirectory, "docker-compose"), buildRuntimeCommandShimScript("docker-compose"));
  writeRuntimeCommandShim(path.join(targetDirectory, "podman-compose"), buildRuntimeCommandShimScript("podman-compose"));
}

function writePreloadPackageCommandShims(targetDirectory: string): void {
  const shimScript = buildPreloadPackageCommandShimScript();

  for (const commandName of PRELOAD_PACKAGE_COMMAND_NAMES) {
    writeRuntimeCommandShim(path.join(targetDirectory, commandName), shimScript);
  }
}

function writePreloadPackageManagerCommandShims(targetDirectory: string): void {
  const shimScript = buildPreloadPackageManagerCommandShimScript();

  for (const commandName of PRELOAD_PACKAGE_MANAGER_NAMES) {
    writeRuntimeCommandShim(path.join(targetDirectory, commandName), shimScript);
  }
}

function writeRuntimeCommandShim(filePath: string, contents: string): void {
  try {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === contents) {
      fs.chmodSync(filePath, 0o700);
      return;
    }
  } catch {
    // Missing, unreadable, or non-file paths are replaced below.
  }

  fs.rmSync(filePath, { recursive: true, force: true });
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o700 });
}

/**
 * Protected shebang launchers such as /usr/bin/env can strip DYLD before Node
 * starts. This shell fragment resolves the JavaScript entrypoint first and runs
 * it through the extension-owned runtime shim so the real runtime receives the
 * preload environment directly.
 */
function buildPreloadNodeEntrypointBypassShell(): string {
  return `__pm_unwrapped="\${__pm_target}"
__pm_exec_target="$(sed -n 's/.*exec "\\([^"]*\\)".*/\\1/p' "\${__pm_target}" 2>/dev/null | head -n 1)"
__pm_exec_script="$(sed -n 's/.*exec "[^"]*" "\\([^"]*\\)".*/\\1/p' "\${__pm_target}" 2>/dev/null | head -n 1)"
case "\${__pm_exec_target##*/}:\${__pm_exec_script}" in
  node:/*|nodejs:/*)
    if [ -f "\${__pm_exec_script}" ]; then
      __pm_node="\${PORT_MANAGER_RUNTIME_SHIM_DIR:-}/node"
      if [ -x "\${__pm_node}" ]; then
        exec "\${__pm_node}" "\${__pm_exec_script}" "$@"
      fi
      exec "\${__pm_exec_target}" "\${__pm_exec_script}" "$@"
    fi
    ;;
esac
case "\${__pm_exec_target}" in
  /*)
    if [ -f "\${__pm_exec_target}" ]; then
      __pm_unwrapped="\${__pm_exec_target}"
    fi
    ;;
esac

__pm_first_line="$(IFS= read -r __pm_line < "\${__pm_unwrapped}" && printf '%s' "\${__pm_line}")"
case "\${__pm_first_line}" in
  '#!'*'/usr/bin/env node'*|'#!'*' env node'*)
    __pm_node="\${PORT_MANAGER_RUNTIME_SHIM_DIR:-}/node"
    if [ -x "\${__pm_node}" ]; then
      exec "\${__pm_node}" "\${__pm_unwrapped}" "$@"
    fi
    exec node "\${__pm_unwrapped}" "$@"
    ;;
esac

exec "\${__pm_target}" "$@"`;
}

function buildPreloadPackageCommandShimScript(): string {
  return `#!/bin/sh
# Generated by Port Manager. Keeps package-bin client tools on the preload path.
__pm_name="\${0##*/}"
__pm_shim_dir="$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd -P)"
__pm_marker="# Generated by Port Manager. Keeps package-bin client tools on the preload path."

__pm_is_package_command_shim() {
  [ -f "$1" ] || return 1
  __pm_candidate_first_line="$(IFS= read -r __pm_line < "$1" && printf '%s' "\${__pm_line}")"
  [ "\${__pm_candidate_first_line}" = '#!/bin/sh' ] || return 1
  __pm_candidate_second_line="$(sed -n '2p' "$1" 2>/dev/null)"
  [ "\${__pm_candidate_second_line}" = "\${__pm_marker}" ]
}

__pm_find_next_command() {
  __pm_old_ifs="\${IFS}"
  IFS=:
  for __pm_dir in \${PATH:-}; do
    [ -n "\${__pm_dir}" ] || __pm_dir="."
    __pm_dir_physical="$(CDPATH= cd "\${__pm_dir}" 2>/dev/null && pwd -P)"
    [ -n "\${__pm_dir_physical}" ] || __pm_dir_physical="\${__pm_dir}"
    if [ "\${__pm_dir_physical}" = "\${__pm_shim_dir}" ]; then
      continue
    fi
    __pm_candidate="\${__pm_dir}/\${__pm_name}"
    if [ -f "\${__pm_candidate}" ] && [ -x "\${__pm_candidate}" ]; then
      if __pm_is_package_command_shim "\${__pm_candidate}"; then
        continue
      fi
      IFS="\${__pm_old_ifs}"
      printf '%s\\n' "\${__pm_candidate}"
      return 0
    fi
  done
  IFS="\${__pm_old_ifs}"
  return 1
}

__pm_target="$(__pm_find_next_command)" || {
  printf '%s\\n' "Port Manager: could not find command after shim: \${__pm_name}" >&2
  exit 127
}

export PORT_MANAGER_PRELOAD_REPAIR=1

if [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then
  case ":\${DYLD_INSERT_LIBRARIES:-}:" in
    *:"\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}":*) ;;
    *) export DYLD_INSERT_LIBRARIES="\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}\${DYLD_INSERT_LIBRARIES:+:$DYLD_INSERT_LIBRARIES}" ;;
  esac
fi

${buildPreloadNodeEntrypointBypassShell()}
`;
}

function buildPreloadPackageManagerCommandShimScript(): string {
  return `#!/bin/sh
# Generated by Port Manager. Routes package-manager dev server scripts only.
__pm_name="\${0##*/}"
__pm_shim_dir="$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd -P)"
__pm_marker="# Generated by Port Manager. Routes package-manager dev server scripts only."

__pm_is_package_manager_shim() {
  [ -f "$1" ] || return 1
  __pm_candidate_first_line="$(IFS= read -r __pm_line < "$1" && printf '%s' "\${__pm_line}")"
  [ "\${__pm_candidate_first_line}" = '#!/bin/sh' ] || return 1
  __pm_candidate_second_line="$(sed -n '2p' "$1" 2>/dev/null)"
  [ "\${__pm_candidate_second_line}" = "\${__pm_marker}" ]
}

__pm_find_next_command() {
  __pm_old_ifs="\${IFS}"
  IFS=:
  for __pm_dir in \${PATH:-}; do
    [ -n "\${__pm_dir}" ] || __pm_dir="."
    __pm_dir_physical="$(CDPATH= cd "\${__pm_dir}" 2>/dev/null && pwd -P)"
    [ -n "\${__pm_dir_physical}" ] || __pm_dir_physical="\${__pm_dir}"
    if [ "\${__pm_dir_physical}" = "\${__pm_shim_dir}" ]; then
      continue
    fi
    __pm_candidate="\${__pm_dir}/\${__pm_name}"
    if [ -f "\${__pm_candidate}" ] && [ -x "\${__pm_candidate}" ]; then
      if __pm_is_package_manager_shim "\${__pm_candidate}"; then
        continue
      fi
      IFS="\${__pm_old_ifs}"
      printf '%s\\n' "\${__pm_candidate}"
      return 0
    fi
  done
  IFS="\${__pm_old_ifs}"
  return 1
}

__pm_first_script_arg() {
  __pm_seen_run=0
  for __pm_arg do
    case "\${__pm_arg}" in
      --) __pm_seen_run=1; continue ;;
      -*) continue ;;
    esac
    if [ "\${__pm_arg}" = "run" ] || [ "\${__pm_arg}" = "run-script" ]; then
      __pm_seen_run=1
      continue
    fi
    printf '%s\\n' "\${__pm_arg}"
    return 0
  done
  return 1
}

__pm_package_script_text() {
  __pm_script_name="$1"
  [ -n "\${__pm_script_name}" ] || return 1
  [ -f package.json ] || return 1
  sed -n "s/.*\\\"\${__pm_script_name}\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" package.json 2>/dev/null | head -n 1
}

__pm_text_looks_like_dev_server() {
  __pm_text="$(printf '%s' "$*" | tr '[:upper:]' '[:lower:]')"
  case "\${__pm_text}" in
    *vite*|*next\\ dev*|*nuxt\\ dev*|*storybook\\ dev*|*webpack-dev-server*|*react-scripts\\ start*|*vue-cli-service\\ serve*|*astro\\ dev*|*svelte-kit*|*remix\\ vite:dev*|*uvicorn*|*gunicorn*|*daphne*|*runserver*|*flask\\ run*|*rails\\ server*|*php\\ -s*|*serve\\ --listen*|*http-server*|*--host*|*--port*|*" -p "*|*vite_client_port=*|*port=*)
      return 0
      ;;
  esac
  return 1
}

__pm_target="$(__pm_find_next_command)" || {
  printf '%s\\n' "Port Manager: could not find command after shim: \${__pm_name}" >&2
  exit 127
}

# Dependency lifecycle commands should not resolve nested /usr/bin/env node
# through Port Manager runtime shims; that re-enters preload routing during
# install/link work and can be killed by the operating system.
__pm_path_entry_is_runtime_shim_dir() {
  __pm_entry="$1"
  [ -n "\${__pm_entry}" ] || return 1

  __pm_entry_physical="$(CDPATH= cd "\${__pm_entry}" 2>/dev/null && pwd -P)"
  [ -n "\${__pm_entry_physical}" ] || __pm_entry_physical="\${__pm_entry}"

  if [ "\${__pm_entry_physical}" = "\${__pm_shim_dir}" ]; then
    return 0
  fi

  if [ -n "\${PORT_MANAGER_RUNTIME_SHIM_DIR:-}" ]; then
    __pm_runtime_physical="$(CDPATH= cd "\${PORT_MANAGER_RUNTIME_SHIM_DIR}" 2>/dev/null && pwd -P)"
    [ -n "\${__pm_runtime_physical}" ] || __pm_runtime_physical="\${PORT_MANAGER_RUNTIME_SHIM_DIR}"
    if [ "\${__pm_entry_physical}" = "\${__pm_runtime_physical}" ]; then
      return 0
    fi
  fi

  for __pm_probe in npm yarn pnpm; do
    if [ -f "\${__pm_entry}/\${__pm_probe}" ] && [ "$(sed -n 2p "\${__pm_entry}/\${__pm_probe}" 2>/dev/null)" = "\${__pm_marker}" ]; then
      return 0
    fi
  done

  return 1
}

__pm_strip_port_manager_runtime_shims_from_path() {
  __pm_clean_path=""
  __pm_old_ifs="\${IFS}"
  IFS=:
  for __pm_dir in \${PATH:-}; do
    if __pm_path_entry_is_runtime_shim_dir "\${__pm_dir}"; then
      continue
    fi
    if [ -z "\${__pm_clean_path}" ]; then
      __pm_clean_path="\${__pm_dir}"
    else
      __pm_clean_path="\${__pm_clean_path}:\${__pm_dir}"
    fi
  done
  IFS="\${__pm_old_ifs}"
  export PATH="\${__pm_clean_path}"
  unset __pm_dir __pm_clean_path __pm_old_ifs
}

__pm_exec_without_port_manager_preload() {
  __pm_strip_port_manager_runtime_shims_from_path
  unset PORT_MANAGER_PRELOAD_REPAIR
  unset PORT_MANAGER_RUNTIME_SHIM_DIR
  unset PORT_MANAGER_PREV_BASH_ENV
  unset BASH_ENV
  unset ENV
  unset DYLD_INSERT_LIBRARIES
  unset LD_PRELOAD
  export PORT_MANAGER_HOOK=0
  export PORT_MANAGER_HOOK_DISABLED=1
  exec "\${__pm_target}" "$@"
}

__pm_script_name="$(__pm_first_script_arg "$@" 2>/dev/null || true)"
__pm_script_text="$(__pm_package_script_text "\${__pm_script_name}" 2>/dev/null || true)"
if __pm_text_looks_like_dev_server "$*" "\${npm_lifecycle_script:-}" "\${__pm_script_text}"; then
  export PORT_MANAGER_PRELOAD_REPAIR=1
  if [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then
    case ":\${DYLD_INSERT_LIBRARIES:-}:" in
      *:"\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}":*) ;;
      *) export DYLD_INSERT_LIBRARIES="\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}\${DYLD_INSERT_LIBRARIES:+:$DYLD_INSERT_LIBRARIES}" ;;
    esac
  fi
  ${buildPreloadNodeEntrypointBypassShell()}
fi

__pm_exec_without_port_manager_preload "$@"
`;
}


function shellEnvRestoreFileName(scope: ShellEnvRestoreScope): string {
  if (scope.networkId === undefined) {
    return "portmanager-bash-env.sh";
  }

  return `portmanager-bash-env-${sanitizeFileNamePart(scope.networkId)}.sh`;
}

function sanitizeFileNamePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
  return sanitized.length > 0 ? sanitized : "network";
}

function buildShellEnvRestoreScript(scope: ShellEnvRestoreScope, scriptPath: string): string {
  const globalRouteTablePath = scope.globalRouteTablePath ?? getDefaultRouteTablePath();
  const hostAccessFilePath = scope.hostAccessFilePath ?? getDefaultHostAccessBindingsPath();
  const routeTableExports =
    scope.networkId === undefined
      ? `if [ -z "\${PORT_MANAGER_ROUTES_FILE:-}" ]; then
  export PORT_MANAGER_ROUTES_FILE=${shellQuote(globalRouteTablePath)}
fi
if [ -z "\${PORT_MANAGER_GLOBAL_ROUTES_FILE:-}" ]; then
  export PORT_MANAGER_GLOBAL_ROUTES_FILE=${shellQuote(globalRouteTablePath)}
fi`
      : `export PORT_MANAGER_ROUTES_FILE=${shellQuote(getRouteTablePathForNetwork(scope.networkId))}
export PORT_MANAGER_GLOBAL_ROUTES_FILE=${shellQuote(globalRouteTablePath)}`;
  const networkScope =
    scope.networkId === undefined
      ? `if [ -z "\${PORT_MANAGER_NETWORK_ID:-}" ] && [ -n "\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID:-}" ]; then
  export PORT_MANAGER_NETWORK_ID="\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID}"
fi

if [ -z "\${PORT_MANAGER_NETWORK_ID:-}" ] && [ -n "\${PORT_MANAGER_BORROWED_NETWORK_ID:-}" ]; then
  export PORT_MANAGER_NETWORK_ID="\${PORT_MANAGER_BORROWED_NETWORK_ID}"
fi

if [ -z "\${PORT_MANAGER_NETWORK_ID:-}" ] && [ -n "\${NEWDLOPS_PM_NETWORK_ID:-}" ]; then
  export PORT_MANAGER_NETWORK_ID="\${NEWDLOPS_PM_NETWORK_ID}"
fi

if [ -z "\${PORT_MANAGER_NETWORK_ID:-}" ] && [ -n "\${NEWDLOPS_PM_BORROWED_NETWORK_ID:-}" ]; then
  export PORT_MANAGER_NETWORK_ID="\${NEWDLOPS_PM_BORROWED_NETWORK_ID}"
fi`
      : `export PORT_MANAGER_HOOK=1
export PORT_MANAGER_NETWORK_ID=${shellQuote(scope.networkId)}
export PORT_MANAGER_ROUTE_TABLE_NETWORK_ID=${shellQuote(scope.networkId)}
	export PORT_MANAGER_BORROWED_NETWORK_ID=${shellQuote(scope.networkId)}
	export NEWDLOPS_PM_NETWORK_ID=${shellQuote(scope.networkId)}
	export NEWDLOPS_PM_BORROWED_NETWORK_ID=${shellQuote(scope.networkId)}`;
  const composeRoutingExport =
    scope.composeRoutingFilePath === undefined
      ? ""
      : `export PORT_MANAGER_COMPOSE_ROUTING_FILE=${shellQuote(scope.composeRoutingFilePath)}`;
  const dockerShimExport =
    scope.dockerShimPath === undefined ? "" : `export ${DOCKER_SHIM_PATH_ENV}=${shellQuote(scope.dockerShimPath)}`;
  const agentExports = [
    scope.agentSocketPath === undefined ? "" : `export PORT_MANAGER_AGENT_SOCKET=${shellQuote(scope.agentSocketPath)}`,
    scope.agentMainPath === undefined ? "" : `export PORT_MANAGER_AGENT_MAIN=${shellQuote(scope.agentMainPath)}`,
    scope.agentExecutablePath === undefined
      ? ""
      : `export PORT_MANAGER_AGENT_EXECUTABLE=${shellQuote(scope.agentExecutablePath)}`,
    scope.containerMapHelperPath === undefined
      ? ""
      : `export PORT_MANAGER_CONTAINER_MAP_HELPER=${shellQuote(scope.containerMapHelperPath)}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  const routingExports =
    scope.settings === undefined
      ? ""
      : [
          `export PORT_MANAGER_SCAN_RANGE=${shellQuote(String(scope.settings.scanRange))}`,
          `export PORT_MANAGER_ROUTING_MODE=${shellQuote(scope.settings.routingMode)}`,
          `export PORT_MANAGER_VIRTUAL_PORT_START=${shellQuote(String(scope.settings.virtualPortRangeStart))}`,
          `export PORT_MANAGER_VIRTUAL_PORT_END=${shellQuote(String(scope.settings.virtualPortRangeEnd))}`,
          `export PORT_MANAGER_FIXED_PROTOCOL_PORTS=${shellQuote(scope.settings.fixedProtocolPorts.join(","))}`,
          `export PORT_MANAGER_PRESERVE_LISTEN_PORTS=${shellQuote(scope.settings.preservedListenPorts.join(","))}`,
        ].join("\n");

  return `# Generated by Port Manager. Sourced by non-interactive bash shells.
if [ -n "\${PORT_MANAGER_PREV_BASH_ENV:-}" ] && [ "\${PORT_MANAGER_PREV_BASH_ENV}" != ${shellQuote(
    scriptPath,
  )} ] && [ -r "\${PORT_MANAGER_PREV_BASH_ENV}" ]; then
  . "\${PORT_MANAGER_PREV_BASH_ENV}"
fi

${networkScope}
${routeTableExports}
${agentExports}
${routingExports}
${composeRoutingExport}
${dockerShimExport}

if [ -z "\${PORT_MANAGER_HOST_ACCESS_FILE:-}" ]; then
  export PORT_MANAGER_HOST_ACCESS_FILE=${shellQuote(hostAccessFilePath)}
fi

if [ "\${PORT_MANAGER_PRELOAD_REPAIR:-}" = "1" ] && [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then
  case ":\${DYLD_INSERT_LIBRARIES:-}:" in
    *:"\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}":*) ;;
    *) export DYLD_INSERT_LIBRARIES="\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}\${DYLD_INSERT_LIBRARIES:+:$DYLD_INSERT_LIBRARIES}" ;;
  esac
fi

if [ -n "\${PORT_MANAGER_RUNTIME_SHIM_DIR:-}" ]; then
  __pm_path_rest=""
  __pm_old_ifs="\${IFS}"
  IFS=:
  for __pm_path_entry in \${PATH:-}; do
    if [ "\${__pm_path_entry}" = "\${PORT_MANAGER_RUNTIME_SHIM_DIR}" ]; then
      continue
    fi
    if [ -z "\${__pm_path_rest}" ]; then
      __pm_path_rest="\${__pm_path_entry}"
    else
      __pm_path_rest="\${__pm_path_rest}:\${__pm_path_entry}"
    fi
  done
  IFS="\${__pm_old_ifs}"
  export PATH="\${PORT_MANAGER_RUNTIME_SHIM_DIR}\${__pm_path_rest:+:$__pm_path_rest}"
  unset __pm_path_entry __pm_path_rest __pm_old_ifs
  hash -r 2>/dev/null || true
fi

if [ -n "\${PORT_MANAGER_COMPOSE_ROUTING_FILE:-}" ]; then
${buildComposeProjectRoutingFunctionScript()}
fi
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
const PRELOAD_RUNTIME_LAUNCHER_NAMES = [
  "node",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "pnpx",
  "corepack",
  "uv",
  "uvx",
  "python",
  "python3",
  "python3.8",
  "python3.9",
  "python3.10",
  "python3.11",
  "python3.12",
  "python3.13",
  "python3.14",
  "ruby",
  "php",
  "perl",
  "vite",
  "concurrently",
  "dotenv",
  "wait-on",
  "retry",
];

export interface TerminalHookEnvironmentScope {
  /** Logical network applied to every new VS Code terminal in this extension host. */
  readonly networkId: string;
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
  });
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";

  collection.replace("PORT_MANAGER_HOOK", "1", TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_ROUTE_TABLE_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_BORROWED_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("NEWDLOPS_PM_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("NEWDLOPS_PM_BORROWED_NETWORK_ID", scope.networkId, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath(), TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_MAIN", agentMainPath, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_EXECUTABLE", nativeAgentPath, TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_CONTAINER_MAP_HELPER", nativeContainerMapPath, TERMINAL_MUTATOR_OPTIONS);
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
}

/** True when the current terminal platform can do pre-bind hook routing. */
export function shouldInjectTerminalHook(settings: PortManagerSettings): boolean {
  return settings.enabled && isNativeTerminalHookSupported();
}

/**
 * Creates a PATH directory that shadows common runtime names with native
 * launchers. This preserves DYLD_INSERT_LIBRARIES for the real server process
 * on macOS, where protected launch boundaries can strip DYLD_* variables.
 *
 * This is not part of routing policy. It only keeps the preload hook present
 * so bind/connect can still be routed from the socket address and port.
 */
export function prepareRuntimeShimLauncherDirectory(
  baseDirectory: string,
  launcherPath: string,
  runtimeCommandShimPath?: string,
): string | undefined {
  const sourceShimDirectory = getAsdfShimDirectory();
  const targetDirectory = path.join(baseDirectory, "runtime-shims");
  fs.mkdirSync(targetDirectory, { recursive: true });
  writeRuntimeCommandShims(targetDirectory, runtimeCommandShimPath);

  if (process.platform !== "darwin" || !fs.existsSync(launcherPath)) {
    return targetDirectory;
  }

  for (const runtimeName of PRELOAD_RUNTIME_LAUNCHER_NAMES) {
    ensureSymlink(path.join(targetDirectory, runtimeName), launcherPath);
  }

  if (sourceShimDirectory !== undefined) {
    for (const entry of fs.readdirSync(sourceShimDirectory, { withFileTypes: true })) {
      if (entry.name === "asdf" || entry.name.startsWith(".") || (!entry.isFile() && !entry.isSymbolicLink())) {
        continue;
      }

      ensureSymlink(path.join(targetDirectory, entry.name), launcherPath);
    }
  }

  return targetDirectory;
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

/** Locates the user's asdf shim directory without requiring asdf to be loaded. */
function getAsdfShimDirectory(): string | undefined {
  const asdfDataDirectory = process.env.ASDF_DATA_DIR ?? path.join(os.homedir(), ".asdf");
  const shimDirectory = path.join(asdfDataDirectory, "shims");

  return fs.existsSync(shimDirectory) ? shimDirectory : undefined;
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
    ensureSymlink(path.join(targetDirectory, "docker"), runtimeCommandShimPath);
    ensureSymlink(path.join(targetDirectory, "podman"), runtimeCommandShimPath);
    return;
  }

  writeRuntimeCommandShim(path.join(targetDirectory, "docker"), buildRuntimeCommandShimScript("docker"));
  writeRuntimeCommandShim(path.join(targetDirectory, "podman"), buildRuntimeCommandShimScript("podman"));
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

  return `# Generated by Port Manager. Sourced by non-interactive bash shells.
if [ -n "\${PORT_MANAGER_PREV_BASH_ENV:-}" ] && [ "\${PORT_MANAGER_PREV_BASH_ENV}" != ${shellQuote(
    scriptPath,
  )} ] && [ -r "\${PORT_MANAGER_PREV_BASH_ENV}" ]; then
  . "\${PORT_MANAGER_PREV_BASH_ENV}"
fi

${networkScope}

if [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then
  case ":\${DYLD_INSERT_LIBRARIES:-}:" in
    *:"\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}":*) ;;
    *) export DYLD_INSERT_LIBRARIES="\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}\${DYLD_INSERT_LIBRARIES:+:$DYLD_INSERT_LIBRARIES}" ;;
  esac
fi

if [ -n "\${PORT_MANAGER_COMPOSE_ROUTING_FILE:-}" ]; then
${buildComposeProjectRoutingFunctionScript()}
fi
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

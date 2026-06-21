import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAgentSocketPath } from "../agent/agent-socket";
import { getDefaultRouteTablePath } from "../agent/route-table";
import { readPortManagerSettings } from "../config/vscode-settings";
import type { DisposableLike, PortManagerSettings } from "../shared/types";

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

/** Applies and refreshes terminal environment variables owned by Port Manager. */
export function configureTerminalHookEnvironment(context: vscode.ExtensionContext): DisposableLike {
  const applyEnvironment = () => {
    applyTerminalHookEnvironment(context);
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
function applyTerminalHookEnvironment(context: vscode.ExtensionContext): void {
  const collection = context.environmentVariableCollection;
  const settings = readPortManagerSettings();

  collection.clear();
  collection.persistent = false;
  collection.description = "Port Manager routes terminal TCP binds through the local daemon.";

  if (!shouldInjectTerminalHook(settings)) {
    return;
  }

  const hookLibraryPath = context.asAbsolutePath(getHookLibraryRelativePath());
  const asdfShimLauncherPath = context.asAbsolutePath(getAsdfShimLauncherRelativePath());
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";

  collection.replace("PORT_MANAGER_HOOK", "1", TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath(), TERMINAL_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_ROUTES_FILE", getDefaultRouteTablePath(), TERMINAL_MUTATOR_OPTIONS);
  applyRoutingSettings(collection, settings);
  collection.prepend(preloadVariable, `${hookLibraryPath}${path.delimiter}`, TERMINAL_MUTATOR_OPTIONS);
  applyAsdfShimLauncherPath(collection, context.globalStorageUri.fsPath, asdfShimLauncherPath);
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
 * Creates a PATH directory that shadows asdf shell-script shims with native
 * launchers. This preserves DYLD_INSERT_LIBRARIES for the real runtime on
 * macOS, where protected shebang interpreters can strip DYLD_* variables.
 */
export function prepareAsdfShimLauncherDirectory(
  baseDirectory: string,
  launcherPath: string,
): string | undefined {
  const sourceShimDirectory = getAsdfShimDirectory();

  if (process.platform !== "darwin" || sourceShimDirectory === undefined || !fs.existsSync(launcherPath)) {
    return undefined;
  }

  const targetDirectory = path.join(baseDirectory, "asdf-shims");
  fs.mkdirSync(targetDirectory, { recursive: true });

  for (const entry of fs.readdirSync(sourceShimDirectory, { withFileTypes: true })) {
    if (entry.name === "asdf" || entry.name.startsWith(".") || (!entry.isFile() && !entry.isSymbolicLink())) {
      continue;
    }

    ensureSymlink(path.join(targetDirectory, entry.name), launcherPath);
  }

  return targetDirectory;
}

/** Adds the generated asdf launcher shims ahead of regular asdf shims. */
function applyAsdfShimLauncherPath(
  collection: vscode.EnvironmentVariableCollection,
  baseDirectory: string,
  launcherPath: string,
): void {
  const launcherDirectory = prepareAsdfShimLauncherDirectory(baseDirectory, launcherPath);

  if (launcherDirectory !== undefined) {
    collection.prepend("PATH", `${launcherDirectory}${path.delimiter}`, TERMINAL_MUTATOR_OPTIONS);
  }
}

/** The native hook currently ships only for POSIX preload mechanisms. */
function isNativeTerminalHookSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

/** Returns the packaged native hook library for the current OS. */
function getHookLibraryRelativePath(): string {
  if (process.platform === "darwin") {
    return path.join("media", "native", "libportmanager_hook.dylib");
  }

  return path.join("media", "native", "libportmanager_hook.so");
}

/** Returns the packaged native launcher used to bypass macOS asdf shim scripts. */
function getAsdfShimLauncherRelativePath(): string {
  return path.join("media", "native", "portmanager_asdf_shim");
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

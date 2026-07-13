import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { readPortManagerPackageVersion } from "../shared/package-version";
import { getAgentSocketPath } from "../agent/agent-socket";
import {
  getDefaultHostAccessBindingsPath,
  getDefaultRouteTablePath,
  getRouteTablePathForNetwork,
  ROUTE_TABLE_TTL_SECONDS_ENV,
} from "../agent/route-table";
import { readPortManagerSettings } from "../config/vscode-settings";
import {
  ACTUAL_LOOPBACK_HOST_ENV,
  GLOBAL_LOGICAL_NETWORK_ID,
  loopbackAddressForNetwork,
  NETWORK_IS_GLOBAL_ENV,
  NETWORK_LOOPBACK_HOST_ENV,
  shouldExposeNetworkLoopbackHost,
  usesLoopbackAddressOnlyRouting,
} from "../core/networks/loopback-address";
import type { DisposableLike, PortManagerSettings } from "../shared/types";
import {
  buildRuntimeCommandShimScript,
  type RuntimeCommandShimName,
} from "./compose-project-routing";
import { normalizeBrowserDnsHostname } from "../platform/network/browser-dns-server";

/**
 * Keeps new VS Code terminals on the pre-bind routing path.
 *
 * The terminal conflict monitor is only a recovery path after a process has
 * already failed. This module injects the native hook and daemon settings into
 * terminal environments so non-fixed protocol ports can be allocated before
 * bind() reaches the operating system.
 */

/**
 * Static routing context is copied into the new process directly. VS Code's
 * shell integration decodes each integration-time mutator with helper
 * processes, so sending dozens of immutable values through that path adds a
 * visible delay before the first prompt.
 */
const TERMINAL_CONTEXT_MUTATOR_OPTIONS: vscode.EnvironmentVariableMutatorOptions = {
  applyAtProcessCreation: true,
  applyAtShellIntegration: false,
};

/**
 * Only the variables that turn routing on are delayed until shell profiles
 * finish. Runtime managers and prompt setup therefore run without preload or
 * PATH shims, while commands launched from the ready prompt stay routed.
 */
const TERMINAL_ACTIVATION_MUTATOR_OPTIONS: vscode.EnvironmentVariableMutatorOptions = {
  /*
   * VS Code's shell-integration script runs after the user's shell profiles.
   * Delaying preload/PATH mutation until that point keeps nvm/asdf/pyenv and
   * prompt setup out of the native hook while preserving routing for every
   * command the user starts from the ready prompt. A terminal without working
   * shell integration stays untouched and can still use the explicit attach
   * path, which sources its generated routing script directly.
   */
  applyAtProcessCreation: false,
  applyAtShellIntegration: true,
};

export const RUNTIME_SHIM_DIRECTORY_ENV = "PORT_MANAGER_RUNTIME_SHIM_DIR";
export const DOCKER_SHIM_PATH_ENV = "PORT_MANAGER_DOCKER_SHIM";
export const EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV = "PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE";
export const AGENT_REQUIRED_ENV = "PORT_MANAGER_AGENT_REQUIRED";
export const ESCAPED_SERVER_RESPAWN_ENV = "PORT_MANAGER_ESCAPED_SERVER_RESPAWN";
export const NETWORK_DNS_ALIAS_ENV = "PORT_MANAGER_NETWORK_DNS_ALIAS";
const PRELOAD_PACKAGE_MANAGER_NAMES: readonly string[] = ["npm", "npx", "pnpm", "pnpx", "corepack", "uv", "uvx", "yarn", "yarnpkg"];
const RUNTIME_COMMAND_SHIM_NAMES: readonly RuntimeCommandShimName[] = ["docker", "podman", "docker-compose", "podman-compose"];
const PRELOAD_RUNTIME_LAUNCHER_NAMES = [
  "node",
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
];
// Observation commands get a hooked exec boundary via the same trampoline so
// state-path arguments (.celery/celery.log) are remapped to the caller's own
// network mirror — each terminal tails ITS network (docs/per-network-files.md).
const OBSERVATION_COMMAND_SHIM_NAMES: readonly string[] = ["tail", "cat"];
// Process observation follows the caller's network the same way: these resolve
// to the native process-scope shim, which hides rows belonging to a DIFFERENT
// logical network so machine-wide kill sweeps (`ps -ef | grep celery | kill`,
// `pkill -f celery`) only ever see their own scope. Rows with no network
// identity stay visible; /bin/ps and PORT_MANAGER_PROCESS_SCOPE=0 stay global.
const PROCESS_SCOPE_SHIM_NAMES: readonly string[] = ["ps", "pgrep", "pkill", "killall"];
// These names are project-bin commands that commonly bind or probe dev ports.
// Package managers are intentionally excluded so install/link lifecycle work
// does not inherit socket routing unless the invoked tool crosses a runtime
// shim boundary later.
const PRELOAD_PACKAGE_COMMAND_NAMES: readonly string[] = [
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
export const TERMINAL_RUNTIME_SHIM_READY_CHECK_NAMES: readonly string[] = [
  ...RUNTIME_COMMAND_SHIM_NAMES,
  ...PRELOAD_PACKAGE_MANAGER_NAMES,
  ...PRELOAD_PACKAGE_COMMAND_NAMES,
];
const COMPOSE_REFRESH_WAIT_MS = "3000";
const VITE_ADDITIONAL_ALLOWED_HOSTS_ENV = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";
const PORT_MANAGER_VITE_ALLOWED_HOSTS_ENV = "PORT_MANAGER_VITE_ALLOWED_HOSTS";

export interface TerminalHookEnvironmentScope {
  /** Logical network applied to every new VS Code terminal in this extension host. */
  readonly networkId: string;
  /** Display name used by shell startup hooks to label attached terminals. */
  readonly networkName?: string;
  /** Single-label DNS alias for this network, when the name is resolver-safe. */
  readonly networkDnsAlias?: string;
  /** Dynamic Compose/container routing map consumed by Docker/Podman shims. */
  readonly composeRoutingFilePath?: string;
  /** Directory where Docker/Podman shims signal lifecycle changes back to the extension. */
  readonly terminalAttachmentMarkerDirectoryPath?: string;
  /** Logical ports owned by Compose attachments in this network. */
  readonly composeLogicalPorts?: readonly number[];
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
    if (!settings.logicalPortGateway || !shouldInjectTerminalHook(settings)) {
      return;
    }
    // Unattached terminals join the reserved global network in address-only
    // mode so 127.0.0.1/0.0.0.0 remain daemon-owned ingress coordinates. The
    // service prepares the fixed lo0 alias asynchronously; env generation never
    // falls back to an unmanaged localhost identity just because the alias probe
    // is pending or failed.
    if (settings.globalNetwork && usesLoopbackAddressOnlyRouting(settings)) {
      applyGlobalNetworkEnvironment(context, collection, settings);
      return;
    }
    // A terminal not attached to any network still gets a minimal hook so a
    // server it launches on a gateway-owned port relocates instead of being
    // shadowed by the gateway listener. No network id is injected, so the hook
    // stays in pure passthrough for everything except that relocation.
    applyScopelessGatewayEnvironment(context, collection, settings);
    return;
  }

  if (!shouldInjectTerminalHook(settings)) {
    return;
  }

  ensureNetworkEnvFileScaffold(scope.networkId, scope.networkName);

  const hookLibraryPath = context.asAbsolutePath(getHookLibraryRelativePath());
  const agentMainPath = context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
  const nativeAgentPath = context.asAbsolutePath(path.join("media", "native", "portmanager_agent"));
  const nativeContainerMapPath = context.asAbsolutePath(path.join("media", "native", "portmanager_container_map"));
  const asdfShimLauncherPath = context.asAbsolutePath(getAsdfShimLauncherRelativePath());
  const runtimeCommandShimPath = context.asAbsolutePath(getRuntimeCommandShimRelativePath());
  // User network identity must stay non-empty across protected shebang/BASH_ENV
  // boundaries; the native hook treats an empty name with the global flag as
  // host-real and disables per-network env/file substitution.
  const networkName = scope.networkName ?? scope.networkId;
  const networkDnsAlias = scope.networkDnsAlias ?? normalizeBrowserDnsHostname(networkName);
  const shellEnvRestorePath = prepareShellEnvRestoreScript(context.globalStorageUri.fsPath, hookLibraryPath, {
    networkId: scope.networkId,
    networkName,
    networkDnsAlias,
    agentSocketPath: getAgentSocketPath(),
    agentMainPath,
    agentExecutablePath: nativeAgentPath,
    containerMapHelperPath: nativeContainerMapPath,
    globalRouteTablePath: getDefaultRouteTablePath(),
    hostAccessFilePath: getDefaultHostAccessBindingsPath(),
    settings,
    composeRoutingFilePath: scope.composeRoutingFilePath,
    terminalAttachmentMarkerDirectoryPath: scope.terminalAttachmentMarkerDirectoryPath,
    composeLogicalPorts: scope.composeLogicalPorts,
    dockerShimPath: runtimeCommandShimPath,
  });
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
  const preloadHintVariable = process.platform === "darwin" ? "PORT_MANAGER_DYLD_INSERT_LIBRARIES" : "PORT_MANAGER_LD_PRELOAD";

  collection.replace("PORT_MANAGER_HOOK", "1", TERMINAL_ACTIVATION_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_HOOK_DISABLED", "", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace(NETWORK_IS_GLOBAL_ENV, "", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  // Dev-log endpoint (docs/dev-logging.md): hooked servers/clients write to the
  // shared trace file when PORT_MANAGER_DEV_LOG is set in the host env.
  if (process.env.PORT_MANAGER_DEV_LOG !== undefined && process.env.PORT_MANAGER_DEV_LOG.length > 0) {
    collection.replace("PORT_MANAGER_DEV_LOG", process.env.PORT_MANAGER_DEV_LOG, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  }
  collection.replace("PORT_MANAGER_NETWORK_ID", scope.networkId, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_NETWORK_NAME", networkName, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  // Per-network identity uses the hook's hostname virtualization: loopback
  // address first, network name as fallback. A non-empty name also prevents a
  // stale global-scope flag from making this user network host-real.
  // See docs/per-network-hostname.md.
  if (networkDnsAlias !== undefined) {
    collection.replace(NETWORK_DNS_ALIAS_ENV, networkDnsAlias, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  }
  collection.replace("PORT_MANAGER_ROUTE_TABLE_NETWORK_ID", scope.networkId, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_BORROWED_NETWORK_ID", scope.networkId, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("NEWDLOPS_PM_NETWORK_ID", scope.networkId, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("NEWDLOPS_PM_BORROWED_NETWORK_ID", scope.networkId, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_MAIN", agentMainPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_EXECUTABLE", nativeAgentPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_CONTAINER_MAP_HELPER", nativeContainerMapPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace(DOCKER_SHIM_PATH_ENV, runtimeCommandShimPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_PRELOAD_REPAIR", "1", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_ROUTES_FILE", getRouteTablePathForNetwork(scope.networkId), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_GLOBAL_ROUTES_FILE", getDefaultRouteTablePath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_HOST_ACCESS_FILE", getDefaultHostAccessBindingsPath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_COMPOSE_REFRESH_WAIT_MS", COMPOSE_REFRESH_WAIT_MS, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  if (scope.composeRoutingFilePath !== undefined) {
    collection.replace("PORT_MANAGER_COMPOSE_ROUTING_FILE", scope.composeRoutingFilePath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  }
  if (scope.terminalAttachmentMarkerDirectoryPath !== undefined) {
    collection.replace(
      "PORT_MANAGER_TERMINAL_ATTACHMENT_DIR",
      scope.terminalAttachmentMarkerDirectoryPath,
      TERMINAL_CONTEXT_MUTATOR_OPTIONS,
    );
  }
  const composeLogicalPorts = serializeTcpPortList(scope.composeLogicalPorts);
  collection.replace("PORT_MANAGER_COMPOSE_LOGICAL_PORTS", composeLogicalPorts, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  applyRoutingSettings(collection, settings);
  applyLoopbackRoutingHosts(collection, scope.networkId, settings);
  collection.replace(
    preloadVariable,
    prependUniquePathListEntry(hookLibraryPath, process.env[preloadVariable]),
    TERMINAL_ACTIVATION_MUTATOR_OPTIONS,
  );
  collection.replace(preloadHintVariable, hookLibraryPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  applyRuntimeShimLauncherPath(collection, context.globalStorageUri.fsPath, asdfShimLauncherPath, runtimeCommandShimPath);

  if (shellEnvRestorePath !== undefined) {
    collection.replace("BASH_ENV", shellEnvRestorePath, TERMINAL_ACTIVATION_MUTATOR_OPTIONS);
  }
}

/**
 * Attaches an unattached terminal to the reserved global logical network. The
 * hook then virtualizes connection coordinates only — default-local binds and
 * managed connects move to the fixed global alias — while identity stays
 * host-real: no NETWORK_NAME, no DNS alias, no compose vars, no `.portmanager/`
 * scaffolding, and the NETWORK_IS_GLOBAL flag makes the hook skip hostname
 * virtualization, env-file injection, file substitution, argv rewriting, and
 * the Docker-socket guard.
 */
function applyGlobalNetworkEnvironment(
  context: vscode.ExtensionContext,
  collection: vscode.EnvironmentVariableCollection,
  settings: PortManagerSettings,
): void {
  const hookLibraryPath = context.asAbsolutePath(getHookLibraryRelativePath());
  const agentMainPath = context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
  const nativeAgentPath = context.asAbsolutePath(path.join("media", "native", "portmanager_agent"));
  const nativeContainerMapPath = context.asAbsolutePath(path.join("media", "native", "portmanager_container_map"));
  const asdfShimLauncherPath = context.asAbsolutePath(getAsdfShimLauncherRelativePath());
  const runtimeCommandShimPath = context.asAbsolutePath(getRuntimeCommandShimRelativePath());
  const shellEnvRestorePath = prepareShellEnvRestoreScript(context.globalStorageUri.fsPath, hookLibraryPath, {
    networkId: GLOBAL_LOGICAL_NETWORK_ID,
    globalNetworkScope: true,
    agentSocketPath: getAgentSocketPath(),
    agentMainPath,
    agentExecutablePath: nativeAgentPath,
    containerMapHelperPath: nativeContainerMapPath,
    globalRouteTablePath: getDefaultRouteTablePath(),
    hostAccessFilePath: getDefaultHostAccessBindingsPath(),
    settings,
    dockerShimPath: runtimeCommandShimPath,
  });
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
  const preloadHintVariable = process.platform === "darwin" ? "PORT_MANAGER_DYLD_INSERT_LIBRARIES" : "PORT_MANAGER_LD_PRELOAD";

  collection.replace("PORT_MANAGER_HOOK", "1", TERMINAL_ACTIVATION_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_HOOK_DISABLED", "", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  if (process.env.PORT_MANAGER_DEV_LOG !== undefined && process.env.PORT_MANAGER_DEV_LOG.length > 0) {
    collection.replace("PORT_MANAGER_DEV_LOG", process.env.PORT_MANAGER_DEV_LOG, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  }
  collection.replace("PORT_MANAGER_NETWORK_ID", GLOBAL_LOGICAL_NETWORK_ID, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_ROUTE_TABLE_NETWORK_ID", GLOBAL_LOGICAL_NETWORK_ID, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_BORROWED_NETWORK_ID", GLOBAL_LOGICAL_NETWORK_ID, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("NEWDLOPS_PM_NETWORK_ID", GLOBAL_LOGICAL_NETWORK_ID, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("NEWDLOPS_PM_BORROWED_NETWORK_ID", GLOBAL_LOGICAL_NETWORK_ID, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace(NETWORK_IS_GLOBAL_ENV, "1", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_MAIN", agentMainPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_EXECUTABLE", nativeAgentPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_CONTAINER_MAP_HELPER", nativeContainerMapPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace(DOCKER_SHIM_PATH_ENV, runtimeCommandShimPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_PRELOAD_REPAIR", "1", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace(
    "PORT_MANAGER_ROUTES_FILE",
    getRouteTablePathForNetwork(GLOBAL_LOGICAL_NETWORK_ID),
    TERMINAL_CONTEXT_MUTATOR_OPTIONS,
  );
  collection.replace("PORT_MANAGER_GLOBAL_ROUTES_FILE", getDefaultRouteTablePath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_HOST_ACCESS_FILE", getDefaultHostAccessBindingsPath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  applyRoutingSettings(collection, settings);
  applyLoopbackRoutingHosts(collection, GLOBAL_LOGICAL_NETWORK_ID, settings);
  collection.replace(
    preloadVariable,
    prependUniquePathListEntry(hookLibraryPath, process.env[preloadVariable]),
    TERMINAL_ACTIVATION_MUTATOR_OPTIONS,
  );
  collection.replace(preloadHintVariable, hookLibraryPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  applyRuntimeShimLauncherPath(collection, context.globalStorageUri.fsPath, asdfShimLauncherPath, runtimeCommandShimPath);
  if (shellEnvRestorePath !== undefined) {
    collection.replace("BASH_ENV", shellEnvRestorePath, TERMINAL_ACTIVATION_MUTATOR_OPTIONS);
  }
}

/**
 * Injects the smallest hook environment needed for gateway bind relocation into
 * a terminal with no network attachment. It carries no network id, so the hook
 * treats every bind and connect as passthrough except a bind to a port the
 * gateway currently claims, which it relocates to a daemon-assigned high port.
 */
function applyScopelessGatewayEnvironment(
  context: vscode.ExtensionContext,
  collection: vscode.EnvironmentVariableCollection,
  settings: PortManagerSettings,
): void {
  const hookLibraryPath = context.asAbsolutePath(getHookLibraryRelativePath());
  const agentMainPath = context.asAbsolutePath(path.join("out", "src", "agent", "agent-main.js"));
  const nativeAgentPath = context.asAbsolutePath(path.join("media", "native", "portmanager_agent"));
  const nativeContainerMapPath = context.asAbsolutePath(path.join("media", "native", "portmanager_container_map"));
  const asdfShimLauncherPath = context.asAbsolutePath(getAsdfShimLauncherRelativePath());
  const runtimeCommandShimPath = context.asAbsolutePath(getRuntimeCommandShimRelativePath());
  const shellEnvRestorePath = prepareShellEnvRestoreScript(context.globalStorageUri.fsPath, hookLibraryPath, {
    hookWithoutNetwork: true,
    agentSocketPath: getAgentSocketPath(),
    agentMainPath,
    agentExecutablePath: nativeAgentPath,
    containerMapHelperPath: nativeContainerMapPath,
    globalRouteTablePath: getDefaultRouteTablePath(),
    hostAccessFilePath: getDefaultHostAccessBindingsPath(),
    settings,
    dockerShimPath: runtimeCommandShimPath,
  });
  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
  const preloadHintVariable = process.platform === "darwin" ? "PORT_MANAGER_DYLD_INSERT_LIBRARIES" : "PORT_MANAGER_LD_PRELOAD";

  collection.replace("PORT_MANAGER_HOOK", "1", TERMINAL_ACTIVATION_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_HOOK_DISABLED", "", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  // Dev-log endpoint (docs/dev-logging.md): even scopeless gateway terminals log.
  if (process.env.PORT_MANAGER_DEV_LOG !== undefined && process.env.PORT_MANAGER_DEV_LOG.length > 0) {
    collection.replace("PORT_MANAGER_DEV_LOG", process.env.PORT_MANAGER_DEV_LOG, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  }
  collection.replace("PORT_MANAGER_AGENT_SOCKET", getAgentSocketPath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_MAIN", agentMainPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_AGENT_EXECUTABLE", nativeAgentPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_CONTAINER_MAP_HELPER", nativeContainerMapPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace(DOCKER_SHIM_PATH_ENV, runtimeCommandShimPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_GLOBAL_ROUTES_FILE", getDefaultRouteTablePath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_HOST_ACCESS_FILE", getDefaultHostAccessBindingsPath(), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_PRELOAD_REPAIR", "1", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  applyRoutingSettings(collection, settings);
  collection.replace(
    preloadVariable,
    prependUniquePathListEntry(hookLibraryPath, process.env[preloadVariable]),
    TERMINAL_ACTIVATION_MUTATOR_OPTIONS,
  );
  collection.replace(preloadHintVariable, hookLibraryPath, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  applyRuntimeShimLauncherPath(collection, context.globalStorageUri.fsPath, asdfShimLauncherPath, runtimeCommandShimPath);
  if (shellEnvRestorePath !== undefined) {
    collection.replace("BASH_ENV", shellEnvRestorePath, TERMINAL_ACTIVATION_MUTATOR_OPTIONS);
  }
}

/** Mirrors the per-network bind hosts used by native high-port and same-port routing. */
function applyLoopbackRoutingHosts(
  collection: vscode.EnvironmentVariableCollection,
  networkId: string,
  settings: PortManagerSettings,
): void {
  const loopbackHost = loopbackAddressForNetwork(networkId);

  collection.replace(ACTUAL_LOOPBACK_HOST_ENV, loopbackHost, TERMINAL_CONTEXT_MUTATOR_OPTIONS);

  if (shouldExposeNetworkLoopbackHost(settings)) {
    collection.replace(NETWORK_LOOPBACK_HOST_ENV, loopbackHost, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  } else {
    // Replace with empty rather than deleting the mutator so an inherited value
    // from an older terminal attachment cannot survive into a new process tree.
    collection.replace(NETWORK_LOOPBACK_HOST_ENV, "", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  }
}

/**
 * Scaffolds `<workspaceFolder>/.portmanager/` so both per-network mechanisms
 * are ready the moment anything attaches to the network — window bindings AND
 * per-terminal attach scripts: `env/<network>.env` (injected before main(),
 * docs/per-network-env.md) and `files/<network>/` (existence-based exclusive
 * file substitution, docs/per-network-files.md). The app `.env` is auto-split:
 * a copy is seeded as `files/<network>/.env` so every network starts on an
 * independent (initially identical) file that the hook substitutes exclusively
 * from then on. The native hook only READS these paths. `.portmanager/` is
 * machine-local state, so it is ignored via the repo-LOCAL `.git/info/exclude`
 * — never the shared .gitignore. Idempotent and silent — never overwrites
 * existing content, ignores filesystem errors.
 */
export function ensureNetworkEnvFileScaffold(networkId: string, networkName: string | undefined): void {
  const networkKey = networkName !== undefined && networkName.length > 0 ? networkName : networkId;
  const safeKey = networkKey.replace(/\//g, "-");

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") {
      continue;
    }
    try {
      const root = folder.uri.fsPath;
      const envDirectory = path.join(root, ".portmanager", "env");
      const filesDirectory = path.join(root, ".portmanager", "files", safeKey);
      fs.mkdirSync(envDirectory, { recursive: true });
      fs.mkdirSync(filesDirectory, { recursive: true });
      ensureLocalGitExclude(root);
      const envFilePath = path.join(envDirectory, `${safeKey}.env`);
      if (!fs.existsSync(envFilePath)) {
        fs.writeFileSync(
          envFilePath,
          [
            `# Port Manager per-network environment for "${networkKey}".`,
            "# KEY=VALUE lines are injected into every process of this network before",
            "# main() — they win over inherited terminal env and the app's own .env.",
            "# PORT_MANAGER_*/NEWDLOPS_PM_*/PATH/BASH_ENV/preload keys are ignored.",
            "# See docs/per-network-env.md. Examples:",
            "#",
            "# GOOGLE_APPLICATION_CREDENTIALS=/path/credential.this-network.json",
            "# S3_BUCKET=this-network-dev-bucket",
            "",
          ].join("\n"),
        );
      }
      // Auto-split the app .env: seed this network's own copy once. Content is
      // identical at copy time (behavior-neutral); afterwards the network talks
      // only to its copy (docs/per-network-files.md), so edits are independent.
      const originalDotenvPath = path.join(root, ".env");
      const substituteDotenvPath = path.join(filesDirectory, ".env");
      if (fs.existsSync(originalDotenvPath) && !fs.existsSync(substituteDotenvPath)) {
        fs.copyFileSync(originalDotenvPath, substituteDotenvPath);
      }
    } catch {
      // Best-effort scaffold: a read-only or vanished folder must not break attach.
    }
  }
}

/**
 * Adds `.portmanager/` to the repo-LOCAL git exclude file
 * (`<gitdir>/info/exclude`). Per-network files are machine-local, so the
 * shared .gitignore must stay untouched. Follows `gitdir:` indirection for
 * worktrees (exclude lives in the common dir) and submodules.
 */
export function ensureLocalGitExclude(root: string): void {
  const gitPath = path.join(root, ".git");
  let gitDirectory: string | undefined;
  const gitStats = fs.statSync(gitPath, { throwIfNoEntry: false });

  if (gitStats !== undefined && gitStats.isDirectory()) {
    gitDirectory = gitPath;
  } else if (gitStats !== undefined && gitStats.isFile()) {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitPath, "utf8"));
    if (match !== null) {
      const resolved = path.resolve(root, match[1]);
      const worktreeMarker = `${path.sep}worktrees${path.sep}`;
      const markerIndex = resolved.lastIndexOf(worktreeMarker);
      gitDirectory = markerIndex >= 0 ? resolved.slice(0, markerIndex) : resolved;
    }
  }
  if (gitDirectory === undefined) {
    return;
  }

  const infoDirectory = path.join(gitDirectory, "info");
  const excludePath = path.join(infoDirectory, "exclude");
  const excludeEntry = ".portmanager/";
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  // Accept hand-written variants (/.portmanager/, .portmanager) as satisfying.
  const normalize = (line: string) => line.trim().replace(/^\//, "").replace(/\/$/, "");
  if (existing.split("\n").some((line) => normalize(line) === ".portmanager")) {
    return;
  }
  fs.mkdirSync(infoDirectory, { recursive: true });
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(excludePath, `${existing}${separator}${excludeEntry}\n`);
}

/** Mirrors user routing policy into the native hook's simple env contract. */
function applyRoutingSettings(
  collection: vscode.EnvironmentVariableCollection,
  settings: PortManagerSettings,
): void {
  const packageVersion = readPortManagerPackageVersion();
  if (packageVersion !== undefined) {
    collection.replace("PORT_MANAGER_EXPECTED_VERSION", packageVersion, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  }
  collection.replace("PORT_MANAGER_SCAN_RANGE", String(settings.scanRange), TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace("PORT_MANAGER_ROUTING_MODE", settings.routingMode, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace(AGENT_REQUIRED_ENV, usesLoopbackAddressOnlyRouting(settings) ? "0" : "1", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  collection.replace(ESCAPED_SERVER_RESPAWN_ENV, settings.escapedServerRespawn ? "1" : "", TERMINAL_CONTEXT_MUTATOR_OPTIONS);
  if (settings.experimentalRouteOwnershipMode !== "process") {
    collection.replace(
      EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV,
      settings.experimentalRouteOwnershipMode,
      TERMINAL_CONTEXT_MUTATOR_OPTIONS,
    );
  }
  collection.replace(
    "PORT_MANAGER_VIRTUAL_PORT_START",
    String(settings.virtualPortRangeStart),
    TERMINAL_CONTEXT_MUTATOR_OPTIONS,
  );
  collection.replace(
    "PORT_MANAGER_VIRTUAL_PORT_END",
    String(settings.virtualPortRangeEnd),
    TERMINAL_CONTEXT_MUTATOR_OPTIONS,
  );
  collection.replace(
    "PORT_MANAGER_FIXED_PROTOCOL_PORTS",
    settings.fixedProtocolPorts.join(","),
    TERMINAL_CONTEXT_MUTATOR_OPTIONS,
  );
  collection.replace(
    "PORT_MANAGER_PRESERVE_LISTEN_PORTS",
    settings.preservedListenPorts.join(","),
    TERMINAL_CONTEXT_MUTATOR_OPTIONS,
  );
  collection.replace(
    ROUTE_TABLE_TTL_SECONDS_ENV,
    String(settings.routeTableTtlSeconds),
    TERMINAL_CONTEXT_MUTATOR_OPTIONS,
  );
}

/** True when the current terminal platform can do pre-bind hook routing. */
export function shouldInjectTerminalHook(settings: PortManagerSettings): boolean {
  return settings.enabled && isNativeTerminalHookSupported();
}

/**
 * VS Code can merge terminal env mutators from more than one live extension
 * host. Static preload entries therefore use replace with a normalized list
 * instead of prepend, otherwise opening N windows can put the same native hook
 * path into DYLD_INSERT_LIBRARIES/LD_PRELOAD N times.
 */
function prependUniquePathListEntry(entry: string, currentValue: string | undefined): string {
  const existingEntries = (currentValue ?? "")
    .split(path.delimiter)
    .filter((value) => value.length > 0 && value !== entry && !isPortManagerPreloadLibraryPath(value));

  return [entry, ...existingEntries].join(path.delimiter);
}

/** Drops version-specific PM hook paths inherited from an older extension. */
function isPortManagerPreloadLibraryPath(value: string): boolean {
  return /(?:^|[/\\])media[/\\]native[/\\]libportmanager_hook\.(?:dylib|so)$/.test(value);
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
  options: { readonly force?: boolean } = {},
): string | undefined {
  const sourceShimDirectory = getAsdfShimDirectory();
  const targetDirectory = path.join(baseDirectory, "runtime-shims");
  const stampSignature = buildRuntimeShimDirectorySignature(
    launcherPath,
    runtimeCommandShimPath,
    sourceShimDirectory,
  );

  /*
   * A full rebuild re-enumerates the user's asdf shims and rewrites every
   * generated shim, which several call sites repeat per refresh and per
   * window. The signature captures every rebuild input, so an unchanged stamp
   * means the directory already matches what a rebuild would produce.
   */
  if (options.force !== true && runtimeShimDirectoryMatchesStamp(targetDirectory, stampSignature)) {
    return targetDirectory;
  }

  fs.mkdirSync(targetDirectory, { recursive: true });
  removeStaleRuntimeShimArtifacts(targetDirectory);
  writeRuntimeCommandShims(targetDirectory, runtimeCommandShimPath);
  writePreloadPackageManagerCommandShims(targetDirectory);
  writePreloadPackageCommandShims(targetDirectory);

  if (process.platform !== "darwin" || !fs.existsSync(launcherPath)) {
    writeRuntimeShimDirectoryStamp(targetDirectory, stampSignature);
    return targetDirectory;
  }

  for (const runtimeName of PRELOAD_RUNTIME_LAUNCHER_NAMES) {
    ensureExecutableAlias(path.join(targetDirectory, runtimeName), launcherPath);
  }

  for (const observationName of OBSERVATION_COMMAND_SHIM_NAMES) {
    ensureExecutableAlias(path.join(targetDirectory, observationName), launcherPath);
  }

  const processScopeShimPath = path.join(path.dirname(launcherPath), "portmanager_process_scope_shim");
  if (fs.existsSync(processScopeShimPath)) {
    for (const processScopeName of PROCESS_SCOPE_SHIM_NAMES) {
      ensureExecutableAlias(path.join(targetDirectory, processScopeName), processScopeShimPath);
    }
  }

  if (sourceShimDirectory !== undefined) {
    for (const entry of fs.readdirSync(sourceShimDirectory, { withFileTypes: true })) {
      if (
        entry.name === "asdf" ||
        entry.name.startsWith(".") ||
        PRELOAD_PACKAGE_MANAGER_NAMES.includes(entry.name) ||
        PRELOAD_PACKAGE_COMMAND_NAMES.includes(entry.name) ||
        (!entry.isFile() && !entry.isSymbolicLink())
      ) {
        continue;
      }

      ensureExecutableAlias(path.join(targetDirectory, entry.name), launcherPath);
    }
  }

  writeRuntimeShimDirectoryStamp(targetDirectory, stampSignature);
  return targetDirectory;
}

const RUNTIME_SHIM_STAMP_FILE_NAME = ".portmanager-shim-stamp";

/**
 * Fingerprint of everything a shim-directory rebuild depends on: generated
 * shim templates change only with the extension build, alias targets change
 * with the packaged helper paths, and the alias set follows the user's asdf
 * shim directory (whose mtime moves when shims are added or removed).
 */
function buildRuntimeShimDirectorySignature(
  launcherPath: string,
  runtimeCommandShimPath: string | undefined,
  sourceShimDirectory: string | undefined,
): string {
  let sourceShimDirectoryMtimeMs = -1;
  if (sourceShimDirectory !== undefined) {
    try {
      sourceShimDirectoryMtimeMs = fs.statSync(sourceShimDirectory).mtimeMs;
    } catch {
      sourceShimDirectoryMtimeMs = -1;
    }
  }

  return createHash("sha1")
    .update(
      JSON.stringify([
        readPortManagerPackageVersion() ?? "unknown",
        process.platform,
        launcherPath,
        runtimeCommandShimPath ?? "",
        sourceShimDirectory ?? "",
        sourceShimDirectoryMtimeMs,
        OBSERVATION_COMMAND_SHIM_NAMES.join(","),
        PROCESS_SCOPE_SHIM_NAMES.join(","),
        fs.existsSync(path.join(path.dirname(launcherPath), "portmanager_process_scope_shim")),
      ]),
    )
    .digest("hex");
}

function runtimeShimDirectoryMatchesStamp(targetDirectory: string, signature: string): boolean {
  try {
    if (fs.readFileSync(path.join(targetDirectory, RUNTIME_SHIM_STAMP_FILE_NAME), "utf8").trim() !== signature) {
      return false;
    }

    // Guard against wholesale directory tampering: the stamp only counts when
    // a representative generated entry is still present next to it.
    const sentinelName = process.platform === "darwin" ? PRELOAD_RUNTIME_LAUNCHER_NAMES[0] : RUNTIME_COMMAND_SHIM_NAMES[0];
    if (sentinelName !== undefined) {
      fs.lstatSync(path.join(targetDirectory, sentinelName));
    }

    return true;
  } catch {
    return false;
  }
}

function writeRuntimeShimDirectoryStamp(targetDirectory: string, signature: string): void {
  try {
    fs.writeFileSync(path.join(targetDirectory, RUNTIME_SHIM_STAMP_FILE_NAME), `${signature}\n`, "utf8");
  } catch {
    // A missing stamp only means the next refresh rebuilds the directory.
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
 * Removes files left by reverted runtime-shim experiments before stable shims
 * are regenerated. These files live in the extension-owned shim directory and
 * can keep disabling the preload hook even after the extension code is rolled
 * back, because existing terminals continue to resolve commands through PATH.
 */
function removeStaleRuntimeShimArtifacts(targetDirectory: string): void {
  fs.rmSync(path.join(targetDirectory, ".portmanager-node"), { force: true });

  const currentGeneratedShimNames = new Set([
    ...RUNTIME_COMMAND_SHIM_NAMES,
    ...PRELOAD_PACKAGE_MANAGER_NAMES,
    ...PRELOAD_PACKAGE_COMMAND_NAMES,
  ]);

  for (const entry of fs.readdirSync(targetDirectory, { withFileTypes: true })) {
    const shimPath = path.join(targetDirectory, entry.name);
    if (currentGeneratedShimNames.has(entry.name)) {
      /*
       * Never unlink active command names such as yarn/node/concurrently during
       * cleanup. Running shells can cache these absolute paths; the writer below
       * will replace stale contents with a ready temp file and atomic rename.
       */
      continue;
    }

    if (isPortManagerGeneratedRuntimeShim(shimPath)) {
      fs.rmSync(shimPath, { recursive: true, force: true });
    }
  }
}

function isPortManagerGeneratedRuntimeShim(filePath: string): boolean {
  try {
    const existingPath = fs.lstatSync(filePath);
    if (existingPath.isDirectory() || existingPath.isSymbolicLink()) {
      return false;
    }

    const contents = fs.readFileSync(filePath, "utf8");
    return contents.includes("Generated by Port Manager.");
  } catch {
    return false;
  }
}

function isStaleGeneratedRuntimeShim(filePath: string): boolean {
  try {
    const existingPath = fs.lstatSync(filePath);
    if (existingPath.isDirectory()) {
      return false;
    }

    const contents = fs.readFileSync(filePath, "utf8");
    if (!contents.includes("Generated by Port Manager.")) {
      return false;
    }

    return [
      VITE_ADDITIONAL_ALLOWED_HOSTS_ENV,
      ".portmanager-node",
      "PORT_MANAGER_HOOK_DISABLED",
      "__pm_package_manager_command_should_run_clean",
      "__pm_exec_without_port_manager_preload",
    ].some((marker) => contents.includes(marker));
  } catch {
    return false;
  }
}

/**
 * Creates a bash startup fragment that restores DYLD for non-interactive
 * project scripts. macOS strips DYLD_* when a shebang goes through protected
 * tools such as /usr/bin/env; BASH_ENV survives that boundary.
 */
export interface ShellEnvRestoreScope {
  /** Logical network scope that must survive protected shebang and bash boundaries. */
  readonly networkId?: string;
  /** Reserved host/global scope: carries a network id only for routing, not app identity. */
  readonly globalNetworkScope?: boolean;
  /** Hooked host scope with no logical network id. */
  readonly hookWithoutNetwork?: boolean;
  /** Human-visible network name; non-empty value marks user networks as not the reserved global scope. */
  readonly networkName?: string;
  /** Single-label network alias used to fold dev-server --host aliases back to localhost. */
  readonly networkDnsAlias?: string;
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
  /** Directory where Docker/Podman shims signal lifecycle changes back to the extension. */
  readonly terminalAttachmentMarkerDirectoryPath?: string;
  /** Logical ports owned by Compose attachments in this network. */
  readonly composeLogicalPorts?: readonly number[];
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
  const contents = buildShellEnvRestoreScript(scope, targetPath, hookLibraryPath);

  // Refresh loops regenerate this script far more often than its inputs
  // change; matching content means the write (and its watcher fan-out) can be
  // skipped entirely.
  try {
    if (fs.readFileSync(targetPath, "utf8") === contents) {
      return targetPath;
    }
  } catch {
    // Missing or unreadable scripts are (re)written below.
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, "utf8");
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
    collection.replace(RUNTIME_SHIM_DIRECTORY_ENV, launcherDirectory, TERMINAL_CONTEXT_MUTATOR_OPTIONS);
    /*
     * The managed profile prelude deliberately resets readiness while runtime
     * managers initialize. Restore it in the same shell-integration phase that
     * prepends the verified shim directory; leaving it in process-creation
     * context would strand the ready prompt at 0 after the prelude runs.
     *
     * Preserve the terminal shell's real PATH. Replacing PATH from the extension
     * host environment can hide Docker/Compose/runtime entries and bypass the
     * lifecycle-signal shims; attach and BASH_ENV scripts normalize duplicates.
     */
    collection.replace("PORT_MANAGER_RUNTIME_SHIM_READY", "1", TERMINAL_ACTIVATION_MUTATOR_OPTIONS);
    collection.prepend("PATH", `${launcherDirectory}${path.delimiter}`, TERMINAL_ACTIVATION_MUTATOR_OPTIONS);
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

/**
 * Creates an executable alias that preserves argv[0] even when child launchers
 * resolve PATH entries through realpath before exec. A symlink loses the tool
 * name in that flow, while a hard link keeps the invoked basename.
 */
function ensureExecutableAlias(linkPath: string, targetPath: string): void {
  const tempPath = temporarySiblingPath(linkPath);

  try {
    const targetStat = fs.statSync(targetPath);
    const existingPath = fs.lstatSync(linkPath);

    if (!existingPath.isSymbolicLink()) {
      const existingStat = fs.statSync(linkPath);
      if (existingStat.dev === targetStat.dev && existingStat.ino === targetStat.ino) {
        return;
      }
    }
  } catch {
    // Missing aliases and inaccessible stale entries are replaced below.
  }

  try {
    fs.rmSync(tempPath, { recursive: true, force: true });
    try {
      fs.linkSync(targetPath, tempPath);
    } catch {
      fs.symlinkSync(targetPath, tempPath);
    }

    replacePathAtomically(linkPath, tempPath);
  } catch (error) {
    fs.rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

/** Replaces stale extension-owned symlinks while leaving matching links alone. */
function ensureSymlink(linkPath: string, targetPath: string): void {
  const tempPath = temporarySiblingPath(linkPath);

  try {
    if (fs.readlinkSync(linkPath) === targetPath) {
      return;
    }
  } catch {
    // Missing or non-symlink paths are replaced inside the extension-owned dir.
  }

  try {
    fs.rmSync(tempPath, { recursive: true, force: true });
    fs.symlinkSync(targetPath, tempPath);
    replacePathAtomically(linkPath, tempPath);
  } catch (error) {
    fs.rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

function writeRuntimeCommandShims(targetDirectory: string, runtimeCommandShimPath: string | undefined): void {
  if (runtimeCommandShimPath !== undefined && fs.existsSync(runtimeCommandShimPath)) {
    for (const commandName of RUNTIME_COMMAND_SHIM_NAMES) {
      ensureExecutableAlias(path.join(targetDirectory, commandName), runtimeCommandShimPath);
    }
    return;
  }

  for (const commandName of RUNTIME_COMMAND_SHIM_NAMES) {
    writeRuntimeCommandShim(path.join(targetDirectory, commandName), buildRuntimeCommandShimScript(commandName));
  }
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

  const tempPath = temporarySiblingPath(filePath);
  try {
    fs.rmSync(tempPath, { recursive: true, force: true });
    fs.writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o700 });
    fs.chmodSync(tempPath, 0o700);
    replacePathAtomically(filePath, tempPath);
  } catch (error) {
    fs.rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Creates a temporary sibling so POSIX rename can swap generated shims without
 * exposing a missing executable between unlink and recreate.
 */
function temporarySiblingPath(filePath: string): string {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  return path.join(directory, `.${baseName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}

/** Renames over files atomically; stale directories need one cleanup fallback. */
function replacePathAtomically(filePath: string, tempPath: string): void {
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.lstatSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
        fs.renameSync(tempPath, filePath);
        return;
      }
    } catch {
      // Preserve the original rename failure below.
    }

    throw error;
  }
}

/** Adds the current network DNS alias to Vite's safe host list while preserving user-provided entries. */
function buildViteAllowedHostsExport(networkDnsAlias: string | undefined): string {
  const aliasAssignment =
    networkDnsAlias === undefined
      ? `__pm_vite_next_allowed_host=""`
      : `__pm_vite_next_allowed_host=${shellQuote(networkDnsAlias)}`;

  return `${aliasAssignment}
__pm_vite_allowed_hosts="\${${VITE_ADDITIONAL_ALLOWED_HOSTS_ENV}:-}"
if [ -n "\${${PORT_MANAGER_VITE_ALLOWED_HOSTS_ENV}:-}" ]; then
  __pm_vite_filtered_hosts=""
  __pm_vite_old_ifs="\${IFS}"
  IFS=,
  for __pm_vite_host in \${__pm_vite_allowed_hosts}; do
    __pm_vite_skip=0
    for __pm_vite_owned_host in \${${PORT_MANAGER_VITE_ALLOWED_HOSTS_ENV}}; do
      if [ "\${__pm_vite_host}" = "\${__pm_vite_owned_host}" ]; then
        __pm_vite_skip=1
        break
      fi
    done
    if [ "\${__pm_vite_skip}" != "1" ]; then
      if [ -z "\${__pm_vite_filtered_hosts}" ]; then
        __pm_vite_filtered_hosts="\${__pm_vite_host}"
      else
        __pm_vite_filtered_hosts="\${__pm_vite_filtered_hosts},\${__pm_vite_host}"
      fi
    fi
  done
  IFS="\${__pm_vite_old_ifs}"
  __pm_vite_allowed_hosts="\${__pm_vite_filtered_hosts}"
fi
if [ -n "\${__pm_vite_next_allowed_host}" ]; then
  case ",\${__pm_vite_allowed_hosts}," in
    *",\${__pm_vite_next_allowed_host},"*) ;;
    *)
      if [ -z "\${__pm_vite_allowed_hosts}" ]; then
        __pm_vite_allowed_hosts="\${__pm_vite_next_allowed_host}"
      else
        __pm_vite_allowed_hosts="\${__pm_vite_allowed_hosts},\${__pm_vite_next_allowed_host}"
      fi
      ;;
  esac
  export ${PORT_MANAGER_VITE_ALLOWED_HOSTS_ENV}="\${__pm_vite_next_allowed_host}"
else
  unset ${PORT_MANAGER_VITE_ALLOWED_HOSTS_ENV}
fi
if [ -n "\${__pm_vite_allowed_hosts}" ]; then
  export ${VITE_ADDITIONAL_ALLOWED_HOSTS_ENV}="\${__pm_vite_allowed_hosts}"
else
  unset ${VITE_ADDITIONAL_ALLOWED_HOSTS_ENV}
fi
unset __pm_vite_allowed_hosts __pm_vite_filtered_hosts __pm_vite_host __pm_vite_next_allowed_host __pm_vite_old_ifs __pm_vite_owned_host __pm_vite_skip`;
}

/**
 * Execs the resolved target with the preload environment the caller already
 * restored. Script-content and shebang parsing was removed: the extension-owned
 * PATH runtime shims (node/python/…) restore the preload across protected
 * launchers such as /usr/bin/env, so no shell-side target rewriting is needed.
 */
function buildPreloadNodeEntrypointBypassShell(): string {
  return `exec "\${__pm_target}" "$@"`;
}

/**
 * Fallback for package managers that can safely run without parent interception.
 *
 * Some manager layers should not keep the native hook loaded after command
 * classification. Use this only when later children are expected to cross a
 * runtime or package-command shim; Yarn/npm-style project scripts need the
 * hooked-parent path because they can launch node_modules/.bin by absolute path.
 */
function buildCleanPackageManagerEntrypointShell(): string {
  return `__pm_exec_clean() {
  case "$(uname -s)" in
    Darwin) unset DYLD_INSERT_LIBRARIES ;;
  esac
  exec "$@"
}

__pm_exec_clean "\${__pm_target}" "$@"`;
}

/**
 * Runs script-based package managers with the preload still active.
 *
 * Yarn classic can launch project binaries through `/bin/sh -c` with
 * node_modules/.bin ahead of the extension shim directory. Keeping the manager
 * hooked lets the native exec interceptor rewrite those package-bin launches
 * before protected shebang interpreters strip DYLD again.
 */
function buildHookedPackageManagerEntrypointShell(): string {
  return `if [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then
${buildShellPrependVariablePathListEntry("DYLD_INSERT_LIBRARIES", "PORT_MANAGER_DYLD_INSERT_LIBRARIES")}
fi

${buildPreloadNodeEntrypointBypassShell()}`;
}

/**
 * Some native package managers exec the target runtime by absolute path.
 * Those children cannot cross a PATH shim boundary, so the manager parent must
 * keep the preload hook long enough for exec/connect interception to survive,
 * while avoiding script parsing against native binaries.
 */
function buildPreloadedPackageManagerEntrypointShell(): string {
  return `if [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then
${buildShellPrependVariablePathListEntry("DYLD_INSERT_LIBRARIES", "PORT_MANAGER_DYLD_INSERT_LIBRARIES")}
fi

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

# A #!/bin/sh-class wrapper (e.g. yarn's temp node/yarn shims) strips
# DYLD_INSERT_LIBRARIES when exec'd (SIP shell) and re-execs a real binary by
# absolute path, bypassing every shim -- an unrecoverable preload dead end.
# Resolve PAST it to a native binary or a #!/usr/bin/env script (re-routes
# through PATH back into a shim). Shebang-only; no runtime-manager specifics.
__pm_candidate_is_shell_wrapper() {
  __pm_w_first="$(IFS= read -r __pm_w_line < "$1" 2>/dev/null && printf '%s' "\${__pm_w_line}")"
  case "\${__pm_w_first}" in
    '#!/bin/sh'|'#!/bin/sh '*|'#!/usr/bin/sh'|'#!/usr/bin/sh '*|'#!/bin/dash'|'#!/bin/dash '*|'#!/usr/bin/dash'|'#!/usr/bin/dash '*) return 0 ;;
    *) return 1 ;;
  esac
}

__pm_find_next_command() {
  __pm_old_ifs="\${IFS}"
  IFS=:
  __pm_fallback=""
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
      if __pm_candidate_is_shell_wrapper "\${__pm_candidate}"; then
        [ -n "\${__pm_fallback}" ] || __pm_fallback="\${__pm_candidate}"
        continue
      fi
      IFS="\${__pm_old_ifs}"
      printf '%s\\n' "\${__pm_candidate}"
      return 0
    fi
  done
  IFS="\${__pm_old_ifs}"
  if [ -n "\${__pm_fallback}" ]; then
    printf '%s\\n' "\${__pm_fallback}"
    return 0
  fi
  return 1
}

__pm_target="$(__pm_find_next_command)" || {
  printf '%s\\n' "Port Manager: could not find command after shim: \${__pm_name}" >&2
  exit 127
}

export PORT_MANAGER_PRELOAD_REPAIR=1

if [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then
${buildShellPrependVariablePathListEntry("DYLD_INSERT_LIBRARIES", "PORT_MANAGER_DYLD_INSERT_LIBRARIES")}
fi

${buildPreloadNodeEntrypointBypassShell()}
`;
}

function buildPreloadPackageManagerCommandShimScript(): string {
  return `#!/bin/sh
# Generated by Port Manager. Routes package-manager project commands only.
__pm_name="\${0##*/}"
__pm_shim_dir="$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd -P)"
__pm_marker="# Generated by Port Manager. Routes package-manager project commands only."

__pm_is_package_manager_shim() {
  [ -f "$1" ] || return 1
  __pm_candidate_first_line="$(IFS= read -r __pm_line < "$1" && printf '%s' "\${__pm_line}")"
  [ "\${__pm_candidate_first_line}" = '#!/bin/sh' ] || return 1
  __pm_candidate_second_line="$(sed -n '2p' "$1" 2>/dev/null)"
  [ "\${__pm_candidate_second_line}" = "\${__pm_marker}" ]
}

# See __pm_candidate_is_shell_wrapper in the package-command shim: a
# #!/bin/sh-class wrapper (yarn's temp node/yarn shims) strips DYLD and
# absolute-execs past every shim, so resolve past it to a native binary or a
# #!/usr/bin/env script (which re-routes through PATH back into a shim).
__pm_candidate_is_shell_wrapper() {
  __pm_w_first="$(IFS= read -r __pm_w_line < "$1" 2>/dev/null && printf '%s' "\${__pm_w_line}")"
  case "\${__pm_w_first}" in
    '#!/bin/sh'|'#!/bin/sh '*|'#!/usr/bin/sh'|'#!/usr/bin/sh '*|'#!/bin/dash'|'#!/bin/dash '*|'#!/usr/bin/dash'|'#!/usr/bin/dash '*) return 0 ;;
    *) return 1 ;;
  esac
}

__pm_find_next_command() {
  __pm_old_ifs="\${IFS}"
  IFS=:
  __pm_fallback=""
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
      if __pm_candidate_is_shell_wrapper "\${__pm_candidate}"; then
        [ -n "\${__pm_fallback}" ] || __pm_fallback="\${__pm_candidate}"
        continue
      fi
      IFS="\${__pm_old_ifs}"
      printf '%s\\n' "\${__pm_candidate}"
      return 0
    fi
  done
  IFS="\${__pm_old_ifs}"
  if [ -n "\${__pm_fallback}" ]; then
    printf '%s\\n' "\${__pm_fallback}"
    return 0
  fi
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

__pm_dependency_command_name() {
  case "$1" in
    ""|install|i|ci|add|remove|rm|uninstall|unlink|link|upgrade|update|up|dedupe|rebuild|prune|audit|fund|cache|config|doctor|why|list|info|outdated|import|set|version|versions|publish|pack|login|logout|owner|team|token|profile|whoami|init|create|dlx|patch|patch-commit|plugin|plugins|env|self)
      return 0
      ;;
    preinstall|install:clean|postinstall|prepare|prepublish|prepublishOnly|postpublish)
      return 0
      ;;
  esac
  return 1
}

__pm_package_manager_command_runs_project_code() {
  __pm_first="$(__pm_first_script_arg "$@" 2>/dev/null || true)"

  case "\${__pm_name}" in
    uv|uvx)
      case "\${__pm_first}" in
        run|tool|x|uvx) return 0 ;;
      esac
      __pm_dependency_command_name "\${__pm_first}" && return 1
      return 0
      ;;
    npx|pnpx)
      return 0
      ;;
    corepack)
      case "\${__pm_first}" in
        npm|npx|pnpm|pnpx|yarn|yarnpkg) return 0 ;;
      esac
      __pm_dependency_command_name "\${__pm_first}" && return 1
      return 0
      ;;
    npm|pnpm)
      case "\${__pm_first}" in
        run|run-script|start|test|exec|x|dlx) return 0 ;;
      esac
      __pm_dependency_command_name "\${__pm_first}" && return 1
      return 0
      ;;
    yarn|yarnpkg)
      __pm_dependency_command_name "\${__pm_first}" && return 1
      return 0
      ;;
  esac

  return 0
}

__pm_package_manager_requires_preload_parent() {
  case "\${__pm_name}" in
    uv|uvx) return 0 ;;
    npm|npx|pnpm|pnpx|corepack|yarn|yarnpkg) return 0 ;;
  esac
  return 1
}

__pm_package_manager_is_native_binary() {
  case "\${__pm_name}" in
    uv|uvx) return 0 ;;
  esac
  return 1
}

__pm_text_looks_like_dev_server() {
  __pm_text="$(printf '%s' "$*" | tr '[:upper:]' '[:lower:]')"
  case "\${__pm_text}" in
    *vite*|*next\\ dev*|*nuxt\\ dev*|*storybook\\ dev*|*webpack-dev-server*|*react-scripts\\ start*|*vue-cli-service\\ serve*|*astro\\ dev*|*svelte-kit*|*remix\\ vite:dev*|*celery*|*uvicorn*|*gunicorn*|*daphne*|*runserver*|*flask\\ run*|*rails\\ server*|*php\\ -s*|*serve\\ --listen*|*http-server*|*--host*|*--port*|*" -p "*|*vite_client_port=*|*port=*)
      return 0
      ;;
  esac
  return 1
}

__pm_target="$(__pm_find_next_command)" || {
  printf '%s\\n' "Port Manager: could not find command after shim: \${__pm_name}" >&2
  exit 127
}

__pm_script_name="$(__pm_first_script_arg "$@" 2>/dev/null || true)"
__pm_script_text="$(__pm_package_script_text "\${__pm_script_name}" 2>/dev/null || true)"
if __pm_package_manager_command_runs_project_code "$@" || __pm_text_looks_like_dev_server "$*" "\${npm_lifecycle_script:-}" "\${__pm_script_text}"; then
  export PORT_MANAGER_PRELOAD_REPAIR=1
  if __pm_package_manager_requires_preload_parent; then
    if __pm_package_manager_is_native_binary; then
      ${buildPreloadedPackageManagerEntrypointShell()}
    fi
    ${buildHookedPackageManagerEntrypointShell()}
  fi
  ${buildCleanPackageManagerEntrypointShell()}
else
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
    export PATH="\${__pm_path_rest}"
    unset __pm_path_rest __pm_old_ifs __pm_path_entry
  fi
  export PORT_MANAGER_HOOK=0
  export PORT_MANAGER_HOOK_DISABLED=1
  unset BASH_ENV PORT_MANAGER_PRELOAD_REPAIR PORT_MANAGER_DYLD_INSERT_LIBRARIES PORT_MANAGER_LD_PRELOAD DYLD_INSERT_LIBRARIES LD_PRELOAD PORT_MANAGER_RUNTIME_SHIM_DIR PORT_MANAGER_COMPOSE_ROUTING_FILE PORT_MANAGER_COMPOSE_LOGICAL_PORTS PORT_MANAGER_COMPOSE_REFRESH_WAIT_MS PORT_MANAGER_DOCKER_SHIM ${NETWORK_DNS_ALIAS_ENV} ${PORT_MANAGER_VITE_ALLOWED_HOSTS_ENV}
fi

exec "\${__pm_target}" "$@"
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

function buildShellEnvRestoreScript(scope: ShellEnvRestoreScope, scriptPath: string, hookLibraryPath: string): string {
  const globalRouteTablePath = scope.globalRouteTablePath ?? getDefaultRouteTablePath();
  const hostAccessFilePath = scope.hostAccessFilePath ?? getDefaultHostAccessBindingsPath();
  const networkName = scope.networkName ?? scope.networkId ?? "";
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
      ? `${scope.hookWithoutNetwork === true ? `export PORT_MANAGER_HOOK=1
unset ${NETWORK_IS_GLOBAL_ENV}

` : ""}if [ -z "\${PORT_MANAGER_NETWORK_ID:-}" ] && [ -n "\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID:-}" ]; then
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
      : scope.globalNetworkScope === true
        ? `export PORT_MANAGER_HOOK=1
export ${NETWORK_IS_GLOBAL_ENV}=1
export PORT_MANAGER_NETWORK_ID=${shellQuote(scope.networkId)}
export PORT_MANAGER_ROUTE_TABLE_NETWORK_ID=${shellQuote(scope.networkId)}
export PORT_MANAGER_BORROWED_NETWORK_ID=${shellQuote(scope.networkId)}
export NEWDLOPS_PM_NETWORK_ID=${shellQuote(scope.networkId)}
export NEWDLOPS_PM_BORROWED_NETWORK_ID=${shellQuote(scope.networkId)}
unset PORT_MANAGER_NETWORK_NAME`
      : `export PORT_MANAGER_HOOK=1
unset ${NETWORK_IS_GLOBAL_ENV}
export PORT_MANAGER_NETWORK_ID=${shellQuote(scope.networkId)}
export PORT_MANAGER_NETWORK_NAME=${shellQuote(networkName)}
export PORT_MANAGER_ROUTE_TABLE_NETWORK_ID=${shellQuote(scope.networkId)}
export PORT_MANAGER_BORROWED_NETWORK_ID=${shellQuote(scope.networkId)}
export NEWDLOPS_PM_NETWORK_ID=${shellQuote(scope.networkId)}
export NEWDLOPS_PM_BORROWED_NETWORK_ID=${shellQuote(scope.networkId)}`;
  const networkDnsAliasExport =
    scope.networkDnsAlias === undefined
      ? `unset ${NETWORK_DNS_ALIAS_ENV}`
      : `export ${NETWORK_DNS_ALIAS_ENV}=${shellQuote(scope.networkDnsAlias)}`;
  const viteAllowedHostsExport = buildViteAllowedHostsExport(scope.networkDnsAlias);
  const composeRoutingExport =
    scope.composeRoutingFilePath === undefined
      ? ""
      : `export PORT_MANAGER_COMPOSE_ROUTING_FILE=${shellQuote(scope.composeRoutingFilePath)}`;
  const terminalAttachmentExport =
    scope.terminalAttachmentMarkerDirectoryPath === undefined
      ? ""
      : `export PORT_MANAGER_TERMINAL_ATTACHMENT_DIR=${shellQuote(scope.terminalAttachmentMarkerDirectoryPath)}`;
  const composeLogicalPorts = serializeTcpPortList(scope.composeLogicalPorts);
  const composeLogicalPortsExport = `export PORT_MANAGER_COMPOSE_LOGICAL_PORTS=${shellQuote(composeLogicalPorts)}`;
  const composeRefreshWaitExport =
    scope.networkId === undefined ? "" : `export PORT_MANAGER_COMPOSE_REFRESH_WAIT_MS=${shellQuote(COMPOSE_REFRESH_WAIT_MS)}`;
  const dockerShimExport =
    scope.dockerShimPath === undefined ? "" : `export ${DOCKER_SHIM_PATH_ENV}=${shellQuote(scope.dockerShimPath)}`;
  /*
   * BASH_ENV outlives an installed extension version. Always refresh both the
   * hint and repair flag so a long-running terminal cannot keep sending runtime
   * shims to a dylib path removed by an extension upgrade.
   */
  const preloadRepairExport = "export PORT_MANAGER_PRELOAD_REPAIR=1";
  const preloadHintExport = `export PORT_MANAGER_DYLD_INSERT_LIBRARIES=${shellQuote(hookLibraryPath)}`;
  const loopbackHost = scope.networkId === undefined ? undefined : loopbackAddressForNetwork(scope.networkId);
  const loopbackExports =
    loopbackHost === undefined
      ? ""
      : [
          `export ${ACTUAL_LOOPBACK_HOST_ENV}=${shellQuote(loopbackHost)}`,
          scope.settings !== undefined && shouldExposeNetworkLoopbackHost(scope.settings)
            ? `export ${NETWORK_LOOPBACK_HOST_ENV}=${shellQuote(loopbackHost)}`
            : `unset ${NETWORK_LOOPBACK_HOST_ENV}`,
        ].join("\n");
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
          scope.settings.experimentalRouteOwnershipMode !== "process"
            ? `export ${EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV}=${shellQuote(scope.settings.experimentalRouteOwnershipMode)}`
            : `unset ${EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV}`,
          `export ${AGENT_REQUIRED_ENV}=${shellQuote(usesLoopbackAddressOnlyRouting(scope.settings) ? "0" : "1")}`,
          scope.settings.escapedServerRespawn
            ? `export ${ESCAPED_SERVER_RESPAWN_ENV}=1`
            : `unset ${ESCAPED_SERVER_RESPAWN_ENV}`,
          `export PORT_MANAGER_VIRTUAL_PORT_START=${shellQuote(String(scope.settings.virtualPortRangeStart))}`,
          `export PORT_MANAGER_VIRTUAL_PORT_END=${shellQuote(String(scope.settings.virtualPortRangeEnd))}`,
          `export PORT_MANAGER_FIXED_PROTOCOL_PORTS=${shellQuote(scope.settings.fixedProtocolPorts.join(","))}`,
          `export PORT_MANAGER_PRESERVE_LISTEN_PORTS=${shellQuote(scope.settings.preservedListenPorts.join(","))}`,
          `export ${ROUTE_TABLE_TTL_SECONDS_ENV}=${shellQuote(String(scope.settings.routeTableTtlSeconds))}`,
        ].join("\n");
  const runtimeShimSentinelName =
    process.platform === "darwin" ? PRELOAD_RUNTIME_LAUNCHER_NAMES[0] : RUNTIME_COMMAND_SHIM_NAMES[0];

  /*
   * Compose routing deliberately stays out of BASH_ENV. Docker/Podman PATH
   * shims already consume PORT_MANAGER_COMPOSE_ROUTING_FILE and load routing
   * logic on demand; embedding that library made every bash child parse ~48KB.
   */
  return `# Generated by Port Manager. Sourced by non-interactive bash shells.
if [ -n "\${PORT_MANAGER_PREV_BASH_ENV:-}" ] && [ "\${PORT_MANAGER_PREV_BASH_ENV}" != ${shellQuote(
    scriptPath,
  )} ] && [ -r "\${PORT_MANAGER_PREV_BASH_ENV}" ]; then
  . "\${PORT_MANAGER_PREV_BASH_ENV}"
fi

${networkScope}
${networkDnsAliasExport}
${viteAllowedHostsExport}
${routeTableExports}
${agentExports}
${routingExports}
${loopbackExports}
${composeRoutingExport}
${terminalAttachmentExport}
${composeLogicalPortsExport}
${composeRefreshWaitExport}
${dockerShimExport}
${preloadHintExport}
${preloadRepairExport}

if [ -z "\${PORT_MANAGER_HOST_ACCESS_FILE:-}" ]; then
  export PORT_MANAGER_HOST_ACCESS_FILE=${shellQuote(hostAccessFilePath)}
fi

if [ "\${PORT_MANAGER_HOOK_DISABLED:-}" != "1" ] && [ "\${PORT_MANAGER_HOOK:-1}" != "0" ] && [ "\${PORT_MANAGER_PRELOAD_REPAIR:-}" = "1" ] && [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then
${buildShellPrependPortManagerPreloadEntry("DYLD_INSERT_LIBRARIES", "PORT_MANAGER_DYLD_INSERT_LIBRARIES")}
fi

if [ -n "\${PORT_MANAGER_RUNTIME_SHIM_DIR:-}" ]; then
  export PORT_MANAGER_RUNTIME_SHIM_READY=0
  __pm_runtime_shim_missing=0
  if [ ! -s "\${PORT_MANAGER_RUNTIME_SHIM_DIR}/${RUNTIME_SHIM_STAMP_FILE_NAME}" ] || [ ! -x "\${PORT_MANAGER_RUNTIME_SHIM_DIR}/${runtimeShimSentinelName}" ]; then
    __pm_runtime_shim_missing=1
  fi

  case "\${__pm_runtime_shim_missing}:\${PATH:-}" in
    "0:\${PORT_MANAGER_RUNTIME_SHIM_DIR}"|"0:\${PORT_MANAGER_RUNTIME_SHIM_DIR}":*)
      export PORT_MANAGER_RUNTIME_SHIM_READY=1
      ;;
    *)
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
      if [ "\${__pm_runtime_shim_missing}" = "0" ]; then
        export PATH="\${PORT_MANAGER_RUNTIME_SHIM_DIR}\${__pm_path_rest:+:$__pm_path_rest}"
        export PORT_MANAGER_RUNTIME_SHIM_READY=1
      else
        export PATH="\${__pm_path_rest}"
      fi
      unset __pm_path_entry __pm_path_rest __pm_old_ifs
      hash -r 2>/dev/null || true
      ;;
  esac
  unset __pm_runtime_shim_missing
fi
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildShellPrependVariablePathListEntry(targetVariableName: string, entryVariableName: string): string {
  return [
    '  __pm_path_rest=""',
    '  __pm_old_ifs="${IFS}"',
    "  IFS=:",
    `  for __pm_path_entry in \${${targetVariableName}:-}; do`,
    `    if [ -z "$__pm_path_entry" ] || [ "$__pm_path_entry" = "$${entryVariableName}" ]; then`,
    "      continue",
    "    fi",
    '    if [ -z "$__pm_path_rest" ]; then',
    '      __pm_path_rest="$__pm_path_entry"',
    "    else",
    '      __pm_path_rest="$__pm_path_rest:$__pm_path_entry"',
    "    fi",
    "  done",
    '  IFS="${__pm_old_ifs}"',
    `  export ${targetVariableName}="$${entryVariableName}\${__pm_path_rest:+:$__pm_path_rest}"`,
    "  unset __pm_path_entry __pm_path_rest __pm_old_ifs",
  ].join("\n");
}

function buildShellPrependPortManagerPreloadEntry(targetVariableName: string, entryVariableName: string): string {
  return [
    '  __pm_path_rest=""',
    '  __pm_old_ifs="${IFS}"',
    "  IFS=:",
    `  for __pm_path_entry in \${${targetVariableName}:-}; do`,
    `    if [ -z "$__pm_path_entry" ] || [ "$__pm_path_entry" = "$${entryVariableName}" ]; then`,
    "      continue",
    "    fi",
    '    case "$__pm_path_entry" in',
    "      */media/native/libportmanager_hook.dylib) continue ;;",
    "    esac",
    '    if [ -z "$__pm_path_rest" ]; then',
    '      __pm_path_rest="$__pm_path_entry"',
    "    else",
    '      __pm_path_rest="$__pm_path_rest:$__pm_path_entry"',
    "    fi",
    "  done",
    '  IFS="${__pm_old_ifs}"',
    `  export ${targetVariableName}="$${entryVariableName}\${__pm_path_rest:+:$__pm_path_rest}"`,
    "  unset __pm_path_entry __pm_path_rest __pm_old_ifs",
  ].join("\n");
}

function serializeTcpPortList(ports: readonly number[] | undefined): string {
  if (ports === undefined || ports.length === 0) {
    return "";
  }

  const uniquePorts = new Set<number>();
  for (const port of ports) {
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      uniquePorts.add(port);
    }
  }

  return [...uniquePorts].sort((left, right) => left - right).join(",");
}

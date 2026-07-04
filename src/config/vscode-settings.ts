import * as vscode from "vscode";
import { DEFAULT_PORT_MANAGER_SETTINGS } from "../shared/default-settings";
import type {
  ContainerRuntimePreference,
  ContainerRuntimeSettings,
  ExperimentalRouteOwnershipMode,
  LoopbackAddressRoutingMode,
  PortManagerSettings,
  PortRoutingMode,
  ProcessKillSignal,
  ScanDirection,
} from "../shared/types";

/**
 * Reads and normalizes VS Code configuration for the Port Manager domain.
 *
 * Command handlers call this at execution time so changes made in Settings UI
 * are reflected without requiring extension reload.
 */

const DEFAULT_SETTINGS: PortManagerSettings = DEFAULT_PORT_MANAGER_SETTINGS;
const DEFAULT_CONTAINER_RUNTIME_SETTINGS: ContainerRuntimeSettings = {
  containerRuntime: "auto",
  containerImage: "alpine:3.20",
};

const VALID_SCAN_DIRECTIONS = new Set<ScanDirection>(["up", "down", "both"]);
const VALID_ROUTING_MODES = new Set<PortRoutingMode>(["nearest", "hashed"]);
const VALID_EXPERIMENTAL_ROUTE_OWNERSHIP_MODES = new Set<ExperimentalRouteOwnershipMode>([
  "process",
  "terminal-scope-listener",
  "loopback-address-only",
]);
const VALID_LOOPBACK_ADDRESS_ROUTING_MODES = new Set<LoopbackAddressRoutingMode>(["high-port", "auto", "loopback"]);
const VALID_CONTAINER_RUNTIMES = new Set<ContainerRuntimePreference>(["auto", "docker", "podman"]);

/**
 * Builds a complete settings object from VS Code configuration values.
 * Invalid values are clamped or replaced with defaults at this boundary so core
 * services can assume their configuration contract is already valid.
 */
export function readPortManagerSettings(): PortManagerSettings {
  const config = vscode.workspace.getConfiguration("portManager");
  const virtualPortRange = normalizeVirtualPortRange(
    config.get<number>("virtualPortRangeStart", DEFAULT_SETTINGS.virtualPortRangeStart),
    config.get<number>("virtualPortRangeEnd", DEFAULT_SETTINGS.virtualPortRangeEnd),
  );

  return {
    enabled: config.get<boolean>("enabled", DEFAULT_SETTINGS.enabled),
    defaultHost: normalizeHost(config.get<string>("defaultHost", DEFAULT_SETTINGS.defaultHost)),
    scanRange: normalizeScanRange(config.get<number>("scanRange", DEFAULT_SETTINGS.scanRange)),
    scanDirection: normalizeScanDirection(
      config.get<ScanDirection>("scanDirection", DEFAULT_SETTINGS.scanDirection),
    ),
    routingMode: normalizeRoutingMode(config.get<PortRoutingMode>("routingMode", DEFAULT_SETTINGS.routingMode)),
    experimentalRouteOwnershipMode: normalizeExperimentalRouteOwnershipMode(
      config.get<ExperimentalRouteOwnershipMode>(
        "experimentalRouteOwnershipMode",
        DEFAULT_SETTINGS.experimentalRouteOwnershipMode,
      ),
    ),
    enableLoopbackAddressRouting: config.get<boolean>(
      "enableLoopbackAddressRouting",
      DEFAULT_SETTINGS.enableLoopbackAddressRouting ?? false,
    ),
    loopbackAddressRoutingMode: readLoopbackAddressRoutingMode(config),
    virtualPortRangeStart: virtualPortRange.start,
    virtualPortRangeEnd: virtualPortRange.end,
    preferredPorts: normalizePreferredPorts(
      config.get<readonly number[]>("preferredPorts", DEFAULT_SETTINGS.preferredPorts),
    ),
    fixedProtocolPorts: normalizePortList(
      config.get<readonly number[]>("fixedProtocolPorts", DEFAULT_SETTINGS.fixedProtocolPorts),
      DEFAULT_SETTINGS.fixedProtocolPorts,
      { allowEmpty: true },
    ),
    preservedListenPorts: normalizePortList(
      config.get<readonly number[]>("preservedListenPorts", DEFAULT_SETTINGS.preservedListenPorts),
      DEFAULT_SETTINGS.preservedListenPorts,
      { allowEmpty: true },
    ),
    routeTableTtlSeconds: normalizeRouteTableTtlSeconds(
      config.get<number>("routeTableTtlSeconds", DEFAULT_SETTINGS.routeTableTtlSeconds),
    ),
    autoOpenBrowser: config.get<boolean>("autoOpenBrowser", DEFAULT_SETTINGS.autoOpenBrowser),
    showConflictNotification: config.get<boolean>(
      "showConflictNotification",
      DEFAULT_SETTINGS.showConflictNotification,
    ),
    watchPreferredPorts: config.get<boolean>("watchPreferredPorts", DEFAULT_SETTINGS.watchPreferredPorts),
    watchIntervalMs: normalizeWatchIntervalMs(
      config.get<number>("watchIntervalMs", DEFAULT_SETTINGS.watchIntervalMs),
    ),
    notifyOnDetectedConflict: config.get<boolean>(
      "notifyOnDetectedConflict",
      DEFAULT_SETTINGS.notifyOnDetectedConflict,
    ),
    monitorAllListeningPorts: config.get<boolean>(
      "monitorAllListeningPorts",
      DEFAULT_SETTINGS.monitorAllListeningPorts,
    ),
    logicalPortGateway: config.get<boolean>("logicalPortGateway", DEFAULT_SETTINGS.logicalPortGateway),
    detectTerminalListenFailures: config.get<boolean>(
      "detectTerminalListenFailures",
      DEFAULT_SETTINGS.detectTerminalListenFailures,
    ),
    routeTerminalCommandsOnStart: config.get<boolean>(
      "routeTerminalCommandsOnStart",
      DEFAULT_SETTINGS.routeTerminalCommandsOnStart,
    ),
    processKillSignal: normalizeKillSignal(
      config.get<ProcessKillSignal>("processKillSignal", DEFAULT_SETTINGS.processKillSignal),
    ),
  };
}

/** Reads container runtime settings used by the logical network adapter. */
export function readContainerRuntimeSettings(): ContainerRuntimeSettings {
  const config = vscode.workspace.getConfiguration("portManager");

  return {
    containerRuntime: normalizeContainerRuntime(
      config.get<ContainerRuntimePreference>(
        "containerRuntime",
        DEFAULT_CONTAINER_RUNTIME_SETTINGS.containerRuntime,
      ),
    ),
    containerImage: normalizeNonEmptyString(
      config.get<string>("containerImage", DEFAULT_CONTAINER_RUNTIME_SETTINGS.containerImage),
      DEFAULT_CONTAINER_RUNTIME_SETTINGS.containerImage,
    ),
  };
}

/** Reads whether the owner window may keep a container lifecycle event stream open. */
export function readContainerEventsWatchEnabled(): boolean {
  return vscode.workspace.getConfiguration("portManager").get<boolean>("containerEventsWatch", true);
}

/** Opens the Settings UI already filtered to this extension's namespace. */
export async function openPortManagerSettings(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:newdlops.portmanager portManager");
}

/**
 * Keeps user-entered host values URL-friendly while preserving common local
 * hostnames. Empty values fall back because the host is required for URLs.
 */
function normalizeHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_SETTINGS.defaultHost;
}

/**
 * Clamps scan range to the package.json contribution limits. The domain layer
 * should not need to defend against zero, negative, or huge search windows.
 */
function normalizeScanRange(scanRange: number): number {
  if (!Number.isFinite(scanRange)) {
    return DEFAULT_SETTINGS.scanRange;
  }

  return Math.max(1, Math.min(200, Math.trunc(scanRange)));
}

/**
 * Keeps background polling responsive without letting a bad setting create a
 * tight loop in the extension host.
 */
function normalizeWatchIntervalMs(watchIntervalMs: number): number {
  if (!Number.isFinite(watchIntervalMs)) {
    return DEFAULT_SETTINGS.watchIntervalMs;
  }

  return Math.max(1000, Math.min(60_000, Math.trunc(watchIntervalMs)));
}

/** Keeps route-cache TTLs inside the native reader contract. */
function normalizeRouteTableTtlSeconds(routeTableTtlSeconds: number): number {
  if (!Number.isFinite(routeTableTtlSeconds)) {
    return DEFAULT_SETTINGS.routeTableTtlSeconds;
  }

  return Math.max(5, Math.min(3600, Math.trunc(routeTableTtlSeconds)));
}

/** Converts unknown scan direction strings to the documented default policy. */
function normalizeScanDirection(scanDirection: ScanDirection): ScanDirection {
  return VALID_SCAN_DIRECTIONS.has(scanDirection) ? scanDirection : DEFAULT_SETTINGS.scanDirection;
}

/** Converts unknown routing modes to the hashed logical-port policy. */
function normalizeRoutingMode(routingMode: PortRoutingMode): PortRoutingMode {
  return VALID_ROUTING_MODES.has(routingMode) ? routingMode : DEFAULT_SETTINGS.routingMode;
}

/** Keeps experimental route ownership opt-in and falls back to legacy PID ownership. */
function normalizeExperimentalRouteOwnershipMode(
  mode: ExperimentalRouteOwnershipMode,
): ExperimentalRouteOwnershipMode {
  return VALID_EXPERIMENTAL_ROUTE_OWNERSHIP_MODES.has(mode)
    ? mode
    : DEFAULT_SETTINGS.experimentalRouteOwnershipMode;
}

/** Reads the explicit loopback policy while preserving the legacy boolean setting. */
function readLoopbackAddressRoutingMode(config: vscode.WorkspaceConfiguration): LoopbackAddressRoutingMode {
  const inspected = config.inspect<LoopbackAddressRoutingMode>("loopbackAddressRoutingMode");
  const configuredValue =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue;
  const legacyBoolean = config.inspect<boolean>("enableLoopbackAddressRouting");
  const legacyConfiguredValue =
    legacyBoolean?.workspaceFolderValue ??
    legacyBoolean?.workspaceValue ??
    legacyBoolean?.globalValue;

  if (configuredValue !== undefined && VALID_LOOPBACK_ADDRESS_ROUTING_MODES.has(configuredValue)) {
    return configuredValue;
  }

  if (legacyConfiguredValue !== undefined) {
    return legacyConfiguredValue ? "auto" : "high-port";
  }

  return DEFAULT_SETTINGS.loopbackAddressRoutingMode;
}

/** Converts unknown container runtime settings to auto detection. */
function normalizeContainerRuntime(runtime: ContainerRuntimePreference): ContainerRuntimePreference {
  return VALID_CONTAINER_RUNTIMES.has(runtime) ? runtime : DEFAULT_CONTAINER_RUNTIME_SETTINGS.containerRuntime;
}

/** Keeps required string settings populated. */
function normalizeNonEmptyString(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Keeps the hashed actual-port pool inside a valid TCP range. */
function normalizeVirtualPortRange(start: number, end: number): { readonly start: number; readonly end: number } {
  const normalizedStart = Math.trunc(start);
  const normalizedEnd = Math.trunc(end);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    normalizedStart < 1 ||
    normalizedEnd > 65_535 ||
    normalizedStart > normalizedEnd
  ) {
    return {
      start: DEFAULT_SETTINGS.virtualPortRangeStart,
      end: DEFAULT_SETTINGS.virtualPortRangeEnd,
    };
  }

  return {
    start: normalizedStart,
    end: normalizedEnd,
  };
}

/**
 * Removes invalid port entries and duplicates while keeping user ordering.
 * Empty prompt lists fall back to defaults so command prompts stay useful.
 */
function normalizePreferredPorts(preferredPorts: readonly number[]): readonly number[] {
  return normalizePortList(preferredPorts, DEFAULT_SETTINGS.preferredPorts, { allowEmpty: false });
}

/**
 * Removes invalid port entries and duplicates while keeping user ordering.
 * Used for both prompt suggestions and fixed-protocol exclusions.
 */
function normalizePortList(
  ports: readonly number[],
  fallbackPorts: readonly number[],
  options: { readonly allowEmpty: boolean },
): readonly number[] {
  const seenPorts = new Set<number>();
  const normalizedPorts: number[] = [];

  for (const port of ports) {
    const normalizedPort = Math.trunc(port);
    if (!isValidPort(normalizedPort) || seenPorts.has(normalizedPort)) {
      continue;
    }

    seenPorts.add(normalizedPort);
    normalizedPorts.push(normalizedPort);
  }

  if (normalizedPorts.length > 0 || options.allowEmpty) {
    return normalizedPorts;
  }

  return fallbackPorts;
}

/**
 * Leaves common POSIX signals configurable while defaulting unknown strings to
 * SIGTERM. Windows ignores POSIX signal nuance inside Node's kill mechanism.
 */
function normalizeKillSignal(signal: ProcessKillSignal): ProcessKillSignal {
  const signalText = String(signal).trim();
  return signalText.length > 0 ? (signalText as ProcessKillSignal) : DEFAULT_SETTINGS.processKillSignal;
}

/** Validates the user-facing TCP port range. */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

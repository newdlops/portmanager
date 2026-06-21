import * as vscode from "vscode";
import type { PortManagerSettings, ProcessKillSignal, ScanDirection } from "../shared/types";

/**
 * Reads and normalizes VS Code configuration for the Port Manager domain.
 *
 * Command handlers call this at execution time so changes made in Settings UI
 * are reflected without requiring extension reload.
 */

const DEFAULT_SETTINGS: PortManagerSettings = {
  enabled: true,
  defaultHost: "localhost",
  scanRange: 20,
  scanDirection: "up",
  preferredPorts: [3000, 3001, 5173, 8000, 8080],
  autoOpenBrowser: false,
  showConflictNotification: true,
  watchPreferredPorts: true,
  watchIntervalMs: 3000,
  notifyOnDetectedConflict: true,
  monitorAllListeningPorts: true,
  processKillSignal: "SIGTERM",
};

const VALID_SCAN_DIRECTIONS = new Set<ScanDirection>(["up", "down", "both"]);

/**
 * Builds a complete settings object from VS Code configuration values.
 * Invalid values are clamped or replaced with defaults at this boundary so core
 * services can assume their configuration contract is already valid.
 */
export function readPortManagerSettings(): PortManagerSettings {
  const config = vscode.workspace.getConfiguration("portManager");

  return {
    enabled: config.get<boolean>("enabled", DEFAULT_SETTINGS.enabled),
    defaultHost: normalizeHost(config.get<string>("defaultHost", DEFAULT_SETTINGS.defaultHost)),
    scanRange: normalizeScanRange(config.get<number>("scanRange", DEFAULT_SETTINGS.scanRange)),
    scanDirection: normalizeScanDirection(
      config.get<ScanDirection>("scanDirection", DEFAULT_SETTINGS.scanDirection),
    ),
    preferredPorts: normalizePreferredPorts(
      config.get<readonly number[]>("preferredPorts", DEFAULT_SETTINGS.preferredPorts),
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
    processKillSignal: normalizeKillSignal(
      config.get<ProcessKillSignal>("processKillSignal", DEFAULT_SETTINGS.processKillSignal),
    ),
  };
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

/** Converts unknown scan direction strings to the documented default policy. */
function normalizeScanDirection(scanDirection: ScanDirection): ScanDirection {
  return VALID_SCAN_DIRECTIONS.has(scanDirection) ? scanDirection : DEFAULT_SETTINGS.scanDirection;
}

/**
 * Removes invalid port entries and duplicates while keeping user ordering.
 * The resulting list is used only for prompt hints, so an empty list is safe.
 */
function normalizePreferredPorts(preferredPorts: readonly number[]): readonly number[] {
  const seenPorts = new Set<number>();
  const normalizedPorts: number[] = [];

  for (const port of preferredPorts) {
    const normalizedPort = Math.trunc(port);
    if (!isValidPort(normalizedPort) || seenPorts.has(normalizedPort)) {
      continue;
    }

    seenPorts.add(normalizedPort);
    normalizedPorts.push(normalizedPort);
  }

  return normalizedPorts.length > 0 ? normalizedPorts : DEFAULT_SETTINGS.preferredPorts;
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

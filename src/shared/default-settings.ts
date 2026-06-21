import type { PortManagerSettings } from "./types";

/**
 * Default Port Manager settings shared by VS Code configuration and external
 * terminal CLI clients. User settings still override these inside VS Code.
 */
export const DEFAULT_PORT_MANAGER_SETTINGS: PortManagerSettings = {
  enabled: true,
  defaultHost: "localhost",
  scanRange: 20,
  scanDirection: "up",
  routingMode: "hashed",
  virtualPortRangeStart: 53_000,
  virtualPortRangeEnd: 59_999,
  preferredPorts: [3000, 3001, 5173, 8000, 8080],
  autoOpenBrowser: false,
  showConflictNotification: true,
  watchPreferredPorts: true,
  watchIntervalMs: 3000,
  notifyOnDetectedConflict: true,
  monitorAllListeningPorts: true,
  detectTerminalListenFailures: true,
  routeTerminalCommandsOnStart: true,
  processKillSignal: "SIGTERM",
};

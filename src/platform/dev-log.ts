import * as syncFs from "node:fs";

/**
 * ============================================================================
 * Port Manager development log endpoint — TypeScript side (DEV DIAGNOSTICS)
 * ============================================================================
 *
 * Mirror of the native logger in `native/shared/pm_dev_log.c`: the extension
 * host appends to the SAME file as the native hook/router/agent, so routing and
 * attribution decisions across the whole system land on one greppable timeline
 * WITHOUT rebuilding anything.
 *
 *   Enable : set the `portManager.developmentLogPath` VS Code setting (the
 *            extension copies it into `process.env.PORT_MANAGER_DEV_LOG` at
 *            activation, which then propagates to every native child through
 *            `buildNodeRuntimeEnvironment` and to hooked terminals through the
 *            terminal environment collection). Setting the raw
 *            PORT_MANAGER_DEV_LOG env var before launching also works.
 *   Format : "HH:MM:SS.mmm000 [<component> pid=<n>] <message>\n" (the trailing
 *            000 keeps microsecond-column alignment with the native writer).
 *
 * Full documentation: docs/dev-logging.md (kept in sync with this file and the
 * native header). To trace a new subsystem, import `devLog` and call it with a
 * short component tag (e.g. "ts-router", "ts-compose").
 * ============================================================================
 */

/** Environment variable that gates the shared dev-log across native + TS. */
export const DEV_LOG_ENV = "PORT_MANAGER_DEV_LOG";

/** Absolute path of the dev-log file, or undefined when the endpoint is off. */
export function devLogPath(): string | undefined {
  const path = process.env[DEV_LOG_ENV];
  return path !== undefined && path.length > 0 ? path : undefined;
}

/** True when the dev-log endpoint is enabled (guard for expensive log args). */
export function devLogEnabled(): boolean {
  return devLogPath() !== undefined;
}

/**
 * Appends one formatted line to the shared dev-log file when the endpoint is
 * enabled; otherwise a no-op. Never throws — dev logging must not break the
 * extension.
 */
export function devLog(component: string, message: string): void {
  const path = devLogPath();
  if (path === undefined) {
    return;
  }
  try {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    syncFs.appendFileSync(path, `${hh}:${mm}:${ss}.${ms}000 [${component} pid=${process.pid}] ${message}\n`);
  } catch {
    // Intentionally swallowed: a broken dev-log path must never affect behavior.
  }
}

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

/**
 * Shared hard limit for diagnostic output.
 *
 * The native hook is injected into every routed child, so an unbounded sink
 * turns ordinary process creation into synchronous disk traffic and can grow
 * by gigabytes during a long debugging session. The native logger mirrors this
 * value in `native/shared/pm_dev_log.c`.
 */
export const DEV_LOG_MAX_BYTES = 64 * 1024 * 1024;

/** Absolute path of the dev-log file, or undefined when the endpoint is off. */
export function devLogPath(): string | undefined {
  const path = process.env[DEV_LOG_ENV];
  return path !== undefined && path.length > 0 ? path : undefined;
}

/** True once an existing log has reached the shared diagnostic size limit. */
export function devLogPathAtCapacity(path: string): boolean {
  try {
    return syncFs.statSync(path).size >= DEV_LOG_MAX_BYTES;
  } catch {
    // A missing file has its full budget available; write failures stay silent.
    return false;
  }
}

/** True when the endpoint is configured and still has room for diagnostics. */
export function devLogEnabled(): boolean {
  const path = devLogPath();
  return path !== undefined && !devLogPathAtCapacity(path);
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
  let descriptor: number | undefined;
  try {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    const line = `${hh}:${mm}:${ss}.${ms}000 [${component} pid=${process.pid}] ${message}\n`;

    descriptor = syncFs.openSync(path, "a", 0o644);
    const currentSize = syncFs.fstatSync(descriptor).size;
    if (currentSize + Buffer.byteLength(line) > DEV_LOG_MAX_BYTES) {
      return;
    }
    syncFs.writeSync(descriptor, line);
  } catch {
    // Intentionally swallowed: a broken dev-log path must never affect behavior.
  } finally {
    if (descriptor !== undefined) {
      try {
        syncFs.closeSync(descriptor);
      } catch {
        // Diagnostic cleanup must not affect extension behavior either.
      }
    }
  }
}

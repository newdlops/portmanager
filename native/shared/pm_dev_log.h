#ifndef PORTMANAGER_PM_DEV_LOG_H
#define PORTMANAGER_PM_DEV_LOG_H

/*
 * ============================================================================
 * Port Manager development log endpoint (DEV DIAGNOSTICS)
 * ============================================================================
 *
 * A single, runtime-toggleable, file-based log shared by every Port Manager
 * component (native hook / router / agent / process-tracker AND the TypeScript
 * extension host via src/platform/dev-log.ts). It exists so a developer can
 * trace routing/attribution decisions WITHOUT rebuilding native binaries to
 * add printf calls, and so daemon output (router/agent) that would otherwise
 * vanish on stderr is captured to one greppable timeline.
 *
 *   Enable  : set PORT_MANAGER_DEV_LOG=/absolute/path/to/log in the process
 *             environment (or the VS Code setting `portManager.developmentLogPath`,
 *             which the extension propagates into every native child + hooked
 *             terminal). Unset/empty => zero overhead, no file touched. Each
 *             sink stops accepting lines at 64 MiB so forgotten diagnostics
 *             cannot degrade process startup or grow without bound.
 *   Format  : "HH:MM:SS.mmmuuu [<component> pid=<n>] <message>\n"
 *   Sinks   : all components append to the SAME file; the component + pid
 *             fields disambiguate the interleaved timeline.
 *
 * Full documentation: docs/dev-logging.md (kept in sync with this header).
 *
 * When you add a new native binary that needs tracing: include this header,
 * call pm_dev_log("<component>", ...), and add native/shared/pm_dev_log.c to
 * that binary's compile line in scripts/build-native-hook.sh.
 * ============================================================================
 */

/*
 * Appends one formatted line to the dev-log file when PORT_MANAGER_DEV_LOG is
 * set; otherwise a no-op. Safe to call from any thread and from the injected
 * hook (uses a per-call open + O_APPEND, so no fd leaks across fork/exec and no
 * shared mutable state to race).
 */
void pm_dev_log(const char *component, const char *format, ...)
    __attribute__((format(printf, 2, 3)));

/*
 * Non-zero when PORT_MANAGER_DEV_LOG is set and its file is below the 64 MiB
 * safety limit. Use to guard call sites that would do expensive work only to
 * build a log argument.
 */
int pm_dev_log_enabled(void);

#endif /* PORTMANAGER_PM_DEV_LOG_H */

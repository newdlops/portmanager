#ifndef PM_PEER_PROCESS_H
#define PM_PEER_PROCESS_H

#include <stddef.h>

/*
 * Loopback connection attribution shared by the logical port router.
 *
 * The router owns logical ports on 127.0.0.1/::1 and must decide which network
 * an accepted connection belongs to. That decision starts from the source
 * process: this module maps a loopback TCP connection back to the client pid
 * and reads the Port Manager network scope from that process' environment,
 * replacing a slower lsof + full-process-table scan on the hot path.
 *
 * Every function is best-effort. A negative/failed return means "unresolved";
 * the caller emits a placeholder so the higher-level resolver falls back to its
 * own lookup rather than misrouting.
 */

/*
 * Resolves the client process behind one accepted loopback connection.
 *
 * Endpoints are expressed from the CLIENT's point of view: its local endpoint
 * is the connection's peer (remote) address/port, and its foreign endpoint is
 * the address/port the router accepted on. Both endpoints are required because
 * only the full pair reliably selects the client socket's protocol control
 * block among the two loopback endpoints of the same connection.
 *
 * Returns the pid (> 0) on success, or -1 when the owner cannot be determined
 * (e.g. the socket is owned by another uid, or the platform is unsupported).
 * When out_start_time_seconds is non-NULL it receives the process start time in
 * seconds on success, used by the caller as a pid-reuse guard.
 */
int pm_peer_resolve_client_pid(
    const char *client_local_host,
    int client_local_port,
    const char *client_foreign_host,
    int client_foreign_port,
    long *out_start_time_seconds);

/* Marks exact environment-entry boundaries in pm_peer_read_environment_text. */
#define PM_PEER_ENVIRONMENT_ENTRY_SEPARATOR '\x1e'

/*
 * Reads selected values from one process' environment without launching a
 * command. Each exact NAME=value entry is prefixed by
 * PM_PEER_ENVIRONMENT_ENTRY_SEPARATOR; whitespace inside a value is preserved.
 * The function does not inspect ancestors.
 *
 * Returns 0 and fills buffer on success (a marker-only buffer means no selected
 * variable exists); returns -1 when the process is not readable or the caller
 * buffer would truncate a selected value.
 */
int pm_peer_read_environment_text(
    int pid,
    const char *const *names,
    size_t name_count,
    char *buffer,
    size_t size);

/*
 * Reads the first Port Manager network id set in the environment of the given
 * process. When the process itself carries no scope, the process' ancestors are
 * consulted up to a small depth so a client launched a few levels below the
 * attached shell still attributes correctly.
 *
 * Returns 0 and fills buffer on success; returns -1 when no scope is found or
 * the environment cannot be read.
 */
int pm_peer_read_network_id(int pid, char *buffer, size_t size);

#endif /* PM_PEER_PROCESS_H */

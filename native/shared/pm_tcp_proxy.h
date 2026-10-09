#ifndef PM_TCP_PROXY_H
#define PM_TCP_PROXY_H
#include <stddef.h>
#include <stdint.h>
#include <pthread.h>

/*
 * Shared TCP transport for native helpers. Route selection and listener
 * ownership stay with each caller; this adapter only owns bounded worker
 * admission, connection preparation, and a backpressured byte pump.
 */

/** Load process-local limits before starting any workers (default: 256/5s). */
void pm_tcp_proxy_initialize(void);

/**
 * Start a bounded FIFO for the helper's control output. Queueing never waits
 * for the receiver; partial frames remain intact until they can drain.
 * A stalled receiver cannot hold connection workers past their route deadline.
 */
int pm_tcp_proxy_control_start(int fd);
int pm_tcp_proxy_control_write(const char *line);

/** Portable monotonic route waits: Darwin relative waits / POSIX monotonic conditions. */
int64_t pm_tcp_proxy_now_ms(void);
int pm_tcp_proxy_condition_init(pthread_cond_t *condition);
int pm_tcp_proxy_condition_wait(pthread_cond_t *condition, pthread_mutex_t *mutex, int64_t deadline);

/** Recompute admission headroom when a shared router adds/removes listener fds. */
void pm_tcp_proxy_set_listener_count(size_t count);

/**
 * Start one detached, quota-counted worker. Ownership of data transfers only
 * on success; on failure the caller must close its client and free data.
 * The permit is returned after worker cleanup, including preparation failures.
 */
int pm_tcp_proxy_start_worker(void *(*worker)(void *), void *data);

/** Mark a socket nonblocking and close-on-exec; failure leaves ownership with the caller. */
int pm_tcp_proxy_prepare_socket(int fd);

/** Detect reset before opening a late target; orderly FIN remains a valid half-close. */
int pm_tcp_proxy_client_failed(int fd);

/**
 * Resolve and connect all addresses within one monotonic setup budget.
 * Numeric addresses bypass DNS; matching in-flight name lookups share one
 * of at most four resolver jobs. A late result cannot open a timed-out target.
 * The returned socket remains nonblocking; failure returns -1.
 */
int pm_tcp_proxy_connect(const char *host, int port);

/**
 * Forward both streams with 64KiB per direction. FIN propagates only after
 * buffered bytes drain; the opposite direction stays alive without an idle
 * timeout. Errors/reset terminate both directions. Callers close both fds.
 */
void pm_tcp_proxy_forward(int client_fd, int target_fd);

#endif

#include <errno.h>
#include <netdb.h>
#include <poll.h>
#include <stdatomic.h>
#include <sys/socket.h>
#include <time.h>

/*
 * Model a SYN that never completes and repeatedly interrupted poll calls.
 * Other OS operations remain real, so each attempt must release its fd.
 * Real FIN/reset/byte forwarding is covered separately by the TCP tests.
 */
static int fixture_timeout = 0;
static int fixture_interrupt = 0;
static int fixture_attempt_polls = 0;
static int fixture_total_polls = 0;
static int fixture_dns = 0;
static int fixture_addresses = 0;
static int fixture_connect_calls = 0;
static int fixture_max_poll_ms = 0;
static int fixture_late_ready = 0;
static int fixture_late_immediate = 0;
static atomic_int fixture_dns_calls = 0;

static int fixture_getaddrinfo(const char *host, const char *service, const struct addrinfo *hints, struct addrinfo **results) {
  if (fixture_dns && host[0] == 'p' && host[1] == 'm') {
    if (hints != NULL && (hints->ai_flags & AI_NUMERICHOST) != 0) return EAI_NONAME;
    atomic_fetch_add(&fixture_dns_calls, 1);
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 350000000 };
    nanosleep(&pause, NULL);
    return EAI_NONAME;
  }
  if (fixture_addresses && hints != NULL) {
    struct addrinfo multiple = *hints;
    multiple.ai_flags &= ~AI_NUMERICHOST;
    return getaddrinfo("localhost", service, &multiple, results);
  }
  return getaddrinfo(host, service, hints, results);
}

static int fixture_connect(int fd, const struct sockaddr *address, socklen_t length) {
  fixture_connect_calls++;
  if (fixture_late_immediate) {
    /* Model descheduling across a successful connect syscall. */
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 50000000 };
    nanosleep(&pause, NULL);
    return 0;
  }
  if (fixture_addresses && fixture_connect_calls % 2 == 1) {
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 20000000 };
    nanosleep(&pause, NULL);
    errno = ECONNREFUSED;
    return -1;
  }
  if (fixture_timeout) { errno = EINPROGRESS; return -1; }
  return connect(fd, address, length);
}

static int fixture_poll(struct pollfd *descriptors, nfds_t count, int timeout) {
  if (fixture_timeout && timeout >= 0 && count == 1 && (descriptors[0].events & POLLOUT) != 0) {
    fixture_total_polls++;
    if (timeout > fixture_max_poll_ms) fixture_max_poll_ms = timeout;
    if (fixture_late_ready) {
      /* Readiness may win the kernel race, yet its worker resumes overdue. */
      struct timespec pause = { .tv_sec = 0, .tv_nsec = 50000000 };
      nanosleep(&pause, NULL);
      descriptors[0].revents = POLLOUT;
      return 1;
    }
    if (fixture_interrupt && fixture_attempt_polls++ < 3) {
      struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000 };
      nanosleep(&pause, NULL);
      errno = EINTR;
      return -1;
    }
    return poll(NULL, 0, timeout);
  }
  return poll(descriptors, count, timeout);
}

#define connect fixture_connect
#define poll fixture_poll
#define getaddrinfo fixture_getaddrinfo
#include "../../native/shared/pm_tcp_proxy.c"
#undef connect
#undef poll
#undef getaddrinfo

/** Count real descriptors before and after repeated preparation failure. */
static int fixture_fd_count(void) {
  int count = 0;
  for (int fd = 0; fd < 1024; fd++) if (fcntl(fd, F_GETFD) >= 0) count++;
  return count;
}

static void *fixture_shared_lookup(void *raw_port) {
  int fd = pm_tcp_proxy_connect("pm-shared", *(int *)raw_port);
  if (fd >= 0) close(fd);
  return (void *)(intptr_t)(fd < 0);
}

int main(int argc, char **argv) {
  int before, failures = 0;
  int64_t started, elapsed;
  if (argc != 3) return 2;
  fixture_dns = strcmp(argv[1], "dns") == 0 || strcmp(argv[1], "shared") == 0;
  fixture_addresses = strcmp(argv[1], "addresses") == 0;
  fixture_timeout = !fixture_dns && strcmp(argv[1], "refused") != 0;
  fixture_interrupt = strcmp(argv[1], "interrupt") == 0;
  fixture_late_ready = strcmp(argv[1], "late-ready") == 0;
  fixture_late_immediate = strcmp(argv[1], "late-immediate") == 0;
  pm_tcp_proxy_initialize();
  {
    /* The OS resolver may retain its own control sockets on first use.
     * Warm those once so the count measures failed TCP attempts, not DNS setup. */
    struct addrinfo *warm = NULL;
    if (getaddrinfo("localhost", "1", NULL, &warm) == 0) freeaddrinfo(warm);
  }
  before = fixture_fd_count();
  started = pm_monotonic_ms();
  if (strcmp(argv[1], "shared") == 0) {
    pthread_t callers[8];
    int port = atoi(argv[2]);
    for (int index = 0; index < 8; index++) {
      if (pthread_create(&callers[index], NULL, fixture_shared_lookup, &port) != 0) return 3;
    }
    for (int index = 0; index < 8; index++) {
      void *failed = NULL;
      pthread_join(callers[index], &failed);
      failures += (int)(intptr_t)failed;
    }
  } else {
    for (int attempt = 0; attempt < 4; attempt++) {
      int fd;
      char host[32];
      fixture_attempt_polls = 0;
      snprintf(host, sizeof(host), "pm-stalled-%d", attempt);
      fd = pm_tcp_proxy_connect(fixture_dns ? host : "127.0.0.1", atoi(argv[2]));
      if (fd < 0) failures++;
      else close(fd);
    }
    if (fixture_dns) {
      // A fifth hostname is refused while the resolver quota is occupied;
      // numeric addresses remain independent of those blocked jobs.
      int fd = pm_tcp_proxy_connect("pm-excess", atoi(argv[2]));
      if (fd < 0) failures++; else close(fd);
      fd = pm_tcp_proxy_connect("127.0.0.1", atoi(argv[2]));
      if (fd < 0) failures++; else close(fd);
    }
  }
  elapsed = pm_monotonic_ms() - started;
  if (fixture_dns) {
    // Wait for intentionally delayed OS work to return; late results must
    // release their pipes even after every caller has left.
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 450000000 };
    nanosleep(&pause, NULL);
  }
  printf("{\"failures\":%d,\"elapsedMs\":%lld,\"polls\":%d,\"fdDelta\":%d,"
    "\"dnsCalls\":%d,\"connectCalls\":%d,\"maxPollMs\":%d}\n",
    failures, (long long)elapsed, fixture_total_polls, fixture_fd_count() - before,
    atomic_load(&fixture_dns_calls), fixture_connect_calls, fixture_max_poll_ms);
  return 0;
}

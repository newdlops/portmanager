#include <errno.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
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
static int64_t fixture_virtual_ms = 1000000;

/* Scheduler delays can legitimately exhaust a 35ms budget before three
 * interruptions/address attempts on a busy VM. Model their monotonic cost deterministically;
 * the remaining setup modes still exercise real elapsed time and real fds. */
static int fixture_clock_gettime(clockid_t clock, struct timespec *value) {
  if ((!fixture_timeout && !fixture_late_immediate) || clock != CLOCK_MONOTONIC) return clock_gettime(clock, value);
  value->tv_sec = (time_t)(fixture_virtual_ms / 1000);
  value->tv_nsec = (long)(fixture_virtual_ms % 1000) * 1000000;
  return 0;
}

static int fixture_getaddrinfo(const char *host, const char *service, const struct addrinfo *hints, struct addrinfo **results) {
  if (fixture_dns && host[0] == 'p' && host[1] == 'm') {
    if (hints != NULL && (hints->ai_flags & AI_NUMERICHOST) != 0) return EAI_NONAME;
    atomic_fetch_add(&fixture_dns_calls, 1);
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 350000000 };
    nanosleep(&pause, NULL);
    return EAI_NONAME;
  }
  if (fixture_addresses && hints != NULL) {
    /* CI's localhost can have only one address. Supply two owned candidates
       explicitly so this policy test does not depend on machine DNS setup. */
    struct addrinfo *first = calloc(1, sizeof(*first));
    struct addrinfo *second = calloc(1, sizeof(*second));
    struct sockaddr_in *one = calloc(1, sizeof(*one));
    struct sockaddr_in *two = calloc(1, sizeof(*two));
    if (first == NULL || second == NULL || one == NULL || two == NULL) {
      free(first); free(second); free(one); free(two); return EAI_MEMORY;
    }
    one->sin_family = two->sin_family = AF_INET;
    one->sin_addr.s_addr = two->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    one->sin_port = two->sin_port = htons((unsigned short)atoi(service));
    first->ai_family = second->ai_family = AF_INET;
    first->ai_socktype = second->ai_socktype = SOCK_STREAM;
    first->ai_protocol = second->ai_protocol = IPPROTO_TCP;
    first->ai_addrlen = second->ai_addrlen = sizeof(*one);
    first->ai_addr = (struct sockaddr *)one; second->ai_addr = (struct sockaddr *)two;
    first->ai_next = second; *results = first;
    return 0;
  }
  return getaddrinfo(host, service, hints, results);
}

static void fixture_freeaddrinfo(struct addrinfo *results) {
  if (!fixture_addresses) { freeaddrinfo(results); return; }
  while (results != NULL) {
    struct addrinfo *next = results->ai_next;
    free(results->ai_addr); free(results); results = next;
  }
}

static int fixture_connect(int fd, const struct sockaddr *address, socklen_t length) {
  fixture_connect_calls++;
  if (fixture_late_immediate) {
    /* Model descheduling across a successful connect syscall. */
    fixture_virtual_ms += 50;
    return 0;
  }
  if (fixture_addresses && fixture_connect_calls % 2 == 1) {
    fixture_virtual_ms += 20;
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
      fixture_virtual_ms += 50;
      descriptors[0].revents = POLLOUT;
      return 1;
    }
    if (fixture_interrupt && fixture_attempt_polls++ < 3) {
      fixture_virtual_ms += 10;
      errno = EINTR;
      return -1;
    }
    fixture_virtual_ms += timeout;
    return 0;
    return poll(NULL, 0, timeout);
  }
  return poll(descriptors, count, timeout);
}

#define connect fixture_connect
#define poll fixture_poll
#define getaddrinfo fixture_getaddrinfo
#define freeaddrinfo fixture_freeaddrinfo
#define clock_gettime fixture_clock_gettime
#include "../../native/shared/pm_tcp_proxy.c"
#undef connect
#undef poll
#undef getaddrinfo
#undef freeaddrinfo
#undef clock_gettime

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

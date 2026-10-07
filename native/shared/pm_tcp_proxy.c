/*
 * Native TCP helpers share one bounded transport lifetime here. Callers keep
 * route selection and listener ownership; this adapter handles worker/fd
 * admission, shared deadline-bound DNS, and one backpressured duplex pump.
 */
#include "pm_tcp_proxy.h"
#include "pm_dev_log.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#include <stdio.h>

#define PM_TCP_PROXY_BUFFER_SIZE 65536
#define PM_TCP_PROXY_DEFAULT_MAX_CONNECTIONS 256
#define PM_TCP_PROXY_DEFAULT_CONNECT_TIMEOUT_MS 5000
#define PM_TCP_PROXY_MAX_DNS_JOBS 4
#define PM_TCP_PROXY_MAX_ADDRESSES 64
#define PM_TCP_PROXY_MAX_CONTROL_FRAMES 4096
#define PM_TCP_PROXY_MAX_CONTROL_BYTES (4 * 1024 * 1024)
#define PM_TCP_PROXY_MAX_CONTROL_LINE 1024
#if defined(MSG_NOSIGNAL)
#define PM_TCP_PROXY_SEND_FLAGS MSG_NOSIGNAL
#else
#define PM_TCP_PROXY_SEND_FLAGS 0
#endif

typedef struct proxy_worker {
  void *(*run)(void *);
  void *data;
} proxy_worker_t;

typedef struct proxy_direction {
  int source_fd;
  int target_fd;
  char *buffer;
  size_t start;
  size_t length;
  int source_open;
  int target_shutdown;
} proxy_direction_t;

typedef struct proxy_address {
  struct sockaddr_storage address;
  socklen_t length;
  int family;
  int type;
  int protocol;
} proxy_address_t;

typedef struct proxy_dns_job {
  char host[256];
  char service[16];
  int wake[2];
  unsigned int references;
  int ready;
  proxy_address_t *addresses;
  size_t address_count;
  struct proxy_dns_job *next;
} proxy_dns_job_t;

typedef struct proxy_control_frame {
  struct proxy_control_frame *next;
  size_t length;
  size_t sent;
  char data[];
} proxy_control_frame_t;

/* The writer owns the FIFO head until its whole frame is sent. Callers only
 * append; no expiry can splice the middle of the tab-delimited protocol. */
static pthread_mutex_t pm_control_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t pm_control_ready = PTHREAD_COND_INITIALIZER;
static proxy_control_frame_t *pm_control_head = NULL, *pm_control_tail = NULL;
static size_t pm_control_count = 0, pm_control_bytes = 0;
static int pm_control_fd = -1, pm_control_broken = 0;

/* A permit spans attribution, route lookup, connect, forwarding, and fd cleanup. */
static atomic_uint pm_active_workers = 0;
/* Listener changes adjust admission without evicting existing TCP sessions. */
static atomic_uint pm_max_workers = PM_TCP_PROXY_DEFAULT_MAX_CONNECTIONS;
/* Configuration and fd ceiling are immutable after initialization. */
static unsigned int pm_configured_max_workers = PM_TCP_PROXY_DEFAULT_MAX_CONNECTIONS;
static rlim_t pm_fd_ceiling = RLIM_INFINITY;
static int pm_connect_timeout_ms = PM_TCP_PROXY_DEFAULT_CONNECT_TIMEOUT_MS;
/* A parent may reserve a smaller DNS capacity in its shared proxy budget. */
static unsigned int pm_max_dns_jobs = PM_TCP_PROXY_MAX_DNS_JOBS;
/* Only in-flight names are shared. Completed DNS results are never cached. */
static pthread_mutex_t pm_dns_mutex = PTHREAD_MUTEX_INITIALIZER;
static proxy_dns_job_t *pm_dns_jobs = NULL;
static unsigned int pm_dns_job_count = 0;

/** Only this fixed worker waits for pipe capacity; existing TCP pumps stay independent. */
static void *pm_control_writer(void *unused) {
  (void)unused;
  for (;;) {
    proxy_control_frame_t *frame;
    pthread_mutex_lock(&pm_control_mutex);
    while (pm_control_head == NULL) pthread_cond_wait(&pm_control_ready, &pm_control_mutex);
    frame = pm_control_head;
    pthread_mutex_unlock(&pm_control_mutex);

    while (frame->sent < frame->length) {
      ssize_t written = write(pm_control_fd, frame->data + frame->sent, frame->length - frame->sent);
      if (written > 0) { frame->sent += (size_t)written; continue; }
      if (written < 0 && errno == EINTR) continue;
      if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        struct pollfd output = { .fd = pm_control_fd, .events = POLLOUT, .revents = 0 };
        int ready;
        do { ready = poll(&output, 1, -1); } while (ready < 0 && errno == EINTR);
        if (ready > 0 && (output.revents & POLLOUT) != 0
            && (output.revents & (POLLERR | POLLHUP | POLLNVAL)) == 0) continue;
      }
      /* A broken stream cannot safely receive another frame. Keep data-plane
       * sessions alive; reject new control writes until the owner closes us. */
      pthread_mutex_lock(&pm_control_mutex);
      pm_control_broken = 1;
      while (pm_control_head != NULL) {
        proxy_control_frame_t *next = pm_control_head->next;
        free(pm_control_head);
        pm_control_head = next;
      }
      pm_control_tail = NULL;
      pm_control_count = pm_control_bytes = 0;
      pthread_mutex_unlock(&pm_control_mutex);
      pm_dev_log("tcp-control", "output disconnected");
      return NULL;
    }
    pthread_mutex_lock(&pm_control_mutex);
    pm_control_head = frame->next;
    if (pm_control_head == NULL) pm_control_tail = NULL;
    pm_control_count--;
    pm_control_bytes -= frame->length;
    pthread_mutex_unlock(&pm_control_mutex);
    free(frame);
  }
}

int pm_tcp_proxy_control_start(int fd) {
  pthread_attr_t attributes;
  pthread_t thread;
  int result;
  if (pm_control_fd >= 0 || pm_tcp_proxy_prepare_socket(fd) != 0) return -1;
  pm_control_fd = fd;
  result = pthread_attr_init(&attributes);
  if (result == 0) {
    result = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    if (result == 0) result = pthread_create(&thread, &attributes, pm_control_writer, NULL);
    pthread_attr_destroy(&attributes);
  }
  if (result != 0) { pm_control_fd = -1; return -1; }
  return 0;
}

int pm_tcp_proxy_control_write(const char *line) {
  proxy_control_frame_t *frame;
  if (line == NULL) return -1;
  size_t length = strnlen(line, PM_TCP_PROXY_MAX_CONTROL_LINE + 1);
  if (length == 0 || length > PM_TCP_PROXY_MAX_CONTROL_LINE || line[length - 1] != '\n') return -1;
  pthread_mutex_lock(&pm_control_mutex);
  if (pm_control_fd < 0 || pm_control_broken
      || pm_control_count >= PM_TCP_PROXY_MAX_CONTROL_FRAMES
      || length > PM_TCP_PROXY_MAX_CONTROL_BYTES - pm_control_bytes) {
    pthread_mutex_unlock(&pm_control_mutex);
    return -1;
  }
  frame = malloc(sizeof(*frame) + length);
  if (frame == NULL) { pthread_mutex_unlock(&pm_control_mutex); return -1; }
  frame->next = NULL;
  frame->length = length;
  frame->sent = 0;
  memcpy(frame->data, line, length);
  if (pm_control_tail == NULL) pm_control_head = frame;
  else pm_control_tail->next = frame;
  pm_control_tail = frame;
  pm_control_count++;
  pm_control_bytes += length;
  pthread_cond_signal(&pm_control_ready);
  pthread_mutex_unlock(&pm_control_mutex);
  return 0;
}

/** Strictly bounded overrides are useful for diagnostics and small-host tests. */
static int pm_read_limit(const char *name, int fallback, int maximum) {
  const char *value = getenv(name);
  char *end = NULL;
  long parsed;
  if (value == NULL || *value == '\0') return fallback;
  errno = 0;
  parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 1 || parsed > maximum) return fallback;
  return (int)parsed;
}

void pm_tcp_proxy_initialize(void) {
  struct rlimit descriptors;
  pm_configured_max_workers = (unsigned int)pm_read_limit(
    "PORT_MANAGER_PROXY_MAX_CONNECTIONS", PM_TCP_PROXY_DEFAULT_MAX_CONNECTIONS, 4096);
  pm_connect_timeout_ms = pm_read_limit(
    "PORT_MANAGER_PROXY_CONNECT_TIMEOUT_MS", PM_TCP_PROXY_DEFAULT_CONNECT_TIMEOUT_MS, 600000);
  pm_max_dns_jobs = (unsigned int)pm_read_limit(
    "PORT_MANAGER_PROXY_MAX_DNS_JOBS", PM_TCP_PROXY_MAX_DNS_JOBS, PM_TCP_PROXY_MAX_DNS_JOBS);

  if (getrlimit(RLIMIT_NOFILE, &descriptors) == 0 && descriptors.rlim_cur != RLIM_INFINITY) {
    pm_fd_ceiling = descriptors.rlim_cur;
  }
  pm_tcp_proxy_set_listener_count(0);
}

void pm_tcp_proxy_set_listener_count(size_t count) {
  unsigned int limit = pm_configured_max_workers;
  /* Two sockets per worker. DNS owns at most eight pipe fds; remaining
   * headroom covers control/stdin, kqueue, and OS resolver bookkeeping. */
  if (pm_fd_ceiling != RLIM_INFINITY) {
    rlim_t used = (rlim_t)count + 32;
    rlim_t available = pm_fd_ceiling > used ? (pm_fd_ceiling - used) / 2 : 0;
    if (available < limit) limit = (unsigned int)available;
  }
  atomic_store_explicit(&pm_max_workers, limit, memory_order_relaxed);
}

/** Returning the permit last prevents a new worker from racing old fd teardown. */
static void *pm_run_worker(void *raw_worker) {
  proxy_worker_t *worker = raw_worker;
  void *result = worker->run(worker->data);
  free(worker);
  atomic_fetch_sub_explicit(&pm_active_workers, 1, memory_order_relaxed);
  return result;
}

int pm_tcp_proxy_start_worker(void *(*run)(void *), void *data) {
  proxy_worker_t *worker;
  pthread_attr_t attributes;
  pthread_t thread;
  int result;
  unsigned int previous = atomic_fetch_add_explicit(&pm_active_workers, 1, memory_order_relaxed);
  if (previous >= atomic_load_explicit(&pm_max_workers, memory_order_relaxed)) {
    atomic_fetch_sub_explicit(&pm_active_workers, 1, memory_order_relaxed);
    return -1;
  }
  worker = malloc(sizeof(*worker));
  if (worker == NULL) {
    atomic_fetch_sub_explicit(&pm_active_workers, 1, memory_order_relaxed);
    return -1;
  }
  worker->run = run;
  worker->data = data;
  if (pthread_attr_init(&attributes) != 0) {
    free(worker);
    atomic_fetch_sub_explicit(&pm_active_workers, 1, memory_order_relaxed);
    return -1;
  }
  result = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  if (result == 0) result = pthread_create(&thread, &attributes, pm_run_worker, worker);
  pthread_attr_destroy(&attributes);
  if (result != 0) {
    free(worker);
    atomic_fetch_sub_explicit(&pm_active_workers, 1, memory_order_relaxed);
    return -1;
  }
  return 0;
}

int pm_tcp_proxy_prepare_socket(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  int descriptor_flags = fcntl(fd, F_GETFD, 0);
  if (flags < 0 || descriptor_flags < 0) return -1;
  if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) return -1;
  return fcntl(fd, F_SETFD, descriptor_flags | FD_CLOEXEC);
}

int pm_tcp_proxy_client_failed(int fd) {
  char byte;
  int error = 0;
  socklen_t error_length = sizeof(error);
  if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &error_length) != 0) return 1;
  if (error != 0) {
    pm_dev_log("tcp-proxy", "socket failed fd=%d error=%d", fd, error);
    return 1;
  }
  ssize_t result = recv(fd, &byte, 1, MSG_PEEK);
  /* Accepted clients are nonblocking. A zero-byte read is an orderly FIN:
   * the sender may still be waiting for our response after shutdown(SHUT_WR). */
  return result < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK;
}

static int64_t pm_monotonic_ms(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) return -1;
  return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

int64_t pm_tcp_proxy_now_ms(void) {
  return pm_monotonic_ms();
}

int pm_tcp_proxy_condition_init(pthread_cond_t *condition) {
#if defined(__APPLE__)
  return pthread_cond_init(condition, NULL);
#else
  pthread_condattr_t attributes;
  int result = pthread_condattr_init(&attributes);
  if (result != 0) return result;
  result = pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC);
  if (result == 0) result = pthread_cond_init(condition, &attributes);
  pthread_condattr_destroy(&attributes);
  return result;
#endif
}

int pm_tcp_proxy_condition_wait(pthread_cond_t *condition, pthread_mutex_t *mutex, int64_t deadline) {
  int64_t now = pm_monotonic_ms();
  struct timespec until;
  if (now < 0 || now >= deadline) return ETIMEDOUT;
#if defined(__APPLE__)
  int64_t remaining = deadline - now;
  until.tv_sec = (time_t)(remaining / 1000);
  until.tv_nsec = (long)((remaining % 1000) * 1000000);
  return pthread_cond_timedwait_relative_np(condition, mutex, &until);
#else
  until.tv_sec = (time_t)(deadline / 1000);
  until.tv_nsec = (long)((deadline % 1000) * 1000000);
  return pthread_cond_timedwait(condition, mutex, &until);
#endif
}

/** Copy a bounded address set instead of retaining an arbitrary OS linked list. */
static proxy_address_t *pm_copy_addresses(const struct addrinfo *results, size_t *count) {
  const struct addrinfo *cursor;
  proxy_address_t *addresses;
  size_t capacity = 0;
  *count = 0;
  for (cursor = results; cursor != NULL && capacity < PM_TCP_PROXY_MAX_ADDRESSES; cursor = cursor->ai_next) {
    if (cursor->ai_addr != NULL && cursor->ai_addrlen <= sizeof(struct sockaddr_storage)
        && (cursor->ai_family == AF_INET || cursor->ai_family == AF_INET6)) capacity++;
  }
  if (capacity == 0) return NULL;
  addresses = calloc(capacity, sizeof(*addresses));
  if (addresses == NULL) return NULL;
  for (cursor = results; cursor != NULL && *count < capacity; cursor = cursor->ai_next) {
    proxy_address_t *address;
    if (cursor->ai_addr == NULL || cursor->ai_addrlen > sizeof(struct sockaddr_storage)
        || (cursor->ai_family != AF_INET && cursor->ai_family != AF_INET6)) continue;
    address = &addresses[(*count)++];
    memcpy(&address->address, cursor->ai_addr, cursor->ai_addrlen);
    address->length = (socklen_t)cursor->ai_addrlen;
    address->family = cursor->ai_family;
    address->type = cursor->ai_socktype;
    address->protocol = cursor->ai_protocol;
  }
  return addresses;
}

/** The worker and every waiter own a reference, so late DNS cannot signal a reused fd. */
static void pm_dns_release_locked(proxy_dns_job_t *job) {
  if (--job->references != 0) return;
  close(job->wake[0]);
  close(job->wake[1]);
  free(job->addresses);
  free(job);
}

static void pm_dns_release(proxy_dns_job_t *job) {
  pthread_mutex_lock(&pm_dns_mutex);
  pm_dns_release_locked(job);
  pthread_mutex_unlock(&pm_dns_mutex);
}

/** A blocked system resolver can retain at most four jobs; callers still meet their deadline. */
static void *pm_dns_worker(void *raw_job) {
  proxy_dns_job_t *job = raw_job;
  struct addrinfo hints, *results = NULL;
  proxy_address_t *addresses = NULL;
  size_t count = 0;
  proxy_dns_job_t **cursor;
  char wake = 1;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_NUMERICSERV;
  if (getaddrinfo(job->host, job->service, &hints, &results) == 0) {
    addresses = pm_copy_addresses(results, &count);
    freeaddrinfo(results);
  }
  pthread_mutex_lock(&pm_dns_mutex);
  job->addresses = addresses;
  job->address_count = count;
  job->ready = 1;
  cursor = &pm_dns_jobs;
  while (*cursor != NULL && *cursor != job) cursor = &(*cursor)->next;
  if (*cursor == job) *cursor = job->next;
  pm_dns_job_count--;
  /* Do not consume this byte: every waiter polls the same readable wakeup. */
  while (write(job->wake[1], &wake, 1) < 0 && errno == EINTR) {}
  pm_dns_release_locked(job);
  pthread_mutex_unlock(&pm_dns_mutex);
  return NULL;
}

/** Admit one DNS job or join the same in-flight origin without adding resolver threads. */
static proxy_dns_job_t *pm_dns_acquire(const char *host, const char *service) {
  proxy_dns_job_t *job;
  pthread_attr_t attributes;
  pthread_t thread;
  int result;
  pthread_mutex_lock(&pm_dns_mutex);
  for (job = pm_dns_jobs; job != NULL; job = job->next) {
    if (strcmp(job->host, host) == 0 && strcmp(job->service, service) == 0) {
      job->references++;
      pthread_mutex_unlock(&pm_dns_mutex);
      return job;
    }
  }
  if (pm_dns_job_count >= pm_max_dns_jobs) {
    pthread_mutex_unlock(&pm_dns_mutex);
    return NULL;
  }
  job = calloc(1, sizeof(*job));
  if (job == NULL) { pthread_mutex_unlock(&pm_dns_mutex); return NULL; }
  if (pipe(job->wake) != 0) { free(job); pthread_mutex_unlock(&pm_dns_mutex); return NULL; }
  if (pm_tcp_proxy_prepare_socket(job->wake[0]) != 0 || pm_tcp_proxy_prepare_socket(job->wake[1]) != 0) {
    close(job->wake[0]); close(job->wake[1]); free(job);
    pthread_mutex_unlock(&pm_dns_mutex);
    return NULL;
  }
  snprintf(job->host, sizeof(job->host), "%s", host);
  snprintf(job->service, sizeof(job->service), "%s", service);
  job->references = 2;
  result = pthread_attr_init(&attributes);
  if (result == 0) {
    result = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    if (result == 0) result = pthread_create(&thread, &attributes, pm_dns_worker, job);
    pthread_attr_destroy(&attributes);
  }
  if (result != 0) {
    job->references = 1;
    pm_dns_release_locked(job);
    pthread_mutex_unlock(&pm_dns_mutex);
    return NULL;
  }
  job->next = pm_dns_jobs;
  pm_dns_jobs = job;
  pm_dns_job_count++;
  pthread_mutex_unlock(&pm_dns_mutex);
  return job;
}

/** A readable wakeup has no wall-clock dependency, unlike a realtime condition timeout. */
static int pm_dns_wait(proxy_dns_job_t *job, int64_t deadline) {
  for (;;) {
    int ready;
    int64_t now;
    struct pollfd wake = { .fd = job->wake[0], .events = POLLIN, .revents = 0 };
    pthread_mutex_lock(&pm_dns_mutex);
    ready = job->ready;
    pthread_mutex_unlock(&pm_dns_mutex);
    now = pm_monotonic_ms();
    if (now < 0 || now >= deadline) return -1;
    if (ready) return job->addresses == NULL ? -1 : 0;
    ready = poll(&wake, 1, (int)(deadline - now));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (wake.revents & (POLLERR | POLLNVAL | POLLHUP)) != 0) return -1;
  }
}

/** EINTR and a second address consume the original deadline, never a new one. */
static int pm_wait_connected(int fd, int64_t deadline) {
  for (;;) {
    int64_t now = pm_monotonic_ms();
    int remaining;
    struct pollfd descriptor = { .fd = fd, .events = POLLOUT, .revents = 0 };
    int ready;
    int error = 0;
    socklen_t error_length = sizeof(error);
    if (now < 0 || now >= deadline) { errno = ETIMEDOUT; return -1; }
    remaining = (int)(deadline - now);
    ready = poll(&descriptor, 1, remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready == 0) { errno = ETIMEDOUT; return -1; }
    if (ready < 0) return -1;
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &error_length) != 0) return -1;
    if (error != 0) { errno = error; return -1; }
    if ((descriptor.revents & POLLOUT) != 0) return 0;
    errno = ECONNREFUSED;
    return -1;
  }
}

int pm_tcp_proxy_connect(const char *host, int port) {
  struct addrinfo hints;
  struct addrinfo *results = NULL;
  proxy_address_t *addresses = NULL;
  proxy_dns_job_t *job = NULL;
  size_t count = 0;
  char service[16];
  int fd = -1;
  int64_t started = pm_monotonic_ms();
  int64_t deadline;
  if (started < 0 || host == NULL || *host == '\0' || strlen(host) > 255 || port < 1 || port > 65535) return -1;
  deadline = started + pm_connect_timeout_ms;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_NUMERICSERV | AI_NUMERICHOST;
  snprintf(service, sizeof(service), "%d", port);
  /* Numeric route coordinates use no resolver job or additional thread. */
  if (getaddrinfo(host, service, &hints, &results) == 0) {
    addresses = pm_copy_addresses(results, &count);
    freeaddrinfo(results);
  } else {
    job = pm_dns_acquire(host, service);
    if (job == NULL) return -1;
    if (pm_dns_wait(job, deadline) != 0) { pm_dns_release(job); return -1; }
    addresses = job->addresses;
    count = job->address_count;
  }
  for (size_t index = 0; addresses != NULL && index < count; index++) {
    const proxy_address_t *address = &addresses[index];
    int64_t now = pm_monotonic_ms();
    int result;
    if (now < 0 || now >= deadline) break;
    fd = socket(address->family, address->type, address->protocol);
    if (fd < 0) continue;
    if (pm_tcp_proxy_prepare_socket(fd) != 0) { close(fd); fd = -1; continue; }
    now = pm_monotonic_ms();
    if (now < 0 || now >= deadline) { close(fd); fd = -1; break; }
    result = connect(fd, (const struct sockaddr *)&address->address, address->length);
    if (result == 0 || (errno == EINPROGRESS && pm_wait_connected(fd, deadline) == 0)) {
      /* A ready syscall can return after the worker was descheduled. Never
       * publish that socket once its original setup budget has elapsed. */
      now = pm_monotonic_ms();
      if (now >= 0 && now < deadline) break;
      errno = ETIMEDOUT;
    }
    close(fd);
    fd = -1;
  }
  if (job != NULL) pm_dns_release(job);
  else free(addresses);
  return fd;
}

static int pm_would_block(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK;
}

/** Read no further than the fixed buffer; a slow peer backpressures its sender. */
static int pm_read_direction(proxy_direction_t *direction) {
  ssize_t count;
  size_t available;
  if (!direction->source_open || direction->length == PM_TCP_PROXY_BUFFER_SIZE) return 0;
  if (direction->start + direction->length == PM_TCP_PROXY_BUFFER_SIZE) {
    memmove(direction->buffer, direction->buffer + direction->start, direction->length);
    direction->start = 0;
  }
  available = PM_TCP_PROXY_BUFFER_SIZE - direction->start - direction->length;
  count = recv(direction->source_fd, direction->buffer + direction->start + direction->length, available, 0);
  if (count > 0) { direction->length += (size_t)count; return 0; }
  if (count == 0) { direction->source_open = 0; return 0; }
  return errno == EINTR || pm_would_block() ? 0 : -1;
}

static int pm_write_direction(proxy_direction_t *direction, short revents) {
  while (direction->length > 0) {
    ssize_t count = send(direction->target_fd, direction->buffer + direction->start,
      direction->length, PM_TCP_PROXY_SEND_FLAGS);
    if (count > 0) {
      direction->start += (size_t)count;
      direction->length -= (size_t)count;
      if (direction->length == 0) direction->start = 0;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && pm_would_block() && (revents & POLLHUP) == 0) return 0;
    return -1;
  }
  return 0;
}

/** EOF alone never discards the response or any queued write bytes. */
static void pm_shutdown_drained(proxy_direction_t *direction) {
  if (!direction->source_open && direction->length == 0 && !direction->target_shutdown) {
    shutdown(direction->target_fd, SHUT_WR);
    direction->target_shutdown = 1;
  }
}

static void pm_set_nodelay(int fd) {
  int enabled = 1;
  (void)setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
}

void pm_tcp_proxy_forward(int client_fd, int target_fd) {
  proxy_direction_t forward = { .source_fd = client_fd, .target_fd = target_fd, .source_open = 1 };
  proxy_direction_t backward = { .source_fd = target_fd, .target_fd = client_fd, .source_open = 1 };
  int suppress_client_hup = 0, suppress_target_hup = 0;
  forward.buffer = malloc(PM_TCP_PROXY_BUFFER_SIZE);
  backward.buffer = malloc(PM_TCP_PROXY_BUFFER_SIZE);
  if (forward.buffer == NULL || backward.buffer == NULL) goto cleanup;
  if (pm_tcp_proxy_prepare_socket(client_fd) != 0 || pm_tcp_proxy_prepare_socket(target_fd) != 0) goto cleanup;
  pm_set_nodelay(client_fd);
  pm_set_nodelay(target_fd);

  for (;;) {
    struct pollfd descriptors[2] = {
      { .fd = client_fd, .events = 0, .revents = 0 },
      { .fd = target_fd, .events = 0, .revents = 0 }
    };
    int ready;
    pm_shutdown_drained(&forward);
    pm_shutdown_drained(&backward);
    if (forward.source_open && forward.length < PM_TCP_PROXY_BUFFER_SIZE) descriptors[0].events |= POLLIN;
    if (backward.length > 0) descriptors[0].events |= POLLOUT;
    if (backward.source_open && backward.length < PM_TCP_PROXY_BUFFER_SIZE) descriptors[1].events |= POLLIN;
    if (forward.length > 0) descriptors[1].events |= POLLOUT;
    if (descriptors[0].events == 0 && descriptors[1].events == 0) break;
    /* Keep zero-interest sockets in poll for reset/error while backpressured.
     * Suppress only an already observed HUP that cannot yet be drained; HUP
     * remains level-triggered even with events=0 and would otherwise spin. */
    if (descriptors[0].events != 0) suppress_client_hup = 0;
    if (descriptors[1].events != 0) suppress_target_hup = 0;
    if (descriptors[0].events == 0 && suppress_client_hup) descriptors[0].fd = -1;
    if (descriptors[1].events == 0 && suppress_target_hup) descriptors[1].fd = -1;
    if ((descriptors[0].events == 0 || descriptors[1].events == 0) && pm_dev_log_enabled()) {
      pm_dev_log("tcp-proxy", "wait client=%d/%x target=%d/%x forward=%zu/%d backward=%zu/%d",
        descriptors[0].fd, descriptors[0].events, descriptors[1].fd, descriptors[1].events,
        forward.length, forward.source_open, backward.length, backward.source_open);
    }
    int poll_timeout = -1;
#if defined(__APPLE__)
    /* Darwin does not wake poll(events=0) for a reset behind unread bytes.
     * Inspect socket errors only while a direction has no I/O interest;
     * ordinary idle full-duplex streams still sleep without periodic wakeups.
     * This is a liveness check, never an idle deadline or an EOF decision. */
    if (descriptors[0].events == 0 || descriptors[1].events == 0) poll_timeout = 100;
#endif
    ready = poll(descriptors, 2, poll_timeout);
    if ((descriptors[0].events == 0 || descriptors[1].events == 0
        || ((descriptors[0].revents | descriptors[1].revents) & (POLLERR | POLLHUP | POLLNVAL)) != 0)
        && pm_dev_log_enabled()) {
      pm_dev_log("tcp-proxy", "poll ready=%d client=%x target=%x", ready,
        descriptors[0].revents, descriptors[1].revents);
    }
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) break;
    if (ready == 0) {
      if (pm_tcp_proxy_client_failed(client_fd) || pm_tcp_proxy_client_failed(target_fd)) break;
      continue;
    }
    if ((descriptors[0].revents | descriptors[1].revents) & (POLLERR | POLLNVAL)) break;
    /* Inspect SO_ERROR before treating HUP as harmless level-triggered EOF. */
    if ((descriptors[0].revents & POLLHUP) != 0 && pm_tcp_proxy_client_failed(client_fd)) break;
    if ((descriptors[1].revents & POLLHUP) != 0 && pm_tcp_proxy_client_failed(target_fd)) break;
    if (descriptors[0].events == 0 && (descriptors[0].revents & POLLHUP) != 0) suppress_client_hup = 1;
    if (descriptors[1].events == 0 && (descriptors[1].revents & POLLHUP) != 0) suppress_target_hup = 1;
    if ((descriptors[0].revents & (POLLIN | POLLHUP)) != 0 && pm_read_direction(&forward) != 0) break;
    if ((descriptors[1].revents & (POLLIN | POLLHUP)) != 0 && pm_read_direction(&backward) != 0) break;
    if (backward.length > 0 && (descriptors[0].revents & (POLLOUT | POLLHUP)) != 0
        && pm_write_direction(&backward, descriptors[0].revents) != 0) break;
    if (forward.length > 0 && (descriptors[1].revents & (POLLOUT | POLLHUP)) != 0
        && pm_write_direction(&forward, descriptors[1].revents) != 0) break;
  }

cleanup:
  shutdown(client_fd, SHUT_RDWR);
  shutdown(target_fd, SHUT_RDWR);
  free(forward.buffer);
  free(backward.buffer);
}

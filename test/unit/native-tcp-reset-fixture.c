#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/socket.h>

/* Model the valid scheduler sequence that otherwise depends on tight timing:
 * one socket's bounded upload is full while the other reports readiness.
 * A later error belongs to the disabled socket, so waiting for a timeout to
 * inspect it loses liveness. All descriptor allocation and cleanup stay real. */
static int fixture_client = -1, fixture_target = -1;
static int fixture_waits, fixture_starved_waits, fixture_error_observed;
static int fixture_reads, fixture_sends;
static int fixture_kevent(int queue, const struct kevent *changes, int count,
    struct kevent *events, int capacity, const struct timespec *timeout) {
  if (events == NULL) return kevent(queue, changes, count, events, capacity, timeout);
  fixture_waits++;
  if (fixture_waits > 30) { errno = EIO; return -1; }
  if (timeout != NULL) fixture_starved_waits++;
  EV_SET(&events[0], fixture_waits == 1 ? fixture_client : fixture_target,
    fixture_waits == 1 ? EVFILT_READ : EVFILT_WRITE, 0, 0, 1,
    (void *)(uintptr_t)(fixture_waits == 1 ? 0 : 1));
  return 1;
}
static ssize_t fixture_recv(int fd, void *buffer, size_t size, int flags) {
  if ((flags & MSG_PEEK) != 0) return recv(fd, buffer, size, flags);
  if (fd == fixture_client && fixture_reads++ == 0) {
    memset(buffer, 'x', size); return (ssize_t)size;
  }
  errno = EAGAIN; return -1;
}
static ssize_t fixture_send(int fd, const void *buffer, size_t size, int flags) {
  (void)fd; (void)buffer; (void)size; (void)flags;
  fixture_sends++; errno = EAGAIN; return -1;
}
static int fixture_getsockopt(int fd, int level, int option, void *value, socklen_t *length) {
  if (fd == fixture_client && level == SOL_SOCKET && option == SO_ERROR && fixture_starved_waits > 0) {
    *(int *)value = ECONNRESET; *length = sizeof(int); fixture_error_observed = 1; return 0;
  }
  return getsockopt(fd, level, option, value, length);
}
#define kevent(...) fixture_kevent(__VA_ARGS__)
#define recv fixture_recv
#define send fixture_send
#define getsockopt fixture_getsockopt
#include "../../native/shared/pm_tcp_proxy.c"
#undef kevent
#undef recv
#undef send
#undef getsockopt

int main(void) {
  int client[2], target[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, client) != 0 ||
      socketpair(AF_UNIX, SOCK_STREAM, 0, target) != 0) return 2;
  fixture_client = client[0]; fixture_target = target[0];
  pm_tcp_proxy_forward(client[0], target[0]);
  close(client[0]); close(client[1]); close(target[0]); close(target[1]);
  printf("{\"waits\":%d,\"backpressuredEvents\":%d,\"errorObserved\":%d,\"sends\":%d}\n",
    fixture_waits, fixture_starved_waits, fixture_error_observed, fixture_sends);
  return fixture_error_observed ? 0 : 1;
}

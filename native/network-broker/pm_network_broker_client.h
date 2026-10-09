#ifndef PM_NETWORK_BROKER_CLIENT_H
#define PM_NETWORK_BROKER_CLIENT_H

#include "pm_network_broker_protocol.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

/* Called with interposition depth held by the hook. Only AF_UNIX transport is
 * used here; it cannot turn a denied direct TCP operation into a raw fallback. */
static long long pm_nb_client_now(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int pm_nb_client_wait(int fd, short events, long long deadline) {
  for (;;) {
    long long remaining = deadline - pm_nb_client_now();
    if (remaining <= 0) { errno = ETIMEDOUT; return -1; }
    struct pollfd item = { .fd = fd, .events = events };
    int ready = poll(&item, 1, (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) { if (ready == 0) errno = ETIMEDOUT; return -1; }
    if (item.revents & events) return 0;
    errno = ECONNRESET; return -1;
  }
}

static int pm_nb_client_call(const char *socket_path, const pm_nb_request *request,
    int passed_fd, pm_nb_response *response, int *received_fd) {
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (socket_path == NULL || strlen(socket_path) >= sizeof(address.sun_path)) { errno = ENAMETOOLONG; return -1; }
  memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
#if defined(__APPLE__)
  int no_sigpipe = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) { int error = errno; close(fd); errno = error; return -1; }
#endif
  int error = 0, rights_sent = 0;
  *received_fd = -1;
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0 || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) goto fail;
  long long deadline = pm_nb_client_now() + 10000;
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    if (errno != EINPROGRESS || pm_nb_client_wait(fd, POLLOUT, deadline) != 0) goto fail;
    socklen_t size = sizeof(error);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) != 0) goto fail;
    if (error != 0) { errno = error; goto fail; }
  }
  size_t sent = 0;
  while (sent < sizeof(*request)) {
    struct iovec data = { .iov_base = (unsigned char *)request + sent, .iov_len = sizeof(*request) - sent };
    union { struct cmsghdr aligned; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } ancillary;
    struct msghdr message;
    memset(&message, 0, sizeof(message));
    message.msg_iov = &data; message.msg_iovlen = 1;
    if (passed_fd >= 0 && !rights_sent) {
      memset(&ancillary, 0, sizeof(ancillary));
      message.msg_control = ancillary.bytes; message.msg_controllen = sizeof(ancillary.bytes);
      struct cmsghdr *header = CMSG_FIRSTHDR(&message);
      header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
      memcpy(CMSG_DATA(header), &passed_fd, sizeof(int));
    }
    ssize_t count = sendmsg(fd, &message,
#ifdef MSG_NOSIGNAL
      MSG_NOSIGNAL
#else
      0
#endif
    );
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (pm_nb_client_wait(fd, POLLOUT, deadline) == 0) continue;
    }
    if (count <= 0) goto fail;
    rights_sent = 1; sent += (size_t)count;
  }
  size_t read_bytes = 0;
  memset(response, 0, sizeof(*response));
  while (read_bytes < sizeof(*response)) {
    struct iovec data = { .iov_base = (unsigned char *)response + read_bytes, .iov_len = 1 };
    union { struct cmsghdr aligned; unsigned char bytes[CMSG_SPACE(PM_NB_RIGHTS_CAPACITY * sizeof(int))]; } ancillary;
    struct msghdr message;
    memset(&message, 0, sizeof(message)); memset(&ancillary, 0, sizeof(ancillary));
    message.msg_iov = &data; message.msg_iovlen = 1;
    message.msg_control = ancillary.bytes; message.msg_controllen = sizeof(ancillary.bytes);
    ssize_t count = recvmsg(fd, &message, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (pm_nb_client_wait(fd, POLLIN, deadline) == 0) continue;
    }
    int invalid = (message.msg_flags & MSG_CTRUNC) != 0;
    for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header != NULL; header = CMSG_NXTHDR(&message, header)) {
      if (header->cmsg_len < CMSG_LEN(0) || header->cmsg_len > (size_t)((unsigned char *)message.msg_control + message.msg_controllen - (unsigned char *)header)) { invalid = 1; break; }
      if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) { invalid = 1; continue; }
      size_t bytes = header->cmsg_len >= CMSG_LEN(0) ? header->cmsg_len - CMSG_LEN(0) : 0;
      if (bytes % sizeof(int) != 0) invalid = 1;
      for (size_t offset = 0; offset + sizeof(int) <= bytes; offset += sizeof(int)) {
        int acquired; memcpy(&acquired, (unsigned char *)CMSG_DATA(header) + offset, sizeof(acquired));
        if (*received_fd >= 0 || invalid) { close(acquired); invalid = 1; }
        else { *received_fd = acquired; if (fcntl(acquired, F_SETFD, FD_CLOEXEC) != 0) invalid = 1; }
      }
    }
    if (invalid) { errno = EPROTO; goto fail; }
    if (count <= 0) { if (count == 0) errno = ECONNRESET; goto fail; }
    read_bytes += (size_t)count;
  }
  if (response->magic != PM_NB_MAGIC || response->version != PM_NB_VERSION || response->operation != request->operation ||
      response->address_length > PM_NB_ADDRESS_CAPACITY ||
      ((*received_fd >= 0) != (response->error == 0 && (request->operation == PM_NB_SOCKET || request->operation == PM_NB_ACCEPT)))) {
    errno = EPROTO; goto fail;
  }
  if (response->error != 0) { errno = response->error; goto fail; }
  if (*received_fd >= 0) {
    unsigned char acknowledgement = PM_NB_FD_ACK;
    for (;;) {
      ssize_t count = send(fd, &acknowledgement, 1,
#ifdef MSG_NOSIGNAL
        MSG_NOSIGNAL
#else
        0
#endif
      );
      if (count == 1) break;
      if (count < 0 && errno == EINTR) continue;
      if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) && pm_nb_client_wait(fd, POLLOUT, deadline) == 0) continue;
      goto fail;
    }
  }
  close(fd);
  return 0;
fail:
  error = errno != 0 ? errno : EIO;
  close(fd);
  if (*received_fd >= 0) { close(*received_fd); *received_fd = -1; }
  errno = error;
  return -1;
}
#endif

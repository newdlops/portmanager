#include "../../native/network-broker/pm_network_broker_client.h"
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#if defined(__APPLE__)
#include <libproc.h>
#endif

/* Raw transport cases exercise broker ownership rather than the well-formed
 * client helper. All descriptors are disposable fixture descriptors. */
static int control_socket(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(address.sun_path)) { close(fd); return -1; }
  strcpy(address.sun_path, path);
  struct timeval timeout = { .tv_sec = 3 };
  if (fd < 0 || setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0 ||
      connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { if (fd >= 0) close(fd); return -1; }
  return fd;
}
static int send_raw(int control, const pm_nb_request *request, int fd, size_t fd_count) {
  struct iovec data = { .iov_base = (void *)request, .iov_len = sizeof(*request) };
  union { struct cmsghdr aligned; unsigned char bytes[CMSG_SPACE(253 * sizeof(int))]; } ancillary;
  struct msghdr message;
  memset(&message, 0, sizeof(message)); memset(&ancillary, 0, sizeof(ancillary));
  message.msg_iov = &data; message.msg_iovlen = 1;
  if (fd_count > 253) return -1;
  if (fd_count > 0) {
    message.msg_control = ancillary.bytes; message.msg_controllen = CMSG_SPACE(fd_count * sizeof(int));
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(fd_count * sizeof(int));
    for (size_t index = 0; index < fd_count; index++) memcpy((char *)CMSG_DATA(header) + index * sizeof(int), &fd, sizeof(fd));
  }
  return sendmsg(control, &message, 0) == sizeof(*request) ? 0 : -1;
}
static int receive_raw(int control, pm_nb_response *response, int *received) {
  struct iovec data = { .iov_base = response, .iov_len = sizeof(*response) };
  union { struct cmsghdr aligned; unsigned char bytes[CMSG_SPACE(4 * sizeof(int))]; } ancillary;
  struct msghdr message;
  memset(&message, 0, sizeof(message));
  message.msg_iov = &data; message.msg_iovlen = 1;
  message.msg_control = ancillary.bytes; message.msg_controllen = sizeof(ancillary.bytes);
  ssize_t count = recvmsg(control, &message, MSG_WAITALL);
  *received = -1;
  for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); count > 0 && header != NULL; header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) continue;
    size_t bytes = header->cmsg_len - CMSG_LEN(0);
    for (size_t offset = 0; offset + sizeof(int) <= bytes; offset += sizeof(int)) {
      int fd; memcpy(&fd, (char *)CMSG_DATA(header) + offset, sizeof(fd));
      if (*received >= 0) close(fd); else *received = fd;
    }
  }
  if (count == sizeof(*response)) return 0;
  if (count == 0) errno = ECONNRESET;
  return -1;
}

static pm_nb_request request_for(int operation) {
  pm_nb_request request;
  memset(&request, 0, sizeof(request)); request.magic = PM_NB_MAGIC;
  request.version = PM_NB_VERSION; request.operation = operation;
  return request;
}
static int invoke(const char *path, int operation, int fd, const char *host, int port, int *returned) {
  pm_nb_request request = request_for(operation);
  if (operation == PM_NB_BIND || operation == PM_NB_CONNECT) {
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address)); address.sin_family = AF_INET;
#if defined(__APPLE__)
    address.sin_len = sizeof(address);
#endif
    address.sin_port = htons((unsigned short)port);
    if (inet_pton(AF_INET, host, &address.sin_addr) != 1) return -1;
    request.address_length = sizeof(address); memcpy(request.address, &address, sizeof(address));
  } else if (operation == PM_NB_LISTEN) request.backlog = 16;
  else if (operation == PM_NB_SOCKET) { request.domain = AF_INET; request.type = SOCK_STREAM; }
  pm_nb_response response;
  return pm_nb_client_call(path, &request, fd, &response, returned);
}
int main(int argc, char **argv) {
  if (argc < 3) return 2;
#if defined(__APPLE__)
  if (argc == 3 && strcmp(argv[1], "descriptor-count") == 0) {
    int bytes = proc_pidinfo(atoi(argv[2]), PROC_PIDLISTFDS, 0, NULL, 0);
    if (bytes <= 0) return 3;
    struct proc_fdinfo *fds = malloc((size_t)bytes);
    if (fds == NULL) return 3;
    bytes = proc_pidinfo(atoi(argv[2]), PROC_PIDLISTFDS, 0, fds, bytes);
    free(fds);
    if (bytes <= 0) return 3;
    printf("%zu\n", (size_t)bytes / sizeof(struct proc_fdinfo)); return 0;
  }
#endif
  int fd = socket(AF_INET, SOCK_STREAM, 0), returned = -1, result = -1;
  if (fd < 0) return 3;
  if (argc == 5 && (strcmp(argv[1], "connect") == 0 || strcmp(argv[1], "connect-nonblocking") == 0)) {
    int nonblocking = strcmp(argv[1], "connect-nonblocking") == 0;
    if (nonblocking && fcntl(fd, F_SETFL, O_NONBLOCK) != 0) return 3;
    result = invoke(argv[2], PM_NB_CONNECT, fd, argv[3], atoi(argv[4]), &returned);
    if (nonblocking && result < 0 && errno == EINPROGRESS) {
      struct pollfd item = { .fd = fd, .events = POLLOUT };
      int error = 0; socklen_t size = sizeof(error);
      if (poll(&item, 1, 3000) > 0 && getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && error == 0) result = 0;
      else errno = error != 0 ? error : ETIMEDOUT;
    }
    if (result == 0) {
      if (nonblocking && fcntl(fd, F_SETFL, 0) != 0) return 3;
      char bytes[32];
      result = write(fd, "fixture", 7) == 7 && read(fd, bytes, sizeof(bytes)) == 2 && memcmp(bytes, "ok", 2) == 0 ? 0 : -1;
    }
  } else if (argc == 3 && strcmp(argv[1], "server") == 0) {
    result = invoke(argv[2], PM_NB_BIND, fd, "0.0.0.0", 0, &returned);
    if (result == 0) result = invoke(argv[2], PM_NB_LISTEN, fd, NULL, 0, &returned);
    if (result == 0) {
      struct sockaddr_in local; socklen_t size = sizeof(local);
      if (getsockname(fd, (struct sockaddr *)&local, &size) != 0) return 3;
      char host[64]; inet_ntop(AF_INET, &local.sin_addr, host, sizeof(host));
      printf("ready %s %d\n", host, ntohs(local.sin_port)); fflush(stdout);
      result = invoke(argv[2], PM_NB_ACCEPT, fd, NULL, 0, &returned);
      if (result == 0) {
        char bytes[32];
        ssize_t count = read(returned, bytes, sizeof(bytes));
        if (count != 7) printf("server read=%zd errno=%d flags=%d\n", count, errno, fcntl(returned, F_GETFL, 0));
        result = count == 7 && memcmp(bytes, "fixture", 7) == 0 && write(returned, "ok", 2) == 2 ? 0 : -1;
        close(returned); returned = -1;
      }
    }
  } else if (argc == 3 && strcmp(argv[1], "unknown-op") == 0) {
    result = invoke(argv[2], 255, fd, NULL, 0, &returned);
  } else if (argc == 3 && strcmp(argv[1], "socket") == 0) {
    result = invoke(argv[2], PM_NB_SOCKET, -1, NULL, 0, &returned);
    if (returned >= 0) { close(returned); returned = -1; }
  } else if (argc == 3 && (strcmp(argv[1], "duplicate-rights") == 0 || strcmp(argv[1], "truncated-rights") == 0 || strcmp(argv[1], "many-rights") == 0)) {
    pm_nb_request request = request_for(PM_NB_CONNECT);
    int control = control_socket(argv[2]);
    pm_nb_response response;
    if (control < 0) return 3;
    size_t count = strcmp(argv[1], "duplicate-rights") == 0 ? 2 : strcmp(argv[1], "many-rights") == 0 ? 253 : 20;
    result = send_raw(control, &request, fd, count);
    if (result == 0) result = receive_raw(control, &response, &returned);
    if (result == 0) result = response.magic == PM_NB_MAGIC && response.error == EPROTO && returned < 0 ? 0 : -1;
    // Darwin can reject oversized ancillary data in recvmsg before delivering
    // a frame. An EOF with no returned authority is also a closed denial.
    else if (strcmp(argv[1], "truncated-rights") == 0 && errno == ECONNRESET && returned < 0) result = 0;
    if (returned >= 0) close(returned);
    close(control);
  } else if (argc == 3 && strcmp(argv[1], "hold-socket") == 0) {
    pm_nb_request request = request_for(PM_NB_SOCKET);
    request.domain = AF_INET; request.type = SOCK_STREAM;
    pm_nb_response response;
    int control = control_socket(argv[2]);
    if (control < 0) return 3;
    result = send_raw(control, &request, -1, 0);
    if (result == 0) result = receive_raw(control, &response, &returned);
    if (result == 0 && (response.error != 0 || returned < 0)) result = -1;
    if (result == 0) {
      puts("ready"); fflush(stdout);
      char byte;
      // The test shuts the broker down with an unacknowledged transfer. Its
      // copy must close while the recipient's independently installed FD lives.
      result = read(control, &byte, 1) == 0 && fcntl(returned, F_GETFD, 0) >= 0 ? 0 : -1;
    }
    if (returned >= 0) close(returned);
    close(control);
  } else if (argc == 3 && strcmp(argv[1], "invalid-fd") == 0) {
    pm_nb_request request = request_for(PM_NB_LISTEN);
    pm_nb_response response;
    int regular = open("/dev/null", O_RDONLY);
    result = pm_nb_client_call(argv[2], &request, regular, &response, &returned);
    result = result < 0 && errno == EINVAL && returned < 0 ? 0 : -1;
    close(regular);
  } else if (argc == 3 && (strcmp(argv[1], "cancel-accept") == 0 || strcmp(argv[1], "cancel-accept-halfclose") == 0)) {
    result = invoke(argv[2], PM_NB_BIND, fd, "127.0.0.1", 0, &returned);
    if (result == 0) result = invoke(argv[2], PM_NB_LISTEN, fd, NULL, 0, &returned);
    int original = fcntl(fd, F_GETFL, 0), control = control_socket(argv[2]);
    pm_nb_request request = request_for(PM_NB_ACCEPT);
    if (result == 0 && control >= 0) result = send_raw(control, &request, fd, 1); else result = -1;
    long long deadline = pm_nb_client_now() + 1500;
    while (result == 0 && !(fcntl(fd, F_GETFL, 0) & O_NONBLOCK) && pm_nb_client_now() < deadline) usleep(5000);
    if (result == 0 && !(fcntl(fd, F_GETFL, 0) & O_NONBLOCK)) result = -1;
    if (strcmp(argv[1], "cancel-accept") == 0) {
      close(control); control = -1;
    } else {
      if (result == 0 && shutdown(control, SHUT_WR) != 0) result = -1;
    }
    deadline = pm_nb_client_now() + 1500;
    while (result == 0 && fcntl(fd, F_GETFL, 0) != original && pm_nb_client_now() < deadline) usleep(5000);
    if (result == 0 && fcntl(fd, F_GETFL, 0) != original) result = -1;
    if (control >= 0) close(control);
  }
  int error = errno;
  close(fd);
  if (result == 0) { puts("allowed"); return 0; }
  printf("failed errno=%d\n", error);
  return error == EACCES || error == EPERM ? 1 : 3;
}

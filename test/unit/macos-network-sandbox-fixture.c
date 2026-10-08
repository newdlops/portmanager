/* Raw libc/syscalls with no Port Manager hook: verify kernel policy, not env cooperation. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/sysctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "hold") == 0) {
    puts("synthetic-victim-ready"); fflush(stdout);
    for (;;) pause();
  }
  int fd = -1;
  int result = -1;
  if (argc == 2 && strcmp(argv[1], "socket-only") == 0) {
    fd = socket(AF_INET, SOCK_STREAM, 0);
    result = fd >= 0 ? 0 : -1;
  } else if (argc == 3 && strcmp(argv[1], "read") == 0) {
    fd = open(argv[2], O_RDONLY);
    if (fd >= 0) {
      char byte;
      result = read(fd, &byte, 1) == 1 ? 0 : -1;
    }
  } else if (argc == 3 && strcmp(argv[1], "write") == 0) {
    fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) result = write(fd, "fixture", 7) == 7 ? 0 : -1;
  } else if (argc == 4 && strcmp(argv[1], "tcp") == 0) {
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons((unsigned short)atoi(argv[3]));
    if (inet_pton(AF_INET, argv[2], &address.sin_addr) != 1) return 2;
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) result = connect(fd, (struct sockaddr *)&address, sizeof(address));
  } else if (argc == 3 && strcmp(argv[1], "unix") == 0) {
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    snprintf(address.sun_path, sizeof(address.sun_path), "%s", argv[2]);
    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd >= 0) result = connect(fd, (struct sockaddr *)&address, sizeof(address));
  } else if ((argc == 3 && strcmp(argv[1], "brokered-tcp") == 0) ||
             (argc == 5 && strcmp(argv[1], "brokered-connect") == 0)) {
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    snprintf(address.sun_path, sizeof(address.sun_path), "%s", argv[2]);
    int control = socket(AF_UNIX, SOCK_STREAM, 0);
    if (control < 0 || connect(control, (struct sockaddr *)&address, sizeof(address)) != 0) return 1;
    char byte;
    struct iovec data = { &byte, 1 };
    union { struct cmsghdr aligned; char bytes[CMSG_SPACE(sizeof(int))]; } ancillary;
    struct msghdr message;
    memset(&message, 0, sizeof(message));
    message.msg_iov = &data; message.msg_iovlen = 1;
    message.msg_control = ancillary.bytes; message.msg_controllen = sizeof(ancillary.bytes);
    if (recvmsg(control, &message, 0) != 1) return 3;
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    if (header == NULL || header->cmsg_type != SCM_RIGHTS) return 3;
    memcpy(&fd, CMSG_DATA(header), sizeof(fd));
    close(control);
    if (argc == 5) {
      struct sockaddr_in target;
      memset(&target, 0, sizeof(target));
      target.sin_family = AF_INET;
      target.sin_port = htons((unsigned short)atoi(argv[4]));
      if (inet_pton(AF_INET, argv[3], &target.sin_addr) != 1) return 2;
      result = connect(fd, (struct sockaddr *)&target, sizeof(target));
    } else result = write(fd, "fixture", 7) == 7 ? 0 : -1;
  } else if (argc == 3 && strcmp(argv[1], "signal") == 0) {
    result = kill((pid_t)atoi(argv[2]), 0);
  } else if (argc == 3 && strcmp(argv[1], "unlink") == 0) {
    result = unlink(argv[2]);
  } else if (argc == 4 && strcmp(argv[1], "link") == 0) {
    result = link(argv[2], argv[3]);
  } else if (argc == 3 && strcmp(argv[1], "process-env") == 0) {
    int mib[] = { CTL_KERN, KERN_PROCARGS2, atoi(argv[2]) };
    char buffer[256 * 1024];
    size_t size = sizeof(buffer);
    result = sysctl(mib, 3, buffer, &size, NULL, 0);
    if (result == 0) {
      const char secret[] = "PM_AUDIT_SYNTHETIC_SECRET=fake-other-network-value";
      int found = 0;
      for (size_t index = 0; index + sizeof(secret) - 1 <= size; index++) {
        if (memcmp(buffer + index, secret, sizeof(secret) - 1) == 0) { found = 1; break; }
      }
      if (!found) { result = -1; errno = EACCES; }
    }
  } else {
    return 2;
  }
  int failure = errno;
  if (fd >= 0) close(fd);
  if (result == 0) { puts("allowed"); return 0; }
  printf("denied errno=%d\n", failure);
  return failure == EPERM || failure == EACCES ? 1 : 3;
}

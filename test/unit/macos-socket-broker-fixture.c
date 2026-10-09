/* Trusted synthetic FD broker. It can connect only the single endpoint passed by the test. */
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  struct sockaddr_un local;
  memset(&local, 0, sizeof(local));
  local.sun_family = AF_UNIX;
  snprintf(local.sun_path, sizeof(local.sun_path), "%s", argv[1]);
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0 || bind(server, (struct sockaddr *)&local, sizeof(local)) != 0 || listen(server, 8) != 0) return 1;
  puts("ready"); fflush(stdout);
  for (;;) {
    int client = accept(server, NULL, NULL);
    if (client < 0) return 1;
    struct sockaddr_in target;
    memset(&target, 0, sizeof(target));
    target.sin_family = AF_INET;
    target.sin_port = htons((unsigned short)atoi(argv[2]));
    target.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0 || (strcmp(argv[2], "unconnected") != 0 && connect(fd, (struct sockaddr *)&target, sizeof(target)) != 0)) return 1;
    char byte = 'x';
    struct iovec data = { &byte, 1 };
    union { struct cmsghdr aligned; char bytes[CMSG_SPACE(sizeof(int))]; } ancillary;
    memset(&ancillary, 0, sizeof(ancillary));
    struct msghdr message;
    memset(&message, 0, sizeof(message));
    message.msg_iov = &data; message.msg_iovlen = 1;
    message.msg_control = ancillary.bytes; message.msg_controllen = sizeof(ancillary.bytes);
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(fd));
    memcpy(CMSG_DATA(header), &fd, sizeof(fd));
    sendmsg(client, &message, 0);
    close(fd); close(client);
  }
}

/* Fill a real socket send buffer before queue admission, then validate every
 * byte of the bounded FIFO as the receiver drains fragmented reads. */
#include "../../native/shared/pm_tcp_proxy.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void frame_for(int index, char *frame) {
  int length = snprintf(frame, 1025, "FRAME%06d ", index);
  memset(frame + length, 'x', 1024 - (size_t)length);
  frame[1023] = '\n';
  frame[1024] = '\0';
}

int main(void) {
  int sockets[2], send_buffer = 1024, accepted = 0, rejected = 0;
  char frame[1025], received[1024], fragment[37];
  size_t padding = 0;
  signal(SIGPIPE, SIG_IGN);
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) return 2;
  setsockopt(sockets[0], SOL_SOCKET, SO_SNDBUF, &send_buffer, sizeof(send_buffer));
  if (pm_tcp_proxy_prepare_socket(sockets[0]) != 0) return 3;
  memset(frame, '#', 1024);
  for (;;) {
    ssize_t count = write(sockets[0], frame, 1024);
    if (count > 0) { padding += (size_t)count; continue; }
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
    return 4;
  }
  if (pm_tcp_proxy_control_start(sockets[0]) != 0) return 5;
  for (int index = 0; index < 5000; index++) {
    frame_for(index, frame);
    if (pm_tcp_proxy_control_write(frame) == 0) accepted++;
    else rejected++;
  }
  while (padding > 0) {
    size_t request = padding < sizeof(fragment) ? padding : sizeof(fragment);
    ssize_t count = read(sockets[1], fragment, request);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 6;
    for (ssize_t index = 0; index < count; index++) if (fragment[index] != '#') return 7;
    padding -= (size_t)count;
  }
  for (int index = 0; index < accepted; index++) {
    size_t length = 0;
    while (length < sizeof(received)) {
      size_t request = sizeof(received) - length;
      if (request > sizeof(fragment)) request = sizeof(fragment);
      ssize_t count = read(sockets[1], received + length, request);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) return 8;
      length += (size_t)count;
    }
    frame_for(index, frame);
    if (memcmp(frame, received, 1024) != 0) return 9;
  }
  printf("{\"accepted\":%d,\"rejected\":%d,\"verifiedBytes\":%d}\n", accepted, rejected, accepted * 1024);
  return accepted == 4096 && rejected == 904 ? 0 : 1;
}

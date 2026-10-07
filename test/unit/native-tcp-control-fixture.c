/*
 * A real controller pipe stops reading after READY. Fill its kernel buffer,
 * then verify that pending clients expire while an established stream survives.
 * The same child resumes without restart; stale replies cannot open a target.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int64_t now_ms(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

static int readable(int fd, int64_t deadline) {
  for (;;) {
    int64_t remaining = deadline - now_ms();
    struct pollfd event = { .fd = fd, .events = POLLIN, .revents = 0 };
    if (remaining <= 0) return -1;
    int result = poll(&event, 1, (int)remaining);
    if (result < 0 && errno == EINTR) continue;
    return result > 0 ? 0 : -1;
  }
}

static int read_line(int fd, char *line, size_t capacity, int64_t deadline) {
  size_t length = 0;
  while (length + 1 < capacity) {
    if (readable(fd, deadline) != 0) return -1;
    ssize_t count = read(fd, line + length, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count != 1) return -1;
    if (line[length++] == '\n') { line[length] = '\0'; return 0; }
  }
  return -1;
}

static int request_id(int output, char *id, size_t capacity, int64_t deadline) {
  char line[2048];
  while (read_line(output, line, sizeof(line), deadline) == 0) {
    if (strncmp(line, "CONNECT\t", 8) != 0) continue;
    char *end = strchr(line + 8, '\t');
    if (end == NULL || (size_t)(end - line - 8) >= capacity) return -1;
    *end = '\0';
    snprintf(id, capacity, "%s", line + 8);
    return 0;
  }
  return -1;
}

static int write_all(int fd, const char *bytes, size_t length) {
  for (size_t sent = 0; sent < length;) {
    ssize_t count = write(fd, bytes + sent, length - sent);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    sent += (size_t)count;
  }
  return 0;
}

static int answer(int input, const char *id, int port) {
  char response[128];
  int length = snprintf(response, sizeof(response), "ROUTE\t%s\t127.0.0.1\t%d\n", id, port);
  return write_all(input, response, (size_t)length);
}

static int listener(int *port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = 0 };
  socklen_t length = sizeof(address);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (fd < 0 || bind(fd, (struct sockaddr *)&address, length) != 0 || listen(fd, 16) != 0) return -1;
  if (getsockname(fd, (struct sockaddr *)&address, &length) != 0) return -1;
  *port = ntohs(address.sin_port);
  return fd;
}

static int client(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (fd < 0) return -1;
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { close(fd); return -1; }
  return fd;
}

static int read_bytes(int fd, char *bytes, size_t length, int64_t deadline) {
  for (size_t read_count = 0; read_count < length;) {
    if (readable(fd, deadline) != 0) return -1;
    ssize_t count = read(fd, bytes + read_count, length - read_count);
    if (count <= 0) return -1;
    read_count += (size_t)count;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int input[2], output[2], port, target_port;
  int target = listener(&target_port);
  int reservation = listener(&port);
  if (target < 0 || reservation < 0 || pipe(input) != 0 || pipe(output) != 0) return 3;
  close(reservation);
  signal(SIGPIPE, SIG_IGN);
  setenv("PORT_MANAGER_HOOK_DISABLED", "1", 1);
  setenv("PORT_MANAGER_PROXY_MAX_CONNECTIONS", "5", 1);
  setenv("PORT_MANAGER_PROXY_ROUTE_TIMEOUT_MS", "250", 1);
  setenv("PORT_MANAGER_ROUTER_RESPONSE_TIMEOUT_MS", "250", 1);
  char port_text[16];
  snprintf(port_text, sizeof(port_text), "%d", port);
  pid_t child = fork();
  if (child == 0) {
    dup2(input[0], STDIN_FILENO);
    dup2(output[1], STDOUT_FILENO);
    close(input[0]); close(input[1]); close(output[0]); close(output[1]); close(target);
    if (strcmp(argv[2], "host") == 0) execl(argv[1], argv[1], "127.0.0.1", port_text, (char *)NULL);
    else execl(argv[1], argv[1], port_text, (char *)NULL);
    _exit(127);
  }
  if (child < 0) return 4;
  close(input[0]);
  /* Retain the parent's duplicate output writer solely to fill the real pipe. */
  char line[2048], id[64], bytes[4];
  int healthy = -1, backend = -1, fresh = -1, closed_clients = 0, late_targets = 0, survived = 0, recovered = 0;
  int pending[4] = { -1, -1, -1, -1 };
  int result = 1;
  if (read_line(output[0], line, sizeof(line), now_ms() + 5000) != 0 || strncmp(line, "READY\t", 6) != 0) goto cleanup;
  healthy = client(port);
  if (healthy < 0 || request_id(output[0], id, sizeof(id), now_ms() + 5000) != 0
      || answer(input[1], id, target_port) != 0 || readable(target, now_ms() + 3000) != 0) goto cleanup;
  backend = accept(target, NULL, NULL);
  if (backend < 0 || write_all(backend, "keep", 4) != 0
      || read_bytes(healthy, bytes, 4, now_ms() + 3000) != 0 || memcmp(bytes, "keep", 4) != 0) goto cleanup;

  int flags = fcntl(output[1], F_GETFL);
  if (flags < 0 || fcntl(output[1], F_SETFL, flags | O_NONBLOCK) != 0) goto cleanup;
  char padding[1024];
  memset(padding, 'x', sizeof(padding));
  padding[sizeof(padding) - 1] = '\n';
  while (write(output[1], padding, sizeof(padding)) > 0) {}
  if (errno != EAGAIN && errno != EWOULDBLOCK) goto cleanup;
  if (fcntl(output[1], F_SETFL, flags) != 0) goto cleanup;
  int64_t started = now_ms(), close_deadline = started + 3500;
  for (int index = 0; index < 4; index++) if ((pending[index] = client(port)) < 0) goto cleanup;
  for (int index = 0; index < 4; index++) {
    if (readable(pending[index], close_deadline) == 0 && recv(pending[index], bytes, sizeof(bytes), 0) == 0) closed_clients++;
  }
  int64_t elapsed = now_ms() - started;
  if (closed_clients != 4) goto report;

  if (write_all(healthy, "ping", 4) == 0 && read_bytes(backend, bytes, 4, now_ms() + 1000) == 0
      && memcmp(bytes, "ping", 4) == 0 && write_all(backend, "pong", 4) == 0
      && read_bytes(healthy, bytes, 4, now_ms() + 1000) == 0 && memcmp(bytes, "pong", 4) == 0) survived = 1;

  /* Resuming the same control stream drains complete stale frames. Their
   * clients have already timed out, so their late answers must be ignored. */
  for (int index = 0; index < 4; index++) {
    if (request_id(output[0], id, sizeof(id), now_ms() + 5000) != 0 || answer(input[1], id, target_port) != 0) goto report;
  }
  if (readable(target, now_ms() + 100) == 0) late_targets++;
  fresh = client(port);
  if (fresh < 0 || request_id(output[0], id, sizeof(id), now_ms() + 5000) != 0
      || answer(input[1], id, target_port) != 0 || readable(target, now_ms() + 3000) != 0) goto report;
  int accepted = accept(target, NULL, NULL);
  if (accepted >= 0) {
    if (write_all(accepted, "new!", 4) == 0 && read_bytes(fresh, bytes, 4, now_ms() + 1000) == 0
        && memcmp(bytes, "new!", 4) == 0) recovered = 1;
    close(accepted);
  }
report:
  printf("{\"expiredClients\":%d,\"elapsedMs\":%lld,\"survived\":%d,\"lateTargets\":%d,\"recovered\":%d}\n",
    closed_clients, (long long)elapsed, survived, late_targets, recovered);
  result = closed_clients == 4 && survived && late_targets == 0 && recovered ? 0 : 1;
cleanup:
  kill(child, SIGKILL);
  waitpid(child, NULL, 0);
  for (int index = 0; index < 4; index++) if (pending[index] >= 0) close(pending[index]);
  if (healthy >= 0) close(healthy);
  if (backend >= 0) close(backend);
  if (fresh >= 0) close(fresh);
  close(target); close(input[1]); close(output[0]); close(output[1]);
  return result;
}

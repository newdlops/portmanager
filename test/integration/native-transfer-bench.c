/*
 * Real loopback echo traffic measures the native helper's established data
 * plane. Every returned byte is checked; client FIN must drain the full reply.
 * This fixture owns its sockets and never locates the user's daemon.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define BLOCK_SIZE 65536
#define MAX_CLIENTS 32

static unsigned char payload[BLOCK_SIZE];
static int64_t now_ns(void) {
  struct timespec value;
  clock_gettime(CLOCK_MONOTONIC, &value);
  return (int64_t)value.tv_sec * 1000000000 + value.tv_nsec;
}

static void prepare(int fd) {
  int enabled = 1;
  struct timeval timeout = { .tv_sec = 10, .tv_usec = 0 };
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
}

static int send_all(int fd, const void *data, size_t length) {
  const unsigned char *bytes = data;
  while (length > 0) {
    ssize_t sent = send(fd, bytes, length, 0);
    if (sent < 0 && errno == EINTR) continue;
    if (sent <= 0) return -1;
    bytes += sent;
    length -= (size_t)sent;
  }
  return 0;
}

static int receive_all(int fd, void *data, size_t length) {
  unsigned char *bytes = data;
  while (length > 0) {
    ssize_t received = recv(fd, bytes, length, 0);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) return -1;
    bytes += received;
    length -= (size_t)received;
  }
  return 0;
}

static int connect_client(int port) {
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons((unsigned short)port) };
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  prepare(fd);
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { close(fd); return -1; }
  return fd;
}

static void *echo_connection(void *raw) {
  int fd = *(int *)raw;
  unsigned char buffer[BLOCK_SIZE];
  free(raw);
  prepare(fd);
  for (;;) {
    ssize_t count = recv(fd, buffer, sizeof(buffer), 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || send_all(fd, buffer, (size_t)count) != 0) break;
  }
  shutdown(fd, SHUT_WR);
  close(fd);
  return NULL;
}

static int server(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = 0 };
  socklen_t length = sizeof(address);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (fd < 0 || bind(fd, (struct sockaddr *)&address, length) != 0 || listen(fd, 32) != 0) return 2;
  getsockname(fd, (struct sockaddr *)&address, &length);
  printf("READY %d\n", ntohs(address.sin_port));
  fflush(stdout);
  for (;;) {
    int *client = malloc(sizeof(*client));
    pthread_t thread;
    if (client == NULL) return 3;
    *client = accept(fd, NULL, NULL);
    if (*client < 0 || pthread_create(&thread, NULL, echo_connection, client) != 0) { if (*client >= 0) close(*client); free(client); return 4; }
    pthread_detach(thread);
  }
}

typedef struct transfer {
  int fd;
  atomic_int failed;
  int seconds;
  int send_error;
  int receive_error;
  int mismatch;
  uint64_t sent;
  uint64_t received;
} transfer_t;

static void *write_transfer(void *raw) {
  transfer_t *transfer = raw;
  int64_t deadline = now_ns() + (int64_t)transfer->seconds * 1000000000;
  do {
    if (send_all(transfer->fd, payload, sizeof(payload)) != 0) { transfer->send_error = errno; transfer->failed = 1; break; }
    transfer->sent += sizeof(payload);
  } while (now_ns() < deadline);
  shutdown(transfer->fd, SHUT_WR);
  return NULL;
}

static void *run_transfer(void *raw) {
  transfer_t *transfer = raw;
  unsigned char buffer[BLOCK_SIZE];
  pthread_t writer;
  if (pthread_create(&writer, NULL, write_transfer, transfer) != 0) { transfer->failed = 1; return NULL; }
  for (;;) {
    ssize_t count = recv(transfer->fd, buffer, sizeof(buffer), 0);
    if (count < 0 && errno == EINTR) continue;
    if (count == 0) break;
    size_t offset = (size_t)(transfer->received % BLOCK_SIZE);
    size_t first = count > 0 && (size_t)count < BLOCK_SIZE - offset ? (size_t)count : BLOCK_SIZE - offset;
    if (count < 0 || memcmp(buffer, payload + offset, first) != 0 ||
        ((size_t)count > first && memcmp(buffer + first, payload, (size_t)count - first) != 0)) {
      if (count < 0) transfer->receive_error = errno;
      else transfer->mismatch = 1;
      transfer->failed = 1; shutdown(transfer->fd, SHUT_RDWR); break;
    }
    transfer->received += (uint64_t)count;
  }
  pthread_join(writer, NULL);
  if (transfer->received != transfer->sent) transfer->failed = 1;
  return NULL;
}

static int compare_double(const void *left, const void *right) {
  double a = *(const double *)left, b = *(const double *)right;
  return (a > b) - (a < b);
}

static int latency(int port) {
  int fd = connect_client(port);
  unsigned char reply[64];
  double times[1000];
  if (fd < 0) return 5;
  for (int index = -100; index < 1000; index++) {
    int64_t start = now_ns();
    if (send_all(fd, payload, sizeof(reply)) != 0 || receive_all(fd, reply, sizeof(reply)) != 0 || memcmp(reply, payload, sizeof(reply)) != 0) { close(fd); return 6; }
    if (index >= 0) times[index] = (double)(now_ns() - start) / 1000;
  }
  shutdown(fd, SHUT_WR);
  close(fd);
  qsort(times, 1000, sizeof(double), compare_double);
  printf("{\"p50Us\":%.3f,\"p95Us\":%.3f,\"p99Us\":%.3f,\"messages\":1000}\n", times[500], times[950], times[990]);
  return 0;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  for (size_t index = 0; index < sizeof(payload); index++) payload[index] = (unsigned char)(index * 131 + index / 256);
  if (argc == 2 && strcmp(argv[1], "server") == 0) return server();
  if (argc == 3 && strcmp(argv[1], "latency") == 0) return latency(atoi(argv[2]));
  if (argc != 5 || strcmp(argv[1], "bulk") != 0) return 2;
  int port = atoi(argv[2]), clients = atoi(argv[3]), seconds = atoi(argv[4]);
  if (clients < 1 || clients > MAX_CLIENTS || seconds < 1 || seconds > 30) return 2;
  transfer_t transfers[MAX_CLIENTS] = {0};
  pthread_t threads[MAX_CLIENTS];
  unsigned char warm[BLOCK_SIZE];
  for (int index = 0; index < clients; index++) {
    transfers[index].fd = connect_client(port);
    transfers[index].seconds = seconds;
    if (transfers[index].fd < 0 || send_all(transfers[index].fd, payload, sizeof(payload)) != 0 || receive_all(transfers[index].fd, warm, sizeof(warm)) != 0 || memcmp(warm, payload, sizeof(warm)) != 0) return 5;
  }
  int64_t start = now_ns();
  for (int index = 0; index < clients; index++) if (pthread_create(&threads[index], NULL, run_transfer, &transfers[index]) != 0) return 6;
  uint64_t bytes = 0;
  int failures = 0;
  for (int index = 0; index < clients; index++) {
    pthread_join(threads[index], NULL);
    close(transfers[index].fd);
    bytes += transfers[index].received;
    failures += transfers[index].failed;
  }
  double elapsed = (double)(now_ns() - start) / 1000000000;
  printf("{\"seconds\":%.6f,\"connections\":%d,\"echoedBytes\":%llu,\"payloadMiBps\":%.3f,\"failures\":%d,\"streams\":[", elapsed, clients, (unsigned long long)bytes, bytes / 1048576.0 / elapsed, failures);
  for (int index = 0; index < clients; index++) printf("%s{\"sent\":%llu,\"received\":%llu,\"sendError\":%d,\"receiveError\":%d,\"mismatch\":%d}", index ? "," : "", (unsigned long long)transfers[index].sent, (unsigned long long)transfers[index].received, transfers[index].send_error, transfers[index].receive_error, transfers[index].mismatch);
  printf("]}\n");
  return failures ? 7 : 0;
}

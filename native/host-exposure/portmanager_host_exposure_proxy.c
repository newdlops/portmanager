#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "../shared/pm_tcp_proxy.h"

#define PM_HOST_PROXY_BACKLOG 128
#define PM_HOST_PROXY_HOST_SIZE 256
#define PM_HOST_PROXY_LINE_SIZE 1024
#define PM_HOST_PROXY_MAX_LISTENERS 8
#define PM_HOST_PROXY_ROUTE_RESPONSE_TIMEOUT_MS 5000

typedef struct pending_route {
  uint64_t id;
  int resolved;
  int failed;
  char host[PM_HOST_PROXY_HOST_SIZE];
  int port;
  pthread_cond_t condition;
  struct pending_route *next;
} pending_route_t;

typedef struct accepted_connection {
  int client_fd;
  char local_address[PM_HOST_PROXY_HOST_SIZE];
  int local_port;
  char remote_address[PM_HOST_PROXY_HOST_SIZE];
  int remote_port;
} accepted_connection_t;

static pthread_mutex_t pm_pending_mutex = PTHREAD_MUTEX_INITIALIZER;
static pending_route_t *pm_pending_routes = NULL;
static uint64_t pm_next_route_id = 1;
static long pm_route_response_timeout_ms = PM_HOST_PROXY_ROUTE_RESPONSE_TIMEOUT_MS;

static int pm_write_protocol_line(const char *line) {
  return pm_tcp_proxy_control_write(line);
}

static uint64_t pm_allocate_route_id(void) {
  uint64_t id;

  pthread_mutex_lock(&pm_pending_mutex);
  id = pm_next_route_id++;
  if (pm_next_route_id == 0) {
    pm_next_route_id = 1;
  }
  pthread_mutex_unlock(&pm_pending_mutex);

  return id;
}

static void pm_add_pending_route(pending_route_t *route) {
  pthread_mutex_lock(&pm_pending_mutex);
  route->next = pm_pending_routes;
  pm_pending_routes = route;
  pthread_mutex_unlock(&pm_pending_mutex);
}

static void pm_remove_pending_route(pending_route_t *route) {
  pending_route_t **cursor;

  pthread_mutex_lock(&pm_pending_mutex);
  cursor = &pm_pending_routes;
  while (*cursor != NULL) {
    if (*cursor == route) {
      *cursor = route->next;
      break;
    }
    cursor = &(*cursor)->next;
  }
  pthread_mutex_unlock(&pm_pending_mutex);
}

static pending_route_t *pm_find_pending_route(uint64_t id) {
  pending_route_t *cursor = pm_pending_routes;

  while (cursor != NULL) {
    if (cursor->id == id) {
      return cursor;
    }
    cursor = cursor->next;
  }

  return NULL;
}

static void pm_apply_route_response(uint64_t id, const char *host, int port, int failed) {
  pending_route_t *route;

  pthread_mutex_lock(&pm_pending_mutex);
  route = pm_find_pending_route(id);
  if (route != NULL) {
    route->failed = failed;
    route->port = port;
    snprintf(route->host, sizeof(route->host), "%s", host == NULL ? "" : host);
    route->resolved = 1;
    pthread_cond_signal(&route->condition);
  }
  pthread_mutex_unlock(&pm_pending_mutex);
}

static void pm_parse_response_line(char *line) {
  char *saveptr = NULL;
  char *kind = strtok_r(line, "\t\r\n", &saveptr);
  char *id_text = strtok_r(NULL, "\t\r\n", &saveptr);
  uint64_t id;

  if (kind == NULL || id_text == NULL) {
    return;
  }

  id = strtoull(id_text, NULL, 10);
  if (id == 0) {
    return;
  }

  if (strcmp(kind, "ROUTE") == 0) {
    char *host = strtok_r(NULL, "\t\r\n", &saveptr);
    char *port_text = strtok_r(NULL, "\t\r\n", &saveptr);
    int port = port_text == NULL ? 0 : atoi(port_text);

    if (host == NULL || port <= 0 || port > 65535) {
      pm_apply_route_response(id, "", 0, 1);
      return;
    }

    pm_apply_route_response(id, host, port, 0);
    return;
  }

  if (strcmp(kind, "ERROR") == 0) {
    pm_apply_route_response(id, "", 0, 1);
  }
}

static void *pm_stdin_reader_thread(void *unused) {
  char *line = NULL;
  size_t capacity = 0;
  (void)unused;

  while (getline(&line, &capacity, stdin) >= 0) {
    pm_parse_response_line(line);
  }

  free(line);
  _exit(0);
  return NULL;
}

static int pm_send_route_request(const accepted_connection_t *connection, uint64_t route_id) {
  char line[PM_HOST_PROXY_LINE_SIZE];
  int length = snprintf(
    line,
    sizeof(line),
    "CONNECT\t%llu\t%s\t%d\t%s\t%d\n",
    (unsigned long long)route_id,
    connection->local_address,
    connection->local_port,
    connection->remote_address,
    connection->remote_port);

  if (length <= 0 || (size_t)length >= sizeof(line)) {
    return -1;
  }

  return pm_write_protocol_line(line);
}

static int pm_resolve_route(const accepted_connection_t *connection, char *host, size_t host_size, int *port) {
  pending_route_t route;
  int64_t deadline;

  memset(&route, 0, sizeof(route));
  route.id = pm_allocate_route_id();
  if (pm_tcp_proxy_condition_init(&route.condition) != 0) {
    return -1;
  }
  deadline = pm_tcp_proxy_now_ms();
  if (deadline < 0) {
    pthread_cond_destroy(&route.condition);
    return -1;
  }
  deadline += pm_route_response_timeout_ms;

  pm_add_pending_route(&route);
  if (pm_send_route_request(connection, route.id) != 0) {
    pm_remove_pending_route(&route);
    pthread_cond_destroy(&route.condition);
    return -1;
  }

  pthread_mutex_lock(&pm_pending_mutex);
  while (!route.resolved) {
    if (pm_tcp_proxy_condition_wait(&route.condition, &pm_pending_mutex, deadline) != 0) {
      break;
    }
  }
  pthread_mutex_unlock(&pm_pending_mutex);

  pm_remove_pending_route(&route);
  int64_t finished = pm_tcp_proxy_now_ms();
  if (finished < 0 || finished >= deadline || !route.resolved || route.failed || route.port <= 0 || route.host[0] == '\0') {
    pthread_cond_destroy(&route.condition);
    return -1;
  }

  snprintf(host, host_size, "%s", route.host);
  *port = route.port;
  pthread_cond_destroy(&route.condition);
  return 0;
}

static void *pm_connection_thread(void *raw_connection) {
  accepted_connection_t *connection = (accepted_connection_t *)raw_connection;
  char host[PM_HOST_PROXY_HOST_SIZE];
  int port = 0;
  int target_fd;

  if (pm_resolve_route(connection, host, sizeof(host), &port) != 0) {
    close(connection->client_fd);
    free(connection);
    return NULL;
  }

  if (pm_tcp_proxy_client_failed(connection->client_fd)) {
    close(connection->client_fd);
    free(connection);
    return NULL;
  }
  target_fd = pm_tcp_proxy_connect(host, port);
  if (target_fd < 0) {
    close(connection->client_fd);
    free(connection);
    return NULL;
  }

  pm_tcp_proxy_forward(connection->client_fd, target_fd);
  close(target_fd);
  close(connection->client_fd);
  free(connection);
  return NULL;
}

static int pm_set_reuseaddr(int fd) {
  int enabled = 1;
  return setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
}

static int pm_parse_port(const char *value) {
  char *end = NULL;
  long port = strtol(value, &end, 10);

  if (end == value || *end != '\0' || port < 1 || port > 65535) {
    return 0;
  }

  return (int)port;
}

static void pm_sockaddr_text(
  const struct sockaddr *address,
  socklen_t address_length,
  char *host,
  size_t host_size,
  int *port) {
  char service[16];

  host[0] = '\0';
  service[0] = '\0';
  if (getnameinfo(address, address_length, host, (socklen_t)host_size, service, sizeof(service), NI_NUMERICHOST | NI_NUMERICSERV) != 0) {
    snprintf(host, host_size, "127.0.0.1");
    *port = 0;
    return;
  }

  *port = atoi(service);
}

static int pm_create_listeners(const char *host, int port, int *listeners, int max_listeners) {
  struct addrinfo hints;
  struct addrinfo *results = NULL;
  struct addrinfo *cursor;
  char port_text[16];
  int listener_count = 0;

  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_PASSIVE;
  snprintf(port_text, sizeof(port_text), "%d", port);

  if (getaddrinfo(host, port_text, &hints, &results) != 0) {
    return 0;
  }

  for (cursor = results; cursor != NULL && listener_count < max_listeners; cursor = cursor->ai_next) {
    int fd = socket(cursor->ai_family, cursor->ai_socktype, cursor->ai_protocol);
    if (fd < 0) {
      continue;
    }
    if (pm_tcp_proxy_prepare_socket(fd) != 0) {
      close(fd);
      continue;
    }

    pm_set_reuseaddr(fd);
    if (cursor->ai_family == AF_INET6) {
      int v6only = 1;
      setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, sizeof(v6only));
    }

    if (bind(fd, cursor->ai_addr, cursor->ai_addrlen) == 0 && listen(fd, PM_HOST_PROXY_BACKLOG) == 0) {
      listeners[listener_count++] = fd;
      continue;
    }

    close(fd);
  }

  freeaddrinfo(results);
  return listener_count;
}

static accepted_connection_t *pm_accept_connection(int listener_fd) {
  struct sockaddr_storage remote_address;
  struct sockaddr_storage local_address;
  socklen_t remote_length = sizeof(remote_address);
  socklen_t local_length = sizeof(local_address);
  accepted_connection_t *connection;
  int client_fd = accept(listener_fd, (struct sockaddr *)&remote_address, &remote_length);

  if (client_fd < 0) {
    return NULL;
  }
  if (pm_tcp_proxy_prepare_socket(client_fd) != 0) {
    close(client_fd);
    return NULL;
  }

  connection = (accepted_connection_t *)calloc(1, sizeof(accepted_connection_t));
  if (connection == NULL) {
    close(client_fd);
    return NULL;
  }

  connection->client_fd = client_fd;
  pm_sockaddr_text(
    (const struct sockaddr *)&remote_address,
    remote_length,
    connection->remote_address,
    sizeof(connection->remote_address),
    &connection->remote_port);

  if (getsockname(client_fd, (struct sockaddr *)&local_address, &local_length) == 0) {
    pm_sockaddr_text(
      (const struct sockaddr *)&local_address,
      local_length,
      connection->local_address,
      sizeof(connection->local_address),
      &connection->local_port);
  } else {
    snprintf(connection->local_address, sizeof(connection->local_address), "127.0.0.1");
    connection->local_port = 0;
  }

  return connection;
}

static void pm_start_connection_thread(accepted_connection_t *connection) {
  if (pm_tcp_proxy_start_worker(pm_connection_thread, connection) != 0) {
    close(connection->client_fd);
    free(connection);
    return;
  }

}

int main(int argc, char **argv) {
  const char *host;
  int port;
  int listeners[PM_HOST_PROXY_MAX_LISTENERS];
  int listener_count;
  pthread_t stdin_thread;
  char ready_line[PM_HOST_PROXY_LINE_SIZE];

  if (argc != 3) {
    fprintf(stderr, "usage: %s <host-address> <host-port>\n", argv[0]);
    return 2;
  }

  host = argv[1];
  port = pm_parse_port(argv[2]);
  if (host[0] == '\0' || port == 0) {
    fprintf(stderr, "invalid host exposure endpoint: %s:%s\n", argv[1], argv[2]);
    return 2;
  }

  signal(SIGPIPE, SIG_IGN);
  pm_tcp_proxy_initialize();
  if (pm_tcp_proxy_control_start(STDOUT_FILENO) != 0) return 5;
  {
    const char *value = getenv("PORT_MANAGER_PROXY_ROUTE_TIMEOUT_MS");
    char *end = NULL;
    long parsed = value == NULL ? 0 : strtol(value, &end, 10);
    if (value != NULL && end != value && *end == '\0' && parsed > 0 && parsed <= 600000) {
      pm_route_response_timeout_ms = parsed;
    }
  }
  listener_count = pm_create_listeners(host, port, listeners, PM_HOST_PROXY_MAX_LISTENERS);
  if (listener_count == 0) {
    fprintf(stderr, "could not bind host exposure %s:%d\n", host, port);
    return 3;
  }
  pm_tcp_proxy_set_listener_count((size_t)listener_count);

  if (pthread_create(&stdin_thread, NULL, pm_stdin_reader_thread, NULL) != 0) {
    fprintf(stderr, "could not start control reader\n");
    return 4;
  }
  pthread_detach(stdin_thread);

  snprintf(ready_line, sizeof(ready_line), "READY\t%s\t%d\n", host, port);
  if (pm_write_protocol_line(ready_line) != 0) {
    return 5;
  }

  for (;;) {
    struct pollfd poll_fds[PM_HOST_PROXY_MAX_LISTENERS];
    int index;
    int ready;

    for (index = 0; index < listener_count; index++) {
      poll_fds[index].fd = listeners[index];
      poll_fds[index].events = POLLIN;
      poll_fds[index].revents = 0;
    }

    ready = poll(poll_fds, (nfds_t)listener_count, -1);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;
    }

    for (index = 0; index < listener_count; index++) {
      if ((poll_fds[index].revents & POLLIN) != 0) {
        accepted_connection_t *connection = pm_accept_connection(poll_fds[index].fd);
        if (connection != NULL) {
          pm_start_connection_thread(connection);
        }
      }
    }
  }

  for (int index = 0; index < listener_count; index++) {
    close(listeners[index]);
  }

  return 0;
}

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
#include <unistd.h>

#define PM_ROUTER_BACKLOG 128
#define PM_ROUTER_BUFFER_SIZE 65536
#define PM_ROUTER_HOST_SIZE 256
#define PM_ROUTER_LINE_SIZE 1024

typedef struct pending_route {
  uint64_t id;
  int resolved;
  int failed;
  char host[PM_ROUTER_HOST_SIZE];
  int port;
  pthread_cond_t condition;
  struct pending_route *next;
} pending_route_t;

typedef struct accepted_connection {
  int client_fd;
  int logical_port;
  char local_address[PM_ROUTER_HOST_SIZE];
  int local_port;
  char remote_address[PM_ROUTER_HOST_SIZE];
  int remote_port;
} accepted_connection_t;

typedef struct copy_args {
  int source_fd;
  int target_fd;
} copy_args_t;

static pthread_mutex_t pm_pending_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t pm_stdout_mutex = PTHREAD_MUTEX_INITIALIZER;
static pending_route_t *pm_pending_routes = NULL;
static uint64_t pm_next_route_id = 1;

static int pm_write_all(int fd, const char *buffer, size_t length) {
  size_t written = 0;

  while (written < length) {
    ssize_t result = write(fd, buffer + written, length - written);
    if (result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }

    if (result == 0) {
      return -1;
    }

    written += (size_t)result;
  }

  return 0;
}

static int pm_write_protocol_line(const char *line) {
  int result;

  pthread_mutex_lock(&pm_stdout_mutex);
  result = pm_write_all(STDOUT_FILENO, line, strlen(line));
  pthread_mutex_unlock(&pm_stdout_mutex);

  return result;
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
  char line[PM_ROUTER_LINE_SIZE];
  int length = snprintf(
    line,
    sizeof(line),
    "CONNECT\t%llu\t%d\t%s\t%d\t%s\t%d\n",
    (unsigned long long)route_id,
    connection->logical_port,
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

  memset(&route, 0, sizeof(route));
  route.id = pm_allocate_route_id();
  if (pthread_cond_init(&route.condition, NULL) != 0) {
    return -1;
  }

  pm_add_pending_route(&route);
  if (pm_send_route_request(connection, route.id) != 0) {
    pm_remove_pending_route(&route);
    pthread_cond_destroy(&route.condition);
    return -1;
  }

  pthread_mutex_lock(&pm_pending_mutex);
  while (!route.resolved) {
    pthread_cond_wait(&route.condition, &pm_pending_mutex);
  }
  pthread_mutex_unlock(&pm_pending_mutex);

  pm_remove_pending_route(&route);
  if (route.failed || route.port <= 0 || route.host[0] == '\0') {
    pthread_cond_destroy(&route.condition);
    return -1;
  }

  snprintf(host, host_size, "%s", route.host);
  *port = route.port;
  pthread_cond_destroy(&route.condition);
  return 0;
}

static int pm_connect_target(const char *host, int port) {
  struct addrinfo hints;
  struct addrinfo *results = NULL;
  struct addrinfo *cursor;
  char port_text[16];
  int fd = -1;

  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  snprintf(port_text, sizeof(port_text), "%d", port);

  if (getaddrinfo(host, port_text, &hints, &results) != 0) {
    return -1;
  }

  for (cursor = results; cursor != NULL; cursor = cursor->ai_next) {
    fd = socket(cursor->ai_family, cursor->ai_socktype, cursor->ai_protocol);
    if (fd < 0) {
      continue;
    }

    if (connect(fd, cursor->ai_addr, cursor->ai_addrlen) == 0) {
      break;
    }

    close(fd);
    fd = -1;
  }

  freeaddrinfo(results);
  return fd;
}

static int pm_send_all_socket(int fd, const char *buffer, size_t length) {
  size_t sent = 0;

  while (sent < length) {
    ssize_t result = send(fd, buffer + sent, length - sent, 0);
    if (result < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    if (result == 0) {
      return -1;
    }
    sent += (size_t)result;
  }

  return 0;
}

static void *pm_copy_thread(void *raw_args) {
  copy_args_t *args = (copy_args_t *)raw_args;
  char *buffer = (char *)malloc(PM_ROUTER_BUFFER_SIZE);

  if (buffer != NULL) {
    for (;;) {
      ssize_t count = recv(args->source_fd, buffer, PM_ROUTER_BUFFER_SIZE, 0);
      if (count < 0) {
        if (errno == EINTR) {
          continue;
        }
        break;
      }
      if (count == 0) {
        break;
      }
      if (pm_send_all_socket(args->target_fd, buffer, (size_t)count) != 0) {
        break;
      }
    }
  }

  free(buffer);
  shutdown(args->target_fd, SHUT_WR);
  shutdown(args->source_fd, SHUT_RD);
  free(args);
  return NULL;
}

static void pm_proxy_connection(int client_fd, int target_fd) {
  pthread_t client_to_target;
  pthread_t target_to_client;
  copy_args_t *forward = (copy_args_t *)calloc(1, sizeof(copy_args_t));
  copy_args_t *backward = (copy_args_t *)calloc(1, sizeof(copy_args_t));

  if (forward == NULL || backward == NULL) {
    free(forward);
    free(backward);
    return;
  }

  forward->source_fd = client_fd;
  forward->target_fd = target_fd;
  backward->source_fd = target_fd;
  backward->target_fd = client_fd;

  if (pthread_create(&client_to_target, NULL, pm_copy_thread, forward) != 0) {
    free(forward);
    free(backward);
    return;
  }
  if (pthread_create(&target_to_client, NULL, pm_copy_thread, backward) != 0) {
    shutdown(client_fd, SHUT_RDWR);
    shutdown(target_fd, SHUT_RDWR);
    pthread_join(client_to_target, NULL);
    free(backward);
    return;
  }

  pthread_join(client_to_target, NULL);
  pthread_join(target_to_client, NULL);
}

static void *pm_connection_thread(void *raw_connection) {
  accepted_connection_t *connection = (accepted_connection_t *)raw_connection;
  char host[PM_ROUTER_HOST_SIZE];
  int port = 0;
  int target_fd;

  if (pm_resolve_route(connection, host, sizeof(host), &port) != 0) {
    close(connection->client_fd);
    free(connection);
    return NULL;
  }

  target_fd = pm_connect_target(host, port);
  if (target_fd < 0) {
    close(connection->client_fd);
    free(connection);
    return NULL;
  }

  pm_proxy_connection(connection->client_fd, target_fd);
  close(target_fd);
  close(connection->client_fd);
  free(connection);
  return NULL;
}

static int pm_set_reuseaddr(int fd) {
  int enabled = 1;
  return setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
}

static int pm_create_ipv4_listener(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address;

  if (fd < 0) {
    return -1;
  }

  pm_set_reuseaddr(fd);
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);

  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(fd, PM_ROUTER_BACKLOG) != 0) {
    close(fd);
    return -1;
  }

  return fd;
}

static int pm_create_ipv6_listener(int port) {
  int fd = socket(AF_INET6, SOCK_STREAM, 0);
  struct sockaddr_in6 address;
  int v6only = 1;

  if (fd < 0) {
    return -1;
  }

  pm_set_reuseaddr(fd);
  setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, sizeof(v6only));
  memset(&address, 0, sizeof(address));
  address.sin6_family = AF_INET6;
  address.sin6_port = htons((uint16_t)port);
  inet_pton(AF_INET6, "::1", &address.sin6_addr);

  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(fd, PM_ROUTER_BACKLOG) != 0) {
    close(fd);
    return -1;
  }

  return fd;
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

static accepted_connection_t *pm_accept_connection(int listener_fd, int logical_port) {
  struct sockaddr_storage remote_address;
  struct sockaddr_storage local_address;
  socklen_t remote_length = sizeof(remote_address);
  socklen_t local_length = sizeof(local_address);
  accepted_connection_t *connection;
  int client_fd = accept(listener_fd, (struct sockaddr *)&remote_address, &remote_length);

  if (client_fd < 0) {
    return NULL;
  }

  connection = (accepted_connection_t *)calloc(1, sizeof(accepted_connection_t));
  if (connection == NULL) {
    close(client_fd);
    return NULL;
  }

  connection->client_fd = client_fd;
  connection->logical_port = logical_port;
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
    connection->local_port = logical_port;
  }

  return connection;
}

static void pm_start_connection_thread(accepted_connection_t *connection) {
  pthread_t thread;

  if (pthread_create(&thread, NULL, pm_connection_thread, connection) != 0) {
    close(connection->client_fd);
    free(connection);
    return;
  }

  pthread_detach(thread);
}

static int pm_parse_port(const char *value) {
  char *end = NULL;
  long port = strtol(value, &end, 10);

  if (end == value || *end != '\0' || port < 1 || port > 65535) {
    return 0;
  }

  return (int)port;
}

int main(int argc, char **argv) {
  int logical_port;
  int listeners[2];
  int listener_count = 0;
  pthread_t stdin_thread;
  char ready_line[64];

  if (argc != 2) {
    fprintf(stderr, "usage: %s <logical-port>\n", argv[0]);
    return 2;
  }

  logical_port = pm_parse_port(argv[1]);
  if (logical_port == 0) {
    fprintf(stderr, "invalid logical port: %s\n", argv[1]);
    return 2;
  }

  signal(SIGPIPE, SIG_IGN);
  listeners[listener_count] = pm_create_ipv4_listener(logical_port);
  if (listeners[listener_count] >= 0) {
    listener_count++;
  }

  listeners[listener_count] = pm_create_ipv6_listener(logical_port);
  if (listeners[listener_count] >= 0) {
    listener_count++;
  }

  if (listener_count == 0) {
    fprintf(stderr, "could not bind localhost logical port %d\n", logical_port);
    return 3;
  }

  if (pthread_create(&stdin_thread, NULL, pm_stdin_reader_thread, NULL) != 0) {
    fprintf(stderr, "could not start control reader\n");
    return 4;
  }
  pthread_detach(stdin_thread);

  snprintf(ready_line, sizeof(ready_line), "READY\t%d\n", logical_port);
  if (pm_write_protocol_line(ready_line) != 0) {
    return 5;
  }

  for (;;) {
    struct pollfd poll_fds[2];
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
        accepted_connection_t *connection = pm_accept_connection(poll_fds[index].fd, logical_port);
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

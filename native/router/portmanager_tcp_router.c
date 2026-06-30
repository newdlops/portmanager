#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
#include <sys/event.h>
#include <sys/time.h>
#define PM_ROUTER_USE_KQUEUE 1
#endif
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define PM_ROUTER_BACKLOG 1024
#define PM_ROUTER_BUFFER_SIZE 65536
#define PM_ROUTER_HOST_SIZE 256
#define PM_ROUTER_LINE_SIZE 1024
#define PM_ROUTER_ROUTE_RESPONSE_TIMEOUT_MS 5000
#if defined(MSG_NOSIGNAL)
#define PM_ROUTER_SEND_FLAGS MSG_NOSIGNAL
#else
#define PM_ROUTER_SEND_FLAGS 0
#endif

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

typedef struct logical_listener {
  int fd;
  int logical_port;
} logical_listener_t;

typedef struct listener_list {
  logical_listener_t *items;
  size_t count;
  size_t capacity;
} listener_list_t;

typedef struct line_buffer {
  char *data;
  size_t length;
  size_t capacity;
} line_buffer_t;

typedef struct proxy_direction {
  int source_fd;
  int target_fd;
  char *buffer;
  size_t start;
  size_t length;
  int source_open;
  int target_shutdown;
} proxy_direction_t;

static pthread_mutex_t pm_pending_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t pm_stdout_mutex = PTHREAD_MUTEX_INITIALIZER;
static pending_route_t *pm_pending_routes = NULL;
static uint64_t pm_next_route_id = 1;
#if PM_ROUTER_USE_KQUEUE
static int pm_kqueue_fd = -1;
#endif

static int pm_parse_port(const char *value);
static int pm_listener_list_open_port(listener_list_t *listeners, int logical_port);
static void pm_listener_list_close_port(listener_list_t *listeners, int logical_port);
static void pm_listener_list_free(listener_list_t *listeners);

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

static void pm_handle_control_line(listener_list_t *listeners, char *line) {
  if (strncmp(line, "LISTEN\t", 7) == 0) {
    int logical_port = pm_parse_port(line + 7);
    char response[PM_ROUTER_LINE_SIZE];

    if (logical_port > 0 && pm_listener_list_open_port(listeners, logical_port) == 0) {
      snprintf(response, sizeof(response), "READY\t%d\n", logical_port);
    } else {
      snprintf(response, sizeof(response), "LISTEN_ERROR\t%d\n", logical_port);
    }
    (void)pm_write_protocol_line(response);
    return;
  }

  if (strncmp(line, "CLOSE\t", 6) == 0) {
    int logical_port = pm_parse_port(line + 6);
    char response[PM_ROUTER_LINE_SIZE];

    if (logical_port > 0) {
      pm_listener_list_close_port(listeners, logical_port);
      snprintf(response, sizeof(response), "CLOSED\t%d\n", logical_port);
      (void)pm_write_protocol_line(response);
    }
    return;
  }

  pm_parse_response_line(line);
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

static void pm_add_milliseconds(struct timespec *deadline, long timeout_ms) {
  deadline->tv_sec += timeout_ms / 1000;
  deadline->tv_nsec += (timeout_ms % 1000) * 1000000L;
  if (deadline->tv_nsec >= 1000000000L) {
    deadline->tv_sec += deadline->tv_nsec / 1000000000L;
    deadline->tv_nsec = deadline->tv_nsec % 1000000000L;
  }
}

static int pm_resolve_route(const accepted_connection_t *connection, char *host, size_t host_size, int *port) {
  pending_route_t route;
  struct timespec deadline;

  memset(&route, 0, sizeof(route));
  route.id = pm_allocate_route_id();
  if (pthread_cond_init(&route.condition, NULL) != 0) {
    return -1;
  }
  if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) {
    pthread_cond_destroy(&route.condition);
    return -1;
  }
  pm_add_milliseconds(&deadline, PM_ROUTER_ROUTE_RESPONSE_TIMEOUT_MS);

  pm_add_pending_route(&route);
  if (pm_send_route_request(connection, route.id) != 0) {
    pm_remove_pending_route(&route);
    pthread_cond_destroy(&route.condition);
    return -1;
  }

  pthread_mutex_lock(&pm_pending_mutex);
  while (!route.resolved) {
    if (pthread_cond_timedwait(&route.condition, &pm_pending_mutex, &deadline) == ETIMEDOUT) {
      break;
    }
  }
  pthread_mutex_unlock(&pm_pending_mutex);

  pm_remove_pending_route(&route);
  if (!route.resolved || route.failed || route.port <= 0 || route.host[0] == '\0') {
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

static int pm_socket_would_block(void) {
  return errno == EAGAIN || errno == EWOULDBLOCK;
}

static int pm_set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);

  if (flags < 0) {
    return -1;
  }

  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void pm_set_tcp_nodelay(int fd) {
  int enabled = 1;

#if defined(TCP_NODELAY)
  (void)setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
#else
  (void)fd;
  (void)enabled;
#endif
}

static void pm_proxy_direction_compact(proxy_direction_t *direction) {
  if (direction->start == 0) {
    return;
  }

  if (direction->length > 0) {
    memmove(direction->buffer, direction->buffer + direction->start, direction->length);
  }
  direction->start = 0;
}

static int pm_proxy_direction_read(proxy_direction_t *direction) {
  ssize_t count;
  size_t available;

  if (!direction->source_open || direction->length >= PM_ROUTER_BUFFER_SIZE) {
    return 0;
  }

  if (direction->start + direction->length >= PM_ROUTER_BUFFER_SIZE) {
    pm_proxy_direction_compact(direction);
  }
  available = PM_ROUTER_BUFFER_SIZE - direction->start - direction->length;
  if (available == 0) {
    return 0;
  }

  count = recv(direction->source_fd, direction->buffer + direction->start + direction->length, available, 0);
  if (count > 0) {
    direction->length += (size_t)count;
    return 0;
  }
  if (count == 0) {
    direction->source_open = 0;
    return 0;
  }
  if (errno == EINTR || pm_socket_would_block()) {
    return 0;
  }

  direction->source_open = 0;
  return -1;
}

static int pm_proxy_direction_write(proxy_direction_t *direction) {
  while (direction->length > 0) {
    ssize_t count = send(
      direction->target_fd,
      direction->buffer + direction->start,
      direction->length,
      PM_ROUTER_SEND_FLAGS);

    if (count > 0) {
      direction->start += (size_t)count;
      direction->length -= (size_t)count;
      if (direction->length == 0) {
        direction->start = 0;
      }
      continue;
    }
    if (count == 0) {
      return -1;
    }
    if (errno == EINTR) {
      continue;
    }
    if (pm_socket_would_block()) {
      return 0;
    }
    return -1;
  }

  return 0;
}

static void pm_proxy_direction_shutdown_if_drained(proxy_direction_t *direction) {
  if (!direction->source_open && direction->length == 0 && !direction->target_shutdown) {
    shutdown(direction->target_fd, SHUT_WR);
    direction->target_shutdown = 1;
  }
}

/**
 * Proxies one TCP connection with a single nonblocking pump.
 *
 * The previous implementation used two extra copy threads per connection. That
 * multiplied scheduler and stack pressure during bursty browser/container
 * traffic. A bounded poll loop keeps both directions moving from the connection
 * worker itself while still honoring TCP half-close semantics.
 */
static void pm_proxy_connection(int client_fd, int target_fd) {
  proxy_direction_t forward;
  proxy_direction_t backward;
  char *forward_buffer = (char *)malloc(PM_ROUTER_BUFFER_SIZE);
  char *backward_buffer = (char *)malloc(PM_ROUTER_BUFFER_SIZE);

  if (forward_buffer == NULL || backward_buffer == NULL) {
    free(forward_buffer);
    free(backward_buffer);
    return;
  }
  if (pm_set_nonblocking(client_fd) != 0 || pm_set_nonblocking(target_fd) != 0) {
    free(forward_buffer);
    free(backward_buffer);
    return;
  }

  pm_set_tcp_nodelay(client_fd);
  pm_set_tcp_nodelay(target_fd);
  memset(&forward, 0, sizeof(forward));
  memset(&backward, 0, sizeof(backward));
  forward.source_fd = client_fd;
  forward.target_fd = target_fd;
  forward.buffer = forward_buffer;
  forward.source_open = 1;
  backward.source_fd = target_fd;
  backward.target_fd = client_fd;
  backward.buffer = backward_buffer;
  backward.source_open = 1;

  for (;;) {
    struct pollfd poll_fds[4];
    int poll_roles[4];
    nfds_t poll_count = 0;
    int ready;
    int failed = 0;

    if (forward.source_open && forward.length < PM_ROUTER_BUFFER_SIZE) {
      poll_fds[poll_count].fd = forward.source_fd;
      poll_fds[poll_count].events = POLLIN;
      poll_fds[poll_count].revents = 0;
      poll_roles[poll_count++] = 0;
    }
    if (forward.length > 0) {
      poll_fds[poll_count].fd = forward.target_fd;
      poll_fds[poll_count].events = POLLOUT;
      poll_fds[poll_count].revents = 0;
      poll_roles[poll_count++] = 1;
    }
    if (backward.source_open && backward.length < PM_ROUTER_BUFFER_SIZE) {
      poll_fds[poll_count].fd = backward.source_fd;
      poll_fds[poll_count].events = POLLIN;
      poll_fds[poll_count].revents = 0;
      poll_roles[poll_count++] = 2;
    }
    if (backward.length > 0) {
      poll_fds[poll_count].fd = backward.target_fd;
      poll_fds[poll_count].events = POLLOUT;
      poll_fds[poll_count].revents = 0;
      poll_roles[poll_count++] = 3;
    }

    if (poll_count == 0) {
      break;
    }

    ready = poll(poll_fds, poll_count, -1);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;
    }

    for (nfds_t index = 0; index < poll_count; index++) {
      short revents = poll_fds[index].revents;

      if (revents == 0) {
        continue;
      }

      switch (poll_roles[index]) {
        case 0:
          if ((revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0 &&
              pm_proxy_direction_read(&forward) != 0) {
            failed = 1;
          }
          break;
        case 1:
          if ((revents & (POLLHUP | POLLERR | POLLNVAL)) != 0 ||
              ((revents & POLLOUT) != 0 && pm_proxy_direction_write(&forward) != 0)) {
            failed = 1;
          }
          break;
        case 2:
          if ((revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) != 0 &&
              pm_proxy_direction_read(&backward) != 0) {
            failed = 1;
          }
          break;
        case 3:
          if ((revents & (POLLHUP | POLLERR | POLLNVAL)) != 0 ||
              ((revents & POLLOUT) != 0 && pm_proxy_direction_write(&backward) != 0)) {
            failed = 1;
          }
          break;
        default:
          break;
      }
    }

    pm_proxy_direction_shutdown_if_drained(&forward);
    pm_proxy_direction_shutdown_if_drained(&backward);
    if (failed) {
      break;
    }
  }

  shutdown(client_fd, SHUT_RDWR);
  shutdown(target_fd, SHUT_RDWR);
  free(forward_buffer);
  free(backward_buffer);
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
  if (pm_set_nonblocking(fd) != 0) {
    close(fd);
    return -1;
  }
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
  if (pm_set_nonblocking(fd) != 0) {
    close(fd);
    return -1;
  }
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

static int pm_register_read_event(int fd, int logical_port) {
#if PM_ROUTER_USE_KQUEUE
  struct kevent change;

  if (pm_kqueue_fd < 0) {
    return 0;
  }

  /*
   * kqueue removes events when an fd closes. We still delete explicitly on
   * CLOSE so the control protocol has deterministic listener ownership.
   */
  EV_SET(&change, (uintptr_t)fd, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, (void *)(intptr_t)logical_port);
  return kevent(pm_kqueue_fd, &change, 1, NULL, 0, NULL);
#else
  (void)fd;
  (void)logical_port;
  return 0;
#endif
}

static void pm_unregister_read_event(int fd) {
#if PM_ROUTER_USE_KQUEUE
  struct kevent change;

  if (pm_kqueue_fd < 0) {
    return;
  }

  EV_SET(&change, (uintptr_t)fd, EVFILT_READ, EV_DELETE, 0, 0, NULL);
  (void)kevent(pm_kqueue_fd, &change, 1, NULL, 0, NULL);
#else
  (void)fd;
#endif
}

static int pm_reserve_listeners(listener_list_t *listeners, size_t count) {
  logical_listener_t *next;
  size_t capacity;

  if (count <= listeners->capacity) {
    return 0;
  }

  capacity = listeners->capacity == 0 ? 16 : listeners->capacity;
  while (capacity < count) {
    capacity *= 2;
  }

  next = (logical_listener_t *)realloc(listeners->items, capacity * sizeof(logical_listener_t));
  if (next == NULL) {
    return -1;
  }

  listeners->items = next;
  listeners->capacity = capacity;
  return 0;
}

static int pm_listener_list_has_port(const listener_list_t *listeners, int logical_port) {
  for (size_t index = 0; index < listeners->count; index++) {
    if (listeners->items[index].logical_port == logical_port) {
      return 1;
    }
  }

  return 0;
}

static int pm_listener_list_add_fd(listener_list_t *listeners, int logical_port, int fd) {
  if (pm_reserve_listeners(listeners, listeners->count + 1) != 0) {
    return -1;
  }
  if (pm_register_read_event(fd, logical_port) != 0) {
    return -1;
  }

  listeners->items[listeners->count].fd = fd;
  listeners->items[listeners->count].logical_port = logical_port;
  listeners->count++;
  return 0;
}

static int pm_listener_list_open_port(listener_list_t *listeners, int logical_port) {
  int ipv4_fd;
  int ipv6_fd;
  size_t before_count;

  if (pm_listener_list_has_port(listeners, logical_port)) {
    return 0;
  }

  before_count = listeners->count;
  ipv4_fd = pm_create_ipv4_listener(logical_port);
  if (ipv4_fd >= 0 && pm_listener_list_add_fd(listeners, logical_port, ipv4_fd) != 0) {
    close(ipv4_fd);
  }

  ipv6_fd = pm_create_ipv6_listener(logical_port);
  if (ipv6_fd >= 0 && pm_listener_list_add_fd(listeners, logical_port, ipv6_fd) != 0) {
    close(ipv6_fd);
  }

  if (listeners->count == before_count) {
    return -1;
  }

  return 0;
}

static void pm_listener_list_close_port(listener_list_t *listeners, int logical_port) {
  size_t index = 0;

  while (index < listeners->count) {
    if (listeners->items[index].logical_port != logical_port) {
      index++;
      continue;
    }

    pm_unregister_read_event(listeners->items[index].fd);
    close(listeners->items[index].fd);
    memmove(&listeners->items[index], &listeners->items[index + 1], (listeners->count - index - 1) * sizeof(logical_listener_t));
    listeners->count--;
  }
}

static void pm_listener_list_free(listener_list_t *listeners) {
  for (size_t index = 0; index < listeners->count; index++) {
    pm_unregister_read_event(listeners->items[index].fd);
    close(listeners->items[index].fd);
  }
  free(listeners->items);
  listeners->items = NULL;
  listeners->count = 0;
  listeners->capacity = 0;
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

static void pm_accept_ready_connections(int listener_fd, int logical_port) {
  for (;;) {
    accepted_connection_t *connection = pm_accept_connection(listener_fd, logical_port);

    if (connection == NULL) {
      break;
    }

    pm_start_connection_thread(connection);
  }
}

static int pm_parse_port(const char *value) {
  char *end = NULL;
  long port = strtol(value, &end, 10);

  if (end == value || (*end != '\0' && *end != '\r' && *end != '\n') || port < 1 || port > 65535) {
    return 0;
  }

  return (int)port;
}

static int pm_line_buffer_reserve(line_buffer_t *buffer, size_t required) {
  char *next;
  size_t capacity;

  if (required <= buffer->capacity) {
    return 0;
  }

  capacity = buffer->capacity == 0 ? 4096 : buffer->capacity;
  while (capacity < required) {
    capacity *= 2;
  }

  next = (char *)realloc(buffer->data, capacity);
  if (next == NULL) {
    return -1;
  }

  buffer->data = next;
  buffer->capacity = capacity;
  return 0;
}

static int pm_line_buffer_append(line_buffer_t *buffer, const char *data, size_t length) {
  if (pm_line_buffer_reserve(buffer, buffer->length + length + 1) != 0) {
    return -1;
  }

  memcpy(buffer->data + buffer->length, data, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
  return 0;
}

static int pm_read_control_input(listener_list_t *listeners, line_buffer_t *buffer) {
  char chunk[4096];
  ssize_t count;

  count = read(STDIN_FILENO, chunk, sizeof(chunk));
  if (count < 0) {
    return errno == EINTR ? 0 : -1;
  }
  if (count == 0) {
    return -1;
  }
  if (pm_line_buffer_append(buffer, chunk, (size_t)count) != 0) {
    return -1;
  }

  for (;;) {
    char *newline = memchr(buffer->data, '\n', buffer->length);
    size_t line_length;

    if (newline == NULL) {
      break;
    }

    line_length = (size_t)(newline - buffer->data);
    buffer->data[line_length] = '\0';
    if (line_length > 0) {
      pm_handle_control_line(listeners, buffer->data);
    }

    memmove(buffer->data, newline + 1, buffer->length - line_length - 1);
    buffer->length -= line_length + 1;
    buffer->data[buffer->length] = '\0';
  }

  return 0;
}

static void pm_line_buffer_free(line_buffer_t *buffer) {
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0;
  buffer->capacity = 0;
}

#if PM_ROUTER_USE_KQUEUE
static int pm_run_event_loop(listener_list_t *listeners, line_buffer_t *input_buffer) {
  struct kevent events[256];

  for (;;) {
    int ready = kevent(pm_kqueue_fd, NULL, 0, events, (int)(sizeof(events) / sizeof(events[0])), NULL);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      fprintf(stderr, "kevent failed for router listeners: %s\n", strerror(errno));
      return -1;
    }

    for (int index = 0; index < ready; index++) {
      int fd = (int)events[index].ident;
      int logical_port = (int)(intptr_t)events[index].udata;

      if (fd == STDIN_FILENO) {
        if (pm_read_control_input(listeners, input_buffer) != 0) {
          return 0;
        }
        continue;
      }

      if ((events[index].flags & EV_ERROR) != 0 || events[index].filter != EVFILT_READ || logical_port <= 0) {
        continue;
      }

      pm_accept_ready_connections(fd, logical_port);
    }
  }
}
#else
static int pm_run_event_loop(listener_list_t *listeners, line_buffer_t *input_buffer) {
  struct pollfd *poll_fds = NULL;
  size_t poll_capacity = 0;

  for (;;) {
    size_t required_poll_count = listeners->count + 1;
    int ready;

    if (required_poll_count > poll_capacity) {
      size_t next_capacity = poll_capacity == 0 ? 16 : poll_capacity;
      struct pollfd *next;

      while (next_capacity < required_poll_count) {
        next_capacity *= 2;
      }
      next = (struct pollfd *)realloc(poll_fds, next_capacity * sizeof(struct pollfd));
      if (next == NULL) {
        free(poll_fds);
        return -1;
      }
      poll_fds = next;
      poll_capacity = next_capacity;
    }

    poll_fds[0].fd = STDIN_FILENO;
    poll_fds[0].events = POLLIN;
    poll_fds[0].revents = 0;
    for (size_t index = 0; index < listeners->count; index++) {
      poll_fds[index + 1].fd = listeners->items[index].fd;
      poll_fds[index + 1].events = POLLIN;
      poll_fds[index + 1].revents = 0;
    }

    ready = poll(poll_fds, (nfds_t)required_poll_count, -1);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      fprintf(stderr, "poll failed for %zu router fds: %s\n", required_poll_count, strerror(errno));
      free(poll_fds);
      return -1;
    }

    for (size_t index = 0; index < listeners->count; index++) {
      if ((poll_fds[index + 1].revents & POLLIN) != 0) {
        pm_accept_ready_connections(listeners->items[index].fd, listeners->items[index].logical_port);
      }
    }

    if ((poll_fds[0].revents & (POLLIN | POLLHUP | POLLERR)) != 0 && pm_read_control_input(listeners, input_buffer) != 0) {
      free(poll_fds);
      return 0;
    }
  }
}
#endif

int main(int argc, char **argv) {
  listener_list_t listeners = {0};
  line_buffer_t input_buffer = {0};
  int control_mode = 0;
  char ready_line[64];

  if (argc < 2) {
    fprintf(stderr, "usage: %s <logical-port> [logical-port ...] | --control\n", argv[0]);
    return 2;
  }

  signal(SIGPIPE, SIG_IGN);
#if PM_ROUTER_USE_KQUEUE
  pm_kqueue_fd = kqueue();
  if (pm_kqueue_fd < 0) {
    fprintf(stderr, "could not create router kqueue: %s\n", strerror(errno));
    return 6;
  }
  if (pm_register_read_event(STDIN_FILENO, 0) != 0) {
    fprintf(stderr, "could not register router control input: %s\n", strerror(errno));
    close(pm_kqueue_fd);
    pm_kqueue_fd = -1;
    return 6;
  }
#endif
  control_mode = argc == 2 && strcmp(argv[1], "--control") == 0;
  if (control_mode) {
    if (pm_write_protocol_line("READY\tcontrol\n") != 0) {
      return 5;
    }
  } else {
    for (int arg_index = 1; arg_index < argc; arg_index++) {
      int logical_port = pm_parse_port(argv[arg_index]);
      if (logical_port == 0) {
        fprintf(stderr, "invalid logical port: %s\n", argv[arg_index]);
        pm_listener_list_free(&listeners);
        return 2;
      }

      if (pm_listener_list_open_port(&listeners, logical_port) != 0) {
        fprintf(stderr, "could not bind localhost logical port %d\n", logical_port);
        continue;
      }

      snprintf(ready_line, sizeof(ready_line), "READY\t%d\n", logical_port);
      if (pm_write_protocol_line(ready_line) != 0) {
        pm_listener_list_free(&listeners);
        return 5;
      }
    }

    if (listeners.count == 0) {
      return 3;
    }
  }

  (void)pm_run_event_loop(&listeners, &input_buffer);
  pm_line_buffer_free(&input_buffer);
  pm_listener_list_free(&listeners);
#if PM_ROUTER_USE_KQUEUE
  if (pm_kqueue_fd >= 0) {
    close(pm_kqueue_fd);
    pm_kqueue_fd = -1;
  }
#endif
  return 0;
}

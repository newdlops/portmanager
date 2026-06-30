#include "portmanager_agent.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define PM_CLIENT_BUFFER_INITIAL 2048
#define PM_CLIENT_BUFFER_MAX 32768
#define PM_CLIENT_READ_CHUNK 4096
#define PM_LISTEN_BACKLOG 16384
#define PM_LISTENER_POLL_IDLE_GRACE_SECONDS 2
#define PM_LISTENER_POLL_INTERVAL_SECONDS 300

typedef struct {
  int fd;
  int wants_events;
  char *buffer;
  size_t length;
  size_t capacity;
} pm_client;

typedef struct {
  char socket_path[PM_TEXT];
  char route_table_path[PM_TEXT];
  char agent_main_path[PM_TEXT];
} pm_arguments;

static int pm_running = 1;

static void pm_handle_signal(int signal_number) {
  (void)signal_number;
  pm_running = 0;
}

static void pm_usage(void) {
  fprintf(stderr, "Usage: portmanager_agent --socket <path> [--route-table <path>] [--agent-main <path>]\n");
}

static int pm_set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) {
    return -1;
  }

  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int pm_parse_arguments(int argc, char **argv, pm_arguments *arguments) {
  memset(arguments, 0, sizeof(*arguments));

  for (int index = 1; index < argc; index++) {
    if (strcmp(argv[index], "--socket") == 0 && index + 1 < argc) {
      snprintf(arguments->socket_path, sizeof(arguments->socket_path), "%s", argv[++index]);
      continue;
    }
    if (strcmp(argv[index], "--route-table") == 0 && index + 1 < argc) {
      snprintf(arguments->route_table_path, sizeof(arguments->route_table_path), "%s", argv[++index]);
      continue;
    }
    if (strcmp(argv[index], "--agent-main") == 0 && index + 1 < argc) {
      snprintf(arguments->agent_main_path, sizeof(arguments->agent_main_path), "%s", argv[++index]);
      continue;
    }
    pm_usage();
    return -1;
  }

  if (arguments->socket_path[0] == '\0') {
    pm_usage();
    return -1;
  }

  return 0;
}

static int pm_create_server(const char *socket_path) {
  int fd;
  struct sockaddr_un address;

  fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    perror("socket");
    return -1;
  }

  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (strlen(socket_path) >= sizeof(address.sun_path)) {
    fprintf(stderr, "Port Manager socket path is too long: %s\n", socket_path);
    close(fd);
    return -1;
  }
  snprintf(address.sun_path, sizeof(address.sun_path), "%s", socket_path);

  unlink(socket_path);
  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    perror("bind");
    close(fd);
    return -1;
  }

  chmod(socket_path, 0600);
  if (pm_set_nonblocking(fd) != 0) {
    perror("fcntl");
    close(fd);
    unlink(socket_path);
    return -1;
  }

  if (listen(fd, PM_LISTEN_BACKLOG) != 0) {
    perror("listen");
    close(fd);
    unlink(socket_path);
    return -1;
  }

  return fd;
}

static int pm_write_all(int fd, const char *data, size_t length) {
  size_t offset = 0;

  while (offset < length) {
    ssize_t written = write(fd, data + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        struct pollfd write_poll;
        int ready;

        memset(&write_poll, 0, sizeof(write_poll));
        write_poll.fd = fd;
        write_poll.events = POLLOUT;
        ready = poll(&write_poll, 1, 100);
        if (ready < 0 && errno == EINTR) {
          continue;
        }
        if (ready > 0 && (write_poll.revents & POLLOUT)) {
          continue;
        }
      }
      return -1;
    }
    if (written == 0) {
      return -1;
    }
    offset += (size_t)written;
  }

  return 0;
}

static int pm_send_response(int fd, const pm_request *request, int ok, const char *payload, const char *error) {
  pm_buffer message;
  int result;

  pm_buffer_init(&message);
  if (ok) {
    result = pm_buffer_append(&message, "{\"type\":\"response\",\"id\":") ||
             pm_buffer_append(&message, request->id_raw) ||
             pm_buffer_append(&message, ",\"method\":") ||
             pm_json_append_string(&message, request->method) ||
             pm_buffer_append(&message, ",\"ok\":true,\"payload\":") ||
             pm_buffer_append(&message, payload == NULL ? "null" : payload) ||
             pm_buffer_append(&message, "}\n");
  } else {
    result = pm_buffer_append(&message, "{\"type\":\"response\",\"id\":") ||
             pm_buffer_append(&message, request->id_raw[0] == '\0' ? "\"unknown\"" : request->id_raw) ||
             pm_buffer_append(&message, ",\"method\":") ||
             pm_json_append_string(&message, request->method[0] == '\0' ? "unknown" : request->method) ||
             pm_buffer_append(&message, ",\"ok\":false,\"error\":") ||
             pm_json_append_string(&message, error == NULL ? "Port Manager native daemon request failed." : error) ||
             pm_buffer_append(&message, "}\n");
  }

  if (result == 0) {
    result = pm_write_all(fd, message.data, message.length);
  }

  pm_buffer_free(&message);
  return result;
}

static int pm_build_snapshot_event(pm_agent_state *state, pm_buffer *message) {
  pm_buffer snapshot;
  int result;

  pm_buffer_init(&snapshot);
  result = pm_state_snapshot(state, &snapshot);
  if (result == 0) {
    result = pm_buffer_append(message, "{\"type\":\"snapshot\",\"payload\":") ||
             pm_buffer_append(message, snapshot.data) ||
             pm_buffer_append(message, "}\n");
  }
  pm_buffer_free(&snapshot);
  return result;
}

static void pm_broadcast_snapshot(pm_client *clients, size_t client_count, pm_agent_state *state) {
  pm_buffer message;
  int built = 0;

  pm_buffer_init(&message);
  for (size_t index = 0; index < client_count; index++) {
    if (clients[index].fd >= 0 && clients[index].wants_events) {
      if (!built) {
        if (pm_build_snapshot_event(state, &message) != 0) {
          break;
        }
        built = 1;
      }
      pm_write_all(clients[index].fd, message.data, message.length);
    }
  }
  pm_buffer_free(&message);
}

static int pm_has_event_clients(pm_client *clients, size_t client_count) {
  for (size_t index = 0; index < client_count; index++) {
    if (clients[index].fd >= 0 && clients[index].wants_events) {
      return 1;
    }
  }

  return 0;
}

static int pm_request_wants_events(const pm_request *request) {
  /*
   * Hook clients and shell probes read a single response frame and close. If
   * they receive an async snapshot from another request first, they interpret
   * it as their response and fail the bind path under concurrency. Only the VS
   * Code extension client keeps a socket open for live snapshot events.
   */
  return strncmp(request->id_raw, "\"extension-", 11) == 0;
}

static int pm_reserve_client_buffer(pm_client *client, size_t required) {
  size_t next_capacity;
  char *next;

  if (required > PM_CLIENT_BUFFER_MAX) {
    return -1;
  }
  if (required <= client->capacity) {
    return 0;
  }

  next_capacity = client->capacity == 0 ? PM_CLIENT_BUFFER_INITIAL : client->capacity;
  while (next_capacity < required && next_capacity < PM_CLIENT_BUFFER_MAX) {
    next_capacity *= 2;
  }
  if (next_capacity > PM_CLIENT_BUFFER_MAX) {
    next_capacity = PM_CLIENT_BUFFER_MAX;
  }
  if (next_capacity < required) {
    return -1;
  }

  next = (char *)realloc(client->buffer, next_capacity);
  if (next == NULL) {
    return -1;
  }
  client->buffer = next;
  client->capacity = next_capacity;
  if (client->length == 0) {
    client->buffer[0] = '\0';
  }
  return 0;
}

static int pm_dispatch(pm_agent_state *state, const pm_request *request, pm_buffer *payload, int *state_changed, int *shutdown_requested, char *error, size_t error_size) {
  *state_changed = 0;
  *shutdown_requested = 0;

  if (strcmp(request->method, "listSnapshot") == 0) {
    return pm_state_snapshot(state, payload);
  }
  if (strcmp(request->method, "daemonStatus") == 0) {
    return pm_state_daemon_status(state, payload);
  }
  if (strcmp(request->method, "refreshSnapshot") == 0) {
    return pm_state_refresh_snapshot(state, payload);
  }
  if (strcmp(request->method, "allocateRoute") == 0) {
    pm_allocate_input input;
    if (pm_parse_allocate_input(request->payload, &input) != 0) {
      snprintf(error, error_size, "Invalid allocateRoute payload.");
      return -1;
    }
    *state_changed = 1;
    return pm_state_allocate_route(state, &input, payload);
  }
  if (strcmp(request->method, "registerExistingProcess") == 0) {
    pm_register_input input;
    if (pm_parse_register_input(request->payload, &input) != 0) {
      snprintf(error, error_size, "Invalid registerExistingProcess payload.");
      return -1;
    }
    *state_changed = 1;
    return pm_state_register_process(state, &input, payload);
  }
  if (strcmp(request->method, "releaseRouteAllocation") == 0) {
    char allocation_id[PM_ID];
    if (pm_json_get_string(request->payload, "allocationId", allocation_id, sizeof(allocation_id)) != 0) {
      snprintf(error, error_size, "Invalid releaseRouteAllocation payload.");
      return -1;
    }
    *state_changed = 1;
    return pm_state_release_allocation(state, allocation_id, payload);
  }
  if (strcmp(request->method, "releaseProcessRoute") == 0) {
    pm_release_process_input input;
    if (pm_parse_release_process_input(request->payload, &input) != 0) {
      snprintf(error, error_size, "Invalid releaseProcessRoute payload.");
      return -1;
    }
    *state_changed = 1;
    return pm_state_release_process_route(state, &input, payload);
  }
  if (strcmp(request->method, "startManagedProcess") == 0) {
    pm_start_input input;
    if (pm_parse_start_input(request->payload, &input) != 0) {
      snprintf(error, error_size, "Invalid startManagedProcess payload.");
      return -1;
    }
    *state_changed = 1;
    return pm_state_start_process(state, &input, payload);
  }
  if (strcmp(request->method, "stopProcess") == 0) {
    char id[PM_ID];
    char signal_name[PM_SMALL];
    if (pm_json_get_string(request->payload, "id", id, sizeof(id)) != 0) {
      snprintf(error, error_size, "Invalid stopProcess payload.");
      return -1;
    }
    if (pm_json_get_string(request->payload, "signal", signal_name, sizeof(signal_name)) != 0) {
      signal_name[0] = '\0';
    }
    *state_changed = 1;
    return pm_state_stop_process(state, id, signal_name, payload);
  }
  if (strcmp(request->method, "restartProcess") == 0) {
    char id[PM_ID];
    char signal_name[PM_SMALL];
    if (pm_json_get_string(request->payload, "id", id, sizeof(id)) != 0) {
      snprintf(error, error_size, "Invalid restartProcess payload.");
      return -1;
    }
    if (pm_json_get_string(request->payload, "signal", signal_name, sizeof(signal_name)) != 0) {
      signal_name[0] = '\0';
    }
    *state_changed = 1;
    return pm_state_restart_process(state, id, signal_name, payload);
  }
  if (strcmp(request->method, "removeProcess") == 0) {
    char id[PM_ID];
    if (pm_json_get_string(request->payload, "id", id, sizeof(id)) != 0) {
      snprintf(error, error_size, "Invalid removeProcess payload.");
      return -1;
    }
    *state_changed = 1;
    return pm_state_remove_process(state, id, payload);
  }
  if (strcmp(request->method, "shutdownDaemon") == 0) {
    *shutdown_requested = 1;
    return pm_buffer_append(payload, "true");
  }

  snprintf(error, error_size, "Unknown Port Manager native daemon method: %s", request->method);
  return -1;
}

static void pm_handle_line(pm_client *client, pm_agent_state *state, const char *line, int *snapshot_dirty, int *route_tables_dirty) {
  pm_request request;
  pm_buffer payload;
  char error[PM_TEXT] = "Port Manager native daemon request failed.";
  int state_changed = 0;
  int shutdown_requested = 0;

  memset(&request, 0, sizeof(request));
  pm_buffer_init(&payload);
  if (pm_parse_request(line, &request) != 0) {
    snprintf(request.id_raw, sizeof(request.id_raw), "\"unknown\"");
    pm_send_response(client->fd, &request, 0, NULL, "Invalid Port Manager agent request message.");
    pm_buffer_free(&payload);
    return;
  }

  if (pm_request_wants_events(&request)) {
    client->wants_events = 1;
  }

  if (pm_dispatch(state, &request, &payload, &state_changed, &shutdown_requested, error, sizeof(error)) != 0) {
    pm_send_response(client->fd, &request, 0, NULL, error);
    pm_buffer_free(&payload);
    return;
  }

  pm_send_response(client->fd, &request, 1, payload.data, NULL);
  if (state_changed) {
    /*
     * Route allocations can arrive in large bind/connect bursts. Mark the state
     * dirty here and let the event loop coalesce snapshot broadcasts and
     * aggregate route-table writes after all ready clients in this poll turn
     * have received their response frames.
     */
    *snapshot_dirty = 1;
    state->route_tables_dirty = 1;
    *route_tables_dirty = 1;
  }
  if (shutdown_requested) {
    pm_running = 0;
  }

  pm_buffer_free(&payload);
}

static int pm_add_client(pm_client **clients, size_t *count, size_t *capacity, int fd) {
  pm_client *next;
  size_t next_capacity;

  if (*count + 1 > *capacity) {
    next_capacity = *capacity == 0 ? 16 : *capacity * 2;
    next = (pm_client *)realloc(*clients, next_capacity * sizeof(pm_client));
    if (next == NULL) {
      return -1;
    }
    *clients = next;
    *capacity = next_capacity;
  }

  (*clients)[*count].fd = fd;
  (*clients)[*count].wants_events = 0;
  (*clients)[*count].buffer = NULL;
  (*clients)[*count].length = 0;
  (*clients)[*count].capacity = 0;
  (*count)++;
  return 0;
}

static void pm_remove_client(pm_client *clients, size_t *count, size_t index) {
  if (clients[index].fd >= 0) {
    close(clients[index].fd);
  }
  free(clients[index].buffer);
  memmove(&clients[index], &clients[index + 1], (*count - index - 1) * sizeof(pm_client));
  (*count)--;
}

static int pm_process_client_buffer(pm_client *client, pm_agent_state *state, int *snapshot_dirty, int *route_tables_dirty) {
  for (;;) {
    char *newline = memchr(client->buffer, '\n', client->length);
    size_t line_length;
    char line[PM_CLIENT_BUFFER_MAX];

    if (client->length == 0) {
      break;
    }
    if (newline == NULL) {
      break;
    }

    line_length = (size_t)(newline - client->buffer);
    if (line_length >= sizeof(line)) {
      return -1;
    }
    memcpy(line, client->buffer, line_length);
    line[line_length] = '\0';

    memmove(client->buffer, newline + 1, client->length - line_length - 1);
    client->length -= line_length + 1;
    client->buffer[client->length] = '\0';

    if (line_length > 0) {
      pm_handle_line(client, state, line, snapshot_dirty, route_tables_dirty);
    }
  }

  return 0;
}

static int pm_read_client(pm_client *client, pm_agent_state *state, int *snapshot_dirty, int *route_tables_dirty) {
  for (;;) {
    ssize_t bytes_read;
    size_t target_capacity;
    size_t available;

    if (client->length >= PM_CLIENT_BUFFER_MAX - 1) {
      return -1;
    }

    target_capacity = client->length + PM_CLIENT_READ_CHUNK + 1;
    if (target_capacity > PM_CLIENT_BUFFER_MAX) {
      target_capacity = PM_CLIENT_BUFFER_MAX;
    }
    if (pm_reserve_client_buffer(client, target_capacity) != 0) {
      return -1;
    }

    available = client->capacity - client->length - 1;
    if (available == 0) {
      return -1;
    }

    bytes_read = read(client->fd, client->buffer + client->length, available);
    if (bytes_read < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return 0;
      }
      return -1;
    }
    if (bytes_read == 0) {
      return -1;
    }

    client->length += (size_t)bytes_read;
    client->buffer[client->length] = '\0';
    if (pm_process_client_buffer(client, state, snapshot_dirty, route_tables_dirty) != 0) {
      return -1;
    }
  }
}

static void pm_event_loop(int server_fd, pm_agent_state *state) {
  pm_client *clients = NULL;
  struct pollfd *poll_fds = NULL;
  size_t client_count = 0;
  size_t client_capacity = 0;
  size_t poll_capacity = 0;
  pm_buffer last_listener_signature;
  time_t next_poll = time(NULL) + 3;
  time_t last_io_at = 0;
  time_t route_table_flush_retry_after = 0;
  int snapshot_dirty = 0;
  int route_tables_dirty = 0;

  pm_buffer_init(&last_listener_signature);

  while (pm_running) {
    size_t poll_count = client_count + 1;
    size_t polled_client_count = client_count;
    int ready;
    int handled_io = 0;

    if (poll_count > poll_capacity) {
      size_t next_capacity = poll_capacity == 0 ? 64 : poll_capacity;
      struct pollfd *next;

      while (next_capacity < poll_count) {
        next_capacity *= 2;
      }

      next = (struct pollfd *)realloc(poll_fds, next_capacity * sizeof(struct pollfd));
      if (next == NULL) {
        break;
      }
      poll_fds = next;
      poll_capacity = next_capacity;
    }

    memset(poll_fds, 0, poll_count * sizeof(struct pollfd));
    poll_fds[0].fd = server_fd;
    poll_fds[0].events = POLLIN;
    for (size_t index = 0; index < client_count; index++) {
      poll_fds[index + 1].fd = clients[index].fd;
      poll_fds[index + 1].events = POLLIN;
    }

    ready = poll(poll_fds, (nfds_t)poll_count, 1000);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      fprintf(stderr, "Port Manager native agent poll failed: %s\n", strerror(errno));
      break;
    }

    if (ready > 0 && (poll_fds[0].revents & (POLLERR | POLLHUP | POLLNVAL))) {
      fprintf(stderr, "Port Manager native agent socket failed: revents=%hd\n", poll_fds[0].revents);
      break;
    }

    if (ready > 0 && (poll_fds[0].revents & POLLIN)) {
      for (;;) {
        int client_fd = accept(server_fd, NULL, NULL);
        if (client_fd < 0) {
          if (errno == EINTR) {
            continue;
          }
          break;
        }
        handled_io = 1;
        if (pm_set_nonblocking(client_fd) != 0) {
          close(client_fd);
          continue;
        }
        if (pm_add_client(&clients, &client_count, &client_capacity, client_fd) != 0) {
          close(client_fd);
        }
      }
    }

    for (size_t reverse = polled_client_count; reverse > 0;) {
      size_t index = --reverse;
      short revents;

      if (index >= client_count) {
        continue;
      }

      revents = poll_fds[index + 1].revents;
      if (revents & (POLLERR | POLLHUP | POLLNVAL)) {
        pm_remove_client(clients, &client_count, index);
        continue;
      }
      if (revents & POLLIN) {
        handled_io = 1;
        if (pm_read_client(&clients[index], state, &snapshot_dirty, &route_tables_dirty) != 0) {
          pm_remove_client(clients, &client_count, index);
        }
      }
    }

    if (handled_io) {
      last_io_at = time(NULL);
    }

    if (pm_state_reap_children(state)) {
      snapshot_dirty = 1;
      route_tables_dirty = 1;
    }

    if (time(NULL) >= next_poll) {
      time_t now = time(NULL);
      if (handled_io || (last_io_at > 0 && now - last_io_at < PM_LISTENER_POLL_IDLE_GRACE_SECONDS) || !pm_has_event_clients(clients, client_count)) {
        next_poll = now + 1;
      } else {
        pm_buffer signature;
        pm_buffer_init(&signature);
        if (pm_state_listener_signature(state, &signature) == 0) {
          if (last_listener_signature.data == NULL || strcmp(last_listener_signature.data, signature.data == NULL ? "" : signature.data) != 0) {
            pm_buffer_free(&last_listener_signature);
            last_listener_signature = signature;
            memset(&signature, 0, sizeof(signature));
            snapshot_dirty = 1;
          }
        }
        pm_buffer_free(&signature);
        next_poll = now + PM_LISTENER_POLL_INTERVAL_SECONDS;
      }
    }

    if (snapshot_dirty && !pm_has_event_clients(clients, client_count)) {
      snapshot_dirty = 0;
    } else if (snapshot_dirty && client_count > 0) {
      time_t now = time(NULL);
      /*
       * Full snapshots rescan OS listeners and can be relatively expensive.
       * Keep short-lived hook requests ahead of UI refreshes while a burst is
       * still active, then publish one reconciled snapshot once the socket loop
       * has been idle for a short grace period.
       */
      if (!handled_io && (last_io_at == 0 || now - last_io_at >= PM_LISTENER_POLL_IDLE_GRACE_SECONDS)) {
        pm_broadcast_snapshot(clients, client_count, state);
        snapshot_dirty = 0;
      }
    }

    if (route_tables_dirty || state->route_tables_dirty || pm_state_route_table_heartbeat_due(state, time(NULL))) {
      time_t now = time(NULL);
      int heartbeat_due = pm_state_route_table_heartbeat_due(state, now);

      if (now >= route_table_flush_retry_after &&
          (heartbeat_due || (!handled_io && (last_io_at == 0 || now - last_io_at >= PM_LISTENER_POLL_IDLE_GRACE_SECONDS)))) {
        if (pm_state_flush_route_tables(state) == 0) {
          route_tables_dirty = 0;
          route_table_flush_retry_after = 0;
        } else {
          route_table_flush_retry_after = now + 1;
        }
      }
    }
  }

  for (size_t index = 0; index < client_count; index++) {
    close(clients[index].fd);
    free(clients[index].buffer);
  }
  free(poll_fds);
  free(clients);
  pm_buffer_free(&last_listener_signature);
}

int main(int argc, char **argv) {
  pm_arguments arguments;
  pm_agent_state state;
  int server_fd;

  signal(SIGTERM, pm_handle_signal);
  signal(SIGINT, pm_handle_signal);
  signal(SIGHUP, pm_handle_signal);
  /*
   * Hook clients open a short-lived socket, read the response frame, and close
   * before the daemon broadcasts the follow-up snapshot. Ignore SIGPIPE so a
   * closed request socket becomes a normal EPIPE write failure instead of
   * terminating the routing daemon and causing later bind hooks to return
   * EAGAIN.
   */
  signal(SIGPIPE, SIG_IGN);

  if (pm_parse_arguments(argc, argv, &arguments) != 0) {
    return 1;
  }

  server_fd = pm_create_server(arguments.socket_path);
  if (server_fd < 0) {
    return 1;
  }

  pm_state_init(&state, arguments.route_table_path, arguments.agent_main_path);
  pm_event_loop(server_fd, &state);
  pm_state_dispose(&state);
  close(server_fd);
  unlink(arguments.socket_path);
  return 0;
}

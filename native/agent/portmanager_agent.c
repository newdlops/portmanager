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

#include "../shared/pm_dev_log.h"

#define PM_CLIENT_BUFFER_INITIAL 2048
/* Large enough for a respawnChild request carrying an escaped child's full
 * argv+env (base64), which reaches tens of KB in deep shell/yarn chains. */
#define PM_CLIENT_BUFFER_MAX 262144
#define PM_CLIENT_READ_CHUNK 4096
#define PM_LISTEN_BACKLOG 16384
#define PM_LISTENER_POLL_IDLE_GRACE_SECONDS 2
#define PM_LISTENER_POLL_INTERVAL_SECONDS 300
/* UI events coalesce a short mutation burst but cannot starve behind sustained hook traffic. */
#define PM_SNAPSHOT_BROADCAST_IDLE_MS 40
#define PM_SNAPSHOT_BROADCAST_MAX_DELAY_MS 250
#define PM_EVENT_LOOP_DEFAULT_POLL_MS 1000
#define PM_ACCEPT_BUDGET_PER_TURN 512
#define PM_CLIENT_READ_BUDGET_PER_TURN 512
#define PM_CLIENT_RESPONSE_WRITE_BUDGET_MS 100
#define PM_CONTROL_WRITE_BUDGET_MS 100
#define PM_SNAPSHOT_BROADCAST_WRITE_BUDGET_MS 100
/* Sustained mutation storms get a fixed scheduling deadline; the separate
 * socket budget bounds fan-out without forcing large snapshots at >4Hz. */
#define PM_SNAPSHOT_BROADCAST_START_MAX_DELAY_MS \
  PM_SNAPSHOT_BROADCAST_MAX_DELAY_MS

typedef struct {
  int fd;
  int wants_events;
  int is_control;
  int control_pid;
  char *buffer;
  size_t length;
  size_t capacity;
} pm_client;

/*
 * Persistent control connections keyed by pid. A hooked parent opens one and
 * the daemon pushes a RESPAWN command to it so the parent relaunches an escaped
 * child as a true child of itself (preserving the process tree, stdio, and job
 * control that no reparenting API can restore afterward on macOS).
 */
typedef struct {
  int pid;
  int fd;
  /* Network scope the hooked parent registered with, so a respawn is routed
   * only to an ancestor in the escaped child's own network (never a shared or
   * cross-network ancestor, whose kill/wait virtualization would leak signals
   * across network boundaries). */
  char network_id[128];
} pm_control_entry;

static pm_control_entry *pm_control_entries = NULL;
static size_t pm_control_entry_count = 0;
static size_t pm_control_entry_capacity = 0;

static long long pm_monotonic_milliseconds(void);
static void pm_disconnect_client(pm_client *client);

static void pm_control_registry_set(int pid, int fd, const char *network_id) {
  for (size_t index = 0; index < pm_control_entry_count; index++) {
    if (pm_control_entries[index].pid == pid) {
      pm_control_entries[index].fd = fd;
      snprintf(pm_control_entries[index].network_id, sizeof(pm_control_entries[index].network_id), "%s",
               network_id != NULL ? network_id : "");
      return;
    }
  }
  if (pm_control_entry_count + 1 > pm_control_entry_capacity) {
    size_t next_capacity = pm_control_entry_capacity == 0 ? 32 : pm_control_entry_capacity * 2;
    pm_control_entry *next = (pm_control_entry *)realloc(pm_control_entries, next_capacity * sizeof(pm_control_entry));
    if (next == NULL) {
      return;
    }
    pm_control_entries = next;
    pm_control_entry_capacity = next_capacity;
  }
  pm_control_entries[pm_control_entry_count].pid = pid;
  pm_control_entries[pm_control_entry_count].fd = fd;
  snprintf(pm_control_entries[pm_control_entry_count].network_id, sizeof(pm_control_entries[pm_control_entry_count].network_id), "%s",
           network_id != NULL ? network_id : "");
  pm_control_entry_count++;
}

/*
 * Returns the control fd for pid only when its registered network matches
 * want_network_id. A pid whose network differs returns -1 so the caller falls
 * through to the next candidate ancestor rather than routing cross-network.
 */
static int pm_control_registry_fd_for_pid(int pid, const char *want_network_id) {
  for (size_t index = 0; index < pm_control_entry_count; index++) {
    if (pm_control_entries[index].pid == pid) {
      if (want_network_id == NULL || want_network_id[0] == '\0' ||
          strcmp(pm_control_entries[index].network_id, want_network_id) == 0) {
        return pm_control_entries[index].fd;
      }
      return -1;
    }
  }
  return -1;
}

/*
 * Writes an entire buffer to a nonblocking control socket, waiting for
 * writability between partial writes. A RESPAWN line carries the escaped
 * child's full env and exceeds the socket send buffer, so a single write()
 * returns short; without draining it the push silently fails. Bounded so a
 * stuck reader cannot hang the daemon's poll loop.
 */
static int pm_write_all_to_control(int fd, const char *data, size_t length) {
  size_t written = 0;
  long long deadline_ms = pm_monotonic_milliseconds() + PM_CONTROL_WRITE_BUDGET_MS;

  while (written < length) {
    if (written > 0 && pm_monotonic_milliseconds() >= deadline_ms) {
      return -1;
    }
    ssize_t count = write(fd, data + written, length - written);
    if (count > 0) {
      written += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) {
      if (pm_monotonic_milliseconds() >= deadline_ms) {
        return -1;
      }
      continue;
    }
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd writable = {.fd = fd, .events = POLLOUT, .revents = 0};
      long long remaining_ms = deadline_ms - pm_monotonic_milliseconds();
      int ready;

      if (remaining_ms <= 0) {
        return -1;
      }
      ready = poll(&writable, 1, (int)remaining_ms);
      if (ready < 0 && errno == EINTR) {
        continue;
      }
      if (ready <= 0 || (writable.revents & (POLLERR | POLLHUP | POLLNVAL))) {
        return -1;
      }
      continue;
    }
    return -1;
  }

  return 0;
}

static void pm_control_registry_remove_fd(int fd) {
  size_t index = 0;
  while (index < pm_control_entry_count) {
    if (pm_control_entries[index].fd == fd) {
      memmove(
        &pm_control_entries[index],
        &pm_control_entries[index + 1],
        (pm_control_entry_count - index - 1) * sizeof(pm_control_entry));
      pm_control_entry_count--;
    } else {
      index++;
    }
  }
}

static int pm_running = 1;

static void pm_handle_signal(int signal_number) {
  (void)signal_number;
  pm_running = 0;
}

/** Monotonic timing keeps UI fairness independent of wall-clock adjustments. */
static long long pm_monotonic_milliseconds(void) {
  struct timespec now;

  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    return (long long)time(NULL) * 1000LL;
  }

  return (long long)now.tv_sec * 1000LL + now.tv_nsec / 1000000LL;
}

static int pm_set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) {
    return -1;
  }

  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int pm_socket_has_live_server(const struct sockaddr_un *address) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  int connected;

  if (fd < 0) {
    return 0;
  }

  connected = connect(fd, (const struct sockaddr *)address, sizeof(*address)) == 0;
  close(fd);
  return connected;
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

  if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    int bind_errno = errno;
    if (bind_errno != EADDRINUSE || pm_socket_has_live_server(&address)) {
      if (bind_errno == EADDRINUSE) {
        fprintf(stderr, "Port Manager agent is already listening on %s\n", socket_path);
      } else {
        errno = bind_errno;
        perror("bind");
      }
      close(fd);
      return -1;
    }

    /*
     * A filesystem entry can outlive the daemon after a crash. Only unlink after
     * a connection probe proves that no live daemon owns the socket path.
     */
    unlink(socket_path);
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
      perror("bind");
      close(fd);
      return -1;
    }
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

/** Shares one deadline across event subscribers so slow windows cannot each
 * charge the singleton mutation loop a full socket-write timeout. */
static int pm_write_all_until(int fd, const char *data, size_t length, long long deadline_ms) {
  size_t offset = 0;

  while (offset < length) {
    if (offset > 0 && pm_monotonic_milliseconds() >= deadline_ms) {
      return -1;
    }
    ssize_t written = write(fd, data + offset, length - offset);
    if (written > 0) {
      offset += (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) {
      if (pm_monotonic_milliseconds() >= deadline_ms) {
        return -1;
      }
      continue;
    }
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd write_poll = {.fd = fd, .events = POLLOUT, .revents = 0};
      long long remaining_ms = deadline_ms - pm_monotonic_milliseconds();

      if (remaining_ms <= 0 ||
          poll(&write_poll, 1, (int)remaining_ms) <= 0 ||
          (write_poll.revents & (POLLERR | POLLHUP | POLLNVAL))) {
        return -1;
      }
      continue;
    }
    return -1;
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
    result = pm_write_all_until(
      fd,
      message.data,
      message.length,
      pm_monotonic_milliseconds() + PM_CLIENT_RESPONSE_WRITE_BUDGET_MS);
  }

  pm_buffer_free(&message);
  return result;
}

static int pm_build_snapshot_event(pm_agent_state *state, pm_buffer *message) {
  pm_buffer snapshot;
  int result;

  pm_buffer_init(&snapshot);
  /* Event fan-out must stay memory-only; explicit snapshot requests own scans. */
  result = pm_state_cached_snapshot(state, &snapshot);
  if (result == 0) {
    result = pm_buffer_append(message, "{\"type\":\"snapshot\",\"payload\":") ||
             pm_buffer_append(message, snapshot.data) ||
             pm_buffer_append(message, "}\n");
  }
  pm_buffer_free(&snapshot);
  return result;
}

/** Advances one subscriber by at most one successful nonblocking write so all
 * windows get a chance before any lagging window consumes the shared budget. */
static int pm_write_event_progress(
  pm_client *client,
  const char *data,
  size_t length,
  size_t *offset,
  long long deadline_ms) {
  for (;;) {
    ssize_t written;

    if (pm_monotonic_milliseconds() >= deadline_ms) {
      return 0;
    }
    written = write(client->fd, data + *offset, length - *offset);
    if (written > 0) {
      *offset += (size_t)written;
      return *offset >= length ? 1 : 0;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return 0;
    }
    return -1;
  }
}

static int pm_broadcast_snapshot(pm_client *clients, size_t client_count, pm_agent_state *state) {
  pm_buffer message;
  struct pollfd *write_fds = NULL;
  size_t *write_offsets = NULL;
  long long write_deadline_ms;
  size_t subscriber_count = 0;
  size_t sole_subscriber_index = 0;
  int result = -1;

  pm_buffer_init(&message);
  for (size_t index = 0; index < client_count; index++) {
    if (clients[index].fd >= 0 && clients[index].wants_events) {
      sole_subscriber_index = index;
      subscriber_count++;
    }
  }
  if (subscriber_count == 0) {
    result = 0;
    goto done;
  }
  if (pm_build_snapshot_event(state, &message) != 0) {
    goto done;
  }

  write_deadline_ms = pm_monotonic_milliseconds() + PM_SNAPSHOT_BROADCAST_WRITE_BUDGET_MS;
  if (subscriber_count == 1) {
    if (pm_write_all_until(
          clients[sole_subscriber_index].fd,
          message.data,
          message.length,
          write_deadline_ms) != 0) {
      pm_disconnect_client(&clients[sole_subscriber_index]);
    }
    result = 0;
    goto done;
  }

  write_fds = (struct pollfd *)calloc(client_count, sizeof(struct pollfd));
  write_offsets = (size_t *)calloc(client_count, sizeof(size_t));
  if (write_fds == NULL || write_offsets == NULL) {
    goto done;
  }

  for (size_t index = 0; index < client_count; index++) {
    if (clients[index].fd >= 0 && clients[index].wants_events) {
      int progress = pm_write_event_progress(
        &clients[index], message.data, message.length, &write_offsets[index], write_deadline_ms);
      if (progress < 0) {
        pm_disconnect_client(&clients[index]);
      }
    }
  }

  for (;;) {
    size_t pending_count = 0;
    long long remaining_ms = write_deadline_ms - pm_monotonic_milliseconds();
    int ready;

    for (size_t index = 0; index < client_count; index++) {
      write_fds[index].fd = -1;
      write_fds[index].events = 0;
      write_fds[index].revents = 0;
      if (clients[index].fd >= 0 &&
          clients[index].wants_events &&
          write_offsets[index] < message.length) {
        write_fds[index].fd = clients[index].fd;
        write_fds[index].events = POLLOUT;
        pending_count++;
      }
    }

    if (pending_count == 0 || remaining_ms <= 0) {
      break;
    }

    ready = poll(write_fds, (nfds_t)client_count, (int)remaining_ms);
    if (ready < 0 && errno == EINTR) {
      continue;
    }
    if (ready <= 0) {
      break;
    }

    for (size_t index = 0; index < client_count; index++) {
      if (write_fds[index].fd < 0) {
        continue;
      }
      if (write_fds[index].revents & (POLLERR | POLLHUP | POLLNVAL)) {
        pm_disconnect_client(&clients[index]);
        continue;
      }
      if (write_fds[index].revents & POLLOUT) {
        int progress = pm_write_event_progress(
          &clients[index], message.data, message.length, &write_offsets[index], write_deadline_ms);
        if (progress < 0) {
          pm_disconnect_client(&clients[index]);
        }
      }
    }
  }

  for (size_t index = 0; index < client_count; index++) {
    if (clients[index].fd >= 0 &&
        clients[index].wants_events &&
        write_offsets[index] < message.length) {
      /* A partial line can never share a stream with the next JSON event.
       * Reconnect the lagging subscriber from a clean frame boundary. */
      pm_disconnect_client(&clients[index]);
    }
  }
  result = 0;

done:
  free(write_offsets);
  free(write_fds);
  pm_buffer_free(&message);
  return result;
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

  /*
   * Dev-log every request except the high-frequency read-only polls, so the
   * shared timeline (docs/dev-logging.md) shows route allocations/releases and
   * other mutations without being flooded by snapshot polling.
   */
  if (pm_dev_log_enabled() && strcmp(request->method, "listSnapshot") != 0 &&
      strcmp(request->method, "daemonStatus") != 0 &&
      strcmp(request->method, "refreshSnapshot") != 0) {
    pm_dev_log("agent", "dispatch method=%s", request->method);
  }

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

static int pm_handle_line(pm_client *client, pm_agent_state *state, const char *line, int *snapshot_dirty, int *route_tables_dirty) {
  pm_request request;
  pm_buffer payload;
  char error[PM_TEXT] = "Port Manager native daemon request failed.";
  int state_changed = 0;
  int shutdown_requested = 0;

  memset(&request, 0, sizeof(request));
  pm_buffer_init(&payload);
  if (pm_parse_request(line, &request) != 0) {
    snprintf(request.id_raw, sizeof(request.id_raw), "\"unknown\"");
    int send_result = pm_send_response(client->fd, &request, 0, NULL, "Invalid Port Manager agent request message.");
    pm_buffer_free(&payload);
    return send_result;
  }

  if (pm_request_wants_events(&request) && !client->wants_events) {
    client->wants_events = 1;
    /* The first subscription receives current in-memory state without waiting
     * for the five-minute listener poll or a later mutation. */
    *snapshot_dirty = 1;
  }

  /*
   * A hooked parent registers a persistent control connection here. The socket
   * stays open (unlike request/response clients) so the daemon can push a
   * RESPAWN command to it later.
   */
  if (strcmp(request.method, "controlChannel") == 0) {
    int pid = pm_json_get_int(request.payload == NULL ? "" : request.payload, "pid", 0);
    char network_id[128];
    network_id[0] = '\0';
    pm_json_get_string(request.payload == NULL ? "" : request.payload, "networkId", network_id, sizeof(network_id));
    if (pid > 0) {
      client->is_control = 1;
      client->control_pid = pid;
      pm_control_registry_set(pid, client->fd, network_id);
    }
    int send_result = pm_send_response(client->fd, &request, 1, NULL, NULL);
    pm_buffer_free(&payload);
    return send_result;
  }

  /*
   * Routes a preformatted RESPAWN line to a parent's control connection. The
   * detector (extension) computes the escaped child's argv/env/cwd and a
   * nearest-first list of candidate ancestor pids (comma-separated); the daemon
   * forwards the opaque line to the first candidate that owns a control
   * connection, since only the daemon knows which ancestors are hooked.
   */
  if (strcmp(request.method, "respawnChild") == 0) {
    char parent_pids[PM_TEXT];
    char target_network_id[128];
    int target_fd = -1;

    parent_pids[0] = '\0';
    target_network_id[0] = '\0';
    pm_json_get_string(request.payload == NULL ? "" : request.payload, "parentPids", parent_pids, sizeof(parent_pids));
    pm_json_get_string(request.payload == NULL ? "" : request.payload, "networkId", target_network_id, sizeof(target_network_id));
    {
      char *saveptr = NULL;
      char *token = strtok_r(parent_pids, ",", &saveptr);
      while (token != NULL && target_fd < 0) {
        int candidate = atoi(token);
        if (candidate > 0) {
          /* Same-network ancestors only: never route across network scope. */
          target_fd = pm_control_registry_fd_for_pid(candidate, target_network_id);
        }
        token = strtok_r(NULL, ",", &saveptr);
      }
    }

    int pushed = 0;

    if (target_fd >= 0) {
      char *line = (char *)malloc(PM_CLIENT_BUFFER_MAX);
      if (line != NULL) {
        if (pm_json_get_string(request.payload == NULL ? "" : request.payload, "line", line, PM_CLIENT_BUFFER_MAX) == 0) {
          size_t length = strlen(line);
          if (length + 1 < PM_CLIENT_BUFFER_MAX) {
            line[length] = '\n';
            line[length + 1] = '\0';
            length++;
          }
          pushed = pm_write_all_to_control(target_fd, line, length) == 0;
        }
        free(line);
      }
    }

    if (pushed) {
      int send_result = pm_send_response(client->fd, &request, 1, NULL, NULL);
      pm_buffer_free(&payload);
      return send_result;
    } else {
      int send_result = pm_send_response(client->fd, &request, 0, NULL, "No control channel for the requested parent pid.");
      pm_buffer_free(&payload);
      return send_result;
    }
  }

  if (pm_dispatch(state, &request, &payload, &state_changed, &shutdown_requested, error, sizeof(error)) != 0) {
    int send_result = pm_send_response(client->fd, &request, 0, NULL, error);
    pm_buffer_free(&payload);
    return send_result;
  }

  int send_result = pm_send_response(client->fd, &request, 1, payload.data, NULL);
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
  return send_result;
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
  (*clients)[*count].is_control = 0;
  (*clients)[*count].control_pid = 0;
  (*clients)[*count].buffer = NULL;
  (*clients)[*count].length = 0;
  (*clients)[*count].capacity = 0;
  (*count)++;
  return 0;
}

static void pm_remove_client(pm_client *clients, size_t *count, size_t index) {
  if (clients[index].fd >= 0) {
    pm_control_registry_remove_fd(clients[index].fd);
    close(clients[index].fd);
  }
  free(clients[index].buffer);
  memmove(&clients[index], &clients[index + 1], (*count - index - 1) * sizeof(pm_client));
  (*count)--;
}

/** Closes one client without shifting the poll-indexed array mid-turn. */
static void pm_disconnect_client(pm_client *client) {
  if (client->fd >= 0) {
    pm_control_registry_remove_fd(client->fd);
    close(client->fd);
  }
  client->fd = -1;
  client->wants_events = 0;
}

/** Removes marked clients while keeping the round-robin cursor attached to
 * the same next live fd instead of to an index shifted by memmove(). */
static void pm_compact_clients_preserving_cursor(pm_client *clients, size_t *count, size_t *scan_cursor) {
  int next_fd = -1;
  size_t original_count = *count;

  if (original_count > 0) {
    size_t start = *scan_cursor % original_count;
    for (size_t offset = 0; offset < original_count; offset++) {
      size_t index = (start + offset) % original_count;
      if (clients[index].fd >= 0) {
        next_fd = clients[index].fd;
        break;
      }
    }
  }

  for (size_t reverse = *count; reverse > 0;) {
    size_t index = --reverse;
    if (clients[index].fd < 0) {
      pm_remove_client(clients, count, index);
    }
  }

  *scan_cursor = 0;
  if (next_fd >= 0) {
    for (size_t index = 0; index < *count; index++) {
      if (clients[index].fd == next_fd) {
        *scan_cursor = index;
        break;
      }
    }
  }
}

static int pm_client_has_complete_frame(const pm_client *client) {
  return client->length > 0 && memchr(client->buffer, '\n', client->length) != NULL;
}

static int pm_process_client_buffer(
  pm_client *client,
  pm_agent_state *state,
  int *snapshot_dirty,
  int *route_tables_dirty,
  size_t max_frames) {
  size_t processed_frames = 0;

  while (processed_frames < max_frames) {
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
    processed_frames++;

    if (line_length > 0) {
      if (pm_handle_line(client, state, line, snapshot_dirty, route_tables_dirty) != 0) {
        return -1;
      }
    }
  }

  return 0;
}

static int pm_read_client(pm_client *client, pm_agent_state *state, int *snapshot_dirty, int *route_tables_dirty) {
  if (pm_client_has_complete_frame(client)) {
    return pm_process_client_buffer(client, state, snapshot_dirty, route_tables_dirty, 1);
  }

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
    /* poll() is level-triggered, so one bounded read per turn preserves
     * throughput without letting a pipelined client monopolize the daemon. */
    return pm_process_client_buffer(client, state, snapshot_dirty, route_tables_dirty, 1);
  }
}

static void pm_event_loop(int server_fd, pm_agent_state *state) {
  pm_client *clients = NULL;
  struct pollfd *poll_fds = NULL;
  size_t client_count = 0;
  size_t client_capacity = 0;
  size_t poll_capacity = 0;
  size_t client_scan_cursor = 0;
  pm_buffer last_listener_signature;
  time_t next_poll = time(NULL) + 3;
  time_t last_io_at = 0;
  long long last_io_at_ms = 0;
  long long snapshot_dirty_since_ms = 0;
  time_t route_table_flush_retry_after = 0;
  int snapshot_dirty = 0;
  int route_tables_dirty = 0;

  pm_buffer_init(&last_listener_signature);

  while (pm_running) {
    size_t poll_count = client_count + 1;
    size_t polled_client_count = client_count;
    int ready;
    int handled_io = 0;
    int poll_timeout_ms = PM_EVENT_LOOP_DEFAULT_POLL_MS;
    size_t accepted_this_turn = 0;
    size_t clients_read_this_turn = 0;

    if (snapshot_dirty && snapshot_dirty_since_ms > 0) {
      long long now_ms = pm_monotonic_milliseconds();
      long long idle_due_at = last_io_at_ms > 0
        ? last_io_at_ms + PM_SNAPSHOT_BROADCAST_IDLE_MS
        : now_ms;
      long long max_due_at = snapshot_dirty_since_ms + PM_SNAPSHOT_BROADCAST_START_MAX_DELAY_MS;
      long long due_at = idle_due_at < max_due_at ? idle_due_at : max_due_at;
      long long remaining_ms = due_at - now_ms;

      if (remaining_ms < 0) {
        remaining_ms = 0;
      }
      if (remaining_ms < poll_timeout_ms) {
        poll_timeout_ms = (int)remaining_ms;
      }
    }

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
      /* One read can contain several newline-delimited requests. Their
       * remaining frames already live in userspace, so the kernel may no
       * longer report POLLIN; drain them on zero-wait round-robin turns. */
      if (pm_client_has_complete_frame(&clients[index])) {
        poll_timeout_ms = 0;
      }
    }

    ready = poll(poll_fds, (nfds_t)poll_count, poll_timeout_ms);
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
        if (accepted_this_turn >= PM_ACCEPT_BUDGET_PER_TURN ||
            (snapshot_dirty_since_ms > 0 &&
             pm_monotonic_milliseconds() - snapshot_dirty_since_ms >= PM_SNAPSHOT_BROADCAST_START_MAX_DELAY_MS)) {
          break;
        }
        int client_fd = accept(server_fd, NULL, NULL);
        if (client_fd < 0) {
          if (errno == EINTR) {
            continue;
          }
          break;
        }
        accepted_this_turn++;
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

    if (polled_client_count > 0) {
      size_t scan_start = client_scan_cursor % polled_client_count;
      size_t next_scan_cursor = scan_start;

      /* Keep poll-array indices stable for the whole turn. A disconnected
       * client is marked first and compacted afterward; otherwise memmove
       * would make revents belong to the wrong socket. The persistent cursor
       * ensures a >512-client burst cannot starve older low-index clients. */
      for (size_t offset = 0; offset < polled_client_count; offset++) {
        size_t index = (scan_start + offset) % polled_client_count;
        short revents = poll_fds[index + 1].revents;
        int buffered_frame;

        if (snapshot_dirty_since_ms > 0 &&
            pm_monotonic_milliseconds() - snapshot_dirty_since_ms >= PM_SNAPSHOT_BROADCAST_START_MAX_DELAY_MS) {
          break;
        }

        if (index >= client_count || clients[index].fd < 0) {
          continue;
        }

        buffered_frame = pm_client_has_complete_frame(&clients[index]);
        if ((revents & POLLIN) || buffered_frame) {
          long long request_started_ms;

          if (clients_read_this_turn >= PM_CLIENT_READ_BUDGET_PER_TURN) {
            /* Preserve both queued data and a simultaneous HUP. Level-triggered
             * polling (or the buffered-frame zero-wait path) resumes it next turn. */
            continue;
          }

          clients_read_this_turn++;
          handled_io = 1;
          next_scan_cursor = (index + 1) % polled_client_count;
          request_started_ms = pm_monotonic_milliseconds();
          if (pm_read_client(&clients[index], state, &snapshot_dirty, &route_tables_dirty) != 0) {
            /* Dispatch may have committed a mutation before its response write
             * discovered a dead client, so preserve the original fairness age. */
            if (snapshot_dirty && snapshot_dirty_since_ms == 0) {
              snapshot_dirty_since_ms = request_started_ms;
            }
            pm_disconnect_client(&clients[index]);
            continue;
          }
          if (snapshot_dirty) {
            long long now_ms = pm_monotonic_milliseconds();
            if (snapshot_dirty_since_ms == 0) {
              /* Include parsing/dispatch/response time in the first mutation's
               * fairness age; a slow response must not buy another full delay. */
              snapshot_dirty_since_ms = request_started_ms;
            }
            if (now_ms - snapshot_dirty_since_ms >= PM_SNAPSHOT_BROADCAST_START_MAX_DELAY_MS) {
              break;
            }
          }
        }

        /* Send-only hook registrations commonly report POLLIN and HUP
         * together. Consume their queued frame first and defer the close one
         * turn when needed, so an accepted registration is never discarded. */
        if ((revents & (POLLERR | POLLHUP | POLLNVAL)) &&
            !(revents & POLLIN) &&
            !buffered_frame) {
          pm_disconnect_client(&clients[index]);
        }
      }

      client_scan_cursor = next_scan_cursor;
      pm_compact_clients_preserving_cursor(clients, &client_count, &client_scan_cursor);
    }

    if (handled_io) {
      last_io_at = time(NULL);
      last_io_at_ms = pm_monotonic_milliseconds();
    }

    if (pm_state_reap_children(state)) {
      snapshot_dirty = 1;
      route_tables_dirty = 1;
    }

    if (snapshot_dirty && snapshot_dirty_since_ms == 0) {
      snapshot_dirty_since_ms = pm_monotonic_milliseconds();
    }

    if (snapshot_dirty && state->listener_cache_updated_at[0] == '\0') {
      time_t refresh_at = time(NULL) + 1;
      /* A mutation-invalidated cache is omitted from the fast event. Schedule
       * the accurate listener follow-up promptly once request traffic is idle. */
      if (next_poll > refresh_at) {
        next_poll = refresh_at;
      }
    }

    if (snapshot_dirty && !pm_has_event_clients(clients, client_count)) {
      snapshot_dirty = 0;
      snapshot_dirty_since_ms = 0;
    } else if (snapshot_dirty) {
      long long now_ms = pm_monotonic_milliseconds();
      int idle_due = last_io_at_ms == 0 || now_ms - last_io_at_ms >= PM_SNAPSHOT_BROADCAST_IDLE_MS;
      int max_delay_due = now_ms - snapshot_dirty_since_ms >= PM_SNAPSHOT_BROADCAST_START_MAX_DELAY_MS;

      /*
       * A quiet burst is coalesced for a few milliseconds. Sustained hook I/O
       * cannot postpone UI delivery past the fixed fairness deadline.
       */
      if (idle_due || max_delay_due) {
        if (pm_broadcast_snapshot(clients, client_count, state) == 0) {
          snapshot_dirty = 0;
          snapshot_dirty_since_ms = 0;
        }
        pm_compact_clients_preserving_cursor(clients, &client_count, &client_scan_cursor);
      }
    }

    /* UI state is memory-authoritative and latency-sensitive, so event fan-out
     * gets the due turn before synchronous filesystem publication. Compact hook
     * bursts still defer route files until idle/heartbeat without delaying
     * request responses or the sidebar. */
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

    if (snapshot_dirty && snapshot_dirty_since_ms == 0) {
      snapshot_dirty_since_ms = pm_monotonic_milliseconds();
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
  pm_agent_arguments arguments;
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

  if (pm_parse_agent_arguments(argc, argv, &arguments) != 0) {
    return 1;
  }

  if (arguments.lock_stale_mode) {
    return pm_lock_is_stale(arguments.stale_lock_path) ? 0 : 1;
  }
  if (arguments.probe_only) {
    return pm_probe_daemon(arguments.socket_path, arguments.agent_main_path) == 0 ? 0 : 1;
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

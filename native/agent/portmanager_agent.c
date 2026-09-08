#include "portmanager_agent.h"
#include "portmanager_agent_output.h"

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
#define PM_OUTPUT_CLIENT_BYTES_PER_TURN (64 * 1024)
#define PM_OUTPUT_BYTES_PER_TURN (256 * 1024)
#define PM_OUTPUT_TURN_MS 5
/* Sustained mutation storms get a fixed scheduling deadline; the separate
 * socket budget bounds fan-out without forcing large snapshots at >4Hz. */
#define PM_SNAPSHOT_BROADCAST_START_MAX_DELAY_MS \
  PM_SNAPSHOT_BROADCAST_MAX_DELAY_MS

/* Accepted mutations survive a send-only client's close; abandoned read-only
 * observations are canceled. Limits bound retained frames across all clients. */
typedef struct pm_pending_scan {
  struct pm_pending_scan *next;
  char *line;
  size_t bytes;
  int mutation;
  pm_scan_context *context;
} pm_pending_scan;
static size_t pm_pending_scan_count;
static size_t pm_pending_scan_bytes;

/* Delivery receipts retain request identity, never a pointer into the movable
 * client array. A respawn RPC must not report success for an unsent command. */
typedef struct pm_pending_control {
  struct pm_pending_control *next;
  pm_request request;
  pm_output_receipt *receipt;
} pm_pending_control;
static size_t pm_pending_control_count;

/* File receipts preserve accepted mutations independently of client lifetime.
 * Retained responses have their own count/byte budget, separate from sockets. */
typedef struct pm_pending_publication {
  struct pm_pending_publication *next;
  pm_request request;
  pm_publication_receipt *receipt;
  pm_buffer payload;
} pm_pending_publication;
static size_t pm_pending_publication_count;
static size_t pm_pending_publication_bytes;

typedef struct {
  int fd;
  int wants_events;
  int is_control;
  int control_pid;
  int read_closed;
  /* macOS reports HUP without POLLOUT after SHUT_WR; retry EAGAIN without spinning. */
  long long output_retry_after_ms;
  char *buffer;
  size_t length;
  size_t capacity;
  pm_pending_scan *pending_scans;
  /* Heap-stable: control registry references survive client array compaction. */
  pm_output_queue *output;
  pm_pending_control *pending_controls;
  size_t pending_control_count;
  pm_pending_publication *pending_publications;
  size_t pending_publication_count;
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
  pm_output_queue *output;
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

static void pm_control_registry_set(int pid, int fd, pm_output_queue *output, const char *network_id) {
  for (size_t index = 0; index < pm_control_entry_count; index++) {
    if (pm_control_entries[index].pid == pid) {
      pm_control_entries[index].fd = fd;
      pm_control_entries[index].output = output;
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
  pm_control_entries[pm_control_entry_count].output = output;
  snprintf(pm_control_entries[pm_control_entry_count].network_id, sizeof(pm_control_entries[pm_control_entry_count].network_id), "%s",
           network_id != NULL ? network_id : "");
  pm_control_entry_count++;
}

/* Only a same-network ancestor may receive a queued control push. */
static pm_output_queue *pm_control_registry_output_for_pid(int pid, const char *want_network_id) {
  for (size_t index = 0; index < pm_control_entry_count; index++) {
    if (pm_control_entries[index].pid == pid) {
      if (want_network_id == NULL || want_network_id[0] == '\0' ||
          strcmp(pm_control_entries[index].network_id, want_network_id) == 0) {
        return pm_control_entries[index].output;
      }
      return NULL;
    }
  }
  return NULL;
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

  if (fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) return -1;
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

static int pm_send_response(pm_client *client, const pm_request *request, int ok, const char *payload, const char *error) {
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
    result = pm_output_send(client->output, message.data, message.length, pm_monotonic_milliseconds());
  }

  pm_buffer_free(&message);
  return result;
}

static void pm_clear_client_controls(pm_client *client) {
  while (client->pending_controls != NULL) {
    pm_pending_control *pending = client->pending_controls;
    client->pending_controls = pending->next;
    pm_output_receipt_release(pending->receipt);
    free(pending);
    pm_pending_control_count--;
  }
  client->pending_control_count = 0;
}

/** A completed write wakes its RPC on the main loop; a failed/expired write
 * returns failure instead of acknowledging an action that was never delivered. */
static int pm_finish_client_controls(pm_client *client) {
  for (pm_pending_control **link = &client->pending_controls; *link != NULL; link = &(*link)->next) {
    pm_pending_control *pending = *link;
    int status = pm_output_receipt_status(pending->receipt);
    if (status == 0) continue;
    int result = pm_send_response(client, &pending->request, status > 0, NULL, "Control channel closed before command delivery.");
    *link = pending->next;
    pm_output_receipt_release(pending->receipt);
    free(pending);
    client->pending_control_count--;
    pm_pending_control_count--;
    return result;
  }
  return 0;
}

static void pm_free_pending_publication(pm_pending_publication *pending) {
  pm_pending_publication_count--;
  pm_pending_publication_bytes -= pending->payload.capacity;
  pm_publication_release(pending->receipt);
  pm_buffer_free(&pending->payload);
  free(pending);
}

static void pm_clear_client_publications(pm_client *client) {
  while (client->pending_publications != NULL) {
    pm_pending_publication *pending = client->pending_publications;
    client->pending_publications = pending->next;
    pm_free_pending_publication(pending);
  }
  client->pending_publication_count = 0;
}

static int pm_finish_client_publications(pm_client *client) {
  for (pm_pending_publication **link = &client->pending_publications; *link != NULL; link = &(*link)->next) {
    pm_pending_publication *pending = *link;
    int status = pm_publication_status(pending->receipt);
    if (status == 0) continue;
    const char *response = pm_publication_response(pending->receipt);
    int result = pm_send_response(client, &pending->request, status > 0,
      response == NULL ? pending->payload.data : response,
      "Failed to publish Port Manager state within the file publication budget.");
    *link = pending->next;
    client->pending_publication_count--;
    pm_free_pending_publication(pending);
    return result;
  }
  return 0;
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

/** One shared snapshot enters each subscriber's FIFO without waiting for any
 * reader. The poll loop drains partial frames alongside ordinary responses. */
static int pm_broadcast_snapshot(pm_client *clients, size_t client_count, pm_agent_state *state) {
  pm_buffer message;
  pm_buffer_init(&message);
  if (pm_build_snapshot_event(state, &message) != 0) { pm_buffer_free(&message); return -1; }
  pm_output_message *shared = pm_output_message_create(message.data, message.length);
  pm_buffer_free(&message);
  if (shared == NULL) {
    /* An over-budget frame cannot be delivered. Release subscriptions instead
     * of retrying serialization in a tight loop ahead of DNS/control reads. */
    for (size_t index = 0; index < client_count; index++) {
      if (clients[index].wants_events) pm_disconnect_client(&clients[index]);
    }
    return 0;
  }
  long long now = pm_monotonic_milliseconds();
  for (size_t index = 0; index < client_count; index++) {
    if (clients[index].fd >= 0 && clients[index].wants_events &&
        pm_output_enqueue(clients[index].output, shared, 1, now) != 0) {
      pm_disconnect_client(&clients[index]);
    }
  }
  pm_output_message_release(shared);
  return 0;
}

/** Shutdown may finish already queued replies, bounded by their original deadlines. */
static int pm_has_client_output(pm_client *clients, size_t count) {
  for (size_t index = 0; index < count; index++) {
    if (pm_output_pending(clients[index].output)) return 1;
  }
  return 0;
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
  if (strcmp(request->method, "repairRoutingState") == 0) {
    *state_changed = 1;
    if (pm_state_repair_routing(state, payload) != 0) {
      snprintf(error, error_size, "Failed to repair routing from a fresh listener scan.");
      return -1;
    }
    return 0;
  }
  if (strcmp(request->method, "flushRouteTables") == 0) {
    if (pm_state_flush_route_tables(state) != 0) {
      snprintf(error, error_size, "Failed to publish Port Manager route tables.");
      return -1;
    }
    return pm_buffer_append(payload, "true");
  }
  if (strcmp(request->method, "syncBrowserDns") == 0) {
    if (pm_dns_sync(state, request->payload, payload) != 0) {
      snprintf(error, error_size, "Failed to apply Port Manager browser DNS records.");
      return -1;
    }
    return 0;
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
    unsigned long before_revision = state->registration_revision;
    size_t before_pending = state->pending_count;
    int result = pm_state_register_process(state, &input, payload);
    *state_changed = state->registration_revision != before_revision || state->pending_count != before_pending;
    return result;
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

static int pm_handle_ready_line(pm_client *client, pm_agent_state *state, const char *line, int *snapshot_dirty) {
  pm_request request;
  pm_buffer payload;
  char error[PM_TEXT] = "Port Manager native daemon request failed.";
  int state_changed = 0;
  int shutdown_requested = 0;

  memset(&request, 0, sizeof(request));
  pm_buffer_init(&payload);
  if (pm_parse_request(line, &request) != 0) {
    snprintf(request.id_raw, sizeof(request.id_raw), "\"unknown\"");
    int send_result = pm_send_response(client, &request, 0, NULL, "Invalid Port Manager agent request message.");
    pm_buffer_free(&payload);
    return send_result;
  }

  if (client->fd >= 0 && pm_request_wants_events(&request) && !client->wants_events) {
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
      pm_control_registry_set(pid, client->fd, client->output, network_id);
    }
    int send_result = pm_send_response(client, &request, 1, NULL, NULL);
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
    pm_output_queue *target_output = NULL;

    parent_pids[0] = '\0';
    target_network_id[0] = '\0';
    pm_json_get_string(request.payload == NULL ? "" : request.payload, "parentPids", parent_pids, sizeof(parent_pids));
    pm_json_get_string(request.payload == NULL ? "" : request.payload, "networkId", target_network_id, sizeof(target_network_id));
    {
      char *saveptr = NULL;
      char *token = strtok_r(parent_pids, ",", &saveptr);
      while (token != NULL && target_output == NULL) {
        int candidate = atoi(token);
        if (candidate > 0) {
          /* Same-network ancestors only: never route across network scope. */
          target_output = pm_control_registry_output_for_pid(candidate, target_network_id);
        }
        token = strtok_r(NULL, ",", &saveptr);
      }
    }

    pm_pending_control *pending = NULL;
    if (target_output != NULL && client->pending_control_count < 128 && pm_pending_control_count < 1024) {
      pending = calloc(1, sizeof(*pending));
    }

    if (pending != NULL) {
      char *line = (char *)malloc(PM_CLIENT_BUFFER_MAX);
      if (line != NULL) {
        if (pm_json_get_string(request.payload == NULL ? "" : request.payload, "line", line, PM_CLIENT_BUFFER_MAX) == 0) {
          size_t length = strlen(line);
          if (length + 1 < PM_CLIENT_BUFFER_MAX) {
            line[length] = '\n';
            line[length + 1] = '\0';
            length++;
          }
          pending->receipt = pm_output_send_tracked(target_output, line, length, pm_monotonic_milliseconds());
        }
        free(line);
      }
    }

    if (pending != NULL && pending->receipt != NULL) {
      pending->request = request;
      pending->request.payload = NULL;
      pending->next = client->pending_controls;
      client->pending_controls = pending;
      client->pending_control_count++;
      pm_pending_control_count++;
      pm_buffer_free(&payload);
      return 0;
    } else {
      free(pending);
      int send_result = pm_send_response(client, &request, 0, NULL, "No control channel for the requested parent pid.");
      pm_buffer_free(&payload);
      return send_result;
    }
  }

  int may_publish = strcmp(request.method, "flushRouteTables") == 0 ||
    strcmp(request.method, "repairRoutingState") == 0 ||
    strcmp(request.method, "syncBrowserDns") == 0 || strcmp(request.method, "allocateRoute") == 0;
  pm_pending_publication *pending = NULL;
  if (may_publish && client->fd >= 0) {
    if (client->pending_publication_count < 128 && pm_pending_publication_count < 1024 &&
        pm_pending_publication_bytes < 8 * 1024 * 1024) pending = calloc(1, sizeof(*pending));
    if (pending == NULL) return pm_send_response(client, &request, 0, NULL, "File publication request queue is full.");
  }
  unsigned long before_revision = state->route_dirty_revision;
  int dispatched = pm_dispatch(state, &request, &payload, &state_changed, &shutdown_requested, error, sizeof(error));
  pm_publication_receipt *receipt = state->request_publication;
  state->request_publication = NULL;
  if (state_changed) {
    *snapshot_dirty = 1;
    /* Domain paths which queued a captured snapshot already advanced the
     * revision. Never advance it twice or clear it for an older repair. */
    if (before_revision == state->route_dirty_revision) pm_mark_route_tables_dirty(state);
  }
  int send_result = 0;
  if (dispatched != 0) {
    send_result = pm_send_response(client, &request, 0, NULL, error);
  } else if (receipt != NULL && client->fd >= 0) {
    if (pending == NULL || payload.capacity > 8 * 1024 * 1024 - pm_pending_publication_bytes) {
      send_result = pm_send_response(client, &request, 0, NULL, "File publication response queue is full.");
    } else {
      pending->request = request;
      pending->request.payload = NULL;
      pending->receipt = receipt;
      receipt = NULL;
      pending->payload = payload;
      memset(&payload, 0, sizeof(payload));
      pending->next = client->pending_publications;
      client->pending_publications = pending;
      client->pending_publication_count++;
      pm_pending_publication_count++;
      pm_pending_publication_bytes += pending->payload.capacity;
      pending = NULL;
    }
  } else if (client->fd >= 0) {
    send_result = pm_send_response(client, &request, 1, payload.data, NULL);
  }
  if (shutdown_requested) pm_running = 0;
  pm_publication_release(receipt);
  free(pending);
  pm_buffer_free(&payload);
  return send_result;
}

/** Release references without a blocking wait; the broker reaps canceled jobs. */
static void pm_free_pending_scan(pm_pending_scan *pending) {
  pm_pending_scan_count--;
  pm_pending_scan_bytes -= pending->bytes;
  pm_scan_context_free(pending->context);
  free(pending->line);
  free(pending);
}

static void pm_clear_client_scans(pm_client *client, int keep_mutations) {
  pm_pending_scan **link = &client->pending_scans;
  while (*link != NULL) {
    pm_pending_scan *pending = *link;
    if (keep_mutations && pending->mutation) { link = &pending->next; continue; }
    *link = pending->next;
    pm_free_pending_scan(pending);
  }
}

/** Preflight may defer one request while the same socket continues processing
 * DNS/status/control frames. Replies remain correlated by their NDJSON id. */
static int pm_handle_line(pm_client *client, pm_agent_state *state, const char *line, int *snapshot_dirty) {
  pm_request request;
  memset(&request, 0, sizeof(request));
  if (pm_parse_request(line, &request) != 0) return pm_handle_ready_line(client, state, line, snapshot_dirty);
  int snapshot = strcmp(request.method, "listSnapshot") == 0 || strcmp(request.method, "refreshSnapshot") == 0;
  int mutation = strcmp(request.method, "repairRoutingState") == 0 || strcmp(request.method, "allocateRoute") == 0 ||
                 strcmp(request.method, "releaseProcessRoute") == 0;
  if (!snapshot && !mutation) return pm_handle_ready_line(client, state, line, snapshot_dirty);
  if (pm_request_wants_events(&request) && !client->wants_events) {
    client->wants_events = 1;
    *snapshot_dirty = 1;
  }
  pm_scan_context *context = pm_scan_context_create();
  int prepared = context == NULL ? -1 : pm_state_prepare_request(state, &request, context);
  if (prepared > 0) {
    size_t bytes = strlen(line) + 1;
    if (pm_pending_scan_count >= 1024 || pm_pending_scan_bytes + bytes > 8 * 1024 * 1024) prepared = -1;
    else {
      pm_pending_scan *pending = calloc(1, sizeof(*pending));
      if (pending != NULL) pending->line = strdup(line);
      if (pending == NULL || pending->line == NULL) { free(pending); prepared = -1; }
      else {
        pending->bytes = bytes;
        pending->mutation = mutation;
        pending->context = context;
        pm_pending_scan **tail = &client->pending_scans;
        while (*tail != NULL) tail = &(*tail)->next;
        *tail = pending;
        pm_pending_scan_count++;
        pm_pending_scan_bytes += bytes;
        return 0;
      }
    }
  }
  int result;
  if (prepared < 0) result = pm_send_response(client, &request, 0, NULL, "Could not prepare a fresh listener scan within the request budget.");
  else {
    pm_scan_use(context);
    result = pm_handle_ready_line(client, state, line, snapshot_dirty);
    pm_scan_use(NULL);
  }
  pm_scan_context_free(context);
  return result;
}

/** Complete observations on the control thread, using current registry state.
 * No client-array index or process pointer crosses the external wait. */
static int pm_finish_client_scans(pm_client *client, pm_agent_state *state, int *snapshot_dirty) {
  pm_pending_scan **link = &client->pending_scans;
  size_t completed = 0;
  while (*link != NULL && completed < 1) {
    pm_pending_scan *pending = *link;
    pm_request request;
    memset(&request, 0, sizeof(request));
    int prepared = pm_parse_request(pending->line, &request) == 0
      ? pm_state_prepare_request(state, &request, pending->context) : -1;
    if (prepared > 0) { link = &pending->next; continue; }
    int result = 0;
    if (prepared < 0) {
      if (client->fd >= 0) result = pm_send_response(client, &request, 0, NULL, "Could not prepare a fresh listener scan within the request budget.");
    } else {
      pm_scan_use(pending->context);
      result = pm_handle_ready_line(client, state, pending->line, snapshot_dirty);
      pm_scan_use(NULL);
    }
    *link = pending->next;
    pm_free_pending_scan(pending);
    completed++;
    if (client->fd >= 0 && result != 0) return -1;
  }
  return 0;
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

  pm_output_queue *output = pm_output_create(fd);
  if (output == NULL) return -1;
  (*clients)[*count].output = output;
  (*clients)[*count].fd = fd;
  (*clients)[*count].wants_events = 0;
  (*clients)[*count].is_control = 0;
  (*clients)[*count].control_pid = 0;
  (*clients)[*count].read_closed = 0;
  (*clients)[*count].output_retry_after_ms = 0;
  (*clients)[*count].buffer = NULL;
  (*clients)[*count].length = 0;
  (*clients)[*count].capacity = 0;
  (*clients)[*count].pending_scans = NULL;
  (*clients)[*count].pending_controls = NULL;
  (*clients)[*count].pending_control_count = 0;
  (*clients)[*count].pending_publications = NULL;
  (*clients)[*count].pending_publication_count = 0;
  (*count)++;
  return 0;
}

static void pm_remove_client(pm_client *clients, size_t *count, size_t index) {
  if (clients[index].fd >= 0) {
    pm_control_registry_remove_fd(clients[index].fd);
    close(clients[index].fd);
  }
  pm_output_free(clients[index].output);
  pm_clear_client_controls(&clients[index]);
  pm_clear_client_publications(&clients[index]);
  free(clients[index].buffer);
  pm_clear_client_scans(&clients[index], 0);
  memmove(&clients[index], &clients[index + 1], (*count - index - 1) * sizeof(pm_client));
  (*count)--;
}

/** Closes one client without shifting the poll-indexed array mid-turn. */
static void pm_disconnect_client(pm_client *client) {
  if (client->fd >= 0) {
    pm_control_registry_remove_fd(client->fd);
    close(client->fd);
  }
  pm_output_disconnect(client->output);
  pm_clear_client_controls(client);
  pm_clear_client_publications(client);
  client->fd = -1;
  client->wants_events = 0;
  pm_clear_client_scans(client, 1);
}

/** Preserve both scheduling positions by fd across removal/reallocation. */
static int pm_cursor_fd(pm_client *clients, size_t count, size_t cursor) {
  for (size_t offset = 0; offset < count; offset++) {
    size_t index = (cursor + offset) % count;
    if (clients[index].fd >= 0) return clients[index].fd;
  }
  return -1;
}

static void pm_compact_clients_preserving_cursor(pm_client *clients, size_t *count, size_t *scan_cursor, size_t *output_cursor) {
  int next_read_fd = pm_cursor_fd(clients, *count, *scan_cursor);
  int next_output_fd = pm_cursor_fd(clients, *count, *output_cursor);
  for (size_t reverse = *count; reverse > 0;) {
    size_t index = --reverse;
    if (clients[index].fd < 0 && clients[index].pending_scans == NULL) pm_remove_client(clients, count, index);
  }
  *scan_cursor = *output_cursor = 0;
  for (size_t index = 0; index < *count; index++) {
    if (clients[index].fd == next_read_fd) *scan_cursor = index;
    if (clients[index].fd == next_output_fd) *output_cursor = index;
  }
}

/** Output has its own cursor and aggregate work budget. A POLLOUT storm never
 * consumes the request-read budget or polls synchronously on a slow reader. */
static void pm_flush_clients(pm_client *clients, size_t count, struct pollfd *fds, size_t *cursor) {
  size_t bytes = 0;
  long long deadline = pm_monotonic_milliseconds() + PM_OUTPUT_TURN_MS;
  size_t start = count == 0 ? 0 : *cursor % count;
  for (size_t offset = 0; offset < count; offset++) {
    size_t index = (start + offset) % count;
    *cursor = (index + 1) % count;
    if (clients[index].fd < 0) continue;
    short events = fds[index + 1].revents;
    if ((events & POLLOUT) || (clients[index].read_closed && (events & POLLHUP))) {
      size_t budget = PM_OUTPUT_BYTES_PER_TURN - bytes;
      if (budget > PM_OUTPUT_CLIENT_BYTES_PER_TURN) budget = PM_OUTPUT_CLIENT_BYTES_PER_TURN;
      long written = pm_output_flush(clients[index].output, budget);
      if (written < 0) pm_disconnect_client(&clients[index]);
      else {
        bytes += (size_t)written;
        clients[index].output_retry_after_ms = written == 0 ? pm_monotonic_milliseconds() + 20 : 0;
      }
    }
    if (!pm_running && (events & (POLLERR | POLLHUP | POLLNVAL))) {
      if (send(clients[index].fd, "", 0, 0) < 0) pm_disconnect_client(&clients[index]);
      else clients[index].read_closed = 1;
    }
    if (bytes >= PM_OUTPUT_BYTES_PER_TURN || pm_monotonic_milliseconds() >= deadline) break;
  }
}

static int pm_client_has_complete_frame(const pm_client *client) {
  return client->length > 0 && memchr(client->buffer, '\n', client->length) != NULL;
}

static int pm_process_client_buffer(
  pm_client *client,
  pm_agent_state *state,
  int *snapshot_dirty,
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
      if (pm_handle_line(client, state, line, snapshot_dirty) != 0) {
        return -1;
      }
    }
  }

  return 0;
}

static int pm_read_client(pm_client *client, pm_agent_state *state, int *snapshot_dirty) {
  if (pm_client_has_complete_frame(client)) {
    return pm_process_client_buffer(client, state, snapshot_dirty, 1);
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
      /* A request writer may half-close while still reading a large response.
       * HUP alone cannot distinguish SHUT_WR from close on macOS. A zero-byte
       * send probes the peer's read side without adding any protocol bytes. */
      if (send(client->fd, "", 0, 0) < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return -1;
      client->read_closed = 1;
      return 0;
    }

    client->length += (size_t)bytes_read;
    client->buffer[client->length] = '\0';
    /* poll() is level-triggered, so one bounded read per turn preserves
     * throughput without letting a pipelined client monopolize the daemon. */
    return pm_process_client_buffer(client, state, snapshot_dirty, 1);
  }
}

static void pm_event_loop(int server_fd, pm_agent_state *state) {
  pm_client *clients = NULL;
  struct pollfd *poll_fds = NULL;
  size_t client_count = 0;
  size_t client_capacity = 0;
  size_t poll_capacity = 0;
  size_t client_scan_cursor = 0;
  size_t client_output_cursor = 0;
  pm_buffer last_listener_signature;
  time_t next_poll = time(NULL) + 3;
  time_t last_io_at = 0;
  long long last_io_at_ms = 0;
  long long snapshot_dirty_since_ms = 0;
  int snapshot_dirty = 0;
  pm_scan_context *background_scan = NULL;

  pm_buffer_init(&last_listener_signature);

  while (pm_running || pm_has_client_output(clients, client_count) || pm_pending_control_count > 0 || pm_pending_publication_count > 0) {
    size_t poll_count = client_count + 1;
    size_t polled_client_count = client_count;
    int ready;
    int handled_io = 0;
    int poll_timeout_ms = PM_EVENT_LOOP_DEFAULT_POLL_MS;
    size_t accepted_this_turn = 0;
    size_t clients_read_this_turn = 0;

    /* DNS answers and blocking file operations each own their worker. Only
     * lifecycle changes and immutable publication completions run here. */
    pm_dns_maybe_rebind(state, time(NULL));
    if (pm_running) {
      int route_wait = pm_state_schedule_route_publication(state, last_io_at_ms);
      if (route_wait < poll_timeout_ms) poll_timeout_ms = route_wait;
    }
    if ((pm_state_poll_publications(state) || pm_pending_publication_count > 0) && poll_timeout_ms > 20) poll_timeout_ms = 20;

    /* Commands run as bounded subprocesses. Only active captures need the
     * short poll cadence; an idle daemon keeps its existing wakeup policy. */
    if (pm_scan_poll() || pm_pending_scan_count > 0 || pm_pending_control_count > 0) poll_timeout_ms = 20;
    if (client_count > 0) {
      size_t start = client_scan_cursor % client_count;
      size_t completed = 0;
      long long deadline = pm_monotonic_milliseconds() + 5;
      /* A completed scan can wake many readers. Bound result application too,
       * so a shared capture does not turn into a long burst ahead of DNS RPCs. */
      for (size_t offset = 0; offset < client_count; offset++) {
        size_t index = (start + offset) % client_count;
        size_t before = pm_pending_scan_count + pm_pending_control_count + pm_pending_publication_count;
        if (pm_finish_client_controls(&clients[index]) != 0 ||
            pm_finish_client_publications(&clients[index]) != 0 ||
            (pm_running && pm_finish_client_scans(&clients[index], state, &snapshot_dirty) != 0)) {
          pm_disconnect_client(&clients[index]);
        }
        if (pm_pending_scan_count + pm_pending_control_count + pm_pending_publication_count < before) completed++;
        client_scan_cursor = (index + 1) % client_count;
        if (completed >= 8 || pm_monotonic_milliseconds() >= deadline) break;
      }
    }

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
    poll_fds[0].fd = pm_running ? server_fd : -1;
    poll_fds[0].events = POLLIN;
    for (size_t index = 0; index < client_count; index++) {
      int remaining = pm_output_remaining_ms(clients[index].output, pm_monotonic_milliseconds());
      if (clients[index].fd >= 0 && clients[index].read_closed && send(clients[index].fd, "", 0, 0) < 0 &&
          errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) pm_disconnect_client(&clients[index]);
      if (clients[index].read_closed && clients[index].pending_scans == NULL && clients[index].pending_controls == NULL &&
          clients[index].pending_publications == NULL &&
          !pm_output_pending(clients[index].output)) {
        pm_disconnect_client(&clients[index]);
      } else if (remaining == 0) {
        pm_dev_log("agent-output", "disconnect stalled fd=%d", clients[index].fd);
        pm_disconnect_client(&clients[index]);
      } else if (remaining > 0 && remaining < poll_timeout_ms) poll_timeout_ms = remaining;
      poll_fds[index + 1].fd = clients[index].fd;
      if (clients[index].read_closed) {
        long long retry_ms = clients[index].output_retry_after_ms - pm_monotonic_milliseconds();
        if (!pm_output_pending(clients[index].output) || retry_ms > 0) poll_fds[index + 1].fd = -1;
        if (retry_ms > 0 && retry_ms < poll_timeout_ms) poll_timeout_ms = (int)retry_ms;
      }
      poll_fds[index + 1].events = (pm_running && !clients[index].read_closed ? POLLIN : 0) |
        (pm_output_pending(clients[index].output) ? POLLOUT : 0);
      /* One read can contain several newline-delimited requests. Their
       * remaining frames already live in userspace, so the kernel may no
       * longer report POLLIN; drain them on zero-wait round-robin turns. */
      if (pm_running && clients[index].fd >= 0 && pm_client_has_complete_frame(&clients[index])) {
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

    pm_flush_clients(clients, polled_client_count, poll_fds, &client_output_cursor);
    if (!pm_running) {
      pm_compact_clients_preserving_cursor(clients, &client_count, &client_scan_cursor, &client_output_cursor);
      continue;
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
        if (((revents & POLLIN) && !clients[index].read_closed) || buffered_frame) {
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
          if (pm_read_client(&clients[index], state, &snapshot_dirty) != 0) {
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
            !clients[index].read_closed && !(revents & POLLIN) &&
            !buffered_frame) {
          pm_disconnect_client(&clients[index]);
        }
      }

      client_scan_cursor = next_scan_cursor;
      pm_compact_clients_preserving_cursor(clients, &client_count, &client_scan_cursor, &client_output_cursor);
    }

    if (handled_io) {
      last_io_at = time(NULL);
      last_io_at_ms = pm_monotonic_milliseconds();
    }

    if (pm_state_reap_children(state)) {
      snapshot_dirty = 1;
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
        pm_compact_clients_preserving_cursor(clients, &client_count, &client_scan_cursor, &client_output_cursor);
      }
    }

    /* Hand off due snapshots after this turn's mutations; callbacks and file
     * writes remain separate so status/control traffic cannot delay commits. */
    pm_state_schedule_route_publication(state, last_io_at_ms);

    if (time(NULL) >= next_poll) {
      time_t now = time(NULL);
      if (handled_io || (last_io_at > 0 && now - last_io_at < PM_LISTENER_POLL_IDLE_GRACE_SECONDS) || !pm_has_event_clients(clients, client_count)) {
        next_poll = now + 1;
      } else {
        pm_buffer signature;
        pm_buffer_init(&signature);
        pm_request request;
        memset(&request, 0, sizeof(request));
        snprintf(request.method, sizeof(request.method), "listSnapshot");
        if (background_scan == NULL) background_scan = pm_scan_context_create();
        int prepared = background_scan == NULL ? -1 : pm_state_prepare_request(state, &request, background_scan);
        pm_scan_use(background_scan);
        if (prepared == 0 && pm_state_listener_signature(state, &signature) == 0) {
          if (last_listener_signature.data == NULL || strcmp(last_listener_signature.data, signature.data == NULL ? "" : signature.data) != 0) {
            pm_buffer_free(&last_listener_signature);
            last_listener_signature = signature;
            memset(&signature, 0, sizeof(signature));
            snapshot_dirty = 1;
          }
        }
        pm_scan_use(NULL);
        pm_buffer_free(&signature);
        if (prepared > 0) next_poll = now;
        else {
          pm_scan_context_free(background_scan);
          background_scan = NULL;
          next_poll = now + (prepared < 0 ? 1 : PM_LISTENER_POLL_INTERVAL_SECONDS);
        }
      }
    }

    if (snapshot_dirty && snapshot_dirty_since_ms == 0) {
      snapshot_dirty_since_ms = pm_monotonic_milliseconds();
    }

  }

  for (size_t index = 0; index < client_count; index++) {
    if (clients[index].fd >= 0) close(clients[index].fd);
    pm_output_free(clients[index].output);
    pm_clear_client_controls(&clients[index]);
  pm_clear_client_publications(&clients[index]);
    free(clients[index].buffer);
    pm_clear_client_scans(&clients[index], 0);
  }
  free(poll_fds);
  free(clients);
  pm_buffer_free(&last_listener_signature);
  pm_scan_context_free(background_scan);
  pm_scan_dispose();
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
  pm_dns_init(&state, arguments.dns_port);
  pm_event_loop(server_fd, &state);
  pm_dns_dispose(&state);
  pm_state_dispose(&state);
  close(server_fd);
  unlink(arguments.socket_path);
  return 0;
}

#include "portmanager_agent.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define PM_PROCESS_INSPECT_TEXT 65536
#define PM_ROUTE_TABLE_WRITE_LOCK_STALE_SECONDS 30
#define PM_ROUTE_TABLE_WRITE_LOCK_ATTEMPTS 100
#define PM_ROUTE_TABLE_WRITE_LOCK_SLEEP_US 10000
#define PM_ROUTE_TABLE_TTL_SECONDS_ENV "PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS"
#define PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS 30

typedef struct {
  pm_route *items;
  size_t count;
  size_t capacity;
} pm_route_list;

typedef struct {
  pm_listener *items;
  size_t count;
  size_t capacity;
} pm_listener_list;

static int pm_scan_lsof(pm_listener_list *listeners, const char *updated_at);
static int pm_scan_lsof_cached(pm_agent_state *state, pm_listener_list *listeners, char *updated_at, size_t updated_at_size, int *fresh_scan);
static int pm_listener_cache_store(pm_agent_state *state, const pm_listener_list *listeners, const char *updated_at, time_t now);
static void pm_listener_cache_invalidate(pm_agent_state *state);
static int pm_state_needs_external_listener_fresh_scan(pm_agent_state *state);
static int pm_find_listener_for_port_host(int port, const char *host, pm_listener *out);
static const char *pm_listener_route_host(const pm_listener *listener, const char *fallback_host, char *buffer, size_t size);
static void pm_remove_pending_endpoint(pm_agent_state *state, int logical_port, const char *network_id);
static int pm_listener_is_tracked(pm_agent_state *state, const pm_listener *listener);
static int pm_write_route_tables(pm_agent_state *state);

static void pm_copy(char *target, size_t size, const char *value) {
  if (size == 0) {
    return;
  }

  snprintf(target, size, "%s", value == NULL ? "" : value);
}

static long pm_epoch_milliseconds(void) {
  struct timeval now;

  if (gettimeofday(&now, NULL) != 0) {
    return (long)time(NULL) * 1000L;
  }

  return (long)(now.tv_sec * 1000L + now.tv_usec / 1000L);
}

static int pm_text_empty(const char *value) {
  return value == NULL || value[0] == '\0';
}

static int pm_route_table_ttl_seconds(void) {
  const char *value = getenv(PM_ROUTE_TABLE_TTL_SECONDS_ENV);
  char *end = NULL;
  long parsed;

  if (value == NULL || value[0] == '\0') {
    return PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS;
  }

  parsed = strtol(value, &end, 10);
  if (end == value || *end != '\0') {
    return PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS;
  }
  if (parsed < 5) {
    return 5;
  }
  if (parsed > 3600) {
    return 3600;
  }

  return (int)parsed;
}

static int pm_route_table_refresh_margin_seconds(void) {
  int ttl_seconds = pm_route_table_ttl_seconds();
  int margin_seconds = ttl_seconds / 2;

  if (margin_seconds < 1) {
    margin_seconds = 1;
  }
  if (margin_seconds > 10) {
    margin_seconds = 10;
  }

  return margin_seconds;
}

static void pm_normalize_network(const char *value, char *out, size_t out_size) {
  const char *start = value == NULL ? "" : value;
  const char *end;

  while (*start != '\0' && isspace((unsigned char)*start)) {
    start++;
  }

  end = start + strlen(start);
  while (end > start && isspace((unsigned char)*(end - 1))) {
    end--;
  }

  if ((size_t)(end - start) >= out_size) {
    end = start + out_size - 1;
  }

  if (out_size > 0) {
    memcpy(out, start, (size_t)(end - start));
    out[end - start] = '\0';
  }
}

void pm_iso_now(char *buffer, size_t size) {
  time_t now = time(NULL);
  struct tm parts;

  gmtime_r(&now, &parts);
  strftime(buffer, size, "%Y-%m-%dT%H:%M:%SZ", &parts);
}

static int pm_reserve_processes(pm_agent_state *state, size_t count) {
  pm_process *next;
  size_t capacity;

  if (count <= state->process_capacity) {
    return 0;
  }

  capacity = state->process_capacity == 0 ? 16 : state->process_capacity;
  while (capacity < count) {
    capacity *= 2;
  }

  next = (pm_process *)realloc(state->processes, capacity * sizeof(pm_process));
  if (next == NULL) {
    return -1;
  }

  state->processes = next;
  state->process_capacity = capacity;
  return 0;
}

static int pm_reserve_pending(pm_agent_state *state, size_t count) {
  pm_pending_route *next;
  size_t capacity;

  if (count <= state->pending_capacity) {
    return 0;
  }

  capacity = state->pending_capacity == 0 ? 16 : state->pending_capacity;
  while (capacity < count) {
    capacity *= 2;
  }

  next = (pm_pending_route *)realloc(state->pending_routes, capacity * sizeof(pm_pending_route));
  if (next == NULL) {
    return -1;
  }

  state->pending_routes = next;
  state->pending_capacity = capacity;
  return 0;
}

static int pm_reserve_bidirectional_refreshes(pm_agent_state *state, size_t count) {
  pm_bidirectional_route_refresh *next;
  size_t capacity;

  if (count <= state->bidirectional_refresh_capacity) {
    return 0;
  }

  capacity = state->bidirectional_refresh_capacity == 0 ? 16 : state->bidirectional_refresh_capacity;
  while (capacity < count) {
    capacity *= 2;
  }

  next = (pm_bidirectional_route_refresh *)realloc(state->bidirectional_refreshes, capacity * sizeof(pm_bidirectional_route_refresh));
  if (next == NULL) {
    return -1;
  }

  state->bidirectional_refreshes = next;
  state->bidirectional_refresh_capacity = capacity;
  return 0;
}

static int pm_reserve_routes(pm_route_list *routes, size_t count) {
  pm_route *next;
  size_t capacity;

  if (count <= routes->capacity) {
    return 0;
  }

  capacity = routes->capacity == 0 ? 16 : routes->capacity;
  while (capacity < count) {
    capacity *= 2;
  }

  next = (pm_route *)realloc(routes->items, capacity * sizeof(pm_route));
  if (next == NULL) {
    return -1;
  }

  routes->items = next;
  routes->capacity = capacity;
  return 0;
}

static int pm_reserve_listeners(pm_listener_list *listeners, size_t count) {
  pm_listener *next;
  size_t capacity;

  if (count <= listeners->capacity) {
    return 0;
  }

  capacity = listeners->capacity == 0 ? 32 : listeners->capacity;
  while (capacity < count) {
    capacity *= 2;
  }

  next = (pm_listener *)realloc(listeners->items, capacity * sizeof(pm_listener));
  if (next == NULL) {
    return -1;
  }

  listeners->items = next;
  listeners->capacity = capacity;
  return 0;
}

static int pm_string_array_contains(char **items, size_t count, const char *value) {
  for (size_t index = 0; index < count; index++) {
    if (strcmp(items[index], value) == 0) {
      return 1;
    }
  }

  return 0;
}

static int pm_string_array_add(char ***items, size_t *count, size_t *capacity, const char *value) {
  char **next_items;
  char *copy;
  size_t next_capacity;

  if (pm_string_array_contains(*items, *count, value)) {
    return 0;
  }

  if (*count + 1 > *capacity) {
    next_capacity = *capacity == 0 ? 16 : *capacity * 2;
    next_items = (char **)realloc(*items, next_capacity * sizeof(char *));
    if (next_items == NULL) {
      return -1;
    }
    *items = next_items;
    *capacity = next_capacity;
  }

  copy = strdup(value);
  if (copy == NULL) {
    return -1;
  }

  (*items)[(*count)++] = copy;
  return 0;
}

static int pm_string_array_append(char ***items, size_t *count, size_t *capacity, const char *value) {
  char **next_items;
  size_t next_capacity;
  char *copy;

  if (*count + 1 > *capacity) {
    next_capacity = *capacity == 0 ? 16 : *capacity * 2;
    next_items = (char **)realloc(*items, next_capacity * sizeof(char *));
    if (next_items == NULL) {
      return -1;
    }
    *items = next_items;
    *capacity = next_capacity;
  }

  copy = strdup(value);
  if (copy == NULL) {
    return -1;
  }

  (*items)[(*count)++] = copy;
  return 0;
}

static void pm_string_array_clear(char ***items, size_t *count, size_t *capacity) {
  for (size_t index = 0; index < *count; index++) {
    free((*items)[index]);
  }

  free(*items);
  *items = NULL;
  *count = 0;
  *capacity = 0;
}

static int pm_reserve_route_table_signatures(pm_agent_state *state, size_t count) {
  char **next_paths;
  char **next_signatures;
  size_t capacity;

  if (count <= state->route_table_signature_capacity) {
    return 0;
  }

  capacity = state->route_table_signature_capacity == 0 ? 16 : state->route_table_signature_capacity;
  while (capacity < count) {
    capacity *= 2;
  }

  next_paths = (char **)malloc(capacity * sizeof(char *));
  next_signatures = (char **)malloc(capacity * sizeof(char *));
  if (next_paths == NULL || next_signatures == NULL) {
    free(next_paths);
    free(next_signatures);
    return -1;
  }

  for (size_t index = 0; index < state->route_table_signature_count; index++) {
    next_paths[index] = state->route_table_signature_paths[index];
    next_signatures[index] = state->route_table_signatures[index];
  }
  free(state->route_table_signature_paths);
  free(state->route_table_signatures);
  state->route_table_signature_paths = next_paths;
  state->route_table_signatures = next_signatures;
  state->route_table_signature_capacity = capacity;
  return 0;
}

static int pm_route_table_signature_index(const pm_agent_state *state, const char *file_path) {
  for (size_t index = 0; index < state->route_table_signature_count; index++) {
    if (strcmp(state->route_table_signature_paths[index], file_path) == 0) {
      return (int)index;
    }
  }

  return -1;
}

static const char *pm_route_table_signature_for_path(const pm_agent_state *state, const char *file_path) {
  int index = pm_route_table_signature_index(state, file_path);

  if (index < 0) {
    return NULL;
  }

  return state->route_table_signatures[index];
}

static int pm_remember_route_table_signature(pm_agent_state *state, const char *file_path, const char *signature) {
  int index = pm_route_table_signature_index(state, file_path);
  char *signature_copy;

  signature_copy = strdup(signature == NULL ? "" : signature);
  if (signature_copy == NULL) {
    return -1;
  }

  if (index >= 0) {
    free(state->route_table_signatures[index]);
    state->route_table_signatures[index] = signature_copy;
    return 0;
  }

  if (pm_reserve_route_table_signatures(state, state->route_table_signature_count + 1) != 0) {
    free(signature_copy);
    return -1;
  }

  state->route_table_signature_paths[state->route_table_signature_count] = strdup(file_path);
  if (state->route_table_signature_paths[state->route_table_signature_count] == NULL) {
    free(signature_copy);
    return -1;
  }
  state->route_table_signatures[state->route_table_signature_count] = signature_copy;
  state->route_table_signature_count++;
  return 0;
}

static void pm_forget_route_table_signature(pm_agent_state *state, const char *file_path) {
  int found = pm_route_table_signature_index(state, file_path);
  size_t index;

  if (found < 0) {
    return;
  }

  index = (size_t)found;
  free(state->route_table_signature_paths[index]);
  free(state->route_table_signatures[index]);
  memmove(
    &state->route_table_signature_paths[index],
    &state->route_table_signature_paths[index + 1],
    (state->route_table_signature_count - index - 1) * sizeof(char *));
  memmove(
    &state->route_table_signatures[index],
    &state->route_table_signatures[index + 1],
    (state->route_table_signature_count - index - 1) * sizeof(char *));
  state->route_table_signature_count--;
}

static void pm_route_table_signatures_clear(pm_agent_state *state) {
  for (size_t index = 0; index < state->route_table_signature_count; index++) {
    free(state->route_table_signature_paths[index]);
    free(state->route_table_signatures[index]);
  }

  free(state->route_table_signature_paths);
  free(state->route_table_signatures);
  state->route_table_signature_paths = NULL;
  state->route_table_signatures = NULL;
  state->route_table_signature_count = 0;
  state->route_table_signature_capacity = 0;
}

static void pm_default_route_table_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_ROUTES_FILE");

  if (configured != NULL && configured[0] != '\0') {
    pm_copy(buffer, size, configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-routes-%ld.json", (long)getuid());
}

static int pm_has_suffix(const char *value, const char *suffix) {
  size_t value_length;
  size_t suffix_length;

  if (value == NULL || suffix == NULL) {
    return 0;
  }

  value_length = strlen(value);
  suffix_length = strlen(suffix);
  if (suffix_length > value_length) {
    return 0;
  }

  return strcmp(value + value_length - suffix_length, suffix) == 0;
}

static void pm_adopt_previous_generation_route_files(pm_agent_state *state) {
  const char *slash;
  const char *name;
  const char *dot;
  DIR *directory_handle;
  struct dirent *entry;
  char directory[PM_TEXT];
  char stem[PM_TEXT];
  char extension[PM_SMALL];
  size_t stem_length;
  size_t extension_length;
  const char *route_table_path = state->route_table_path;

  if (pm_text_empty(route_table_path)) {
    return;
  }

  slash = strrchr(route_table_path, '/');
  name = slash == NULL ? route_table_path : slash + 1;
  dot = strrchr(name, '.');

  if (slash == NULL) {
    pm_copy(directory, sizeof(directory), ".");
  } else if (slash == route_table_path) {
    pm_copy(directory, sizeof(directory), "/");
  } else {
    size_t directory_length = (size_t)(slash - route_table_path);
    if (directory_length >= sizeof(directory)) {
      directory_length = sizeof(directory) - 1;
    }
    memcpy(directory, route_table_path, directory_length);
    directory[directory_length] = '\0';
  }

  if (dot == NULL) {
    pm_copy(stem, sizeof(stem), name);
    pm_copy(extension, sizeof(extension), ".json");
  } else {
    size_t prefix_length = (size_t)(dot - name);
    if (prefix_length >= sizeof(stem)) {
      prefix_length = sizeof(stem) - 1;
    }
    memcpy(stem, name, prefix_length);
    stem[prefix_length] = '\0';
    pm_copy(extension, sizeof(extension), dot);
  }

  if (stem[0] == '\0' || extension[0] == '\0') {
    return;
  }

  directory_handle = opendir(directory);
  if (directory_handle == NULL) {
    return;
  }

  stem_length = strlen(stem);
  extension_length = strlen(extension);
  while ((entry = readdir(directory_handle)) != NULL) {
    char file_path[PM_TEXT];
    char scoped_name[PM_TEXT];
    size_t file_name_length;
    size_t scoped_length;
    int written;

    if (strncmp(entry->d_name, stem, stem_length) != 0 || entry->d_name[stem_length] != '-' ||
        !pm_has_suffix(entry->d_name, extension)) {
      continue;
    }

    /*
     * Scoped route tables and per-port endpoint files are generation-local, but
     * a fresh daemon does not know which ones the previous generation wrote.
     * Adopt them into the normal cleanup sets so the first route-table write
     * publishes empty network tables and removes stale endpoint files.
     */
    if (strcmp(directory, "/") == 0) {
      written = snprintf(file_path, sizeof(file_path), "/%s", entry->d_name);
    } else {
      written = snprintf(file_path, sizeof(file_path), "%s/%s", directory, entry->d_name);
    }
    if (written < 0 || (size_t)written >= sizeof(file_path)) {
      continue;
    }

    file_name_length = strlen(entry->d_name);
    if (file_name_length <= stem_length + 1 + extension_length) {
      continue;
    }
    scoped_length = file_name_length - stem_length - 1 - extension_length;
    if (scoped_length >= sizeof(scoped_name)) {
      scoped_length = sizeof(scoped_name) - 1;
    }
    memcpy(scoped_name, entry->d_name + stem_length + 1, scoped_length);
    scoped_name[scoped_length] = '\0';

    if (strncmp(scoped_name, "compose-claim-port-", strlen("compose-claim-port-")) == 0) {
      pm_string_array_add(
        &state->written_claim_paths,
        &state->written_claim_count,
        &state->written_claim_capacity,
        file_path);
    } else if (strstr(scoped_name, "-port-") != NULL) {
      pm_string_array_add(
        &state->written_entry_paths,
        &state->written_entry_count,
        &state->written_entry_capacity,
        file_path);
    } else if (scoped_name[0] != '\0') {
      pm_string_array_add(
        &state->written_network_ids,
        &state->written_network_count,
        &state->written_network_capacity,
        scoped_name);
    }
  }

  closedir(directory_handle);
}

void pm_state_init(pm_agent_state *state, const char *route_table_path, const char *agent_main_path) {
  memset(state, 0, sizeof(*state));
  if (!pm_text_empty(route_table_path)) {
    pm_copy(state->route_table_path, sizeof(state->route_table_path), route_table_path);
  } else {
    pm_default_route_table_path(state->route_table_path, sizeof(state->route_table_path));
  }
  pm_adopt_previous_generation_route_files(state);
  pm_copy(state->agent_main_path, sizeof(state->agent_main_path), agent_main_path);
  pm_iso_now(state->started_at, sizeof(state->started_at));
  state->route_table_writer_started_ms = pm_epoch_milliseconds();
  snprintf(
    state->route_table_writer_id,
    sizeof(state->route_table_writer_id),
    "native-agent:%ld:%ld",
    (long)getpid(),
    state->route_table_writer_started_ms);
  state->next_process_id = 1;
  state->next_allocation_id = 1;
  state->agent_pid = getpid();
  pm_write_route_tables(state);
}

void pm_state_dispose(pm_agent_state *state) {
  free(state->processes);
  free(state->pending_routes);
  free(state->bidirectional_refreshes);
  pm_string_array_clear(&state->suppressed_detected_ids, &state->suppressed_count, &state->suppressed_capacity);
  pm_string_array_clear(&state->written_network_ids, &state->written_network_count, &state->written_network_capacity);
  pm_string_array_clear(&state->written_entry_paths, &state->written_entry_count, &state->written_entry_capacity);
  pm_string_array_clear(&state->written_claim_paths, &state->written_claim_count, &state->written_claim_capacity);
  pm_route_table_signatures_clear(state);
  free(state->listener_cache_items);
  memset(state, 0, sizeof(*state));
}

static void pm_route_identity(const pm_route *route, char *buffer, size_t size) {
  snprintf(buffer, size, "%s:%d:%s", route->network_id, route->logical_port, route->route_direction);
}

static void pm_endpoint_identity(int logical_port, const char *network_id, char *buffer, size_t size) {
  snprintf(buffer, size, "%s:%d", network_id == NULL ? "" : network_id, logical_port);
}

static void pm_prune_bidirectional_refreshes(pm_agent_state *state, time_t now) {
  size_t write_index = 0;

  for (size_t read_index = 0; read_index < state->bidirectional_refresh_count; read_index++) {
    if (state->bidirectional_refreshes[read_index].refresh_until > now) {
      if (write_index != read_index) {
        state->bidirectional_refreshes[write_index] = state->bidirectional_refreshes[read_index];
      }
      write_index++;
    }
  }

  state->bidirectional_refresh_count = write_index;
}

static int pm_mark_bidirectional_route_observed(pm_agent_state *state, int logical_port, const char *network_id) {
  const char *normalized_network_id = network_id == NULL ? "" : network_id;
  time_t refresh_until = time(NULL) + pm_route_table_ttl_seconds();

  pm_prune_bidirectional_refreshes(state, time(NULL));
  for (size_t index = 0; index < state->bidirectional_refresh_count; index++) {
    pm_bidirectional_route_refresh *refresh = &state->bidirectional_refreshes[index];
    if (refresh->logical_port == logical_port && strcmp(refresh->network_id, normalized_network_id) == 0) {
      refresh->refresh_until = refresh_until;
      return 0;
    }
  }

  if (pm_reserve_bidirectional_refreshes(state, state->bidirectional_refresh_count + 1) != 0) {
    return -1;
  }

  state->bidirectional_refreshes[state->bidirectional_refresh_count].logical_port = logical_port;
  pm_copy(
    state->bidirectional_refreshes[state->bidirectional_refresh_count].network_id,
    sizeof(state->bidirectional_refreshes[state->bidirectional_refresh_count].network_id),
    normalized_network_id);
  state->bidirectional_refreshes[state->bidirectional_refresh_count].refresh_until = refresh_until;
  state->bidirectional_refresh_count++;
  return 0;
}

static int pm_route_recently_bidirectional(pm_agent_state *state, const pm_route *route, time_t now) {
  const char *network_id = route->network_id[0] == '\0' ? "" : route->network_id;

  pm_prune_bidirectional_refreshes(state, now);
  for (size_t index = 0; index < state->bidirectional_refresh_count; index++) {
    pm_bidirectional_route_refresh *refresh = &state->bidirectional_refreshes[index];
    if (refresh->logical_port == route->logical_port && strcmp(refresh->network_id, network_id) == 0) {
      return refresh->refresh_until > now;
    }
  }

  return 0;
}

static int pm_routes_can_refresh_unchanged_table(pm_agent_state *state, const pm_route *routes, size_t count) {
  time_t now = time(NULL);

  if (count == 0) {
    return 0;
  }

  for (size_t index = 0; index < count; index++) {
    if (strcmp(routes[index].status, "running") == 0 || strcmp(routes[index].source, "compose") == 0) {
      continue;
    }
    if (!pm_route_recently_bidirectional(state, &routes[index], now)) {
      return 0;
    }
  }

  return 1;
}

static int pm_route_list_add_dedupe(pm_route_list *routes, const pm_route *route) {
  char identity[PM_TEXT];
  char candidate[PM_TEXT];

  pm_route_identity(route, identity, sizeof(identity));
  for (size_t index = 0; index < routes->count; index++) {
    pm_route_identity(&routes->items[index], candidate, sizeof(candidate));
    if (strcmp(identity, candidate) == 0) {
      memmove(&routes->items[index], &routes->items[index + 1], (routes->count - index - 1) * sizeof(pm_route));
      routes->count--;
      break;
    }
  }

  if (pm_reserve_routes(routes, routes->count + 1) != 0) {
    return -1;
  }

  routes->items[routes->count++] = *route;
  return 0;
}

static int pm_route_list_append(pm_route_list *routes, const pm_route *route) {
  if (pm_reserve_routes(routes, routes->count + 1) != 0) {
    return -1;
  }

  routes->items[routes->count++] = *route;
  return 0;
}

static void pm_process_to_route(const pm_process *process, pm_route *route) {
  memset(route, 0, sizeof(*route));
  route->logical_port = process->requested_port;
  route->actual_port = process->actual_port;
  pm_copy(route->route_direction, sizeof(route->route_direction), "listen");
  pm_copy(route->host, sizeof(route->host), process->host[0] ? process->host : "localhost");
  pm_copy(route->cwd, sizeof(route->cwd), process->cwd);
  pm_copy(route->network_id, sizeof(route->network_id), process->network_id);
  pm_copy(route->process_id, sizeof(route->process_id), process->id);
  pm_copy(route->process_name, sizeof(route->process_name), process->name);
  pm_copy(route->status, sizeof(route->status), process->status);
  pm_copy(route->source, sizeof(route->source), process->source[0] ? process->source : "managed");
}

static int pm_build_routes(pm_agent_state *state, const pm_route *extra, pm_route_list *routes) {
  memset(routes, 0, sizeof(*routes));

  for (size_t index = 0; index < state->pending_count; index++) {
    if (pm_route_list_append(routes, &state->pending_routes[index].route) != 0) {
      return -1;
    }
  }

  if (extra != NULL && pm_route_list_add_dedupe(routes, extra) != 0) {
    return -1;
  }

  for (size_t index = 0; index < state->process_count; index++) {
    pm_route route;
    pm_process *process = &state->processes[index];

    if (strcmp(process->status, "running") != 0 || strcmp(process->source, "detected") == 0) {
      continue;
    }

    pm_process_to_route(process, &route);
    if (pm_route_list_add_dedupe(routes, &route) != 0) {
      return -1;
    }
  }

  return 0;
}

static int pm_append_route_json(pm_buffer *buffer, const pm_route *route) {
  if (pm_buffer_appendf(buffer, "{\"logicalPort\":%d,\"actualPort\":%d,\"routeDirection\":", route->logical_port, route->actual_port) != 0 ||
      pm_json_append_string(buffer, route->route_direction) != 0 ||
      pm_buffer_append(buffer, ",\"host\":") != 0 ||
      pm_json_append_string(buffer, route->host) != 0) {
    return -1;
  }

  if (route->cwd[0] != '\0' && (pm_buffer_append(buffer, ",\"cwd\":") != 0 || pm_json_append_string(buffer, route->cwd) != 0)) {
    return -1;
  }
  if (route->network_id[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"networkId\":") != 0 || pm_json_append_string(buffer, route->network_id) != 0)) {
    return -1;
  }
  if (route->process_id[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"processId\":") != 0 || pm_json_append_string(buffer, route->process_id) != 0)) {
    return -1;
  }
  if (route->process_name[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"processName\":") != 0 || pm_json_append_string(buffer, route->process_name) != 0)) {
    return -1;
  }

  return pm_buffer_append(buffer, ",\"status\":") ||
         pm_json_append_string(buffer, route->status) ||
         pm_buffer_append(buffer, ",\"source\":") ||
         pm_json_append_string(buffer, route->source) ||
         pm_buffer_append_char(buffer, '}');
}

static int pm_append_routes_json(pm_buffer *buffer, const pm_route *routes, size_t count) {
  if (pm_buffer_append_char(buffer, '[') != 0) {
    return -1;
  }

  for (size_t index = 0; index < count; index++) {
    if (index > 0 && pm_buffer_append_char(buffer, ',') != 0) {
      return -1;
    }
    if (pm_append_route_json(buffer, &routes[index]) != 0) {
      return -1;
    }
  }

  return pm_buffer_append_char(buffer, ']');
}

static int pm_append_process_json(pm_buffer *buffer, const pm_process *process) {
  if (pm_buffer_append(buffer, "{\"id\":") != 0 ||
      pm_json_append_string(buffer, process->id) != 0 ||
      pm_buffer_appendf(buffer, ",\"pid\":%ld,\"name\":", (long)process->pid) != 0 ||
      pm_json_append_string(buffer, process->name) != 0 ||
      pm_buffer_append(buffer, ",\"command\":") != 0 ||
      pm_json_append_string(buffer, process->command) != 0 ||
      pm_buffer_append(buffer, ",\"cwd\":") != 0 ||
      pm_json_append_string(buffer, process->cwd) != 0) {
    return -1;
  }

  if (process->network_id[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"networkId\":") != 0 || pm_json_append_string(buffer, process->network_id) != 0)) {
    return -1;
  }

  if (pm_buffer_appendf(buffer, ",\"requestedPort\":%d,\"actualPort\":%d,\"status\":", process->requested_port, process->actual_port) != 0 ||
      pm_json_append_string(buffer, process->status) != 0 ||
      pm_buffer_append(buffer, ",\"startedAt\":") != 0 ||
      pm_json_append_string(buffer, process->started_at) != 0) {
    return -1;
  }

  if (process->stopped_at[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"stoppedAt\":") != 0 || pm_json_append_string(buffer, process->stopped_at) != 0)) {
    return -1;
  }
  if (process->url[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"url\":") != 0 || pm_json_append_string(buffer, process->url) != 0)) {
    return -1;
  }
  if (process->error_message[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"errorMessage\":") != 0 || pm_json_append_string(buffer, process->error_message) != 0)) {
    return -1;
  }
  if (process->source[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"source\":") != 0 || pm_json_append_string(buffer, process->source) != 0)) {
    return -1;
  }

  return pm_buffer_append_char(buffer, '}');
}

static void pm_url(char *buffer, size_t size, const char *host, int port) {
  snprintf(buffer, size, "http://%s:%d", host == NULL || host[0] == '\0' ? "localhost" : host, port);
}

static unsigned int pm_hash_text(const char *value) {
  unsigned int hash = 0x811c9dc5u;

  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
    hash ^= *cursor;
    hash *= 0x01000193u;
  }

  return hash;
}

static int pm_is_valid_port(int port) {
  return port >= 1 && port <= 65535;
}

static int pm_bind_available(int port, const char *host) {
  struct addrinfo hints;
  struct addrinfo *result = NULL;
  char service[16];
  int available = 0;

  if (!pm_is_valid_port(port)) {
    return 0;
  }

  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  snprintf(service, sizeof(service), "%d", port);

  if (getaddrinfo(pm_text_empty(host) || strcmp(host, "localhost") == 0 ? "127.0.0.1" : host, service, &hints, &result) != 0) {
    return 0;
  }

  for (struct addrinfo *cursor = result; cursor != NULL; cursor = cursor->ai_next) {
    int fd = socket(cursor->ai_family, cursor->ai_socktype, cursor->ai_protocol);
    if (fd < 0) {
      continue;
    }

    if (bind(fd, cursor->ai_addr, cursor->ai_addrlen) == 0) {
      available = 1;
      close(fd);
      break;
    }

    close(fd);
  }

  freeaddrinfo(result);
  return available;
}

static int pm_actual_port_reserved(pm_agent_state *state, int port) {
  for (size_t index = 0; index < state->pending_count; index++) {
    if (state->pending_routes[index].route.actual_port == port) {
      return 1;
    }
  }

  for (size_t index = 0; index < state->process_count; index++) {
    pm_process *process = &state->processes[index];
    if (strcmp(process->status, "running") == 0 && strcmp(process->source, "detected") != 0 && process->actual_port == port) {
      return 1;
    }
  }

  return 0;
}

static int pm_port_available(pm_agent_state *state, int port, const char *host) {
  return !pm_actual_port_reserved(state, port) && pm_bind_available(port, host);
}

static int pm_route_nearest(pm_agent_state *state, const pm_allocate_input *input) {
  if (pm_port_available(state, input->requested_port, input->host)) {
    return input->requested_port;
  }

  for (int offset = 1; offset <= input->scan_range; offset++) {
    int up = input->requested_port + offset;
    int down = input->requested_port - offset;

    if ((strcmp(input->scan_direction, "up") == 0 || strcmp(input->scan_direction, "both") == 0) &&
        pm_is_valid_port(up) &&
        pm_port_available(state, up, input->host)) {
      return up;
    }

    if ((strcmp(input->scan_direction, "down") == 0 || strcmp(input->scan_direction, "both") == 0) &&
        pm_is_valid_port(down) &&
        pm_port_available(state, down, input->host)) {
      return down;
    }
  }

  return 0;
}

static int pm_route_hashed(pm_agent_state *state, const pm_allocate_input *input) {
  char scope[PM_TEXT + PM_SMALL];
  char hash_input[PM_TEXT + PM_SMALL + 32];
  int start = input->virtual_start <= 0 ? PM_DEFAULT_VIRTUAL_START : input->virtual_start;
  int end = input->virtual_end <= 0 ? PM_DEFAULT_VIRTUAL_END : input->virtual_end;
  int range_size;
  int max_candidates;
  unsigned int start_offset;

  if (!pm_is_valid_port(start) || !pm_is_valid_port(end) || start > end) {
    return 0;
  }

  pm_copy(scope, sizeof(scope), input->network_id[0] ? input->network_id : input->cwd);
  snprintf(hash_input, sizeof(hash_input), "%s:%d", scope, input->requested_port);
  range_size = end - start + 1;
  max_candidates = input->scan_range + 1;
  if (max_candidates > range_size) {
    max_candidates = range_size;
  }
  start_offset = pm_hash_text(hash_input) % (unsigned int)range_size;

  for (int offset = 0; offset < max_candidates; offset++) {
    int candidate = start + (int)((start_offset + (unsigned int)offset) % (unsigned int)range_size);
    if (pm_port_available(state, candidate, input->host)) {
      return candidate;
    }
  }

  return 0;
}

static int pm_listener_list_has_port(const pm_listener_list *listeners, int port) {
  for (size_t index = 0; listeners != NULL && index < listeners->count; index++) {
    if (listeners->items[index].port == port) {
      return 1;
    }
  }

  return 0;
}

static int pm_process_is_external_listener_owned(const pm_process *process) {
  return process != NULL &&
    (strcmp(process->source, "registered") == 0 ||
     strcmp(process->source, "hooked") == 0 ||
     strcmp(process->source, "compose") == 0);
}

static void pm_normalize_endpoint_host_key(const char *host, char *out, size_t out_size) {
  const char *start = host == NULL ? "" : host;
  const char *end;
  size_t length;

  while (*start != '\0' && isspace((unsigned char)*start)) {
    start++;
  }

  end = start + strlen(start);
  while (end > start && isspace((unsigned char)*(end - 1))) {
    end--;
  }

  if (end > start && *start == '[' && *(end - 1) == ']') {
    start++;
    end--;
  }

  length = (size_t)(end - start);
  if (
    length == 0 ||
    (length == 1 && strncmp(start, "*", 1) == 0) ||
    (length == 7 && strncasecmp(start, "0.0.0.0", 7) == 0) ||
    (length == 2 && strncmp(start, "::", 2) == 0)
  ) {
    pm_copy(out, out_size, "*");
    return;
  }

  if (length == 9 && strncasecmp(start, "localhost", 9) == 0) {
    pm_copy(out, out_size, "127.0.0.1");
    return;
  }

  if (length >= out_size) {
    length = out_size - 1;
  }
  for (size_t index = 0; index < length; index++) {
    out[index] = (char)tolower((unsigned char)start[index]);
  }
  out[length] = '\0';
}

static int pm_is_non_default_loopback_host(const char *host) {
  struct in_addr address;
  uint32_t ip;

  if (inet_pton(AF_INET, host, &address) != 1) {
    return 0;
  }

  ip = ntohl(address.s_addr);
  return (ip >> 24) == 127 && ip != 0x7f000001u;
}

static int pm_endpoint_hosts_match(const char *listener_host, const char *route_host) {
  char normalized_listener[PM_SMALL];
  char normalized_route[PM_SMALL];

  pm_normalize_endpoint_host_key(listener_host, normalized_listener, sizeof(normalized_listener));
  pm_normalize_endpoint_host_key(route_host, normalized_route, sizeof(normalized_route));

  if (pm_is_non_default_loopback_host(normalized_route)) {
    return strcmp(normalized_listener, normalized_route) == 0;
  }

  if (strcmp(normalized_listener, "*") == 0 || strcmp(normalized_route, "*") == 0) {
    return 1;
  }

  if (
    (strcmp(normalized_route, "127.0.0.1") == 0 && strcmp(normalized_listener, "::1") == 0) ||
    (strcmp(normalized_route, "::1") == 0 && strcmp(normalized_listener, "127.0.0.1") == 0)
  ) {
    return 1;
  }

  return strcmp(normalized_listener, normalized_route) == 0;
}

static int pm_parse_lsof_tcp_endpoint(const char *value, char *host, size_t host_size, int *port) {
  const char *start = value == NULL ? "" : value;
  const char *end;
  const char *colon;
  size_t host_length;
  char port_text[16];
  size_t port_length;

  while (*start != '\0' && isspace((unsigned char)*start)) {
    start++;
  }
  if (strncmp(start, "TCP ", 4) == 0) {
    start += 4;
  }
  end = start + strlen(start);
  while (end > start && isspace((unsigned char)*(end - 1))) {
    end--;
  }

  colon = end;
  while (colon > start && *colon != ':') {
    colon--;
  }
  if (colon <= start || colon + 1 >= end) {
    return -1;
  }

  port_length = (size_t)(end - colon - 1);
  if (port_length == 0 || port_length >= sizeof(port_text)) {
    return -1;
  }
  memcpy(port_text, colon + 1, port_length);
  port_text[port_length] = '\0';
  *port = atoi(port_text);
  if (!pm_is_valid_port(*port)) {
    return -1;
  }

  host_length = (size_t)(colon - start);
  if (host_length > 1 && start[0] == '[' && start[host_length - 1] == ']') {
    start++;
    host_length -= 2;
  }
  if (host_length >= host_size) {
    host_length = host_size - 1;
  }
  memcpy(host, start, host_length);
  host[host_length] = '\0';
  return 0;
}

static int pm_established_line_matches_route(const char *line, const pm_route *route) {
  char endpoint[PM_TEXT];
  char *state_marker;
  char *arrow;
  char local_host[PM_SMALL];
  char remote_host[PM_SMALL];
  int local_port;
  int remote_port;

  if (line == NULL || route == NULL || strcmp(route->source, "compose") == 0) {
    return 0;
  }

  pm_copy(endpoint, sizeof(endpoint), line);
  state_marker = strstr(endpoint, " (");
  if (state_marker != NULL) {
    *state_marker = '\0';
  }
  arrow = strstr(endpoint, "->");
  if (arrow == NULL) {
    return 0;
  }
  *arrow = '\0';
  arrow += 2;

  if (pm_parse_lsof_tcp_endpoint(endpoint, local_host, sizeof(local_host), &local_port) != 0 ||
      pm_parse_lsof_tcp_endpoint(arrow, remote_host, sizeof(remote_host), &remote_port) != 0) {
    return 0;
  }

  return (local_port == route->actual_port && pm_endpoint_hosts_match(local_host, route->host)) ||
    (remote_port == route->actual_port && pm_endpoint_hosts_match(remote_host, route->host));
}

static void pm_refresh_established_route_observations(pm_agent_state *state) {
  pm_route_list routes = {0};
  FILE *pipe;
  char line[2048];

  if (pm_build_routes(state, NULL, &routes) != 0 || routes.count == 0) {
    free(routes.items);
    return;
  }

  pipe = popen("lsof -nP -iTCP -sTCP:ESTABLISHED -Fn 2>/dev/null", "r");
  if (pipe == NULL) {
    free(routes.items);
    return;
  }

  while (fgets(line, sizeof(line), pipe) != NULL) {
    size_t length = strlen(line);
    while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) {
      line[--length] = '\0';
    }
    if (length == 0 || line[0] != 'n') {
      continue;
    }

    for (size_t index = 0; index < routes.count; index++) {
      if (pm_established_line_matches_route(line + 1, &routes.items[index])) {
        pm_mark_bidirectional_route_observed(state, routes.items[index].logical_port, routes.items[index].network_id);
      }
    }
  }

  pclose(pipe);
  free(routes.items);
}

static const pm_listener *pm_find_listener_by_process_pid_endpoint(const pm_listener_list *listeners, const pm_process *process) {
  for (size_t index = 0; listeners != NULL && index < listeners->count; index++) {
    if (
      listeners->items[index].pid == process->pid &&
      listeners->items[index].port == process->actual_port &&
      pm_endpoint_hosts_match(listeners->items[index].local_address, process->host)
    ) {
      return &listeners->items[index];
    }
  }

  return NULL;
}

static const pm_listener *pm_find_listener_by_process_endpoint(const pm_listener_list *listeners, const pm_process *process) {
  const pm_listener *fallback = NULL;

  for (size_t index = 0; listeners != NULL && index < listeners->count; index++) {
    if (
      listeners->items[index].port != process->actual_port ||
      !pm_endpoint_hosts_match(listeners->items[index].local_address, process->host)
    ) {
      continue;
    }

    if (listeners->items[index].pid > 0) {
      return &listeners->items[index];
    }

    fallback = &listeners->items[index];
  }

  return fallback;
}

static void pm_clear_missing_listener_state(pm_process *process) {
  process->missing_listener_since = 0;
  process->missing_listener_count = 0;
}

static int pm_adopt_listener_owner(pm_process *process, const pm_listener *listener) {
  int changed = 0;

  if (listener == NULL) {
    return 0;
  }

  if (listener->pid > 0 && process->pid != listener->pid) {
    process->pid = listener->pid;
    changed = 1;
  }
  if (listener->process_name[0] != '\0' && strcmp(process->name, listener->process_name) != 0) {
    pm_copy(process->name, sizeof(process->name), listener->process_name);
    changed = 1;
  }
  if (listener->command[0] != '\0' && strcmp(process->command, listener->command) != 0) {
    pm_copy(process->command, sizeof(process->command), listener->command);
    changed = 1;
  }

  pm_clear_missing_listener_state(process);
  return changed;
}

static void pm_trim_process_text(char *text) {
  size_t length;

  if (text == NULL) {
    return;
  }

  length = strlen(text);
  while (length > 0 && isspace((unsigned char)text[length - 1])) {
    text[--length] = '\0';
  }
}

static int pm_read_process_text(pid_t pid, const char *command_template, char *out, size_t out_size) {
  char command[PM_TEXT];
  char line[4096];
  FILE *pipe;
  size_t used = 0;

  if (out == NULL || out_size == 0 || pid <= 0) {
    return 0;
  }

  out[0] = '\0';
  snprintf(command, sizeof(command), command_template, (long)pid);
  pipe = popen(command, "r");
  if (pipe == NULL) {
    return 0;
  }

  while (fgets(line, sizeof(line), pipe) != NULL && used + 1 < out_size) {
    size_t line_length = strlen(line);
    if (line_length > out_size - used - 1) {
      line_length = out_size - used - 1;
    }
    memcpy(out + used, line, line_length);
    used += line_length;
    out[used] = '\0';
  }

  pclose(pipe);
  pm_trim_process_text(out);
  return out[0] != '\0';
}

static int pm_read_process_environment_text(pid_t pid, char *out, size_t out_size) {
  return pm_read_process_text(pid, "ps eww -p %ld 2>/dev/null", out, out_size);
}

static int pm_read_process_command_text(pid_t pid, char *out, size_t out_size) {
  return pm_read_process_text(pid, "ps -o command= -p %ld 2>/dev/null", out, out_size);
}

static int pm_process_text_value(const char *text, const char *name, char *out, size_t out_size) {
  size_t name_length;
  const char *cursor;

  if (text == NULL || name == NULL || out == NULL || out_size == 0) {
    return 0;
  }

  name_length = strlen(name);
  cursor = text;
  while ((cursor = strstr(cursor, name)) != NULL) {
    const char *value_start;
    const char *value_end;
    size_t value_length;

    if ((cursor == text || isspace((unsigned char)*(cursor - 1))) && cursor[name_length] == '=') {
      value_start = cursor + name_length + 1;
      value_end = value_start;
      while (*value_end != '\0' && !isspace((unsigned char)*value_end)) {
        value_end++;
      }

      value_length = (size_t)(value_end - value_start);
      if (value_length > 0) {
        if (value_length >= out_size) {
          value_length = out_size - 1;
        }
        memcpy(out, value_start, value_length);
        out[value_length] = '\0';
        return 1;
      }
    }

    cursor += name_length;
  }

  return 0;
}

static int pm_process_text_has_any_value(const char *text, const char *const *names, size_t count) {
  char value[PM_SMALL];

  for (size_t index = 0; index < count; index++) {
    if (pm_process_text_value(text, names[index], value, sizeof(value))) {
      return 1;
    }
  }

  return 0;
}

static int pm_process_text_first_value(const char *text, const char *const *names, size_t count, char *out, size_t out_size) {
  for (size_t index = 0; index < count; index++) {
    if (pm_process_text_value(text, names[index], out, out_size)) {
      return 1;
    }
  }

  return 0;
}

static int pm_parse_port_token(const char *value, int actual_port) {
  const char *cursor;
  long port = 0;
  int digits = 0;

  if (value == NULL || value[0] == '\0') {
    return 0;
  }

  cursor = strrchr(value, ':');
  cursor = cursor == NULL ? value : cursor + 1;
  if (!isdigit((unsigned char)*cursor)) {
    return 0;
  }

  while (isdigit((unsigned char)*cursor) && digits < 6) {
    port = port * 10 + (*cursor - '0');
    cursor++;
    digits++;
  }

  if (digits == 0 || (*cursor != '\0' && *cursor != '/') || !pm_is_valid_port((int)port) || (int)port == actual_port) {
    return 0;
  }

  return (int)port;
}

static int pm_infer_requested_port_from_environment(const char *environment, int actual_port) {
  static const char *const port_variables[] = {
    "VITE_CLIENT_PORT",
    "PORT",
    "SERVER_PORT",
    "DEV_SERVER_PORT",
    "HTTP_PORT",
  };
  char value[PM_SMALL];

  for (size_t index = 0; index < sizeof(port_variables) / sizeof(port_variables[0]); index++) {
    if (pm_process_text_value(environment, port_variables[index], value, sizeof(value))) {
      int port = pm_parse_port_token(value, actual_port);
      if (port > 0) {
        return port;
      }
    }
  }

  return 0;
}

static int pm_token_matches_any(const char *token, const char *const *values, size_t count) {
  for (size_t index = 0; index < count; index++) {
    if (strcmp(token, values[index]) == 0) {
      return 1;
    }
  }

  return 0;
}

static int pm_token_has_prefix_port(const char *token, const char *prefix, int actual_port) {
  size_t prefix_length = strlen(prefix);

  if (strncmp(token, prefix, prefix_length) != 0) {
    return 0;
  }

  return pm_parse_port_token(token + prefix_length, actual_port);
}

static int pm_infer_requested_port_from_command(const char *command, int actual_port) {
  static const char *const port_flags[] = {
    "--port",
    "--listen-port",
    "--http-port",
    "--server-port",
    "-p",
  };
  static const char *const server_commands[] = {
    "runserver",
    "serve",
    "http.server",
  };
  char copy[PM_TEXT];
  char *save = NULL;
  char *token;
  int next_token_is_port = 0;

  if (command == NULL || command[0] == '\0') {
    return 0;
  }

  pm_copy(copy, sizeof(copy), command);
  for (token = strtok_r(copy, " \t\r\n", &save); token != NULL; token = strtok_r(NULL, " \t\r\n", &save)) {
    int port;

    if (next_token_is_port) {
      port = pm_parse_port_token(token, actual_port);
      if (port > 0) {
        return port;
      }
      next_token_is_port = 0;
    }

    port = pm_token_has_prefix_port(token, "--port=", actual_port);
    if (port <= 0) {
      port = pm_token_has_prefix_port(token, "--listen-port=", actual_port);
    }
    if (port <= 0) {
      port = pm_token_has_prefix_port(token, "--http-port=", actual_port);
    }
    if (port <= 0) {
      port = pm_token_has_prefix_port(token, "--server-port=", actual_port);
    }
    if (port > 0) {
      return port;
    }

    if (pm_token_matches_any(token, port_flags, sizeof(port_flags) / sizeof(port_flags[0])) ||
        pm_token_matches_any(token, server_commands, sizeof(server_commands) / sizeof(server_commands[0]))) {
      next_token_is_port = 1;
      continue;
    }

    if (strstr(token, "localhost:") != NULL ||
        strstr(token, "127.0.0.1:") != NULL ||
        strstr(token, "0.0.0.0:") != NULL ||
        strstr(token, "*:") != NULL ||
        strstr(token, "::1:") != NULL) {
      port = pm_parse_port_token(token, actual_port);
      if (port > 0) {
        return port;
      }
    }
  }

  return 0;
}

static int pm_is_hook_recovery_helper_text(const char *text) {
  return text != NULL &&
    (strstr(text, "portmanager_agent") != NULL ||
     strstr(text, "portmanager_tcp_router") != NULL ||
     strstr(text, "portmanager_process_lookup") != NULL ||
     strstr(text, "debugpy/adapter") != NULL ||
     strstr(text, "debugpy.adapter") != NULL);
}

static void pm_infer_process_name_from_command(const char *command, char *out, size_t out_size) {
  const char *end;
  size_t length;

  if (out == NULL || out_size == 0) {
    return;
  }

  if (command == NULL || command[0] == '\0') {
    pm_copy(out, out_size, "hooked process");
    return;
  }

  end = command;
  while (*end != '\0' && !isspace((unsigned char)*end)) {
    end++;
  }

  length = (size_t)(end - command);
  if (length == 0) {
    pm_copy(out, out_size, "hooked process");
    return;
  }
  if (length >= out_size) {
    length = out_size - 1;
  }

  memcpy(out, command, length);
  out[length] = '\0';
}

static int pm_recovered_hook_route_exists(
  pm_agent_state *state,
  pid_t pid,
  int requested_port,
  int actual_port,
  const char *network_id) {
  for (size_t index = 0; index < state->process_count; index++) {
    pm_process *process = &state->processes[index];
    if (strcmp(process->status, "stopped") != 0 &&
        process->pid == pid &&
        process->requested_port == requested_port &&
        process->actual_port == actual_port &&
        strcmp(process->network_id, network_id) == 0) {
      return 1;
    }
  }

  return 0;
}

static int pm_hook_recovery_disabled(void) {
  const char *value = getenv("PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY");

  return value != NULL && strcmp(value, "1") == 0;
}

static int pm_recover_untracked_hooked_listener(pm_agent_state *state, const pm_listener *listener, const char *updated_at) {
  static const char *const hook_markers[] = {
    "PORT_MANAGER_HOOK",
    "PORT_MANAGER_DYLD_INSERT_LIBRARIES",
    "PORT_MANAGER_AGENT_SOCKET",
    "PORT_MANAGER_ROUTES_FILE",
  };
  static const char *const network_variables[] = {
    "PORT_MANAGER_NETWORK_ID",
    "PORT_MANAGER_BORROWED_NETWORK_ID",
    "NEWDLOPS_PM_NETWORK_ID",
    "NEWDLOPS_PM_BORROWED_NETWORK_ID",
  };
  static const char *const cwd_variables[] = {
    "PWD",
    "INIT_CWD",
  };
  char environment[PM_PROCESS_INSPECT_TEXT];
  char command[PM_TEXT];
  char network_id[PM_SMALL];
  char cwd[PM_TEXT];
  char host[PM_SMALL];
  char name[PM_SMALL];
  pm_process *process;
  int requested_port;

  if (listener == NULL ||
      listener->pid <= 0 ||
      listener->pid == state->agent_pid ||
      pm_listener_is_tracked(state, listener) ||
      pm_is_hook_recovery_helper_text(listener->process_name) ||
      pm_is_hook_recovery_helper_text(listener->command)) {
    return 0;
  }

  if (!pm_read_process_environment_text(listener->pid, environment, sizeof(environment)) ||
      !pm_process_text_has_any_value(environment, hook_markers, sizeof(hook_markers) / sizeof(hook_markers[0]))) {
    return 0;
  }
  network_id[0] = '\0';
  (void)pm_process_text_first_value(environment, network_variables, sizeof(network_variables) / sizeof(network_variables[0]), network_id, sizeof(network_id));

  if (!pm_read_process_command_text(listener->pid, command, sizeof(command))) {
    pm_copy(command, sizeof(command), listener->command[0] ? listener->command : listener->process_name);
  }
  if (pm_is_hook_recovery_helper_text(command)) {
    return 0;
  }

  requested_port = pm_infer_requested_port_from_environment(environment, listener->port);
  if (requested_port <= 0) {
    requested_port = pm_infer_requested_port_from_command(command, listener->port);
  }
  if (!pm_process_text_first_value(environment, cwd_variables, sizeof(cwd_variables) / sizeof(cwd_variables[0]), cwd, sizeof(cwd))) {
    pm_copy(cwd, sizeof(cwd), ".");
  }
  if (network_id[0] == '\0' ||
      requested_port <= 0 ||
      requested_port == listener->port ||
      pm_recovered_hook_route_exists(state, listener->pid, requested_port, listener->port, network_id)) {
    return 0;
  }

  if (listener->process_name[0] != '\0') {
    pm_copy(name, sizeof(name), listener->process_name);
  } else {
    pm_infer_process_name_from_command(command, name, sizeof(name));
  }

  if (pm_reserve_processes(state, state->process_count + 1) != 0) {
    return 0;
  }

  process = &state->processes[state->process_count++];
  memset(process, 0, sizeof(*process));
  snprintf(process->id, sizeof(process->id), "managed-process-%lu", state->next_process_id++);
  process->pid = listener->pid;
  pm_copy(process->name, sizeof(process->name), name);
  pm_copy(process->command, sizeof(process->command), command);
  pm_copy(process->cwd, sizeof(process->cwd), cwd);
  pm_copy(process->network_id, sizeof(process->network_id), network_id);
  process->requested_port = requested_port;
  process->actual_port = listener->port;
  pm_copy(process->host, sizeof(process->host), pm_listener_route_host(listener, "127.0.0.1", host, sizeof(host)));
  pm_copy(process->status, sizeof(process->status), "running");
  pm_copy(process->started_at, sizeof(process->started_at), updated_at);
  pm_url(process->url, sizeof(process->url), process->host, process->actual_port);
  pm_copy(process->source, sizeof(process->source), "hooked");
  process->child_owned = 0;
  pm_clear_missing_listener_state(process);

  pm_remove_pending_endpoint(state, process->requested_port, network_id);
  return 1;
}

static int pm_recover_untracked_hooked_listeners(
  pm_agent_state *state,
  const pm_listener_list *listeners,
  const char *updated_at) {
  int changed = 0;

  if (pm_hook_recovery_disabled()) {
    return 0;
  }

  for (size_t index = 0; listeners != NULL && index < listeners->count; index++) {
    /*
     * Daemon restarts erase in-memory hook registrations, but the server keeps
     * the Port Manager environment. Rehydrate only listeners that still carry
     * that environment and expose an explicit logical-port hint.
     */
    if (pm_recover_untracked_hooked_listener(state, &listeners->items[index], updated_at)) {
      changed = 1;
    }
  }

  return changed;
}

static int pm_reconcile_external_processes_with_listeners(
  pm_agent_state *state,
  const pm_listener_list *listeners,
  const char *updated_at) {
  int changed = 0;
  time_t now = time(NULL);

  for (size_t index = 0; index < state->process_count; index++) {
    pm_process *process = &state->processes[index];
    const pm_listener *listener;

    if (strcmp(process->status, "running") != 0 || !pm_process_is_external_listener_owned(process)) {
      pm_clear_missing_listener_state(process);
      continue;
    }

    listener = pm_find_listener_by_process_pid_endpoint(listeners, process);
    if (listener != NULL) {
      pm_clear_missing_listener_state(process);
      continue;
    }

    listener = pm_find_listener_by_process_endpoint(listeners, process);
    if (listener != NULL) {
      changed = pm_adopt_listener_owner(process, listener) || changed;
      continue;
    }

    /*
     * Hooked servers are owned by their OS listener, not by a child handle in
     * the daemon. Require two missed scans and a short grace window so Daphne
     * autoreload handoffs do not erase routes, while dead routes stop blocking
     * the next listen/send allocation.
     */
    if (process->missing_listener_since == 0) {
      process->missing_listener_since = now;
    }
    process->missing_listener_count++;

    if (now - process->missing_listener_since >= PM_EXTERNAL_LISTENER_GRACE_SECONDS &&
        process->missing_listener_count >= PM_EXTERNAL_LISTENER_MISSING_SCAN_THRESHOLD) {
      pm_copy(process->status, sizeof(process->status), "stopped");
      pm_copy(process->stopped_at, sizeof(process->stopped_at), updated_at);
      process->url[0] = '\0';
      pm_clear_missing_listener_state(process);
      changed = 1;
    }
  }

  changed = pm_recover_untracked_hooked_listeners(state, listeners, updated_at) || changed;
  return changed;
}

static int pm_state_needs_external_listener_fresh_scan(pm_agent_state *state) {
  time_t now = time(NULL);

  for (size_t index = 0; index < state->process_count; index++) {
    pm_process *process = &state->processes[index];
    if (strcmp(process->status, "running") != 0 || !pm_process_is_external_listener_owned(process)) {
      continue;
    }

    /*
     * Once a real scan has observed a missing hooked listener, the next scan
     * after the grace window must be fresh. Replaying a cached "missing" list
     * would make cleanup fast but would not prove the listener stayed gone.
     */
    if (process->missing_listener_since > 0 && now - process->missing_listener_since >= PM_EXTERNAL_LISTENER_GRACE_SECONDS) {
      return 1;
    }
  }

  return 0;
}

static int pm_cleanup_pending(pm_agent_state *state) {
  time_t now = time(NULL);
  size_t before = state->pending_count;
  size_t write_index = 0;
  pm_listener_list listeners = {0};
  int listener_scan_attempted = 0;
  int listener_scan_ok = 0;

  for (size_t read_index = 0; read_index < state->pending_count; read_index++) {
    int keep_route = state->pending_routes[read_index].expires_at > now;

    if (!keep_route) {
      /*
       * A listener can outlive its short-lived allocation while a hook process
       * is still coming up. Match the TypeScript daemon contract: if the actual
       * routed port is already listening, refresh the pending endpoint instead
       * of deleting the route that clients may need to reach it.
       */
      if (!listener_scan_attempted) {
        char updated_at[PM_TIME];
        pm_iso_now(updated_at, sizeof(updated_at));
        listener_scan_ok = pm_scan_lsof(&listeners, updated_at) == 0;
        if (listener_scan_ok) {
          (void)pm_listener_cache_store(state, &listeners, updated_at, now);
        }
        listener_scan_attempted = 1;
      }

      if (listener_scan_ok && pm_listener_list_has_port(&listeners, state->pending_routes[read_index].route.actual_port)) {
        state->pending_routes[read_index].expires_at = now + PM_ROUTE_TTL_SECONDS;
        keep_route = 1;
      }
    }

    if (keep_route) {
      if (write_index != read_index) {
        state->pending_routes[write_index] = state->pending_routes[read_index];
      }
      write_index++;
    }
  }

  state->pending_count = write_index;
  free(listeners.items);
  return before != state->pending_count;
}

static pm_route *pm_find_active_route(pm_agent_state *state, int logical_port, const char *network_id, pm_route *scratch) {
  pm_route_list routes;
  char endpoint[PM_SMALL];
  char candidate[PM_SMALL];

  if (pm_build_routes(state, NULL, &routes) != 0) {
    return NULL;
  }

  pm_endpoint_identity(logical_port, network_id, endpoint, sizeof(endpoint));
  for (size_t index = 0; index < routes.count; index++) {
    pm_endpoint_identity(routes.items[index].logical_port, routes.items[index].network_id, candidate, sizeof(candidate));
    if (strcmp(endpoint, candidate) == 0 && strcmp(routes.items[index].route_direction, "listen") == 0) {
      *scratch = routes.items[index];
      free(routes.items);
      return scratch;
    }
  }

  free(routes.items);
  return NULL;
}

static pm_pending_route *pm_find_pending_endpoint(pm_agent_state *state, int logical_port, const char *network_id) {
  char endpoint[PM_SMALL];
  char candidate[PM_SMALL];

  pm_endpoint_identity(logical_port, network_id, endpoint, sizeof(endpoint));
  for (size_t index = 0; index < state->pending_count; index++) {
    pm_endpoint_identity(state->pending_routes[index].route.logical_port, state->pending_routes[index].route.network_id, candidate, sizeof(candidate));
    if (strcmp(endpoint, candidate) == 0) {
      return &state->pending_routes[index];
    }
  }

  return NULL;
}

static pm_pending_route *pm_find_pending_allocation(pm_agent_state *state, const char *allocation_id) {
  if (allocation_id == NULL || allocation_id[0] == '\0') {
    return NULL;
  }

  for (size_t index = 0; index < state->pending_count; index++) {
    if (strcmp(state->pending_routes[index].id, allocation_id) == 0) {
      return &state->pending_routes[index];
    }
  }

  return NULL;
}

static void pm_sanitize_scope(const char *value, char *out, size_t out_size) {
  size_t length = 0;

  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0' && length + 1 < out_size && length < 120; cursor++) {
    if (isalnum(*cursor) || *cursor == '_' || *cursor == '.' || *cursor == '-') {
      out[length++] = (char)*cursor;
    } else {
      out[length++] = '_';
    }
  }

  if (length == 0 && out_size > 1) {
    pm_copy(out, out_size, "network");
  } else {
    out[length] = '\0';
  }
}

static void pm_scoped_route_table_path(const char *base, const char *network_id, char *out, size_t out_size) {
  const char *slash = strrchr(base, '/');
  const char *name = slash == NULL ? base : slash + 1;
  const char *dot = strrchr(name, '.');
  char dir[PM_TEXT];
  char prefix[PM_TEXT];
  char extension[PM_SMALL];
  char scope[PM_SMALL];

  if (pm_text_empty(network_id)) {
    pm_copy(out, out_size, base);
    return;
  }

  if (slash == NULL) {
    pm_copy(dir, sizeof(dir), ".");
  } else {
    size_t dir_length = (size_t)(slash - base);
    if (dir_length >= sizeof(dir)) {
      dir_length = sizeof(dir) - 1;
    }
    memcpy(dir, base, dir_length);
    dir[dir_length] = '\0';
  }

  if (dot == NULL) {
    pm_copy(prefix, sizeof(prefix), name);
    pm_copy(extension, sizeof(extension), ".json");
  } else {
    size_t prefix_length = (size_t)(dot - name);
    if (prefix_length >= sizeof(prefix)) {
      prefix_length = sizeof(prefix) - 1;
    }
    memcpy(prefix, name, prefix_length);
    prefix[prefix_length] = '\0';
    pm_copy(extension, sizeof(extension), dot);
  }

  pm_sanitize_scope(network_id, scope, sizeof(scope));
  snprintf(out, out_size, "%s/%s-%s%s", dir, prefix, scope, extension);
}

static void pm_route_entry_path(const char *base, int logical_port, const char *network_id, char *out, size_t out_size) {
  char scoped[PM_TEXT];
  const char *slash;
  const char *name;
  const char *dot;
  char dir[PM_TEXT];
  char prefix[PM_TEXT];
  char extension[PM_SMALL];

  pm_scoped_route_table_path(base, network_id, scoped, sizeof(scoped));
  slash = strrchr(scoped, '/');
  name = slash == NULL ? scoped : slash + 1;
  dot = strrchr(name, '.');

  if (slash == NULL) {
    pm_copy(dir, sizeof(dir), ".");
  } else {
    size_t dir_length = (size_t)(slash - scoped);
    if (dir_length >= sizeof(dir)) {
      dir_length = sizeof(dir) - 1;
    }
    memcpy(dir, scoped, dir_length);
    dir[dir_length] = '\0';
  }

  if (dot == NULL) {
    pm_copy(prefix, sizeof(prefix), name);
    pm_copy(extension, sizeof(extension), ".json");
  } else {
    size_t prefix_length = (size_t)(dot - name);
    if (prefix_length >= sizeof(prefix)) {
      prefix_length = sizeof(prefix) - 1;
    }
    memcpy(prefix, name, prefix_length);
    prefix[prefix_length] = '\0';
    pm_copy(extension, sizeof(extension), dot);
  }

  snprintf(out, out_size, "%s/%s-port-%d%s", dir, prefix, logical_port, extension);
}

static void pm_route_compose_claim_path(const char *base, int port, char *out, size_t out_size) {
  const char *slash = strrchr(base, '/');
  const char *name = slash == NULL ? base : slash + 1;
  const char *dot = strrchr(name, '.');
  char dir[PM_TEXT];
  char prefix[PM_TEXT];
  char extension[PM_SMALL];

  if (slash == NULL) {
    pm_copy(dir, sizeof(dir), ".");
  } else {
    size_t dir_length = (size_t)(slash - base);
    if (dir_length >= sizeof(dir)) {
      dir_length = sizeof(dir) - 1;
    }
    memcpy(dir, base, dir_length);
    dir[dir_length] = '\0';
  }

  if (dot == NULL) {
    pm_copy(prefix, sizeof(prefix), name);
    pm_copy(extension, sizeof(extension), ".json");
  } else {
    size_t prefix_length = (size_t)(dot - name);
    if (prefix_length >= sizeof(prefix)) {
      prefix_length = sizeof(prefix) - 1;
    }
    memcpy(prefix, name, prefix_length);
    prefix[prefix_length] = '\0';
    pm_copy(extension, sizeof(extension), dot);
  }

  snprintf(out, out_size, "%s/%s-compose-claim-port-%d%s", dir, prefix, port, extension);
}

static int pm_mkdir_p_for_file(const char *file_path) {
  char path[PM_TEXT];

  pm_copy(path, sizeof(path), file_path);
  for (char *cursor = path + 1; *cursor != '\0'; cursor++) {
    if (*cursor != '/') {
      continue;
    }
    *cursor = '\0';
    if (mkdir(path, 0700) != 0 && errno != EEXIST) {
      return -1;
    }
    *cursor = '/';
  }

  return 0;
}

static int pm_write_atomic(const char *file_path, const char *text) {
  char temp_path[PM_TEXT];
  int fd;
  size_t length = strlen(text);
  size_t offset = 0;

  if (pm_mkdir_p_for_file(file_path) != 0) {
    return -1;
  }

  snprintf(temp_path, sizeof(temp_path), "%s.tmp.%ld", file_path, (long)getpid());
  fd = open(temp_path, O_CREAT | O_TRUNC | O_WRONLY, 0600);
  if (fd < 0) {
    return -1;
  }

  while (offset < length) {
    ssize_t written = write(fd, text + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      close(fd);
      unlink(temp_path);
      return -1;
    }
    if (written == 0) {
      close(fd);
      unlink(temp_path);
      return -1;
    }
    offset += (size_t)written;
  }

  close(fd);
  if (rename(temp_path, file_path) != 0) {
    unlink(temp_path);
    return -1;
  }

  return 0;
}

static int pm_read_route_table_generation(
  const char *file_path,
  char *writer_id,
  size_t writer_id_size,
  long *writer_started_ms,
  unsigned long *sequence) {
  char buffer[4096];
  int fd;
  ssize_t count;
  long raw_sequence;

  if (writer_id_size > 0) {
    writer_id[0] = '\0';
  }
  if (writer_started_ms != NULL) {
    *writer_started_ms = 0;
  }
  if (sequence != NULL) {
    *sequence = 0;
  }

  fd = open(file_path, O_RDONLY);
  if (fd < 0) {
    return -1;
  }

  count = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);
  if (count <= 0) {
    return -1;
  }

  buffer[count] = '\0';
  if (pm_json_get_string(buffer, "writerId", writer_id, writer_id_size) != 0 || writer_id[0] == '\0') {
    return -1;
  }

  if (writer_started_ms != NULL) {
    *writer_started_ms = pm_json_get_long(buffer, "writerStartedAtMs", 0);
  }
  raw_sequence = pm_json_get_long(buffer, "sequence", 0);
  if (sequence != NULL && raw_sequence > 0) {
    *sequence = (unsigned long)raw_sequence;
  }

  return writer_started_ms != NULL && *writer_started_ms > 0 ? 0 : -1;
}

static int pm_route_table_generation_is_newer(
  const pm_agent_state *state,
  const char *file_path,
  unsigned long candidate_sequence) {
  char current_writer_id[PM_ID];
  long current_started_ms = 0;
  unsigned long current_sequence = 0;
  int writer_compare;

  if (pm_read_route_table_generation(
        file_path,
        current_writer_id,
        sizeof(current_writer_id),
        &current_started_ms,
        &current_sequence) != 0) {
    return 0;
  }

  if (current_started_ms != state->route_table_writer_started_ms) {
    return current_started_ms > state->route_table_writer_started_ms;
  }

  writer_compare = strcmp(current_writer_id, state->route_table_writer_id);
  if (writer_compare != 0) {
    return writer_compare > 0;
  }

  return current_sequence > candidate_sequence;
}

/*
 * Unchanged route content can reuse the existing file only while native readers
 * still consider its TTL fresh. Missing TTL metadata is treated as legacy state
 * and rewritten into the current format.
 */
static int pm_route_table_file_fresh_for_reuse(const char *file_path) {
  char buffer[4096];
  int fd;
  ssize_t count;
  long expires_at_ms;
  long now_ms;

  fd = open(file_path, O_RDONLY);
  if (fd < 0) {
    return 0;
  }

  count = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);
  if (count <= 0) {
    return 0;
  }

  buffer[count] = '\0';
  expires_at_ms = pm_json_get_long(buffer, "expiresAtMs", 0);
  if (expires_at_ms <= 0) {
    return 0;
  }

  now_ms = pm_epoch_milliseconds();
  return expires_at_ms - now_ms > pm_route_table_refresh_margin_seconds() * 1000L;
}

static int pm_unlink_route_table_file_if_not_newer(
  const pm_agent_state *state,
  const char *file_path,
  unsigned long sequence) {
  if (pm_route_table_generation_is_newer(state, file_path, sequence)) {
    return -1;
  }

  return unlink(file_path);
}

static int pm_write_route_table_file(
  const pm_agent_state *state,
  const char *file_path,
  const pm_route *routes,
  size_t count,
  unsigned long sequence) {
  pm_buffer buffer;
  char updated_at[PM_TIME];
  long updated_at_ms;
  long expires_at_ms;
  long ttl_ms;
  int result;

  if (pm_route_table_generation_is_newer(state, file_path, sequence)) {
    return -1;
  }

  pm_buffer_init(&buffer);
  pm_iso_now(updated_at, sizeof(updated_at));
  updated_at_ms = pm_epoch_milliseconds();
  ttl_ms = pm_route_table_ttl_seconds() * 1000L;
  expires_at_ms = updated_at_ms + ttl_ms;
  result = pm_buffer_append(&buffer, "{\"updatedAt\":") ||
           pm_json_append_string(&buffer, updated_at) ||
           pm_buffer_appendf(
             &buffer,
             ",\"expiresAtMs\":%ld,\"ttlMs\":%ld",
             expires_at_ms,
             ttl_ms) ||
           pm_buffer_append(&buffer, ",\"generation\":{\"writerId\":") ||
           pm_json_append_string(&buffer, state->route_table_writer_id) ||
           pm_buffer_appendf(
             &buffer,
             ",\"writerStartedAtMs\":%ld,\"sequence\":%lu,\"pid\":%ld}",
             state->route_table_writer_started_ms,
             sequence,
             (long)state->agent_pid) ||
           pm_buffer_append(&buffer, ",\"routes\":") ||
           pm_append_routes_json(&buffer, routes, count) ||
           pm_buffer_append(&buffer, "}\n");

  if (result == 0) {
    result = pm_write_atomic(file_path, buffer.data);
  }

  pm_buffer_free(&buffer);
  return result;
}

static int pm_build_route_table_signature(pm_buffer *signature, const pm_route *routes, size_t count) {
  pm_buffer_init(signature);
  return pm_append_routes_json(signature, routes, count);
}

static int pm_write_route_table_file_if_changed(
  pm_agent_state *state,
  const char *file_path,
  const pm_route *routes,
  size_t count,
  unsigned long sequence) {
  pm_buffer signature;
  const char *previous_signature;
  int result;

  if (pm_build_route_table_signature(&signature, routes, count) != 0) {
    pm_buffer_free(&signature);
    return -1;
  }

  previous_signature = pm_route_table_signature_for_path(state, file_path);
  if (previous_signature != NULL && strcmp(previous_signature, signature.data == NULL ? "" : signature.data) == 0 && access(file_path, F_OK) == 0) {
    if (pm_route_table_generation_is_newer(state, file_path, sequence)) {
      result = -1;
    } else if (pm_route_table_file_fresh_for_reuse(file_path)) {
      result = 0;
    } else if (!pm_routes_can_refresh_unchanged_table(state, routes, count)) {
      result = 0;
    } else {
      result = pm_write_route_table_file(state, file_path, routes, count, sequence);
    }
    pm_buffer_free(&signature);
    return result;
  }

  result = pm_write_route_table_file(state, file_path, routes, count, sequence);
  if (result == 0) {
    result = pm_remember_route_table_signature(state, file_path, signature.data == NULL ? "" : signature.data);
  }

  pm_buffer_free(&signature);
  return result;
}

static void pm_route_table_write_lock_path(const char *route_table_path, char *out, size_t out_size) {
  snprintf(out, out_size, "%s.lock", route_table_path);
}

static void pm_remove_stale_route_table_write_lock(const char *lock_path) {
  struct stat stats;
  time_t now = time(NULL);

  if (stat(lock_path, &stats) != 0) {
    return;
  }

  if (now - stats.st_mtime >= PM_ROUTE_TABLE_WRITE_LOCK_STALE_SECONDS) {
    unlink(lock_path);
  }
}

static int pm_acquire_route_table_write_lock(const char *route_table_path, char *lock_path, size_t lock_path_size) {
  char owner[128];

  pm_route_table_write_lock_path(route_table_path, lock_path, lock_path_size);
  if (pm_mkdir_p_for_file(lock_path) != 0) {
    return -1;
  }

  for (int attempt = 0; attempt < PM_ROUTE_TABLE_WRITE_LOCK_ATTEMPTS; attempt++) {
    int fd = open(lock_path, O_CREAT | O_EXCL | O_WRONLY, 0600);
    if (fd >= 0) {
      snprintf(owner, sizeof(owner), "%ld\n%ld\n", (long)getpid(), (long)time(NULL));
      (void)write(fd, owner, strlen(owner));
      return fd;
    }

    if (errno != EEXIST) {
      return -1;
    }

    pm_remove_stale_route_table_write_lock(lock_path);
    usleep(PM_ROUTE_TABLE_WRITE_LOCK_SLEEP_US);
  }

  return -1;
}

static void pm_release_route_table_write_lock(int fd, const char *lock_path) {
  if (fd >= 0) {
    close(fd);
  }
  if (lock_path != NULL && lock_path[0] != '\0') {
    unlink(lock_path);
  }
}

typedef struct {
  char entry_path[PM_TEXT];
  pm_route route;
} pm_route_entry_item;

typedef struct {
  char claim_path[PM_TEXT];
  pm_route route;
} pm_route_claim_item;

static int pm_compare_route_entry_items(const void *left, const void *right) {
  const pm_route_entry_item *left_item = (const pm_route_entry_item *)left;
  const pm_route_entry_item *right_item = (const pm_route_entry_item *)right;

  return strcmp(left_item->entry_path, right_item->entry_path);
}

static int pm_compare_route_claim_items(const void *left, const void *right) {
  const pm_route_claim_item *left_item = (const pm_route_claim_item *)left;
  const pm_route_claim_item *right_item = (const pm_route_claim_item *)right;

  return strcmp(left_item->claim_path, right_item->claim_path);
}

static int pm_write_route_tables(pm_agent_state *state) {
  pm_route_list routes;
  pm_route_entry_item *entry_items = NULL;
  pm_route_claim_item *claim_items = NULL;
  size_t claim_item_count = 0;
  char **current_networks = NULL;
  size_t current_network_count = 0;
  size_t current_network_capacity = 0;
  char **current_entries = NULL;
  size_t current_entry_count = 0;
  size_t current_entry_capacity = 0;
  char **current_claims = NULL;
  size_t current_claim_count = 0;
  size_t current_claim_capacity = 0;
  char lock_path[PM_TEXT];
  int lock_fd;
  int result = 0;
  int endpoint_entries_complete = 1;
  int claim_entries_complete = 1;
  unsigned long sequence;

  if (pm_build_routes(state, NULL, &routes) != 0) {
    return -1;
  }

  lock_fd = pm_acquire_route_table_write_lock(state->route_table_path, lock_path, sizeof(lock_path));
  if (lock_fd < 0) {
    free(routes.items);
    return -1;
  }

  if (routes.count > 0) {
    entry_items = (pm_route_entry_item *)malloc(routes.count * sizeof(pm_route_entry_item));
    claim_items = (pm_route_claim_item *)malloc(routes.count * 2 * sizeof(pm_route_claim_item));
    if (entry_items == NULL || claim_items == NULL) {
      pm_release_route_table_write_lock(lock_fd, lock_path);
      free(entry_items);
      free(claim_items);
      free(routes.items);
      return -1;
    }
  }

  sequence = ++state->route_table_sequence;
  if (pm_route_table_generation_is_newer(state, state->route_table_path, sequence)) {
    pm_release_route_table_write_lock(lock_fd, lock_path);
    free(claim_items);
    free(entry_items);
    free(routes.items);
    return -1;
  }

  for (size_t index = 0; index < routes.count; index++) {
    pm_route_entry_path(
      state->route_table_path,
      routes.items[index].logical_port,
      routes.items[index].network_id,
      entry_items[index].entry_path,
      sizeof(entry_items[index].entry_path));
    entry_items[index].route = routes.items[index];
    if (routes.items[index].network_id[0] != '\0') {
      pm_string_array_add(&current_networks, &current_network_count, &current_network_capacity, routes.items[index].network_id);
    }
    if (strcmp(routes.items[index].source, "compose") == 0) {
      pm_route_compose_claim_path(
        state->route_table_path,
        routes.items[index].logical_port,
        claim_items[claim_item_count].claim_path,
        sizeof(claim_items[claim_item_count].claim_path));
      claim_items[claim_item_count].route = routes.items[index];
      claim_item_count++;

      if (routes.items[index].actual_port != routes.items[index].logical_port) {
        pm_route_compose_claim_path(
          state->route_table_path,
          routes.items[index].actual_port,
          claim_items[claim_item_count].claim_path,
          sizeof(claim_items[claim_item_count].claim_path));
        claim_items[claim_item_count].route = routes.items[index];
        claim_item_count++;
      }
    }
  }

  if (routes.count > 0) {
    qsort(entry_items, routes.count, sizeof(pm_route_entry_item), pm_compare_route_entry_items);
  }
  if (claim_item_count > 0) {
    qsort(claim_items, claim_item_count, sizeof(pm_route_claim_item), pm_compare_route_claim_items);
  }

  for (size_t index = 0; index < routes.count;) {
    size_t end = index + 1;
    pm_route_list endpoint_routes = {0};
    int endpoint_result = 0;

    while (end < routes.count && strcmp(entry_items[index].entry_path, entry_items[end].entry_path) == 0) {
      end++;
    }

    for (size_t route_index = index; route_index < end; route_index++) {
      if (pm_route_list_append(&endpoint_routes, &entry_items[route_index].route) != 0) {
        endpoint_result = -1;
        break;
      }
    }

    if (endpoint_result == 0 &&
        pm_write_route_table_file_if_changed(state, entry_items[index].entry_path, endpoint_routes.items, endpoint_routes.count, sequence) != 0) {
      endpoint_result = -1;
    }
    if (pm_string_array_append(&current_entries, &current_entry_count, &current_entry_capacity, entry_items[index].entry_path) != 0) {
      endpoint_entries_complete = 0;
      endpoint_result = -1;
    }
    if (endpoint_result != 0) {
      result = -1;
    }
    free(endpoint_routes.items);
    index = end;
  }

  for (size_t index = 0; index < claim_item_count;) {
    size_t end = index + 1;
    pm_route_list claim_routes = {0};
    int claim_result = 0;

    while (end < claim_item_count && strcmp(claim_items[index].claim_path, claim_items[end].claim_path) == 0) {
      end++;
    }

    for (size_t route_index = index; route_index < end; route_index++) {
      if (pm_route_list_append(&claim_routes, &claim_items[route_index].route) != 0) {
        claim_result = -1;
        break;
      }
    }

    if (claim_result == 0 &&
        pm_write_route_table_file_if_changed(state, claim_items[index].claim_path, claim_routes.items, claim_routes.count, sequence) != 0) {
      claim_result = -1;
    }
    if (pm_string_array_append(&current_claims, &current_claim_count, &current_claim_capacity, claim_items[index].claim_path) != 0) {
      claim_entries_complete = 0;
      claim_result = -1;
    }
    if (claim_result != 0) {
      result = -1;
    }
    free(claim_routes.items);
    index = end;
  }

  if (pm_write_route_table_file_if_changed(state, state->route_table_path, routes.items, routes.count, sequence) != 0) {
    result = -1;
  }

  for (size_t network_index = 0; network_index < current_network_count; network_index++) {
    char network_path[PM_TEXT];
    pm_route_list network_routes = {0};

    for (size_t route_index = 0; route_index < routes.count; route_index++) {
      if (strcmp(routes.items[route_index].network_id, current_networks[network_index]) == 0) {
        pm_route_list_add_dedupe(&network_routes, &routes.items[route_index]);
      }
    }

    pm_scoped_route_table_path(state->route_table_path, current_networks[network_index], network_path, sizeof(network_path));
    if (pm_write_route_table_file_if_changed(state, network_path, network_routes.items, network_routes.count, sequence) != 0) {
      result = -1;
    }
    free(network_routes.items);
  }

  for (size_t index = 0; index < state->written_network_count; index++) {
    if (!pm_string_array_contains(current_networks, current_network_count, state->written_network_ids[index])) {
      char network_path[PM_TEXT];
      pm_scoped_route_table_path(state->route_table_path, state->written_network_ids[index], network_path, sizeof(network_path));
      if (pm_write_route_table_file_if_changed(state, network_path, NULL, 0, sequence) != 0) {
        result = -1;
      }
    }
  }

  if (endpoint_entries_complete) {
    for (size_t index = 0; index < state->written_entry_count; index++) {
      if (!pm_string_array_contains(current_entries, current_entry_count, state->written_entry_paths[index])) {
        if (pm_unlink_route_table_file_if_not_newer(state, state->written_entry_paths[index], sequence) != 0 && errno != ENOENT) {
          result = -1;
        } else {
          pm_forget_route_table_signature(state, state->written_entry_paths[index]);
        }
      }
    }
  }

  if (claim_entries_complete) {
    for (size_t index = 0; index < state->written_claim_count; index++) {
      if (!pm_string_array_contains(current_claims, current_claim_count, state->written_claim_paths[index])) {
        if (pm_unlink_route_table_file_if_not_newer(state, state->written_claim_paths[index], sequence) != 0 && errno != ENOENT) {
          result = -1;
        } else {
          pm_forget_route_table_signature(state, state->written_claim_paths[index]);
        }
      }
    }
  }

  pm_string_array_clear(&state->written_network_ids, &state->written_network_count, &state->written_network_capacity);
  state->written_network_ids = current_networks;
  state->written_network_count = current_network_count;
  state->written_network_capacity = current_network_capacity;
  current_networks = NULL;
  current_network_count = current_network_capacity = 0;

  if (endpoint_entries_complete) {
    pm_string_array_clear(&state->written_entry_paths, &state->written_entry_count, &state->written_entry_capacity);
    state->written_entry_paths = current_entries;
    state->written_entry_count = current_entry_count;
    state->written_entry_capacity = current_entry_capacity;
    current_entries = NULL;
    current_entry_count = current_entry_capacity = 0;
  }

  if (claim_entries_complete) {
    pm_string_array_clear(&state->written_claim_paths, &state->written_claim_count, &state->written_claim_capacity);
    state->written_claim_paths = current_claims;
    state->written_claim_count = current_claim_count;
    state->written_claim_capacity = current_claim_capacity;
    current_claims = NULL;
    current_claim_count = current_claim_capacity = 0;
  }

  pm_string_array_clear(&current_networks, &current_network_count, &current_network_capacity);
  pm_string_array_clear(&current_entries, &current_entry_count, &current_entry_capacity);
  pm_string_array_clear(&current_claims, &current_claim_count, &current_claim_capacity);
  pm_release_route_table_write_lock(lock_fd, lock_path);
  free(claim_items);
  free(entry_items);
  free(routes.items);
  return result;
}

int pm_state_flush_route_tables(pm_agent_state *state) {
  return pm_write_route_tables(state);
}

static int pm_write_route_entry_table(pm_agent_state *state, const pm_route *route) {
  char entry_path[PM_TEXT];
  char lock_path[PM_TEXT];
  int lock_fd;
  int result;
  unsigned long sequence;

  pm_route_entry_path(state->route_table_path, route->logical_port, route->network_id, entry_path, sizeof(entry_path));
  lock_fd = pm_acquire_route_table_write_lock(state->route_table_path, lock_path, sizeof(lock_path));
  if (lock_fd < 0) {
    return -1;
  }

  sequence = ++state->route_table_sequence;
  if (pm_route_table_generation_is_newer(state, state->route_table_path, sequence)) {
    pm_release_route_table_write_lock(lock_fd, lock_path);
    return -1;
  }

  result = pm_write_route_table_file_if_changed(state, entry_path, route, 1, sequence);
  if (result == 0) {
    result = pm_string_array_add(&state->written_entry_paths, &state->written_entry_count, &state->written_entry_capacity, entry_path);
  }

  pm_release_route_table_write_lock(lock_fd, lock_path);
  return result;
}

static int pm_flush_route_tables_for_allocation(pm_agent_state *state, const pm_route *route, int compact_response) {
  /*
   * Native hooks read per-endpoint files first. For large bind/connect bursts,
   * publish that endpoint before replying and let the event loop coalesce the
   * global/network aggregate table after the burst has gone idle.
   */
  if (compact_response && route != NULL) {
    return pm_write_route_entry_table(state, route);
  }

  return pm_write_route_tables(state);
}

static int pm_build_allocation_payload(
  pm_agent_state *state,
  const char *allocation_id,
  int requested_port,
  int actual_port,
  const char *host,
  const char *network_id,
  time_t expires_at,
  int compact_response,
  pm_buffer *payload) {
  pm_route_list routes;
  char route_file[PM_TEXT];
  char expires[PM_TIME];
  struct tm parts;
  int routed = requested_port != actual_port;

  pm_scoped_route_table_path(state->route_table_path, network_id, route_file, sizeof(route_file));
  gmtime_r(&expires_at, &parts);
  strftime(expires, sizeof(expires), "%Y-%m-%dT%H:%M:%SZ", &parts);

  if (pm_buffer_append(payload, "{\"allocationId\":") != 0 ||
      pm_json_append_string(payload, allocation_id) != 0 ||
      pm_buffer_appendf(payload, ",\"requestedPort\":%d,\"actualPort\":%d,\"host\":", requested_port, actual_port) != 0 ||
      pm_json_append_string(payload, host) != 0 ||
      pm_buffer_appendf(payload, ",\"routed\":%s", routed ? "true" : "false") != 0) {
    return -1;
  }

  if (!compact_response) {
    if (pm_build_routes(state, NULL, &routes) != 0) {
      return -1;
    }
    if (pm_buffer_append(payload, ",\"logicalRoutes\":") != 0 ||
        pm_append_routes_json(payload, routes.items, routes.count) != 0) {
      free(routes.items);
      return -1;
    }
    free(routes.items);
  }

  if (pm_buffer_append(payload, ",\"logicalRoutesFile\":") != 0 ||
      pm_json_append_string(payload, route_file) != 0 ||
      pm_buffer_append(payload, ",\"expiresAt\":") != 0 ||
      pm_json_append_string(payload, expires) != 0 ||
      pm_buffer_append_char(payload, '}') != 0) {
    return -1;
  }

  return 0;
}

int pm_state_allocate_route(pm_agent_state *state, const pm_allocate_input *input, pm_buffer *payload) {
  char network_id[PM_SMALL];
  char actual_host[PM_SMALL];
  pm_allocate_input effective_input;
  pm_route active_route;
  pm_pending_route *reusable;
  int actual_port;
  pm_pending_route pending;
  pm_listener_list listeners = {0};
  char updated_at[PM_TIME];
  int listener_scan_fresh = 0;

  /*
   * Allocation bursts come from short-lived hook clients, so one fresh lsof per
   * request can starve response delivery. The scan here only reconciles process
   * metadata; actual port safety still goes through bind() probes below.
   */
  if (pm_state_needs_external_listener_fresh_scan(state)) {
    pm_listener_cache_invalidate(state);
  }
  if (pm_scan_lsof_cached(state, &listeners, updated_at, sizeof(updated_at), &listener_scan_fresh) == 0) {
    if (listener_scan_fresh && pm_reconcile_external_processes_with_listeners(state, &listeners, updated_at)) {
      pm_write_route_tables(state);
    }
  }
  free(listeners.items);

  if (pm_cleanup_pending(state)) {
    pm_write_route_tables(state);
  }
  pm_normalize_network(input->network_id, network_id, sizeof(network_id));
  pm_copy(actual_host, sizeof(actual_host), input->actual_host[0] ? input->actual_host : input->host);

  /*
   * The chosen actual port must be derived from the explicit logical network
   * that will be written to the route table. CWD overlap is not an authority
   * signal; unscoped host listeners must stay reachable through localhost.
   */
  effective_input = *input;
  pm_copy(effective_input.network_id, sizeof(effective_input.network_id), network_id);

  if (strcmp(input->route_direction, "send") == 0 && pm_find_active_route(state, input->requested_port, network_id, &active_route) != NULL) {
    pm_mark_bidirectional_route_observed(state, input->requested_port, network_id);
    if (pm_flush_route_tables_for_allocation(state, &active_route, input->compact_response) != 0) {
      return -1;
    }
    return pm_build_allocation_payload(
      state,
      "",
      input->requested_port,
      active_route.actual_port,
      active_route.host,
      network_id,
      time(NULL),
      input->compact_response,
      payload);
  }

  reusable = pm_find_pending_endpoint(state, input->requested_port, network_id);
  if (reusable != NULL) {
    if (strcmp(reusable->route.route_direction, input->route_direction) != 0) {
      pm_mark_bidirectional_route_observed(state, input->requested_port, network_id);
    }
    reusable->expires_at = time(NULL) + PM_ROUTE_TTL_SECONDS;
    if (pm_flush_route_tables_for_allocation(state, &reusable->route, input->compact_response) != 0) {
      return -1;
    }
    return pm_build_allocation_payload(
      state,
      reusable->id,
      input->requested_port,
      reusable->route.actual_port,
      reusable->route.host,
      network_id,
      reusable->expires_at,
      input->compact_response,
      payload);
  }

  if (strcmp(input->route_direction, "send") == 0) {
    pm_listener same_port_listener;
    char same_port_host[PM_SMALL];

    /*
     * A sender can start after a server that was launched before terminal
     * attach, or after a protected launcher dropped the hook. In that state
     * the OS has the requested listener but no route row exists yet, so a new
     * 5xxxx reservation would shadow the real server and make wait-on hang.
     */
    if (pm_find_listener_for_port_host(input->requested_port, input->host, &same_port_listener)) {
      return pm_build_allocation_payload(
        state,
        "",
        input->requested_port,
        input->requested_port,
        pm_listener_route_host(&same_port_listener, input->host, same_port_host, sizeof(same_port_host)),
        network_id,
        time(NULL),
        input->compact_response,
        payload);
    }
  }

  pm_copy(effective_input.host, sizeof(effective_input.host), actual_host);
  actual_port = strcmp(input->routing_mode, "hashed") == 0 ? pm_route_hashed(state, &effective_input) : pm_route_nearest(state, &effective_input);
  if (actual_port <= 0) {
    return -1;
  }

  memset(&pending, 0, sizeof(pending));
  snprintf(pending.id, sizeof(pending.id), "allocation:native:%ld:%lu", (long)getpid(), state->next_allocation_id++);
  pending.expires_at = time(NULL) + PM_ROUTE_TTL_SECONDS;
  pending.route.logical_port = input->requested_port;
  pending.route.actual_port = actual_port;
  pm_copy(pending.route.route_direction, sizeof(pending.route.route_direction), strcmp(input->route_direction, "send") == 0 ? "send" : "listen");
  pm_copy(pending.route.host, sizeof(pending.route.host), actual_host);
  pm_copy(pending.route.cwd, sizeof(pending.route.cwd), input->cwd);
  pm_copy(pending.route.network_id, sizeof(pending.route.network_id), network_id);
  pm_copy(pending.route.process_name, sizeof(pending.route.process_name), input->name[0] ? input->name : input->command);
  pm_copy(pending.route.status, sizeof(pending.route.status), "starting");
  pm_copy(pending.route.source, sizeof(pending.route.source), "allocated");

  if (pm_reserve_pending(state, state->pending_count + 1) != 0) {
    return -1;
  }

  state->pending_routes[state->pending_count++] = pending;
  if (pm_flush_route_tables_for_allocation(state, &pending.route, input->compact_response) != 0) {
    return -1;
  }
  return pm_build_allocation_payload(
    state,
    pending.id,
    input->requested_port,
    actual_port,
    actual_host,
    network_id,
    pending.expires_at,
    input->compact_response,
    payload);
}

static void pm_remove_pending_allocation(pm_agent_state *state, const char *allocation_id) {
  for (size_t index = 0; index < state->pending_count; index++) {
    if (strcmp(state->pending_routes[index].id, allocation_id) == 0) {
      memmove(&state->pending_routes[index], &state->pending_routes[index + 1], (state->pending_count - index - 1) * sizeof(pm_pending_route));
      state->pending_count--;
      return;
    }
  }
}

static void pm_remove_pending_endpoint(pm_agent_state *state, int logical_port, const char *network_id) {
  char endpoint[PM_SMALL];
  char candidate[PM_SMALL];
  size_t write_index = 0;

  pm_endpoint_identity(logical_port, network_id, endpoint, sizeof(endpoint));
  for (size_t read_index = 0; read_index < state->pending_count; read_index++) {
    pm_endpoint_identity(state->pending_routes[read_index].route.logical_port, state->pending_routes[read_index].route.network_id, candidate, sizeof(candidate));
    if (strcmp(endpoint, candidate) != 0) {
      if (write_index != read_index) {
        state->pending_routes[write_index] = state->pending_routes[read_index];
      }
      write_index++;
    }
  }

  state->pending_count = write_index;
}

static pm_process *pm_find_registered_route(pm_agent_state *state, const pm_register_input *input, const char *source, const char *network_id) {
  for (size_t index = 0; index < state->process_count; index++) {
    pm_process *process = &state->processes[index];
    if (strcmp(process->status, "running") == 0 &&
        strcmp(process->source, source) == 0 &&
        process->requested_port == input->requested_port &&
        process->actual_port == input->actual_port &&
        strcmp(process->network_id, network_id) == 0) {
      return process;
    }
  }

  return NULL;
}

static int pm_listener_address_is_wildcard(const char *address) {
  return address == NULL ||
    address[0] == '\0' ||
    strcmp(address, "*") == 0 ||
    strcmp(address, "0.0.0.0") == 0 ||
    strcmp(address, "::") == 0 ||
    strcmp(address, "[::]") == 0;
}

static int pm_listener_address_is_routeable(const char *address) {
  char normalized[PM_SMALL];
  struct in_addr v4;
  struct in6_addr v6;
  size_t length;

  if (pm_listener_address_is_wildcard(address)) {
    return 0;
  }

  if (strcmp(address, "localhost") == 0) {
    return 1;
  }

  pm_copy(normalized, sizeof(normalized), address);
  length = strlen(normalized);
  if (length > 2 && normalized[0] == '[' && normalized[length - 1] == ']') {
    memmove(normalized, normalized + 1, length - 2);
    normalized[length - 2] = '\0';
  }

  return inet_pton(AF_INET, normalized, &v4) == 1 ||
    inet_pton(AF_INET6, normalized, &v6) == 1;
}

static const char *pm_listener_route_host(const pm_listener *listener, const char *fallback_host, char *buffer, size_t size) {
  if (buffer == NULL || size == 0) {
    return fallback_host;
  }

  if (listener != NULL && pm_listener_address_is_routeable(listener->local_address)) {
    pm_copy(buffer, size, listener->local_address);
  } else {
    pm_copy(buffer, size, fallback_host);
  }

  return buffer;
}

static pm_process *pm_find_process(pm_agent_state *state, const char *id) {
  for (size_t index = 0; index < state->process_count; index++) {
    if (strcmp(state->processes[index].id, id) == 0) {
      return &state->processes[index];
    }
  }

  return NULL;
}

static const char *pm_normalized_source(const char *source) {
  if (strcmp(source, "hooked") == 0 || strcmp(source, "compose") == 0) {
    return source;
  }

  return "registered";
}

int pm_state_register_process(pm_agent_state *state, const pm_register_input *input, pm_buffer *payload) {
  char network_id[PM_SMALL];
  char source[PM_SOURCE];
  pm_pending_route *allocation;
  pm_process *process;
  char now[PM_TIME];

  pm_normalize_network(input->network_id, network_id, sizeof(network_id));
  allocation = pm_find_pending_allocation(state, input->allocation_id);
  if (network_id[0] == '\0' && allocation != NULL) {
    pm_copy(network_id, sizeof(network_id), allocation->route.network_id);
  }
  if (allocation != NULL && strcmp(allocation->route.route_direction, "send") == 0) {
    pm_mark_bidirectional_route_observed(state, input->requested_port, network_id);
  }
  pm_copy(source, sizeof(source), pm_normalized_source(input->source));
  if (input->allocation_id[0] != '\0') {
    pm_remove_pending_allocation(state, input->allocation_id);
  }

  process = pm_find_registered_route(state, input, source, network_id);
  pm_iso_now(now, sizeof(now));

  if (process == NULL) {
    if (pm_reserve_processes(state, state->process_count + 1) != 0) {
      return -1;
    }
    process = &state->processes[state->process_count++];
    memset(process, 0, sizeof(*process));
    snprintf(process->id, sizeof(process->id), "managed-process-%lu", state->next_process_id++);
  }

  process->pid = input->pid;
  pm_copy(process->name, sizeof(process->name), input->name);
  pm_copy(process->command, sizeof(process->command), input->command);
  pm_copy(process->cwd, sizeof(process->cwd), input->cwd);
  pm_copy(process->network_id, sizeof(process->network_id), network_id);
  process->requested_port = input->requested_port;
  process->actual_port = input->actual_port;
  pm_copy(process->host, sizeof(process->host), input->host);
  pm_copy(process->status, sizeof(process->status), "running");
  pm_copy(process->started_at, sizeof(process->started_at), now);
  process->stopped_at[0] = '\0';
  pm_url(process->url, sizeof(process->url), input->host, input->actual_port);
  process->error_message[0] = '\0';
  pm_copy(process->source, sizeof(process->source), source);
  process->child_owned = 0;
  pm_clear_missing_listener_state(process);

  pm_remove_pending_endpoint(state, process->requested_port, network_id);
  pm_listener_cache_invalidate(state);
  pm_write_route_tables(state);
  return pm_append_process_json(payload, process);
}

int pm_state_release_allocation(pm_agent_state *state, const char *allocation_id, pm_buffer *payload) {
  size_t before = state->pending_count;

  pm_remove_pending_allocation(state, allocation_id);
  if (before != state->pending_count) {
    pm_write_route_tables(state);
  }

  return pm_buffer_append(payload, before != state->pending_count ? "true" : "false");
}

static int pm_scan_lsof(pm_listener_list *listeners, const char *updated_at) {
  FILE *pipe = popen("lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null", "r");
  char line[2048];
  pid_t current_pid = 0;
  char current_name[PM_SMALL] = "";

  if (pipe == NULL) {
    return -1;
  }

  while (fgets(line, sizeof(line), pipe) != NULL) {
    char *value;
    size_t length = strlen(line);

    while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) {
      line[--length] = '\0';
    }
    if (length == 0) {
      continue;
    }

    value = line + 1;
    if (line[0] == 'p') {
      current_pid = (pid_t)strtol(value, NULL, 10);
      current_name[0] = '\0';
      continue;
    }
    if (line[0] == 'c') {
      pm_copy(current_name, sizeof(current_name), value);
      continue;
    }
    if (line[0] != 'n') {
      continue;
    }

    char endpoint[PM_TEXT];
    char *state_marker;
    char *remote_marker;
    char *colon;
    char address[PM_SMALL];
    int port;

    pm_copy(endpoint, sizeof(endpoint), value);
    if (strncmp(endpoint, "TCP ", 4) == 0) {
      memmove(endpoint, endpoint + 4, strlen(endpoint + 4) + 1);
    }
    state_marker = strstr(endpoint, " (");
    if (state_marker != NULL) {
      *state_marker = '\0';
    }
    remote_marker = strstr(endpoint, "->");
    if (remote_marker != NULL) {
      *remote_marker = '\0';
    }
    colon = strrchr(endpoint, ':');
    if (colon == NULL) {
      continue;
    }

    *colon = '\0';
    port = atoi(colon + 1);
    if (!pm_is_valid_port(port)) {
      continue;
    }
    pm_copy(address, sizeof(address), endpoint[0] == '\0' ? "*" : endpoint);
    if (address[0] == '[') {
      size_t addr_len = strlen(address);
      if (addr_len > 2 && address[addr_len - 1] == ']') {
        memmove(address, address + 1, addr_len - 2);
        address[addr_len - 2] = '\0';
      }
    }

    if (pm_reserve_listeners(listeners, listeners->count + 1) != 0) {
      pclose(pipe);
      return -1;
    }

    pm_listener *listener = &listeners->items[listeners->count++];
    memset(listener, 0, sizeof(*listener));
    pm_copy(listener->local_address, sizeof(listener->local_address), address);
    listener->port = port;
    listener->pid = current_pid;
    pm_copy(listener->process_name, sizeof(listener->process_name), current_name);
    pm_copy(listener->command, sizeof(listener->command), current_name);
    pm_copy(listener->source, sizeof(listener->source), "external");
    pm_copy(listener->updated_at, sizeof(listener->updated_at), updated_at);
    snprintf(listener->id, sizeof(listener->id), "tcp:%s:%d:%ld", listener->local_address, listener->port, (long)listener->pid);
  }

  pclose(pipe);
  return 0;
}

static int pm_listener_list_copy(pm_listener_list *target, const pm_listener *items, size_t count) {
  memset(target, 0, sizeof(*target));
  if (count == 0) {
    return 0;
  }

  target->items = (pm_listener *)malloc(count * sizeof(pm_listener));
  if (target->items == NULL) {
    return -1;
  }

  memcpy(target->items, items, count * sizeof(pm_listener));
  target->count = count;
  target->capacity = count;
  return 0;
}

static int pm_listener_cache_store(pm_agent_state *state, const pm_listener_list *listeners, const char *updated_at, time_t now) {
  pm_listener *next_items = NULL;

  if (listeners->count > 0) {
    next_items = (pm_listener *)malloc(listeners->count * sizeof(pm_listener));
    if (next_items == NULL) {
      return -1;
    }
    memcpy(next_items, listeners->items, listeners->count * sizeof(pm_listener));
  }

  free(state->listener_cache_items);
  state->listener_cache_items = next_items;
  state->listener_cache_count = listeners->count;
  state->listener_cache_expires_at = now + PM_LISTENER_SCAN_CACHE_SECONDS;
  pm_copy(state->listener_cache_updated_at, sizeof(state->listener_cache_updated_at), updated_at);
  return 0;
}

static void pm_listener_cache_invalidate(pm_agent_state *state) {
  state->listener_cache_expires_at = 0;
  state->listener_cache_updated_at[0] = '\0';
}

static int pm_scan_lsof_cached(pm_agent_state *state, pm_listener_list *listeners, char *updated_at, size_t updated_at_size, int *fresh_scan) {
  time_t now = time(NULL);

  if (fresh_scan != NULL) {
    *fresh_scan = 0;
  }

  if (state->listener_cache_updated_at[0] != '\0' && now < state->listener_cache_expires_at) {
    if (updated_at != NULL && updated_at_size > 0) {
      pm_copy(updated_at, updated_at_size, state->listener_cache_updated_at);
    }
    return pm_listener_list_copy(listeners, state->listener_cache_items, state->listener_cache_count);
  }

  if (updated_at != NULL && updated_at_size > 0) {
    pm_iso_now(updated_at, updated_at_size);
  }
  if (pm_scan_lsof(listeners, updated_at) != 0) {
    return -1;
  }

  (void)pm_listener_cache_store(state, listeners, updated_at, now);
  if (fresh_scan != NULL) {
    *fresh_scan = 1;
  }
  return 0;
}

static int pm_find_listener_for_port_host(int port, const char *host, pm_listener *out) {
  pm_listener_list listeners = {0};
  const pm_listener *fallback = NULL;
  char updated_at[PM_TIME];
  int found = 0;

  pm_iso_now(updated_at, sizeof(updated_at));
  if (pm_scan_lsof(&listeners, updated_at) != 0) {
    free(listeners.items);
    return 0;
  }

  for (size_t index = 0; index < listeners.count; index++) {
    if (listeners.items[index].port != port || !pm_endpoint_hosts_match(listeners.items[index].local_address, host)) {
      continue;
    }

    if (listeners.items[index].pid > 0) {
      *out = listeners.items[index];
      found = 1;
      break;
    }

    fallback = &listeners.items[index];
  }

  if (!found && fallback != NULL) {
    *out = *fallback;
    found = 1;
  }

  free(listeners.items);
  return found;
}

int pm_state_release_process_route(pm_agent_state *state, const pm_release_process_input *input, pm_buffer *payload) {
  char network_id[PM_SMALL];
  pm_listener_list listeners = {0};
  char updated_at[PM_TIME];
  int listener_scan_ok = 0;
  int released = 0;
  int retained = 0;

  pm_normalize_network(input->network_id, network_id, sizeof(network_id));
  pm_iso_now(updated_at, sizeof(updated_at));
  listener_scan_ok = pm_scan_lsof(&listeners, updated_at) == 0;
  if (listener_scan_ok) {
    (void)pm_listener_cache_store(state, &listeners, updated_at, time(NULL));
  }

  if (input->allocation_id[0] != '\0') {
    size_t before = state->pending_count;
    pm_remove_pending_allocation(state, input->allocation_id);
    released = released || before != state->pending_count;
  }

  for (size_t index = 0; index < state->process_count; index++) {
    pm_process *process = &state->processes[index];
    const pm_listener *active_listener;

    if (strcmp(process->status, "running") != 0 ||
        strcmp(process->source, "detected") == 0 ||
        process->pid != input->pid ||
        process->requested_port != input->requested_port ||
        process->actual_port != input->actual_port ||
        (network_id[0] != '\0' && strcmp(process->network_id, network_id) != 0)) {
      continue;
    }

    active_listener = listener_scan_ok ? pm_find_listener_by_process_endpoint(&listeners, process) : NULL;
    if (active_listener != NULL) {
      (void)pm_adopt_listener_owner(process, active_listener);
      retained = 1;
      continue;
    }

    pm_copy(process->status, sizeof(process->status), "stopped");
    pm_iso_now(process->stopped_at, sizeof(process->stopped_at));
    process->url[0] = '\0';
    pm_clear_missing_listener_state(process);
    released = 1;
  }

  if (released || retained) {
    pm_listener_cache_invalidate(state);
    pm_write_route_tables(state);
  }

  free(listeners.items);
  return pm_buffer_append(payload, released ? "true" : "false");
}

static char *pm_build_injected_command(const char *command, const char *mode, int port) {
  char port_text[16];
  const char *needle = "${port}";
  size_t command_length = strlen(command);
  size_t needle_length = strlen(needle);
  char *result;

  snprintf(port_text, sizeof(port_text), "%d", port);
  if (strcmp(mode, "argument") == 0) {
    result = (char *)malloc(command_length + strlen(port_text) + 9);
    if (result != NULL) {
      snprintf(result, command_length + strlen(port_text) + 9, "%s --port %s", command, port_text);
    }
    return result;
  }

  if (strcmp(mode, "template") != 0) {
    return strdup(command);
  }

  size_t replacements = 0;
  for (const char *cursor = command; (cursor = strstr(cursor, needle)) != NULL; cursor += needle_length) {
    replacements++;
  }

  result = (char *)malloc(command_length + replacements * (strlen(port_text) - needle_length) + 1);
  if (result == NULL) {
    return NULL;
  }

  char *write_cursor = result;
  const char *read_cursor = command;
  const char *match;
  while ((match = strstr(read_cursor, needle)) != NULL) {
    size_t chunk = (size_t)(match - read_cursor);
    memcpy(write_cursor, read_cursor, chunk);
    write_cursor += chunk;
    memcpy(write_cursor, port_text, strlen(port_text));
    write_cursor += strlen(port_text);
    read_cursor = match + needle_length;
  }
  strcpy(write_cursor, read_cursor);
  return result;
}

static pid_t pm_spawn_shell(const pm_start_input *input, int actual_port, const char *routes_json, const char *routes_file) {
  char *command = pm_build_injected_command(input->command, input->injection_mode, actual_port);
  pid_t child;

  if (command == NULL) {
    return -1;
  }

  child = fork();
  if (child == 0) {
    char actual_text[16];
    char logical_text[16];
    int devnull;

    snprintf(actual_text, sizeof(actual_text), "%d", actual_port);
    snprintf(logical_text, sizeof(logical_text), "%d", input->requested_port);
    setenv("PORT", actual_text, 1);
    setenv("PORT_MANAGER_ACTUAL_PORT", actual_text, 1);
    setenv("PORT_MANAGER_LOGICAL_PORT", logical_text, 1);
    setenv("PORT_MANAGER_ROUTES", routes_json, 1);
    setenv("PORT_MANAGER_ROUTES_FILE", routes_file, 1);
    chdir(input->cwd);

    devnull = open("/dev/null", O_RDWR);
    if (devnull >= 0) {
      dup2(devnull, STDIN_FILENO);
      dup2(devnull, STDOUT_FILENO);
      dup2(devnull, STDERR_FILENO);
      if (devnull > STDERR_FILENO) {
        close(devnull);
      }
    }

    execl("/bin/sh", "sh", "-c", command, (char *)NULL);
    _exit(127);
  }

  free(command);
  return child;
}

static int pm_append_routes_env_json(pm_agent_state *state, const pm_route *extra, pm_buffer *buffer) {
  pm_route_list routes;
  int result;

  if (pm_build_routes(state, extra, &routes) != 0) {
    return -1;
  }
  result = pm_append_routes_json(buffer, routes.items, routes.count);
  free(routes.items);
  return result;
}

static int pm_start_process_with_actual(pm_agent_state *state, const pm_start_input *input, int actual_port, const char *existing_id, pm_process **out_process) {
  pm_route pending_route;
  pm_buffer routes_json;
  char route_file[PM_TEXT];
  pid_t child;
  pm_process *process;
  char now[PM_TIME];

  memset(&pending_route, 0, sizeof(pending_route));
  pending_route.logical_port = input->requested_port;
  pending_route.actual_port = actual_port;
  pm_copy(pending_route.route_direction, sizeof(pending_route.route_direction), "listen");
  pm_copy(pending_route.host, sizeof(pending_route.host), input->host);
  pm_copy(pending_route.cwd, sizeof(pending_route.cwd), input->cwd);
  pm_copy(pending_route.process_name, sizeof(pending_route.process_name), input->name);
  pm_copy(pending_route.status, sizeof(pending_route.status), "running");
  pm_copy(pending_route.source, sizeof(pending_route.source), "managed");

  pm_buffer_init(&routes_json);
  if (pm_append_routes_env_json(state, &pending_route, &routes_json) != 0) {
    pm_buffer_free(&routes_json);
    return -1;
  }

  pm_scoped_route_table_path(state->route_table_path, "", route_file, sizeof(route_file));
  child = pm_spawn_shell(input, actual_port, routes_json.data, route_file);
  pm_buffer_free(&routes_json);
  if (child <= 0) {
    return -1;
  }

  if (existing_id != NULL && existing_id[0] != '\0') {
    process = pm_find_process(state, existing_id);
    if (process == NULL) {
      return -1;
    }
  } else {
    if (pm_reserve_processes(state, state->process_count + 1) != 0) {
      return -1;
    }
    process = &state->processes[state->process_count++];
    memset(process, 0, sizeof(*process));
    snprintf(process->id, sizeof(process->id), "managed-process-%lu", state->next_process_id++);
  }

  pm_iso_now(now, sizeof(now));
  process->pid = child;
  pm_copy(process->name, sizeof(process->name), input->name);
  pm_copy(process->command, sizeof(process->command), input->command);
  pm_copy(process->cwd, sizeof(process->cwd), input->cwd);
  process->network_id[0] = '\0';
  process->requested_port = input->requested_port;
  process->actual_port = actual_port;
  pm_copy(process->host, sizeof(process->host), input->host);
  pm_copy(process->status, sizeof(process->status), "running");
  pm_copy(process->started_at, sizeof(process->started_at), now);
  process->stopped_at[0] = '\0';
  pm_url(process->url, sizeof(process->url), input->host, actual_port);
  process->error_message[0] = '\0';
  pm_copy(process->source, sizeof(process->source), "managed");
  process->child_owned = 1;
  pm_clear_missing_listener_state(process);
  pm_copy(process->injection_mode, sizeof(process->injection_mode), input->injection_mode);
  process->scan_range = input->scan_range;
  pm_copy(process->scan_direction, sizeof(process->scan_direction), input->scan_direction);
  pm_copy(process->routing_mode, sizeof(process->routing_mode), input->routing_mode);
  process->virtual_start = input->virtual_start;
  process->virtual_end = input->virtual_end;

  pm_listener_cache_invalidate(state);
  pm_write_route_tables(state);
  *out_process = process;
  return 0;
}

int pm_state_start_process(pm_agent_state *state, const pm_start_input *input, pm_buffer *payload) {
  pm_allocate_input allocation_input;
  int actual_port;
  pm_process *process;

  memset(&allocation_input, 0, sizeof(allocation_input));
  pm_copy(allocation_input.name, sizeof(allocation_input.name), input->name);
  pm_copy(allocation_input.command, sizeof(allocation_input.command), input->command);
  pm_copy(allocation_input.cwd, sizeof(allocation_input.cwd), input->cwd);
  pm_copy(allocation_input.host, sizeof(allocation_input.host), input->host);
  pm_copy(allocation_input.route_direction, sizeof(allocation_input.route_direction), "listen");
  allocation_input.requested_port = input->requested_port;
  allocation_input.scan_range = input->scan_range;
  pm_copy(allocation_input.scan_direction, sizeof(allocation_input.scan_direction), input->scan_direction);
  pm_copy(allocation_input.routing_mode, sizeof(allocation_input.routing_mode), input->routing_mode);
  allocation_input.virtual_start = input->virtual_start;
  allocation_input.virtual_end = input->virtual_end;

  actual_port = strcmp(input->routing_mode, "hashed") == 0 ? pm_route_hashed(state, &allocation_input) : pm_route_nearest(state, &allocation_input);
  if (actual_port <= 0 || pm_start_process_with_actual(state, input, actual_port, NULL, &process) != 0) {
    return -1;
  }

  return pm_append_process_json(payload, process);
}

static int pm_signal_number(const char *signal_name) {
  if (signal_name == NULL || signal_name[0] == '\0' || strcmp(signal_name, "SIGTERM") == 0) {
    return SIGTERM;
  }
  if (strcmp(signal_name, "SIGKILL") == 0) {
    return SIGKILL;
  }
  if (strcmp(signal_name, "SIGINT") == 0) {
    return SIGINT;
  }
  if (strcmp(signal_name, "SIGHUP") == 0) {
    return SIGHUP;
  }
  if (strcmp(signal_name, "SIGQUIT") == 0) {
    return SIGQUIT;
  }
  return SIGTERM;
}

int pm_state_stop_process(pm_agent_state *state, const char *id, const char *signal_name, pm_buffer *payload) {
  pm_process *process = pm_find_process(state, id);

  if (process == NULL) {
    return pm_buffer_append(payload, "null");
  }

  if (strcmp(process->status, "stopped") != 0 && process->child_owned) {
    kill(process->pid, pm_signal_number(signal_name));
  }

  pm_copy(process->status, sizeof(process->status), "stopped");
  pm_iso_now(process->stopped_at, sizeof(process->stopped_at));
  process->url[0] = '\0';
  pm_clear_missing_listener_state(process);
  pm_listener_cache_invalidate(state);
  pm_write_route_tables(state);
  return pm_append_process_json(payload, process);
}

int pm_state_restart_process(pm_agent_state *state, const char *id, const char *signal_name, pm_buffer *payload) {
  pm_process *process = pm_find_process(state, id);
  pm_start_input input;
  pm_allocate_input allocation_input;
  int actual_port;

  if (process == NULL) {
    return pm_buffer_append(payload, "null");
  }

  if (strcmp(process->source, "managed") != 0) {
    return -1;
  }

  memset(&input, 0, sizeof(input));
  pm_copy(input.name, sizeof(input.name), process->name);
  pm_copy(input.command, sizeof(input.command), process->command);
  pm_copy(input.cwd, sizeof(input.cwd), process->cwd);
  pm_copy(input.host, sizeof(input.host), process->host[0] ? process->host : "localhost");
  pm_copy(input.injection_mode, sizeof(input.injection_mode), process->injection_mode[0] ? process->injection_mode : "env");
  input.requested_port = process->requested_port;
  input.scan_range = process->scan_range > 0 ? process->scan_range : PM_DEFAULT_SCAN_RANGE;
  pm_copy(input.scan_direction, sizeof(input.scan_direction), process->scan_direction[0] ? process->scan_direction : "up");
  pm_copy(input.routing_mode, sizeof(input.routing_mode), process->routing_mode[0] ? process->routing_mode : "nearest");
  input.virtual_start = process->virtual_start > 0 ? process->virtual_start : PM_DEFAULT_VIRTUAL_START;
  input.virtual_end = process->virtual_end > 0 ? process->virtual_end : PM_DEFAULT_VIRTUAL_END;

  if (strcmp(process->status, "stopped") != 0) {
    kill(process->pid, pm_signal_number(signal_name));
    pm_copy(process->status, sizeof(process->status), "stopped");
    pm_iso_now(process->stopped_at, sizeof(process->stopped_at));
    process->url[0] = '\0';
    pm_clear_missing_listener_state(process);
  }

  memset(&allocation_input, 0, sizeof(allocation_input));
  pm_copy(allocation_input.name, sizeof(allocation_input.name), input.name);
  pm_copy(allocation_input.command, sizeof(allocation_input.command), input.command);
  pm_copy(allocation_input.cwd, sizeof(allocation_input.cwd), input.cwd);
  pm_copy(allocation_input.host, sizeof(allocation_input.host), input.host);
  pm_copy(allocation_input.route_direction, sizeof(allocation_input.route_direction), "listen");
  allocation_input.requested_port = input.requested_port;
  allocation_input.scan_range = input.scan_range;
  pm_copy(allocation_input.scan_direction, sizeof(allocation_input.scan_direction), input.scan_direction);
  pm_copy(allocation_input.routing_mode, sizeof(allocation_input.routing_mode), input.routing_mode);
  allocation_input.virtual_start = input.virtual_start;
  allocation_input.virtual_end = input.virtual_end;

  actual_port = strcmp(input.routing_mode, "hashed") == 0 ? pm_route_hashed(state, &allocation_input) : pm_route_nearest(state, &allocation_input);
  if (actual_port <= 0 || pm_start_process_with_actual(state, &input, actual_port, id, &process) != 0) {
    return -1;
  }

  return pm_append_process_json(payload, process);
}

int pm_state_remove_process(pm_agent_state *state, const char *id, pm_buffer *payload) {
  for (size_t index = 0; index < state->process_count; index++) {
    if (strcmp(state->processes[index].id, id) == 0) {
      pm_process removed = state->processes[index];
      memmove(&state->processes[index], &state->processes[index + 1], (state->process_count - index - 1) * sizeof(pm_process));
      state->process_count--;
      pm_listener_cache_invalidate(state);
      pm_write_route_tables(state);
      return pm_append_process_json(payload, &removed);
    }
  }

  if (strncmp(id, "detected:", 9) == 0) {
    pm_string_array_add(&state->suppressed_detected_ids, &state->suppressed_count, &state->suppressed_capacity, id);
  }

  return pm_buffer_append(payload, "null");
}

static int pm_listener_is_tracked(pm_agent_state *state, const pm_listener *listener) {
  for (size_t index = 0; index < state->process_count; index++) {
    pm_process *process = &state->processes[index];
    if (
      strcmp(process->status, "stopped") != 0 &&
      process->pid == listener->pid &&
      process->actual_port == listener->port &&
      pm_endpoint_hosts_match(listener->local_address, process->host)
    ) {
      return 1;
    }
  }

  return 0;
}

static const char *pm_url_host_from_listener(const char *address) {
  if (address == NULL || address[0] == '\0' || strcmp(address, "*") == 0 || strcmp(address, "0.0.0.0") == 0 || strcmp(address, "::") == 0) {
    return "localhost";
  }

  return address;
}

static int pm_append_listener_json(pm_buffer *buffer, const pm_listener *listener) {
  if (pm_buffer_append(buffer, "{\"id\":") != 0 ||
      pm_json_append_string(buffer, listener->id) != 0 ||
      pm_buffer_append(buffer, ",\"protocol\":\"tcp\",\"localAddress\":") != 0 ||
      pm_json_append_string(buffer, listener->local_address) != 0 ||
      pm_buffer_appendf(buffer, ",\"port\":%d", listener->port) != 0) {
    return -1;
  }

  if (listener->pid > 0 && pm_buffer_appendf(buffer, ",\"pid\":%ld", (long)listener->pid) != 0) {
    return -1;
  }
  if (listener->process_name[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"processName\":") != 0 || pm_json_append_string(buffer, listener->process_name) != 0)) {
    return -1;
  }
  if (listener->command[0] != '\0' &&
      (pm_buffer_append(buffer, ",\"command\":") != 0 || pm_json_append_string(buffer, listener->command) != 0)) {
    return -1;
  }

  return pm_buffer_append(buffer, ",\"source\":") ||
         pm_json_append_string(buffer, listener->source) ||
         pm_buffer_append(buffer, ",\"updatedAt\":") ||
         pm_json_append_string(buffer, listener->updated_at) ||
         pm_buffer_append_char(buffer, '}');
}

static int pm_append_detected_process_json(pm_buffer *buffer, const pm_listener *listener) {
  char id[PM_TEXT];
  char name[PM_SMALL];
  char url[PM_TEXT];

  snprintf(id, sizeof(id), "detected:%s", listener->id);
  if (listener->process_name[0] != '\0') {
    pm_copy(name, sizeof(name), listener->process_name);
  } else {
    snprintf(name, sizeof(name), "Port %d", listener->port);
  }
  pm_url(url, sizeof(url), pm_url_host_from_listener(listener->local_address), listener->port);

  return pm_buffer_append(buffer, "{\"id\":") ||
         pm_json_append_string(buffer, id) ||
         pm_buffer_appendf(buffer, ",\"pid\":%ld,\"name\":", (long)listener->pid) ||
         pm_json_append_string(buffer, name) ||
         pm_buffer_append(buffer, ",\"command\":") ||
         pm_json_append_string(buffer, listener->command[0] ? listener->command : name) ||
         pm_buffer_append(buffer, ",\"cwd\":\"\",\"requestedPort\":") ||
         pm_buffer_appendf(buffer, "%d,\"actualPort\":%d,\"status\":\"running\",\"startedAt\":", listener->port, listener->port) ||
         pm_json_append_string(buffer, listener->updated_at) ||
         pm_buffer_append(buffer, ",\"url\":") ||
         pm_json_append_string(buffer, url) ||
         pm_buffer_append(buffer, ",\"source\":\"detected\"}");
}

int pm_state_snapshot(pm_agent_state *state, pm_buffer *payload) {
  pm_listener_list listeners = {0};
  pm_route_list routes;
  char updated_at[PM_TIME];
  int listener_scan_fresh = 0;

  pm_iso_now(updated_at, sizeof(updated_at));
  if (pm_cleanup_pending(state)) {
    pm_write_route_tables(state);
  }
  if (pm_state_needs_external_listener_fresh_scan(state)) {
    pm_listener_cache_invalidate(state);
  }
  if (pm_scan_lsof_cached(state, &listeners, updated_at, sizeof(updated_at), &listener_scan_fresh) == 0 &&
      listener_scan_fresh &&
      pm_reconcile_external_processes_with_listeners(state, &listeners, updated_at)) {
    pm_write_route_tables(state);
  }
  for (size_t index = 0; index < listeners.count; index++) {
    if (pm_listener_is_tracked(state, &listeners.items[index])) {
      pm_copy(listeners.items[index].source, sizeof(listeners.items[index].source), "managed");
    }
  }

  if (pm_build_routes(state, NULL, &routes) != 0) {
    free(listeners.items);
    return -1;
  }

  if (pm_buffer_appendf(payload, "{\"agentPid\":%ld,\"daemon\":{\"status\":\"running\",\"pid\":%ld,\"startedAt\":", (long)state->agent_pid, (long)state->agent_pid) != 0 ||
      pm_json_append_string(payload, state->started_at) != 0 ||
      pm_buffer_append(payload, ",\"updatedAt\":") != 0 ||
      pm_json_append_string(payload, updated_at) != 0 ||
      pm_buffer_append(payload, ",\"routeTablePath\":") != 0 ||
      pm_json_append_string(payload, state->route_table_path) != 0 ||
      pm_buffer_append(payload, ",\"agentMainPath\":") != 0 ||
      pm_json_append_string(payload, state->agent_main_path) != 0 ||
      pm_buffer_appendf(payload, ",\"listenerCount\":%zu,\"routeCount\":%zu,\"monitoringAllListeners\":true},\"processes\":[", listeners.count, routes.count) != 0) {
    free(listeners.items);
    free(routes.items);
    return -1;
  }

  int needs_comma = 0;
  for (size_t index = 0; index < state->process_count; index++) {
    if (needs_comma && pm_buffer_append_char(payload, ',') != 0) {
      return -1;
    }
    if (pm_append_process_json(payload, &state->processes[index]) != 0) {
      return -1;
    }
    needs_comma = 1;
  }

  for (size_t index = 0; index < listeners.count; index++) {
    char detected_id[PM_TEXT];
    if (pm_listener_is_tracked(state, &listeners.items[index])) {
      continue;
    }
    snprintf(detected_id, sizeof(detected_id), "detected:%s", listeners.items[index].id);
    if (pm_string_array_contains(state->suppressed_detected_ids, state->suppressed_count, detected_id)) {
      continue;
    }
    if (needs_comma && pm_buffer_append_char(payload, ',') != 0) {
      return -1;
    }
    if (pm_append_detected_process_json(payload, &listeners.items[index]) != 0) {
      return -1;
    }
    needs_comma = 1;
  }

  if (pm_buffer_append(payload, "],\"listeners\":[") != 0) {
    return -1;
  }
  for (size_t index = 0; index < listeners.count; index++) {
    if (index > 0 && pm_buffer_append_char(payload, ',') != 0) {
      return -1;
    }
    if (pm_append_listener_json(payload, &listeners.items[index]) != 0) {
      return -1;
    }
  }

  if (pm_buffer_append(payload, "],\"routes\":") != 0 ||
      pm_append_routes_json(payload, routes.items, routes.count) != 0 ||
      pm_buffer_append(payload, ",\"updatedAt\":") != 0 ||
      pm_json_append_string(payload, updated_at) != 0 ||
      pm_buffer_append_char(payload, '}') != 0) {
    free(listeners.items);
    free(routes.items);
    return -1;
  }

  free(listeners.items);
  free(routes.items);
  return 0;
}

int pm_state_daemon_status(pm_agent_state *state, pm_buffer *payload) {
  pm_route_list routes;
  char updated_at[PM_TIME];

  pm_iso_now(updated_at, sizeof(updated_at));
  if (pm_cleanup_pending(state)) {
    pm_write_route_tables(state);
  }
  if (pm_build_routes(state, NULL, &routes) != 0) {
    return -1;
  }

  if (pm_buffer_appendf(payload, "{\"status\":\"running\",\"pid\":%ld,\"startedAt\":", (long)state->agent_pid) != 0 ||
      pm_json_append_string(payload, state->started_at) != 0 ||
      pm_buffer_append(payload, ",\"updatedAt\":") != 0 ||
      pm_json_append_string(payload, updated_at) != 0 ||
      pm_buffer_append(payload, ",\"routeTablePath\":") != 0 ||
      pm_json_append_string(payload, state->route_table_path) != 0 ||
      pm_buffer_append(payload, ",\"agentMainPath\":") != 0 ||
      pm_json_append_string(payload, state->agent_main_path) != 0 ||
      pm_buffer_appendf(payload, ",\"listenerCount\":%zu,\"routeCount\":%zu,\"monitoringAllListeners\":true}", state->listener_cache_count, routes.count) != 0) {
    free(routes.items);
    return -1;
  }

  free(routes.items);
  return 0;
}

int pm_state_refresh_snapshot(pm_agent_state *state, pm_buffer *payload) {
  if (pm_cleanup_pending(state)) {
    pm_write_route_tables(state);
  }
  pm_refresh_established_route_observations(state);
  pm_write_route_tables(state);
  return pm_state_snapshot(state, payload);
}

int pm_state_reap_children(pm_agent_state *state) {
  int changed = 0;

  for (;;) {
    int status = 0;
    pid_t pid = waitpid(-1, &status, WNOHANG);
    if (pid <= 0) {
      break;
    }

    for (size_t index = 0; index < state->process_count; index++) {
      pm_process *process = &state->processes[index];
      if (process->pid == pid && process->child_owned && strcmp(process->status, "running") == 0) {
        pm_copy(process->status, sizeof(process->status), "stopped");
        pm_iso_now(process->stopped_at, sizeof(process->stopped_at));
        process->url[0] = '\0';
        pm_clear_missing_listener_state(process);
        pm_listener_cache_invalidate(state);
        changed = 1;
      }
    }
  }

  if (changed) {
    pm_write_route_tables(state);
  }

  return changed;
}

int pm_state_listener_signature(pm_agent_state *state, pm_buffer *signature) {
  pm_listener_list listeners = {0};
  char updated_at[PM_TIME];
  int listener_scan_fresh = 0;

  if (pm_state_needs_external_listener_fresh_scan(state)) {
    pm_listener_cache_invalidate(state);
  }
  if (pm_scan_lsof_cached(state, &listeners, updated_at, sizeof(updated_at), &listener_scan_fresh) != 0) {
    return -1;
  }
  if (listener_scan_fresh && pm_reconcile_external_processes_with_listeners(state, &listeners, updated_at)) {
    pm_write_route_tables(state);
  }

  for (size_t index = 0; index < listeners.count; index++) {
    pm_buffer_appendf(signature, "%ld:%s:%d;", (long)listeners.items[index].pid, listeners.items[index].local_address, listeners.items[index].port);
  }

  free(listeners.items);
  return 0;
}

#define _GNU_SOURCE

#include <arpa/inet.h>
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

/*
 * Port Manager native socket hook.
 *
 * This library is injected into terminal-launched development processes. It
 * rewrites bind(logicalPort) to bind(actualPort), registers the resulting
 * route with the daemon, translates connect(logicalPort) to actualPort, and
 * maps getsockname(actualPort) back to logicalPort so the process still sees
 * its requested logical port.
 */

#define PM_MAX_RESPONSE 65536
#define PM_MAX_REQUEST 8192
#define PM_MAX_TEXT 512
#define PM_MAX_PATH 1024
#define PM_MAX_SHEBANG 4096
#define PM_MAX_SCRIPT_LINE 4096
#define PM_ROUTE_MAPPING_INITIAL_CAPACITY 128
#define PM_ROUTE_MAPPING_MAX_CAPACITY 65535
#define PM_MAX_ROUTE_OBJECT 8192
#define PM_ROUTE_FILE_CACHE_INITIAL_CAPACITY 128
#define PM_ROUTE_FILE_CACHE_MAX_CAPACITY 65535
#define PM_ROUTE_TABLE_TTL_SECONDS_ENV "PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS"
#define PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS 15
#define PM_DEFAULT_SCAN_RANGE 20
#define PM_DEFAULT_VIRTUAL_START 53000
#define PM_DEFAULT_VIRTUAL_END 59999
#define PM_DEFAULT_FIXED_PROTOCOL_PORTS "22,25,53,80,110,143,389,443,465,587,993,995,1433,1521,1883,3306,33060,4222,5432,5671,5672,6379,8883,9092,9200,9300,11211,15672,27017,50051"
#define PM_AGENT_ROUNDTRIP_TIMEOUT_MS 60000
#define PM_BIND_ALLOCATION_ATTEMPTS 4
#define PM_COMPOSE_ROUTE_WAIT_MS 10000
#define PM_CONNECT_ROUTE_WAIT_MS 1000
#define PM_ROUTE_ALLOCATION_TTL_MS 300000
#define PM_SEND_ALLOCATION_JOIN_WAIT_MS 1000
#define PM_SEND_ALLOCATION_LOCK_STALE_MS 10000
#define PM_SEND_ALLOCATION_LOCK_POLL_MS 25
#define PM_ACTUAL_LOOPBACK_HOST_ENV "PORT_MANAGER_ACTUAL_LOOPBACK_HOST"
#define PM_NETWORK_LOOPBACK_HOST_ENV "PORT_MANAGER_NETWORK_LOOPBACK_HOST"
#define PM_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV "PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE"
#define PM_TERMINAL_SCOPE_LISTENER_MODE "terminal-scope-listener"
#define PM_LOOPBACK_ADDRESS_ONLY_MODE "loopback-address-only"

typedef int (*pm_bind_fn)(int, const struct sockaddr *, socklen_t);
typedef int (*pm_connect_fn)(int, const struct sockaddr *, socklen_t);
typedef int (*pm_getsockname_fn)(int, struct sockaddr *, socklen_t *);
typedef int (*pm_execve_fn)(const char *, char *const [], char *const []);
typedef int (*pm_execv_fn)(const char *, char *const []);
typedef int (*pm_execvp_fn)(const char *, char *const []);
typedef int (*pm_posix_spawn_fn)(
  pid_t *,
  const char *,
  const posix_spawn_file_actions_t *,
  const posix_spawnattr_t *,
  char *const [],
  char *const []);
typedef int (*pm_posix_spawnp_fn)(
  pid_t *,
  const char *,
  const posix_spawn_file_actions_t *,
  const posix_spawnattr_t *,
  char *const [],
  char *const []);

typedef struct {
  int logical_port;
  int actual_port;
  long expires_at_ms;
  char allocation_id[PM_MAX_TEXT];
  char host[128];
  char network_id[PM_MAX_TEXT];
} pm_route_mapping;

typedef struct {
  char path[PM_MAX_PATH];
  time_t mtime_sec;
  long mtime_nsec;
  off_t size;
  struct pm_cached_route *routes;
  size_t route_count;
  unsigned long last_used;
} pm_route_file_cache_entry;

typedef struct pm_cached_route {
  int logical_port;
  int actual_port;
  int has_network_id;
  int has_cwd;
  int is_compose;
  char host[128];
  char network_id[PM_MAX_TEXT];
  char cwd[PM_MAX_TEXT];
  char route_direction[32];
} pm_cached_route;

#if defined(__APPLE__)
static pm_bind_fn pm_real_bind = bind;
static pm_connect_fn pm_real_connect = connect;
static pm_getsockname_fn pm_real_getsockname = getsockname;
static pm_execve_fn pm_real_execve = execve;
static pm_execv_fn pm_real_execv = execv;
static pm_execvp_fn pm_real_execvp = execvp;
static pm_posix_spawn_fn pm_real_posix_spawn = posix_spawn;
static pm_posix_spawnp_fn pm_real_posix_spawnp = posix_spawnp;
#else
static pm_bind_fn pm_real_bind = NULL;
static pm_connect_fn pm_real_connect = NULL;
static pm_getsockname_fn pm_real_getsockname = NULL;
static pm_execve_fn pm_real_execve = NULL;
static pm_execv_fn pm_real_execv = NULL;
static pm_execvp_fn pm_real_execvp = NULL;
static pm_posix_spawn_fn pm_real_posix_spawn = NULL;
static pm_posix_spawnp_fn pm_real_posix_spawnp = NULL;
#endif
static __thread int pm_hook_depth = 0;
static pm_route_mapping *pm_routes = NULL;
static size_t pm_route_count = 0;
static size_t pm_route_capacity = 0;
static pm_route_file_cache_entry *pm_route_file_cache = NULL;
static size_t pm_route_file_cache_count = 0;
static size_t pm_route_file_cache_capacity = 0;
static unsigned long pm_request_sequence = 1;
static unsigned long pm_route_file_cache_tick = 1;
static pthread_mutex_t pm_route_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t pm_route_file_cache_mutex = PTHREAD_MUTEX_INITIALIZER;

static void pm_release_process_routes(void);
static void pm_clear_memory_routes(void);
static void pm_clear_route_file_cache(void);
static const char *pm_actual_loopback_host(void);
static const char *pm_current_network_id(void);
static const char *pm_network_loopback_host(void);
static int pm_connect_route_table_lookup(int logical_port, char *target_host, size_t target_host_size, int *is_compose_route);
extern char **environ;

static int pm_hook_enabled(void) {
  const char *disabled = getenv("PORT_MANAGER_HOOK_DISABLED");
  const char *enabled = getenv("PORT_MANAGER_HOOK");

  if (disabled != NULL && strcmp(disabled, "1") == 0) {
    return 0;
  }

  return enabled == NULL || strcmp(enabled, "0") != 0;
}

static int pm_debug_enabled(void) {
  const char *debug = getenv("PORT_MANAGER_HOOK_DEBUG");
  return debug != NULL && strcmp(debug, "1") == 0;
}

static void pm_debug(const char *format, ...) {
  va_list args;

  if (!pm_debug_enabled()) {
    return;
  }

  fprintf(stderr, "[portmanager-hook pid=%ld] ", (long)getpid());
  va_start(args, format);
  vfprintf(stderr, format, args);
  va_end(args);
  fprintf(stderr, "\n");
}

static const char *pm_path_basename(const char *path) {
  const char *slash;

  if (path == NULL || path[0] == '\0') {
    return NULL;
  }

  slash = strrchr(path, '/');
  return slash == NULL ? path : slash + 1;
}

static int pm_env_flag_is_one(const char *name) {
  const char *value = getenv(name);
  return value != NULL && strcmp(value, "1") == 0;
}

#if defined(__APPLE__)
#define PM_PRELOAD_ENV "DYLD_INSERT_LIBRARIES"
#define PM_PRELOAD_HINT_ENV "PORT_MANAGER_DYLD_INSERT_LIBRARIES"
#else
#define PM_PRELOAD_ENV "LD_PRELOAD"
#define PM_PRELOAD_HINT_ENV "PORT_MANAGER_LD_PRELOAD"
#endif

typedef struct {
  char **envp;
  char *preload_assignment;
} pm_child_environment;

typedef struct {
  const char *target;
  char **argv;
  char *resolved_script_path;
  char *interpreter_path;
  char *argv_storage;
  char **envp;
  char **envp_storage;
} pm_child_exec_plan;

static const char *pm_envp_value(char *const envp[], const char *name) {
  size_t name_length;

  if (envp == NULL || name == NULL) {
    return NULL;
  }

  name_length = strlen(name);
  for (size_t index = 0; envp[index] != NULL; index++) {
    if (strncmp(envp[index], name, name_length) == 0 && envp[index][name_length] == '=') {
      return envp[index] + name_length + 1;
    }
  }

  return NULL;
}

static int pm_envp_value_is(char *const envp[], const char *name, const char *expected) {
  const char *value = pm_envp_value(envp, name);
  return value != NULL && strcmp(value, expected) == 0;
}

static int pm_preload_value_is_normalized(const char *value, const char *hook_path) {
  size_t hook_length;
  const char *cursor;
  int segment_index = 0;
  int saw_hook = 0;

  if (value == NULL || value[0] == '\0' || hook_path == NULL || hook_path[0] == '\0') {
    return 0;
  }

  hook_length = strlen(hook_path);
  cursor = value;
  while (*cursor != '\0') {
    const char *end = strchr(cursor, ':');
    size_t segment_length = end == NULL ? strlen(cursor) : (size_t)(end - cursor);
    int is_hook = segment_length == hook_length && strncmp(cursor, hook_path, segment_length) == 0;

    if (segment_length == 0) {
      return 0;
    }

    if (is_hook) {
      if (segment_index != 0 || saw_hook) {
        return 0;
      }
      saw_hook = 1;
    } else if (segment_index == 0) {
      return 0;
    }

    if (end == NULL) {
      break;
    }
    if (end[1] == '\0') {
      return 0;
    }

    cursor = end + 1;
    segment_index++;
  }

  return saw_hook;
}

static char *pm_make_preload_assignment(const char *hook_path, const char *current_value) {
  char *assignment;
  size_t size;
  size_t offset;
  size_t hook_length;
  const char *cursor;

  if (hook_path == NULL || hook_path[0] == '\0') {
    return NULL;
  }

  hook_length = strlen(hook_path);
  size = strlen(PM_PRELOAD_ENV) + hook_length + (current_value == NULL ? 0 : strlen(current_value)) + 3;
  assignment = malloc(size);
  if (assignment == NULL) {
    return NULL;
  }

  offset = (size_t)snprintf(assignment, size, "%s=%s", PM_PRELOAD_ENV, hook_path);
  if (current_value == NULL || current_value[0] == '\0') {
    return assignment;
  }

  cursor = current_value;
  while (*cursor != '\0') {
    const char *end = strchr(cursor, ':');
    size_t segment_length = end == NULL ? strlen(cursor) : (size_t)(end - cursor);
    int is_hook = segment_length == hook_length && strncmp(cursor, hook_path, segment_length) == 0;

    if (segment_length > 0 && !is_hook) {
      assignment[offset++] = ':';
      memcpy(assignment + offset, cursor, segment_length);
      offset += segment_length;
      assignment[offset] = '\0';
    }

    if (end == NULL) {
      break;
    }

    cursor = end + 1;
  }

  return assignment;
}

static pm_child_environment pm_prepare_child_environment(char *const envp[]) {
  pm_child_environment prepared = { (char **)envp, NULL };
  const char *hook_path;
  const char *current_preload;
  char *assignment;
  char **updated_envp;
  size_t count = 0;
  size_t preload_index = (size_t)-1;
  size_t name_length = strlen(PM_PRELOAD_ENV);

  /*
   * Protected launchers can remove DYLD_INSERT_LIBRARIES while preserving the
   * Port Manager hint variable. Repairing every child exec makes package
   * manager lifecycle commands inherit the socket hook even when they are not
   * serving traffic. Runtime/package-bin shims opt into repair only for the
   * execution boundary that must keep routing semantics.
   */
  if (!pm_hook_enabled() || pm_hook_depth > 0 || envp == NULL ||
      pm_envp_value_is(envp, "PORT_MANAGER_HOOK_DISABLED", "1") ||
      pm_envp_value_is(envp, "PORT_MANAGER_HOOK", "0") ||
      !pm_envp_value_is(envp, "PORT_MANAGER_PRELOAD_REPAIR", "1")) {
    return prepared;
  }

  hook_path = pm_envp_value(envp, PM_PRELOAD_HINT_ENV);
  current_preload = pm_envp_value(envp, PM_PRELOAD_ENV);
  if (hook_path == NULL || hook_path[0] == '\0' || pm_preload_value_is_normalized(current_preload, hook_path)) {
    return prepared;
  }

  while (envp[count] != NULL) {
    if (strncmp(envp[count], PM_PRELOAD_ENV, name_length) == 0 && envp[count][name_length] == '=') {
      preload_index = count;
    }
    count++;
  }

  assignment = pm_make_preload_assignment(hook_path, current_preload);
  if (assignment == NULL) {
    return prepared;
  }

  updated_envp = malloc(sizeof(char *) * (count + (preload_index == (size_t)-1 ? 2 : 1)));
  if (updated_envp == NULL) {
    free(assignment);
    return prepared;
  }

  for (size_t index = 0; index < count; index++) {
    updated_envp[index] = preload_index == index ? assignment : envp[index];
  }

  if (preload_index == (size_t)-1) {
    updated_envp[count] = assignment;
    updated_envp[count + 1] = NULL;
  } else {
    updated_envp[count] = NULL;
  }

  prepared.envp = updated_envp;
  prepared.preload_assignment = assignment;
  pm_debug("child preload restored variable=%s", PM_PRELOAD_ENV);
  return prepared;
}

static void pm_release_child_environment(pm_child_environment *prepared) {
  if (prepared == NULL || prepared->preload_assignment == NULL) {
    return;
  }

  free(prepared->envp);
  free(prepared->preload_assignment);
  prepared->envp = NULL;
  prepared->preload_assignment = NULL;
}

static int pm_is_executable_file(const char *path) {
  struct stat stat_buffer;

  return path != NULL &&
    path[0] != '\0' &&
    stat(path, &stat_buffer) == 0 &&
    S_ISREG(stat_buffer.st_mode) &&
    access(path, X_OK) == 0;
}

static int pm_same_path_text(const char *left, const char *right) {
  char left_resolved[PM_MAX_PATH];
  char right_resolved[PM_MAX_PATH];

  if (left == NULL || right == NULL) {
    return 0;
  }

  if (realpath(left, left_resolved) == NULL) {
    snprintf(left_resolved, sizeof(left_resolved), "%s", left);
  }

  if (realpath(right, right_resolved) == NULL) {
    snprintf(right_resolved, sizeof(right_resolved), "%s", right);
  }

  return strcmp(left_resolved, right_resolved) == 0;
}

static int pm_is_node_package_binary_path(const char *path) {
  return path != NULL &&
    (strstr(path, "/node_modules/.bin/") != NULL ||
     strncmp(path, "node_modules/.bin/", 18) == 0);
}

static int pm_find_executable_on_env_path(
  const char *tool_name,
  char *const envp[],
  char *buffer,
  size_t size,
  int allow_runtime_shim) {
  const char *path_env = pm_envp_value(envp, "PATH");
  const char *shim_directory = pm_envp_value(envp, "PORT_MANAGER_RUNTIME_SHIM_DIR");
  const char *cursor;

  if (tool_name == NULL || tool_name[0] == '\0' || strchr(tool_name, '/') != NULL ||
      path_env == NULL || path_env[0] == '\0' || buffer == NULL || size == 0) {
    return -1;
  }

  cursor = path_env;
  while (cursor != NULL) {
    const char *separator = strchr(cursor, ':');
    size_t directory_length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
    char directory[PM_MAX_PATH];
    char candidate[PM_MAX_PATH];

    if (directory_length == 0) {
      snprintf(directory, sizeof(directory), ".");
    } else if (directory_length >= sizeof(directory)) {
      goto next_path_entry;
    } else {
      memcpy(directory, cursor, directory_length);
      directory[directory_length] = '\0';
    }

    if (!allow_runtime_shim && shim_directory != NULL && shim_directory[0] != '\0' &&
        pm_same_path_text(directory, shim_directory)) {
      goto next_path_entry;
    }

    snprintf(candidate, sizeof(candidate), "%s/%s", directory, tool_name);
    if (pm_is_executable_file(candidate)) {
      snprintf(buffer, size, "%s", candidate);
      return 0;
    }

next_path_entry:
    if (separator == NULL) {
      break;
    }
    cursor = separator + 1;
  }

  return -1;
}

static int pm_resolve_exec_path(
  const char *path,
  char *const envp[],
  int allow_path_lookup,
  char *buffer,
  size_t size) {
  if (path == NULL || path[0] == '\0' || buffer == NULL || size == 0) {
    return -1;
  }

  if (strchr(path, '/') != NULL) {
    if (!pm_is_executable_file(path)) {
      return -1;
    }
    snprintf(buffer, size, "%s", path);
    return 0;
  }

  if (!allow_path_lookup) {
    return -1;
  }

  return pm_find_executable_on_env_path(path, envp, buffer, size, 1);
}

static int pm_read_shebang(const char *path, char *buffer, size_t size) {
  FILE *file;

  if (path == NULL || buffer == NULL || size == 0) {
    return -1;
  }

  file = fopen(path, "r");
  if (file == NULL) {
    return -1;
  }

  if (fgets(buffer, (int)size, file) == NULL) {
    fclose(file);
    return -1;
  }
  fclose(file);

  return strncmp(buffer, "#!", 2) == 0 ? 0 : -1;
}

static char *pm_trim_text(char *value) {
  char *end;

  while (value != NULL && (*value == ' ' || *value == '\t')) {
    value++;
  }

  if (value == NULL) {
    return NULL;
  }

  end = value + strlen(value);
  while (end > value && (end[-1] == '\n' || end[-1] == '\r' || end[-1] == ' ' || end[-1] == '\t')) {
    *--end = '\0';
  }

  return value;
}

static char *pm_duplicate_text(const char *value) {
  size_t size;
  char *copy;

  if (value == NULL) {
    return NULL;
  }

  size = strlen(value) + 1;
  copy = malloc(size);
  if (copy == NULL) {
    return NULL;
  }

  memcpy(copy, value, size);
  return copy;
}

static int pm_shebang_env_tool(const char *script_path, char *tool_name, size_t tool_name_size) {
  char line[PM_MAX_SHEBANG];
  char *cursor;
  char *tool_start;
  size_t tool_length;

  if (tool_name == NULL || tool_name_size == 0) {
    return -1;
  }

  tool_name[0] = '\0';
  if (pm_read_shebang(script_path, line, sizeof(line)) != 0) {
    return -1;
  }

  cursor = pm_trim_text(line + 2);
  if (cursor == NULL ||
      strncmp(cursor, "/usr/bin/env", 12) != 0 ||
      (cursor[12] != '\0' && cursor[12] != ' ' && cursor[12] != '\t')) {
    return -1;
  }

  cursor += 12;
  while (*cursor == ' ' || *cursor == '\t') {
    cursor++;
  }

  tool_start = cursor;
  while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t') {
    cursor++;
  }

  tool_length = (size_t)(cursor - tool_start);
  if (tool_length == 0 || tool_length >= tool_name_size) {
    return -1;
  }

  while (*cursor == ' ' || *cursor == '\t') {
    cursor++;
  }
  if (*cursor != '\0') {
    return -1;
  }

  memcpy(tool_name, tool_start, tool_length);
  tool_name[tool_length] = '\0';
  return 0;
}

static int pm_is_regular_file(const char *path) {
  struct stat stat_buffer;

  return path != NULL &&
    path[0] != '\0' &&
    stat(path, &stat_buffer) == 0 &&
    S_ISREG(stat_buffer.st_mode);
}

static int pm_shell_script_uses_shell(const char *script_path) {
  char line[PM_MAX_SHEBANG];
  char *cursor;

  if (pm_read_shebang(script_path, line, sizeof(line)) != 0) {
    return 0;
  }

  cursor = pm_trim_text(line + 2);
  if (cursor == NULL) {
    return 0;
  }

  return strcmp(cursor, "/bin/sh") == 0 ||
    strcmp(cursor, "/bin/bash") == 0 ||
    strcmp(cursor, "/bin/zsh") == 0 ||
    strcmp(cursor, "/usr/bin/env sh") == 0 ||
    strcmp(cursor, "/usr/bin/env bash") == 0 ||
    strcmp(cursor, "/usr/bin/env zsh") == 0;
}

static int pm_shell_script_node_exec_target(
  const char *script_path,
  char *interpreter_path,
  size_t interpreter_size,
  char *node_script_path,
  size_t node_script_size) {
  FILE *file;
  char line[PM_MAX_SCRIPT_LINE];

  if (!pm_shell_script_uses_shell(script_path) ||
      interpreter_path == NULL ||
      interpreter_size == 0 ||
      node_script_path == NULL ||
      node_script_size == 0) {
    return -1;
  }

  file = fopen(script_path, "r");
  if (file == NULL) {
    return -1;
  }

  while (fgets(line, sizeof(line), file) != NULL) {
    char *trimmed = pm_trim_text(line);
    char *exec_position;
    char *target_start;
    char *target_end;
    char *script_start;
    char *script_end;
    const char *target_name;
    size_t target_length;
    size_t script_length;

    if (trimmed == NULL) {
      continue;
    }

    exec_position = strstr(trimmed, "exec \"");
    if (exec_position == NULL) {
      continue;
    }

    target_start = exec_position + strlen("exec \"");
    target_end = strchr(target_start, '"');
    if (target_start[0] != '/' || target_end == NULL) {
      continue;
    }

    script_start = target_end + 1;
    while (*script_start == ' ' || *script_start == '\t') {
      script_start++;
    }
    if (*script_start != '"') {
      continue;
    }
    script_start++;
    script_end = strchr(script_start, '"');
    if (script_start[0] != '/' || script_end == NULL || strstr(script_end + 1, "\"$@\"") == NULL) {
      continue;
    }

    target_length = (size_t)(target_end - target_start);
    script_length = (size_t)(script_end - script_start);
    if (target_length == 0 ||
        target_length >= interpreter_size ||
        script_length == 0 ||
        script_length >= node_script_size) {
      fclose(file);
      return -1;
    }

    memcpy(interpreter_path, target_start, target_length);
    interpreter_path[target_length] = '\0';
    memcpy(node_script_path, script_start, script_length);
    node_script_path[script_length] = '\0';
    target_name = pm_path_basename(interpreter_path);
    if ((target_name == NULL || (strcmp(target_name, "node") != 0 && strcmp(target_name, "nodejs") != 0)) ||
        !pm_is_executable_file(interpreter_path) ||
        !pm_is_regular_file(node_script_path)) {
      continue;
    }

    fclose(file);
    return 0;
  }

  fclose(file);
  return -1;
}

static int pm_resolve_shebang_interpreter(
  const char *tool_name,
  char *const envp[],
  char *buffer,
  size_t size) {
  const char *node_env;

  if (strcmp(tool_name, "node") != 0) {
    return -1;
  }

  node_env = pm_envp_value(envp, "NODE");
  if (pm_is_executable_file(node_env)) {
    snprintf(buffer, size, "%s", node_env);
    return 0;
  }

  return pm_find_executable_on_env_path(tool_name, envp, buffer, size, 1);
}

static int pm_is_shell_name(const char *target) {
  const char *name = pm_path_basename(target);

  return name != NULL &&
    (strcmp(name, "sh") == 0 ||
     strcmp(name, "bash") == 0 ||
     strcmp(name, "zsh") == 0);
}

static const char *pm_shell_command_arg(char *const argv[]) {
  for (size_t index = 1; argv != NULL && argv[index] != NULL; index++) {
    if (strcmp(argv[index], "-c") == 0) {
      return argv[index + 1];
    }
  }

  return NULL;
}

static int pm_shell_meta_character(char value) {
  return value == '|' ||
    value == '&' ||
    value == ';' ||
    value == '<' ||
    value == '>' ||
    value == '(' ||
    value == ')' ||
    value == '`' ||
    value == '$' ||
    value == '\\' ||
    value == '\n' ||
    value == '\r';
}

static int pm_tokenize_simple_shell_command(char *command, char **tokens, size_t max_tokens, size_t *token_count) {
  char *cursor = command;
  size_t count = 0;

  if (command == NULL || tokens == NULL || token_count == NULL || max_tokens == 0) {
    return -1;
  }

  while (*cursor != '\0') {
    char quote = '\0';
    char *start;

    while (*cursor == ' ' || *cursor == '\t') {
      cursor++;
    }
    if (*cursor == '\0') {
      break;
    }
    if (pm_shell_meta_character(*cursor)) {
      return -1;
    }
    if (count >= max_tokens) {
      return -1;
    }

    if (*cursor == '\'' || *cursor == '"') {
      quote = *cursor;
      start = ++cursor;
      while (*cursor != '\0' && *cursor != quote) {
        if (pm_shell_meta_character(*cursor)) {
          return -1;
        }
        cursor++;
      }
      if (*cursor != quote) {
        return -1;
      }
      *cursor++ = '\0';
      if (*cursor != '\0' && *cursor != ' ' && *cursor != '\t') {
        return -1;
      }
    } else {
      start = cursor;
      while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t') {
        if (pm_shell_meta_character(*cursor)) {
          return -1;
        }
        cursor++;
      }
      if (*cursor != '\0') {
        *cursor++ = '\0';
      }
    }

    if (start[0] == '\0') {
      return -1;
    }
    tokens[count++] = start;
  }

  *token_count = count;
  return count > 0 ? 0 : -1;
}

static int pm_is_shell_env_assignment_token(const char *token) {
  if (token == NULL || token[0] == '\0' || !(isalpha((unsigned char)token[0]) || token[0] == '_')) {
    return 0;
  }

  for (size_t index = 1; token[index] != '\0'; index++) {
    unsigned char ch = (unsigned char)token[index];
    if (token[index] == '=') {
      return 1;
    }
    if (!(isalnum(ch) || ch == '_')) {
      return 0;
    }
  }

  return 0;
}

static size_t pm_shell_env_assignment_prefix_count(char **tokens, size_t token_count) {
  size_t count = 0;

  while (count < token_count && pm_is_shell_env_assignment_token(tokens[count])) {
    count++;
  }

  return count;
}

static size_t pm_env_assignment_name_length(const char *assignment) {
  const char *equals = assignment == NULL ? NULL : strchr(assignment, '=');
  return equals == NULL ? 0 : (size_t)(equals - assignment);
}

static int pm_env_entry_matches_assignment(const char *entry, const char *assignment) {
  size_t name_length = pm_env_assignment_name_length(assignment);

  return entry != NULL &&
    name_length > 0 &&
    strncmp(entry, assignment, name_length) == 0 &&
    entry[name_length] == '=';
}

static char **pm_envp_with_shell_assignments(char *const envp[], char **assignments, size_t assignment_count) {
  char **updated_envp;
  size_t env_count = 0;
  size_t used = 0;

  if (assignment_count == 0) {
    return NULL;
  }

  while (envp != NULL && envp[env_count] != NULL) {
    env_count++;
  }

  updated_envp = calloc(env_count + assignment_count + 1, sizeof(char *));
  if (updated_envp == NULL) {
    return NULL;
  }

  for (size_t env_index = 0; env_index < env_count; env_index++) {
    int replaced = 0;

    for (size_t assignment_index = 0; assignment_index < assignment_count; assignment_index++) {
      if (pm_env_entry_matches_assignment(envp[env_index], assignments[assignment_index])) {
        replaced = 1;
        break;
      }
    }

    if (!replaced) {
      updated_envp[used++] = envp[env_index];
    }
  }

  for (size_t assignment_index = 0; assignment_index < assignment_count; assignment_index++) {
    updated_envp[used++] = assignments[assignment_index];
  }

  updated_envp[used] = NULL;
  return updated_envp;
}

static pm_child_exec_plan pm_prepare_shell_node_package_exec_plan(
  const char *target,
  char *const argv[],
  char *const envp[]) {
  pm_child_exec_plan plan = { target, (char **)argv, NULL, NULL, NULL, NULL, NULL };
  const char *command = pm_shell_command_arg(argv);
  char script_path[PM_MAX_PATH];
  char interpreter_path[PM_MAX_PATH];
  char tool_name[64];
  char *tokens[64];
  size_t token_count = 0;
  size_t assignment_count = 0;
  size_t command_index = 0;
  size_t command_token_count = 0;
  char **next_argv;

  /*
   * Yarn classic runs package binaries through "/bin/sh -c". That protected
   * shell drops DYLD before the .bin shebang can be rewritten. For the narrow
   * case of a simple node_modules/.bin command, skip the shell and launch the
   * Node script directly with the repaired child environment.
   */
  if (!pm_is_shell_name(target) ||
      command == NULL ||
      (plan.argv_storage = pm_duplicate_text(command)) == NULL ||
      pm_tokenize_simple_shell_command(plan.argv_storage, tokens, sizeof(tokens) / sizeof(tokens[0]), &token_count) != 0 ||
      (assignment_count = pm_shell_env_assignment_prefix_count(tokens, token_count)) >= token_count ||
      pm_resolve_exec_path(tokens[assignment_count], envp, 1, script_path, sizeof(script_path)) != 0 ||
      !pm_is_node_package_binary_path(script_path) ||
      pm_shebang_env_tool(script_path, tool_name, sizeof(tool_name)) != 0 ||
      pm_resolve_shebang_interpreter(tool_name, envp, interpreter_path, sizeof(interpreter_path)) != 0) {
    free(plan.argv_storage);
    plan.argv_storage = NULL;
    return plan;
  }

  command_index = assignment_count;
  command_token_count = token_count - command_index;
  next_argv = calloc(command_token_count + 2, sizeof(char *));
  if (next_argv == NULL) {
    free(plan.argv_storage);
    plan.argv_storage = NULL;
    return plan;
  }

  plan.resolved_script_path = pm_duplicate_text(script_path);
  plan.interpreter_path = pm_duplicate_text(interpreter_path);
  if (plan.resolved_script_path == NULL || plan.interpreter_path == NULL) {
    free(next_argv);
    free(plan.argv_storage);
    free(plan.resolved_script_path);
    free(plan.interpreter_path);
    plan.argv_storage = NULL;
    plan.resolved_script_path = NULL;
    plan.interpreter_path = NULL;
    return plan;
  }

  if (assignment_count > 0) {
    plan.envp_storage = pm_envp_with_shell_assignments(envp, tokens, assignment_count);
    if (plan.envp_storage == NULL) {
      free(next_argv);
      free(plan.argv_storage);
      free(plan.resolved_script_path);
      free(plan.interpreter_path);
      plan.argv_storage = NULL;
      plan.resolved_script_path = NULL;
      plan.interpreter_path = NULL;
      return plan;
    }
    plan.envp = plan.envp_storage;
  }

  next_argv[0] = plan.interpreter_path;
  next_argv[1] = plan.resolved_script_path;
  for (size_t index = command_index + 1; index < token_count; index++) {
    next_argv[index - command_index + 1] = tokens[index];
  }

  plan.target = plan.interpreter_path;
  plan.argv = next_argv;
  pm_debug(
    "shell package-bin rewrite command=%s script=%s interpreter=%s assignments=%zu",
    command,
    plan.resolved_script_path,
    plan.interpreter_path,
    assignment_count);
  return plan;
}

static pm_child_exec_plan pm_prepare_simple_node_wrapper_exec_plan(
  const char *target,
  char *const argv[],
  char *const envp[],
  int allow_path_lookup) {
  pm_child_exec_plan plan = { target, (char **)argv, NULL, NULL, NULL, NULL, NULL };
  char wrapper_path[PM_MAX_PATH];
  char interpreter_path[PM_MAX_PATH];
  char node_script_path[PM_MAX_PATH];
  size_t argc = 0;
  char **next_argv;

  /*
   * Yarn creates temporary shell wrappers that execute
   *   exec "/path/to/node" "/path/to/yarn.js" "$@"
   * and puts them before extension-owned shims in PATH. If a hooked process
   * launches that wrapper directly, macOS strips DYLD at the /bin/sh boundary.
   * Skip the wrapper and exec the Node entrypoint while the repaired envp is
   * still intact.
   */
  if (pm_resolve_exec_path(target, envp, allow_path_lookup, wrapper_path, sizeof(wrapper_path)) != 0 ||
      pm_shell_script_node_exec_target(
        wrapper_path,
        interpreter_path,
        sizeof(interpreter_path),
        node_script_path,
        sizeof(node_script_path)) != 0) {
    return plan;
  }

  while (argv != NULL && argv[argc] != NULL) {
    argc++;
  }

  next_argv = calloc(argc + 2, sizeof(char *));
  if (next_argv == NULL) {
    return plan;
  }

  plan.interpreter_path = pm_duplicate_text(interpreter_path);
  plan.resolved_script_path = pm_duplicate_text(node_script_path);
  if (plan.interpreter_path == NULL || plan.resolved_script_path == NULL) {
    free(next_argv);
    free(plan.interpreter_path);
    free(plan.resolved_script_path);
    plan.interpreter_path = NULL;
    plan.resolved_script_path = NULL;
    return plan;
  }

  next_argv[0] = plan.interpreter_path;
  next_argv[1] = plan.resolved_script_path;
  for (size_t index = 1; index < argc; index++) {
    next_argv[index + 1] = argv[index];
  }

  plan.target = plan.interpreter_path;
  plan.argv = next_argv;
  pm_debug("shell node-wrapper rewrite wrapper=%s script=%s interpreter=%s", wrapper_path, plan.resolved_script_path, plan.interpreter_path);
  return plan;
}

static pm_child_exec_plan pm_prepare_child_exec_plan(
  const char *target,
  char *const argv[],
  char *const envp[],
  int allow_path_lookup) {
  pm_child_exec_plan plan = { target, (char **)argv, NULL, NULL, NULL, NULL, NULL };
  char script_path[PM_MAX_PATH];
  char interpreter_path[PM_MAX_PATH];
  char tool_name[64];
  size_t argc = 0;
  char **next_argv;

  /*
   * Node package binaries usually have "#!/usr/bin/env node". On macOS that
   * protected /usr/bin/env boundary can drop DYLD_INSERT_LIBRARIES even when
   * the spawning package manager is already hooked. Rewrite only package-bin
   * scripts with the simple env-node shebang so CLI tools such as wait-on keep
   * the repaired envp without changing arbitrary script shebang semantics.
   */
  if (!pm_hook_enabled() || pm_hook_depth > 0 || envp == NULL ||
      pm_envp_value_is(envp, "PORT_MANAGER_HOOK_DISABLED", "1") ||
      pm_envp_value_is(envp, "PORT_MANAGER_HOOK", "0")) {
    return plan;
  }

  plan = pm_prepare_shell_node_package_exec_plan(target, argv, envp);
  if (plan.interpreter_path != NULL) {
    return plan;
  }

  plan = pm_prepare_simple_node_wrapper_exec_plan(target, argv, envp, allow_path_lookup);
  if (plan.interpreter_path != NULL) {
    return plan;
  }

  if (pm_resolve_exec_path(target, envp, allow_path_lookup, script_path, sizeof(script_path)) != 0 ||
      !pm_is_node_package_binary_path(script_path) ||
      pm_shebang_env_tool(script_path, tool_name, sizeof(tool_name)) != 0 ||
      pm_resolve_shebang_interpreter(tool_name, envp, interpreter_path, sizeof(interpreter_path)) != 0) {
    return plan;
  }

  while (argv != NULL && argv[argc] != NULL) {
    argc++;
  }

  next_argv = calloc(argc + 2, sizeof(char *));
  if (next_argv == NULL) {
    return plan;
  }

  plan.resolved_script_path = pm_duplicate_text(script_path);
  plan.interpreter_path = pm_duplicate_text(interpreter_path);
  if (plan.resolved_script_path == NULL || plan.interpreter_path == NULL) {
    free(next_argv);
    free(plan.resolved_script_path);
    free(plan.interpreter_path);
    plan.resolved_script_path = NULL;
    plan.interpreter_path = NULL;
    return plan;
  }

  next_argv[0] = plan.interpreter_path;
  next_argv[1] = plan.resolved_script_path;
  for (size_t index = 1; index < argc; index++) {
    next_argv[index + 1] = argv[index];
  }

  plan.target = plan.interpreter_path;
  plan.argv = next_argv;
  pm_debug("shebang rewrite script=%s interpreter=%s", plan.resolved_script_path, plan.interpreter_path);
  return plan;
}

static void pm_release_child_exec_plan(pm_child_exec_plan *plan) {
  if (plan == NULL || plan->interpreter_path == NULL) {
    return;
  }

  free(plan->argv);
  free(plan->resolved_script_path);
  free(plan->interpreter_path);
  free(plan->argv_storage);
  free(plan->envp_storage);
  plan->target = NULL;
  plan->argv = NULL;
  plan->resolved_script_path = NULL;
  plan->interpreter_path = NULL;
  plan->argv_storage = NULL;
  plan->envp = NULL;
  plan->envp_storage = NULL;
}

static int pm_is_container_runtime_name(const char *name) {
  return name != NULL &&
    (strcmp(name, "docker") == 0 ||
     strcmp(name, "podman") == 0 ||
     strcmp(name, "docker-compose") == 0 ||
     strcmp(name, "podman-compose") == 0);
}

/**
 * PATH aliases do not see scripts that call /usr/local/bin/docker directly.
 * Rewriting the exec target keeps hardcoded Docker/Podman CLI calls on the
 * same compose/container route map as interactive shell commands.
 */
static const char *pm_runtime_exec_target(const char *path, char *const argv[]) {
  const char *shim_path = getenv("PORT_MANAGER_DOCKER_SHIM");
  const char *path_name = pm_path_basename(path);
  const char *argv_name = argv != NULL && argv[0] != NULL ? pm_path_basename(argv[0]) : NULL;
  const char *shim_name = pm_path_basename(shim_path);

  if (!pm_hook_enabled() || pm_hook_depth > 0 || pm_env_flag_is_one("PORT_MANAGER_DOCKER_SHIM_BYPASS")) {
    return path;
  }

  if (shim_path == NULL || shim_path[0] == '\0' ||
      (path_name != NULL && shim_name != NULL && strcmp(path_name, shim_name) == 0)) {
    return path;
  }

  if (pm_is_container_runtime_name(path_name) || pm_is_container_runtime_name(argv_name)) {
    return shim_path;
  }

  return path;
}

static int pm_is_docker_socket_path(const char *path) {
  const char *name = pm_path_basename(path);

  return name != NULL && (strcmp(name, "docker.sock") == 0 || strcmp(name, "podman.sock") == 0);
}

static int pm_is_docker_socket_addr(const struct sockaddr *addr, socklen_t addrlen) {
  const struct sockaddr_un *unix_addr;
  size_t path_offset = offsetof(struct sockaddr_un, sun_path);
  size_t path_length;
  char socket_path[sizeof(unix_addr->sun_path) + 1];

  if (addr == NULL || addr->sa_family != AF_UNIX || addrlen <= (socklen_t)path_offset) {
    return 0;
  }

  unix_addr = (const struct sockaddr_un *)addr;
  if (unix_addr->sun_path[0] == '\0') {
    return 0;
  }

  path_length = strnlen(unix_addr->sun_path, sizeof(unix_addr->sun_path));
  if (path_length == 0 || path_length >= sizeof(socket_path)) {
    return 0;
  }

  memcpy(socket_path, unix_addr->sun_path, path_length);
  socket_path[path_length] = '\0';
  return pm_is_docker_socket_path(socket_path);
}

/**
 * Direct Docker socket clients bypass CLI alias rewriting entirely. Until a
 * Docker API proxy rewrites HTTP container ids/names, fail closed inside an
 * attached network so those requests cannot mutate the host daemon by mistake.
 */
static int pm_should_block_docker_socket(const struct sockaddr *addr, socklen_t addrlen) {
  const char *network_id;

  if (!pm_hook_enabled() || pm_hook_depth > 0 ||
      pm_env_flag_is_one("PORT_MANAGER_DOCKER_SHIM_BYPASS") ||
      pm_env_flag_is_one("PORT_MANAGER_ALLOW_DOCKER_SOCKET")) {
    return 0;
  }

  if (!pm_is_docker_socket_addr(addr, addrlen)) {
    return 0;
  }

  network_id = pm_current_network_id();
  return network_id != NULL && network_id[0] != '\0';
}

static int pm_has_current_network_scope(void) {
  const char *network_id = pm_current_network_id();

  return network_id != NULL && network_id[0] != '\0';
}

static void pm_normalize_process_preload_env(void) {
  const char *hook_path = getenv(PM_PRELOAD_HINT_ENV);
  const char *current_preload = getenv(PM_PRELOAD_ENV);
  char *assignment;
  char *value;

  if (hook_path == NULL || hook_path[0] == '\0' || pm_preload_value_is_normalized(current_preload, hook_path)) {
    return;
  }

  assignment = pm_make_preload_assignment(hook_path, current_preload);
  if (assignment == NULL) {
    return;
  }

  value = strchr(assignment, '=');
  if (value != NULL) {
    setenv(PM_PRELOAD_ENV, value + 1, 1);
  }
  free(assignment);
}

__attribute__((constructor)) static void pm_hook_loaded(void) {
  pm_normalize_process_preload_env();
  pm_debug("loaded");
}

__attribute__((destructor)) static void pm_hook_unloaded(void) {
  pm_release_process_routes();
  pm_clear_memory_routes();
  pm_clear_route_file_cache();
}

static void *pm_resolve_symbol(const char *name) {
  void *symbol = dlsym(RTLD_NEXT, name);
  return symbol;
}

static void pm_ensure_symbols(void) {
  if (pm_real_bind == NULL) {
    pm_real_bind = (pm_bind_fn)pm_resolve_symbol("bind");
  }

  if (pm_real_connect == NULL) {
    pm_real_connect = (pm_connect_fn)pm_resolve_symbol("connect");
  }

  if (pm_real_getsockname == NULL) {
    pm_real_getsockname = (pm_getsockname_fn)pm_resolve_symbol("getsockname");
  }

  if (pm_real_execve == NULL) {
    pm_real_execve = (pm_execve_fn)pm_resolve_symbol("execve");
  }

  if (pm_real_execv == NULL) {
    pm_real_execv = (pm_execv_fn)pm_resolve_symbol("execv");
  }

  if (pm_real_execvp == NULL) {
    pm_real_execvp = (pm_execvp_fn)pm_resolve_symbol("execvp");
  }

  if (pm_real_posix_spawn == NULL) {
    pm_real_posix_spawn = (pm_posix_spawn_fn)pm_resolve_symbol("posix_spawn");
  }

  if (pm_real_posix_spawnp == NULL) {
    pm_real_posix_spawnp = (pm_posix_spawnp_fn)pm_resolve_symbol("posix_spawnp");
  }
}

static int pm_parse_int_env(const char *name, int fallback) {
  const char *value = getenv(name);
  char *end = NULL;
  long parsed;

  if (value == NULL || value[0] == '\0') {
    return fallback;
  }

  parsed = strtol(value, &end, 10);
  if (end == value || *end != '\0' || parsed < 0 || parsed > 65535) {
    return fallback;
  }

  return (int)parsed;
}

static int pm_route_table_ttl_seconds(void) {
  int ttl_seconds = pm_parse_int_env(PM_ROUTE_TABLE_TTL_SECONDS_ENV, PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS);

  if (ttl_seconds < 5) {
    return 5;
  }
  if (ttl_seconds > 3600) {
    return 3600;
  }

  return ttl_seconds;
}

static void pm_agent_roundtrip_timeout(struct timeval *timeout) {
  int timeout_ms = pm_parse_int_env("PORT_MANAGER_AGENT_TIMEOUT_MS", PM_AGENT_ROUNDTRIP_TIMEOUT_MS);

  if (timeout_ms < 100) {
    timeout_ms = 100;
  }

  timeout->tv_sec = timeout_ms / 1000;
  timeout->tv_usec = (timeout_ms % 1000) * 1000;
}

static int pm_is_response_frame(const char *line) {
  return strstr(line, "\"type\":\"response\"") != NULL || strstr(line, "\"type\": \"response\"") != NULL;
}

static int pm_port_list_contains(const char *ports, int target_port) {
  const char *cursor = ports;

  while (cursor != NULL && *cursor != '\0') {
    char *end = NULL;
    long parsed;

    while (*cursor != '\0' && !isdigit((unsigned char)*cursor)) {
      cursor++;
    }

    if (*cursor == '\0') {
      break;
    }

    parsed = strtol(cursor, &end, 10);
    if (end == cursor) {
      break;
    }

    if (parsed == target_port) {
      return 1;
    }

    cursor = end;
  }

  return 0;
}

static int pm_is_fixed_protocol_port(int port) {
  const char *configured_ports = getenv("PORT_MANAGER_FIXED_PROTOCOL_PORTS");
  const char *ports = configured_ports != NULL ? configured_ports : PM_DEFAULT_FIXED_PROTOCOL_PORTS;

  if (ports == NULL || ports[0] == '\0') {
    return 0;
  }

  return pm_port_list_contains(ports, port);
}

static int pm_is_compose_logical_port(int port) {
  const char *ports = getenv("PORT_MANAGER_COMPOSE_LOGICAL_PORTS");

  if (ports == NULL || ports[0] == '\0') {
    return 0;
  }

  return pm_port_list_contains(ports, port);
}

static int pm_is_preserved_listen_port(int port) {
  const char *ports = getenv("PORT_MANAGER_PRESERVE_LISTEN_PORTS");

  if (ports == NULL || ports[0] == '\0') {
    return 0;
  }

  return pm_port_list_contains(ports, port);
}

static int pm_should_preserve_listen_bind(int logical_port) {
  /*
   * Preserving a bind means the kernel sees the original host/port. That is
   * only safe for explicit user overrides; auto-preserving Vite/Next-style dev
   * servers lets their own conflict detector increment ports before Port
   * Manager can present a stable browser alias.
   */
  return pm_is_preserved_listen_port(logical_port);
}

static const char *pm_routing_mode(void) {
  const char *mode = getenv("PORT_MANAGER_ROUTING_MODE");

  if (mode != NULL && (strcmp(mode, "nearest") == 0 || strcmp(mode, "hashed") == 0)) {
    return mode;
  }

  return "hashed";
}

static void pm_default_socket_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_AGENT_SOCKET");

  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-agent-%ld.sock", (long)getuid());
}

static void pm_default_route_table_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_ROUTES_FILE");

  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-routes-%ld.json", (long)getuid());
}

static void pm_default_global_route_table_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_GLOBAL_ROUTES_FILE");

  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-routes-%ld.json", (long)getuid());
}

/** Extracts the logical network suffix from a scoped route-table filename. */
static int pm_route_table_path_network_id(const char *route_file, char *network_id, size_t size) {
  const char *base_name;
  const char *prefix = "newdlops-portmanager-routes-";
  const char *suffix = ".json";
  const char *scope_start;
  size_t prefix_length = strlen(prefix);
  size_t suffix_length = strlen(suffix);
  size_t base_length;
  size_t body_length;
  size_t network_length;

  if (route_file == NULL || route_file[0] == '\0' || network_id == NULL || size == 0) {
    return -1;
  }

  base_name = strrchr(route_file, '/');
  base_name = base_name == NULL ? route_file : base_name + 1;
  base_length = strlen(base_name);

  if (base_length <= prefix_length + suffix_length || strncmp(base_name, prefix, prefix_length) != 0) {
    return -1;
  }

  if (strcmp(base_name + base_length - suffix_length, suffix) != 0) {
    return -1;
  }

  body_length = base_length - prefix_length - suffix_length;
  scope_start = memchr(base_name + prefix_length, '-', body_length);
  if (scope_start == NULL) {
    return -1;
  }

  scope_start++;
  network_length = (size_t)((base_name + prefix_length + body_length) - scope_start);
  if (network_length == 0 || network_length >= size) {
    return -1;
  }

  memcpy(network_id, scope_start, network_length);
  network_id[network_length] = '\0';
  return 0;
}

/** Recovers the global route-table path from a scoped route-table path. */
static void pm_route_table_path_without_network_scope(const char *route_file, char *buffer, size_t size) {
  const char *base_name;
  const char *prefix = "newdlops-portmanager-routes-";
  const char *suffix = ".json";
  const char *scope_start;
  size_t directory_length;
  size_t prefix_length = strlen(prefix);
  size_t suffix_length = strlen(suffix);
  size_t base_length;
  size_t body_length;
  size_t user_scope_length;

  if (buffer == NULL || size == 0) {
    return;
  }

  buffer[0] = '\0';
  if (route_file == NULL || route_file[0] == '\0') {
    return;
  }

  base_name = strrchr(route_file, '/');
  directory_length = base_name == NULL ? 0 : (size_t)(base_name - route_file);
  base_name = base_name == NULL ? route_file : base_name + 1;
  base_length = strlen(base_name);

  if (base_length <= prefix_length + suffix_length || strncmp(base_name, prefix, prefix_length) != 0 ||
      strcmp(base_name + base_length - suffix_length, suffix) != 0) {
    return;
  }

  body_length = base_length - prefix_length - suffix_length;
  scope_start = memchr(base_name + prefix_length, '-', body_length);
  if (scope_start == NULL) {
    snprintf(buffer, size, "%s", route_file);
    return;
  }

  user_scope_length = (size_t)(scope_start - (base_name + prefix_length));
  if (directory_length > 0) {
    snprintf(buffer, size, "%.*s/%s%.*s%s", (int)directory_length, route_file, prefix, (int)user_scope_length, base_name + prefix_length, suffix);
  } else {
    snprintf(buffer, size, "%s%.*s%s", prefix, (int)user_scope_length, base_name + prefix_length, suffix);
  }
}

/** Mirrors route-table.ts scope sanitization for native fallback paths. */
static void pm_sanitize_route_table_scope(const char *value, char *buffer, size_t size) {
  size_t used = 0;

  if (buffer == NULL || size == 0) {
    return;
  }

  if (value == NULL) {
    buffer[0] = '\0';
    return;
  }

  for (size_t index = 0; value[index] != '\0' && used + 1 < size && used < 120; index++) {
    unsigned char ch = (unsigned char)value[index];
    buffer[used++] = (isalnum(ch) || ch == '_' || ch == '.' || ch == '-') ? (char)ch : '_';
  }

  if (used == 0 && size > 1) {
    snprintf(buffer, size, "network");
    return;
  }

  buffer[used] = '\0';
}

/** Builds the network-scoped route table path for the current logical network. */
static int pm_scoped_route_table_path(const char *base_route_table_path, const char *network_id, char *buffer, size_t size) {
  const char *slash;
  const char *file_name;
  const char *extension;
  size_t directory_length;
  size_t stem_length;
  char scope[PM_MAX_TEXT];

  if (base_route_table_path == NULL || base_route_table_path[0] == '\0' || network_id == NULL || network_id[0] == '\0' ||
      buffer == NULL || size == 0) {
    return -1;
  }

  pm_sanitize_route_table_scope(network_id, scope, sizeof(scope));
  slash = strrchr(base_route_table_path, '/');
  directory_length = slash == NULL ? 0 : (size_t)(slash - base_route_table_path);
  file_name = slash == NULL ? base_route_table_path : slash + 1;
  extension = strrchr(file_name, '.');
  if (extension == NULL) {
    extension = ".json";
    stem_length = strlen(file_name);
  } else {
    stem_length = (size_t)(extension - file_name);
  }

  if (directory_length > 0) {
    snprintf(buffer, size, "%.*s/%.*s-%s%s", (int)directory_length, base_route_table_path, (int)stem_length, file_name, scope, extension);
  } else {
    snprintf(buffer, size, "%.*s-%s%s", (int)stem_length, file_name, scope, extension);
  }

  return buffer[0] == '\0' ? -1 : 0;
}

static void pm_route_entry_path(const char *route_table_path, int logical_port, char *buffer, size_t size) {
  const char *file_name;
  const char *extension;

  file_name = strrchr(route_table_path, '/');
  file_name = file_name == NULL ? route_table_path : file_name + 1;
  extension = strrchr(file_name, '.');

  if (extension != NULL) {
    size_t prefix_length = (size_t)(extension - route_table_path);
    snprintf(buffer, size, "%.*s-port-%d%s", (int)prefix_length, route_table_path, logical_port, extension);
    return;
  }

  snprintf(buffer, size, "%s-port-%d.json", route_table_path, logical_port);
}

static void pm_route_compose_claim_path(const char *route_table_path, int port, char *buffer, size_t size) {
  const char *file_name;
  const char *extension;

  file_name = strrchr(route_table_path, '/');
  file_name = file_name == NULL ? route_table_path : file_name + 1;
  extension = strrchr(file_name, '.');

  if (extension != NULL) {
    size_t prefix_length = (size_t)(extension - route_table_path);
    snprintf(buffer, size, "%.*s-compose-claim-port-%d%s", (int)prefix_length, route_table_path, port, extension);
    return;
  }

  snprintf(buffer, size, "%s-compose-claim-port-%d.json", route_table_path, port);
}

static void pm_default_host_access_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_HOST_ACCESS_FILE");

  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-host-access-%ld.json", (long)getuid());
}

static int pm_is_supported_sockaddr(const struct sockaddr *addr, socklen_t addrlen) {
  if (addr == NULL) {
    return 0;
  }

  if (addr->sa_family == AF_INET) {
    return addrlen >= (socklen_t)sizeof(struct sockaddr_in);
  }

  if (addr->sa_family == AF_INET6) {
    return addrlen >= (socklen_t)sizeof(struct sockaddr_in6);
  }

  return 0;
}

static int pm_sockaddr_port(const struct sockaddr *addr) {
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    return ntohs(in->sin_port);
  }

  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    return ntohs(in6->sin6_port);
  }

  return 0;
}

static void pm_set_sockaddr_port(struct sockaddr *addr, int port) {
  if (addr->sa_family == AF_INET) {
    struct sockaddr_in *in = (struct sockaddr_in *)addr;
    in->sin_port = htons((uint16_t)port);
  }

  if (addr->sa_family == AF_INET6) {
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)addr;
    in6->sin6_port = htons((uint16_t)port);
  }
}

static int pm_set_ipv4_mapped_ipv6(struct in6_addr *target, const char *host) {
  struct in_addr v4;

  if (strcmp(host, "localhost") == 0) {
    host = "127.0.0.1";
  }

  if (inet_pton(AF_INET, host, &v4) != 1) {
    return 0;
  }

  memset(target, 0, sizeof(*target));
  target->s6_addr[10] = 0xff;
  target->s6_addr[11] = 0xff;
  memcpy(&target->s6_addr[12], &v4, sizeof(v4));
  return 1;
}

static void pm_set_sockaddr_host(struct sockaddr *addr, const char *host) {
  if (host == NULL || host[0] == '\0') {
    return;
  }

  if (addr->sa_family == AF_INET) {
    struct sockaddr_in *in = (struct sockaddr_in *)addr;

    if (strcmp(host, "localhost") == 0 || strcmp(host, "::1") == 0) {
      inet_pton(AF_INET, "127.0.0.1", &in->sin_addr);
      return;
    }

    (void)inet_pton(AF_INET, host, &in->sin_addr);
    return;
  }

  if (addr->sa_family == AF_INET6) {
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)addr;

    if (pm_set_ipv4_mapped_ipv6(&in6->sin6_addr, host)) {
      return;
    }

    (void)inet_pton(AF_INET6, host, &in6->sin6_addr);
  }
}

static int pm_sockaddr_is_local(const struct sockaddr *addr) {
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    uint32_t ip = ntohl(in->sin_addr.s_addr);
    return ip == 0 || (ip >> 24) == 127;
  }

  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    static const unsigned char loopback[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
    static const unsigned char any[16] = {0};
    return memcmp(&in6->sin6_addr, loopback, 16) == 0 || memcmp(&in6->sin6_addr, any, 16) == 0;
  }

  return 0;
}

static int pm_route_host_is_wildcard_text(const char *host) {
  return host != NULL &&
    (strcmp(host, "::") == 0 ||
     strcmp(host, "0.0.0.0") == 0 ||
     strcmp(host, "*") == 0);
}

static const char *pm_non_default_loopback_host_env(const char *name) {
  const char *host = getenv(name);
  struct in_addr address;
  uint32_t ip;

  if (host == NULL || host[0] == '\0') {
    return NULL;
  }

  if (inet_pton(AF_INET, host, &address) != 1) {
    return NULL;
  }

  ip = ntohl(address.s_addr);
  if ((ip >> 24) != 127 || ip == 0x7f000001u) {
    return NULL;
  }

  return host;
}

static const char *pm_actual_loopback_host(void) {
  return pm_non_default_loopback_host_env(PM_ACTUAL_LOOPBACK_HOST_ENV);
}

static const char *pm_network_loopback_host(void) {
  return pm_non_default_loopback_host_env(PM_NETWORK_LOOPBACK_HOST_ENV);
}

static void pm_sockaddr_host(const struct sockaddr *addr, char *buffer, size_t size) {
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;

    if (in->sin_addr.s_addr == INADDR_ANY) {
      snprintf(buffer, size, "localhost");
      return;
    }

    inet_ntop(AF_INET, &in->sin_addr, buffer, (socklen_t)size);
    return;
  }

  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    inet_ntop(AF_INET6, &in6->sin6_addr, buffer, (socklen_t)size);
    return;
  }

  snprintf(buffer, size, "localhost");
}

static void pm_json_escape(const char *input, char *output, size_t size) {
  size_t used = 0;

  if (size == 0) {
    return;
  }

  for (size_t index = 0; input != NULL && input[index] != '\0' && used + 2 < size; index++) {
    unsigned char ch = (unsigned char)input[index];

    if (ch == '"' || ch == '\\') {
      if (used + 2 >= size) {
        break;
      }

      output[used++] = '\\';
      output[used++] = (char)ch;
      continue;
    }

    if (ch == '\n' || ch == '\r' || ch == '\t') {
      output[used++] = ' ';
      continue;
    }

    output[used++] = (char)ch;
  }

  output[used] = '\0';
}

static void pm_cwd(char *buffer, size_t size) {
  if (getcwd(buffer, size) == NULL) {
    snprintf(buffer, size, ".");
  }
}

static void pm_command_name(char *buffer, size_t size) {
#if defined(__APPLE__)
  extern const char *getprogname(void);
  const char *name = getprogname();
  snprintf(buffer, size, "%s", name != NULL ? name : "process");
#else
  int fd = open("/proc/self/cmdline", O_RDONLY);
  ssize_t count;

  if (fd < 0) {
    snprintf(buffer, size, "process");
    return;
  }

  count = read(fd, buffer, size - 1);
  close(fd);

  if (count <= 0) {
    snprintf(buffer, size, "process");
    return;
  }

  for (ssize_t index = 0; index < count; index++) {
    if (buffer[index] == '\0') {
      buffer[index] = ' ';
    }
  }

  buffer[count] = '\0';
#endif
}

static long pm_now_milliseconds(void) {
  struct timeval now;

  if (gettimeofday(&now, NULL) != 0) {
    return 0;
  }

  return (long)(now.tv_sec * 1000L + now.tv_usec / 1000L);
}

static int pm_agent_connect_error_retryable(int error_code) {
  return error_code == ECONNREFUSED ||
         error_code == ENOENT ||
         error_code == EAGAIN ||
         error_code == ECONNRESET;
}

static int pm_agent_roundtrip(const char *request, char *response, size_t response_size) {
  char socket_path[PM_MAX_PATH];
  struct sockaddr_un server_addr;
  int fd = -1;
  size_t request_len = strlen(request);
  ssize_t written;
  size_t total = 0;
  size_t scan_offset = 0;
  int timeout_ms;
  long deadline_ms;

  pm_ensure_symbols();
  if (pm_real_connect == NULL) {
    return -1;
  }

  pm_default_socket_path(socket_path, sizeof(socket_path));
  memset(&server_addr, 0, sizeof(server_addr));
  server_addr.sun_family = AF_UNIX;
  snprintf(server_addr.sun_path, sizeof(server_addr.sun_path), "%s", socket_path);

  timeout_ms = pm_parse_int_env("PORT_MANAGER_AGENT_ROUNDTRIP_TIMEOUT_MS", PM_AGENT_ROUNDTRIP_TIMEOUT_MS);
  if (timeout_ms < 100) {
    timeout_ms = 100;
  }
  deadline_ms = pm_now_milliseconds() + timeout_ms;
  for (;;) {
    struct timeval timeout;
    int saved_errno;

    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
      return -1;
    }

    pm_agent_roundtrip_timeout(&timeout);
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));

    pm_hook_depth++;
    if (pm_real_connect(fd, (struct sockaddr *)&server_addr, sizeof(server_addr)) == 0) {
      pm_hook_depth--;
      break;
    }
    saved_errno = errno;
    pm_hook_depth--;
    close(fd);
    fd = -1;
    if (!pm_agent_connect_error_retryable(saved_errno) || pm_now_milliseconds() >= deadline_ms) {
      pm_debug("agent connect failed socket=%s error=%s", socket_path, strerror(saved_errno));
      return -1;
    }
    usleep(2000);
  }

  while (request_len > 0) {
    written = write(fd, request, request_len);
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written <= 0) {
      pm_debug("agent write failed socket=%s", socket_path);
      close(fd);
      return -1;
    }

    request += written;
    request_len -= (size_t)written;
  }

  while (total + 1 < response_size) {
    ssize_t count = read(fd, response + total, response_size - total - 1);

    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      break;
    }

    total += (size_t)count;
    response[total] = '\0';

    for (;;) {
      char *newline = memchr(response + scan_offset, '\n', total - scan_offset);
      size_t line_length;

      if (newline == NULL) {
        break;
      }

      line_length = (size_t)(newline - (response + scan_offset));
      response[scan_offset + line_length] = '\0';
      if (pm_is_response_frame(response + scan_offset)) {
        if (scan_offset > 0) {
          memmove(response, response + scan_offset, line_length + 1);
        }
        close(fd);
        return 0;
      }

      scan_offset += line_length + 1;
    }

    if (scan_offset > 0) {
      if (scan_offset < total) {
        memmove(response, response + scan_offset, total - scan_offset);
        total -= scan_offset;
      } else {
        total = 0;
      }
      scan_offset = 0;
    }
  }

  close(fd);
  response[total] = '\0';
  if (total == 0) {
    pm_debug("agent returned empty response socket=%s", socket_path);
  } else {
    pm_debug("agent returned no response frame socket=%s partial=%.160s", socket_path, response);
  }
  return -1;
}

static const char *pm_find_json_key(const char *json, const char *key) {
  char pattern[128];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  return strstr(json, pattern);
}

/*
 * Route tables may be written by the Node daemon as pretty JSON or by the
 * native daemon as compact JSON. Match numeric keys structurally enough for the
 * hot-path route scan instead of depending on a specific colon/space layout.
 */
static char *pm_find_json_int_key(char *cursor, const char *key, int expected_value) {
  char pattern[128];
  size_t pattern_length;

  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  pattern_length = strlen(pattern);

  while (cursor != NULL && *cursor != '\0') {
    char *match = strstr(cursor, pattern);
    char *value_start;
    char *value_end = NULL;
    long parsed;

    if (match == NULL) {
      return NULL;
    }

    value_start = match + pattern_length;
    while (*value_start != '\0' && isspace((unsigned char)*value_start)) {
      value_start++;
    }

    if (*value_start != ':') {
      cursor = value_start;
      continue;
    }

    value_start++;
    while (*value_start != '\0' && isspace((unsigned char)*value_start)) {
      value_start++;
    }

    parsed = strtol(value_start, &value_end, 10);
    if (value_end != value_start && parsed == expected_value) {
      return match;
    }

    cursor = value_end != value_start ? value_end : value_start + 1;
  }

  return NULL;
}

static int pm_json_int(const char *json, const char *key, int fallback) {
  const char *cursor = pm_find_json_key(json, key);

  if (cursor == NULL) {
    return fallback;
  }

  cursor = strchr(cursor, ':');
  if (cursor == NULL) {
    return fallback;
  }

  cursor++;
  while (*cursor != '\0' && isspace((unsigned char)*cursor)) {
    cursor++;
  }

  return atoi(cursor);
}

static long pm_json_long(const char *json, const char *key, long fallback) {
  const char *cursor = pm_find_json_key(json, key);
  char *end = NULL;
  long parsed;

  if (cursor == NULL) {
    return fallback;
  }

  cursor = strchr(cursor, ':');
  if (cursor == NULL) {
    return fallback;
  }

  cursor++;
  while (*cursor != '\0' && isspace((unsigned char)*cursor)) {
    cursor++;
  }

  parsed = strtol(cursor, &end, 10);
  return end == cursor ? fallback : parsed;
}

static int pm_json_string(const char *json, const char *key, char *buffer, size_t size) {
  const char *cursor = pm_find_json_key(json, key);
  size_t used = 0;

  if (cursor == NULL || size == 0) {
    return -1;
  }

  cursor = strchr(cursor, ':');
  if (cursor == NULL) {
    return -1;
  }

  cursor++;
  while (*cursor != '\0' && isspace((unsigned char)*cursor)) {
    cursor++;
  }

  if (*cursor != '"') {
    return -1;
  }

  cursor++;
  while (*cursor != '\0' && *cursor != '"' && used + 1 < size) {
    if (*cursor == '\\' && cursor[1] != '\0') {
      cursor++;
    }

    buffer[used++] = *cursor++;
  }

  buffer[used] = '\0';
  return used > 0 ? 0 : -1;
}

static int pm_path_contains_or_equals(const char *candidate, const char *root) {
  size_t root_length;

  if (candidate == NULL || root == NULL || candidate[0] == '\0' || root[0] == '\0') {
    return 0;
  }

  root_length = strlen(root);
  if (strcmp(candidate, root) == 0) {
    return 1;
  }

  return strncmp(candidate, root, root_length) == 0 && (root[root_length - 1] == '/' || candidate[root_length] == '/');
}

static const char *pm_current_network_id(void) {
  const char *network_id = getenv("PORT_MANAGER_NETWORK_ID");

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("PORT_MANAGER_ROUTE_TABLE_NETWORK_ID");
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("PORT_MANAGER_BORROWED_NETWORK_ID");
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("NEWDLOPS_PM_NETWORK_ID");
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("NEWDLOPS_PM_BORROWED_NETWORK_ID");
  }

  return network_id;
}

/**
 * Chooses a route table that matches the active network even when a child
 * process inherited a stale PORT_MANAGER_ROUTES_FILE from another terminal.
 */
static void pm_effective_route_table_path(char *buffer, size_t size) {
  const char *network_id = pm_current_network_id();
  const char *configured = getenv("PORT_MANAGER_ROUTES_FILE");
  char configured_network[PM_MAX_TEXT];
  char base_route_table_path[PM_MAX_PATH];

  if (buffer == NULL || size == 0) {
    return;
  }

  buffer[0] = '\0';
  if (network_id == NULL || network_id[0] == '\0') {
    pm_default_route_table_path(buffer, size);
    return;
  }

  if (
    configured != NULL &&
    configured[0] != '\0' &&
    pm_route_table_path_network_id(configured, configured_network, sizeof(configured_network)) == 0 &&
    strcmp(configured_network, network_id) == 0
  ) {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  pm_default_global_route_table_path(base_route_table_path, sizeof(base_route_table_path));
  if (base_route_table_path[0] == '\0' && configured != NULL && configured[0] != '\0') {
    pm_route_table_path_without_network_scope(configured, base_route_table_path, sizeof(base_route_table_path));
  }

  if (pm_scoped_route_table_path(base_route_table_path, network_id, buffer, size) == 0) {
    return;
  }

  pm_default_route_table_path(buffer, size);
}

static void pm_network_scope_payload_for_id(const char *network_id, char *buffer, size_t size) {
  char network_json[PM_MAX_TEXT * 2];

  if (size == 0) {
    return;
  }

  if (network_id == NULL || network_id[0] == '\0') {
    buffer[0] = '\0';
    return;
  }

  pm_json_escape(network_id, network_json, sizeof(network_json));
  snprintf(buffer, size, ",\"networkId\":\"%s\"", network_json);
}

static void pm_network_scope_payload(char *buffer, size_t size) {
  pm_network_scope_payload_for_id(pm_current_network_id(), buffer, size);
}

static const char *pm_experimental_route_ownership_mode(void) {
  const char *mode = getenv(PM_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE_ENV);

  if (mode == NULL) {
    return NULL;
  }

  if (strcmp(mode, PM_TERMINAL_SCOPE_LISTENER_MODE) == 0 ||
      strcmp(mode, PM_LOOPBACK_ADDRESS_ONLY_MODE) == 0) {
    return mode;
  }

  return NULL;
}

static int pm_scoped_route_ownership_enabled(void) {
  return pm_experimental_route_ownership_mode() != NULL;
}

static int pm_loopback_address_only_mode(void) {
  const char *mode = pm_experimental_route_ownership_mode();
  return mode != NULL && strcmp(mode, PM_LOOPBACK_ADDRESS_ONLY_MODE) == 0;
}

static int pm_positive_int_text(const char *value) {
  char *end = NULL;
  long parsed;

  if (value == NULL || value[0] == '\0') {
    return 0;
  }

  parsed = strtol(value, &end, 10);
  if (end == value || *end != '\0' || parsed <= 0 || parsed > 2147483647L) {
    return 0;
  }

  return (int)parsed;
}

static void pm_append_text(char *buffer, size_t size, const char *value) {
  size_t length;

  if (buffer == NULL || size == 0 || value == NULL) {
    return;
  }

  length = strlen(buffer);
  if (length >= size - 1) {
    return;
  }

  snprintf(buffer + length, size - length, "%s", value);
}

static void pm_terminal_scope_payload(char *buffer, size_t size) {
  const char *session_id = getenv("PORT_MANAGER_TERMINAL_SESSION_ID");
  const char *process_group_text = getenv("PORT_MANAGER_TERMINAL_PROCESS_GROUP_ID");
  const char *mode = pm_experimental_route_ownership_mode();
  char mode_json[PM_MAX_TEXT * 2];
  char session_json[PM_MAX_TEXT * 2];
  int process_group_id;

  if (size == 0) {
    return;
  }

  if (!pm_scoped_route_ownership_enabled() || mode == NULL) {
    buffer[0] = '\0';
    return;
  }

  pm_json_escape(mode, mode_json, sizeof(mode_json));
  snprintf(buffer, size, ",\"experimentalRouteOwnershipMode\":\"%s\"", mode_json);
  if (session_id != NULL && session_id[0] != '\0') {
    pm_json_escape(session_id, session_json, sizeof(session_json));
    pm_append_text(buffer, size, ",\"terminalSessionId\":\"");
    pm_append_text(buffer, size, session_json);
    pm_append_text(buffer, size, "\"");
  }

  process_group_id = pm_positive_int_text(process_group_text);
  if (process_group_id > 0) {
    char process_group_json[64];
    snprintf(process_group_json, sizeof(process_group_json), ",\"processGroupId\":%d", process_group_id);
    pm_append_text(buffer, size, process_group_json);
  }
}

static int pm_route_matches_network(const char *route_json) {
  const char *network_id = pm_current_network_id();
  char route_network[PM_MAX_TEXT];

  if (network_id == NULL || network_id[0] == '\0') {
    return pm_json_string(route_json, "networkId", route_network, sizeof(route_network)) != 0;
  }

  if (pm_json_string(route_json, "networkId", route_network, sizeof(route_network)) != 0) {
    return 0;
  }

  return strcmp(route_network, network_id) == 0;
}

static time_t pm_stat_mtime_sec(const struct stat *stat_buffer) {
#if defined(__APPLE__)
  return stat_buffer->st_mtimespec.tv_sec;
#else
  return stat_buffer->st_mtim.tv_sec;
#endif
}

static long pm_stat_mtime_nsec(const struct stat *stat_buffer) {
#if defined(__APPLE__)
  return stat_buffer->st_mtimespec.tv_nsec;
#else
  return stat_buffer->st_mtim.tv_nsec;
#endif
}

/*
 * Legacy route files do not carry expiresAtMs, so mtime is the fail-closed TTL
 * guard that also keeps the in-memory route-file cache from outliving the file.
 */
static int pm_route_file_stat_expired(const struct stat *stat_buffer) {
  long now_ms;
  long mtime_ms;

  if (stat_buffer == NULL) {
    return 1;
  }

  now_ms = pm_now_milliseconds();
  mtime_ms = (long)pm_stat_mtime_sec(stat_buffer) * 1000L;
  if (now_ms <= 0 || mtime_ms <= 0) {
    return 0;
  }

  return now_ms - mtime_ms > pm_route_table_ttl_seconds() * 1000L;
}

/** New route-table documents expose an explicit wall-clock expiry for readers. */
static int pm_route_file_buffer_expired(const char *buffer) {
  long expires_at_ms;
  long now_ms;

  if (buffer == NULL) {
    return 1;
  }

  expires_at_ms = pm_json_long(buffer, "expiresAtMs", 0);
  if (expires_at_ms <= 0) {
    return 0;
  }

  now_ms = pm_now_milliseconds();
  if (now_ms <= 0 || now_ms < expires_at_ms) {
    return 0;
  }

  return 1;
}

static void pm_clear_route_file_cache_entry(pm_route_file_cache_entry *entry) {
  if (entry == NULL) {
    return;
  }

  free(entry->routes);
  memset(entry, 0, sizeof(*entry));
}

static void pm_clear_route_file_cache(void) {
  pthread_mutex_lock(&pm_route_file_cache_mutex);
  for (size_t index = 0; index < pm_route_file_cache_count; index++) {
    pm_clear_route_file_cache_entry(&pm_route_file_cache[index]);
  }
  free(pm_route_file_cache);
  pm_route_file_cache = NULL;
  pm_route_file_cache_count = 0;
  pm_route_file_cache_capacity = 0;
  pthread_mutex_unlock(&pm_route_file_cache_mutex);
}

static int pm_route_file_cache_entry_matches(
  const pm_route_file_cache_entry *entry,
  const char *path,
  const struct stat *stat_buffer) {
  return entry != NULL &&
    entry->path[0] != '\0' &&
    strcmp(entry->path, path) == 0 &&
    entry->size == stat_buffer->st_size &&
    entry->mtime_sec == pm_stat_mtime_sec(stat_buffer) &&
    entry->mtime_nsec == pm_stat_mtime_nsec(stat_buffer);
}

static int pm_copy_cached_routes(
  const pm_cached_route *routes,
  size_t route_count,
  pm_cached_route **routes_out,
  size_t *route_count_out) {
  pm_cached_route *copy = NULL;

  if (routes_out == NULL || route_count_out == NULL) {
    return -1;
  }

  *routes_out = NULL;
  *route_count_out = 0;
  if (route_count == 0) {
    return 0;
  }

  copy = (pm_cached_route *)malloc(route_count * sizeof(pm_cached_route));
  if (copy == NULL) {
    return -1;
  }

  memcpy(copy, routes, route_count * sizeof(pm_cached_route));
  *routes_out = copy;
  *route_count_out = route_count;
  return 0;
}

static int pm_get_cached_route_file(
  const char *path,
  const struct stat *stat_buffer,
  pm_cached_route **routes_out,
  size_t *route_count_out) {
  int found = 0;

  pthread_mutex_lock(&pm_route_file_cache_mutex);
  for (size_t index = 0; index < pm_route_file_cache_count; index++) {
    pm_route_file_cache_entry *entry = &pm_route_file_cache[index];
    if (!pm_route_file_cache_entry_matches(entry, path, stat_buffer)) {
      continue;
    }

    entry->last_used = pm_route_file_cache_tick++;
    found = pm_copy_cached_routes(entry->routes, entry->route_count, routes_out, route_count_out) == 0;
    break;
  }
  pthread_mutex_unlock(&pm_route_file_cache_mutex);

  return found ? 0 : -1;
}

static int pm_ensure_route_file_cache_capacity(size_t required) {
  size_t next_capacity;
  pm_route_file_cache_entry *next_cache;

  if (required <= pm_route_file_cache_capacity) {
    return 0;
  }
  if (required > PM_ROUTE_FILE_CACHE_MAX_CAPACITY) {
    return -1;
  }

  next_capacity = pm_route_file_cache_capacity == 0 ? PM_ROUTE_FILE_CACHE_INITIAL_CAPACITY : pm_route_file_cache_capacity;
  while (next_capacity < required) {
    if (next_capacity >= PM_ROUTE_FILE_CACHE_MAX_CAPACITY) {
      next_capacity = PM_ROUTE_FILE_CACHE_MAX_CAPACITY;
      break;
    }
    if (next_capacity > PM_ROUTE_FILE_CACHE_MAX_CAPACITY / 2) {
      next_capacity = PM_ROUTE_FILE_CACHE_MAX_CAPACITY;
    } else {
      next_capacity *= 2;
    }
  }

  next_cache = (pm_route_file_cache_entry *)realloc(
    pm_route_file_cache,
    next_capacity * sizeof(pm_route_file_cache_entry));
  if (next_cache == NULL) {
    return -1;
  }

  memset(
    next_cache + pm_route_file_cache_capacity,
    0,
    (next_capacity - pm_route_file_cache_capacity) * sizeof(pm_route_file_cache_entry));
  pm_route_file_cache = next_cache;
  pm_route_file_cache_capacity = next_capacity;
  return 0;
}

static void pm_store_route_file_cache(
  const char *path,
  const struct stat *stat_buffer,
  const pm_cached_route *routes,
  size_t route_count) {
  pm_route_file_cache_entry *entry = NULL;
  pm_cached_route *copy = NULL;

  if (route_count > 0) {
    copy = (pm_cached_route *)malloc(route_count * sizeof(pm_cached_route));
    if (copy == NULL) {
      return;
    }
    memcpy(copy, routes, route_count * sizeof(pm_cached_route));
  }

  pthread_mutex_lock(&pm_route_file_cache_mutex);
  for (size_t index = 0; index < pm_route_file_cache_count; index++) {
    if (strcmp(pm_route_file_cache[index].path, path) == 0) {
      entry = &pm_route_file_cache[index];
      break;
    }
  }

  if (entry == NULL) {
    if (pm_ensure_route_file_cache_capacity(pm_route_file_cache_count + 1) != 0) {
      pthread_mutex_unlock(&pm_route_file_cache_mutex);
      free(copy);
      return;
    }
    entry = &pm_route_file_cache[pm_route_file_cache_count++];
  }

  pm_clear_route_file_cache_entry(entry);
  snprintf(entry->path, sizeof(entry->path), "%s", path);
  entry->mtime_sec = pm_stat_mtime_sec(stat_buffer);
  entry->mtime_nsec = pm_stat_mtime_nsec(stat_buffer);
  entry->size = stat_buffer->st_size;
  entry->routes = copy;
  entry->route_count = route_count;
  entry->last_used = pm_route_file_cache_tick++;
  pthread_mutex_unlock(&pm_route_file_cache_mutex);
}

static int pm_append_cached_route(
  pm_cached_route **routes,
  size_t *route_count,
  size_t *capacity,
  const char *route_json) {
  pm_cached_route *next_routes;
  pm_cached_route *route;
  char source[32];

  if (*route_count >= *capacity) {
    size_t next_capacity = *capacity == 0 ? 16 : *capacity * 2;
    next_routes = (pm_cached_route *)realloc(*routes, next_capacity * sizeof(pm_cached_route));
    if (next_routes == NULL) {
      return -1;
    }
    *routes = next_routes;
    *capacity = next_capacity;
  }

  route = &(*routes)[(*route_count)++];
  memset(route, 0, sizeof(*route));
  route->logical_port = pm_json_int(route_json, "logicalPort", 0);
  route->actual_port = pm_json_int(route_json, "actualPort", 0);
  if (pm_json_string(route_json, "host", route->host, sizeof(route->host)) != 0) {
    route->host[0] = '\0';
  }
  route->has_network_id = pm_json_string(route_json, "networkId", route->network_id, sizeof(route->network_id)) == 0;
  route->has_cwd = pm_json_string(route_json, "cwd", route->cwd, sizeof(route->cwd)) == 0;
  if (pm_json_string(route_json, "routeDirection", route->route_direction, sizeof(route->route_direction)) != 0) {
    route->route_direction[0] = '\0';
  }
  route->is_compose = pm_json_string(route_json, "source", source, sizeof(source)) == 0 && strcmp(source, "compose") == 0;
  return 0;
}

static int pm_parse_route_file_buffer(char *buffer, pm_cached_route **routes_out, size_t *route_count_out) {
  pm_cached_route *routes = NULL;
  size_t route_count = 0;
  size_t capacity = 0;
  char *cursor = buffer;

  if (routes_out == NULL || route_count_out == NULL) {
    return -1;
  }

  *routes_out = NULL;
  *route_count_out = 0;
  while ((cursor = strchr(cursor, '{')) != NULL) {
    char *object_start = cursor;
    char *object_end = strchr(cursor, '}');
    char object_end_saved;
    int logical;
    int actual;

    if (object_end == NULL) {
      break;
    }

    object_end_saved = *object_end;
    *object_end = '\0';
    logical = pm_json_int(object_start, "logicalPort", 0);
    actual = pm_json_int(object_start, "actualPort", 0);
    if (logical > 0 && actual > 0 && pm_append_cached_route(&routes, &route_count, &capacity, object_start) != 0) {
      *object_end = object_end_saved;
      free(routes);
      return -1;
    }
    *object_end = object_end_saved;
    cursor = object_end + 1;
  }

  *routes_out = routes;
  *route_count_out = route_count;
  return 0;
}

static int pm_load_route_file_routes(const char *path, pm_cached_route **routes_out, size_t *route_count_out) {
  pm_cached_route *routes = NULL;
  size_t route_count = 0;
  char *buffer;
  int fd;
  struct stat stat_buffer;
  ssize_t read_count;

  if (routes_out == NULL || route_count_out == NULL) {
    return -1;
  }

  *routes_out = NULL;
  *route_count_out = 0;
  fd = open(path, O_RDONLY);
  if (fd < 0) {
    return -1;
  }

  if (fstat(fd, &stat_buffer) != 0 || stat_buffer.st_size <= 0 || stat_buffer.st_size > 1024 * 1024) {
    close(fd);
    return -1;
  }

  if (!pm_route_file_stat_expired(&stat_buffer) && pm_get_cached_route_file(path, &stat_buffer, routes_out, route_count_out) == 0) {
    close(fd);
    return 0;
  }

  buffer = (char *)malloc((size_t)stat_buffer.st_size + 1);
  if (buffer == NULL) {
    close(fd);
    return -1;
  }

  read_count = read(fd, buffer, (size_t)stat_buffer.st_size);
  close(fd);
  if (read_count <= 0) {
    free(buffer);
    return -1;
  }

  buffer[read_count] = '\0';
  if (
    pm_route_file_buffer_expired(buffer) ||
    (pm_json_long(buffer, "expiresAtMs", 0) <= 0 && pm_route_file_stat_expired(&stat_buffer))
  ) {
    free(buffer);
    return -1;
  }

  if (pm_parse_route_file_buffer(buffer, &routes, &route_count) != 0) {
    free(buffer);
    return -1;
  }
  free(buffer);

  pm_store_route_file_cache(path, &stat_buffer, routes, route_count);
  *routes_out = routes;
  *route_count_out = route_count;
  return 0;
}

static int pm_cached_route_network_match_level(const pm_cached_route *route) {
  const char *network_id = pm_current_network_id();

  if (network_id == NULL || network_id[0] == '\0') {
    return route->has_network_id ? 0 : 2;
  }

  if (!route->has_network_id) {
    return 0;
  }

  return strcmp(route->network_id, network_id) == 0 ? 2 : 0;
}

static int pm_cached_route_matches_cwd(const pm_cached_route *route, const char *current_cwd) {
  if (!route->has_cwd) {
    return 0;
  }

  return pm_path_contains_or_equals(current_cwd, route->cwd) || pm_path_contains_or_equals(route->cwd, current_cwd);
}

static int pm_cached_route_direction_matches(const pm_cached_route *route, const char *required_direction) {
  if (required_direction == NULL || required_direction[0] == '\0') {
    return 1;
  }

  if (route->route_direction[0] == '\0') {
    return strcmp(required_direction, "listen") == 0;
  }

  return strcmp(route->route_direction, required_direction) == 0;
}

static int pm_cached_route_is_foreign_to_current_network(const pm_cached_route *route) {
  const char *network_id = pm_current_network_id();

  if (!route->has_network_id) {
    return 0;
  }

  if (network_id == NULL || network_id[0] == '\0') {
    return 1;
  }

  return strcmp(route->network_id, network_id) != 0;
}

static int pm_host_access_lookup(int logical_port, char *target_host, size_t target_host_size) {
  char path[PM_MAX_PATH];
  char *buffer;
  int fd;
  struct stat stat_buffer;
  ssize_t read_count;
  char *cursor;

  pm_default_host_access_path(path, sizeof(path));
  fd = open(path, O_RDONLY);
  if (fd < 0) {
    return 0;
  }

  if (fstat(fd, &stat_buffer) != 0 || stat_buffer.st_size <= 0 || stat_buffer.st_size > 1024 * 1024) {
    close(fd);
    return 0;
  }

  buffer = (char *)malloc((size_t)stat_buffer.st_size + 1);
  if (buffer == NULL) {
    close(fd);
    return 0;
  }

  read_count = read(fd, buffer, (size_t)stat_buffer.st_size);
  close(fd);
  if (read_count <= 0) {
    free(buffer);
    return 0;
  }

  buffer[read_count] = '\0';
  cursor = buffer;

  while ((cursor = pm_find_json_int_key(cursor, "logicalPort", logical_port)) != NULL) {
    char *object_start = cursor;
    char *object_end = strchr(cursor, '}');
    int host_port;

    while (object_start > buffer && *object_start != '{') {
      object_start--;
    }

    if (object_end == NULL) {
      break;
    }

    *object_end = '\0';
    host_port = pm_json_int(object_start, "hostPort", 0);
    if (host_port > 0 && pm_route_matches_network(object_start)) {
      if (pm_json_string(object_start, "hostAddress", target_host, target_host_size) != 0) {
        snprintf(target_host, target_host_size, "127.0.0.1");
      }
      free(buffer);
      return host_port;
    }

    cursor = object_end + 1;
  }

  free(buffer);
  return 0;
}

static int pm_response_ok(const char *response) {
  return strstr(response, "\"ok\":true") != NULL || strstr(response, "\"ok\": true") != NULL;
}

static int pm_process_is_alive(pid_t pid) {
  if (pid <= 0) {
    return 0;
  }

  if (kill(pid, 0) == 0) {
    return 1;
  }

  return errno == EPERM;
}

static pid_t pm_lock_owner_pid(const char *path) {
  char buffer[64];
  int fd;
  ssize_t count;
  char *end = NULL;
  long pid;

  fd = open(path, O_RDONLY);
  if (fd < 0) {
    return 0;
  }

  count = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);
  if (count <= 0) {
    return 0;
  }

  buffer[count] = '\0';
  pid = strtol(buffer, &end, 10);
  if (end == buffer || pid <= 0) {
    return 0;
  }

  return (pid_t)pid;
}

static int pm_send_allocation_lock_path(int logical_port, char *buffer, size_t size) {
  char route_table_path[PM_MAX_PATH];
  char route_entry_path[PM_MAX_PATH];
  int written;

  if (buffer == NULL || size == 0 || logical_port <= 0) {
    return -1;
  }

  pm_effective_route_table_path(route_table_path, sizeof(route_table_path));
  if (route_table_path[0] == '\0') {
    return -1;
  }

  pm_route_entry_path(route_table_path, logical_port, route_entry_path, sizeof(route_entry_path));
  written = snprintf(buffer, size, "%s.send.lock", route_entry_path);
  return written > 0 && (size_t)written < size ? 0 : -1;
}

static int pm_try_remove_stale_lock(const char *path) {
  struct stat stat_buffer;
  long now_ms;
  long mtime_ms;
  pid_t owner_pid;

  if (path == NULL || stat(path, &stat_buffer) != 0) {
    return 0;
  }

  now_ms = pm_now_milliseconds();
  mtime_ms = (long)pm_stat_mtime_sec(&stat_buffer) * 1000L + pm_stat_mtime_nsec(&stat_buffer) / 1000000L;
  owner_pid = pm_lock_owner_pid(path);
  if (
    now_ms > 0 &&
    mtime_ms > 0 &&
    now_ms - mtime_ms > PM_SEND_ALLOCATION_LOCK_STALE_MS &&
    !pm_process_is_alive(owner_pid)
  ) {
    return unlink(path) == 0;
  }

  return 0;
}

static int pm_try_acquire_send_allocation_lock(const char *path) {
  char payload[64];
  int fd;
  int written;

  if (path == NULL || path[0] == '\0') {
    return 0;
  }

  fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0600);
  if (fd < 0 && errno == EEXIST && pm_try_remove_stale_lock(path)) {
    fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0600);
  }
  if (fd < 0) {
    return 0;
  }

  written = snprintf(payload, sizeof(payload), "%ld\n%ld\n", (long)getpid(), pm_now_milliseconds());
  if (written > 0) {
    (void)write(fd, payload, (size_t)written);
  }
  close(fd);
  return 1;
}

static void pm_release_send_allocation_lock(const char *path) {
  if (path != NULL && path[0] != '\0') {
    unlink(path);
  }
}

static int pm_reuse_existing_send_route(
  int logical_port,
  int *actual_port,
  char *allocation_id,
  size_t allocation_size,
  char *allocated_host,
  size_t allocated_host_size) {
  char target_host[128];
  int route_is_compose = 0;
  int route_port;

  target_host[0] = '\0';
  route_port = pm_connect_route_table_lookup(logical_port, target_host, sizeof(target_host), &route_is_compose);
  (void)route_is_compose;
  if (route_port <= 0) {
    return 0;
  }

  if (actual_port != NULL) {
    *actual_port = route_port;
  }
  if (allocation_id != NULL && allocation_size > 0) {
    allocation_id[0] = '\0';
  }
  if (allocated_host != NULL && allocated_host_size > 0) {
    snprintf(allocated_host, allocated_host_size, "%s", target_host[0] == '\0' ? "127.0.0.1" : target_host);
  }
  pm_debug("joined route allocation logical=%d actual=%d host=%s", logical_port, route_port, target_host);
  return 1;
}

static int pm_join_or_acquire_send_allocation_lock(
  int logical_port,
  char *lock_path,
  size_t lock_path_size,
  int *actual_port,
  char *allocation_id,
  size_t allocation_size,
  char *allocated_host,
  size_t allocated_host_size) {
  int wait_ms;
  int waited_ms = 0;

  if (pm_send_allocation_lock_path(logical_port, lock_path, lock_path_size) != 0) {
    return 0;
  }

  /*
   * This lock is not an ownership decision for servers. It only lets sender-first
   * connect() hooks converge behind the first route allocation instead of
   * stampeding the single daemon when many polling clients start together.
   */
  wait_ms = pm_parse_int_env("PORT_MANAGER_SEND_ALLOCATION_JOIN_WAIT_MS", PM_SEND_ALLOCATION_JOIN_WAIT_MS);
  if (wait_ms > 10000) {
    wait_ms = 10000;
  }

  while (waited_ms <= wait_ms) {
    if (pm_reuse_existing_send_route(
          logical_port,
          actual_port,
          allocation_id,
          allocation_size,
          allocated_host,
          allocated_host_size)) {
      return -1;
    }

    if (pm_try_acquire_send_allocation_lock(lock_path)) {
      if (pm_reuse_existing_send_route(
            logical_port,
            actual_port,
            allocation_id,
            allocation_size,
            allocated_host,
            allocated_host_size)) {
        pm_release_send_allocation_lock(lock_path);
        return -1;
      }
      return 1;
    }

    if (waited_ms >= wait_ms) {
      break;
    }

    usleep(PM_SEND_ALLOCATION_LOCK_POLL_MS * 1000);
    waited_ms += PM_SEND_ALLOCATION_LOCK_POLL_MS;
  }

  pm_debug("send allocation lock busy logical=%d wait_ms=%d; falling back to daemon request", logical_port, waited_ms);
  return 0;
}

static int pm_allocate_route(
  int logical_port,
  const char *host,
  const char *actual_host,
  const char *route_direction,
  int *actual_port,
  char *allocation_id,
  size_t allocation_size,
  char *allocated_host,
  size_t allocated_host_size) {
  char cwd[PM_MAX_TEXT];
  char command[PM_MAX_TEXT];
  char cwd_json[PM_MAX_TEXT * 2];
  char command_json[PM_MAX_TEXT * 2];
  char host_json[256];
  char actual_host_json[256];
  char actual_host_payload[320];
  char route_direction_json[32];
  char network_payload[PM_MAX_TEXT * 3];
  char terminal_scope_payload[PM_MAX_TEXT * 3];
  char request[PM_MAX_REQUEST];
  char response[PM_MAX_RESPONSE];
  char send_allocation_lock_path[PM_MAX_PATH];
  unsigned long sequence = __sync_fetch_and_add(&pm_request_sequence, 1);
  int owns_send_allocation_lock = 0;
  int is_sender_first_route = route_direction != NULL && strcmp(route_direction, "send") == 0;

  pm_cwd(cwd, sizeof(cwd));
  pm_command_name(command, sizeof(command));
  pm_json_escape(cwd, cwd_json, sizeof(cwd_json));
  pm_json_escape(command, command_json, sizeof(command_json));
  pm_json_escape(host, host_json, sizeof(host_json));
  if (actual_host != NULL && actual_host[0] != '\0' && strcmp(actual_host, host) != 0) {
    pm_json_escape(actual_host, actual_host_json, sizeof(actual_host_json));
    snprintf(actual_host_payload, sizeof(actual_host_payload), ",\"actualHost\":\"%s\"", actual_host_json);
  } else {
    actual_host_payload[0] = '\0';
  }
  pm_json_escape(route_direction == NULL ? "listen" : route_direction, route_direction_json, sizeof(route_direction_json));
  pm_network_scope_payload(network_payload, sizeof(network_payload));
  pm_terminal_scope_payload(terminal_scope_payload, sizeof(terminal_scope_payload));
  response[0] = '\0';

  snprintf(
    request,
    sizeof(request),
    "{\"id\":\"hook-%ld-%lu\",\"method\":\"allocateRoute\",\"payload\":{\"name\":\"%s\",\"command\":\"%s\",\"cwd\":\"%s\",\"requestedPort\":%d,\"host\":\"%s\"%s,\"routeDirection\":\"%s\"%s%s,\"compactResponse\":1,\"scanRange\":%d,\"scanDirection\":\"up\",\"routingMode\":\"%s\",\"virtualPortRangeStart\":%d,\"virtualPortRangeEnd\":%d}}\n",
    (long)getpid(),
    sequence,
    command_json,
    command_json,
    cwd_json,
    logical_port,
    host_json,
    actual_host_payload,
    route_direction_json,
    network_payload,
    terminal_scope_payload,
    pm_parse_int_env("PORT_MANAGER_SCAN_RANGE", PM_DEFAULT_SCAN_RANGE),
    pm_routing_mode(),
    pm_parse_int_env("PORT_MANAGER_VIRTUAL_PORT_START", PM_DEFAULT_VIRTUAL_START),
    pm_parse_int_env("PORT_MANAGER_VIRTUAL_PORT_END", PM_DEFAULT_VIRTUAL_END));

  pm_debug(
    "allocating route logical=%d host=%s actualHost=%s direction=%s mode=%s",
    logical_port,
    host,
    actual_host != NULL && actual_host[0] != '\0' ? actual_host : host,
    route_direction_json,
    pm_routing_mode());

  send_allocation_lock_path[0] = '\0';
  if (is_sender_first_route) {
    int join_result = pm_join_or_acquire_send_allocation_lock(
      logical_port,
      send_allocation_lock_path,
      sizeof(send_allocation_lock_path),
      actual_port,
      allocation_id,
      allocation_size,
      allocated_host,
      allocated_host_size);
    if (join_result < 0) {
      return 0;
    }
    owns_send_allocation_lock = join_result > 0;
  }

  if (pm_agent_roundtrip(request, response, sizeof(response)) != 0 || !pm_response_ok(response)) {
    if (owns_send_allocation_lock) {
      pm_release_send_allocation_lock(send_allocation_lock_path);
    }
    pm_debug("allocateRoute failed logical=%d response=%.240s", logical_port, response);
    return -1;
  }

  *actual_port = pm_json_int(response, "actualPort", logical_port);
  if (pm_json_string(response, "allocationId", allocation_id, allocation_size) != 0) {
    allocation_id[0] = '\0';
  }
  if (allocated_host != NULL && allocated_host_size > 0) {
    if (pm_json_string(response, "host", allocated_host, allocated_host_size) != 0) {
      snprintf(allocated_host, allocated_host_size, "%s", actual_host != NULL && actual_host[0] != '\0' ? actual_host : host);
    }
  }
  pm_debug(
    "allocated route logical=%d actual=%d host=%s allocation=%s",
    logical_port,
    *actual_port,
    allocated_host != NULL && allocated_host[0] != '\0' ? allocated_host : "",
    allocation_id);

  if (owns_send_allocation_lock) {
    pm_release_send_allocation_lock(send_allocation_lock_path);
  }
  return 0;
}

static int pm_send_simple_payload(const char *method, const char *payload) {
  char request[PM_MAX_REQUEST];
  char response[PM_MAX_RESPONSE];
  unsigned long sequence = __sync_fetch_and_add(&pm_request_sequence, 1);

  response[0] = '\0';
  snprintf(
    request,
    sizeof(request),
    "{\"id\":\"hook-%ld-%lu\",\"method\":\"%s\",\"payload\":%s}\n",
    (long)getpid(),
    sequence,
    method,
    payload);
  if (pm_agent_roundtrip(request, response, sizeof(response)) != 0 || !pm_response_ok(response)) {
    pm_debug("%s failed response=%.240s", method, response);
    return -1;
  }

  pm_debug("%s succeeded", method);
  return 0;
}

static void pm_register_process(int logical_port, int actual_port, const char *host, const char *allocation_id) {
  char cwd[PM_MAX_TEXT];
  char command[PM_MAX_TEXT];
  char cwd_json[PM_MAX_TEXT * 2];
  char command_json[PM_MAX_TEXT * 2];
  char host_json[256];
  char allocation_json[PM_MAX_TEXT * 2];
  char network_payload[PM_MAX_TEXT * 3];
  char terminal_scope_payload[PM_MAX_TEXT * 3];
  char payload[PM_MAX_REQUEST];

  pm_cwd(cwd, sizeof(cwd));
  pm_command_name(command, sizeof(command));
  pm_json_escape(cwd, cwd_json, sizeof(cwd_json));
  pm_json_escape(command, command_json, sizeof(command_json));
  pm_json_escape(host, host_json, sizeof(host_json));
  pm_json_escape(allocation_id, allocation_json, sizeof(allocation_json));
  pm_network_scope_payload(network_payload, sizeof(network_payload));
  pm_terminal_scope_payload(terminal_scope_payload, sizeof(terminal_scope_payload));

  snprintf(
    payload,
    sizeof(payload),
    "{\"pid\":%ld,\"name\":\"%s\",\"command\":\"%s\",\"cwd\":\"%s\",\"requestedPort\":%d,\"actualPort\":%d,\"host\":\"%s\"%s%s,\"allocationId\":\"%s\",\"source\":\"hooked\"}",
    (long)getpid(),
    command_json,
    command_json,
    cwd_json,
    logical_port,
    actual_port,
    host_json,
    network_payload,
    terminal_scope_payload,
    allocation_json);
  pm_debug("registering hooked process logical=%d actual=%d host=%s allocation=%s", logical_port, actual_port, host, allocation_id);
  (void)pm_send_simple_payload("registerExistingProcess", payload);
}

static void pm_release_allocation(const char *allocation_id) {
  char allocation_json[PM_MAX_TEXT * 2];
  char payload[PM_MAX_TEXT * 3];

  if (allocation_id == NULL || allocation_id[0] == '\0') {
    return;
  }

  pm_json_escape(allocation_id, allocation_json, sizeof(allocation_json));
  snprintf(payload, sizeof(payload), "{\"allocationId\":\"%s\"}", allocation_json);
  (void)pm_send_simple_payload("releaseRouteAllocation", payload);
}

static int pm_release_process_route(const pm_route_mapping *route) {
  char allocation_json[PM_MAX_TEXT * 2];
  char network_payload[PM_MAX_TEXT * 3];
  char terminal_scope_payload[PM_MAX_TEXT * 3];
  char payload[PM_MAX_REQUEST];

  if (route == NULL || route->logical_port <= 0 || route->actual_port <= 0) {
    return 0;
  }

  pm_json_escape(route->allocation_id, allocation_json, sizeof(allocation_json));
  pm_network_scope_payload_for_id(route->network_id, network_payload, sizeof(network_payload));
  pm_terminal_scope_payload(terminal_scope_payload, sizeof(terminal_scope_payload));
  snprintf(
    payload,
    sizeof(payload),
    "{\"pid\":%ld,\"allocationId\":\"%s\",\"requestedPort\":%d,\"actualPort\":%d%s%s}",
    (long)getpid(),
    allocation_json,
    route->logical_port,
    route->actual_port,
    network_payload,
    terminal_scope_payload);
  return pm_send_simple_payload("releaseProcessRoute", payload);
}

static int pm_ensure_memory_route_capacity(size_t required) {
  size_t next_capacity;
  pm_route_mapping *next_routes;

  if (required <= pm_route_capacity) {
    return 0;
  }
  if (required > PM_ROUTE_MAPPING_MAX_CAPACITY) {
    return -1;
  }

  next_capacity = pm_route_capacity == 0 ? PM_ROUTE_MAPPING_INITIAL_CAPACITY : pm_route_capacity;
  while (next_capacity < required) {
    if (next_capacity >= PM_ROUTE_MAPPING_MAX_CAPACITY) {
      next_capacity = PM_ROUTE_MAPPING_MAX_CAPACITY;
      break;
    }
    if (next_capacity > PM_ROUTE_MAPPING_MAX_CAPACITY / 2) {
      next_capacity = PM_ROUTE_MAPPING_MAX_CAPACITY;
    } else {
      next_capacity *= 2;
    }
  }

  next_routes = (pm_route_mapping *)realloc(pm_routes, next_capacity * sizeof(pm_route_mapping));
  if (next_routes == NULL) {
    return -1;
  }

  memset(next_routes + pm_route_capacity, 0, (next_capacity - pm_route_capacity) * sizeof(pm_route_mapping));
  pm_routes = next_routes;
  pm_route_capacity = next_capacity;
  return 0;
}

static void pm_clear_memory_routes(void) {
  pthread_mutex_lock(&pm_route_mutex);
  free(pm_routes);
  pm_routes = NULL;
  pm_route_count = 0;
  pm_route_capacity = 0;
  pthread_mutex_unlock(&pm_route_mutex);
}

static void pm_release_process_routes(void) {
  pm_route_mapping *routes;
  size_t route_count;

  /*
   * Listener scans are intentionally conservative, but the process that owns a
   * route knows when it is exiting. Release those rows here so endpoint route
   * files cannot keep pointing at a dead actual port until the next scan grace.
   */
  pthread_mutex_lock(&pm_route_mutex);
  route_count = pm_route_count;
  routes = route_count == 0 ? NULL : (pm_route_mapping *)malloc(route_count * sizeof(pm_route_mapping));
  if (routes != NULL) {
    memcpy(routes, pm_routes, route_count * sizeof(pm_route_mapping));
  }
  pthread_mutex_unlock(&pm_route_mutex);

  if (route_count > 0 && routes == NULL) {
    return;
  }

  for (size_t index = 0; index < route_count; index++) {
    if (pm_release_process_route(&routes[index]) != 0) {
      break;
    }
  }
  free(routes);
}

static int pm_memory_route_expired(const pm_route_mapping *route, long now_ms) {
  return route != NULL && route->expires_at_ms > 0 && now_ms > 0 && now_ms >= route->expires_at_ms;
}

static void pm_remember_route(int logical_port, int actual_port, const char *host, const char *allocation_id, long lease_ms) {
  pm_route_mapping *slot;
  const char *network_id = pm_current_network_id();
  const char *route_network_id = network_id == NULL ? "" : network_id;
  long now_ms = pm_now_milliseconds();
  long expires_at_ms = lease_ms > 0 && now_ms > 0 ? now_ms + lease_ms : 0;

  pthread_mutex_lock(&pm_route_mutex);
  for (size_t index = 0; index < pm_route_count; index++) {
    if (pm_routes[index].logical_port == logical_port && strcmp(pm_routes[index].network_id, route_network_id) == 0) {
      slot = &pm_routes[index];
      slot->actual_port = actual_port;
      slot->expires_at_ms = expires_at_ms;
      snprintf(slot->host, sizeof(slot->host), "%s", host);
      snprintf(slot->allocation_id, sizeof(slot->allocation_id), "%s", allocation_id);
      pthread_mutex_unlock(&pm_route_mutex);
      return;
    }
  }

  if (pm_ensure_memory_route_capacity(pm_route_count + 1) != 0) {
    pthread_mutex_unlock(&pm_route_mutex);
    return;
  }

  slot = &pm_routes[pm_route_count++];
  slot->logical_port = logical_port;
  slot->actual_port = actual_port;
  slot->expires_at_ms = expires_at_ms;
  snprintf(slot->host, sizeof(slot->host), "%s", host);
  snprintf(slot->allocation_id, sizeof(slot->allocation_id), "%s", allocation_id);
  snprintf(slot->network_id, sizeof(slot->network_id), "%s", route_network_id);
  pthread_mutex_unlock(&pm_route_mutex);
}

static int pm_memory_actual_for_logical(int logical_port, char *target_host, size_t target_host_size) {
  const char *network_id = pm_current_network_id();
  const char *route_network_id = network_id == NULL ? "" : network_id;
  int actual_port = 0;
  char host[128];
  long now_ms = pm_now_milliseconds();

  host[0] = '\0';
  pthread_mutex_lock(&pm_route_mutex);
  for (size_t index = 0; index < pm_route_count;) {
    if (pm_memory_route_expired(&pm_routes[index], now_ms)) {
      memmove(&pm_routes[index], &pm_routes[index + 1], (pm_route_count - index - 1) * sizeof(pm_route_mapping));
      pm_route_count--;
      continue;
    }

    if (pm_routes[index].logical_port == logical_port && strcmp(pm_routes[index].network_id, route_network_id) == 0) {
      actual_port = pm_routes[index].actual_port;
      snprintf(host, sizeof(host), "%s", pm_routes[index].host);
      break;
    }
    index++;
  }
  pthread_mutex_unlock(&pm_route_mutex);

  if (actual_port > 0 && target_host != NULL && target_host_size > 0) {
    snprintf(target_host, target_host_size, "%s", host);
  }

  return actual_port;
}

static int pm_memory_logical_for_actual(int actual_port) {
  const char *network_id = pm_current_network_id();
  const char *route_network_id = network_id == NULL ? "" : network_id;
  int logical_port = 0;
  long now_ms = pm_now_milliseconds();

  pthread_mutex_lock(&pm_route_mutex);
  for (size_t index = 0; index < pm_route_count;) {
    if (pm_memory_route_expired(&pm_routes[index], now_ms)) {
      memmove(&pm_routes[index], &pm_routes[index + 1], (pm_route_count - index - 1) * sizeof(pm_route_mapping));
      pm_route_count--;
      continue;
    }

    if (pm_routes[index].actual_port == actual_port && strcmp(pm_routes[index].network_id, route_network_id) == 0) {
      logical_port = pm_routes[index].logical_port;
      break;
    }
    index++;
  }
  pthread_mutex_unlock(&pm_route_mutex);

  return logical_port;
}

static int pm_route_table_lookup_file(
  const char *path,
  int source_port,
  int source_is_actual,
  const char *required_direction,
  char *target_host,
  size_t target_host_size,
  int *is_compose_route) {
  pm_cached_route *routes;
  size_t route_count;
  int fallback_port = 0;
  int fallback_is_compose = 0;
  char fallback_host[128];
  char current_cwd[PM_MAX_TEXT];

  if (is_compose_route != NULL) {
    *is_compose_route = 0;
  }

  if (pm_load_route_file_routes(path, &routes, &route_count) != 0) {
    return 0;
  }

  fallback_host[0] = '\0';
  pm_cwd(current_cwd, sizeof(current_cwd));

  for (size_t index = 0; index < route_count; index++) {
    const pm_cached_route *route = &routes[index];
    int match_level;
    int route_matches_cwd;

    if ((source_is_actual && route->actual_port != source_port) || (!source_is_actual && route->logical_port != source_port)) {
      continue;
    }

    match_level = pm_cached_route_network_match_level(route);
    route_matches_cwd = pm_cached_route_matches_cwd(route, current_cwd);
    if (!pm_cached_route_direction_matches(route, required_direction)) {
      continue;
    }

    /*
     * Compose/container routes are network-local claims over host-published
     * ports. A scoped route for another worktree must not become a global
     * fallback, otherwise localhost:<logical> would leak through host publish.
     * Detached hook processes can still use their own worktree's Compose
     * route; package launchers sometimes preserve the preload while losing the
     * explicit network id.
     */
    if (route->is_compose && match_level < 2 && !route_matches_cwd) {
      continue;
    }

    if (source_is_actual && match_level > 0) {
      if (match_level == 2) {
        if (is_compose_route != NULL) {
          *is_compose_route = route->is_compose;
        }
        fallback_port = route->logical_port;
        free(routes);
        return fallback_port;
      }

      if (fallback_port == 0 && (source_is_actual || route_matches_cwd)) {
        fallback_port = route->logical_port;
        fallback_is_compose = route->is_compose;
      }
    }

    if (!source_is_actual && match_level > 0) {
      if (match_level == 2) {
        if (target_host != NULL && target_host_size > 0) {
          snprintf(target_host, target_host_size, "%s", route->host[0] == '\0' ? "127.0.0.1" : route->host);
        }
        if (is_compose_route != NULL) {
          *is_compose_route = route->is_compose;
        }
        fallback_port = route->actual_port;
        free(routes);
        return fallback_port;
      }

      if (fallback_port == 0 && route_matches_cwd) {
        fallback_port = route->actual_port;
        fallback_is_compose = route->is_compose;
        snprintf(fallback_host, sizeof(fallback_host), "%s", route->host[0] == '\0' ? "127.0.0.1" : route->host);
      }
    }
  }

  free(routes);
  if (fallback_port > 0) {
    if (!source_is_actual && target_host != NULL && target_host_size > 0) {
      snprintf(target_host, target_host_size, "%s", fallback_host[0] == '\0' ? "127.0.0.1" : fallback_host);
    }
    if (is_compose_route != NULL) {
      *is_compose_route = fallback_is_compose;
    }
    return fallback_port;
  }

  return 0;
}

static int pm_compose_claim_blocks_port(int port) {
  char path[PM_MAX_PATH];
  char base_path[PM_MAX_PATH];
  pm_cached_route *routes;
  size_t route_count;
  int blocks_port = 0;

  pm_default_global_route_table_path(base_path, sizeof(base_path));
  pm_route_compose_claim_path(base_path, port, path, sizeof(path));
  if (pm_load_route_file_routes(path, &routes, &route_count) != 0) {
    return 0;
  }

  for (size_t index = 0; index < route_count; index++) {
    const pm_cached_route *route = &routes[index];
    if (
      (route->logical_port == port || route->actual_port == port) &&
      route->is_compose &&
      pm_cached_route_direction_matches(route, "listen") &&
      pm_cached_route_is_foreign_to_current_network(route)
    ) {
      blocks_port = 1;
      break;
    }
  }

  free(routes);
  return blocks_port;
}

static int pm_route_table_lookup(
  int source_port,
  int source_is_actual,
  const char *required_direction,
  char *target_host,
  size_t target_host_size,
  int *is_compose_route) {
  char path[PM_MAX_PATH];
  char route_entry_path[PM_MAX_PATH];
  int route_entry_port;

  if (is_compose_route != NULL) {
    *is_compose_route = 0;
  }

  pm_effective_route_table_path(path, sizeof(path));
  if (!source_is_actual) {
    /*
     * Sender polling can hammer several logical ports at once. Try the
     * per-endpoint route file first so unrelated logical ports never race on
     * the shared network aggregate.
     */
    pm_route_entry_path(path, source_port, route_entry_path, sizeof(route_entry_path));
    route_entry_port = pm_route_table_lookup_file(
      route_entry_path,
      source_port,
      source_is_actual,
      required_direction,
      target_host,
      target_host_size,
      is_compose_route);
    if (route_entry_port > 0) {
      return route_entry_port;
    }
  }

  return pm_route_table_lookup_file(
    path,
    source_port,
    source_is_actual,
    required_direction,
    target_host,
    target_host_size,
    is_compose_route);
}

static int pm_connect_route_table_lookup(int logical_port, char *target_host, size_t target_host_size, int *is_compose_route) {
  int actual_port = pm_route_table_lookup(logical_port, 0, "listen", target_host, target_host_size, is_compose_route);

  if (actual_port > 0 || pm_is_compose_logical_port(logical_port)) {
    return actual_port;
  }

  /*
   * Sender-first clients publish a short-lived route before the listener has
   * completed bind/register. Later senders should converge through the same
   * endpoint reservation immediately instead of round-tripping to the daemon.
   */
  return pm_route_table_lookup(logical_port, 0, "send", target_host, target_host_size, is_compose_route);
}

static int pm_wait_for_route(
  int logical_port,
  const char *timeout_env,
  int default_wait_ms,
  const char *reason,
  char *target_host,
  size_t target_host_size,
  int *is_compose_route) {
  int wait_ms = pm_parse_int_env(timeout_env, default_wait_ms);
  int waited_ms = 0;
  int actual_port;

  if (wait_ms <= 0) {
    return 0;
  }
  if (wait_ms > 60000) {
    wait_ms = 60000;
  }

  while (waited_ms < wait_ms) {
    usleep(50000);
    waited_ms += 50;
    actual_port = pm_route_table_lookup(logical_port, 0, "listen", target_host, target_host_size, is_compose_route);
    if (actual_port > 0) {
      pm_debug("connect %s route became ready logical=%d actual=%d wait_ms=%d", reason, logical_port, actual_port, waited_ms);
      return actual_port;
    }
  }

  return 0;
}

static int pm_wait_for_connect_route(
  int logical_port,
  const char *timeout_env,
  int default_wait_ms,
  const char *reason,
  char *target_host,
  size_t target_host_size,
  int *is_compose_route) {
  int wait_ms = pm_parse_int_env(timeout_env, default_wait_ms);
  int waited_ms = 0;
  int actual_port;

  if (wait_ms <= 0) {
    return 0;
  }
  if (wait_ms > 60000) {
    wait_ms = 60000;
  }

  while (waited_ms < wait_ms) {
    usleep(50000);
    waited_ms += 50;
    actual_port = pm_connect_route_table_lookup(logical_port, target_host, target_host_size, is_compose_route);
    if (actual_port > 0) {
      pm_debug("connect %s route became ready logical=%d actual=%d wait_ms=%d", reason, logical_port, actual_port, waited_ms);
      return actual_port;
    }
  }

  return 0;
}

static int pm_wait_for_compose_route(
  int logical_port,
  char *target_host,
  size_t target_host_size,
  int *is_compose_route) {
  return pm_wait_for_route(
    logical_port,
    "PORT_MANAGER_COMPOSE_ROUTE_WAIT_MS",
    PM_COMPOSE_ROUTE_WAIT_MS,
    "compose",
    target_host,
    target_host_size,
    is_compose_route);
}

static int pm_bind_hook(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  struct sockaddr_storage rewritten;
  char host[128];
  char bind_host[128];
  char allocation_id[PM_MAX_TEXT];
  const char *actual_loopback_host;
  const char *loopback_host;
  int logical_port;
  int actual_port;
  int result;

  pm_ensure_symbols();
  if (pm_real_bind == NULL) {
    errno = ENOSYS;
    return -1;
  }

  if (!pm_hook_enabled() || pm_hook_depth > 0 || !pm_is_supported_sockaddr(addr, addrlen)) {
    return pm_real_bind(sockfd, addr, addrlen);
  }

  logical_port = pm_sockaddr_port(addr);
  if (logical_port <= 0) {
    return pm_real_bind(sockfd, addr, addrlen);
  }

  if (pm_loopback_address_only_mode()) {
    loopback_host = pm_network_loopback_host();
    if (loopback_host == NULL || !pm_sockaddr_is_local(addr)) {
      pm_debug("bind address-only unavailable logical=%d", logical_port);
      errno = EADDRNOTAVAIL;
      return -1;
    }

    memcpy(&rewritten, addr, addrlen);
    pm_set_sockaddr_host((struct sockaddr *)&rewritten, loopback_host);
    pm_set_sockaddr_port((struct sockaddr *)&rewritten, logical_port);

    result = pm_real_bind(sockfd, (struct sockaddr *)&rewritten, addrlen);
    if (result == 0) {
      char logical_text[16];

      /*
       * Address-only routing keeps the requested port as the actual endpoint.
       * The route row is still registered so DNS/safe-area clients can discover
       * that this network owns host:port without triggering high-port allocation.
       */
      pm_remember_route(logical_port, logical_port, loopback_host, "", 0);
      snprintf(logical_text, sizeof(logical_text), "%d", logical_port);
      setenv("PORT_MANAGER_LOGICAL_PORT", logical_text, 1);
      setenv("PORT_MANAGER_ACTUAL_PORT", logical_text, 1);
      pm_register_process(logical_port, logical_port, loopback_host, "");
      pm_debug("bind address-only logical=%d host=%s", logical_port, loopback_host);
    }

    return result;
  }

  if (pm_is_fixed_protocol_port(logical_port) && !pm_compose_claim_blocks_port(logical_port)) {
    pm_debug("preserving fixed protocol bind port=%d", logical_port);
    return pm_real_bind(sockfd, addr, addrlen);
  }

  pm_sockaddr_host(addr, host, sizeof(host));
  if (pm_should_preserve_listen_bind(logical_port)) {
    result = pm_real_bind(sockfd, addr, addrlen);
    if (result == 0) {
      char logical_text[16];

      pm_remember_route(logical_port, logical_port, host, "", 0);
      snprintf(logical_text, sizeof(logical_text), "%d", logical_port);
      setenv("PORT_MANAGER_LOGICAL_PORT", logical_text, 1);
      setenv("PORT_MANAGER_ACTUAL_PORT", logical_text, 1);
      pm_register_process(logical_port, logical_port, host, "");
      pm_debug("preserving browser-visible bind logical=%d host=%s", logical_port, host);
    }
    return result;
  }

  loopback_host = pm_network_loopback_host();
  if (loopback_host != NULL) {
    int saved_errno;

    memcpy(&rewritten, addr, addrlen);
    pm_set_sockaddr_host((struct sockaddr *)&rewritten, loopback_host);
    pm_set_sockaddr_port((struct sockaddr *)&rewritten, logical_port);

    result = pm_real_bind(sockfd, (struct sockaddr *)&rewritten, addrlen);
    if (result == 0) {
      char logical_text[16];

      pm_remember_route(logical_port, logical_port, loopback_host, "", 0);
      snprintf(logical_text, sizeof(logical_text), "%d", logical_port);
      setenv("PORT_MANAGER_LOGICAL_PORT", logical_text, 1);
      setenv("PORT_MANAGER_ACTUAL_PORT", logical_text, 1);
      pm_register_process(logical_port, logical_port, loopback_host, "");
      pm_debug("bind loopback-network logical=%d host=%s", logical_port, loopback_host);
      return 0;
    }

    saved_errno = errno;
    if (saved_errno != EADDRNOTAVAIL && saved_errno != EAFNOSUPPORT && saved_errno != EACCES) {
      errno = saved_errno;
      return -1;
    }

    pm_debug("bind loopback-network unavailable logical=%d host=%s error=%s", logical_port, loopback_host, strerror(saved_errno));
    errno = saved_errno;
  }
  allocation_id[0] = '\0';
  actual_loopback_host = pm_actual_loopback_host();
  if (actual_loopback_host == NULL) {
    actual_loopback_host = loopback_host;
  }

  /*
   * Sender-first reservations can be created by clients that resolve localhost
   * to ::1. The listener must reuse only the reserved actual port; its route
   * host must remain the address that bind() was asked to open.
   */
  bind_host[0] = '\0';
  actual_port = pm_route_table_lookup(logical_port, 0, "send", bind_host, sizeof(bind_host), NULL);

  result = -1;
  for (int attempt = 0; attempt < PM_BIND_ALLOCATION_ATTEMPTS; attempt++) {
    int route_table_candidate = actual_port > 0 && attempt == 0;

    if (!route_table_candidate) {
      allocation_id[0] = '\0';
      actual_port = logical_port;

      pm_hook_depth++;
      snprintf(bind_host, sizeof(bind_host), "%s", actual_loopback_host != NULL ? actual_loopback_host : host);
      if (pm_allocate_route(logical_port, bind_host, NULL, "listen", &actual_port, allocation_id, sizeof(allocation_id), NULL, 0) != 0) {
        pm_hook_depth--;
        if (attempt + 1 < PM_BIND_ALLOCATION_ATTEMPTS) {
          usleep(50000);
          continue;
        }
        errno = EAGAIN;
        return -1;
      }
      pm_hook_depth--;
    } else {
      if (bind_host[0] == '\0') {
        snprintf(bind_host, sizeof(bind_host), "%s", actual_loopback_host != NULL ? actual_loopback_host : host);
      }
      pm_debug("bind reusing route table logical=%d actual=%d host=%s", logical_port, actual_port, bind_host);
    }

    memcpy(&rewritten, addr, addrlen);
    pm_set_sockaddr_port((struct sockaddr *)&rewritten, actual_port);
    pm_set_sockaddr_host((struct sockaddr *)&rewritten, bind_host);

    result = pm_real_bind(sockfd, (struct sockaddr *)&rewritten, addrlen);
    if (result == 0) {
      break;
    }

    {
      int saved_errno = errno;
      if (!route_table_candidate) {
        pm_release_allocation(allocation_id);
      }
      allocation_id[0] = '\0';

      if (saved_errno == EADDRINUSE && attempt + 1 < PM_BIND_ALLOCATION_ATTEMPTS) {
        pm_debug("bind collision logical=%d actual=%d retry=%d", logical_port, actual_port, attempt + 1);
        usleep(50000);
        errno = saved_errno;
        continue;
      }

      errno = saved_errno;
      break;
    }
  }

  if (result == 0) {
    char logical_text[16];
    char actual_text[16];

    pm_remember_route(logical_port, actual_port, bind_host, allocation_id, 0);
    snprintf(logical_text, sizeof(logical_text), "%d", logical_port);
    snprintf(actual_text, sizeof(actual_text), "%d", actual_port);
    setenv("PORT_MANAGER_LOGICAL_PORT", logical_text, 1);
    setenv("PORT_MANAGER_ACTUAL_PORT", actual_text, 1);
    pm_register_process(logical_port, actual_port, bind_host, allocation_id);
  } else {
    pm_release_allocation(allocation_id);
  }

  return result;
}

static int pm_connect_hook(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  struct sockaddr_storage rewritten;
  char target_host[128];
  const char *actual_loopback_host;
  const char *loopback_host;
  int route_is_compose;
  int logical_port;
  int actual_port;

  pm_ensure_symbols();
  if (pm_real_connect == NULL) {
    errno = ENOSYS;
    return -1;
  }

  if (pm_should_block_docker_socket(addr, addrlen)) {
    pm_debug("blocked direct Docker socket access from attached network");
    errno = EACCES;
    return -1;
  }

  if (!pm_hook_enabled() || pm_hook_depth > 0 || !pm_is_supported_sockaddr(addr, addrlen) || !pm_sockaddr_is_local(addr)) {
    return pm_real_connect(sockfd, addr, addrlen);
  }

  logical_port = pm_sockaddr_port(addr);
  if (logical_port <= 0) {
    return pm_real_connect(sockfd, addr, addrlen);
  }

  if (pm_loopback_address_only_mode()) {
    loopback_host = pm_network_loopback_host();
    if (loopback_host == NULL) {
      pm_debug("connect address-only unavailable logical=%d", logical_port);
      errno = ECONNREFUSED;
      return -1;
    }

    memcpy(&rewritten, addr, addrlen);
    pm_set_sockaddr_port((struct sockaddr *)&rewritten, logical_port);
    pm_set_sockaddr_host((struct sockaddr *)&rewritten, loopback_host);
    pm_debug("connect address-only logical=%d host=%s", logical_port, loopback_host);
    return pm_real_connect(sockfd, (struct sockaddr *)&rewritten, addrlen);
  }

  target_host[0] = '\0';
  route_is_compose = 0;
  actual_port = pm_memory_actual_for_logical(logical_port, target_host, sizeof(target_host));
  if (actual_port == 0) {
    actual_port = pm_connect_route_table_lookup(logical_port, target_host, sizeof(target_host), &route_is_compose);
  }

  if (actual_port == 0 && pm_is_compose_logical_port(logical_port)) {
    actual_port = pm_wait_for_compose_route(logical_port, target_host, sizeof(target_host), &route_is_compose);
    if (actual_port == 0) {
      pm_debug("connect blocked by missing compose route logical=%d", logical_port);
      errno = ECONNREFUSED;
      return -1;
    }
  }

  if (actual_port == 0 && pm_compose_claim_blocks_port(logical_port)) {
    pm_debug("connect blocked by foreign compose claim logical=%d", logical_port);
    errno = ECONNREFUSED;
    return -1;
  }

  if (actual_port == 0) {
    actual_port = pm_host_access_lookup(logical_port, target_host, sizeof(target_host));
    if (actual_port > 0) {
      memcpy(&rewritten, addr, addrlen);
      pm_set_sockaddr_port((struct sockaddr *)&rewritten, actual_port);
      pm_set_sockaddr_host((struct sockaddr *)&rewritten, target_host);
      pm_debug("connect host-access logical=%d actual=%d host=%s", logical_port, actual_port, target_host);
      return pm_real_connect(sockfd, (struct sockaddr *)&rewritten, addrlen);
    }
  }

  loopback_host = pm_network_loopback_host();
  if (actual_port == 0 && loopback_host != NULL && !pm_is_fixed_protocol_port(logical_port)) {
    int loopback_connect_result;
    int loopback_connect_errno;

    memcpy(&rewritten, addr, addrlen);
    pm_set_sockaddr_port((struct sockaddr *)&rewritten, logical_port);
    pm_set_sockaddr_host((struct sockaddr *)&rewritten, loopback_host);
    pm_debug("connect loopback-network logical=%d host=%s", logical_port, loopback_host);
    loopback_connect_result = pm_real_connect(sockfd, (struct sockaddr *)&rewritten, addrlen);
    if (loopback_connect_result == 0 || errno == EINPROGRESS || errno == EALREADY) {
      return loopback_connect_result;
    }

    loopback_connect_errno = errno;
    if (
      loopback_connect_errno != ECONNREFUSED &&
      loopback_connect_errno != EADDRNOTAVAIL &&
      loopback_connect_errno != EHOSTUNREACH &&
      loopback_connect_errno != ENETUNREACH &&
      loopback_connect_errno != EAFNOSUPPORT
    ) {
      errno = loopback_connect_errno;
      return -1;
    }

    pm_debug(
      "connect loopback-network unavailable logical=%d host=%s error=%s; falling back to routed allocation",
      logical_port,
      loopback_host,
      strerror(loopback_connect_errno));
    errno = loopback_connect_errno;
  }

  if (actual_port == 0 && pm_has_current_network_scope() && !pm_is_fixed_protocol_port(logical_port)) {
    /*
     * DBs and brokers often connect before the extension has flushed the
     * listener row. Wait for the current network route before creating a
     * sender-first reservation, but still allow ordinary dynamic routes to be
     * allocated when no listener appears.
     */
    actual_port = pm_wait_for_connect_route(
      logical_port,
      "PORT_MANAGER_CONNECT_ROUTE_WAIT_MS",
      PM_CONNECT_ROUTE_WAIT_MS,
      "network",
      target_host,
      sizeof(target_host),
      &route_is_compose);
  }

  if (actual_port == 0 && !pm_is_fixed_protocol_port(logical_port)) {
    char allocation_id[PM_MAX_TEXT];

    pm_sockaddr_host(addr, target_host, sizeof(target_host));
    actual_loopback_host = pm_actual_loopback_host();
    if (actual_loopback_host == NULL) {
      actual_loopback_host = pm_network_loopback_host();
    }
    allocation_id[0] = '\0';

    pm_hook_depth++;
    if (pm_allocate_route(
          logical_port,
          target_host,
          actual_loopback_host,
          "send",
          &actual_port,
          allocation_id,
          sizeof(allocation_id),
          target_host,
          sizeof(target_host)) != 0) {
      actual_port = 0;
    }
    pm_hook_depth--;

    if (actual_port > 0) {
      if (target_host[0] == '\0' && actual_loopback_host != NULL) {
        snprintf(target_host, sizeof(target_host), "%s", actual_loopback_host);
      }
      /*
       * connect() may arrive before the server bind(). Keep the daemon's
       * pending route as the shared endpoint reservation and cache it only for
       * that lease window so retry loops do not depend on route-file flush
       * timing but stale reservations still age out.
       */
      pm_remember_route(logical_port, actual_port, target_host, allocation_id, PM_ROUTE_ALLOCATION_TTL_MS);
      pm_debug("connect allocated route logical=%d actual=%d host=%s allocation=%s", logical_port, actual_port, target_host, allocation_id);
    }
  }

  if (actual_port <= 0) {
    return pm_real_connect(sockfd, addr, addrlen);
  }

  if (actual_port == logical_port) {
    char original_host[128];

    pm_sockaddr_host(addr, original_host, sizeof(original_host));
    /*
     * Same-port routes still need host correction. An IPv6 localhost client
     * cannot reach a server that actually bound only 127.0.0.1.
     */
    if (target_host[0] != '\0' && !pm_route_host_is_wildcard_text(target_host) && strcmp(original_host, target_host) != 0) {
      memcpy(&rewritten, addr, addrlen);
      pm_set_sockaddr_host((struct sockaddr *)&rewritten, target_host);
      pm_debug("connect route-host logical=%d actual=%d host=%s", logical_port, actual_port, target_host);
      return pm_real_connect(sockfd, (struct sockaddr *)&rewritten, addrlen);
    }

    /*
     * Same-port compose routes are produced by "attach as-is": the current
     * logical network intentionally reaches Docker's host-published endpoint.
     * Foreign-network compose claims were filtered before this point, so passing
     * through here does not expose another network's clone.
     */
    return pm_real_connect(sockfd, addr, addrlen);
  }

  memcpy(&rewritten, addr, addrlen);
  pm_set_sockaddr_port((struct sockaddr *)&rewritten, actual_port);
  pm_set_sockaddr_host((struct sockaddr *)&rewritten, target_host);
  pm_debug("connect route logical=%d actual=%d host=%s", logical_port, actual_port, target_host);
  return pm_real_connect(sockfd, (struct sockaddr *)&rewritten, addrlen);
}

static int pm_getsockname_hook(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  int result;
  int actual_port;
  int logical_port;

  pm_ensure_symbols();
  if (pm_real_getsockname == NULL) {
    errno = ENOSYS;
    return -1;
  }

  result = pm_real_getsockname(sockfd, addr, addrlen);
  if (result != 0 || !pm_hook_enabled() || pm_hook_depth > 0 || addr == NULL || addrlen == NULL) {
    return result;
  }

  if (!pm_is_supported_sockaddr(addr, *addrlen)) {
    return result;
  }

  actual_port = pm_sockaddr_port(addr);
  logical_port = pm_memory_logical_for_actual(actual_port);
  if (logical_port == 0) {
    logical_port = pm_route_table_lookup(actual_port, 1, "listen", NULL, 0, NULL);
  }

  if (logical_port > 0 && logical_port != actual_port) {
    pm_set_sockaddr_port(addr, logical_port);
  }

  return result;
}

static int pm_exec_with_prepared_child(
  const char *path,
  char *const argv[],
  char *const envp[],
  int allow_path_lookup) {
  const char *target;
  const char *exec_target;
  char **exec_envp;
  char resolved_target[PM_MAX_PATH];
  pm_child_environment child_environment;
  pm_child_exec_plan exec_plan;
  int result;
  int saved_errno;

  pm_ensure_symbols();
  if (pm_real_execve == NULL) {
    errno = ENOSYS;
    return -1;
  }

  target = pm_runtime_exec_target(path, argv);
  if (target != path) {
    pm_debug("runtime exec rewrite path=%s target=%s", path != NULL ? path : "(null)", target);
    allow_path_lookup = 0;
  }

  child_environment = pm_prepare_child_environment(envp);
  exec_plan = pm_prepare_child_exec_plan(target, argv, child_environment.envp, allow_path_lookup);
  exec_target = exec_plan.target;
  exec_envp = exec_plan.envp != NULL ? exec_plan.envp : child_environment.envp;

  /*
   * execvp searches PATH before execve. When no shebang rewrite is needed we
   * still call execve so the repaired child environment is used.
   */
  if (exec_plan.target == target && allow_path_lookup && target != NULL && strchr(target, '/') == NULL) {
    if (pm_resolve_exec_path(target, exec_envp, 1, resolved_target, sizeof(resolved_target)) == 0) {
      exec_target = resolved_target;
    }
  }

  result = pm_real_execve(exec_target, exec_plan.argv, exec_envp);
  saved_errno = errno;
  pm_release_child_exec_plan(&exec_plan);
  pm_release_child_environment(&child_environment);
  errno = saved_errno;
  return result;
}

static int pm_execve_hook(const char *path, char *const argv[], char *const envp[]) {
  return pm_exec_with_prepared_child(path, argv, envp, 0);
}

static int pm_execv_hook(const char *path, char *const argv[]) {
  return pm_exec_with_prepared_child(path, argv, environ, 0);
}

static int pm_execvp_hook(const char *file, char *const argv[]) {
  return pm_exec_with_prepared_child(file, argv, environ, 1);
}

static int pm_posix_spawn_hook(
  pid_t *pid,
  const char *path,
  const posix_spawn_file_actions_t *file_actions,
  const posix_spawnattr_t *attrp,
  char *const argv[],
  char *const envp[]) {
  const char *target;
  pm_child_environment child_environment;
  pm_child_exec_plan exec_plan;
  int result;

  pm_ensure_symbols();
  if (pm_real_posix_spawn == NULL) {
    errno = ENOSYS;
    return ENOSYS;
  }

  target = pm_runtime_exec_target(path, argv);
  if (target != path) {
    pm_debug("runtime posix_spawn rewrite path=%s target=%s", path != NULL ? path : "(null)", target);
  }

  child_environment = pm_prepare_child_environment(envp);
  exec_plan = pm_prepare_child_exec_plan(target, argv, child_environment.envp, 0);
  result = pm_real_posix_spawn(
    pid,
    exec_plan.target,
    file_actions,
    attrp,
    exec_plan.argv,
    exec_plan.envp != NULL ? exec_plan.envp : child_environment.envp);
  pm_release_child_exec_plan(&exec_plan);
  pm_release_child_environment(&child_environment);
  return result;
}

static int pm_posix_spawnp_hook(
  pid_t *pid,
  const char *file,
  const posix_spawn_file_actions_t *file_actions,
  const posix_spawnattr_t *attrp,
  char *const argv[],
  char *const envp[]) {
  const char *target;
  pm_child_environment child_environment;
  pm_child_exec_plan exec_plan;
  int result;

  pm_ensure_symbols();
  if (pm_real_posix_spawnp == NULL) {
    errno = ENOSYS;
    return ENOSYS;
  }

  target = pm_runtime_exec_target(file, argv);
  if (target != file) {
    pm_debug("runtime posix_spawnp rewrite file=%s target=%s", file != NULL ? file : "(null)", target);
    child_environment = pm_prepare_child_environment(envp);
    exec_plan = pm_prepare_child_exec_plan(target, argv, child_environment.envp, 0);
    result = pm_real_posix_spawn(
      pid,
      exec_plan.target,
      file_actions,
      attrp,
      exec_plan.argv,
      exec_plan.envp != NULL ? exec_plan.envp : child_environment.envp);
    pm_release_child_exec_plan(&exec_plan);
    pm_release_child_environment(&child_environment);
    return result;
  }

  child_environment = pm_prepare_child_environment(envp);
  exec_plan = pm_prepare_child_exec_plan(file, argv, child_environment.envp, 1);
  if (exec_plan.target != file) {
    result = pm_real_posix_spawn(
      pid,
      exec_plan.target,
      file_actions,
      attrp,
      exec_plan.argv,
      exec_plan.envp != NULL ? exec_plan.envp : child_environment.envp);
  } else {
    result = pm_real_posix_spawnp(pid, file, file_actions, attrp, argv, child_environment.envp);
  }
  pm_release_child_exec_plan(&exec_plan);
  pm_release_child_environment(&child_environment);
  return result;
}

#if defined(__APPLE__)
#define PM_DYLD_INTERPOSE(_replacement, _replacee) \
  __attribute__((used)) static struct { const void *replacement; const void *replacee; } \
  _pm_interpose_##_replacee __attribute__((section("__DATA,__interpose"))) = { \
    (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee \
  }

PM_DYLD_INTERPOSE(pm_bind_hook, bind);
PM_DYLD_INTERPOSE(pm_connect_hook, connect);
PM_DYLD_INTERPOSE(pm_getsockname_hook, getsockname);
PM_DYLD_INTERPOSE(pm_execve_hook, execve);
PM_DYLD_INTERPOSE(pm_execv_hook, execv);
PM_DYLD_INTERPOSE(pm_execvp_hook, execvp);
PM_DYLD_INTERPOSE(pm_posix_spawn_hook, posix_spawn);
PM_DYLD_INTERPOSE(pm_posix_spawnp_hook, posix_spawnp);
#else
int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return pm_bind_hook(sockfd, addr, addrlen);
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return pm_connect_hook(sockfd, addr, addrlen);
}

int getsockname(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  return pm_getsockname_hook(sockfd, addr, addrlen);
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  return pm_execve_hook(path, argv, envp);
}

int execv(const char *path, char *const argv[]) {
  return pm_execv_hook(path, argv);
}

int execvp(const char *file, char *const argv[]) {
  return pm_execvp_hook(file, argv);
}

int posix_spawn(
  pid_t *pid,
  const char *path,
  const posix_spawn_file_actions_t *file_actions,
  const posix_spawnattr_t *attrp,
  char *const argv[],
  char *const envp[]) {
  return pm_posix_spawn_hook(pid, path, file_actions, attrp, argv, envp);
}

int posix_spawnp(
  pid_t *pid,
  const char *file,
  const posix_spawn_file_actions_t *file_actions,
  const posix_spawnattr_t *attrp,
  char *const argv[],
  char *const envp[]) {
  return pm_posix_spawnp_hook(pid, file, file_actions, attrp, argv, envp);
}
#endif

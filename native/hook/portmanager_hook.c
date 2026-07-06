#define _GNU_SOURCE

#include <arpa/inet.h>
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
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
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include <sys/utsname.h>

#include "../shared/pm_dev_log.h"

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
#define PM_DEFAULT_FIXED_PROTOCOL_PORTS "22,25,53,80,110,143,389,443,465,587,993,995,1433,1521,15432,1883,3306,33060,4222,5432,5671,5672,6379,8883,9092,9200,9300,11211,15672,27017,50051"
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
typedef int (*pm_getifaddrs_fn)(struct ifaddrs **);
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
typedef pid_t (*pm_wait4_fn)(pid_t, int *, int, struct rusage *);
typedef pid_t (*pm_waitpid_fn)(pid_t, int *, int);
typedef pid_t (*pm_wait3_fn)(int *, int, struct rusage *);
typedef int (*pm_kill_fn)(pid_t, int);

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
static pm_getifaddrs_fn pm_real_getifaddrs = getifaddrs;
static pm_execve_fn pm_real_execve = execve;
static pm_execv_fn pm_real_execv = execv;
static pm_execvp_fn pm_real_execvp = execvp;
static pm_posix_spawn_fn pm_real_posix_spawn = posix_spawn;
static pm_posix_spawnp_fn pm_real_posix_spawnp = posix_spawnp;
static pm_wait4_fn pm_real_wait4 = wait4;
static pm_waitpid_fn pm_real_waitpid = waitpid;
static pm_wait3_fn pm_real_wait3 = wait3;
static pm_kill_fn pm_real_kill = kill;
#else
static pm_bind_fn pm_real_bind = NULL;
static pm_connect_fn pm_real_connect = NULL;
static pm_getsockname_fn pm_real_getsockname = NULL;
static pm_getifaddrs_fn pm_real_getifaddrs = NULL;
static pm_execve_fn pm_real_execve = NULL;
static pm_execv_fn pm_real_execv = NULL;
static pm_execvp_fn pm_real_execvp = NULL;
static pm_posix_spawn_fn pm_real_posix_spawn = NULL;
static pm_posix_spawnp_fn pm_real_posix_spawnp = NULL;
static pm_wait4_fn pm_real_wait4 = NULL;
static pm_waitpid_fn pm_real_waitpid = NULL;
static pm_wait3_fn pm_real_wait3 = NULL;
static pm_kill_fn pm_real_kill = NULL;
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
  int to_stderr = pm_debug_enabled();
  /*
   * PORT_MANAGER_HOOK_DEBUG=1 keeps the legacy stderr trace; PORT_MANAGER_DEV_LOG
   * additionally tees every hook debug line into the shared dev-log file so hook
   * activity lands on the same timeline as the router/agent (see docs/dev-logging.md).
   */
  int to_devlog = pm_dev_log_enabled();
  char message[1024];
  va_list args;

  if (!to_stderr && !to_devlog) {
    return;
  }

  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);

  if (to_stderr) {
    fprintf(stderr, "[portmanager-hook pid=%ld] %s\n", (long)getpid(), message);
  }
  if (to_devlog) {
    pm_dev_log("hook", "%s", message);
  }
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

  if (pm_real_getifaddrs == NULL) {
    pm_real_getifaddrs = (pm_getifaddrs_fn)pm_resolve_symbol("getifaddrs");
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

  if (pm_real_wait4 == NULL) {
    pm_real_wait4 = (pm_wait4_fn)pm_resolve_symbol("wait4");
  }

  if (pm_real_waitpid == NULL) {
    pm_real_waitpid = (pm_waitpid_fn)pm_resolve_symbol("waitpid");
  }

  if (pm_real_wait3 == NULL) {
    pm_real_wait3 = (pm_wait3_fn)pm_resolve_symbol("wait3");
  }

  if (pm_real_kill == NULL) {
    pm_real_kill = (pm_kill_fn)pm_resolve_symbol("kill");
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

static void pm_route_gateway_claim_path(const char *route_table_path, int port, char *buffer, size_t size) {
  const char *file_name;
  const char *extension;

  file_name = strrchr(route_table_path, '/');
  file_name = file_name == NULL ? route_table_path : file_name + 1;
  extension = strrchr(file_name, '.');

  if (extension != NULL) {
    size_t prefix_length = (size_t)(extension - route_table_path);
    snprintf(buffer, size, "%.*s-mux-claim-port-%d%s", (int)prefix_length, route_table_path, port, extension);
    return;
  }

  snprintf(buffer, size, "%s-mux-claim-port-%d.json", route_table_path, port);
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

static int pm_bind_ephemeral_local_port(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  struct sockaddr_storage actual_addr;
  struct sockaddr_storage rewritten;
  const char *loopback_host;
  socklen_t actual_addrlen;
  int actual_port;
  int result;

  if (!pm_sockaddr_is_local(addr)) {
    if (pm_loopback_address_only_mode()) {
      errno = EADDRNOTAVAIL;
      return -1;
    }
    return pm_real_bind(sockfd, addr, addrlen);
  }

  loopback_host = pm_network_loopback_host();
  if (loopback_host == NULL) {
    loopback_host = pm_actual_loopback_host();
  }
  if (loopback_host == NULL) {
    if (pm_loopback_address_only_mode()) {
      errno = EADDRNOTAVAIL;
      return -1;
    }
    return pm_real_bind(sockfd, addr, addrlen);
  }

  /*
   * bind(..., port 0) is still a network-owned listener. Any framework that
   * uses an ephemeral loopback coordination port must stay inside the attached
   * logical network instead of escaping to host 127.0.0.1.
   */
  memcpy(&rewritten, addr, addrlen);
  pm_set_sockaddr_host((struct sockaddr *)&rewritten, loopback_host);
  pm_debug("bind ephemeral loopback host=%s", loopback_host);
  result = pm_real_bind(sockfd, (struct sockaddr *)&rewritten, addrlen);
  if (result != 0 || pm_real_getsockname == NULL) {
    return result;
  }

  actual_addrlen = sizeof(actual_addr);
  if (pm_real_getsockname(sockfd, (struct sockaddr *)&actual_addr, &actual_addrlen) == 0) {
    actual_port = pm_sockaddr_port((struct sockaddr *)&actual_addr);
    if (actual_port > 0) {
      char actual_text[16];

      /*
       * Hookless host clients attached by PID still dial localhost. Publishing
       * the kernel's ephemeral port lets the compatibility router expose
       * 127.0.0.1:port while the real listener stays on the network loopback.
       */
      pm_remember_route(actual_port, actual_port, loopback_host, "", 0);
      snprintf(actual_text, sizeof(actual_text), "%d", actual_port);
      setenv("PORT_MANAGER_LOGICAL_PORT", actual_text, 1);
      setenv("PORT_MANAGER_ACTUAL_PORT", actual_text, 1);
      pm_register_process(actual_port, actual_port, loopback_host, "");
    }
  }

  return result;
}

/*
 * True when the logical port gateway currently owns this port on localhost.
 *
 * The extension writes a small claim file per gateway-owned port and refreshes
 * it faster than the route-table TTL. A scope-less bind consults this so a
 * non-attached terminal's server relocates to a high port (becoming the
 * non-network passthrough target) instead of being shadowed by the gateway's
 * localhost listener. Absence or staleness means the port is free to bind.
 */
static int pm_gateway_claim_fresh(int logical_port) {
  char base_path[PM_MAX_PATH];
  char claim_path[PM_MAX_PATH];
  struct stat stat_buffer;
  FILE *file;
  char buffer[256];
  size_t read_length;

  pm_default_global_route_table_path(base_path, sizeof(base_path));
  pm_route_gateway_claim_path(base_path, logical_port, claim_path, sizeof(claim_path));

  if (stat(claim_path, &stat_buffer) != 0 || pm_route_file_stat_expired(&stat_buffer)) {
    return 0;
  }

  file = fopen(claim_path, "r");
  if (file == NULL) {
    return 0;
  }
  read_length = fread(buffer, 1, sizeof(buffer) - 1, file);
  fclose(file);
  buffer[read_length] = '\0';

  return pm_route_file_buffer_expired(buffer) ? 0 : 1;
}

/*
 * Relocates a scope-less server off a gateway-owned port.
 *
 * The bind is moved to a daemon-allocated high port on 127.0.0.1 and registered
 * as a network-less listen route, which is exactly the coordinate the gateway
 * forwards a non-network client to. Returns 0 on success (and completes the
 * bind), or -1 to let the caller fall back to a normal passthrough bind (e.g.
 * the daemon is unavailable or the socket cannot bind the loopback address).
 */
static int pm_bind_gateway_relocation(int sockfd, const struct sockaddr *addr, socklen_t addrlen, int logical_port) {
  struct sockaddr_storage rewritten;
  char allocation_id[PM_MAX_TEXT];
  const char *relocate_host = "127.0.0.1";
  int actual_port = logical_port;
  int result;

  allocation_id[0] = '\0';
  pm_hook_depth++;
  if (pm_allocate_route(logical_port, relocate_host, NULL, "listen", &actual_port, allocation_id, sizeof(allocation_id), NULL, 0) != 0) {
    pm_hook_depth--;
    return -1;
  }
  pm_hook_depth--;

  memcpy(&rewritten, addr, addrlen);
  pm_set_sockaddr_host((struct sockaddr *)&rewritten, relocate_host);
  pm_set_sockaddr_port((struct sockaddr *)&rewritten, actual_port);

  result = pm_real_bind(sockfd, (struct sockaddr *)&rewritten, addrlen);
  if (result != 0) {
    pm_release_allocation(allocation_id);
    return -1;
  }

  {
    char logical_text[16];
    char actual_text[16];

    pm_remember_route(logical_port, actual_port, relocate_host, allocation_id, 0);
    snprintf(logical_text, sizeof(logical_text), "%d", logical_port);
    snprintf(actual_text, sizeof(actual_text), "%d", actual_port);
    setenv("PORT_MANAGER_LOGICAL_PORT", logical_text, 1);
    setenv("PORT_MANAGER_ACTUAL_PORT", actual_text, 1);
    pm_register_process(logical_port, actual_port, relocate_host, allocation_id);
    pm_debug("bind gateway relocation logical=%d actual=%d", logical_port, actual_port);
  }

  return 0;
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
  if (!pm_has_current_network_scope()) {
    /*
     * A globally injected preload can survive after a terminal is detached from
     * every logical network. In that state localhost belongs to the real host,
     * so the hook does not rewrite loopback binds. The one exception is a port
     * the gateway currently owns: a server there must relocate so non-network
     * clients can still reach it through the gateway's passthrough.
     */
    if (
      logical_port > 0 &&
      !pm_is_fixed_protocol_port(logical_port) &&
      pm_sockaddr_is_local(addr) &&
      pm_gateway_claim_fresh(logical_port) &&
      pm_bind_gateway_relocation(sockfd, addr, addrlen, logical_port) == 0
    ) {
      return 0;
    }

    pm_debug("bind passthrough without network scope logical=%d", logical_port);
    return pm_real_bind(sockfd, addr, addrlen);
  }

  if (logical_port == 0) {
    return pm_bind_ephemeral_local_port(sockfd, addr, addrlen);
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
  int loopback_fallback_errno;

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

  if (!pm_has_current_network_scope()) {
    /*
     * Without a network identity, localhost:<port> is the host's own endpoint.
     * Looking up route tables here can bounce back into host proxies or router
     * listeners and create the localhost -> route -> localhost loop.
     */
    pm_debug("connect passthrough without network scope logical=%d", logical_port);
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
  loopback_fallback_errno = 0;
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
  if (actual_port == 0 && loopback_host != NULL) {
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

    loopback_fallback_errno = loopback_connect_errno;
    pm_debug(
      "connect loopback-network unavailable logical=%d host=%s error=%s; falling back to route resolution",
      logical_port,
      loopback_host,
      strerror(loopback_connect_errno));
    errno = loopback_connect_errno;
  }

  if (actual_port == 0 && pm_has_current_network_scope()) {
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

  if (actual_port == 0 && pm_is_fixed_protocol_port(logical_port)) {
    /*
     * Fixed service ports such as RabbitMQ, Postgres, and Redis are commonly
     * shared on host localhost. Inside a logical network, an unresolved route
     * must fail instead of falling through to another network's host service.
     */
    pm_debug("connect blocked fixed protocol host fallback logical=%d", logical_port);
    errno = loopback_fallback_errno != 0 ? loopback_fallback_errno : ECONNREFUSED;
    return -1;
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

/* ---- Control channel (daemon -> hook push) --------------------------------
 * Foundation of the escaped-server respawn path. A version-manager or shell
 * shim (yarn's `#!/bin/sh` node shim, asdf, `/usr/bin/env`) strips the preload
 * before the runtime binds, so a dev server can end up unhooked. The daemon,
 * which alone sees the final resolved process, pushes a RESPAWN command to the
 * server's PARENT; because this hook runs inside that parent, the relaunched
 * child becomes a true child of it (tree, stdio, job control preserved).
 *
 * Only a scoped process that actually spawns children opens the channel, so
 * leaf commands in an attached terminal never connect. Stage 1 observes the
 * pushed command; RESPAWN execution and syscall virtualization follow.
 */
#define PM_CONTROL_RECONNECT_BACKOFF_US 1000000
/* A RESPAWN line carries the escaped child's full argv+env (base64), which for
 * a deep monorepo shell/yarn chain is tens of KB. Sized generously and heap-
 * allocated so the control thread's stack is not blown. */
#define PM_CONTROL_LINE_SIZE 262144

static volatile sig_atomic_t pm_control_should_run = 0;
static volatile sig_atomic_t pm_control_started = 0;
static pthread_mutex_t pm_control_start_mutex = PTHREAD_MUTEX_INITIALIZER;

/*
 * Escaped-child -> replacement PID mapping. When this parent respawns an
 * unhooked child, later stages virtualize wait4/kill/kqueue against this map so
 * the parent's own process management transparently follows the replacement.
 */
#define PM_RESPAWN_MAP_MAX 256
#define PM_RESPAWN_GRAVEYARD_MAX 256
typedef struct {
  pid_t old_pid;
  pid_t new_pid;
} pm_respawn_pair;
static pm_respawn_pair pm_respawn_pairs[PM_RESPAWN_MAP_MAX];
static size_t pm_respawn_pair_count = 0;
/*
 * Killed originals whose death must never be reported to the parent's own
 * wait(). A pid stays here after its pair is retired so a late zombie surfacing
 * in a wildcard wait is still consumed instead of double-reported. Ring buffer:
 * old pids are short-lived and the count of concurrent respawns is tiny.
 */
static pid_t pm_respawn_graveyard[PM_RESPAWN_GRAVEYARD_MAX];
static size_t pm_respawn_graveyard_head = 0;
static int pm_respawn_active = 0; /* fast-path flag: any mapping/graveyard entry? */
static pthread_mutex_t pm_respawn_map_mutex = PTHREAD_MUTEX_INITIALIZER;

static void pm_respawn_graveyard_add_locked(pid_t old_pid) {
  pm_respawn_graveyard[pm_respawn_graveyard_head] = old_pid;
  pm_respawn_graveyard_head = (pm_respawn_graveyard_head + 1) % PM_RESPAWN_GRAVEYARD_MAX;
  pm_respawn_active = 1;
}

static int pm_respawn_in_graveyard_locked(pid_t pid) {
  for (size_t index = 0; index < PM_RESPAWN_GRAVEYARD_MAX; index++) {
    if (pm_respawn_graveyard[index] == pid) {
      return 1;
    }
  }
  return 0;
}

static void pm_respawn_map_record(pid_t old_pid, pid_t new_pid) {
  pthread_mutex_lock(&pm_respawn_map_mutex);
  if (pm_respawn_pair_count < PM_RESPAWN_MAP_MAX) {
    pm_respawn_pairs[pm_respawn_pair_count].old_pid = old_pid;
    pm_respawn_pairs[pm_respawn_pair_count].new_pid = new_pid;
    pm_respawn_pair_count++;
    pm_respawn_active = 1;
  }
  pthread_mutex_unlock(&pm_respawn_map_mutex);
}

/* Replacement pid for a mapped original, or -1. */
static pid_t pm_respawn_new_for_old(pid_t old_pid) {
  pid_t result = -1;
  pthread_mutex_lock(&pm_respawn_map_mutex);
  for (size_t index = 0; index < pm_respawn_pair_count; index++) {
    if (pm_respawn_pairs[index].old_pid == old_pid) {
      result = pm_respawn_pairs[index].new_pid;
      break;
    }
  }
  pthread_mutex_unlock(&pm_respawn_map_mutex);
  return result;
}

/*
 * If new_pid is a replacement, retire the pair (moving the original to the
 * graveyard so its own zombie is never reported) and return the original pid;
 * otherwise return -1.
 */
static pid_t pm_respawn_retire_by_new(pid_t new_pid) {
  pid_t old_pid = -1;
  pthread_mutex_lock(&pm_respawn_map_mutex);
  for (size_t index = 0; index < pm_respawn_pair_count; index++) {
    if (pm_respawn_pairs[index].new_pid == new_pid) {
      old_pid = pm_respawn_pairs[index].old_pid;
      pm_respawn_graveyard_add_locked(old_pid);
      pm_respawn_pairs[index] = pm_respawn_pairs[pm_respawn_pair_count - 1];
      pm_respawn_pair_count--;
      break;
    }
  }
  pthread_mutex_unlock(&pm_respawn_map_mutex);
  return old_pid;
}

/* True if pid is a mapped original (its death should be suppressed). */
static int pm_respawn_is_suppressed_old(pid_t pid) {
  int result = 0;
  pthread_mutex_lock(&pm_respawn_map_mutex);
  if (pm_respawn_in_graveyard_locked(pid)) {
    result = 1;
  } else {
    for (size_t index = 0; index < pm_respawn_pair_count; index++) {
      if (pm_respawn_pairs[index].old_pid == pid) {
        /* First sighting of the killed original: retire it to the graveyard. */
        pm_respawn_graveyard_add_locked(pid);
        result = 1;
        break;
      }
    }
  }
  pthread_mutex_unlock(&pm_respawn_map_mutex);
  return result;
}

/* Standard-alphabet base64 decode; returns 0 on success and NUL-terminates. */
static int pm_base64_decode(const char *input, char *output, size_t output_capacity, size_t *output_length) {
  static const char alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  signed char table[256];
  size_t out = 0;
  int bits = 0;
  int accumulator = 0;

  memset(table, -1, sizeof(table));
  for (int index = 0; index < 64; index++) {
    table[(unsigned char)alphabet[index]] = (signed char)index;
  }

  for (const char *cursor = input; *cursor != '\0'; cursor++) {
    signed char value = table[(unsigned char)*cursor];
    if (value < 0) {
      continue; /* skip '=', whitespace, and any stray delimiter */
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (out + 1 >= output_capacity) {
        return -1;
      }
      output[out++] = (char)((accumulator >> bits) & 0xff);
    }
  }

  if (out >= output_capacity) {
    return -1;
  }
  output[out] = '\0';
  if (output_length != NULL) {
    *output_length = out;
  }
  return 0;
}

/*
 * Relaunches an escaped child as a true child of this parent process.
 *
 * Wire format (all payload fields base64 so argv/env may hold any bytes):
 *   RESPAWN \t oldpid \t cwd \t argc \t arg0 \t .. \t argN \t envc \t env0 \t ..
 *
 * The child is spawned via the REAL posix_spawn on the resolved interpreter
 * (argv[0], captured by the daemon after the version-manager/shell shim already
 * resolved it), bypassing the shim entirely so DYLD_INSERT_LIBRARIES survives
 * and the hook loads. It inherits this parent's fds/pgroup/session, so terminal
 * output and job control are preserved.
 */
/*
 * Reads a target pid's Port Manager network id from its environment via
 * KERN_PROCARGS2, using the SAME variable precedence as the detector's
 * process-lookup helper (so the value equals the RESPAWN target for the genuine
 * escaped child). Lets a respawn refuse to signal any pid that is not in the
 * intended network — the guarantee that a respawn's kill can never cross a
 * network boundary, even under pid reuse. Returns 0 with buf filled, else -1.
 */
static int pm_read_process_network_id(pid_t pid, char *buf, size_t size) {
  static const char *const variables[] = {
    "PORT_MANAGER_NETWORK_ID",
    "PORT_MANAGER_ROUTE_TABLE_NETWORK_ID",
    "PORT_MANAGER_BORROWED_NETWORK_ID",
    "NEWDLOPS_PM_NETWORK_ID",
    "NEWDLOPS_PM_BORROWED_NETWORK_ID",
  };
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, (int)pid};
  size_t buffer_size = 0;
  char *buffer;

  if (buf == NULL || size == 0) {
    return -1;
  }
  buf[0] = '\0';

  if (sysctl(mib, 3, NULL, &buffer_size, NULL, 0) != 0 || buffer_size == 0) {
    return -1;
  }
  buffer = (char *)malloc(buffer_size);
  if (buffer == NULL) {
    return -1;
  }
  if (sysctl(mib, 3, buffer, &buffer_size, NULL, 0) != 0) {
    free(buffer);
    return -1;
  }

  for (size_t variable_index = 0; variable_index < sizeof(variables) / sizeof(variables[0]); variable_index++) {
    const char *name = variables[variable_index];
    size_t name_length = strlen(name);
    size_t offset = 0;

    while (offset < buffer_size) {
      const char *entry = buffer + offset;
      size_t remaining = buffer_size - offset;
      size_t entry_length = strnlen(entry, remaining);

      if (entry_length > name_length && entry[name_length] == '=' && strncmp(entry, name, name_length) == 0) {
        snprintf(buf, size, "%s", entry + name_length + 1);
        free(buffer);
        return buf[0] == '\0' ? -1 : 0;
      }
      offset += entry_length + 1;
    }
  }

  free(buffer);
  return -1;
}

static void pm_control_handle_respawn(const char *fields) {
  char *copy = strdup(fields);
  char *saveptr = NULL;
  char **argv = NULL;
  char **envp = NULL;
  char *decoded = NULL;
  posix_spawn_file_actions_t file_actions;
  int have_file_actions = 0;
  char cwd[PM_MAX_PATH];
  char target_network_id[128];
  const char *token;
  long old_pid_long;
  long argc_long;
  long envc_long;
  int argc;
  int envc;
  int dyld_index = -1;
  const char *dyld_value;
  pid_t new_pid = -1;
  int spawn_result = -1;
  size_t decoded_capacity = 1 << 16;

  if (copy == NULL) {
    return;
  }
  decoded = (char *)malloc(decoded_capacity);
  if (decoded == NULL) {
    free(copy);
    return;
  }

  /* oldpid */
  token = strtok_r(copy, "\t", &saveptr);
  if (token == NULL) {
    goto cleanup;
  }
  old_pid_long = strtol(token, NULL, 10);

  /* target network id (base64): confine this respawn to one network. The
   * executing hook must itself be in that network, else refuse entirely so a
   * shared or cross-network ancestor is never armed (its kill/wait
   * virtualization would otherwise leak signals across network boundaries). */
  token = strtok_r(NULL, "\t", &saveptr);
  if (token == NULL || pm_base64_decode(token, target_network_id, sizeof(target_network_id), NULL) != 0) {
    goto cleanup;
  }
  {
    const char *own_network_id = pm_current_network_id();
    if (own_network_id == NULL || own_network_id[0] == '\0' ||
        strcmp(own_network_id, target_network_id) != 0) {
      pm_debug("respawn REFUSED own_net=%s target_net=%s (scope mismatch)",
               own_network_id != NULL ? own_network_id : "(none)", target_network_id);
      goto cleanup;
    }
  }

  /* cwd (base64) */
  token = strtok_r(NULL, "\t", &saveptr);
  if (token == NULL || pm_base64_decode(token, cwd, sizeof(cwd), NULL) != 0) {
    goto cleanup;
  }

  /* argc */
  token = strtok_r(NULL, "\t", &saveptr);
  if (token == NULL) {
    goto cleanup;
  }
  argc_long = strtol(token, NULL, 10);
  if (argc_long <= 0 || argc_long > 4096) {
    goto cleanup;
  }
  argc = (int)argc_long;
  argv = (char **)calloc((size_t)argc + 1, sizeof(char *));
  if (argv == NULL) {
    goto cleanup;
  }
  for (int index = 0; index < argc; index++) {
    size_t decoded_length = 0;
    token = strtok_r(NULL, "\t", &saveptr);
    if (token == NULL || pm_base64_decode(token, decoded, decoded_capacity, &decoded_length) != 0) {
      goto cleanup;
    }
    argv[index] = (char *)malloc(decoded_length + 1);
    if (argv[index] == NULL) {
      goto cleanup;
    }
    memcpy(argv[index], decoded, decoded_length + 1);
  }

  /* envc */
  token = strtok_r(NULL, "\t", &saveptr);
  if (token == NULL) {
    goto cleanup;
  }
  envc_long = strtol(token, NULL, 10);
  if (envc_long < 0 || envc_long > 65536) {
    goto cleanup;
  }
  envc = (int)envc_long;
  /* +2: room to append DYLD_INSERT_LIBRARIES if the child env lacked it. */
  envp = (char **)calloc((size_t)envc + 2, sizeof(char *));
  if (envp == NULL) {
    goto cleanup;
  }
  dyld_value = getenv("PORT_MANAGER_DYLD_INSERT_LIBRARIES");
  for (int index = 0; index < envc; index++) {
    size_t decoded_length = 0;
    token = strtok_r(NULL, "\t", &saveptr);
    if (token == NULL || pm_base64_decode(token, decoded, decoded_capacity, &decoded_length) != 0) {
      goto cleanup;
    }
    envp[index] = (char *)malloc(decoded_length + 1);
    if (envp[index] == NULL) {
      goto cleanup;
    }
    memcpy(envp[index], decoded, decoded_length + 1);
    if (strncmp(envp[index], "DYLD_INSERT_LIBRARIES=", 22) == 0) {
      dyld_index = index;
    }
  }

  /*
   * Ensure the interpreter receives DYLD_INSERT_LIBRARIES. The escaped child's
   * env usually still carries it (it survives as a string; only the injection
   * was stripped by the shim), but restore it from the always-surviving
   * PORT_MANAGER_DYLD_INSERT_LIBRARIES when absent so the spawn is hooked.
   */
  if (dyld_index < 0 && dyld_value != NULL && dyld_value[0] != '\0') {
    size_t entry_length = strlen("DYLD_INSERT_LIBRARIES=") + strlen(dyld_value);
    char *entry = (char *)malloc(entry_length + 1);
    if (entry != NULL) {
      snprintf(entry, entry_length + 1, "DYLD_INSERT_LIBRARIES=%s", dyld_value);
      envp[envc] = entry;
      envc++;
    }
  }

  if (posix_spawn_file_actions_init(&file_actions) == 0) {
    have_file_actions = 1;
    if (cwd[0] != '\0') {
      /* _np spelling is kept for macOS < 26 portability (the POSIX-2024
       * non-_np name only exists on macOS 26+); silence the 26 deprecation. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      posix_spawn_file_actions_addchdir_np(&file_actions, cwd);
#pragma clang diagnostic pop
    }
  }

  pm_hook_depth++;
  spawn_result = pm_real_posix_spawn(
    &new_pid,
    argv[0],
    have_file_actions ? &file_actions : NULL,
    NULL,
    argv,
    envp);
  pm_hook_depth--;
  if (spawn_result == 0 && new_pid > 0) {
    pm_respawn_map_record((pid_t)old_pid_long, new_pid);
    pm_debug("respawned old=%ld new=%d argv0=%s", old_pid_long, (int)new_pid, argv[0]);
    /*
     * Free the escaped child's coordinates so the replacement (hooked, on the
     * network alias) owns them. The wait/kill virtualization makes this parent's
     * own process management see the replacement in place of the killed original.
     */
    if (old_pid_long > 0) {
      /* Cross-network kill guard: signal the victim only if it is genuinely in
       * the target network right now. A recycled pid, or any process outside
       * this network, fails the check — so a respawn's SIGTERM can never cross
       * a network boundary. */
      char victim_network_id[128];
      victim_network_id[0] = '\0';
      if (pm_read_process_network_id((pid_t)old_pid_long, victim_network_id, sizeof(victim_network_id)) == 0 &&
          strcmp(victim_network_id, target_network_id) == 0) {
        kill((pid_t)old_pid_long, SIGTERM);
      } else {
        pm_debug("respawn kill SKIPPED old=%ld victim_net=%s target_net=%s (cross-network guard)",
                 old_pid_long, victim_network_id, target_network_id);
      }
    }
  } else {
    /* posix_spawn returns the error code directly (does not set errno). */
    pm_debug("respawn failed old=%ld argv0=%s posix_spawn=%d (%s)", old_pid_long, argv[0], spawn_result, strerror(spawn_result));
  }

cleanup:
  if (have_file_actions) {
    posix_spawn_file_actions_destroy(&file_actions);
  }
  if (argv != NULL) {
    for (int index = 0; argv[index] != NULL; index++) {
      free(argv[index]);
    }
    free(argv);
  }
  if (envp != NULL) {
    for (int index = 0; envp[index] != NULL; index++) {
      free(envp[index]);
    }
    free(envp);
  }
  free(decoded);
  free(copy);
}

static void pm_control_dispatch_line(const char *line) {
  if (strncmp(line, "RESPAWN\t", 8) == 0) {
    pm_control_handle_respawn(line + 8);
    return;
  }
  /* Other lines (e.g. the controlChannel response frame) are ignored. */
  pm_debug("control line ignored: %.120s", line);
}

static int pm_control_connect(void) {
  char socket_path[PM_MAX_PATH];
  struct sockaddr_un address;
  char hello[320];
  size_t hello_length;
  const char *network_id;
  int fd;

  pm_ensure_symbols();
  if (pm_real_connect == NULL) {
    return -1;
  }

  pm_default_socket_path(socket_path, sizeof(socket_path));
  fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    return -1;
  }
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  snprintf(address.sun_path, sizeof(address.sun_path), "%s", socket_path);

  /*
   * Runs on the dedicated control thread (its own thread-local hook depth), and
   * calls the real connect directly, so the socket hook is never re-entered.
   */
  if (pm_real_connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    pm_debug("control connect failed socket=%s error=%s", socket_path, strerror(errno));
    close(fd);
    return -1;
  }
  pm_debug("control connected socket=%s", socket_path);

  /* Register the network scope so the daemon routes a RESPAWN only to a
   * same-network ancestor (network ids are [a-z0-9-], so JSON-safe unescaped). */
  network_id = pm_current_network_id();
  hello_length = (size_t)snprintf(
    hello,
    sizeof(hello),
    "{\"id\":\"hook-control-%ld\",\"method\":\"controlChannel\",\"payload\":{\"pid\":%ld,\"networkId\":\"%s\"}}\n",
    (long)getpid(),
    (long)getpid(),
    network_id != NULL ? network_id : "");
  if (hello_length >= sizeof(hello) || write(fd, hello, hello_length) != (ssize_t)hello_length) {
    close(fd);
    return -1;
  }

  return fd;
}

static void pm_control_read_loop(int fd) {
  char *buffer = (char *)malloc(PM_CONTROL_LINE_SIZE);
  size_t length = 0;

  if (buffer == NULL) {
    return;
  }

  for (;;) {
    ssize_t count;

    if (length >= PM_CONTROL_LINE_SIZE - 1) {
      /* Overlong line without a newline: reset rather than grow unbounded. */
      length = 0;
    }
    count = read(fd, buffer + length, PM_CONTROL_LINE_SIZE - 1 - length);
    if (count <= 0) {
      if (count < 0 && errno == EINTR) {
        continue;
      }
      free(buffer);
      return;
    }
    length += (size_t)count;

    for (;;) {
      char *newline = memchr(buffer, '\n', length);
      size_t line_length;

      if (newline == NULL) {
        break;
      }
      line_length = (size_t)(newline - buffer);
      buffer[line_length] = '\0';
      if (line_length > 0) {
        pm_control_dispatch_line(buffer);
      }
      memmove(buffer, newline + 1, length - line_length - 1);
      length -= line_length + 1;
    }
  }
}

static void *pm_control_thread_main(void *unused) {
  (void)unused;

  while (pm_control_should_run) {
    int fd = pm_control_connect();
    if (fd >= 0) {
      pm_control_read_loop(fd);
      close(fd);
    }
    if (!pm_control_should_run) {
      break;
    }
    usleep(PM_CONTROL_RECONNECT_BACKOFF_US);
  }

  return NULL;
}

/*
 * Opens the control channel once for a scoped process that spawns children.
 * Called from the spawn hooks so only real parents connect; leaf commands that
 * never spawn stay off the daemon entirely.
 */
static void pm_control_channel_init(void) {
  pthread_attr_t attr;
  pthread_t thread;

  pm_debug("control init enabled=%d scope=%d started=%d", pm_hook_enabled(), pm_has_current_network_scope(), (int)pm_control_started);
  if (!pm_hook_enabled() || !pm_has_current_network_scope()) {
    return;
  }

  pthread_mutex_lock(&pm_control_start_mutex);
  if (pm_control_started) {
    pthread_mutex_unlock(&pm_control_start_mutex);
    return;
  }
  pm_control_started = 1;
  pthread_mutex_unlock(&pm_control_start_mutex);

  pm_control_should_run = 1;
  if (pthread_attr_init(&attr) != 0) {
    pm_control_should_run = 0;
    return;
  }
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&thread, &attr, pm_control_thread_main, NULL) != 0) {
    pm_control_should_run = 0;
  }
  pthread_attr_destroy(&attr);
}

/*
 * A non-interactive `sh -c <cmd>` reads NO startup file (not BASH_ENV, not ENV),
 * and SIP strips DYLD_INSERT_LIBRARIES when exec'ing the protected shell, so a
 * server launched through `sh -c` (yarn/npm scripts, child_process.exec, make,
 * dotenv — the universal command path) escapes the preload. This is the only
 * hook point for that boundary: prepend an in-command restore so the shell
 * re-establishes the preload for ITS children from the surviving hint. The shell
 * itself stays unhooked (fine); its children (the real server) become hooked.
 * `: pmdyld;` is a no-op sentinel making the rewrite idempotent.
 *
 * Restoring DYLD in the shell is not enough: the orig command routinely execs a
 * `#!/usr/bin/env node` script (every npm `.bin` shim, nvm) and /usr/bin/env is
 * SIP-protected, so the kernel strips DYLD again at that exec. Defeat this by also
 * front-loading the runtime-shim dir in PATH: it holds node/yarn/npm/npx shims that
 * re-restore DYLD (from the surviving hint) before exec'ing the real interpreter, so
 * `/usr/bin/env node` resolves to the shim and the child stays hooked. The shim just
 * re-execs the real tool, so prepending it is transparent.
 */
#define PM_SH_C_SENTINEL ": pmdyld;"
#define PM_SH_C_PREAMBLE \
  ": pmdyld;if [ -n \"$PORT_MANAGER_DYLD_INSERT_LIBRARIES\" ] && [ \"${PORT_MANAGER_HOOK_DISABLED:-0}\" != 1 ] && [ \"${PORT_MANAGER_HOOK:-1}\" != 0 ]; then DYLD_INSERT_LIBRARIES=\"$PORT_MANAGER_DYLD_INSERT_LIBRARIES\"; export DYLD_INSERT_LIBRARIES; if [ -n \"$PORT_MANAGER_RUNTIME_SHIM_DIR\" ] && [ -d \"$PORT_MANAGER_RUNTIME_SHIM_DIR\" ]; then case \":$PATH:\" in \":$PORT_MANAGER_RUNTIME_SHIM_DIR:\"*) ;; *) PATH=\"$PORT_MANAGER_RUNTIME_SHIM_DIR:$PATH\"; export PATH ;; esac; fi; fi;"

static int pm_basename_is_shell(const char *path) {
  const char *base;
  if (path == NULL) {
    return 0;
  }
  base = strrchr(path, '/');
  base = (base == NULL) ? path : base + 1;
  return strcmp(base, "sh") == 0 || strcmp(base, "bash") == 0 || strcmp(base, "zsh") == 0 ||
         strcmp(base, "dash") == 0;
}

/*
 * If (path/argv[0]) is a shell invoked as `-c <cmd>`, returns a new NULL-terminated
 * argv whose command has the DYLD-restore preamble prepended; otherwise NULL (use
 * the original argv). Only argv[cmd_index] is heap-allocated; free with
 * pm_free_rewritten_argv().
 */
static char **pm_rewrite_shell_c_argv(const char *path, char *const argv[], char *const envp[]) {
  size_t argc = 0;
  size_t cmd_index = 0;
  char **new_argv;
  char *new_cmd;
  size_t new_cmd_length;
  const char *hint;

  if (argv == NULL || pm_hook_depth > 0 || !pm_hook_enabled() || envp == NULL) {
    return NULL;
  }
  if (pm_envp_value_is(envp, "PORT_MANAGER_HOOK_DISABLED", "1") ||
      pm_envp_value_is(envp, "PORT_MANAGER_HOOK", "0") ||
      !pm_envp_value_is(envp, "PORT_MANAGER_PRELOAD_REPAIR", "1")) {
    return NULL;
  }
  hint = pm_envp_value(envp, PM_PRELOAD_HINT_ENV);
  if (hint == NULL || hint[0] == '\0') {
    return NULL;
  }
  if (!pm_basename_is_shell(path) && !(argv[0] != NULL && pm_basename_is_shell(argv[0]))) {
    return NULL;
  }

  for (size_t index = 0; argv[index] != NULL; index++) {
    if (cmd_index == 0 && strcmp(argv[index], "-c") == 0 && argv[index + 1] != NULL) {
      cmd_index = index + 1;
    }
    argc++;
  }
  if (cmd_index == 0) {
    return NULL;
  }
  if (strncmp(argv[cmd_index], PM_SH_C_SENTINEL, strlen(PM_SH_C_SENTINEL)) == 0) {
    return NULL; /* already rewritten */
  }

  new_cmd_length = strlen(PM_SH_C_PREAMBLE) + strlen(argv[cmd_index]) + 1;
  new_cmd = (char *)malloc(new_cmd_length);
  if (new_cmd == NULL) {
    return NULL;
  }
  snprintf(new_cmd, new_cmd_length, "%s%s", PM_SH_C_PREAMBLE, argv[cmd_index]);

  new_argv = (char **)malloc((argc + 1) * sizeof(char *));
  if (new_argv == NULL) {
    free(new_cmd);
    return NULL;
  }
  for (size_t index = 0; index < argc; index++) {
    new_argv[index] = (index == cmd_index) ? new_cmd : argv[index];
  }
  new_argv[argc] = NULL;
  return new_argv;
}

static void pm_free_rewritten_argv(char **rewritten, char *const original[]) {
  if (rewritten == NULL) {
    return;
  }
  for (size_t index = 0; rewritten[index] != NULL; index++) {
    if (original == NULL || rewritten[index] != original[index]) {
      free(rewritten[index]);
    }
  }
  free(rewritten);
}

static int pm_exec_with_prepared_child(
  const char *path,
  char *const argv[],
  char *const envp[],
  int allow_path_lookup) {
  const char *target;
  const char *exec_target;
  char resolved_target[PM_MAX_PATH];
  pm_child_environment child_environment;
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

  /*
   * The child only needs the preload environment re-injected; the PATH runtime
   * shims restore it across protected launchers, so the hook no longer parses
   * shebangs or wrapper scripts to redirect the target.
   */
  child_environment = pm_prepare_child_environment(envp);
  exec_target = target;

  /*
   * execvp searches PATH before execve. Resolve it here so the repaired child
   * environment is used for the exec.
   */
  if (allow_path_lookup && target != NULL && strchr(target, '/') == NULL) {
    if (pm_resolve_exec_path(target, child_environment.envp, 1, resolved_target, sizeof(resolved_target)) == 0) {
      exec_target = resolved_target;
    }
  }

  {
    char **rewritten_argv = pm_rewrite_shell_c_argv(exec_target, argv, child_environment.envp);
    result = pm_real_execve(exec_target, rewritten_argv != NULL ? rewritten_argv : argv, child_environment.envp);
    saved_errno = errno;
    pm_free_rewritten_argv(rewritten_argv, argv);
  }
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
  int result;

  pm_ensure_symbols();
  if (pm_real_posix_spawn == NULL) {
    errno = ENOSYS;
    return ENOSYS;
  }

  /* This process spawns children, so it is a potential respawn parent. */
  pm_control_channel_init();

  target = pm_runtime_exec_target(path, argv);
  if (target != path) {
    pm_debug("runtime posix_spawn rewrite path=%s target=%s", path != NULL ? path : "(null)", target);
  }

  child_environment = pm_prepare_child_environment(envp);
  {
    char **rewritten_argv = pm_rewrite_shell_c_argv(target, argv, child_environment.envp);
    result = pm_real_posix_spawn(
      pid, target, file_actions, attrp, rewritten_argv != NULL ? rewritten_argv : argv, child_environment.envp);
    pm_free_rewritten_argv(rewritten_argv, argv);
  }
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
  int result;

  pm_ensure_symbols();
  if (pm_real_posix_spawnp == NULL) {
    errno = ENOSYS;
    return ENOSYS;
  }

  /* This process spawns children, so it is a potential respawn parent. */
  pm_control_channel_init();

  target = pm_runtime_exec_target(file, argv);
  child_environment = pm_prepare_child_environment(envp);

  {
    char **rewritten_argv = pm_rewrite_shell_c_argv(target != file ? target : file, argv, child_environment.envp);
    char *const *effective_argv = rewritten_argv != NULL ? rewritten_argv : argv;
    if (target != file) {
      /*
       * The runtime target was rewritten to an absolute shim path, so spawn it
       * directly instead of letting posix_spawnp re-search PATH.
       */
      pm_debug("runtime posix_spawnp rewrite file=%s target=%s", file != NULL ? file : "(null)", target);
      result = pm_real_posix_spawn(pid, target, file_actions, attrp, effective_argv, child_environment.envp);
    } else {
      result = pm_real_posix_spawnp(pid, file, file_actions, attrp, effective_argv, child_environment.envp);
    }
    pm_free_rewritten_argv(rewritten_argv, argv);
  }

  pm_release_child_environment(&child_environment);
  return result;
}

/*
 * True when a host-order IPv4 address is one this process is allowed to see:
 * 127.0.0.1, or this process's own per-network / actual loopback alias. Every
 * other 127.x address belongs to a different logical network.
 */
static int pm_loopback_addr_is_visible(uint32_t host_order_ip) {
  const char *own_hosts[2];
  size_t index;

  if (host_order_ip == 0x7f000001u) {
    return 1;
  }

  own_hosts[0] = pm_network_loopback_host();
  own_hosts[1] = pm_actual_loopback_host();
  for (index = 0; index < sizeof(own_hosts) / sizeof(own_hosts[0]); index++) {
    struct in_addr parsed;
    if (own_hosts[index] != NULL && inet_pton(AF_INET, own_hosts[index], &parsed) == 1 &&
        ntohl(parsed.s_addr) == host_order_ip) {
      return 1;
    }
  }

  return 0;
}

/*
 * Isolates the interface view for a network-scoped process. The per-network
 * loopback aliases live on the host-global lo0, so any process could otherwise
 * enumerate every other network's alias via getifaddrs()/os.networkInterfaces().
 * We detach the address of foreign aliases (getifaddrs(3) permits a NULL
 * ifa_addr, which every well-behaved caller skips) instead of restructuring or
 * freeing the list, so the caller's freeifaddrs() stays correct on every libc.
 */
static int pm_getifaddrs_hook(struct ifaddrs **ifap) {
  struct ifaddrs *entry;
  int result;

  pm_ensure_symbols();
  if (pm_real_getifaddrs == NULL) {
    errno = ENOSYS;
    return -1;
  }

  result = pm_real_getifaddrs(ifap);
  if (result != 0 || ifap == NULL || *ifap == NULL) {
    return result;
  }

  if (!pm_hook_enabled() || !pm_has_current_network_scope()) {
    return result;
  }

  for (entry = *ifap; entry != NULL; entry = entry->ifa_next) {
    const struct sockaddr *addr = entry->ifa_addr;
    uint32_t ip;

    if (addr == NULL || addr->sa_family != AF_INET) {
      continue;
    }
    ip = ntohl(((const struct sockaddr_in *)addr)->sin_addr.s_addr);
    if ((ip >> 24) != 127 || pm_loopback_addr_is_visible(ip)) {
      continue;
    }

    /* A different network's loopback alias: hide it from this process. */
    entry->ifa_addr = NULL;
    entry->ifa_netmask = NULL;
  }

  return result;
}

/*
 * ---- Transparent respawn: wait()/kill() virtualization ---------------------
 * After this parent respawns an escaped child (kills original P, spawns
 * replacement N as its own child), its own libuv/shell process management must
 * keep seeing "P" alive and then see "P" exit when N exits. macOS cannot
 * reparent N onto P, so the parent's own wait()/kill() are virtualized against
 * the P<->N map:
 *   - wait for P              -> wait for N, report the result as P
 *   - wildcard wait yields N  -> report as P (retire the pair)
 *   - wildcard wait yields P  -> the killed original; consume silently
 *   - kill(P)                 -> kill(N)
 * With no respawn active (pm_respawn_active == 0) every path is a straight
 * pass-through, so unrelated processes and the common case pay nothing.
 */
static pid_t pm_wait_virtualized(pid_t pid, int *status, int options, struct rusage *rusage) {
  pm_ensure_symbols();
  if (pm_real_wait4 == NULL) {
    errno = ENOSYS;
    return -1;
  }
  if (pm_hook_depth > 0 || !pm_respawn_active) {
    return pm_real_wait4(pid, status, options, rusage);
  }

  if (pid > 0) {
    pid_t new_pid = pm_respawn_new_for_old(pid);
    if (new_pid > 0) {
      pid_t result = pm_real_wait4(new_pid, status, options, rusage);
      if (result == new_pid) {
        pm_respawn_retire_by_new(new_pid);
        pm_hook_depth++;
        pm_real_wait4(pid, NULL, WNOHANG, NULL); /* reap the killed original's zombie */
        pm_hook_depth--;
        return pid; /* report the replacement's exit as the original */
      }
      return result; /* 0 (WNOHANG, replacement still running) or -1 */
    }
    if (pm_respawn_is_suppressed_old(pid)) {
      pm_hook_depth++;
      pm_real_wait4(pid, NULL, WNOHANG, NULL);
      pm_hook_depth--;
      errno = ECHILD;
      return -1;
    }
    return pm_real_wait4(pid, status, options, rusage);
  }

  /* Wildcard / process-group wait: loop, suppressing killed originals. */
  for (;;) {
    pid_t result = pm_real_wait4(pid, status, options, rusage);
    pid_t old_pid;

    if (result <= 0) {
      return result;
    }
    old_pid = pm_respawn_retire_by_new(result);
    if (old_pid > 0) {
      return old_pid; /* replacement exited: report as the original */
    }
    if (pm_respawn_is_suppressed_old(result)) {
      continue; /* killed original consumed; keep looking for real events */
    }
    return result;
  }
}

static pid_t pm_wait4_hook(pid_t pid, int *status, int options, struct rusage *rusage) {
  return pm_wait_virtualized(pid, status, options, rusage);
}

static pid_t pm_waitpid_hook(pid_t pid, int *status, int options) {
  return pm_wait_virtualized(pid, status, options, NULL);
}

static pid_t pm_wait3_hook(int *status, int options, struct rusage *rusage) {
  return pm_wait_virtualized((pid_t)-1, status, options, rusage);
}

static int pm_kill_hook(pid_t pid, int sig) {
  pm_ensure_symbols();
  if (pm_real_kill == NULL) {
    errno = ENOSYS;
    return -1;
  }
  if (pm_hook_depth == 0 && pm_respawn_active && pid > 0) {
    pid_t new_pid = pm_respawn_new_for_old(pid);
    if (new_pid > 0) {
      return pm_real_kill(new_pid, sig);
    }
  }
  return pm_real_kill(pid, sig);
}

/*
 * ============================================================================
 * Per-network hostname virtualization
 * ============================================================================
 * The transparent connect() rewrite already routes 127.0.0.1/localhost to each
 * network's loopback, but the process still SEES the machine hostname (and its
 * config still says "localhost"), so any app that keys its identity off the
 * hostname — celery's default node name `celery@%h`, pidfiles, logs, locks,
 * metrics — collides across networks. To give each network a distinct identity
 * GENERICALLY, with zero application-specific knowledge, a hooked process that
 * carries a network id reports the NETWORK NAME as its hostname.
 *
 * gethostname()/uname().nodename then return e.g. "alphac"/"captainprod", so the
 * shell (bash/sh/zsh) and every child it spawns inherit a per-network identity.
 * Apps that derive identity from their hostname distinguish automatically (e.g.
 * celery's default `celery@%h` becomes `celery@alphac`). Opt-in and fail-safe:
 * no network id (or hook disabled) => the real hostname passes through. This is
 * the generic analogue of what zz-multi does by hand with `--hostname=<cluster>`.
 * See docs/per-network-hostname.md.
 * ============================================================================
 */
typedef int (*pm_gethostname_fn)(char *, size_t);
typedef int (*pm_uname_fn)(struct utsname *);

#if defined(__APPLE__)
static pm_gethostname_fn pm_real_gethostname = gethostname;
static pm_uname_fn pm_real_uname = uname;
#else
static pm_gethostname_fn pm_real_gethostname = NULL;
static pm_uname_fn pm_real_uname = NULL;
#endif

/*
 * Returns the per-network hostname (the network name, sanitized to hostname-safe
 * characters) for this process, or NULL when it is not attached to a network or
 * the hook is disabled. Uses only getenv + string ops, so it is safe to call
 * from any thread and arbitrarily early (no file I/O, no interposed calls).
 */
static const char *pm_network_hostname(void) {
  static __thread char sanitized[256];
  const char *network;
  size_t out = 0;

  if (!pm_hook_enabled()) {
    return NULL;
  }
  network = getenv("PORT_MANAGER_NETWORK_NAME");
  if (network == NULL || network[0] == '\0') {
    network = getenv("PORT_MANAGER_NETWORK_ID");
  }
  if (network == NULL || network[0] == '\0') {
    return NULL;
  }
  for (const char *cursor = network; *cursor != '\0' && out + 1 < sizeof(sanitized); cursor++) {
    unsigned char ch = (unsigned char)*cursor;
    sanitized[out++] = (isalnum(ch) || ch == '-' || ch == '.') ? (char)ch : '-';
  }
  sanitized[out] = '\0';
  return sanitized[0] != '\0' ? sanitized : NULL;
}

static int pm_gethostname_hook(char *name, size_t namelen) {
  const char *host;
#if !defined(__APPLE__)
  if (pm_real_gethostname == NULL) {
    pm_real_gethostname = (pm_gethostname_fn)pm_resolve_symbol("gethostname");
  }
#endif
  host = pm_network_hostname();
  if (host != NULL && name != NULL && namelen > 0) {
    snprintf(name, namelen, "%s", host);
    return 0;
  }
  return pm_real_gethostname(name, namelen);
}

static int pm_uname_hook(struct utsname *buf) {
  int result;
  const char *host;
#if !defined(__APPLE__)
  if (pm_real_uname == NULL) {
    pm_real_uname = (pm_uname_fn)pm_resolve_symbol("uname");
  }
#endif
  result = pm_real_uname(buf);
  if (result == 0 && buf != NULL) {
    host = pm_network_hostname();
    if (host != NULL) {
      snprintf(buf->nodename, sizeof(buf->nodename), "%s", host);
    }
  }
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
PM_DYLD_INTERPOSE(pm_getifaddrs_hook, getifaddrs);
PM_DYLD_INTERPOSE(pm_execve_hook, execve);
PM_DYLD_INTERPOSE(pm_execv_hook, execv);
PM_DYLD_INTERPOSE(pm_execvp_hook, execvp);
PM_DYLD_INTERPOSE(pm_posix_spawn_hook, posix_spawn);
PM_DYLD_INTERPOSE(pm_posix_spawnp_hook, posix_spawnp);
PM_DYLD_INTERPOSE(pm_wait4_hook, wait4);
PM_DYLD_INTERPOSE(pm_waitpid_hook, waitpid);
PM_DYLD_INTERPOSE(pm_wait3_hook, wait3);
PM_DYLD_INTERPOSE(pm_kill_hook, kill);
PM_DYLD_INTERPOSE(pm_gethostname_hook, gethostname);
PM_DYLD_INTERPOSE(pm_uname_hook, uname);
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

int getifaddrs(struct ifaddrs **ifap) {
  return pm_getifaddrs_hook(ifap);
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

pid_t wait4(pid_t pid, int *status, int options, struct rusage *rusage) {
  return pm_wait4_hook(pid, status, options, rusage);
}

pid_t waitpid(pid_t pid, int *status, int options) {
  return pm_waitpid_hook(pid, status, options);
}

pid_t wait3(int *status, int options, struct rusage *rusage) {
  return pm_wait3_hook(status, options, rusage);
}

int kill(pid_t pid, int sig) {
  return pm_kill_hook(pid, sig);
}

int gethostname(char *name, size_t namelen) {
  return pm_gethostname_hook(name, namelen);
}

int uname(struct utsname *buf) {
  return pm_uname_hook(buf);
}
#endif

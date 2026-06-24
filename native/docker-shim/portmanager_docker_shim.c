#include <errno.h>
#include <ctype.h>
#include <dirent.h>
#include <limits.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <unistd.h>

/*
 * Docker/Podman PATH shim for Compose clone routing.
 *
 * The shell hook already installs interactive functions, but many project tools
 * call child_process.spawn("docker", ...) and only observe PATH. This helper is
 * symlinked as docker and podman, finds the real runtime outside Port Manager's
 * shim directory, then applies the same project/container rewrite policy before
 * execing the real runtime.
 */

#define PM_MAX_PATH 4096
#define PM_MAX_FIELD 4096
#define PM_MAX_RUNTIME 32

#define PM_RUNTIME_SHIM_DIR_ENV "PORT_MANAGER_RUNTIME_SHIM_DIR"
#define PM_COMPOSE_ROUTING_FILE_ENV "PORT_MANAGER_COMPOSE_ROUTING_FILE"
#define PM_COMPOSE_ROUTING_FILE_PREFIX "compose-project-routing-"
#define PM_COMPOSE_ROUTING_FILE_SUFFIX ".tsv"
#define PM_COMPOSE_ROUTING_COMPOSE_SEPARATOR ".compose-"

typedef struct {
  char kind[16];
  char network_id[PM_MAX_FIELD];
  char runtime[PM_MAX_RUNTIME];
  char workdir[PM_MAX_PATH];
  char project_or_original_id[PM_MAX_FIELD];
  char original_name[PM_MAX_FIELD];
  char attached_id[PM_MAX_FIELD];
  char attached_name[PM_MAX_FIELD];
  char service_name[PM_MAX_FIELD];
} pm_route_row;

/** Returns the executable name used to decide whether this invocation is docker or podman. */
static const char *pm_basename(const char *path) {
  const char *slash;

  if (path == NULL || path[0] == '\0') {
    return NULL;
  }

  slash = strrchr(path, '/');
  return slash == NULL ? path : slash + 1;
}

/** Copies a possibly-null string into a fixed buffer without exposing truncation to callers. */
static void pm_copy(char *destination, size_t size, const char *source) {
  if (size == 0) {
    return;
  }

  if (source == NULL) {
    destination[0] = '\0';
    return;
  }

  snprintf(destination, size, "%s", source);
}

/** Removes line endings left on the final TSV field after splitting a row. */
static void pm_trim_line_end(char *value) {
  size_t length;

  if (value == NULL) {
    return;
  }

  length = strlen(value);
  while (length > 0 && (value[length - 1] == '\n' || value[length - 1] == '\r')) {
    value[--length] = '\0';
  }
}

/** Resolves a path when possible but keeps non-existing PATH entries comparable. */
static int pm_realpath_or_copy(const char *path, char *buffer, size_t size) {
  char resolved[PM_MAX_PATH];

  if (path == NULL || path[0] == '\0' || size == 0) {
    return -1;
  }

  if (realpath(path, resolved) != NULL) {
    snprintf(buffer, size, "%s", resolved);
    return 0;
  }

  snprintf(buffer, size, "%s", path);
  return 0;
}

/** Directory comparison is used to remove only the extension-owned shim directory from PATH. */
static int pm_same_directory(const char *left, const char *right) {
  char left_path[PM_MAX_PATH];
  char right_path[PM_MAX_PATH];

  if (left == NULL || right == NULL || left[0] == '\0' || right[0] == '\0') {
    return 0;
  }

  if (pm_realpath_or_copy(left, left_path, sizeof(left_path)) != 0 ||
      pm_realpath_or_copy(right, right_path, sizeof(right_path)) != 0) {
    return 0;
  }

  return strcmp(left_path, right_path) == 0;
}

/** True when a PATH candidate can replace this shim as the real runtime command. */
static int pm_is_executable_file(const char *path) {
  struct stat stat_buffer;

  if (stat(path, &stat_buffer) != 0 || !S_ISREG(stat_buffer.st_mode)) {
    return 0;
  }

  return access(path, X_OK) == 0;
}

/** Builds the PATH passed to Docker so nested runtime calls do not re-enter this shim. */
static char *pm_path_without_shim_directory(void) {
  const char *path_env = getenv("PATH");
  const char *shim_directory = getenv(PM_RUNTIME_SHIM_DIR_ENV);
  const char *cursor;
  char *result;
  size_t result_size;
  size_t used = 0;

  if (path_env == NULL || path_env[0] == '\0' || shim_directory == NULL || shim_directory[0] == '\0') {
    return path_env == NULL ? NULL : strdup(path_env);
  }

  result_size = strlen(path_env) + 1;
  result = calloc(result_size, 1);
  if (result == NULL) {
    return NULL;
  }

  cursor = path_env;
  while (cursor != NULL) {
    const char *separator = strchr(cursor, ':');
    size_t directory_length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
    char directory[PM_MAX_PATH];

    if (directory_length == 0) {
      snprintf(directory, sizeof(directory), ".");
    } else if (directory_length < sizeof(directory)) {
      memcpy(directory, cursor, directory_length);
      directory[directory_length] = '\0';
    } else {
      directory[0] = '\0';
    }

    if (directory[0] != '\0' && !pm_same_directory(directory, shim_directory)) {
      if (used > 0) {
        result[used++] = ':';
      }
      if (used + directory_length < result_size) {
        memcpy(result + used, cursor, directory_length);
        used += directory_length;
        result[used] = '\0';
      }
    }

    if (separator == NULL) {
      break;
    }
    cursor = separator + 1;
  }

  return result;
}

/** Finds the real docker/podman command while skipping the Port Manager shim directory. */
static int pm_find_runtime_on_path(const char *runtime, char *buffer, size_t size) {
  char *path_env = pm_path_without_shim_directory();
  const char *cursor;

  if (runtime == NULL || runtime[0] == '\0' || strchr(runtime, '/') != NULL || path_env == NULL) {
    free(path_env);
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

    snprintf(candidate, sizeof(candidate), "%s/%s", directory, runtime);
    if (pm_is_executable_file(candidate)) {
      int status = pm_realpath_or_copy(candidate, buffer, size);
      free(path_env);
      return status;
    }

next_path_entry:
    if (separator == NULL) {
      break;
    }
    cursor = separator + 1;
  }

  free(path_env);
  return -1;
}

/** Docker global options are ignored while locating the first semantic command. */
static int pm_global_option_takes_value(const char *arg) {
  return strcmp(arg, "--config") == 0 || strcmp(arg, "--context") == 0 || strcmp(arg, "-c") == 0 ||
         strcmp(arg, "--host") == 0 || strcmp(arg, "-H") == 0 || strcmp(arg, "--log-level") == 0 ||
         strcmp(arg, "-l") == 0 || strcmp(arg, "--tlscacert") == 0 || strcmp(arg, "--tlscert") == 0 ||
         strcmp(arg, "--tlskey") == 0;
}

/** Assignment-form global options also do not change the Docker subcommand. */
static int pm_global_option_is_assignment(const char *arg) {
  const char *options[] = {
    "--config=", "--context=", "--host=", "--log-level=", "--tlscacert=", "--tlscert=", "--tlskey=", NULL,
  };

  for (int index = 0; options[index] != NULL; index++) {
    size_t length = strlen(options[index]);
    if (strncmp(arg, options[index], length) == 0) {
      return 1;
    }
  }

  return 0;
}

/** Flag-form global options are skipped before compose/container routing decisions. */
static int pm_global_option_is_flag(const char *arg) {
  return strcmp(arg, "--debug") == 0 || strcmp(arg, "-D") == 0 || strcmp(arg, "--tls") == 0 ||
         strcmp(arg, "--tlsverify") == 0 || strcmp(arg, "--version") == 0 || strcmp(arg, "-v") == 0 ||
         strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0;
}

/** Returns the argv index of Docker's first non-global-option command. */
static int pm_first_command_index(int argc, char **argv) {
  int skip_next = 0;

  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];

    if (skip_next) {
      skip_next = 0;
      continue;
    }

    if (pm_global_option_takes_value(arg)) {
      skip_next = 1;
      continue;
    }

    if (pm_global_option_is_assignment(arg) || pm_global_option_is_flag(arg)) {
      continue;
    }

    if (arg[0] == '-') {
      continue;
    }

    return index;
  }

  return -1;
}

static const char *pm_network_id_from_route_table_path(void) {
  const char *route_file = getenv("PORT_MANAGER_ROUTES_FILE");
  const char *base_name;
  const char *prefix = "newdlops-portmanager-routes-";
  const char *suffix = ".json";
  const char *scope_start;
  size_t prefix_length = strlen(prefix);
  size_t suffix_length = strlen(suffix);
  size_t base_length;
  size_t body_length;
  size_t network_length;
  static char network_id_from_route_table[PM_MAX_FIELD];

  /*
   * Child process launchers sometimes keep the scoped route file but drop the
   * explicit network variables. The filename is stable enough to recover the
   * logical-network id for Docker/Compose argv rewrites.
   */
  if (route_file == NULL || route_file[0] == '\0') {
    return NULL;
  }

  base_name = strrchr(route_file, '/');
  base_name = base_name == NULL ? route_file : base_name + 1;
  base_length = strlen(base_name);

  if (base_length <= prefix_length + suffix_length || strncmp(base_name, prefix, prefix_length) != 0) {
    return NULL;
  }

  if (strcmp(base_name + base_length - suffix_length, suffix) != 0) {
    return NULL;
  }

  body_length = base_length - prefix_length - suffix_length;
  scope_start = memchr(base_name + prefix_length, '-', body_length);
  if (scope_start == NULL) {
    return NULL;
  }

  scope_start++;
  network_length = (size_t)((base_name + prefix_length + body_length) - scope_start);
  if (network_length == 0 || network_length >= sizeof(network_id_from_route_table)) {
    return NULL;
  }

  memcpy(network_id_from_route_table, scope_start, network_length);
  network_id_from_route_table[network_length] = '\0';
  return network_id_from_route_table;
}

static const char *pm_network_id_from_compose_routing_file(void) {
  const char *routing_file = getenv(PM_COMPOSE_ROUTING_FILE_ENV);
  const char *base_name;
  const char *compose_separator;
  size_t prefix_length = strlen(PM_COMPOSE_ROUTING_FILE_PREFIX);
  size_t suffix_length = strlen(PM_COMPOSE_ROUTING_FILE_SUFFIX);
  size_t base_length;
  size_t scoped_length;
  size_t network_length;
  static char network_id_from_compose_file[PM_MAX_FIELD];

  /*
   * Per-network Compose maps let child-process Docker calls recover scope even
   * when launcher boundaries dropped the explicit network variables.
   */
  if (routing_file == NULL || routing_file[0] == '\0') {
    return NULL;
  }

  base_name = strrchr(routing_file, '/');
  base_name = base_name == NULL ? routing_file : base_name + 1;
  base_length = strlen(base_name);

  if (base_length <= prefix_length + suffix_length || strncmp(base_name, PM_COMPOSE_ROUTING_FILE_PREFIX, prefix_length) != 0) {
    return NULL;
  }

  if (strcmp(base_name + base_length - suffix_length, PM_COMPOSE_ROUTING_FILE_SUFFIX) != 0) {
    return NULL;
  }

  scoped_length = base_length - prefix_length - suffix_length;
  compose_separator = strstr(base_name + prefix_length, PM_COMPOSE_ROUTING_COMPOSE_SEPARATOR);
  network_length = compose_separator == NULL
    ? scoped_length
    : (size_t)(compose_separator - (base_name + prefix_length));
  if (network_length == 0 || network_length >= sizeof(network_id_from_compose_file)) {
    return NULL;
  }

  memcpy(network_id_from_compose_file, base_name + prefix_length, network_length);
  network_id_from_compose_file[network_length] = '\0';
  return network_id_from_compose_file;
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

/** Chooses the active logical network from the terminal hook environment. */
static const char *pm_network_id(void) {
  const char *network_id = getenv("PORT_MANAGER_NETWORK_ID");

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("NEWDLOPS_PM_NETWORK_ID");
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("PORT_MANAGER_BORROWED_NETWORK_ID");
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("NEWDLOPS_PM_BORROWED_NETWORK_ID");
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = pm_network_id_from_compose_routing_file();
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = pm_network_id_from_route_table_path();
  }

  return network_id;
}

/** Returns the daemon's global route table used as the base for scoped tables. */
static void pm_default_global_route_table_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_GLOBAL_ROUTES_FILE");

  if (buffer == NULL || size == 0) {
    return;
  }

  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-routes-%ld.json", (long)getuid());
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
  char scope[PM_MAX_FIELD];

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

/**
 * Reads fallback compose routes from the current network table, not from a
 * stale route-table env inherited from another attached terminal.
 */
static const char *pm_effective_route_table_path(void) {
  const char *network_id = pm_network_id();
  const char *configured = getenv("PORT_MANAGER_ROUTES_FILE");
  char configured_network[PM_MAX_FIELD];
  static char route_table_path[PM_MAX_PATH];
  char base_route_table_path[PM_MAX_PATH];

  if (network_id == NULL || network_id[0] == '\0') {
    return configured;
  }

  if (
    configured != NULL &&
    configured[0] != '\0' &&
    pm_route_table_path_network_id(configured, configured_network, sizeof(configured_network)) == 0 &&
    strcmp(configured_network, network_id) == 0
  ) {
    return configured;
  }

  pm_default_global_route_table_path(base_route_table_path, sizeof(base_route_table_path));
  if (pm_scoped_route_table_path(base_route_table_path, network_id, route_table_path, sizeof(route_table_path)) == 0) {
    return route_table_path;
  }

  return configured;
}

/** Splits one tab-separated route row written by serializeComposeProjectRoutingRows. */
static int pm_parse_route_row(char *line, pm_route_row *row) {
  char *fields[9] = {0};
  char *cursor = line;

  for (int index = 0; index < 9; index++) {
    fields[index] = cursor;
    if (cursor == NULL) {
      fields[index] = "";
      continue;
    }

    cursor = strchr(cursor, '\t');
    if (cursor != NULL) {
      *cursor = '\0';
      cursor++;
    }
  }

  for (char *end = line + strlen(line); end > line && (end[-1] == '\n' || end[-1] == '\r'); end--) {
    end[-1] = '\0';
  }

  memset(row, 0, sizeof(*row));
  pm_copy(row->kind, sizeof(row->kind), fields[0]);
  pm_copy(row->network_id, sizeof(row->network_id), fields[1]);
  pm_copy(row->runtime, sizeof(row->runtime), fields[2]);
  pm_copy(row->workdir, sizeof(row->workdir), fields[3]);
  pm_copy(row->project_or_original_id, sizeof(row->project_or_original_id), fields[4]);
  pm_copy(row->original_name, sizeof(row->original_name), fields[5]);
  pm_copy(row->attached_id, sizeof(row->attached_id), fields[6]);
  pm_copy(row->attached_name, sizeof(row->attached_name), fields[7]);
  pm_copy(row->service_name, sizeof(row->service_name), fields[8]);
  pm_trim_line_end(row->kind);
  pm_trim_line_end(row->network_id);
  pm_trim_line_end(row->runtime);
  pm_trim_line_end(row->workdir);
  pm_trim_line_end(row->project_or_original_id);
  pm_trim_line_end(row->original_name);
  pm_trim_line_end(row->attached_id);
  pm_trim_line_end(row->attached_name);
  pm_trim_line_end(row->service_name);

  return row->kind[0] != '\0';
}

typedef int (*pm_compose_routing_file_callback)(const char *file_path, void *context);

/**
 * Visits per-compose route maps next to a per-network anchor file.
 * The anchor preserves network identity in inherited environments, while the
 * compose-specific files avoid row-order matching across unrelated projects.
 */
static int pm_visit_scoped_compose_routing_files(
  const char *anchor_file_path,
  pm_compose_routing_file_callback callback,
  void *context,
  int *visited_count
) {
  const char *base_name;
  const char *slash;
  size_t directory_length;
  size_t base_length;
  size_t suffix_length = strlen(PM_COMPOSE_ROUTING_FILE_SUFFIX);
  size_t stem_length;
  char directory_path[PM_MAX_PATH];
  char file_name_prefix[PM_MAX_PATH];
  DIR *directory;
  struct dirent *entry;

  if (visited_count != NULL) {
    *visited_count = 0;
  }

  if (anchor_file_path == NULL || anchor_file_path[0] == '\0' || callback == NULL) {
    return -1;
  }

  slash = strrchr(anchor_file_path, '/');
  base_name = slash == NULL ? anchor_file_path : slash + 1;
  directory_length = slash == NULL ? 1 : (size_t)(slash - anchor_file_path);
  base_length = strlen(base_name);

  if (base_length <= suffix_length ||
      strncmp(base_name, PM_COMPOSE_ROUTING_FILE_PREFIX, strlen(PM_COMPOSE_ROUTING_FILE_PREFIX)) != 0 ||
      strcmp(base_name + base_length - suffix_length, PM_COMPOSE_ROUTING_FILE_SUFFIX) != 0) {
    return -1;
  }

  if (strstr(base_name, PM_COMPOSE_ROUTING_COMPOSE_SEPARATOR) != NULL) {
    return -1;
  }

  if (slash == NULL) {
    snprintf(directory_path, sizeof(directory_path), ".");
  } else if (directory_length >= sizeof(directory_path)) {
    return -1;
  } else {
    memcpy(directory_path, anchor_file_path, directory_length);
    directory_path[directory_length] = '\0';
  }

  stem_length = base_length - suffix_length;
  if (stem_length + strlen(PM_COMPOSE_ROUTING_COMPOSE_SEPARATOR) >= sizeof(file_name_prefix)) {
    return -1;
  }

  memcpy(file_name_prefix, base_name, stem_length);
  file_name_prefix[stem_length] = '\0';
  strncat(file_name_prefix, PM_COMPOSE_ROUTING_COMPOSE_SEPARATOR, sizeof(file_name_prefix) - strlen(file_name_prefix) - 1);

  directory = opendir(directory_path);
  if (directory == NULL) {
    return -1;
  }

  while ((entry = readdir(directory)) != NULL) {
    char scoped_file_path[PM_MAX_PATH];
    size_t entry_length = strlen(entry->d_name);

    if (entry_length <= suffix_length ||
        strncmp(entry->d_name, file_name_prefix, strlen(file_name_prefix)) != 0 ||
        strcmp(entry->d_name + entry_length - suffix_length, PM_COMPOSE_ROUTING_FILE_SUFFIX) != 0) {
      continue;
    }

    if (snprintf(scoped_file_path, sizeof(scoped_file_path), "%s/%s", directory_path, entry->d_name) >= (int)sizeof(scoped_file_path)) {
      continue;
    }

    if (visited_count != NULL) {
      (*visited_count)++;
    }
    callback(scoped_file_path, context);
  }

  closedir(directory);
  return 0;
}

/** Cwd matching mirrors the shell shim's lexical PWD check plus physical path fallback. */
static int pm_cwd_matches_workdir(const char *workdir) {
  const char *pwd = getenv("PWD");
  char cwd[PM_MAX_PATH];
  char physical_workdir[PM_MAX_PATH];
  size_t workdir_length;

  if (workdir == NULL || workdir[0] == '\0') {
    return 0;
  }

  workdir_length = strlen(workdir);
  if (pwd != NULL && strncmp(pwd, workdir, workdir_length) == 0 &&
      (pwd[workdir_length] == '\0' || pwd[workdir_length] == '/')) {
    return 1;
  }

  if (getcwd(cwd, sizeof(cwd)) == NULL || realpath(workdir, physical_workdir) == NULL) {
    return 0;
  }

  workdir_length = strlen(physical_workdir);
  return strncmp(cwd, physical_workdir, workdir_length) == 0 &&
         (cwd[workdir_length] == '\0' || cwd[workdir_length] == '/');
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

static int pm_current_cwd_matches_route_cwd(const char *route_cwd) {
  const char *pwd = getenv("PWD");
  char cwd[PM_MAX_PATH];
  char physical_route_cwd[PM_MAX_PATH];

  if (route_cwd == NULL || route_cwd[0] == '\0') {
    return 0;
  }

  if (pwd != NULL &&
      (pm_path_contains_or_equals(pwd, route_cwd) || pm_path_contains_or_equals(route_cwd, pwd))) {
    return 1;
  }

  if (getcwd(cwd, sizeof(cwd)) == NULL) {
    if (pwd == NULL || pwd[0] == '\0') {
      return 0;
    }
    pm_copy(cwd, sizeof(cwd), pwd);
  }

  if (pm_path_contains_or_equals(cwd, route_cwd) || pm_path_contains_or_equals(route_cwd, cwd)) {
    return 1;
  }

  if (realpath(route_cwd, physical_route_cwd) == NULL) {
    return 0;
  }

  return pm_path_contains_or_equals(cwd, physical_route_cwd) || pm_path_contains_or_equals(physical_route_cwd, cwd);
}

/** Normalizes compose file arguments so scripts can route even outside the compose cwd. */
static int pm_normalize_compose_file_path(const char *path, char *buffer, size_t size) {
  char combined[PM_MAX_PATH];
  char resolved[PM_MAX_PATH];

  if (path == NULL || path[0] == '\0' || size == 0) {
    return -1;
  }

  if (path[0] == '/') {
    snprintf(combined, sizeof(combined), "%s", path);
  } else {
    char cwd[PM_MAX_PATH];
    if (getcwd(cwd, sizeof(cwd)) == NULL) {
      return -1;
    }
    snprintf(combined, sizeof(combined), "%s/%s", cwd, path);
  }

  if (realpath(combined, resolved) != NULL) {
    snprintf(buffer, size, "%s", resolved);
  } else {
    snprintf(buffer, size, "%s", combined);
  }

  return 0;
}

/** File comparisons are used when compose commands pass -f from a script cwd. */
static int pm_same_compose_file_path(const char *left, const char *right) {
  char left_path[PM_MAX_PATH];
  char right_path[PM_MAX_PATH];

  if (pm_normalize_compose_file_path(left, left_path, sizeof(left_path)) != 0 ||
      pm_normalize_compose_file_path(right, right_path, sizeof(right_path)) != 0) {
    return 0;
  }

  return strcmp(left_path, right_path) == 0;
}

/** Returns true when argv contains a compose -f/--file reference to the route file. */
static int pm_argv_references_compose_file(int argc, char **argv, const char *expected_file) {
  int next_is_file = 0;

  if (expected_file == NULL || expected_file[0] == '\0') {
    return 0;
  }

  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];

    if (next_is_file) {
      next_is_file = 0;
      if (pm_same_compose_file_path(expected_file, arg)) {
        return 1;
      }
      continue;
    }

    if (strcmp(arg, "-f") == 0 || strcmp(arg, "--file") == 0) {
      next_is_file = 1;
      continue;
    }

    if (strncmp(arg, "--file=", 7) == 0 && pm_same_compose_file_path(expected_file, arg + 7)) {
      return 1;
    }

    if (strncmp(arg, "-f", 2) == 0 && arg[2] != '\0' && pm_same_compose_file_path(expected_file, arg + 2)) {
      return 1;
    }
  }

  return 0;
}

/** Copies the last path component after trimming trailing slashes. */
static int pm_path_basename_component(const char *path_value, char *buffer, size_t size) {
  const char *end;
  const char *start;
  size_t length;

  if (path_value == NULL || path_value[0] == '\0' || buffer == NULL || size == 0) {
    return -1;
  }

  end = path_value + strlen(path_value);
  while (end > path_value + 1 && end[-1] == '/') {
    end--;
  }

  start = end;
  while (start > path_value && start[-1] != '/') {
    start--;
  }

  length = (size_t)(end - start);
  if (length == 0 || length >= size) {
    return -1;
  }

  memcpy(buffer, start, length);
  buffer[length] = '\0';
  return 0;
}

/** Infers Compose's default project name from a directory path when no -p is present. */
static int pm_compose_project_name_from_directory(const char *directory, char *buffer, size_t size) {
  char combined[PM_MAX_PATH];
  char resolved[PM_MAX_PATH];
  const char *source = directory;

  if (directory == NULL || directory[0] == '\0' || buffer == NULL || size == 0) {
    return -1;
  }

  if (directory[0] != '/') {
    char cwd[PM_MAX_PATH];
    if (getcwd(cwd, sizeof(cwd)) != NULL) {
      snprintf(combined, sizeof(combined), "%s/%s", cwd, directory);
      source = combined;
    }
  }

  if (realpath(source, resolved) != NULL) {
    source = resolved;
  }

  return pm_path_basename_component(source, buffer, size);
}

/** Infers Compose's default project name from the first -f/--file argument. */
static int pm_compose_project_name_from_file(const char *file_path, char *buffer, size_t size) {
  char normalized[PM_MAX_PATH];
  char *slash;

  if (pm_normalize_compose_file_path(file_path, normalized, sizeof(normalized)) != 0) {
    return -1;
  }

  slash = strrchr(normalized, '/');
  if (slash == NULL) {
    return -1;
  }

  *slash = '\0';
  return pm_compose_project_name_from_directory(normalized, buffer, size);
}

/**
 * Returns the project name this compose invocation is expected to target.
 * This intentionally mirrors the common Compose precedence enough for routing:
 * explicit -p, COMPOSE_PROJECT_NAME, --project-directory, first -f, then cwd.
 */
static int pm_compose_requested_project_name(int argc, char **argv, char *buffer, size_t size) {
  int next_is_project = 0;
  int next_is_file = 0;
  int next_is_project_directory = 0;
  char first_file[PM_MAX_PATH] = "";
  char project_directory[PM_MAX_PATH] = "";
  const char *env_project = getenv("COMPOSE_PROJECT_NAME");

  if (buffer == NULL || size == 0) {
    return -1;
  }
  buffer[0] = '\0';

  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];

    if (next_is_project) {
      pm_copy(buffer, size, arg);
      return buffer[0] == '\0' ? -1 : 0;
    }

    if (next_is_file) {
      next_is_file = 0;
      if (first_file[0] == '\0') {
        pm_copy(first_file, sizeof(first_file), arg);
      }
      continue;
    }

    if (next_is_project_directory) {
      next_is_project_directory = 0;
      pm_copy(project_directory, sizeof(project_directory), arg);
      continue;
    }

    if (strcmp(arg, "-p") == 0 || strcmp(arg, "--project-name") == 0) {
      next_is_project = 1;
      continue;
    }

    if (strncmp(arg, "--project-name=", 15) == 0) {
      pm_copy(buffer, size, arg + 15);
      return buffer[0] == '\0' ? -1 : 0;
    }

    if (strncmp(arg, "-p", 2) == 0 && arg[2] != '\0') {
      pm_copy(buffer, size, arg + 2);
      return buffer[0] == '\0' ? -1 : 0;
    }

    if (strcmp(arg, "-f") == 0 || strcmp(arg, "--file") == 0) {
      next_is_file = 1;
      continue;
    }

    if (strncmp(arg, "--file=", 7) == 0 && first_file[0] == '\0') {
      pm_copy(first_file, sizeof(first_file), arg + 7);
      continue;
    }

    if (strncmp(arg, "-f", 2) == 0 && arg[2] != '\0' && first_file[0] == '\0') {
      pm_copy(first_file, sizeof(first_file), arg + 2);
      continue;
    }

    if (strcmp(arg, "--project-directory") == 0) {
      next_is_project_directory = 1;
      continue;
    }

    if (strncmp(arg, "--project-directory=", 20) == 0) {
      pm_copy(project_directory, sizeof(project_directory), arg + 20);
      continue;
    }
  }

  if (env_project != NULL && env_project[0] != '\0') {
    pm_copy(buffer, size, env_project);
    return 0;
  }

  if (project_directory[0] != '\0' && pm_compose_project_name_from_directory(project_directory, buffer, size) == 0) {
    return 0;
  }

  if (first_file[0] != '\0' && pm_compose_project_name_from_file(first_file, buffer, size) == 0) {
    return 0;
  }

  return pm_compose_project_name_from_directory(".", buffer, size);
}

static int pm_compose_override_for_project(const char *attached_project, char *buffer, size_t size) {
  const char *routing_file = getenv(PM_COMPOSE_ROUTING_FILE_ENV);
  const char *slash;
  char directory[PM_MAX_PATH];
  char candidate[PM_MAX_PATH];
  size_t directory_length;

  if (attached_project == NULL || attached_project[0] == '\0' || routing_file == NULL || routing_file[0] == '\0') {
    return -1;
  }

  slash = strrchr(routing_file, '/');
  if (slash == NULL) {
    return -1;
  }

  directory_length = (size_t)(slash - routing_file);
  if (directory_length == 0 || directory_length >= sizeof(directory)) {
    return -1;
  }

  memcpy(directory, routing_file, directory_length);
  directory[directory_length] = '\0';
  snprintf(candidate, sizeof(candidate), "%s/compose-overrides/%s.ports.override.yaml", directory, attached_project);

  if (access(candidate, R_OK) != 0) {
    return -1;
  }

  pm_copy(buffer, size, candidate);
  return 0;
}

static int pm_compose_option_takes_value(const char *arg) {
  return strcmp(arg, "-f") == 0 || strcmp(arg, "--file") == 0 ||
         strcmp(arg, "-p") == 0 || strcmp(arg, "--project-name") == 0 ||
         strcmp(arg, "--profile") == 0 || strcmp(arg, "--env-file") == 0 ||
         strcmp(arg, "--project-directory") == 0 || strcmp(arg, "--parallel") == 0 ||
         strcmp(arg, "--progress") == 0 || strcmp(arg, "--ansi") == 0;
}

static int pm_compose_option_is_assignment(const char *arg) {
  const char *options[] = {
    "-f", "--file=", "-p", "--project-name=", "--profile=", "--env-file=", "--project-directory=",
    "--parallel=", "--progress=", "--ansi=", NULL,
  };

  for (int index = 0; options[index] != NULL; index++) {
    size_t length = strlen(options[index]);
    if (strncmp(arg, options[index], length) == 0 && arg[length] != '\0') {
      return 1;
    }
  }

  return 0;
}

static int pm_compose_option_is_flag(const char *arg) {
  return strcmp(arg, "--compatibility") == 0 || strcmp(arg, "--dry-run") == 0 ||
         strcmp(arg, "--verbose") == 0 || strcmp(arg, "--help") == 0 ||
         strcmp(arg, "-h") == 0 || strcmp(arg, "--all-resources") == 0;
}

static int pm_compose_subcommand_index(int argc, char **argv, int command_index, int standalone_compose) {
  int skip_next = 0;
  int start = standalone_compose ? 1 : command_index + 1;

  if (start < 1) {
    start = 1;
  }

  for (int index = start; index < argc; index++) {
    const char *arg = argv[index];

    if (skip_next) {
      skip_next = 0;
      continue;
    }

    if (pm_compose_option_takes_value(arg)) {
      skip_next = 1;
      continue;
    }

    if (pm_compose_option_is_assignment(arg) || pm_compose_option_is_flag(arg)) {
      continue;
    }

    if (arg[0] == '-') {
      continue;
    }

    return index;
  }

  return argc;
}

static const char *pm_find_json_key(const char *json, const char *key) {
  char pattern[128];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  return strstr(json, pattern);
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

static int pm_extract_project_from_process_name(const char *process_name, char *buffer, size_t size) {
  const char *separator;
  size_t project_length;

  if (process_name == NULL || process_name[0] == '\0' || size == 0) {
    return -1;
  }

  separator = strchr(process_name, ':');
  if (separator == NULL) {
    return -1;
  }

  project_length = (size_t)(separator - process_name);
  if (project_length == 0 || project_length >= size) {
    return -1;
  }

  memcpy(buffer, process_name, project_length);
  buffer[project_length] = '\0';
  return 0;
}

static int pm_extract_project_service_from_process_name(
  const char *process_name,
  char *project,
  size_t project_size,
  char *service,
  size_t service_size
) {
  const char *project_separator;
  const char *service_end;
  size_t project_length;
  size_t service_length;

  if (process_name == NULL || process_name[0] == '\0' || project_size == 0 || service_size == 0) {
    return -1;
  }

  project_separator = strchr(process_name, ':');
  if (project_separator == NULL || project_separator == process_name || project_separator[1] == '\0') {
    return -1;
  }

  service_end = strchr(project_separator + 1, '/');
  if (service_end == NULL) {
    service_end = process_name + strlen(process_name);
  }

  project_length = (size_t)(project_separator - process_name);
  service_length = (size_t)(service_end - (project_separator + 1));
  if (project_length == 0 || project_length >= project_size || service_length == 0 || service_length >= service_size) {
    return -1;
  }

  memcpy(project, process_name, project_length);
  project[project_length] = '\0';
  memcpy(service, project_separator + 1, service_length);
  service[service_length] = '\0';
  return 0;
}

static int pm_read_file_limited(const char *path, char **buffer_out) {
  FILE *file;
  long size;
  char *buffer;

  *buffer_out = NULL;
  if (path == NULL || path[0] == '\0') {
    return -1;
  }

  file = fopen(path, "r");
  if (file == NULL) {
    return -1;
  }

  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return -1;
  }

  size = ftell(file);
  if (size <= 0 || size > 1024 * 1024 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return -1;
  }

  buffer = malloc((size_t)size + 1);
  if (buffer == NULL) {
    fclose(file);
    return -1;
  }

  if (fread(buffer, 1, (size_t)size, file) != (size_t)size) {
    free(buffer);
    fclose(file);
    return -1;
  }

  fclose(file);
  buffer[size] = '\0';
  *buffer_out = buffer;
  return 0;
}

static int pm_route_network_matches(const char *route_json, const char *network_id) {
  char route_network[PM_MAX_FIELD];

  if (network_id == NULL || network_id[0] == '\0') {
    return 1;
  }

  if (pm_json_string(route_json, "networkId", route_network, sizeof(route_network)) != 0) {
    return 0;
  }

  return strcmp(route_network, network_id) == 0;
}

static int pm_find_compose_route_from_route_table(
  const char *runtime,
  char *attached_project,
  size_t attached_size,
  char *original_project,
  size_t original_size
) {
  const char *route_file = pm_effective_route_table_path();
  const char *network_id = pm_network_id();
  char *buffer;
  char *cursor;
  char selected_project[PM_MAX_FIELD] = "";
  int found = 0;

  (void)runtime;
  if (pm_read_file_limited(route_file, &buffer) != 0) {
    return -1;
  }

  cursor = buffer;
  while ((cursor = strstr(cursor, "\"source\"")) != NULL) {
    char *object_start = cursor;
    char *object_end = strchr(cursor, '}');
    char object_end_saved;
    char source[64];
    char route_cwd[PM_MAX_PATH];
    char process_name[PM_MAX_FIELD];
    char project_name[PM_MAX_FIELD];

    while (object_start > buffer && *object_start != '{') {
      object_start--;
    }

    if (object_end == NULL) {
      break;
    }

    object_end_saved = *object_end;
    *object_end = '\0';

    if (
      pm_json_string(object_start, "source", source, sizeof(source)) == 0 &&
      strcmp(source, "compose") == 0 &&
      pm_route_network_matches(object_start, network_id) &&
      pm_json_string(object_start, "cwd", route_cwd, sizeof(route_cwd)) == 0 &&
      pm_current_cwd_matches_route_cwd(route_cwd) &&
      pm_json_string(object_start, "processName", process_name, sizeof(process_name)) == 0 &&
      pm_extract_project_from_process_name(process_name, project_name, sizeof(project_name)) == 0
    ) {
      if (selected_project[0] != '\0' && strcmp(selected_project, project_name) != 0) {
        *object_end = object_end_saved;
        free(buffer);
        return -1;
      }

      pm_copy(selected_project, sizeof(selected_project), project_name);
      found = 1;
    }

    *object_end = object_end_saved;
    cursor = object_end + 1;
  }

  free(buffer);
  if (!found || selected_project[0] == '\0') {
    return -1;
  }

  pm_copy(attached_project, attached_size, selected_project);
  if (original_size > 0) {
    original_project[0] = '\0';
  }
  return 0;
}

typedef struct {
  const char *runtime;
  const char *network_id;
  char requested_project[PM_MAX_FIELD];
  int argc;
  char **argv;
  char *attached_project;
  size_t attached_size;
  char *original_project;
  size_t original_size;
  size_t best_length;
  int context_found;
  int project_match_count;
  char project_attached[PM_MAX_FIELD];
  char project_original[PM_MAX_FIELD];
  int found;
} pm_compose_route_search;

/** Scans one compose-specific TSV and updates the best cwd/file match. */
static int pm_find_compose_route_in_file(const char *file_path, void *context) {
  pm_compose_route_search *search = (pm_compose_route_search *)context;
  FILE *file;
  char *line = NULL;
  size_t line_capacity = 0;

  if (file_path == NULL || file_path[0] == '\0' || search == NULL) {
    return -1;
  }

  file = fopen(file_path, "r");
  if (file == NULL) {
    return -1;
  }

  while (getline(&line, &line_capacity, file) >= 0) {
    pm_route_row row;
    size_t workdir_length;
    int row_matches = 0;

    if (!pm_parse_route_row(line, &row)) {
      continue;
    }

    if (strcmp(row.network_id, search->network_id) != 0 || strcmp(row.runtime, search->runtime) != 0) {
      continue;
    }

    workdir_length = strlen(row.workdir);
    if (strcmp(row.kind, "project") == 0 && pm_cwd_matches_workdir(row.workdir)) {
      row_matches = 1;
    } else if (strcmp(row.kind, "file") == 0 && pm_argv_references_compose_file(search->argc, search->argv, row.workdir)) {
      row_matches = 1;
    }

    if (row_matches && workdir_length >= search->best_length) {
      search->best_length = workdir_length;
      pm_copy(search->attached_project, search->attached_size, row.project_or_original_id);
      pm_copy(search->original_project, search->original_size, row.original_name);
      search->context_found = 1;
      search->found = search->attached_project[0] != '\0';
    } else if (strcmp(row.kind, "project") == 0 &&
               search->requested_project[0] != '\0' &&
               (strcmp(search->requested_project, row.original_name) == 0 ||
                strcmp(search->requested_project, row.project_or_original_id) == 0)) {
      search->project_match_count++;
      pm_copy(search->project_attached, sizeof(search->project_attached), row.project_or_original_id);
      pm_copy(search->project_original, sizeof(search->project_original), row.original_name);
    }
  }

  free(line);
  fclose(file);
  return 0;
}

/** Finds the most-specific attached compose project for cwd, compose file, runtime, and network. */
static int pm_find_compose_route(const char *runtime, int argc, char **argv, char *attached_project, size_t attached_size, char *original_project, size_t original_size) {
  const char *file_path = getenv(PM_COMPOSE_ROUTING_FILE_ENV);
  const char *network_id = pm_network_id();
  pm_compose_route_search search;
  int scoped_file_count = 0;

  if (file_path == NULL || file_path[0] == '\0' || network_id == NULL || network_id[0] == '\0') {
    return pm_find_compose_route_from_route_table(runtime, attached_project, attached_size, original_project, original_size);
  }

  memset(&search, 0, sizeof(search));
  search.runtime = runtime;
  search.network_id = network_id;
  (void)pm_compose_requested_project_name(argc, argv, search.requested_project, sizeof(search.requested_project));
  search.argc = argc;
  search.argv = argv;
  search.attached_project = attached_project;
  search.attached_size = attached_size;
  search.original_project = original_project;
  search.original_size = original_size;

  pm_visit_scoped_compose_routing_files(file_path, pm_find_compose_route_in_file, &search, &scoped_file_count);
  if (scoped_file_count == 0) {
    pm_find_compose_route_in_file(file_path, &search);
  }

  if (!search.context_found && search.project_match_count == 1 && search.project_attached[0] != '\0') {
    pm_copy(attached_project, attached_size, search.project_attached);
    pm_copy(original_project, original_size, search.project_original);
    return 0;
  }

  return search.found ? 0 : pm_find_compose_route_from_route_table(runtime, attached_project, attached_size, original_project, original_size);
}

/** Allocates one rewritten compose project option argument. */
static char *pm_replace_project_option_value(const char *prefix, const char *attached_project) {
  size_t prefix_length = strlen(prefix);
  size_t project_length = strlen(attached_project);
  char *value = malloc(prefix_length + project_length + 1);

  if (value == NULL) {
    return NULL;
  }

  memcpy(value, prefix, prefix_length);
  memcpy(value + prefix_length, attached_project, project_length + 1);
  return value;
}

/** Copies argv while forcing project and generated override selection into the attached network project. */
static char **pm_rewrite_compose_args(
  const char *real_runtime_path,
  int argc,
  char **argv,
  const char *attached_project,
  const char *override_file,
  int command_index,
  int standalone_compose
) {
  int insert_override = override_file != NULL && override_file[0] != '\0' &&
                        !pm_argv_references_compose_file(argc, argv, override_file);
  int override_index = insert_override ? pm_compose_subcommand_index(argc, argv, command_index, standalone_compose) : -1;
  char **next_argv = calloc((size_t)argc + (insert_override ? 3 : 1), sizeof(char *));
  int rewrite_next = 0;
  int out_index = 1;

  if (next_argv == NULL) {
    return NULL;
  }

  next_argv[0] = (char *)real_runtime_path;
  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];

    if (insert_override && index == override_index) {
      next_argv[out_index++] = "-f";
      next_argv[out_index] = strdup(override_file);
      if (next_argv[out_index] == NULL) {
        free(next_argv);
        return NULL;
      }
      out_index++;
    }

    if (rewrite_next) {
      next_argv[out_index] = strdup(attached_project);
      if (next_argv[out_index] == NULL) {
        free(next_argv);
        return NULL;
      }
      out_index++;
      rewrite_next = 0;
      continue;
    }

    if (strcmp(arg, "-p") == 0 || strcmp(arg, "--project-name") == 0) {
      next_argv[out_index++] = argv[index];
      rewrite_next = 1;
      continue;
    }

    if (strncmp(arg, "--project-name=", 15) == 0) {
      next_argv[out_index] = pm_replace_project_option_value("--project-name=", attached_project);
      if (next_argv[out_index] == NULL) {
        free(next_argv);
        return NULL;
      }
      out_index++;
      continue;
    }

    if (strncmp(arg, "-p", 2) == 0 && arg[2] != '\0') {
      next_argv[out_index] = pm_replace_project_option_value("-p", attached_project);
      if (next_argv[out_index] == NULL) {
        free(next_argv);
        return NULL;
      }
      out_index++;
      continue;
    }

    next_argv[out_index++] = argv[index];
  }

  if (insert_override && override_index == argc) {
    next_argv[out_index++] = "-f";
    next_argv[out_index] = strdup(override_file);
    if (next_argv[out_index] == NULL) {
      free(next_argv);
      return NULL;
    }
    out_index++;
  }

  next_argv[out_index] = NULL;
  return next_argv;
}

/** Copies argv without changing user arguments. */
static char **pm_copy_runtime_args(const char *real_runtime_path, int argc, char **argv) {
  char **next_argv = calloc((size_t)argc + 1, sizeof(char *));

  if (next_argv == NULL) {
    return NULL;
  }

  next_argv[0] = (char *)real_runtime_path;
  for (int index = 1; index < argc; index++) {
    next_argv[index] = argv[index];
  }
  next_argv[argc] = NULL;
  return next_argv;
}

/** Identifies Docker commands where an argv token may be a container reference. */
static int pm_runtime_command_may_reference_container(int argc, char **argv, int command_index) {
  const char *command;
  const char *container_commands =
    "|attach|commit|cp|diff|exec|export|inspect|kill|logs|pause|port|rename|restart|rm|start|stats|stop|top|unpause|update|wait|";
  char lookup[64];

  if (command_index < 0 || command_index >= argc) {
    return 0;
  }

  command = argv[command_index];
  if (strcmp(command, "container") == 0) {
    for (int index = command_index + 1; index < argc; index++) {
      if (argv[index][0] == '-') {
        continue;
      }
      command = argv[index];
      break;
    }
  }

  snprintf(lookup, sizeof(lookup), "|%s|", command);
  return strstr(container_commands, lookup) != NULL;
}

/** Prefix comparison supports Docker's short container hash input. */
static int pm_has_prefix(const char *value, const char *prefix) {
  size_t prefix_length = strlen(prefix);
  return strncmp(value, prefix, prefix_length) == 0;
}

/**
 * Captures small Docker metadata queries without entering the shell.
 *
 * Container hash fallback only needs labels and ids. Running the real Docker
 * binary directly keeps this shim independent from project shell functions and
 * prevents PATH recursion through Port Manager's own runtime aliases.
 */
static int pm_run_capture(char *const argv[], char *buffer, size_t size) {
  int pipe_fds[2];
  pid_t child;
  size_t used = 0;
  int status = 0;

  if (argv == NULL || argv[0] == NULL || buffer == NULL || size == 0) {
    return -1;
  }

  buffer[0] = '\0';
  if (pipe(pipe_fds) != 0) {
    return -1;
  }

  child = fork();
  if (child < 0) {
    close(pipe_fds[0]);
    close(pipe_fds[1]);
    return -1;
  }

  if (child == 0) {
    int dev_null;

    close(pipe_fds[0]);
    if (dup2(pipe_fds[1], STDOUT_FILENO) < 0) {
      _exit(127);
    }
    close(pipe_fds[1]);

    dev_null = open("/dev/null", O_WRONLY);
    if (dev_null >= 0) {
      (void)dup2(dev_null, STDERR_FILENO);
      close(dev_null);
    }

    execv(argv[0], argv);
    _exit(127);
  }

  close(pipe_fds[1]);
  while (used + 1 < size) {
    ssize_t bytes = read(pipe_fds[0], buffer + used, size - used - 1);
    if (bytes < 0) {
      if (errno == EINTR) {
        continue;
      }
      close(pipe_fds[0]);
      (void)waitpid(child, &status, 0);
      buffer[used] = '\0';
      return -1;
    }
    if (bytes == 0) {
      break;
    }
    used += (size_t)bytes;
  }

  close(pipe_fds[0]);
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) {
      buffer[used] = '\0';
      return -1;
    }
  }

  buffer[used] = '\0';
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

static int pm_first_nonempty_output_line(char *output, char **line_out) {
  char *cursor = output;

  *line_out = NULL;
  while (cursor != NULL && *cursor != '\0') {
    char *line = cursor;
    char *newline = strchr(cursor, '\n');

    if (newline != NULL) {
      *newline = '\0';
      cursor = newline + 1;
    } else {
      cursor = NULL;
    }

    pm_trim_line_end(line);
    if (line[0] == '\0') {
      continue;
    }

    if (*line_out != NULL) {
      return -1;
    }

    *line_out = line;
  }

  return *line_out == NULL ? -1 : 0;
}

static int pm_split_tab_fields(char *line, char **fields, int max_fields) {
  char *cursor = line;
  int count = 0;

  while (count < max_fields) {
    fields[count++] = cursor;
    cursor = strchr(cursor, '\t');
    if (cursor == NULL) {
      break;
    }
    *cursor = '\0';
    cursor++;
  }

  return count;
}

static int pm_inspect_compose_container_service(
  const char *real_runtime_path,
  const char *token,
  char *service,
  size_t service_size
) {
  char output[8192];
  char *line;
  char *fields[4] = {0};
  char *argv[] = {
    (char *)real_runtime_path,
    "inspect",
    "--format",
    "{{.ID}}\t{{.Name}}\t{{index .Config.Labels \"com.docker.compose.project\"}}\t{{index .Config.Labels \"com.docker.compose.service\"}}",
    (char *)token,
    NULL,
  };

  if (service_size == 0 || pm_run_capture(argv, output, sizeof(output)) != 0 ||
      pm_first_nonempty_output_line(output, &line) != 0 ||
      pm_split_tab_fields(line, fields, 4) < 4 ||
      fields[3] == NULL || fields[3][0] == '\0' || strcmp(fields[3], "<no value>") == 0) {
    return -1;
  }

  pm_copy(service, service_size, fields[3]);
  return 0;
}

static int pm_find_compose_project_for_service_from_route_table(
  const char *service,
  char *attached_project,
  size_t attached_size
) {
  const char *route_file = pm_effective_route_table_path();
  const char *network_id = pm_network_id();
  char *buffer;
  char *cursor;
  char selected_project[PM_MAX_FIELD] = "";
  int found = 0;

  if (service == NULL || service[0] == '\0' || pm_read_file_limited(route_file, &buffer) != 0) {
    return -1;
  }

  cursor = buffer;
  while ((cursor = strstr(cursor, "\"source\"")) != NULL) {
    char *object_start = cursor;
    char *object_end = strchr(cursor, '}');
    char object_end_saved;
    char source[64];
    char route_cwd[PM_MAX_PATH];
    char process_name[PM_MAX_FIELD];
    char project_name[PM_MAX_FIELD];
    char service_name[PM_MAX_FIELD];

    while (object_start > buffer && *object_start != '{') {
      object_start--;
    }

    if (object_end == NULL) {
      break;
    }

    object_end_saved = *object_end;
    *object_end = '\0';

    if (
      pm_json_string(object_start, "source", source, sizeof(source)) == 0 &&
      strcmp(source, "compose") == 0 &&
      pm_route_network_matches(object_start, network_id) &&
      pm_json_string(object_start, "cwd", route_cwd, sizeof(route_cwd)) == 0 &&
      pm_current_cwd_matches_route_cwd(route_cwd) &&
      pm_json_string(object_start, "processName", process_name, sizeof(process_name)) == 0 &&
      pm_extract_project_service_from_process_name(process_name, project_name, sizeof(project_name), service_name, sizeof(service_name)) == 0 &&
      strcmp(service_name, service) == 0
    ) {
      if (selected_project[0] != '\0' && strcmp(selected_project, project_name) != 0) {
        *object_end = object_end_saved;
        free(buffer);
        return -1;
      }

      pm_copy(selected_project, sizeof(selected_project), project_name);
      found = 1;
    }

    *object_end = object_end_saved;
    cursor = object_end + 1;
  }

  free(buffer);
  if (!found || selected_project[0] == '\0') {
    return -1;
  }

  pm_copy(attached_project, attached_size, selected_project);
  return 0;
}

/** True when a compose-specific TSV belongs to the current cwd or compose-file args. */
static int pm_compose_routing_file_matches_context(
  const char *file_path,
  const char *runtime,
  const char *network_id,
  int argc,
  char **argv
) {
  FILE *file;
  char *line = NULL;
  size_t line_capacity = 0;
  char requested_project[PM_MAX_FIELD] = "";
  int matches = 0;

  if (file_path == NULL || runtime == NULL || network_id == NULL) {
    return 0;
  }

  (void)pm_compose_requested_project_name(argc, argv, requested_project, sizeof(requested_project));

  file = fopen(file_path, "r");
  if (file == NULL) {
    return 0;
  }

  while (getline(&line, &line_capacity, file) >= 0) {
    pm_route_row row;

    if (!pm_parse_route_row(line, &row) ||
        strcmp(row.network_id, network_id) != 0 ||
        strcmp(row.runtime, runtime) != 0) {
      continue;
    }

    if ((strcmp(row.kind, "project") == 0 && pm_cwd_matches_workdir(row.workdir)) ||
        (strcmp(row.kind, "file") == 0 && pm_argv_references_compose_file(argc, argv, row.workdir))) {
      matches = 1;
      break;
    }

    if (strcmp(row.kind, "project") == 0 &&
        requested_project[0] != '\0' &&
        (strcmp(requested_project, row.original_name) == 0 ||
         strcmp(requested_project, row.project_or_original_id) == 0)) {
      matches = 1;
      break;
    }
  }

  free(line);
  fclose(file);
  return matches;
}

typedef struct {
  const char *runtime;
  const char *network_id;
  const char *token;
  const char *suffix;
  size_t token_length;
  int argc;
  char **argv;
  int require_context;
  int context_files;
  int matches;
  char target[PM_MAX_FIELD];
} pm_container_target_search;

/** Scans one compose-specific TSV for a unique container token rewrite. */
static int pm_container_target_scan_file(const char *file_path, void *context) {
  pm_container_target_search *search = (pm_container_target_search *)context;
  FILE *file;
  char *line = NULL;
  size_t line_capacity = 0;

  if (file_path == NULL || search == NULL) {
    return -1;
  }

  if (search->require_context &&
      !pm_compose_routing_file_matches_context(file_path, search->runtime, search->network_id, search->argc, search->argv)) {
    return 0;
  }

  if (search->require_context) {
    search->context_files++;
  }

  file = fopen(file_path, "r");
  if (file == NULL) {
    return -1;
  }

  while (getline(&line, &line_capacity, file) >= 0) {
    pm_route_row row;
    int matched = 0;

    if (!pm_parse_route_row(line, &row) || strcmp(row.kind, "container") != 0) {
      continue;
    }

    if (strcmp(row.network_id, search->network_id) != 0 || strcmp(row.runtime, search->runtime) != 0) {
      continue;
    }

    if (strcmp(search->token, row.original_name) == 0 ||
        strcmp(search->token, row.attached_name) == 0 ||
        strcmp(search->token, row.service_name) == 0) {
      matched = 1;
    } else if (search->token_length >= 4 &&
               (pm_has_prefix(row.project_or_original_id, search->token) ||
                pm_has_prefix(search->token, row.project_or_original_id) ||
                pm_has_prefix(row.attached_id, search->token) ||
                pm_has_prefix(search->token, row.attached_id))) {
      matched = 1;
    }

    if (matched) {
      search->matches++;
      snprintf(search->target, sizeof(search->target), "%s%s", row.attached_id, search->suffix == NULL ? "" : search->suffix);
    }
  }

  free(line);
  fclose(file);
  return 0;
}

static int pm_lookup_single_compose_container(
  const char *real_runtime_path,
  const char *attached_project,
  const char *service,
  int include_stopped,
  char *container_id,
  size_t container_size
) {
  char output[8192];
  char *line;
  char project_filter[PM_MAX_FIELD + 64];
  char service_filter[PM_MAX_FIELD + 64];
  char *running_argv[] = {
    (char *)real_runtime_path,
    "container",
    "ls",
    "--no-trunc",
    "--filter",
    project_filter,
    "--filter",
    service_filter,
    "--format",
    "{{.ID}}",
    NULL,
  };
  char *all_argv[] = {
    (char *)real_runtime_path,
    "container",
    "ls",
    "-a",
    "--no-trunc",
    "--filter",
    project_filter,
    "--filter",
    service_filter,
    "--format",
    "{{.ID}}",
    NULL,
  };

  snprintf(project_filter, sizeof(project_filter), "label=com.docker.compose.project=%s", attached_project);
  snprintf(service_filter, sizeof(service_filter), "label=com.docker.compose.service=%s", service);

  if (pm_run_capture(include_stopped ? all_argv : running_argv, output, sizeof(output)) != 0 ||
      pm_first_nonempty_output_line(output, &line) != 0) {
    return -1;
  }

  pm_copy(container_id, container_size, line);
  return 0;
}

static char *pm_container_target_from_route_table(
  const char *runtime,
  const char *real_runtime_path,
  const char *token,
  const char *suffix
) {
  char service[PM_MAX_FIELD];
  char attached_project[PM_MAX_FIELD];
  char attached_id[PM_MAX_FIELD];
  char target[PM_MAX_FIELD];

  (void)runtime;
  if (pm_inspect_compose_container_service(real_runtime_path, token, service, sizeof(service)) != 0 ||
      pm_find_compose_project_for_service_from_route_table(service, attached_project, sizeof(attached_project)) != 0 ||
      (pm_lookup_single_compose_container(real_runtime_path, attached_project, service, 0, attached_id, sizeof(attached_id)) != 0 &&
       pm_lookup_single_compose_container(real_runtime_path, attached_project, service, 1, attached_id, sizeof(attached_id)) != 0)) {
    return NULL;
  }

  snprintf(target, sizeof(target), "%s%s", attached_id, suffix == NULL ? "" : suffix);
  return strdup(target);
}

/** Maps one container token, including cp's container:path suffix, when it is unambiguous. */
static char *pm_container_target_for_token(
  const char *runtime,
  const char *real_runtime_path,
  const char *token,
  int argc,
  char **argv
) {
  const char *file_path = getenv(PM_COMPOSE_ROUTING_FILE_ENV);
  const char *network_id = pm_network_id();
  char token_copy[PM_MAX_FIELD];
  char suffix[PM_MAX_FIELD] = "";
  char *colon;
  size_t token_length;
  pm_container_target_search search;
  int scoped_file_count = 0;

  if (token == NULL || token[0] == '\0') {
    return NULL;
  }

  pm_copy(token_copy, sizeof(token_copy), token);
  colon = strchr(token_copy, ':');
  if (colon != NULL) {
    pm_copy(suffix, sizeof(suffix), colon);
    *colon = '\0';
  }
  token_length = strlen(token_copy);

  if (token_length == 0) {
    return NULL;
  }

  if (file_path == NULL || file_path[0] == '\0' || network_id == NULL || network_id[0] == '\0') {
    return pm_container_target_from_route_table(runtime, real_runtime_path, token_copy, suffix);
  }

  memset(&search, 0, sizeof(search));
  search.runtime = runtime;
  search.network_id = network_id;
  search.token = token_copy;
  search.suffix = suffix;
  search.token_length = token_length;
  search.argc = argc;
  search.argv = argv;
  search.require_context = 1;

  pm_visit_scoped_compose_routing_files(file_path, pm_container_target_scan_file, &search, &scoped_file_count);
  if (scoped_file_count > 0 && search.context_files > 0) {
    if (search.matches == 1 && search.target[0] != '\0') {
      return strdup(search.target);
    }
    return pm_container_target_from_route_table(runtime, real_runtime_path, token_copy, suffix);
  }

  if (scoped_file_count > 0) {
    memset(&search, 0, sizeof(search));
    search.runtime = runtime;
    search.network_id = network_id;
    search.token = token_copy;
    search.suffix = suffix;
    search.token_length = token_length;
    search.argc = argc;
    search.argv = argv;
    search.require_context = 0;
    pm_visit_scoped_compose_routing_files(file_path, pm_container_target_scan_file, &search, NULL);
  } else {
    search.require_context = 0;
    search.context_files = 0;
    search.matches = 0;
    search.target[0] = '\0';
    pm_container_target_scan_file(file_path, &search);
  }

  if (search.matches == 1 && search.target[0] != '\0') {
    return strdup(search.target);
  }

  return pm_container_target_from_route_table(runtime, real_runtime_path, token_copy, suffix);
}

/** Creates argv for execv, rewriting only tokens that uniquely identify cloned containers. */
static char **pm_rewrite_container_args(const char *runtime, const char *real_runtime_path, int argc, char **argv) {
  char **next_argv = calloc((size_t)argc + 1, sizeof(char *));

  if (next_argv == NULL) {
    return NULL;
  }

  next_argv[0] = (char *)real_runtime_path;
  for (int index = 1; index < argc; index++) {
    char *target = pm_container_target_for_token(runtime, real_runtime_path, argv[index], argc, argv);
    next_argv[index] = target == NULL ? argv[index] : target;
  }
  next_argv[argc] = NULL;
  return next_argv;
}

/** Derives route runtime and executable name from the symlink used to enter the shim. */
static int pm_resolve_invocation(char **argv, char *runtime, size_t runtime_size, char *executable, size_t executable_size, int *standalone_compose) {
  const char *name = pm_basename(argv[0]);
  const char *override = getenv("PORT_MANAGER_DOCKER_SHIM_RUNTIME");

  *standalone_compose = 0;

  if (name != NULL && (strcmp(name, "docker") == 0 || strcmp(name, "podman") == 0)) {
    pm_copy(runtime, runtime_size, name);
    pm_copy(executable, executable_size, name);
    return 0;
  }

  if (name != NULL && strcmp(name, "docker-compose") == 0) {
    pm_copy(runtime, runtime_size, "docker");
    pm_copy(executable, executable_size, "docker-compose");
    *standalone_compose = 1;
    return 0;
  }

  if (name != NULL && strcmp(name, "podman-compose") == 0) {
    pm_copy(runtime, runtime_size, "podman");
    pm_copy(executable, executable_size, "podman-compose");
    *standalone_compose = 1;
    return 0;
  }

  if (override != NULL && (strcmp(override, "docker") == 0 || strcmp(override, "podman") == 0)) {
    pm_copy(runtime, runtime_size, override);
    pm_copy(executable, executable_size, override);
    return 0;
  }

  return -1;
}

int main(int argc, char **argv) {
  char runtime[PM_MAX_RUNTIME];
  char runtime_executable[PM_MAX_RUNTIME];
  char real_runtime_path[PM_MAX_PATH];
  char attached_project[PM_MAX_FIELD];
  char original_project[PM_MAX_FIELD];
  char override_file[PM_MAX_PATH];
  char **next_argv;
  char *clean_path;
  int command_index;
  int standalone_compose;

  if (pm_resolve_invocation(argv, runtime, sizeof(runtime), runtime_executable, sizeof(runtime_executable), &standalone_compose) != 0) {
    fprintf(stderr, "portmanager-docker-shim: invoke through docker, podman, docker-compose, or podman-compose symlink\n");
    return 127;
  }

  if (pm_find_runtime_on_path(runtime_executable, real_runtime_path, sizeof(real_runtime_path)) != 0) {
    fprintf(stderr, "portmanager-docker-shim: could not resolve real %s on PATH\n", runtime_executable);
    return 127;
  }

  clean_path = pm_path_without_shim_directory();
  if (clean_path != NULL) {
    setenv("PATH", clean_path, 1);
    free(clean_path);
  }

  command_index = pm_first_command_index(argc, argv);
  if (standalone_compose || (command_index >= 0 && strcmp(argv[command_index], "compose") == 0)) {
    if (pm_find_compose_route(runtime, argc, argv, attached_project, sizeof(attached_project), original_project, sizeof(original_project)) == 0) {
      override_file[0] = '\0';
      (void)pm_compose_override_for_project(attached_project, override_file, sizeof(override_file));

      setenv("COMPOSE_PROJECT_NAME", attached_project, 1);
      next_argv = pm_rewrite_compose_args(
        real_runtime_path,
        argc,
        argv,
        attached_project,
        override_file,
        command_index,
        standalone_compose
      );
    } else {
      next_argv = pm_copy_runtime_args(real_runtime_path, argc, argv);
    }
  } else if (command_index >= 0 && strcmp(argv[command_index], "compose") != 0 &&
      pm_runtime_command_may_reference_container(argc, argv, command_index)) {
    next_argv = pm_rewrite_container_args(runtime, real_runtime_path, argc, argv);
  } else {
    next_argv = pm_copy_runtime_args(real_runtime_path, argc, argv);
  }

  if (next_argv == NULL) {
    fprintf(stderr, "portmanager-docker-shim: allocation failed\n");
    return 127;
  }

  execv(real_runtime_path, next_argv);
  fprintf(stderr, "portmanager-docker-shim: failed to execute %s: %s\n", real_runtime_path, strerror(errno));
  return 127;
}

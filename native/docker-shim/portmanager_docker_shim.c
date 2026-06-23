#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

typedef struct {
  char kind[16];
  char network_id[PM_MAX_FIELD];
  char runtime[PM_MAX_RUNTIME];
  char workdir[PM_MAX_PATH];
  char project_or_original_id[PM_MAX_FIELD];
  char original_name[PM_MAX_FIELD];
  char attached_id[PM_MAX_FIELD];
  char attached_name[PM_MAX_FIELD];
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

/** Returns true when argv itself contains a compose project option. */
static int pm_compose_argv_has_project(int argc, char **argv) {
  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];

    if (strcmp(arg, "-p") == 0 || strcmp(arg, "--project-name") == 0 ||
        strncmp(arg, "-p", 2) == 0 || strncmp(arg, "--project-name=", 15) == 0) {
      return 1;
    }
  }

  return 0;
}

/** Explicit compose project selections include either argv or environment state. */
static int pm_compose_args_have_project(int argc, char **argv) {
  const char *compose_project_name = getenv("COMPOSE_PROJECT_NAME");

  return (compose_project_name != NULL && compose_project_name[0] != '\0') || pm_compose_argv_has_project(argc, argv);
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

  return network_id;
}

/** Splits one tab-separated route row written by serializeComposeProjectRoutingRows. */
static int pm_parse_route_row(char *line, pm_route_row *row) {
  char *fields[8] = {0};
  char *cursor = line;

  for (int index = 0; index < 8; index++) {
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
  pm_trim_line_end(row->kind);
  pm_trim_line_end(row->network_id);
  pm_trim_line_end(row->runtime);
  pm_trim_line_end(row->workdir);
  pm_trim_line_end(row->project_or_original_id);
  pm_trim_line_end(row->original_name);
  pm_trim_line_end(row->attached_id);
  pm_trim_line_end(row->attached_name);

  return row->kind[0] != '\0';
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

/** Finds the most-specific attached compose project for the current cwd/runtime/network. */
static int pm_find_compose_route(const char *runtime, char *attached_project, size_t attached_size, char *original_project, size_t original_size) {
  const char *file_path = getenv(PM_COMPOSE_ROUTING_FILE_ENV);
  const char *network_id = pm_network_id();
  FILE *file;
  char *line = NULL;
  size_t line_capacity = 0;
  size_t best_length = 0;
  int found = 0;

  if (file_path == NULL || file_path[0] == '\0' || network_id == NULL || network_id[0] == '\0') {
    return -1;
  }

  file = fopen(file_path, "r");
  if (file == NULL) {
    return -1;
  }

  while (getline(&line, &line_capacity, file) >= 0) {
    pm_route_row row;
    size_t workdir_length;

    if (!pm_parse_route_row(line, &row) || strcmp(row.kind, "project") != 0) {
      continue;
    }

    if (strcmp(row.network_id, network_id) != 0 || strcmp(row.runtime, runtime) != 0) {
      continue;
    }

    workdir_length = strlen(row.workdir);
    if (pm_cwd_matches_workdir(row.workdir) && workdir_length >= best_length) {
      best_length = workdir_length;
      pm_copy(attached_project, attached_size, row.project_or_original_id);
      pm_copy(original_project, original_size, row.original_name);
      found = attached_project[0] != '\0';
    }
  }

  free(line);
  fclose(file);
  return found ? 0 : -1;
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

/** Copies argv while replacing explicit references to the original compose project. */
static char **pm_rewrite_compose_project_args(const char *real_runtime_path, int argc, char **argv, const char *original_project, const char *attached_project) {
  char **next_argv = calloc((size_t)argc + 1, sizeof(char *));
  int rewrite_next = 0;

  if (next_argv == NULL) {
    return NULL;
  }

  next_argv[0] = (char *)real_runtime_path;
  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];

    if (rewrite_next) {
      next_argv[index] = strcmp(arg, original_project) == 0 ? strdup(attached_project) : argv[index];
      rewrite_next = 0;
      continue;
    }

    if (strcmp(arg, "-p") == 0 || strcmp(arg, "--project-name") == 0) {
      next_argv[index] = argv[index];
      rewrite_next = 1;
      continue;
    }

    if (strncmp(arg, "--project-name=", 15) == 0) {
      const char *value = arg + 15;
      next_argv[index] = strcmp(value, original_project) == 0
                           ? pm_replace_project_option_value("--project-name=", attached_project)
                           : argv[index];
      if (next_argv[index] == NULL) {
        free(next_argv);
        return NULL;
      }
      continue;
    }

    if (strncmp(arg, "-p", 2) == 0 && arg[2] != '\0') {
      const char *value = arg + 2;
      next_argv[index] = strcmp(value, original_project) == 0
                           ? pm_replace_project_option_value("-p", attached_project)
                           : argv[index];
      if (next_argv[index] == NULL) {
        free(next_argv);
        return NULL;
      }
      continue;
    }

    next_argv[index] = argv[index];
  }

  next_argv[argc] = NULL;
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

/** Maps one container token, including cp's container:path suffix, when it is unambiguous. */
static char *pm_container_target_for_token(const char *runtime, const char *token) {
  const char *file_path = getenv(PM_COMPOSE_ROUTING_FILE_ENV);
  const char *network_id = pm_network_id();
  char token_copy[PM_MAX_FIELD];
  char suffix[PM_MAX_FIELD] = "";
  char target[PM_MAX_FIELD] = "";
  char *colon;
  FILE *file;
  char *line = NULL;
  size_t line_capacity = 0;
  size_t token_length;
  int matches = 0;

  if (file_path == NULL || file_path[0] == '\0' || network_id == NULL || network_id[0] == '\0' ||
      token == NULL || token[0] == '\0') {
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

  file = fopen(file_path, "r");
  if (file == NULL) {
    return NULL;
  }

  while (getline(&line, &line_capacity, file) >= 0) {
    pm_route_row row;
    int matched = 0;

    if (!pm_parse_route_row(line, &row) || strcmp(row.kind, "container") != 0) {
      continue;
    }

    if (strcmp(row.network_id, network_id) != 0 || strcmp(row.runtime, runtime) != 0) {
      continue;
    }

    if (strcmp(token_copy, row.original_name) == 0) {
      matched = 1;
    } else if (token_length >= 4 &&
               (pm_has_prefix(row.project_or_original_id, token_copy) ||
                pm_has_prefix(token_copy, row.project_or_original_id))) {
      matched = 1;
    }

    if (matched) {
      matches++;
      snprintf(target, sizeof(target), "%s%s", row.attached_id, suffix);
    }
  }

  free(line);
  fclose(file);

  if (matches == 1 && target[0] != '\0') {
    return strdup(target);
  }

  return NULL;
}

/** Creates argv for execv, rewriting only tokens that uniquely identify cloned containers. */
static char **pm_rewrite_container_args(const char *runtime, const char *real_runtime_path, int argc, char **argv) {
  char **next_argv = calloc((size_t)argc + 1, sizeof(char *));

  if (next_argv == NULL) {
    return NULL;
  }

  next_argv[0] = (char *)real_runtime_path;
  for (int index = 1; index < argc; index++) {
    char *target = pm_container_target_for_token(runtime, argv[index]);
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
    if (pm_find_compose_route(runtime, attached_project, sizeof(attached_project), original_project, sizeof(original_project)) == 0) {
      const char *env_project = getenv("COMPOSE_PROJECT_NAME");
      int env_matches_original = env_project != NULL && original_project[0] != '\0' && strcmp(env_project, original_project) == 0;
      if (!pm_compose_args_have_project(argc, argv) || env_matches_original) {
        setenv("COMPOSE_PROJECT_NAME", attached_project, 1);
      }
      if (original_project[0] != '\0' && pm_compose_argv_has_project(argc, argv)) {
        next_argv = pm_rewrite_compose_project_args(real_runtime_path, argc, argv, original_project, attached_project);
      } else {
        next_argv = pm_copy_runtime_args(real_runtime_path, argc, argv);
      }
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

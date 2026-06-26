#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * Native launcher for asdf shim names.
 *
 * On macOS, DYLD_* variables can be stripped when a command goes through a
 * protected shebang interpreter such as /usr/bin/env bash. asdf shims are shell
 * scripts, so terminal-launched commands can lose DYLD_INSERT_LIBRARIES before
 * the real runtime starts. This executable is symlinked under the same shim
 * names, asks asdf for the concrete executable, then execs that path directly.
 * This avoids re-entering protected shebang interpreters before the final
 * runtime has a chance to load Port Manager's hook.
 */

#define PM_MAX_PATH 4096
#define PM_MAX_LINE 4096
#define PM_MAX_SCRIPT 16384
#define PM_MAX_TEXT 512
#define PM_RUNTIME_SHIM_DIR_ENV "PORT_MANAGER_RUNTIME_SHIM_DIR"

#if defined(__APPLE__)
#define PM_PRELOAD_ENV "DYLD_INSERT_LIBRARIES"
#define PM_PRELOAD_HINT_ENV "PORT_MANAGER_DYLD_INSERT_LIBRARIES"
#else
#define PM_PRELOAD_ENV "LD_PRELOAD"
#define PM_PRELOAD_HINT_ENV "PORT_MANAGER_LD_PRELOAD"
#endif

static const char *pm_basename(const char *path) {
  char *copy;
  char *name;

  if (path == NULL || path[0] == '\0') {
    return NULL;
  }

  copy = strdup(path);
  if (copy == NULL) {
    return NULL;
  }

  name = basename(copy);
  if (name == NULL || name[0] == '\0') {
    free(copy);
    return NULL;
  }

  name = strdup(name);
  free(copy);
  return name;
}

static void pm_restore_dyld(void) {
  const char *hook = getenv("PORT_MANAGER_DYLD_INSERT_LIBRARIES");
  const char *current = getenv("DYLD_INSERT_LIBRARIES");
  char *merged;
  size_t size;

  if (hook == NULL || hook[0] == '\0') {
    return;
  }

  if (current != NULL && strstr(current, hook) != NULL) {
    return;
  }

  if (current == NULL || current[0] == '\0') {
    setenv("DYLD_INSERT_LIBRARIES", hook, 1);
    return;
  }

  size = strlen(hook) + strlen(current) + 2;
  merged = malloc(size);
  if (merged == NULL) {
    return;
  }

  snprintf(merged, size, "%s:%s", hook, current);
  setenv("DYLD_INSERT_LIBRARIES", merged, 1);
  free(merged);
}

static const char *pm_network_id_from_bash_env(void) {
  const char *bash_env = getenv("BASH_ENV");
  const char *base_name;
  const char *prefix = "portmanager-bash-env-";
  const char *suffix = ".sh";
  size_t prefix_length = strlen(prefix);
  size_t suffix_length = strlen(suffix);
  size_t base_length;
  size_t network_length;
  static char network_id_from_bash_env[PM_MAX_TEXT];

  /*
   * A scoped BASH_ENV filename identifies the currently attached terminal. It
   * is more authoritative than env vars inherited from an older package manager
   * or shell process.
   */
  if (bash_env == NULL || bash_env[0] == '\0') {
    return NULL;
  }

  base_name = strrchr(bash_env, '/');
  base_name = base_name == NULL ? bash_env : base_name + 1;
  base_length = strlen(base_name);

  if (base_length <= prefix_length + suffix_length || strncmp(base_name, prefix, prefix_length) != 0) {
    return NULL;
  }

  if (strcmp(base_name + base_length - suffix_length, suffix) != 0) {
    return NULL;
  }

  network_length = base_length - prefix_length - suffix_length;
  if (network_length == 0 || network_length >= sizeof(network_id_from_bash_env)) {
    return NULL;
  }

  memcpy(network_id_from_bash_env, base_name + prefix_length, network_length);
  network_id_from_bash_env[network_length] = '\0';
  return network_id_from_bash_env;
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
  static char network_id_from_route_table[PM_MAX_TEXT];

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
  const char *routing_file = getenv("PORT_MANAGER_COMPOSE_ROUTING_FILE");
  const char *base_name;
  const char *compose_separator;
  const char *prefix = "compose-project-routing-";
  const char *suffix = ".tsv";
  size_t prefix_length = strlen(prefix);
  size_t suffix_length = strlen(suffix);
  size_t base_length;
  size_t scoped_length;
  size_t network_length;
  static char network_id_from_compose_file[PM_MAX_TEXT];

  if (routing_file == NULL || routing_file[0] == '\0') {
    return NULL;
  }

  base_name = strrchr(routing_file, '/');
  base_name = base_name == NULL ? routing_file : base_name + 1;
  base_length = strlen(base_name);

  if (base_length <= prefix_length + suffix_length || strncmp(base_name, prefix, prefix_length) != 0) {
    return NULL;
  }

  if (strcmp(base_name + base_length - suffix_length, suffix) != 0) {
    return NULL;
  }

  scoped_length = base_length - prefix_length - suffix_length;
  compose_separator = strstr(base_name + prefix_length, ".compose-");
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

static void pm_export_network_scope(const char *network_id) {
  if (network_id == NULL || network_id[0] == '\0') {
    return;
  }

  setenv("PORT_MANAGER_NETWORK_ID", network_id, 1);
  setenv("PORT_MANAGER_BORROWED_NETWORK_ID", network_id, 1);
  setenv("NEWDLOPS_PM_NETWORK_ID", network_id, 1);
  setenv("NEWDLOPS_PM_BORROWED_NETWORK_ID", network_id, 1);
}

static void pm_restore_network_scope(void) {
  const char *network_id = getenv("PORT_MANAGER_NETWORK_ID");
  const char *borrowed_network_id = getenv("PORT_MANAGER_BORROWED_NETWORK_ID");
  const char *alias_network_id = getenv("NEWDLOPS_PM_NETWORK_ID");
  const char *alias_borrowed_network_id = getenv("NEWDLOPS_PM_BORROWED_NETWORK_ID");

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = borrowed_network_id;
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = alias_network_id;
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = alias_borrowed_network_id;
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = pm_network_id_from_bash_env();
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = pm_network_id_from_compose_routing_file();
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = pm_network_id_from_route_table_path();
  }

  pm_export_network_scope(network_id);
}

static int pm_read_all(int fd, char *buffer, size_t size) {
  ssize_t count;
  size_t used = 0;

  if (size == 0) {
    return -1;
  }

  while (used + 1 < size && (count = read(fd, buffer + used, size - used - 1)) > 0) {
    used += (size_t)count;
  }

  buffer[used] = '\0';
  while (used > 0 && (buffer[used - 1] == '\n' || buffer[used - 1] == '\r' || buffer[used - 1] == ' ' || buffer[used - 1] == '\t')) {
    buffer[--used] = '\0';
  }

  return used > 0 ? 0 : -1;
}

static void pm_disable_hook_for_tool_resolution(const char *tool_name, const char *self_path);

static int pm_asdf_which(const char *tool_name, const char *self_path, char *buffer, size_t size) {
  int pipe_fds[2];
  pid_t pid;
  int status = 0;

  if (pipe(pipe_fds) != 0) {
    return -1;
  }

  pid = fork();
  if (pid < 0) {
    close(pipe_fds[0]);
    close(pipe_fds[1]);
    return -1;
  }

  if (pid == 0) {
    int devnull = open("/dev/null", O_WRONLY);
    close(pipe_fds[0]);
    dup2(pipe_fds[1], STDOUT_FILENO);
    if (devnull >= 0) {
      dup2(devnull, STDERR_FILENO);
    }
    pm_disable_hook_for_tool_resolution(tool_name, self_path);
    execlp("asdf", "asdf", "which", tool_name, (char *)NULL);
    _exit(127);
  }

  close(pipe_fds[1]);
  if (pm_read_all(pipe_fds[0], buffer, size) != 0) {
    close(pipe_fds[0]);
    waitpid(pid, &status, 0);
    return -1;
  }
  close(pipe_fds[0]);

  if (waitpid(pid, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    return -1;
  }

  return buffer[0] == '/' ? 0 : -1;
}

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

static int pm_same_directory(const char *left, const char *right) {
  char left_path[PM_MAX_PATH];
  char right_path[PM_MAX_PATH];

  if (pm_realpath_or_copy(left, left_path, sizeof(left_path)) != 0 ||
      pm_realpath_or_copy(right, right_path, sizeof(right_path)) != 0) {
    return 0;
  }

  return strcmp(left_path, right_path) == 0;
}

static int pm_same_file(const char *left, const char *right) {
  struct stat left_stat;
  struct stat right_stat;

  if (left == NULL || right == NULL || left[0] == '\0' || right[0] == '\0') {
    return 0;
  }

  if (stat(left, &left_stat) != 0 || stat(right, &right_stat) != 0) {
    return 0;
  }

  return left_stat.st_dev == right_stat.st_dev && left_stat.st_ino == right_stat.st_ino;
}

static int pm_is_executable_file(const char *path) {
  struct stat stat_buffer;

  if (stat(path, &stat_buffer) != 0 || !S_ISREG(stat_buffer.st_mode)) {
    return 0;
  }

  return access(path, X_OK) == 0;
}

static int pm_candidate_is_current_shim(const char *candidate, const char *self_path) {
  return pm_is_executable_file(candidate) && pm_same_file(candidate, self_path);
}

static char *pm_path_without_runtime_shims(const char *tool_name, const char *self_path) {
  const char *path_env = getenv("PATH");
  const char *shim_directory = getenv(PM_RUNTIME_SHIM_DIR_ENV);
  const char *cursor;
  char *result;
  size_t result_size;
  size_t used = 0;

  if (path_env == NULL || path_env[0] == '\0') {
    return NULL;
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
    char candidate[PM_MAX_PATH];
    int skip_directory = 0;

    if (directory_length == 0) {
      snprintf(directory, sizeof(directory), ".");
    } else if (directory_length >= sizeof(directory)) {
      skip_directory = 1;
    } else {
      memcpy(directory, cursor, directory_length);
      directory[directory_length] = '\0';
    }

    if (!skip_directory && shim_directory != NULL && shim_directory[0] != '\0' &&
        pm_same_directory(directory, shim_directory)) {
      skip_directory = 1;
    }

    if (!skip_directory && tool_name != NULL && tool_name[0] != '\0') {
      snprintf(candidate, sizeof(candidate), "%s/%s", directory, tool_name);
      if (pm_candidate_is_current_shim(candidate, self_path)) {
        skip_directory = 1;
      }
    }

    if (!skip_directory) {
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

static void pm_disable_hook_for_tool_resolution(const char *tool_name, const char *self_path) {
  char *clean_path = pm_path_without_runtime_shims(tool_name, self_path);

  /*
   * asdf's resolver is an implementation detail of this launcher. Letting the
   * resolver inherit Port Manager's preload and BASH_ENV makes asdf's own
   * helper commands re-enter this shim, which can leave the parent blocked on
   * the resolver pipe before the requested runtime is ever exec'd.
   */
  setenv("PORT_MANAGER_HOOK_DISABLED", "1", 1);
  unsetenv(PM_PRELOAD_ENV);
  unsetenv(PM_PRELOAD_HINT_ENV);
  unsetenv("BASH_ENV");
  unsetenv("PORT_MANAGER_PREV_BASH_ENV");

  if (clean_path != NULL) {
    setenv("PATH", clean_path, 1);
    free(clean_path);
  }
}

static int pm_is_asdf_shim_candidate(const char *candidate) {
  return candidate != NULL && strstr(candidate, "/.asdf/shims/") != NULL;
}

static int pm_find_on_path_excluding(
  const char *tool_name,
  const char *self_path,
  const char *excluded_path,
  char *buffer,
  size_t size
) {
  const char *path_env = getenv("PATH");
  const char *shim_directory = getenv(PM_RUNTIME_SHIM_DIR_ENV);
  const char *cursor;

  if (tool_name == NULL || tool_name[0] == '\0' || strchr(tool_name, '/') != NULL ||
      path_env == NULL || path_env[0] == '\0') {
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

    if (shim_directory != NULL && shim_directory[0] != '\0' && pm_same_directory(directory, shim_directory)) {
      goto next_path_entry;
    }

    snprintf(candidate, sizeof(candidate), "%s/%s", directory, tool_name);
    if (pm_candidate_is_current_shim(candidate, self_path)) {
      goto next_path_entry;
    }

    if (excluded_path != NULL && excluded_path[0] != '\0' && pm_same_file(candidate, excluded_path)) {
      goto next_path_entry;
    }

    if (pm_is_asdf_shim_candidate(candidate)) {
      goto next_path_entry;
    }

    if (pm_is_executable_file(candidate)) {
      return pm_realpath_or_copy(candidate, buffer, size);
    }

next_path_entry:
    if (separator == NULL) {
      break;
    }
    cursor = separator + 1;
  }

  return -1;
}

static int pm_find_on_path(const char *tool_name, const char *self_path, char *buffer, size_t size) {
  return pm_find_on_path_excluding(tool_name, self_path, NULL, buffer, size);
}

static int pm_resolve_tool(const char *tool_name, const char *self_path, char *buffer, size_t size) {
  if (pm_asdf_which(tool_name, self_path, buffer, size) == 0) {
    return 0;
  }

  return pm_find_on_path(tool_name, self_path, buffer, size);
}

static int pm_read_shebang(const char *path, char *buffer, size_t size) {
  FILE *file = fopen(path, "r");

  if (file == NULL) {
    return -1;
  }

  if (fgets(buffer, (int)size, file) == NULL) {
    fclose(file);
    return -1;
  }
  fclose(file);

  if (strncmp(buffer, "#!", 2) != 0) {
    return -1;
  }

  buffer += 2;
  while (*buffer == ' ' || *buffer == '\t') {
    buffer++;
  }

  return buffer[0] == '\0' ? -1 : 0;
}

static char *pm_trim(char *value) {
  char *end;

  while (*value == ' ' || *value == '\t') {
    value++;
  }

  end = value + strlen(value);
  while (end > value && (end[-1] == '\n' || end[-1] == '\r' || end[-1] == ' ' || end[-1] == '\t')) {
    *--end = '\0';
  }

  return value;
}

static int pm_shebang_uses_shell(const char *script_path) {
  char line[PM_MAX_LINE];
  char *cursor;
  char *name;

  if (pm_read_shebang(script_path, line, sizeof(line)) != 0) {
    return 0;
  }

  cursor = pm_trim(line + 2);
  name = strrchr(cursor, '/');
  name = name == NULL ? cursor : name + 1;
  return strcmp(name, "sh") == 0 ||
    strcmp(name, "bash") == 0 ||
    strcmp(name, "zsh") == 0 ||
    strcmp(name, "env sh") == 0 ||
    strcmp(name, "env bash") == 0 ||
    strcmp(name, "env zsh") == 0;
}

static int pm_exec_env_script(const char *script_path, int argc, char **argv, const char *self_path) {
  char line[PM_MAX_LINE];
  char *cursor;
  char *tool;
  char interpreter_path[PM_MAX_PATH];
  char **next_argv;

  if (pm_read_shebang(script_path, line, sizeof(line)) != 0) {
    return -1;
  }

  cursor = pm_trim(line + 2);
  if (strncmp(cursor, "/usr/bin/env", 12) != 0 || (cursor[12] != '\0' && cursor[12] != ' ' && cursor[12] != '\t')) {
    return -1;
  }

  cursor += 12;
  while (*cursor == ' ' || *cursor == '\t') {
    cursor++;
  }

  while (cursor[0] == '-' && cursor[1] != '\0') {
    while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t') {
      cursor++;
    }
    while (*cursor == ' ' || *cursor == '\t') {
      cursor++;
    }
  }

  tool = cursor;
  while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t') {
    cursor++;
  }
  *cursor = '\0';

  if (tool[0] == '\0' || pm_resolve_tool(tool, self_path, interpreter_path, sizeof(interpreter_path)) != 0) {
    return -1;
  }

  next_argv = calloc((size_t)argc + 2, sizeof(char *));
  if (next_argv == NULL) {
    return -1;
  }

  next_argv[0] = interpreter_path;
  next_argv[1] = (char *)script_path;
  for (int index = 1; index < argc; index++) {
    next_argv[index + 1] = argv[index];
  }

  pm_restore_network_scope();
  pm_restore_dyld();
  execv(interpreter_path, next_argv);
  return -1;
}

static int pm_exec_resolved_target(const char *target_path, int argc, char **argv, const char *self_path) {
  char **next_argv;

  if (pm_exec_env_script(target_path, argc, argv, self_path) == 0) {
    return 0;
  }

  next_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (next_argv == NULL) {
    return -1;
  }

  next_argv[0] = (char *)target_path;
  for (int index = 1; index < argc; index++) {
    next_argv[index] = argv[index];
  }

  pm_restore_network_scope();
  pm_restore_dyld();
  execv(target_path, next_argv);
  return -1;
}

static int pm_read_script_prefix(const char *script_path, char *buffer, size_t size) {
  int fd;
  ssize_t count;
  size_t used = 0;

  if (buffer == NULL || size == 0) {
    return -1;
  }

  fd = open(script_path, O_RDONLY);
  if (fd < 0) {
    return -1;
  }

  while (used + 1 < size && (count = read(fd, buffer + used, size - used - 1)) > 0) {
    used += (size_t)count;
  }
  close(fd);
  buffer[used] = '\0';
  return used > 0 ? 0 : -1;
}

static void pm_apply_simple_prefix_assignment(const char *line, const char *exec_position) {
  const char *prefix = strstr(line, "PREFIX=\"");
  const char *value_start;
  const char *value_end;
  char value[PM_MAX_PATH];
  size_t length;

  if (prefix == NULL || (exec_position != NULL && prefix > exec_position)) {
    return;
  }

  value_start = prefix + strlen("PREFIX=\"");
  value_end = strchr(value_start, '"');
  if (value_end == NULL) {
    return;
  }

  length = (size_t)(value_end - value_start);
  if (length == 0 || length >= sizeof(value)) {
    return;
  }

  memcpy(value, value_start, length);
  value[length] = '\0';
  setenv("PREFIX", value, 1);
}

static int pm_exec_simple_shell_exec_wrapper(const char *script_path, int argc, char **argv, const char *self_path) {
  char script[PM_MAX_SCRIPT];
  char *line;
  char *save = NULL;

  /*
   * Homebrew runtime commands such as yarn are shell wrappers that immediately
   * exec the real JS entrypoint. Passing through /bin/bash strips DYLD again,
   * so unwrap the simple "exec \"/absolute/script\" \"$@\"" form and launch
   * the target directly with the restored preload environment.
   */
  if (!pm_shebang_uses_shell(script_path) || pm_read_script_prefix(script_path, script, sizeof(script)) != 0) {
    return -1;
  }

  line = strtok_r(script, "\n", &save);
  while (line != NULL) {
    char *trimmed = pm_trim(line);
    char *exec_position = strstr(trimmed, "exec \"");
    char *target_start;
    char *target_end;
    char target_path[PM_MAX_PATH];
    size_t target_length;

    if (exec_position == NULL) {
      line = strtok_r(NULL, "\n", &save);
      continue;
    }

    target_start = exec_position + strlen("exec \"");
    if (target_start[0] != '/') {
      line = strtok_r(NULL, "\n", &save);
      continue;
    }

    target_end = strchr(target_start, '"');
    if (target_end == NULL || strstr(target_end + 1, "\"$@\"") == NULL) {
      line = strtok_r(NULL, "\n", &save);
      continue;
    }

    target_length = (size_t)(target_end - target_start);
    if (target_length == 0 || target_length >= sizeof(target_path)) {
      return -1;
    }

    memcpy(target_path, target_start, target_length);
    target_path[target_length] = '\0';
    if (!pm_is_executable_file(target_path)) {
      return -1;
    }

    pm_apply_simple_prefix_assignment(trimmed, exec_position);
    return pm_exec_resolved_target(target_path, argc, argv, self_path);
  }

  return -1;
}

static int pm_is_asdf_nodejs_npm_wrapper(const char *tool_name, const char *executable_path) {
  return tool_name != NULL &&
    strcmp(tool_name, "npm") == 0 &&
    executable_path != NULL &&
    strstr(executable_path, "/plugins/nodejs/shims/npm") != NULL;
}

static void pm_prepare_asdf_nodejs_npm_wrapper(
  const char *tool_name,
  const char *executable_path,
  const char *self_path
) {
  char canonical_npm[PM_MAX_PATH];

  /*
   * asdf-nodejs' npm wrapper falls back to `command -v npm` when direct
   * resolution fails. In a Port Manager terminal that PATH search can find this
   * runtime shim again. Supplying the canonical npm path keeps npm scripts on
   * the original PATH while preventing the wrapper from re-entering us.
   */
  if (!pm_is_asdf_nodejs_npm_wrapper(tool_name, executable_path)) {
    return;
  }

  if (pm_find_on_path_excluding("npm", self_path, executable_path, canonical_npm, sizeof(canonical_npm)) != 0 ||
      pm_same_file(canonical_npm, executable_path)) {
    return;
  }

  setenv("ASDF_NODEJS_CANON_NPM_PATH", canonical_npm, 1);
}

static void pm_resolve_self_path(const char *tool_name, const char *argv0, char *buffer, size_t size) {
  const char *shim_directory = getenv(PM_RUNTIME_SHIM_DIR_ENV);
  char candidate[PM_MAX_PATH];

  if (buffer == NULL || size == 0) {
    return;
  }

  buffer[0] = '\0';
  if (argv0 != NULL && strchr(argv0, '/') != NULL && pm_is_executable_file(argv0)) {
    pm_realpath_or_copy(argv0, buffer, size);
    return;
  }

  if (shim_directory != NULL && shim_directory[0] != '\0' &&
      tool_name != NULL && tool_name[0] != '\0' && strchr(tool_name, '/') == NULL) {
    snprintf(candidate, sizeof(candidate), "%s/%s", shim_directory, tool_name);
    if (pm_is_executable_file(candidate)) {
      pm_realpath_or_copy(candidate, buffer, size);
      return;
    }
  }

  if (argv0 != NULL) {
    snprintf(buffer, size, "%s", argv0);
  }
}

int main(int argc, char **argv) {
  const char *tool_name = pm_basename(argv[0]);
  const char *environment_tool_name = getenv("PORT_MANAGER_ASDF_TOOL_NAME");
  char executable_path[PM_MAX_PATH];
  char self_path[PM_MAX_PATH];
  const char *resolved_self_path;
  char **next_argv;

  if (tool_name == NULL) {
    fprintf(stderr, "portmanager-asdf-shim: could not determine shim name\n");
    return 127;
  }

  if (strcmp(tool_name, "portmanager_asdf_shim") == 0) {
    /*
     * Some process launchers resolve PATH aliases before exec. The hard-link
     * aliases normally preserve argv[0], but wrapper scripts can still pass an
     * explicit tool name through this env var when direct invocation is
     * unavoidable.
     */
    if (environment_tool_name == NULL || environment_tool_name[0] == '\0' || strchr(environment_tool_name, '/') != NULL) {
      fprintf(stderr, "portmanager-asdf-shim: must be invoked through an asdf tool symlink\n");
      return 127;
    }
    tool_name = environment_tool_name;
  }

  pm_resolve_self_path(tool_name, argv[0], self_path, sizeof(self_path));
  resolved_self_path = self_path[0] == '\0' ? NULL : self_path;

  if (pm_resolve_tool(tool_name, resolved_self_path, executable_path, sizeof(executable_path)) != 0) {
    fprintf(stderr, "portmanager-asdf-shim: could not resolve runtime tool %s\n", tool_name);
    return 127;
  }

  pm_prepare_asdf_nodejs_npm_wrapper(tool_name, executable_path, resolved_self_path);

  if (pm_exec_env_script(executable_path, argc, argv, resolved_self_path) == 0 ||
      pm_exec_simple_shell_exec_wrapper(executable_path, argc, argv, resolved_self_path) == 0) {
    return 0;
  }

  next_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (next_argv == NULL) {
    fprintf(stderr, "portmanager-asdf-shim: allocation failed\n");
    return 127;
  }

  next_argv[0] = executable_path;

  for (int index = 1; index < argc; index++) {
    next_argv[index] = argv[index];
  }

  pm_restore_network_scope();
  pm_restore_dyld();
  execv(executable_path, next_argv);
  fprintf(stderr, "portmanager-asdf-shim: failed to execute %s for %s: %s\n", executable_path, tool_name, strerror(errno));
  return 127;
}

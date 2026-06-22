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
#define PM_MAX_TEXT 512
#define PM_RUNTIME_SHIM_DIR_ENV "PORT_MANAGER_RUNTIME_SHIM_DIR"

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
  const char *network_id = pm_network_id_from_bash_env();
  const char *borrowed_network_id = getenv("PORT_MANAGER_BORROWED_NETWORK_ID");
  const char *alias_network_id = getenv("NEWDLOPS_PM_NETWORK_ID");
  const char *alias_borrowed_network_id = getenv("NEWDLOPS_PM_BORROWED_NETWORK_ID");

  if (network_id != NULL && network_id[0] != '\0') {
    pm_export_network_scope(network_id);
    return;
  }

  network_id = getenv("PORT_MANAGER_NETWORK_ID");

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = borrowed_network_id;
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = alias_network_id;
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = alias_borrowed_network_id;
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

static int pm_asdf_which(const char *tool_name, char *buffer, size_t size) {
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

static int pm_is_executable_file(const char *path) {
  struct stat stat_buffer;

  if (stat(path, &stat_buffer) != 0 || !S_ISREG(stat_buffer.st_mode)) {
    return 0;
  }

  return access(path, X_OK) == 0;
}

static int pm_find_on_path(const char *tool_name, char *buffer, size_t size) {
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

static int pm_resolve_tool(const char *tool_name, char *buffer, size_t size) {
  if (pm_asdf_which(tool_name, buffer, size) == 0) {
    return 0;
  }

  return pm_find_on_path(tool_name, buffer, size);
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

static int pm_exec_env_script(const char *script_path, int argc, char **argv) {
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

  if (tool[0] == '\0' || pm_resolve_tool(tool, interpreter_path, sizeof(interpreter_path)) != 0) {
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

int main(int argc, char **argv) {
  const char *tool_name = pm_basename(argv[0]);
  char executable_path[PM_MAX_PATH];
  char **next_argv;

  if (tool_name == NULL) {
    fprintf(stderr, "portmanager-asdf-shim: could not determine shim name\n");
    return 127;
  }

  if (strcmp(tool_name, "portmanager_asdf_shim") == 0) {
    fprintf(stderr, "portmanager-asdf-shim: must be invoked through an asdf tool symlink\n");
    return 127;
  }

  if (pm_resolve_tool(tool_name, executable_path, sizeof(executable_path)) != 0) {
    fprintf(stderr, "portmanager-asdf-shim: could not resolve runtime tool %s\n", tool_name);
    return 127;
  }

  if (pm_exec_env_script(executable_path, argc, argv) == 0) {
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

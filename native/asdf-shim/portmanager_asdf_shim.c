#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

static void pm_restore_network_scope(void) {
  const char *network_id = getenv("PORT_MANAGER_NETWORK_ID");
  const char *borrowed_network_id = getenv("PORT_MANAGER_BORROWED_NETWORK_ID");
  const char *alias_network_id = getenv("NEWDLOPS_PM_NETWORK_ID");
  const char *alias_borrowed_network_id = getenv("NEWDLOPS_PM_BORROWED_NETWORK_ID");

  if ((network_id == NULL || network_id[0] == '\0') && borrowed_network_id != NULL && borrowed_network_id[0] != '\0') {
    setenv("PORT_MANAGER_NETWORK_ID", borrowed_network_id, 1);
  } else if ((network_id == NULL || network_id[0] == '\0') && alias_network_id != NULL && alias_network_id[0] != '\0') {
    setenv("PORT_MANAGER_NETWORK_ID", alias_network_id, 1);
  } else if ((network_id == NULL || network_id[0] == '\0') && alias_borrowed_network_id != NULL && alias_borrowed_network_id[0] != '\0') {
    setenv("PORT_MANAGER_NETWORK_ID", alias_borrowed_network_id, 1);
  }
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

  if (tool[0] == '\0' || pm_asdf_which(tool, interpreter_path, sizeof(interpreter_path)) != 0) {
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

  if (pm_asdf_which(tool_name, executable_path, sizeof(executable_path)) != 0) {
    fprintf(stderr, "portmanager-asdf-shim: could not resolve asdf tool %s\n", tool_name);
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

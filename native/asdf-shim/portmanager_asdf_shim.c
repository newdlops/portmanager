#include <errno.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/*
 * Native launcher for asdf shim names.
 *
 * On macOS, DYLD_* variables can be stripped when a command goes through a
 * protected shebang interpreter such as /usr/bin/env bash. asdf shims are shell
 * scripts, so terminal-launched commands can lose DYLD_INSERT_LIBRARIES before
 * the real runtime starts. This executable is symlinked under the same shim
 * names and calls `asdf exec <tool>` directly, preserving Port Manager's hook
 * environment for the final runtime.
 */

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

int main(int argc, char **argv) {
  const char *tool_name = pm_basename(argv[0]);
  char **next_argv;

  if (tool_name == NULL) {
    fprintf(stderr, "portmanager-asdf-shim: could not determine shim name\n");
    return 127;
  }

  if (strcmp(tool_name, "portmanager_asdf_shim") == 0) {
    fprintf(stderr, "portmanager-asdf-shim: must be invoked through an asdf tool symlink\n");
    return 127;
  }

  next_argv = calloc((size_t)argc + 3, sizeof(char *));
  if (next_argv == NULL) {
    fprintf(stderr, "portmanager-asdf-shim: allocation failed\n");
    return 127;
  }

  next_argv[0] = "asdf";
  next_argv[1] = "exec";
  next_argv[2] = (char *)tool_name;

  for (int index = 1; index < argc; index++) {
    next_argv[index + 2] = argv[index];
  }

  execvp("asdf", next_argv);
  fprintf(stderr, "portmanager-asdf-shim: failed to execute asdf for %s: %s\n", tool_name, strerror(errno));
  return 127;
}

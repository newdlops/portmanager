#include <errno.h>
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/*
 * Generic runtime launcher for a logical network terminal.
 *
 * On macOS, DYLD_* variables are stripped when a command crosses a protected
 * launcher such as /usr/bin/env or /bin/sh. This executable is installed on PATH
 * under runtime names (node, python, ...). When `env node` resolves to it, it
 * restores the preload environment and execs the REAL runtime, which is simply
 * the next entry of its own name on PATH. It is runtime-manager agnostic: no
 * asdf/nvm/Homebrew probing, no script parsing — whatever the shell would have
 * run without us is "the next one on PATH".
 */

#define PM_MAX_PATH 4096
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

static char *pm_make_preload_value(const char *hook_path, const char *current_value) {
  char *value;
  size_t size;
  size_t offset;
  size_t hook_length;
  const char *cursor;

  if (hook_path == NULL || hook_path[0] == '\0') {
    return NULL;
  }

  hook_length = strlen(hook_path);
  size = hook_length + (current_value == NULL ? 0 : strlen(current_value)) + 2;
  value = malloc(size);
  if (value == NULL) {
    return NULL;
  }

  memcpy(value, hook_path, hook_length);
  offset = hook_length;
  value[offset] = '\0';

  if (current_value == NULL || current_value[0] == '\0') {
    return value;
  }

  cursor = current_value;
  while (*cursor != '\0') {
    const char *end = strchr(cursor, ':');
    size_t segment_length = end == NULL ? strlen(cursor) : (size_t)(end - cursor);
    int is_hook = segment_length == hook_length && strncmp(cursor, hook_path, segment_length) == 0;

    if (segment_length > 0 && !is_hook) {
      value[offset++] = ':';
      memcpy(value + offset, cursor, segment_length);
      offset += segment_length;
      value[offset] = '\0';
    }

    if (end == NULL) {
      break;
    }

    cursor = end + 1;
  }

  return value;
}

static void pm_restore_dyld(void) {
  const char *hook = getenv(PM_PRELOAD_HINT_ENV);
  const char *current = getenv(PM_PRELOAD_ENV);
  char *merged;

  if (hook == NULL || hook[0] == '\0') {
    return;
  }

  /*
   * The native hook only repairs stripped preload variables for processes that
   * crossed an extension-owned runtime boundary. This keeps package-manager
   * lifecycle commands outside routing while preserving child tools launched by
   * real runtime/server processes.
   */
  setenv("PORT_MANAGER_PRELOAD_REPAIR", "1", 1);

  if (pm_preload_value_is_normalized(current, hook)) {
    return;
  }

  merged = pm_make_preload_value(hook, current);
  if (merged == NULL) {
    return;
  }

  setenv(PM_PRELOAD_ENV, merged, 1);
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

/*
 * A candidate that is a POSIX-shell script wrapper (`#!/bin/sh`, `#!/bin/bash`,
 * …) is a preload dead end: exec'ing it runs a SIP-protected shell that strips
 * DYLD_INSERT_LIBRARIES, and such wrappers almost always re-exec a real binary
 * by ABSOLUTE path (e.g. yarn's temp `node`/`yarn` shims: `exec "/…/node" "$@"`),
 * which bypasses this shim entirely — so the preload can never be recovered
 * downstream. Resolving PAST such a wrapper to a native binary (preload survives
 * the exec) or to a `#!/usr/bin/env X` script (which re-searches PATH for X and
 * thus routes back through this shim, where the preload is restored) keeps the
 * hook alive. `#!/usr/bin/env` and native Mach-O binaries are NOT wrappers.
 * Runtime-manager agnostic: no yarn/nvm/asdf specifics, just the shebang.
 */
static int pm_candidate_is_shell_wrapper(const char *path) {
  FILE *file;
  char header[128];
  size_t got;
  const char *cursor;
  const char *interpreter_start;
  const char *interpreter_end;
  const char *base;
  char base_name[64];
  size_t base_length;

  file = fopen(path, "rb");
  if (file == NULL) {
    return 0;
  }
  got = fread(header, 1, sizeof(header) - 1, file);
  fclose(file);

  if (got < 2 || header[0] != '#' || header[1] != '!') {
    return 0;
  }
  header[got] = '\0';

  cursor = header + 2;
  while (*cursor == ' ' || *cursor == '\t') {
    cursor++;
  }
  interpreter_start = cursor;
  while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t' && *cursor != '\n' && *cursor != '\r') {
    cursor++;
  }
  interpreter_end = cursor;
  if (interpreter_end == interpreter_start) {
    return 0;
  }

  base = interpreter_end;
  while (base > interpreter_start && base[-1] != '/') {
    base--;
  }
  base_length = (size_t)(interpreter_end - base);
  if (base_length == 0 || base_length >= sizeof(base_name)) {
    return 0;
  }
  memcpy(base_name, base, base_length);
  base_name[base_length] = '\0';

  /* env re-routes through PATH back into this shim → recoverable, not a dead end. */
  if (strcmp(base_name, "env") == 0) {
    return 0;
  }
  return strcmp(base_name, "sh") == 0 || strcmp(base_name, "bash") == 0 ||
         strcmp(base_name, "zsh") == 0 || strcmp(base_name, "dash") == 0 ||
         strcmp(base_name, "ksh") == 0;
}

/*
 * Resolves the real runtime by finding the next PATH entry of this launcher's
 * own name, skipping this launcher's own directory and file. This is runtime
 * manager agnostic on purpose: whatever `node`/`python`/etc. the shell would
 * have run without us (nvm, asdf, Homebrew, a bare install) is simply "the next
 * one on PATH". No manager-specific probing, no script parsing.
 */
static int pm_resolve_tool(const char *tool_name, const char *self_path, char *buffer, size_t size) {
  const char *path_env = getenv("PATH");
  const char *shim_directory = getenv(PM_RUNTIME_SHIM_DIR_ENV);
  const char *cursor;
  char fallback[PM_MAX_PATH];

  fallback[0] = '\0';

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

    /* Never resolve back into this launcher (by directory or by file identity). */
    if (shim_directory != NULL && shim_directory[0] != '\0' && pm_same_directory(directory, shim_directory)) {
      goto next_path_entry;
    }

    snprintf(candidate, sizeof(candidate), "%s/%s", directory, tool_name);
    if (pm_candidate_is_current_shim(candidate, self_path)) {
      goto next_path_entry;
    }

    if (pm_is_executable_file(candidate)) {
      /*
       * Prefer a target that keeps the preload alive: a native binary (survives
       * the exec) or an env-shebang script (re-routes through this shim). Skip
       * shell-script wrappers that would strip DYLD and absolute-exec past us,
       * but remember the first one so a tool that ONLY exists as such a wrapper
       * still resolves.
       */
      if (!pm_candidate_is_shell_wrapper(candidate)) {
        return pm_realpath_or_copy(candidate, buffer, size);
      }
      if (fallback[0] == '\0') {
        snprintf(fallback, sizeof(fallback), "%s", candidate);
      }
    }

next_path_entry:
    if (separator == NULL) {
      break;
    }
    cursor = separator + 1;
  }

  if (fallback[0] != '\0') {
    return pm_realpath_or_copy(fallback, buffer, size);
  }

  return -1;
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

/*
 * Guards against a resolution loop. If the "next on PATH" runtime is itself a
 * shell-script shim that re-enters `env <runtime>`, PATH resolution could bounce
 * back into this launcher. A depth counter caps that; legitimate trees never
 * approach the limit because a real runtime binary does not re-enter us.
 */
#define PM_RUNTIME_SHIM_DEPTH_ENV "PORT_MANAGER_RUNTIME_SHIM_DEPTH"
#define PM_RUNTIME_SHIM_DEPTH_LIMIT 24

static int pm_next_runtime_shim_depth(void) {
  const char *value = getenv(PM_RUNTIME_SHIM_DEPTH_ENV);
  long depth = value == NULL ? 0 : strtol(value, NULL, 10);
  return depth < 0 ? 0 : (int)depth;
}

int main(int argc, char **argv) {
  const char *tool_name = pm_basename(argv[0]);
  const char *environment_tool_name = getenv("PORT_MANAGER_ASDF_TOOL_NAME");
  char executable_path[PM_MAX_PATH];
  char self_path[PM_MAX_PATH];
  char depth_text[16];
  const char *resolved_self_path;
  char **next_argv;
  int depth = pm_next_runtime_shim_depth();

  if (tool_name == NULL) {
    fprintf(stderr, "portmanager-asdf-shim: could not determine shim name\n");
    return 127;
  }

  if (depth >= PM_RUNTIME_SHIM_DEPTH_LIMIT) {
    fprintf(stderr, "portmanager-asdf-shim: runtime resolution loop for %s\n", tool_name);
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

  /*
   * The resolved tool is exec'd directly with the preload restored. Script
   * content is never parsed: whatever runtime the shell would have run without
   * us is just the next PATH entry, and we hand it the preload environment.
   */
  next_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (next_argv == NULL) {
    fprintf(stderr, "portmanager-asdf-shim: allocation failed\n");
    return 127;
  }

  next_argv[0] = executable_path;

  for (int index = 1; index < argc; index++) {
    next_argv[index] = argv[index];
  }

  snprintf(depth_text, sizeof(depth_text), "%d", depth + 1);
  setenv(PM_RUNTIME_SHIM_DEPTH_ENV, depth_text, 1);
  pm_restore_network_scope();
  pm_restore_dyld();
  execv(executable_path, next_argv);
  fprintf(stderr, "portmanager-asdf-shim: failed to execute %s for %s: %s\n", executable_path, tool_name, strerror(errno));
  return 127;
}

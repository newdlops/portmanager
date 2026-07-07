#include <ctype.h>
#include <errno.h>
#include <libgen.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include "../shared/pm_peer_process.h"

/*
 * Network-scoped process observation for terminal PATH shims.
 *
 * Installed on PATH as `ps`, `pgrep`, `pkill`, and `killall` inside Port
 * Manager terminals. Process observation follows the caller's network (the
 * same rule the tail/cat trampoline applies to files): rows that belong to a
 * DIFFERENT logical network are hidden, so a workload's machine-wide sweep —
 * `ps -ef | grep celery | kill -9`, `pkill -f celery` — only ever sees and
 * signals its own scope. Rows with no network identity (system processes, the
 * shared host substrate) stay visible everywhere. Attribution reuses the
 * router's pm_peer_read_network_id (env of the process, then a few ancestors).
 *
 * Fail-open by design: when output cannot be mapped to pids (exotic formats)
 * the real tool's output passes through unfiltered — this shim narrows kill
 * sweeps, it must never break observation. Machine-wide truth stays available
 * via absolute paths (/bin/ps) or PORT_MANAGER_PROCESS_SCOPE=0.
 */

#define PM_MAX_PATH 4096
#define PM_MAX_TEXT 512
#define PM_MAX_LINE 65536
#define PM_MAX_FORMAT_KEYWORDS 64

static const char *pm_scope_env_names[] = {
  "PORT_MANAGER_NETWORK_ID",
  "PORT_MANAGER_ROUTE_TABLE_NETWORK_ID",
  "PORT_MANAGER_BORROWED_NETWORK_ID",
  "NEWDLOPS_PM_NETWORK_ID",
  "NEWDLOPS_PM_BORROWED_NETWORK_ID",
};

static const char *pm_caller_scope(void) {
  for (size_t index = 0; index < sizeof(pm_scope_env_names) / sizeof(pm_scope_env_names[0]); index++) {
    const char *value = getenv(pm_scope_env_names[index]);
    if (value != NULL && value[0] != '\0') {
      return value;
    }
  }
  return "";
}

static int pm_env_flag_is(const char *name, const char *expected) {
  const char *value = getenv(name);
  return value != NULL && strcmp(value, expected) == 0;
}

/* Hide only rows that RESOLVE to a different network; unresolved rows stay. */
static int pm_pid_is_foreign(int pid, const char *caller_scope) {
  char scope[PM_MAX_TEXT];

  if (pid <= 0) {
    return 0;
  }
  if (pm_peer_read_network_id(pid, scope, sizeof(scope)) != 0 || scope[0] == '\0') {
    return 0;
  }
  return strcmp(scope, caller_scope) != 0;
}

static int pm_is_executable_file(const char *path) {
  struct stat stat_buffer;

  if (stat(path, &stat_buffer) != 0 || !S_ISREG(stat_buffer.st_mode)) {
    return 0;
  }
  return access(path, X_OK) == 0;
}

/* Resolves the real tool: known system locations first, then PATH entries outside the shim dir. */
static int pm_resolve_real_tool(const char *tool_name, char *buffer, size_t size) {
  const char *candidates[3] = {NULL, NULL, NULL};
  const char *shim_directory = getenv("PORT_MANAGER_RUNTIME_SHIM_DIR");
  const char *path_env;
  char first[PM_MAX_PATH];
  char second[PM_MAX_PATH];

  snprintf(first, sizeof(first), "/bin/%s", tool_name);
  snprintf(second, sizeof(second), "/usr/bin/%s", tool_name);
  candidates[0] = first;
  candidates[1] = second;

  for (size_t index = 0; candidates[index] != NULL; index++) {
    if (pm_is_executable_file(candidates[index])) {
      snprintf(buffer, size, "%s", candidates[index]);
      return 0;
    }
  }

  path_env = getenv("PATH");
  if (path_env == NULL) {
    return -1;
  }
  while (*path_env != '\0') {
    const char *separator = strchr(path_env, ':');
    size_t directory_length = separator == NULL ? strlen(path_env) : (size_t)(separator - path_env);
    char candidate[PM_MAX_PATH];

    if (directory_length > 0 && directory_length < sizeof(candidate) - strlen(tool_name) - 2) {
      memcpy(candidate, path_env, directory_length);
      candidate[directory_length] = '\0';
      if (shim_directory == NULL || strcmp(candidate, shim_directory) != 0) {
        snprintf(candidate + directory_length, sizeof(candidate) - directory_length, "/%s", tool_name);
        if (pm_is_executable_file(candidate)) {
          snprintf(buffer, size, "%s", candidate);
          return 0;
        }
      }
    }
    if (separator == NULL) {
      break;
    }
    path_env = separator + 1;
  }
  return -1;
}

/* Runs the real tool with stdout captured; returns the read stream and child pid. */
static FILE *pm_spawn_capture(const char *executable, char *const argv[], pid_t *out_child) {
  int stdout_pipe[2];
  pid_t child;
  FILE *stream;

  if (pipe(stdout_pipe) != 0) {
    return NULL;
  }
  child = fork();
  if (child < 0) {
    close(stdout_pipe[0]);
    close(stdout_pipe[1]);
    return NULL;
  }
  if (child == 0) {
    close(stdout_pipe[0]);
    if (dup2(stdout_pipe[1], STDOUT_FILENO) < 0) {
      _exit(127);
    }
    close(stdout_pipe[1]);
    execv(executable, argv);
    _exit(127);
  }
  close(stdout_pipe[1]);
  stream = fdopen(stdout_pipe[0], "r");
  if (stream == NULL) {
    close(stdout_pipe[0]);
  }
  *out_child = child;
  return stream;
}

static int pm_wait_exit_code(pid_t child) {
  int status = 0;

  if (waitpid(child, &status, 0) < 0) {
    return 1;
  }
  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  }
  return 1;
}

static void pm_exec_real(const char *tool_name, char **argv) {
  char executable[PM_MAX_PATH];

  if (pm_resolve_real_tool(tool_name, executable, sizeof(executable)) != 0) {
    fprintf(stderr, "portmanager-process-scope-shim: could not resolve %s\n", tool_name);
    exit(127);
  }
  argv[0] = executable;
  execv(executable, argv);
  fprintf(stderr, "portmanager-process-scope-shim: failed to execute %s: %s\n", executable, strerror(errno));
  exit(127);
}

/* ---- ps ------------------------------------------------------------------ */

/*
 * Collects `-o`/`-O` format keywords (comma/space separated, `=header`
 * suffixes stripped) so headerless output can still be mapped to a pid
 * column. Handles joined (-opid=), clustered (-eo pid), and BSD first-word
 * (axo pid) forms.
 */
static int pm_collect_ps_format_keywords(int argc, char **argv, char keywords[][32], int max_keywords) {
  int count = 0;
  int expect_format_value = 0;

  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];
    const char *format_text = NULL;

    if (expect_format_value) {
      format_text = arg;
      expect_format_value = 0;
    } else {
      const char *cursor = arg;
      if (*cursor == '-') {
        cursor++;
      } else if (index != 1) {
        continue;
      }
      for (; *cursor != '\0'; cursor++) {
        if (*cursor == 'o' || *cursor == 'O') {
          if (cursor[1] != '\0') {
            format_text = cursor + 1;
          } else {
            expect_format_value = 1;
          }
          break;
        }
        if (!isalpha((unsigned char)*cursor)) {
          break;
        }
      }
    }

    if (format_text == NULL) {
      continue;
    }
    while (*format_text != '\0' && count < max_keywords) {
      size_t keyword_length = strcspn(format_text, ", \t");
      size_t copy_length = keyword_length;
      size_t equals_offset;

      if (copy_length >= 32) {
        copy_length = 31;
      }
      memcpy(keywords[count], format_text, copy_length);
      keywords[count][copy_length] = '\0';
      equals_offset = strcspn(keywords[count], "=");
      keywords[count][equals_offset] = '\0';
      if (keywords[count][0] != '\0') {
        count++;
      }
      format_text += keyword_length;
      while (*format_text == ',' || *format_text == ' ' || *format_text == '\t') {
        format_text++;
      }
    }
  }
  return count;
}

/* Returns the whitespace-token index of `pid` among format keywords, or -1. */
static int pm_ps_pid_index_from_keywords(int argc, char **argv) {
  char keywords[PM_MAX_FORMAT_KEYWORDS][32];
  int count = pm_collect_ps_format_keywords(argc, argv, keywords, PM_MAX_FORMAT_KEYWORDS);

  for (int index = 0; index < count; index++) {
    if (strcmp(keywords[index], "pid") == 0) {
      return index;
    }
  }
  return count > 0 ? -1 : -2; /* -1: format without pid; -2: no -o at all */
}

/* Extracts the token at `token_index`; returns its length or 0. */
static size_t pm_line_token(const char *line, int token_index, const char **out_start) {
  const char *cursor = line;

  for (int index = 0; index <= token_index; index++) {
    while (*cursor == ' ' || *cursor == '\t') {
      cursor++;
    }
    if (*cursor == '\0' || *cursor == '\n') {
      return 0;
    }
    if (index == token_index) {
      size_t length = strcspn(cursor, " \t\n");
      *out_start = cursor;
      return length;
    }
    cursor += strcspn(cursor, " \t\n");
  }
  return 0;
}

static int pm_token_to_pid(const char *start, size_t length) {
  char text[32];
  char *end = NULL;
  long value;

  if (length == 0 || length >= sizeof(text)) {
    return -1;
  }
  memcpy(text, start, length);
  text[length] = '\0';
  value = strtol(text, &end, 10);
  if (end == NULL || *end != '\0' || value <= 0) {
    return -1;
  }
  return (int)value;
}

static int pm_run_ps(int argc, char **argv, const char *caller_scope) {
  char executable[PM_MAX_PATH];
  char line[PM_MAX_LINE];
  FILE *stream;
  pid_t child;
  int pid_index = pm_ps_pid_index_from_keywords(argc, argv);
  int saw_first_line = 0;

  if (pid_index == -1) {
    /* A -o format without a pid column cannot be mapped to processes. */
    pm_exec_real("ps", argv);
  }
  if (pm_resolve_real_tool("ps", executable, sizeof(executable)) != 0) {
    fprintf(stderr, "portmanager-process-scope-shim: could not resolve ps\n");
    return 127;
  }
  argv[0] = executable;
  stream = pm_spawn_capture(executable, argv, &child);
  if (stream == NULL) {
    return 127;
  }

  while (fgets(line, sizeof(line), stream) != NULL) {
    const char *token_start = NULL;
    size_t token_length;
    int row_pid;

    if (!saw_first_line && pid_index == -2) {
      /* Locate the PID column from the header line; without one, pass through. */
      const char *cursor = line;
      int token_index = 0;

      saw_first_line = 1;
      pid_index = -1;
      while (*cursor != '\0') {
        while (*cursor == ' ' || *cursor == '\t') {
          cursor++;
        }
        if (*cursor == '\0' || *cursor == '\n') {
          break;
        }
        if (strncmp(cursor, "PID", 3) == 0 && (cursor[3] == ' ' || cursor[3] == '\t' || cursor[3] == '\n' || cursor[3] == '\0')) {
          pid_index = token_index;
          break;
        }
        cursor += strcspn(cursor, " \t\n");
        token_index++;
      }
      fputs(line, stdout);
      continue;
    }
    saw_first_line = 1;

    if (pid_index < 0) {
      fputs(line, stdout);
      continue;
    }

    token_length = pm_line_token(line, pid_index, &token_start);
    row_pid = pm_token_to_pid(token_start, token_length);
    if (row_pid > 0 && pm_pid_is_foreign(row_pid, caller_scope)) {
      continue;
    }
    fputs(line, stdout);
  }
  fclose(stream);
  return pm_wait_exit_code(child);
}

/* ---- pgrep --------------------------------------------------------------- */

static int pm_pgrep_output_is_line_mapped(int argc, char **argv) {
  for (int index = 1; index < argc; index++) {
    /* Custom delimiters join every pid into one record; pass through. */
    if (strncmp(argv[index], "-d", 2) == 0) {
      return 0;
    }
  }
  return 1;
}

static int pm_run_pgrep(int argc, char **argv, const char *caller_scope) {
  char executable[PM_MAX_PATH];
  char line[PM_MAX_LINE];
  FILE *stream;
  pid_t child;
  int real_exit;
  int kept = 0;

  if (!pm_pgrep_output_is_line_mapped(argc, argv)) {
    pm_exec_real("pgrep", argv);
  }
  if (pm_resolve_real_tool("pgrep", executable, sizeof(executable)) != 0) {
    fprintf(stderr, "portmanager-process-scope-shim: could not resolve pgrep\n");
    return 127;
  }
  argv[0] = executable;
  stream = pm_spawn_capture(executable, argv, &child);
  if (stream == NULL) {
    return 127;
  }

  while (fgets(line, sizeof(line), stream) != NULL) {
    const char *token_start = NULL;
    size_t token_length = pm_line_token(line, 0, &token_start);
    int row_pid = pm_token_to_pid(token_start, token_length);

    if (row_pid > 0 && pm_pid_is_foreign(row_pid, caller_scope)) {
      continue;
    }
    fputs(line, stdout);
    kept++;
  }
  fclose(stream);
  real_exit = pm_wait_exit_code(child);
  if (real_exit != 0 && real_exit != 1) {
    return real_exit;
  }
  return kept > 0 ? 0 : 1;
}

/* ---- pkill / killall ------------------------------------------------------ */

static const char *pm_signal_names[] = {
  "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "EMT", "FPE", "KILL", "BUS",
  "SEGV", "SYS", "PIPE", "ALRM", "TERM", "URG", "STOP", "TSTP", "CONT",
  "CHLD", "TTIN", "TTOU", "IO", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH",
  "INFO", "USR1", "USR2",
};

static int pm_signal_from_name(const char *name) {
  static const int signal_numbers[] = {
    SIGHUP, SIGINT, SIGQUIT, SIGILL, SIGTRAP, SIGABRT,
#if defined(SIGEMT)
    SIGEMT,
#else
    -1,
#endif
    SIGFPE, SIGKILL, SIGBUS, SIGSEGV, SIGSYS, SIGPIPE, SIGALRM, SIGTERM,
    SIGURG, SIGSTOP, SIGTSTP, SIGCONT, SIGCHLD, SIGTTIN, SIGTTOU, SIGIO,
    SIGXCPU, SIGXFSZ, SIGVTALRM, SIGPROF, SIGWINCH,
#if defined(SIGINFO)
    SIGINFO,
#else
    -1,
#endif
    SIGUSR1, SIGUSR2,
  };
  const char *body = name;

  if (strncmp(body, "SIG", 3) == 0) {
    body += 3;
  }
  for (size_t index = 0; index < sizeof(pm_signal_names) / sizeof(pm_signal_names[0]); index++) {
    if (strcmp(pm_signal_names[index], body) == 0) {
      return signal_numbers[index];
    }
  }
  return -1;
}

/* Parses `-<signal>` / `--signal <x>` out of argv; returns the signal or SIGTERM. */
static int pm_extract_signal(int argc, char **argv, char **out_argv, int *out_argc) {
  int parsed_signal = SIGTERM;
  int out = 0;

  for (int index = 0; index < argc; index++) {
    const char *arg = argv[index];

    if (index > 0 && strcmp(arg, "--signal") == 0 && index + 1 < argc) {
      const char *value = argv[index + 1];
      char *end = NULL;
      long numeric = strtol(value, &end, 10);
      int named;

      if (end != NULL && *end == '\0' && numeric > 0) {
        parsed_signal = (int)numeric;
      } else if ((named = pm_signal_from_name(value)) > 0) {
        parsed_signal = named;
      }
      index++;
      continue;
    }

    if (index > 0 && arg[0] == '-' && arg[1] != '\0' && arg[1] != '-') {
      const char *body = arg + 1;
      char *end = NULL;
      long numeric = strtol(body, &end, 10);

      if (end != NULL && *end == '\0' && numeric > 0) {
        parsed_signal = (int)numeric;
        continue;
      }
      if (isupper((unsigned char)body[0])) {
        int named = pm_signal_from_name(body);
        if (named > 0) {
          parsed_signal = named;
          continue;
        }
      }
    }

    out_argv[out++] = argv[index];
  }
  out_argv[out] = NULL;
  *out_argc = out;
  return parsed_signal;
}

static int pm_signal_pgrep_matches(char **pgrep_argv, int signal_number, const char *caller_scope) {
  char executable[PM_MAX_PATH];
  char line[PM_MAX_LINE];
  FILE *stream;
  pid_t child;
  pid_t self = getpid();
  int real_exit;
  int killed = 0;

  if (pm_resolve_real_tool("pgrep", executable, sizeof(executable)) != 0) {
    fprintf(stderr, "portmanager-process-scope-shim: could not resolve pgrep\n");
    return 127;
  }
  pgrep_argv[0] = executable;
  stream = pm_spawn_capture(executable, pgrep_argv, &child);
  if (stream == NULL) {
    return 127;
  }

  while (fgets(line, sizeof(line), stream) != NULL) {
    const char *token_start = NULL;
    size_t token_length = pm_line_token(line, 0, &token_start);
    int row_pid = pm_token_to_pid(token_start, token_length);

    if (row_pid <= 0 || row_pid == (int)self) {
      continue;
    }
    if (pm_pid_is_foreign(row_pid, caller_scope)) {
      continue;
    }
    if (kill(row_pid, signal_number) == 0) {
      killed++;
    }
  }
  fclose(stream);
  real_exit = pm_wait_exit_code(child);
  if (real_exit != 0 && real_exit != 1) {
    return real_exit;
  }
  return killed > 0 ? 0 : 1;
}

static int pm_run_pkill(int argc, char **argv, const char *caller_scope) {
  char **pgrep_argv = calloc((size_t)argc + 1, sizeof(char *));
  int pgrep_argc = 0;
  int signal_number;

  if (pgrep_argv == NULL) {
    return 127;
  }
  signal_number = pm_extract_signal(argc, argv, pgrep_argv, &pgrep_argc);
  return pm_signal_pgrep_matches(pgrep_argv, signal_number, caller_scope);
}

static int pm_run_killall(int argc, char **argv, const char *caller_scope) {
  int signal_number = SIGTERM;
  int matched_any = 0;
  int first_name = 1;

  /* Only `killall [-SIGNAL] name...` is scoped; other flags go to the real tool. */
  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];
    if (arg[0] != '-') {
      continue;
    }
    {
      const char *body = arg + 1;
      char *end = NULL;
      long numeric = strtol(body, &end, 10);
      int named;

      if (end != NULL && *end == '\0' && numeric > 0) {
        continue;
      }
      named = pm_signal_from_name(body);
      if (named > 0) {
        continue;
      }
    }
    pm_exec_real("killall", argv);
  }

  for (int index = 1; index < argc; index++) {
    const char *arg = argv[index];
    if (arg[0] == '-') {
      const char *body = arg + 1;
      char *end = NULL;
      long numeric = strtol(body, &end, 10);
      int named;

      if (end != NULL && *end == '\0' && numeric > 0) {
        signal_number = (int)numeric;
      } else if ((named = pm_signal_from_name(body)) > 0) {
        signal_number = named;
      }
      continue;
    }
    first_name = 0;
    {
      char *pgrep_argv[4];
      char exact_flag[] = "-x";
      char name_copy[PM_MAX_TEXT];

      snprintf(name_copy, sizeof(name_copy), "%s", arg);
      pgrep_argv[0] = NULL;
      pgrep_argv[1] = exact_flag;
      pgrep_argv[2] = name_copy;
      pgrep_argv[3] = NULL;
      if (pm_signal_pgrep_matches(pgrep_argv, signal_number, caller_scope) == 0) {
        matched_any = 1;
      } else {
        fprintf(stderr, "No matching processes belonging to you were found\n");
      }
    }
  }

  if (first_name) {
    pm_exec_real("killall", argv);
  }
  return matched_any ? 0 : 1;
}

/* ---- entry ---------------------------------------------------------------- */

int main(int argc, char **argv) {
  char *tool_copy = argv[0] == NULL ? NULL : strdup(argv[0]);
  const char *tool_name = tool_copy == NULL ? NULL : basename(tool_copy);
  const char *caller_scope;

  if (tool_name == NULL || tool_name[0] == '\0') {
    fprintf(stderr, "portmanager-process-scope-shim: could not determine tool name\n");
    return 127;
  }

  /*
   * Port Manager's own scans read the full table (they scope themselves), and
   * PORT_MANAGER_PROCESS_SCOPE=0 is the user-facing escape hatch.
   */
  if (pm_env_flag_is("PORT_MANAGER_PROCESS_SCOPE", "0") ||
      pm_env_flag_is("PORT_MANAGER_DOCTOR_PROCESS_SCAN", "1") ||
      pm_env_flag_is("PORT_MANAGER_WORKER_ENV_SCAN", "1")) {
    pm_exec_real(tool_name, argv);
  }

  caller_scope = pm_caller_scope();

  if (strcmp(tool_name, "ps") == 0) {
    return pm_run_ps(argc, argv, caller_scope);
  }
  if (strcmp(tool_name, "pgrep") == 0) {
    return pm_run_pgrep(argc, argv, caller_scope);
  }
  if (strcmp(tool_name, "pkill") == 0) {
    return pm_run_pkill(argc, argv, caller_scope);
  }
  if (strcmp(tool_name, "killall") == 0) {
    return pm_run_killall(argc, argv, caller_scope);
  }

  pm_exec_real(tool_name, argv);
  return 127;
}

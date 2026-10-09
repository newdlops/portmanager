#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libproc.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <sys/user.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <sys/sysmacros.h>
#endif
#include "../shared/pm_audit_identity.h"

#define PM_TEXT_SIZE 4096
#define PM_TTY_SIZE 128

typedef struct pm_process_row {
  int pid;
  int parent_pid;
  int process_group_id;
  char terminal_id[PM_TTY_SIZE];
  unsigned long long birth;
} pm_process_row;

typedef struct pm_process_table {
  pm_process_row *rows;
  size_t count;
  size_t capacity;
} pm_process_table;

static const char *PM_NETWORK_VARIABLES[] = {
  "PORT_MANAGER_NETWORK_ID",
  "PORT_MANAGER_ROUTE_TABLE_NETWORK_ID",
  "PORT_MANAGER_BORROWED_NETWORK_ID",
  "NEWDLOPS_PM_NETWORK_ID",
  "NEWDLOPS_PM_BORROWED_NETWORK_ID",
};

static int pm_is_positive_pid_text(const char *value) {
  if (value == NULL || *value == '\0') {
    return 0;
  }

  for (const char *cursor = value; *cursor != '\0'; cursor++) {
    if (!isdigit((unsigned char)*cursor)) {
      return 0;
    }
  }

  return atoi(value) > 0;
}

static void pm_json_string(const char *value) {
  putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
    switch (*cursor) {
      case '"':
        fputs("\\\"", stdout);
        break;
      case '\\':
        fputs("\\\\", stdout);
        break;
      case '\b':
        fputs("\\b", stdout);
        break;
      case '\f':
        fputs("\\f", stdout);
        break;
      case '\n':
        fputs("\\n", stdout);
        break;
      case '\r':
        fputs("\\r", stdout);
        break;
      case '\t':
        fputs("\\t", stdout);
        break;
      default:
        if (*cursor < 0x20) {
          printf("\\u%04x", *cursor);
        } else {
          putchar(*cursor);
        }
        break;
    }
  }
  putchar('"');
}

static int pm_table_push(pm_process_table *table, pm_process_row row) {
  if (table->count == table->capacity) {
    size_t next_capacity = table->capacity == 0 ? 256 : table->capacity * 2;
    pm_process_row *next_rows = realloc(table->rows, next_capacity * sizeof(*next_rows));
    if (next_rows == NULL) {
      return -1;
    }

    table->rows = next_rows;
    table->capacity = next_capacity;
  }

  table->rows[table->count++] = row;
  return 0;
}

static pm_process_row *pm_find_row(pm_process_table *table, int pid) {
  for (size_t index = 0; index < table->count; index++) {
    if (table->rows[index].pid == pid) {
      return &table->rows[index];
    }
  }

  return NULL;
}

static void pm_print_row(const pm_process_row *row) {
  printf("{\"pid\":%d,\"parentPid\":%d,\"processGroupId\":%d", row->pid, row->parent_pid, row->process_group_id);
  if (row->terminal_id[0] != '\0') {
    fputs(",\"terminalId\":", stdout);
    pm_json_string(row->terminal_id);
  }
  putchar('}');
}

#if defined(__linux__)
static void pm_linux_tty_from_device(unsigned long long tty_device, char *buffer, size_t size) {
  DIR *dir;

  if (tty_device == 0 || size == 0) {
    return;
  }

  dir = opendir("/dev/pts");
  if (dir != NULL) {
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
      char path[PATH_MAX];
      struct stat stat_buffer;

      if (entry->d_name[0] == '.') {
        continue;
      }

      snprintf(path, sizeof(path), "/dev/pts/%s", entry->d_name);
      if (stat(path, &stat_buffer) == 0 && S_ISCHR(stat_buffer.st_mode) &&
          major(stat_buffer.st_rdev) == major((dev_t)tty_device) &&
          minor(stat_buffer.st_rdev) == minor((dev_t)tty_device)) {
        snprintf(buffer, size, "pts/%s", entry->d_name);
        closedir(dir);
        return;
      }
    }
    closedir(dir);
  }

  dir = opendir("/dev");
  if (dir != NULL) {
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
      char path[PATH_MAX];
      struct stat stat_buffer;

      if (strncmp(entry->d_name, "tty", 3) != 0) {
        continue;
      }

      snprintf(path, sizeof(path), "/dev/%s", entry->d_name);
      if (stat(path, &stat_buffer) == 0 && S_ISCHR(stat_buffer.st_mode) &&
          major(stat_buffer.st_rdev) == major((dev_t)tty_device) &&
          minor(stat_buffer.st_rdev) == minor((dev_t)tty_device)) {
        snprintf(buffer, size, "%s", entry->d_name);
        closedir(dir);
        return;
      }
    }
    closedir(dir);
  }
}

static int pm_linux_read_row(int pid, pm_process_row *row) {
  char path[PATH_MAX];
  char stat_buffer[PM_TEXT_SIZE];
  char *end_comm;
  char state;
  long parent_pid;
  long process_group_id;
  long session_id;
  unsigned long long tty_device;
  FILE *file;

  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  file = fopen(path, "r");
  if (file == NULL) {
    return -1;
  }

  if (fgets(stat_buffer, sizeof(stat_buffer), file) == NULL) {
    fclose(file);
    return -1;
  }
  fclose(file);

  end_comm = strrchr(stat_buffer, ')');
  if (end_comm == NULL) {
    return -1;
  }

  if (sscanf(end_comm + 2, "%c %ld %ld %ld %llu", &state, &parent_pid, &process_group_id, &session_id, &tty_device) != 5) {
    return -1;
  }

  (void)state;
  (void)session_id;

  row->pid = pid;
  row->parent_pid = (int)parent_pid;
  row->process_group_id = (int)process_group_id;
  row->terminal_id[0] = '\0';
  row->birth = 0;
  char *birth_cursor = end_comm + 2;
  for (int field = 3; field < 22 && birth_cursor != NULL; field++) {
    birth_cursor = strchr(birth_cursor, ' ');
    if (birth_cursor != NULL) birth_cursor++;
  }
  if (birth_cursor != NULL) row->birth = strtoull(birth_cursor, NULL, 10);
  pm_linux_tty_from_device(tty_device, row->terminal_id, sizeof(row->terminal_id));
  return 0;
}

static int pm_read_process_table(pm_process_table *table) {
  DIR *dir = opendir("/proc");
  struct dirent *entry;

  if (dir == NULL) {
    return -1;
  }

  while ((entry = readdir(dir)) != NULL) {
    pm_process_row row;
    if (!pm_is_positive_pid_text(entry->d_name)) {
      continue;
    }

    if (pm_linux_read_row(atoi(entry->d_name), &row) == 0 && pm_table_push(table, row) != 0) {
      closedir(dir);
      return -1;
    }
  }

  closedir(dir);
  return 0;
}

static int pm_read_cwd(int pid, char *buffer, size_t size) {
  char path[PATH_MAX];
  ssize_t length;

  snprintf(path, sizeof(path), "/proc/%d/cwd", pid);
  length = readlink(path, buffer, size - 1);
  if (length < 0) {
    return -1;
  }

  buffer[length] = '\0';
  return 0;
}

static int pm_linux_read_nul_file(int pid, const char *name, char **output, size_t *output_size) {
  char path[PATH_MAX];
  int fd;
  size_t capacity = PM_TEXT_SIZE;
  size_t length = 0;
  char *buffer = malloc(capacity);

  if (buffer == NULL) {
    return -1;
  }

  snprintf(path, sizeof(path), "/proc/%d/%s", pid, name);
  fd = open(path, O_RDONLY);
  if (fd < 0) {
    free(buffer);
    return -1;
  }

  for (;;) {
    ssize_t result;
    if (length == capacity) {
      size_t next_capacity = capacity * 2;
      char *next_buffer = realloc(buffer, next_capacity);
      if (next_buffer == NULL) {
        close(fd);
        free(buffer);
        return -1;
      }
      buffer = next_buffer;
      capacity = next_capacity;
    }

    result = read(fd, buffer + length, capacity - length);
    if (result < 0) {
      if (errno == EINTR) {
        continue;
      }
      close(fd);
      free(buffer);
      return -1;
    }
    if (result == 0) {
      break;
    }
    length += (size_t)result;
  }

  close(fd);
  *output = buffer;
  *output_size = length;
  return 0;
}

static int pm_read_environment_buffer(int pid, char **output, size_t *output_size) {
  return pm_linux_read_nul_file(pid, "environ", output, output_size);
}

static int pm_read_command_buffer(int pid, char **output, size_t *output_size) {
  return pm_linux_read_nul_file(pid, "cmdline", output, output_size);
}
#elif defined(__APPLE__)
static int pm_read_process_table(pm_process_table *table) {
  int pid_count = proc_listallpids(NULL, 0);
  pid_t *pids;
  int listed_count;

  if (pid_count <= 0) {
    return -1;
  }

  pids = calloc((size_t)pid_count, sizeof(*pids));
  if (pids == NULL) {
    return -1;
  }

  listed_count = proc_listallpids(pids, pid_count * (int)sizeof(*pids));
  if (listed_count <= 0) {
    free(pids);
    return -1;
  }

  for (int index = 0; index < listed_count; index++) {
    struct proc_bsdinfo process_info;
    pm_process_row row;
    char *terminal_name;
    dev_t terminal_device;

    if (pids[index] <= 0 ||
        proc_pidinfo(pids[index], PROC_PIDTBSDINFO, 0, &process_info, sizeof(process_info)) <= 0) {
      continue;
    }

    terminal_device = (dev_t)process_info.e_tdev;
    row.pid = (int)process_info.pbi_pid;
    row.parent_pid = (int)process_info.pbi_ppid;
    row.process_group_id = (int)process_info.pbi_pgid;
    row.terminal_id[0] = '\0';
    row.birth = (unsigned long long)process_info.pbi_start_tvsec * 1000000 + process_info.pbi_start_tvusec;

    if (terminal_device != NODEV) {
      terminal_name = devname(terminal_device, S_IFCHR);
      if (terminal_name != NULL) {
        snprintf(row.terminal_id, sizeof(row.terminal_id), "%s", terminal_name);
      }
    }

    if (row.pid > 0 && pm_table_push(table, row) != 0) {
      free(pids);
      return -1;
    }
  }

  free(pids);
  return 0;
}

static int pm_read_cwd(int pid, char *buffer, size_t size) {
  struct proc_vnodepathinfo path_info;
  int result = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &path_info, sizeof(path_info));

  if (result <= 0 || path_info.pvi_cdir.vip_path[0] == '\0') {
    return -1;
  }

  snprintf(buffer, size, "%s", path_info.pvi_cdir.vip_path);
  return 0;
}

static int pm_read_environment_buffer(int pid, char **output, size_t *output_size) {
  int argmax_mib[2] = {CTL_KERN, KERN_ARGMAX};
  int process_mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  int argmax = 0;
  size_t argmax_size = sizeof(argmax);
  size_t size;
  char *buffer;

  if (sysctl(argmax_mib, 2, &argmax, &argmax_size, NULL, 0) != 0 || argmax <= 0) {
    return -1;
  }

  size = (size_t)argmax;
  buffer = malloc(size);
  if (buffer == NULL) {
    return -1;
  }

  if (sysctl(process_mib, 3, buffer, &size, NULL, 0) != 0 || size == 0) {
    free(buffer);
    return -1;
  }

  *output = buffer;
  *output_size = size;
  return 0;
}
#else
static int pm_read_process_table(pm_process_table *table) {
  (void)table;
  return -1;
}

static int pm_read_cwd(int pid, char *buffer, size_t size) {
  (void)pid;
  (void)buffer;
  (void)size;
  return -1;
}

static int pm_read_environment_buffer(int pid, char **output, size_t *output_size) {
  (void)pid;
  (void)output;
  (void)output_size;
  return -1;
}
#endif

static int pm_read_network_id(int pid, char *buffer, size_t size) {
  char *environment;
  size_t environment_size;

  if (pm_read_environment_buffer(pid, &environment, &environment_size) != 0) {
    return -1;
  }

  for (size_t variable_index = 0; variable_index < sizeof(PM_NETWORK_VARIABLES) / sizeof(PM_NETWORK_VARIABLES[0]); variable_index++) {
    const char *name = PM_NETWORK_VARIABLES[variable_index];
    size_t name_length = strlen(name);
    size_t offset = 0;

    while (offset < environment_size) {
      const char *entry = environment + offset;
      size_t remaining = environment_size - offset;
      size_t entry_length = strnlen(entry, remaining);

      if (entry_length > name_length && entry[name_length] == '=' && strncmp(entry, name, name_length) == 0) {
        snprintf(buffer, size, "%s", entry + name_length + 1);
        free(environment);
        return buffer[0] == '\0' ? -1 : 0;
      }

      offset += entry_length + 1;
    }
  }

  free(environment);
  return -1;
}

/** Emits one NUL-delimited Linux proc file as a JSON string array. */
#if defined(__linux__)
static void pm_print_nul_json_array(const char *name, const char *buffer, size_t size) {
  size_t offset = 0;
  int printed = 0;

  printf(",\"%s\":[", name);
  while (buffer != NULL && offset < size) {
    const char *entry = buffer + offset;
    size_t remaining = size - offset;
    size_t length = strnlen(entry, remaining);
    if (length == remaining) {
      break;
    }
    if (length > 0) {
      if (printed++ > 0) {
        putchar(',');
      }
      pm_json_string(entry);
    }
    offset += length + 1;
  }
  putchar(']');
}
#endif

/*
 * Emits ,"argv":[...],"env":[...] for one pid, used by recovery/respawn
 * callers that need one coherent native capture. macOS KERN_PROCARGS2 embeds
 * both arrays; Linux exposes cmdline and environ as separate NUL files.
 */
static void pm_print_argv_env(int pid) {
#if defined(__linux__)
  char *argv_buffer = NULL;
  char *environment_buffer = NULL;
  size_t argv_size = 0;
  size_t environment_size = 0;

  (void)pm_read_command_buffer(pid, &argv_buffer, &argv_size);
  (void)pm_read_environment_buffer(pid, &environment_buffer, &environment_size);
  pm_print_nul_json_array("argv", argv_buffer, argv_size);
  pm_print_nul_json_array("env", environment_buffer, environment_size);
  free(argv_buffer);
  free(environment_buffer);
#else
  char *buffer = NULL;
  size_t size = 0;
  size_t offset;
  int arg_count;
  int printed;

  if (pm_read_environment_buffer(pid, &buffer, &size) != 0 || size < sizeof(int)) {
    fputs(",\"argv\":[],\"env\":[]", stdout);
    free(buffer);
    return;
  }

  memcpy(&arg_count, buffer, sizeof(int));
  offset = sizeof(int);

  /* Skip exec_path, then the NUL padding that precedes argv[0]. */
  while (offset < size && buffer[offset] != '\0') {
    offset++;
  }
  while (offset < size && buffer[offset] == '\0') {
    offset++;
  }

  fputs(",\"argv\":[", stdout);
  printed = 0;
  for (int index = 0; index < arg_count && offset < size; index++) {
    const char *entry = buffer + offset;
    size_t remaining = size - offset;
    size_t length = strnlen(entry, remaining);
    if (length == remaining) {
      break; /* no terminating NUL: truncated buffer */
    }
    if (printed++ > 0) {
      putchar(',');
    }
    pm_json_string(entry);
    offset += length + 1;
  }
  fputs("]", stdout);

  fputs(",\"env\":[", stdout);
  printed = 0;
  while (offset < size) {
    const char *entry = buffer + offset;
    size_t remaining = size - offset;
    size_t length = strnlen(entry, remaining);
    if (length == remaining) {
      break;
    }
    if (length > 0) {
      if (printed++ > 0) {
        putchar(',');
      }
      pm_json_string(entry);
    }
    offset += length + 1;
  }
  fputs("]", stdout);

  free(buffer);
#endif
}

static void pm_print_table(pm_process_table *table) {
  fputs("{\"rows\":[", stdout);
  for (size_t index = 0; index < table->count; index++) {
    if (index > 0) {
      putchar(',');
    }
    pm_print_row(&table->rows[index]);
  }
  fputs("]}\n", stdout);
}

static void pm_print_ancestor_pids(pm_process_table *table, const pm_process_row *row) {
  int seen[256];
  size_t seen_count = 0;
  const pm_process_row *cursor = row;
  int first = 1;

  putchar('[');
  seen[seen_count++] = row->pid;
  while (cursor->parent_pid > 0 && seen_count < sizeof(seen) / sizeof(seen[0])) {
    int already_seen = 0;
    pm_process_row *parent = pm_find_row(table, cursor->parent_pid);
    if (parent == NULL) {
      break;
    }

    for (size_t index = 0; index < seen_count; index++) {
      if (seen[index] == parent->pid) {
        already_seen = 1;
        break;
      }
    }
    if (already_seen) {
      break;
    }

    if (!first) {
      putchar(',');
    }
    printf("%d", parent->pid);
    first = 0;
    seen[seen_count++] = parent->pid;
    cursor = parent;
  }
  putchar(']');
}

static void pm_print_inspect(pm_process_table *table, int pid, int include_args) {
  pm_process_row *row = pm_find_row(table, pid);
  char cwd[PM_TEXT_SIZE] = "";
  char network_id[PM_TEXT_SIZE] = "";

  printf("{\"pid\":%d", pid);
  if (row != NULL) {
    if (row->birth != 0) printf(",\"birth\":%llu", row->birth);
    fputs(",\"row\":", stdout);
    pm_print_row(row);
    fputs(",\"ancestorPids\":", stdout);
    pm_print_ancestor_pids(table, row);
  }
  if (pm_read_cwd(pid, cwd, sizeof(cwd)) == 0) {
    fputs(",\"cwd\":", stdout);
    pm_json_string(cwd);
  }
  if (pm_read_network_id(pid, network_id, sizeof(network_id)) == 0) {
    fputs(",\"networkId\":", stdout);
    pm_json_string(network_id);
  }
  if (include_args) {
    /* argv/env are only emitted for `capture` so `inspect` stays compact. */
    pm_print_argv_env(pid);
  }
  fputs("}\n", stdout);
}

/* Security identity queries must not enumerate every process, resolve TTY
 * names, or read an environment. A disappeared PID simply has no identity. */
static int pm_print_identity(int pid) {
  unsigned long long birth = 0;
#if defined(__APPLE__)
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info) && info.pbi_uid == geteuid()) {
    birth = (unsigned long long)info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec;
  }
#elif defined(__linux__)
  char filename[64], text[4096];
  snprintf(filename, sizeof(filename), "/proc/%d/stat", pid);
  struct stat stats;
  FILE *file = stat(filename, &stats) == 0 && stats.st_uid == geteuid() ? fopen(filename, "r") : NULL;
  if (file != NULL) {
    if (fgets(text, sizeof(text), file) != NULL) {
      char *cursor = strrchr(text, ')');
      if (cursor != NULL) cursor += 2;
      for (int field = 3; field < 22 && cursor != NULL; field++) {
        cursor = strchr(cursor, ' '); if (cursor != NULL) cursor++;
      }
      if (cursor != NULL) birth = strtoull(cursor, NULL, 10);
    }
    fclose(file);
  }
#endif
  if (birth == 0) return 1;
  printf("{\"pid\":%d,\"birth\":%llu}\n", pid, birth);
  return 0;
}

/* Descriptor measurements never enumerate vnode metadata or read argv/env.
 * Check the target identity on both sides of the kernel descriptor snapshot;
 * an exited or reused PID is an error, never a fabricated zero measurement. */
#if defined(__APPLE__)
static int pm_fd_measurement_identity(int pid, unsigned long long *birth) {
  struct proc_bsdinfo info;
  errno = 0;
  int result = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (result != sizeof(info)) return errno != 0 ? errno : EIO;
  if (info.pbi_uid != geteuid()) return EPERM;
  if (info.pbi_status == SZOMB) return ESRCH;
  *birth = (unsigned long long)info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec;
  return *birth == 0 ? EIO : 0;
}

static int pm_measure_descriptor_count(int pid, unsigned long long expected_birth,
                                       unsigned long long *birth, size_t *count) {
  int error = pm_fd_measurement_identity(pid, birth);
  if (error != 0) return error;
  if (expected_birth != 0 && expected_birth != *birth) return ESTALE;
  errno = 0;
  int needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (needed < 0 || (needed == 0 && errno != 0)) return errno != 0 ? errno : EIO;
  const size_t row_size = sizeof(struct proc_fdinfo), maximum_rows = 1048576;
  if ((size_t)needed % row_size != 0 || (size_t)needed / row_size > maximum_rows - 32) return EOVERFLOW;
  size_t rows = (size_t)needed / row_size + 32;
  if (rows < 64) rows = 64;
  error = EAGAIN;
  for (int attempt = 0; attempt < 4; attempt++) {
    size_t capacity = rows * row_size;
    struct proc_fdinfo *descriptors = malloc(capacity);
    if (descriptors == NULL) return ENOMEM;
    errno = 0;
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, descriptors, (int)capacity);
    int query_error = errno;
    free(descriptors);
    if (bytes < 0 || (bytes == 0 && query_error != 0)) return query_error != 0 ? query_error : EIO;
    if ((size_t)bytes > capacity || (size_t)bytes % row_size != 0) return EIO;
    if ((size_t)bytes < capacity) {
      *count = (size_t)bytes / row_size;
      error = 0;
      break;
    }
    /* A full buffer may have truncated newly opened descriptors. Grow within
     * a fixed bound rather than reporting the truncated count as complete. */
    if (rows > maximum_rows / 2) return EOVERFLOW;
    rows *= 2;
  }
  if (error != 0) return error;
  unsigned long long after = 0;
  error = pm_fd_measurement_identity(pid, &after);
  if (error != 0) return error;
  return after == *birth ? 0 : ESTALE;
}
#endif

static int pm_print_descriptor_count(int pid, unsigned long long expected_birth) {
  unsigned long long birth = 0;
  size_t count = 0;
  int error = ENOTSUP;
#if defined(__APPLE__)
  error = pm_measure_descriptor_count(pid, expected_birth, &birth, &count);
#else
  (void)expected_birth;
#endif
  printf("{\"pid\":%d", pid);
  if (birth != 0) printf(",\"birth\":%llu", birth);
  if (error == 0) printf(",\"fdCount\":%zu", count);
  printf(",\"error\":%d}\n", error);
  return error == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
  pm_process_table table = {0};
  int result = 0;

  if (argc >= 2 && strcmp(argv[1], "fd-count") == 0) {
    if ((argc != 3 && argc != 4) || !isdigit((unsigned char)argv[2][0])) return 2;
    char *end;
    errno = 0;
    long pid = strtol(argv[2], &end, 10);
    if (errno != 0 || *end != '\0' || pid <= 1 || pid > INT_MAX) return 2;
    unsigned long long birth = 0;
    if (argc == 4) {
      if (!isdigit((unsigned char)argv[3][0])) return 2;
      errno = 0;
      birth = strtoull(argv[3], &end, 10);
      if (errno != 0 || *end != '\0' || birth == 0) return 2;
    }
    return pm_print_descriptor_count((int)pid, birth);
  }

  if (argc >= 2 && strcmp(argv[1], "signal") == 0) {
    if (argc != 5 || !pm_is_positive_pid_text(argv[2]) || !isdigit((unsigned char)argv[3][0])) return 2;
    char *end; errno = 0; long pid = strtol(argv[2], &end, 10);
    if (errno != 0 || *end != '\0' || pid <= 1 || pid > INT_MAX) return 2;
    errno = 0; unsigned long long birth = strtoull(argv[3], &end, 10);
    if (errno != 0 || *end != '\0' || birth == 0) return 2;
    int number = strcmp(argv[4], "SIGTERM") == 0 ? SIGTERM : strcmp(argv[4], "SIGHUP") == 0 ? SIGHUP :
      strcmp(argv[4], "SIGINT") == 0 ? SIGINT : strcmp(argv[4], "SIGKILL") == 0 ? SIGKILL : 0;
    if (number == 0) return 2;
    int sent = 0, error = ENOTSUP;
#if defined(__APPLE__)
    sent = pm_audit_signal_birth((pid_t)pid, birth, number) == 0; error = sent ? 0 : errno;
#endif
    printf("{\"pid\":%ld,\"birth\":%llu,\"signal\":\"%s\",\"sent\":%s,\"error\":%d}\n", pid, birth, argv[4], sent ? "true" : "false", error);
    return sent ? 0 : 1;
  }

  if (argc == 3 && strcmp(argv[1], "identity") == 0) {
    char *end; errno = 0;
    long pid = strtol(argv[2], &end, 10);
    return errno == 0 && *end == '\0' && pid > 1 && pid <= INT_MAX ? pm_print_identity((int)pid) : 2;
  }

  if (argc < 2) {
    fprintf(stderr, "usage: portmanager_process_lookup list|inspect <pid>\n");
    return 2;
  }

  if (pm_read_process_table(&table) != 0) {
    fprintf(stderr, "process table lookup failed: %s\n", strerror(errno));
    return 3;
  }

  if (strcmp(argv[1], "list") == 0) {
    pm_print_table(&table);
  } else if (strcmp(argv[1], "inspect") == 0 && argc == 3 && pm_is_positive_pid_text(argv[2])) {
    pm_print_inspect(&table, atoi(argv[2]), 0);
  } else if (strcmp(argv[1], "capture") == 0 && argc == 3 && pm_is_positive_pid_text(argv[2])) {
    /* Adds argv/env for composing an exact escaped-server respawn. */
    pm_print_inspect(&table, atoi(argv[2]), 1);
  } else {
    fprintf(stderr, "usage: portmanager_process_lookup list|inspect|capture <pid>\n");
    result = 2;
  }

  free(table.rows);
  return result;
}

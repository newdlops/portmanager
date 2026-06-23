#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <libproc.h>
#include <sys/param.h>
#include <sys/sysctl.h>
#include <sys/user.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <sys/sysmacros.h>
#endif

#define PM_TEXT_SIZE 4096
#define PM_TTY_SIZE 128

typedef struct pm_process_row {
  int pid;
  int parent_pid;
  int process_group_id;
  char terminal_id[PM_TTY_SIZE];
} pm_process_row;

typedef struct pm_process_table {
  pm_process_row *rows;
  size_t count;
  size_t capacity;
} pm_process_table;

static const char *PM_NETWORK_VARIABLES[] = {
  "PORT_MANAGER_NETWORK_ID",
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

static int pm_read_environment_buffer(int pid, char **output, size_t *output_size) {
  char path[PATH_MAX];
  int fd;
  size_t capacity = PM_TEXT_SIZE;
  size_t length = 0;
  char *buffer = malloc(capacity);

  if (buffer == NULL) {
    return -1;
  }

  snprintf(path, sizeof(path), "/proc/%d/environ", pid);
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
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  char *buffer;

  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size == 0) {
    return -1;
  }

  buffer = malloc(size);
  if (buffer == NULL) {
    return -1;
  }

  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0) {
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

static void pm_print_inspect(pm_process_table *table, int pid) {
  pm_process_row *row = pm_find_row(table, pid);
  char cwd[PM_TEXT_SIZE] = "";
  char network_id[PM_TEXT_SIZE] = "";

  printf("{\"pid\":%d", pid);
  if (row != NULL) {
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
  fputs("}\n", stdout);
}

int main(int argc, char **argv) {
  pm_process_table table = {0};
  int result = 0;

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
    pm_print_inspect(&table, atoi(argv[2]));
  } else {
    fprintf(stderr, "usage: portmanager_process_lookup list|inspect <pid>\n");
    result = 2;
  }

  free(table.rows);
  return result;
}

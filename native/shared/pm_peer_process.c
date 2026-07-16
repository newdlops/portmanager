/*
 * See pm_peer_process.h for the module contract.
 *
 * The environment scan for the network scope mirrors the standalone
 * portmanager_process_lookup helper on purpose: both must agree on the variable
 * precedence, and this module stays self-contained so the router links one
 * extra object rather than the whole lookup binary. A later daemon
 * consolidation (SPEC 0.6) can merge the two readers.
 */

#include "pm_peer_process.h"

#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

#if defined(__APPLE__)
#include <libproc.h>
#include <netinet/in.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#elif defined(__linux__)
#include <ctype.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <unistd.h>
#endif

/* Environment variables that carry the Port Manager network scope, in priority order. */
static const char *PM_NETWORK_VARIABLES[] = {
    "PORT_MANAGER_NETWORK_ID",
    "PORT_MANAGER_ROUTE_TABLE_NETWORK_ID",
    "PORT_MANAGER_BORROWED_NETWORK_ID",
    "NEWDLOPS_PM_NETWORK_ID",
    "NEWDLOPS_PM_BORROWED_NETWORK_ID",
};

/* Self process plus four ancestors: deep enough for shell -> tool -> child chains. */
#define PM_PEER_MAX_ANCESTRY 5

/* Scans a NUL-delimited environment blob for the first network scope variable. */
static int pm_scan_environment_for_network_id(
    const char *environment,
    size_t environment_size,
    char *buffer,
    size_t size) {
  for (size_t variable_index = 0;
       variable_index < sizeof(PM_NETWORK_VARIABLES) / sizeof(PM_NETWORK_VARIABLES[0]);
       variable_index++) {
    const char *name = PM_NETWORK_VARIABLES[variable_index];
    size_t name_length = strlen(name);
    size_t offset = 0;

    while (offset < environment_size) {
      const char *entry = environment + offset;
      size_t remaining = environment_size - offset;
      size_t entry_length = strnlen(entry, remaining);

      if (entry_length > name_length && entry[name_length] == '=' && strncmp(entry, name, name_length) == 0) {
        snprintf(buffer, size, "%s", entry + name_length + 1);
        return buffer[0] == '\0' ? -1 : 0;
      }

      offset += entry_length + 1;
    }
  }

  return -1;
}

#if defined(__APPLE__)

static int pm_peer_read_environment_buffer(int pid, char **output, size_t *output_size) {
  int argmax_mib[2] = {CTL_KERN, KERN_ARGMAX};
  int process_mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  int argmax = 0;
  size_t argmax_size = sizeof(argmax);
  size_t size;
  char *buffer;

  /*
   * Allocate the kernel argument ceiling rather than querying this process'
   * current byte count first. The target may exec between two sysctl calls;
   * KERN_ARGMAX keeps the second read from returning a truncated argv/env tail.
   */
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

static int pm_peer_bsdinfo(int pid, struct proc_bsdinfo *info) {
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == (int)sizeof(*info) ? 0 : -1;
}

static int pm_peer_parent_pid(int pid) {
  struct proc_bsdinfo info;
  return pm_peer_bsdinfo(pid, &info) == 0 ? (int)info.pbi_ppid : -1;
}

static long pm_peer_start_time_seconds(int pid) {
  struct proc_bsdinfo info;
  return pm_peer_bsdinfo(pid, &info) == 0 ? (long)info.pbi_start_tvsec : 0;
}

/* True when host parses to the given IPv4 socket address (network byte order). */
static int pm_peer_matches_ipv4(const char *host, uint32_t s_addr) {
  struct in_addr parsed;
  if (host == NULL || inet_pton(AF_INET, host, &parsed) != 1) {
    return -1; /* unparseable: caller decides */
  }
  return parsed.s_addr == s_addr ? 1 : 0;
}

static int pm_peer_matches_ipv6(const char *host, const struct in6_addr *addr) {
  struct in6_addr parsed;
  if (host == NULL || inet_pton(AF_INET6, host, &parsed) != 1) {
    return -1;
  }
  return memcmp(&parsed, addr, sizeof(parsed)) == 0 ? 1 : 0;
}

/* Tests one socket's endpoints against the client we are attributing. */
static int pm_peer_socket_matches(
    const struct in_sockinfo *info,
    const char *client_local_host,
    int client_local_port,
    const char *client_foreign_host,
    int client_foreign_port) {
  if (ntohs((uint16_t)info->insi_lport) != client_local_port ||
      ntohs((uint16_t)info->insi_fport) != client_foreign_port) {
    return 0;
  }

  /*
   * The loopback (lport,fport) pair is effectively unique, but the address is
   * still verified when it parses so a cross-family port collision cannot
   * mis-attribute. A -1 (unparseable target) is treated as "do not reject".
   */
  if ((info->insi_vflag & INI_IPV4) != 0) {
    int local_match = pm_peer_matches_ipv4(client_local_host, info->insi_laddr.ina_46.i46a_addr4.s_addr);
    int foreign_match = pm_peer_matches_ipv4(client_foreign_host, info->insi_faddr.ina_46.i46a_addr4.s_addr);
    return local_match != 0 && foreign_match != 0;
  }
  if ((info->insi_vflag & INI_IPV6) != 0) {
    int local_match = pm_peer_matches_ipv6(client_local_host, &info->insi_laddr.ina_6);
    int foreign_match = pm_peer_matches_ipv6(client_foreign_host, &info->insi_faddr.ina_6);
    return local_match != 0 && foreign_match != 0;
  }
  return 1;
}

/*
 * Finds the pid owning the client socket via public libproc APIs.
 *
 * pcblist_n would be one syscall, but its records are XNU-private structs the
 * SDK does not ship. proc_pidfdinfo(PROC_PIDFDSOCKETINFO) uses the stable
 * public socket_fdinfo instead: iterate each process' socket fds and match the
 * connection endpoints. The scan early-exits on the owning process, and the
 * TypeScript layer caches the verdict per pid so repeat connections do not
 * re-scan.
 */
int pm_peer_resolve_client_pid(
    const char *client_local_host,
    int client_local_port,
    const char *client_foreign_host,
    int client_foreign_port,
    long *out_start_time_seconds) {
  int pid_capacity;
  pid_t *pids;
  int listed_bytes;
  int listed_count;
  int resolved_pid = -1;

  if (client_local_port <= 0 || client_foreign_port <= 0) {
    return -1;
  }

  pid_capacity = proc_listallpids(NULL, 0);
  if (pid_capacity <= 0) {
    return -1;
  }
  pids = calloc((size_t)pid_capacity, sizeof(*pids));
  if (pids == NULL) {
    return -1;
  }
  listed_bytes = proc_listallpids(pids, pid_capacity * (int)sizeof(*pids));
  if (listed_bytes <= 0) {
    free(pids);
    return -1;
  }
  listed_count = listed_bytes / (int)sizeof(*pids);

  for (int index = 0; index < listed_count && resolved_pid < 0; index++) {
    int pid = pids[index];
    struct proc_fdinfo *fds;
    int fd_bytes;
    int fd_count;

    if (pid <= 0) {
      continue;
    }
    fd_bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (fd_bytes <= 0) {
      continue;
    }
    fds = malloc((size_t)fd_bytes);
    if (fds == NULL) {
      continue;
    }
    fd_bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, fd_bytes);
    if (fd_bytes <= 0) {
      free(fds);
      continue;
    }
    fd_count = fd_bytes / (int)sizeof(struct proc_fdinfo);

    for (int fd_index = 0; fd_index < fd_count; fd_index++) {
      struct socket_fdinfo socket_info;
      const struct in_sockinfo *info;

      if (fds[fd_index].proc_fdtype != PROX_FDTYPE_SOCKET) {
        continue;
      }
      if (proc_pidfdinfo(pid, fds[fd_index].proc_fd, PROC_PIDFDSOCKETINFO, &socket_info, sizeof(socket_info)) !=
          (int)sizeof(socket_info)) {
        continue;
      }
      if (socket_info.psi.soi_kind == SOCKINFO_TCP) {
        info = &socket_info.psi.soi_proto.pri_tcp.tcpsi_ini;
      } else if (socket_info.psi.soi_kind == SOCKINFO_IN) {
        info = &socket_info.psi.soi_proto.pri_in;
      } else {
        continue;
      }

      if (pm_peer_socket_matches(info, client_local_host, client_local_port, client_foreign_host, client_foreign_port)) {
        resolved_pid = pid;
        break;
      }
    }

    free(fds);
  }

  free(pids);

  if (resolved_pid <= 0) {
    return -1;
  }
  if (out_start_time_seconds != NULL) {
    *out_start_time_seconds = pm_peer_start_time_seconds(resolved_pid);
  }
  return resolved_pid;
}

#elif defined(__linux__)

static int pm_peer_read_environment_buffer(int pid, char **output, size_t *output_size) {
  char path[64];
  int fd;
  size_t capacity = 8192;
  size_t used = 0;
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
    if (used == capacity) {
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
    result = read(fd, buffer + used, capacity - used);
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
    used += (size_t)result;
  }

  close(fd);
  *output = buffer;
  *output_size = used;
  return 0;
}

/* Returns the token after the last ')' at the given zero-based index of /proc/pid/stat. */
static int pm_peer_read_stat_token(int pid, int token_index, char *out, size_t out_size) {
  char path[64];
  FILE *file;
  char line[4096];
  char *cursor;
  int index = 0;
  char *token;
  char *saveptr = NULL;

  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  file = fopen(path, "r");
  if (file == NULL) {
    return -1;
  }
  if (fgets(line, sizeof(line), file) == NULL) {
    fclose(file);
    return -1;
  }
  fclose(file);

  cursor = strrchr(line, ')');
  if (cursor == NULL || cursor[1] == '\0') {
    return -1;
  }
  cursor += 1; /* fields after comm start here: state, ppid, ... */

  for (token = strtok_r(cursor, " \t\n", &saveptr); token != NULL; token = strtok_r(NULL, " \t\n", &saveptr)) {
    if (index == token_index) {
      snprintf(out, out_size, "%s", token);
      return 0;
    }
    index++;
  }
  return -1;
}

static int pm_peer_parent_pid(int pid) {
  char token[32];
  /* Field order after comm: state(0) ppid(1) ... */
  if (pm_peer_read_stat_token(pid, 1, token, sizeof(token)) != 0) {
    return -1;
  }
  return atoi(token);
}

static long pm_peer_start_time_seconds(int pid) {
  char token[64];
  long ticks_per_second = sysconf(_SC_CLK_TCK);
  /* starttime is field 22 (1-based); after comm it is index 19. */
  if (ticks_per_second <= 0 || pm_peer_read_stat_token(pid, 19, token, sizeof(token)) != 0) {
    return 0;
  }
  return strtol(token, NULL, 10) / ticks_per_second;
}

/* Finds the socket inode for one loopback TCP 4-tuple in /proc/net/tcp{,6}. */
static long pm_peer_socket_inode(
    const char *proc_path,
    int is_ipv6,
    const char *client_local_host,
    int client_local_port,
    int client_foreign_port) {
  FILE *file = fopen(proc_path, "r");
  char line[512];
  long inode = -1;
  uint32_t local_ipv4 = 0;
  int have_local_ipv4 = 0;

  if (file == NULL) {
    return -1;
  }
  if (!is_ipv6 && client_local_host != NULL) {
    struct in_addr parsed;
    if (inet_pton(AF_INET, client_local_host, &parsed) == 1) {
      local_ipv4 = parsed.s_addr;
      have_local_ipv4 = 1;
    }
  }

  /* Skip the header line. */
  if (fgets(line, sizeof(line), file) == NULL) {
    fclose(file);
    return -1;
  }

  while (fgets(line, sizeof(line), file) != NULL) {
    char local[128];
    char remote[128];
    char *tokens[16];
    int token_count = 0;
    char *token;
    char *saveptr = NULL;
    unsigned int local_addr_hex = 0;
    unsigned int local_port_hex = 0;
    unsigned int remote_port_hex = 0;

    for (token = strtok_r(line, " \t\n", &saveptr); token != NULL && token_count < 16;
         token = strtok_r(NULL, " \t\n", &saveptr)) {
      tokens[token_count++] = token;
    }
    if (token_count < 10) {
      continue;
    }

    snprintf(local, sizeof(local), "%s", tokens[1]);
    snprintf(remote, sizeof(remote), "%s", tokens[2]);

    char *local_port_text = strchr(local, ':');
    char *remote_port_text = strchr(remote, ':');
    if (local_port_text == NULL || remote_port_text == NULL) {
      continue;
    }
    *local_port_text = '\0';
    local_port_text += 1;
    *remote_port_text = '\0';
    remote_port_text += 1;

    local_port_hex = (unsigned int)strtoul(local_port_text, NULL, 16);
    remote_port_hex = (unsigned int)strtoul(remote_port_text, NULL, 16);
    if ((int)local_port_hex != client_local_port || (int)remote_port_hex != client_foreign_port) {
      continue;
    }

    /* IPv6 loopback attribution relies on the unique port pair; verify IPv4 address. */
    if (!is_ipv6 && have_local_ipv4) {
      local_addr_hex = (unsigned int)strtoul(local, NULL, 16);
      if ((uint32_t)local_addr_hex != local_ipv4) {
        continue;
      }
    }

    inode = strtol(tokens[9], NULL, 10);
    break;
  }

  fclose(file);
  return inode;
}

/* Scans /proc/<pid>/fd for a socket referencing the given inode. */
static int pm_peer_pid_for_inode(long inode) {
  DIR *proc = opendir("/proc");
  struct dirent *proc_entry;
  char target[64];
  int found_pid = -1;

  if (proc == NULL) {
    return -1;
  }
  snprintf(target, sizeof(target), "socket:[%ld]", inode);

  while ((proc_entry = readdir(proc)) != NULL && found_pid < 0) {
    char fd_path[128];
    DIR *fd_dir;
    struct dirent *fd_entry;
    int pid;

    if (proc_entry->d_name[0] < '1' || proc_entry->d_name[0] > '9') {
      continue;
    }
    pid = atoi(proc_entry->d_name);
    if (pid <= 0) {
      continue;
    }

    snprintf(fd_path, sizeof(fd_path), "/proc/%d/fd", pid);
    fd_dir = opendir(fd_path);
    if (fd_dir == NULL) {
      continue;
    }

    while ((fd_entry = readdir(fd_dir)) != NULL) {
      char link_path[192];
      char link_target[64];
      ssize_t link_length;

      snprintf(link_path, sizeof(link_path), "%s/%s", fd_path, fd_entry->d_name);
      link_length = readlink(link_path, link_target, sizeof(link_target) - 1);
      if (link_length <= 0) {
        continue;
      }
      link_target[link_length] = '\0';
      if (strcmp(link_target, target) == 0) {
        found_pid = pid;
        break;
      }
    }

    closedir(fd_dir);
  }

  closedir(proc);
  return found_pid;
}

int pm_peer_resolve_client_pid(
    const char *client_local_host,
    int client_local_port,
    const char *client_foreign_host,
    int client_foreign_port,
    long *out_start_time_seconds) {
  int is_ipv6 = client_local_host != NULL && strchr(client_local_host, ':') != NULL;
  const char *proc_path = is_ipv6 ? "/proc/net/tcp6" : "/proc/net/tcp";
  long inode;
  int pid;

  (void)client_foreign_host;
  if (client_local_port <= 0 || client_foreign_port <= 0) {
    return -1;
  }

  inode = pm_peer_socket_inode(proc_path, is_ipv6, client_local_host, client_local_port, client_foreign_port);
  if (inode < 0) {
    return -1;
  }

  pid = pm_peer_pid_for_inode(inode);
  if (pid <= 0) {
    return -1;
  }

  if (out_start_time_seconds != NULL) {
    *out_start_time_seconds = pm_peer_start_time_seconds(pid);
  }
  return pid;
}

#else /* unsupported platform */

static int pm_peer_read_environment_buffer(int pid, char **output, size_t *output_size) {
  (void)pid;
  (void)output;
  (void)output_size;
  return -1;
}

static int pm_peer_parent_pid(int pid) {
  (void)pid;
  return -1;
}

int pm_peer_resolve_client_pid(
    const char *client_local_host,
    int client_local_port,
    const char *client_foreign_host,
    int client_foreign_port,
    long *out_start_time_seconds) {
  (void)client_local_host;
  (void)client_local_port;
  (void)client_foreign_host;
  (void)client_foreign_port;
  (void)out_start_time_seconds;
  return -1;
}

#endif

/*
 * KERN_PROCARGS2 prefixes the environment with argc, the executable path, and
 * argv. Linux /proc already exposes only environment entries. Keeping this
 * boundary here lets every caller use the same NUL-delimited entry view.
 */
static int pm_peer_environment_entries(
    const char *buffer,
    size_t buffer_size,
    const char **environment,
    size_t *environment_size) {
  size_t offset = 0;

  if (buffer == NULL || environment == NULL || environment_size == NULL) {
    return -1;
  }

#if defined(__APPLE__)
  int argument_count;

  if (buffer_size < sizeof(argument_count)) {
    return -1;
  }
  memcpy(&argument_count, buffer, sizeof(argument_count));
  if (argument_count < 0) {
    return -1;
  }
  offset = sizeof(argument_count);

  /* Skip executable path and the padding between it and argv[0]. */
  while (offset < buffer_size && buffer[offset] != '\0') {
    offset++;
  }
  while (offset < buffer_size && buffer[offset] == '\0') {
    offset++;
  }

  for (int index = 0; index < argument_count; index++) {
    size_t remaining;
    size_t length;

    if (offset >= buffer_size) {
      return -1;
    }
    remaining = buffer_size - offset;
    length = strnlen(buffer + offset, remaining);
    if (length == remaining) {
      return -1;
    }
    offset += length + 1;
  }
#endif

  if (offset > buffer_size) {
    return -1;
  }
  *environment = buffer + offset;
  *environment_size = buffer_size - offset;
  return 0;
}

int pm_peer_read_environment_text(
    int pid,
    const char *const *names,
    size_t name_count,
    char *buffer,
    size_t size) {
  char *process_buffer = NULL;
  size_t process_buffer_size = 0;
  const char *environment = NULL;
  size_t environment_size = 0;
  size_t offset = 0;
  size_t used = 0;

  if (names == NULL || name_count == 0 || buffer == NULL || size == 0 || pid <= 0) {
    return -1;
  }
  buffer[0] = '\0';

  if (pm_peer_read_environment_buffer(pid, &process_buffer, &process_buffer_size) != 0 ||
      pm_peer_environment_entries(process_buffer, process_buffer_size, &environment, &environment_size) != 0) {
    free(process_buffer);
    return -1;
  }
  /* A leading separator identifies the exact-entry format even when none of
   * the selected variables exist. That successful empty selection must not
   * fall back to ps for an unrelated, directly readable process. */
  if (size < 2) {
    free(process_buffer);
    return -1;
  }
  buffer[used++] = PM_PEER_ENVIRONMENT_ENTRY_SEPARATOR;
  buffer[used] = '\0';

  while (offset < environment_size) {
    const char *entry = environment + offset;
    size_t remaining = environment_size - offset;
    size_t entry_length = strnlen(entry, remaining);
    int selected = 0;

    if (entry_length == remaining) {
      buffer[0] = '\0';
      free(process_buffer);
      return -1;
    }
    for (size_t name_index = 0; name_index < name_count && !selected; name_index++) {
      size_t name_length = strlen(names[name_index]);
      selected = entry_length > name_length && entry[name_length] == '=' &&
        strncmp(entry, names[name_index], name_length) == 0;
    }
    if (selected) {
      size_t separator_length = used > 1 ? 1 : 0;
      if (used + separator_length + entry_length + 1 > size) {
        buffer[0] = '\0';
        free(process_buffer);
        return -1;
      }
      if (separator_length != 0) {
        buffer[used++] = PM_PEER_ENVIRONMENT_ENTRY_SEPARATOR;
      }
      for (size_t entry_index = 0; entry_index < entry_length; entry_index++) {
        /* Reserve the separator byte for framing; it has no meaningful role
         * in Port Manager's selected routing values. */
        buffer[used++] = entry[entry_index] == PM_PEER_ENVIRONMENT_ENTRY_SEPARATOR
          ? '?'
          : entry[entry_index];
      }
      buffer[used] = '\0';
    }
    offset += entry_length + 1;
  }

  free(process_buffer);
  return 0;
}

/* Reads the network scope from one process' environment, ancestors excluded. */
static int pm_peer_read_network_id_self(int pid, char *buffer, size_t size) {
  char *environment = NULL;
  size_t environment_size = 0;
  const char *entries = NULL;
  size_t entries_size = 0;
  int result;

  if (pm_peer_read_environment_buffer(pid, &environment, &environment_size) != 0) {
    return -1;
  }

  if (pm_peer_environment_entries(environment, environment_size, &entries, &entries_size) != 0) {
    free(environment);
    return -1;
  }

  result = pm_scan_environment_for_network_id(entries, entries_size, buffer, size);
  free(environment);
  return result;
}

int pm_peer_read_network_id(int pid, char *buffer, size_t size) {
  int current = pid;

  for (int depth = 0; depth < PM_PEER_MAX_ANCESTRY && current > 1; depth++) {
    int parent;

    if (pm_peer_read_network_id_self(current, buffer, size) == 0) {
      return 0;
    }

    parent = pm_peer_parent_pid(current);
    if (parent <= 1 || parent == current) {
      break;
    }
    current = parent;
  }

  return -1;
}

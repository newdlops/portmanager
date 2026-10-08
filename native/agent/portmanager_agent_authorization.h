#ifndef PORTMANAGER_AGENT_AUTHORIZATION_H
#define PORTMANAGER_AGENT_AUTHORIZATION_H

#include "../shared/pm_network_namespace.h"
#include <pwd.h>
#include <arpa/inet.h>
#include <limits.h>
#if defined(__APPLE__)
#include <libproc.h>
#include <sys/proc_info.h>
#elif defined(__linux__)
#include <dirent.h>
#endif

/* Private keys are supplied by the trusted extension/CLI, never by workload
 * environment. This header keeps the small authorization boundary separate
 * from registry and transport scheduling, without another link dependency. */
#define PM_AUTH_MAX_PROCESS_SCOPES 8192
typedef struct {
  pid_t pid;
  unsigned long long birth;
  char network_id[128];
  /* Set only by a controller before exec or by observed trusted ancestry. */
  int controller_scope;
} pm_authenticated_scope;
typedef struct {
  char controller_path[PM_TEXT];
  char controller_token[65];
  pm_authenticated_scope *scopes;
  size_t count;
} pm_authorization;

static unsigned long long pm_auth_process_birth(pid_t pid) {
#if defined(__APPLE__)
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
  return (unsigned long long)info.pbi_start_tvsec * 1000000ULL + info.pbi_start_tvusec;
#elif defined(__linux__)
  char file[64], text[4096];
  snprintf(file, sizeof(file), "/proc/%ld/stat", (long)pid);
  int fd = open(file, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t length = read(fd, text, sizeof(text) - 1);
  close(fd);
  if (length <= 0) return 0;
  text[length] = '\0';
  char *cursor = strrchr(text, ')');
  if (cursor == NULL) return 0;
  cursor += 2;
  for (int field = 3; field < 22; field++) {
    cursor = strchr(cursor, ' ');
    if (cursor == NULL) return 0;
    cursor++;
  }
  return strtoull(cursor, NULL, 10);
#else
  (void)pid;
  return 0;
#endif
}

/* Walk directory descriptors: O_NOFOLLOW on the leaf alone would still allow
 * a swapped parent symlink to redirect a controller key into shared source. */
static int pm_auth_read_key(const char *file, char *out, size_t capacity) {
  char copy[PM_TEXT];
  if (file[0] != '/' || strlen(file) >= sizeof(copy)) return -1;
  snprintf(copy, sizeof(copy), "%s", file);
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (directory < 0) return -1;
  char *save = NULL, *component = strtok_r(copy, "/", &save);
  int fd = -1;
  while (component != NULL) {
    char *next = strtok_r(NULL, "/", &save);
    if (strcmp(component, ".") == 0 || strcmp(component, "..") == 0) break;
    if (next == NULL) {
      struct stat parent;
      if (fstat(directory, &parent) != 0 || parent.st_uid != geteuid() || (parent.st_mode & 077) != 0) break;
      fd = openat(directory, component, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
      break;
    }
    int next_fd = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(directory);
    directory = next_fd;
    if (directory < 0) break;
    component = next;
  }
  if (directory >= 0) close(directory);
  if (fd < 0) return -1;
  struct stat info;
  int valid = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == geteuid() &&
    (info.st_mode & 077) == 0 && info.st_size >= 65 && (size_t)info.st_size < capacity;
  ssize_t length = valid ? read(fd, out, capacity - 1) : -1;
  close(fd);
  if (!valid || length != info.st_size || memchr(out, '\0', (size_t)length) != NULL) return -1;
  out[length] = '\0';
  return 0;
}

static int pm_auth_token_matches(const char *expected, const char *supplied) {
  if (strlen(supplied) != 64) return 0;
  unsigned int difference = 0;
  for (size_t index = 0; index < 64; index++) {
    unsigned char ch = (unsigned char)supplied[index];
    if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return 0;
    difference |= (unsigned char)expected[index] ^ ch;
  }
  return difference == 0;
}

static int pm_auth_init(pm_authorization *auth, const char *file, const char *socket_path) {
  memset(auth, 0, sizeof(*auth));
  if (file[0] != '\0') snprintf(auth->controller_path, sizeof(auth->controller_path), "%s", file);
  else {
    struct passwd *account = getpwuid(geteuid());
    char key[225];
    size_t length = strlen(socket_path);
    if (account == NULL || length == 0 || length > 112) return -1;
    for (size_t index = 0; index < length; index++) snprintf(key + index * 2, 3, "%02x", (unsigned char)socket_path[index]);
    int written = snprintf(auth->controller_path, sizeof(auth->controller_path), "%s/.portmanager/security/agent-control/%s.key", account->pw_dir, key);
    if (written < 0 || (size_t)written >= sizeof(auth->controller_path)) return -1;
  }
  char contents[83];
  if (pm_auth_read_key(auth->controller_path, contents, sizeof(contents)) != 0 || strlen(contents) != 65 || contents[64] != '\n') return -1;
  contents[64] = '\0';
  if (!pm_auth_token_matches(contents, contents)) return -1;
  memcpy(auth->controller_token, contents, 65);
  auth->scopes = calloc(PM_AUTH_MAX_PROCESS_SCOPES, sizeof(*auth->scopes));
  return auth->scopes == NULL ? -1 : 0;
}

static int pm_auth_pin_scope(pm_authorization *auth, pid_t pid, unsigned long long birth, const char *network_id) {
  if (birth == 0 || pm_auth_process_birth(pid) != birth) return -1;
  for (size_t index = 0; index < auth->count; index++) {
    pm_authenticated_scope *scope = &auth->scopes[index];
    if (scope->pid != pid) continue;
    if (scope->birth == birth) return strcmp(scope->network_id, network_id) == 0 ? 0 : -1;
    *scope = (pm_authenticated_scope){ .pid = pid, .birth = birth };
    snprintf(scope->network_id, sizeof(scope->network_id), "%s", network_id);
    return 0;
  }
  /* Bounded registry: reclaim exited identities only when admitting a new one. */
  if (auth->count == PM_AUTH_MAX_PROCESS_SCOPES) {
    size_t index = 0;
    while (index < auth->count) {
      if (pm_auth_process_birth(auth->scopes[index].pid) != auth->scopes[index].birth) auth->scopes[index] = auth->scopes[--auth->count];
      else index++;
    }
    if (auth->count == PM_AUTH_MAX_PROCESS_SCOPES) return -1;
  }
  pm_authenticated_scope *scope = &auth->scopes[auth->count++];
  scope->pid = pid; scope->birth = birth;
  scope->controller_scope = 0;
  snprintf(scope->network_id, sizeof(scope->network_id), "%s", network_id);
  return 0;
}

/* Parentage is read from the OS, never workload JSON or environment. Bounds
 * and birth checks exclude cycles, PID reuse and a newer replacement parent. */
static pid_t pm_auth_process_parent(pid_t pid) {
#if defined(__APPLE__)
  struct proc_bsdinfo info;
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info) &&
    info.pbi_uid == geteuid() ? (pid_t)info.pbi_ppid : 0;
#elif defined(__linux__)
  char file[64], text[4096];
  snprintf(file, sizeof(file), "/proc/%ld/stat", (long)pid);
  int fd = open(file, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t length = read(fd, text, sizeof(text) - 1); close(fd);
  if (length <= 0) return 0;
  text[length] = '\0';
  char *cursor = strrchr(text, ')'), state; long parent = 0;
  return cursor != NULL && sscanf(cursor + 1, " %c %ld", &state, &parent) == 2 &&
    parent > 0 && parent <= INT_MAX ? (pid_t)parent : 0;
#else
  (void)pid; return 0;
#endif
}

static pm_authenticated_scope *pm_auth_exact_scope(pm_authorization *auth, pid_t pid, unsigned long long birth) {
  for (size_t index = 0; index < auth->count; index++) {
    if (auth->scopes[index].pid == pid && auth->scopes[index].birth == birth) return &auth->scopes[index];
  }
  return NULL;
}

/* Only controller-origin scope can authorize descendants. Ordinary network
 * tokens retain their existing exact-peer binding and do not create roots. */
static pm_authenticated_scope *pm_auth_controller_scope(pm_authorization *auth, pid_t pid, unsigned long long birth) {
  if (birth == 0 || pm_auth_process_birth(pid) != birth) return NULL;
  pid_t current = pid;
  unsigned long long current_birth = birth;
  for (int depth = 0; depth < 64 && current > 1 && current_birth != 0; depth++) {
    pm_authenticated_scope *scope = pm_auth_exact_scope(auth, current, current_birth);
    if (scope != NULL && scope->controller_scope) {
      if (current == pid) return scope;
      char network_id[128]; snprintf(network_id, sizeof(network_id), "%s", scope->network_id);
      if (pm_auth_process_birth(current) != current_birth) return NULL;
      /* An earlier conflicting guest pin or a full registry must not erase a
       * witnessed controller ancestor and reopen another network's token. */
      if (pm_auth_pin_scope(auth, pid, birth, network_id) != 0) return scope;
      scope = pm_auth_exact_scope(auth, pid, birth);
      if (scope != NULL) scope->controller_scope = 1;
      return scope;
    }
    pid_t parent = pm_auth_process_parent(current);
    unsigned long long parent_birth = parent > 1 ? pm_auth_process_birth(parent) : 0;
    if (parent == current || parent_birth == 0 || parent_birth > current_birth ||
        pm_auth_process_birth(current) != current_birth) return NULL;
    current = parent; current_birth = parent_birth;
  }
  return NULL;
}

static int pm_auth_register_controller_scope(pm_authorization *auth, pid_t pid, unsigned long long birth, const char *network_id) {
  char key[PM_NETWORK_NAMESPACE_KEY_SIZE];
  if (pid <= 1 || pm_network_namespace_key(network_id, key, sizeof(key)) != 0 ||
      birth == 0 || pm_auth_process_birth(pid) != birth) return -1;
  pm_authenticated_scope *inherited = pm_auth_controller_scope(auth, pid, birth);
  if (inherited != NULL && strcmp(inherited->network_id, network_id) != 0) return -1;
  if (pm_auth_pin_scope(auth, pid, birth, network_id) != 0) return -1;
  pm_authenticated_scope *scope = pm_auth_exact_scope(auth, pid, birth);
  if (scope == NULL) return -1;
  scope->controller_scope = 1;
  return 0;
}

static int pm_auth_host_allowed(const char *host, const char *network_host) {
  return strcmp(host, network_host) == 0 || strcmp(host, "localhost") == 0 ||
    strcmp(host, "127.0.0.1") == 0 || strcmp(host, "0.0.0.0") == 0 || strcmp(host, "::1") == 0 || strcmp(host, "::") == 0;
}

/* A PID alone is insufficient: a workload must not advertise another
 * process's high-port listener as its own route. Check bound TCP descriptors
 * without running lsof or consulting the caller's environment. */
static int pm_auth_owns_tcp_endpoint(pid_t pid, const char *host, int port) {
  const char *address = strcmp(host, "localhost") == 0 ? "127.0.0.1" : host;
#if defined(__APPLE__)
  int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (bytes <= 0 || bytes > (int)(8192 * sizeof(struct proc_fdinfo))) return 0;
  struct proc_fdinfo *fds = malloc((size_t)bytes);
  if (fds == NULL) return 0;
  bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, bytes);
  int owned = 0;
  for (int index = 0; index < bytes / (int)sizeof(*fds) && !owned; index++) {
    struct socket_fdinfo socket;
    if (fds[index].proc_fdtype != PROX_FDTYPE_SOCKET ||
        proc_pidfdinfo(pid, fds[index].proc_fd, PROC_PIDFDSOCKETINFO, &socket, sizeof(socket)) != sizeof(socket) ||
        socket.psi.soi_kind != SOCKINFO_TCP) continue;
    struct in_sockinfo *info = &socket.psi.soi_proto.pri_tcp.tcpsi_ini;
    if (ntohs((uint16_t)info->insi_lport) != port || info->insi_fport != 0) continue;
    struct in_addr v4;
    struct in6_addr v6;
    if ((info->insi_vflag & INI_IPV4) && inet_pton(AF_INET, address, &v4) == 1) {
      owned = info->insi_laddr.ina_46.i46a_addr4.s_addr == v4.s_addr;
    } else if ((info->insi_vflag & INI_IPV6) && inet_pton(AF_INET6, address, &v6) == 1) {
      owned = memcmp(&info->insi_laddr.ina_6, &v6, sizeof(v6)) == 0;
    }
  }
  free(fds);
  return owned;
#elif defined(__linux__)
  struct in_addr parsed;
  if (inet_pton(AF_INET, address, &parsed) != 1) return 0;
  char file[64], line[512];
  snprintf(file, sizeof(file), "/proc/%ld/net/tcp", (long)pid);
  FILE *table = fopen(file, "r");
  if (table == NULL) return 0;
  unsigned long inode = 0;
  for (int count = 0; count < 65536 && fgets(line, sizeof(line), table) != NULL; count++) {
    unsigned int local, local_port, foreign, foreign_port;
    unsigned long candidate;
    if (sscanf(line, "%*d: %x:%x %x:%x %*s %*s %*s %*s %*s %*s %lu", &local, &local_port, &foreign, &foreign_port, &candidate) == 5 &&
        local == parsed.s_addr && local_port == (unsigned int)port && foreign_port == 0) { inode = candidate; break; }
  }
  fclose(table);
  if (inode == 0) return 0;
  snprintf(file, sizeof(file), "/proc/%ld/fd", (long)pid);
  DIR *directory = opendir(file);
  if (directory == NULL) return 0;
  int owned = 0, count = 0;
  struct dirent *entry;
  while (!owned && count++ < 8192 && (entry = readdir(directory)) != NULL) {
    char target[64];
    ssize_t size = readlinkat(dirfd(directory), entry->d_name, target, sizeof(target) - 1);
    if (size <= 0) continue;
    target[size] = '\0';
    unsigned long candidate;
    owned = sscanf(target, "socket:[%lu]", &candidate) == 1 && candidate == inode;
  }
  closedir(directory);
  return owned;
#else
  (void)pid; (void)host; (void)port;
  return 0;
#endif
}

/* Return controller=2, network=1, anonymous readiness=0, denied=-1. Workload
 * authorization must run before scan creation AND before deferred execution. */
static int pm_auth_request(pm_authorization *auth, pm_agent_state *state, const pm_request *request,
    pid_t peer_pid, unsigned long long peer_birth) {
  if (pm_auth_token_matches(auth->controller_token, request->authorization)) return 2;
  if (strcmp(request->method, "daemonStatus") == 0 && request->authorization[0] == '\0') return 0;
  char key[PM_NETWORK_NAMESPACE_KEY_SIZE], file[PM_TEXT], contents[83];
  if (pm_network_namespace_key(request->authorization_network_id, key, sizeof(key)) != 0) return -1;
  int written = snprintf(file, sizeof(file), "%s.scopes/%s.key", auth->controller_path, key);
  if (written < 0 || (size_t)written >= sizeof(file) || pm_auth_read_key(file, contents, sizeof(contents)) != 0 ||
      contents[64] != '\n' || !pm_auth_token_matches(contents, request->authorization)) return -1;
  char *host = contents + 65;
  size_t length = strlen(host);
  if (length == 0 || host[length - 1] != '\n') return -1;
  host[length - 1] = '\0';
  if (strncmp(host, "127.", 4) != 0) return -1;
  pm_authenticated_scope *trusted_scope = pm_auth_controller_scope(auth, peer_pid, peer_birth);
  if (trusted_scope != NULL && strcmp(trusted_scope->network_id, request->authorization_network_id) != 0) return -1;
  char network_id[128];
  pm_json_get_string(request->payload, "networkId", network_id, sizeof(network_id));
  if (strcmp(request->method, "releaseRouteAllocation") == 0) {
    char id[PM_ID];
    if (pm_json_get_string(request->payload, "allocationId", id, sizeof(id)) != 0) return -1;
    network_id[0] = '\0';
    for (size_t index = 0; index < state->pending_count; index++) {
      if (strcmp(state->pending_routes[index].id, id) == 0) snprintf(network_id, sizeof(network_id), "%s", state->pending_routes[index].route.network_id);
    }
  } else if (strcmp(request->method, "allocateRoute") == 0) {
    pm_allocate_input input;
    if (pm_parse_allocate_input(request->payload, &input) != 0 || !pm_auth_host_allowed(input.host, host) ||
        !pm_auth_host_allowed(input.actual_host, host) ||
        (input.process_group_id != 0 && input.process_group_id != getpgid(peer_pid))) return -1;
  } else if (strcmp(request->method, "registerExistingProcess") == 0) {
    pm_register_input input;
    if (pm_parse_register_input(request->payload, &input) != 0 || input.pid != peer_pid ||
        strcmp(input.source, "hooked") != 0 || !pm_auth_host_allowed(input.host, host) ||
        !pm_auth_owns_tcp_endpoint(peer_pid, input.host, input.actual_port) ||
        (input.process_group_id != 0 && input.process_group_id != getpgid(peer_pid))) return -1;
    for (size_t index = 0; index < state->process_count; index++) {
      if (state->processes[index].pid == peer_pid && strcmp(state->processes[index].network_id, network_id) != 0) return -1;
    }
    for (size_t index = 0; index < state->pending_count; index++) {
      if (strcmp(state->pending_routes[index].id, input.allocation_id) == 0 &&
          strcmp(state->pending_routes[index].route.network_id, network_id) != 0) return -1;
    }
  } else if (strcmp(request->method, "releaseProcessRoute") == 0) {
    pm_release_process_input input;
    if (pm_parse_release_process_input(request->payload, &input) != 0 || input.pid != peer_pid ||
        (input.process_group_id != 0 && input.process_group_id != getpgid(peer_pid))) return -1;
    for (size_t index = 0; index < state->pending_count; index++) {
      if (strcmp(state->pending_routes[index].id, input.allocation_id) == 0 &&
          strcmp(state->pending_routes[index].route.network_id, network_id) != 0) return -1;
    }
    for (size_t index = 0; index < state->process_count; index++) {
      pm_process *process = &state->processes[index];
      if (process->requested_port == input.requested_port && process->actual_port == input.actual_port &&
          strcmp(process->network_id, network_id) != 0) return -1;
    }
  } else if (strcmp(request->method, "controlChannel") == 0) {
    if (pm_json_get_long(request->payload, "pid", 0) != peer_pid) return -1;
  } else return -1;
  if (strcmp(network_id, request->authorization_network_id) != 0 &&
      !(network_id[0] == '\0' && strcmp(request->authorization_network_id, "network-global") == 0)) return -1;
  return pm_auth_pin_scope(auth, peer_pid, peer_birth, request->authorization_network_id) == 0 ? 1 : -1;
}

#endif

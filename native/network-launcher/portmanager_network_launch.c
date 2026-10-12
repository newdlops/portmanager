#define _DARWIN_C_SOURCE
#include "../network-broker/pm_network_broker_client.h"
#include "../shared/pm_network_namespace.h"
#include "../shared/pm_dev_log.h"
#include "../agent/portmanager_agent.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <libproc.h>
#include <sys/stdio.h>
#endif

/* The supervisor starts exactly one guarded child. Its private pipe is never
 * inherited by application code; it is not a workload management protocol. */
#define PM_LAUNCH_MAGIC 0x504d4c52U
#define PM_LAUNCH_PROFILE_BYTES (128 * 1024)
#define PM_LAUNCH_START_MS 8000
#define PM_LAUNCH_STOP_MS 2000
#define PM_LAUNCH_SCOPE_REFRESH_MS 1000
enum { PM_LAUNCH_POLICY_READY = 1, PM_LAUNCH_EXEC_FAILED = 2, PM_LAUNCH_AUTHORIZED = 3, PM_LAUNCH_EXEC_START = 4 };
typedef struct { unsigned int magic, phase; int error, reserved; } pm_launch_record;
typedef struct {
  const char *profile_path, *broker_path, *hook_path, *network_id;
  const char *agent_path, *controller_path;
  const char *ready_path;
  int command_index, guard, announce;
} pm_launch_options;
static volatile sig_atomic_t pm_launch_signal;
static void pm_launch_on_signal(int number) { pm_launch_signal = number; }
/* The trusted host temporarily reads the same TTY for pm's menu. The guarded
 * child cannot signal this supervisor, and no new scope travels on this seam. */
static volatile sig_atomic_t pm_launch_menu_signal;
static void pm_launch_on_menu_signal(int number) { pm_launch_menu_signal = number; }

/* Inventory is bounded and single-threaded. macOS has no public closefrom in
 * this SDK; a failed inventory exits rather than carrying unknown authority. */
static int pm_launch_close_inherited(int keep) {
#if defined(__APPLE__)
  int capacity = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
  if (capacity <= 0 || capacity > 65536) { errno = EOVERFLOW; return -1; }
  struct proc_fdinfo *descriptors = malloc((size_t)capacity);
  if (descriptors == NULL) return -1;
  int bytes = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, descriptors, capacity);
  if (bytes <= 0 || bytes > capacity) { free(descriptors); errno = EIO; return -1; }
  for (size_t index = 0; index < (size_t)bytes / sizeof(*descriptors); index++) {
    int fd = descriptors[index].proc_fd;
    if (fd > 2 && fd != keep) close(fd);
  }
  free(descriptors); return 0;
#else
  (void)keep; errno = ENOTSUP; return -1;
#endif
}
static unsigned long long pm_launch_birth(pid_t pid) {
#if defined(__APPLE__)
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
  return (unsigned long long)info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec;
#else
  (void)pid; return 0;
#endif
}
static int pm_launch_parse(int argc, char **argv, pm_launch_options *options) {
  memset(options, 0, sizeof(*options));
  for (int index = 1; index < argc; index++) {
    const char *argument = argv[index];
    if (strcmp(argument, "--") == 0) { options->command_index = index + 1; break; }
    if (strcmp(argument, "--guard") == 0) options->guard = 1;
    else if (strcmp(argument, "--announce-ready") == 0) options->announce = 1;
    else if (index + 1 >= argc) return -1;
    else if (strcmp(argument, "--profile") == 0 && options->profile_path == NULL) options->profile_path = argv[++index];
    else if (strcmp(argument, "--broker") == 0 && options->broker_path == NULL) options->broker_path = argv[++index];
    else if (strcmp(argument, "--hook") == 0 && options->hook_path == NULL) options->hook_path = argv[++index];
    else if (strcmp(argument, "--network-id") == 0 && options->network_id == NULL) options->network_id = argv[++index];
    else if (strcmp(argument, "--agent-socket") == 0 && options->agent_path == NULL) options->agent_path = argv[++index];
    else if (strcmp(argument, "--controller-token-file") == 0 && options->controller_path == NULL) options->controller_path = argv[++index];
    else if (strcmp(argument, "--ready-file") == 0 && options->ready_path == NULL) options->ready_path = argv[++index];
    else return -1;
  }
  char key[PM_NETWORK_NAMESPACE_KEY_SIZE];
  return options->command_index > 0 && options->command_index < argc && options->profile_path != NULL &&
    options->broker_path != NULL && options->hook_path != NULL && options->network_id != NULL &&
    (options->agent_path == NULL) == (options->controller_path == NULL) &&
    (options->ready_path == NULL || options->agent_path != NULL) &&
    pm_network_namespace_key(options->network_id, key, sizeof(key)) == 0 ? 0 : -1;
}
/* A descriptor-rooted walk rejects symlinks without a check/open race. The
 * leaf and its immediate private parent must belong to the launching user. */
static int pm_launch_open_private(const char *path, const char *boundary, int executable) {
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX || strstr(path, boundary) == NULL) { errno = EINVAL; return -1; }
  char buffer[PATH_MAX]; strcpy(buffer, path);
  char *leaf = strrchr(buffer, '/');
  if (leaf == NULL || leaf[1] == '\0') { errno = EINVAL; return -1; }
  *leaf++ = '\0';
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  char *save = NULL;
  for (char *part = strtok_r(buffer, "/", &save); directory >= 0 && part != NULL; part = strtok_r(NULL, "/", &save)) {
    if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) { close(directory); errno = EINVAL; return -1; }
    int next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(directory); directory = next;
  }
  struct stat parent, file;
  if (directory < 0) return -1;
  if (fstat(directory, &parent) != 0 || parent.st_uid != geteuid() || (parent.st_mode & 077) != 0) {
    close(directory); errno = EACCES; return -1;
  }
  int fd = openat(directory, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  close(directory);
  if (fd < 0) return -1;
  if (fstat(fd, &file) != 0 || !S_ISREG(file.st_mode) || file.st_uid != geteuid() ||
      (file.st_mode & (executable ? 022 : 077)) != 0 || (!executable && file.st_nlink != 1)) {
    close(fd); errno = EACCES; return -1;
  }
  return fd;
}
static char *pm_launch_read_profile(const char *path) {
  int fd = pm_launch_open_private(path, "/.portmanager/security/profiles/", 0);
  if (fd < 0) return NULL;
  struct stat file;
  if (fstat(fd, &file) != 0 || file.st_size <= 0 || file.st_size > PM_LAUNCH_PROFILE_BYTES) {
    close(fd); errno = EINVAL; return NULL;
  }
  char *profile = malloc((size_t)file.st_size + 1);
  if (profile == NULL) { close(fd); return NULL; }
  size_t offset = 0;
  while (offset < (size_t)file.st_size) {
    ssize_t count = read(fd, profile + offset, (size_t)file.st_size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { free(profile); close(fd); errno = EIO; return NULL; }
    offset += (size_t)count;
  }
  close(fd);
  if (memchr(profile, '\0', offset) != NULL) { free(profile); errno = EINVAL; return NULL; }
  profile[offset] = '\0'; return profile;
}
/* Only the device already supplied by the trusted terminal owner is added.
 * Other /dev/tty* paths remain outside the base host-read allowlist. /dev/tty
 * is the kernel alias for this session's controlling device, not another tab. */
static char *pm_launch_terminal_profile(char *profile) {
  if (!isatty(0)) return profile;
  char terminal[PATH_MAX], escaped[PATH_MAX * 2];
  if (ttyname_r(0, terminal, sizeof(terminal)) != 0 || strncmp(terminal, "/dev/", 5) != 0) { free(profile); errno = EINVAL; return NULL; }
  size_t output = 0;
  for (size_t index = 0; terminal[index] != '\0'; index++) {
    unsigned char byte = (unsigned char)terminal[index];
    if (byte < 32 || byte == 127) { free(profile); errno = EINVAL; return NULL; }
    if (byte == '\\' || byte == '"') escaped[output++] = '\\';
    escaped[output++] = (char)byte;
  }
  escaped[output] = '\0';
  size_t length = strlen(profile), capacity = length + strlen(escaped) + 256;
  char *extended = realloc(profile, capacity);
  if (extended == NULL) { free(profile); return NULL; }
  snprintf(extended + length, capacity - length,
    "\n(allow pseudo-tty)\n(allow file-read* file-write* file-ioctl (literal \"/dev/tty\") (literal \"%s\"))\n", escaped);
  return extended;
}
static int pm_launch_record_write(unsigned int phase, int error) {
  pm_launch_record record = { .magic = PM_LAUNCH_MAGIC, .phase = phase, .error = error };
  size_t offset = 0;
  while (offset < sizeof(record)) {
    ssize_t count = write(3, (const char *)&record + offset, sizeof(record) - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}

#include "pm_network_launch_authorization.h"
#include "pm_network_launch_readiness.h"
#include "pm_network_launch_members.h"
#include "pm_network_launch_receipt.h"

/* The guard blocks before executing application code. Only the supervisor's
 * private socket can release it; this descriptor disappears on SETEXEC. */
static int pm_launch_record_read(int fd, pm_launch_record *record, long long deadline) {
  size_t offset = 0;
  while (offset < sizeof(*record)) {
    if (pm_launch_signal != 0) { errno = EINTR; return -1; }
    long long remaining = deadline - pm_nb_client_now();
    if (remaining <= 0) { errno = ETIMEDOUT; return -1; }
    struct pollfd descriptor = { .fd = fd, .events = POLLIN };
    int ready = poll(&descriptor, 1, remaining > 50 ? 50 : (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) return -1;
    if (ready == 0) continue;
    ssize_t count = read(fd, (char *)record + offset, sizeof(*record) - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { if (count == 0) errno = EPROTO; return -1; }
    offset += (size_t)count;
  }
  if (record->magic != PM_LAUNCH_MAGIC || record->reserved != 0 || record->error != 0) {
    errno = record->magic == PM_LAUNCH_MAGIC && record->phase == PM_LAUNCH_EXEC_FAILED && record->error > 0 ? record->error : EPROTO;
    return -1;
  }
  return 0;
}
static void pm_launch_clean_environment(void) {
  extern char **environ;
  char *diagnostics = getenv("PORT_MANAGER_DEV_LOG") == NULL ? NULL : strdup(getenv("PORT_MANAGER_DEV_LOG"));
  for (size_t index = 0; environ[index] != NULL;) {
    const char *entry = environ[index];
    if (strncmp(entry, "PORT_MANAGER_", 13) == 0 || strncmp(entry, "NEWDLOPS_PM_", 12) == 0 ||
        strncmp(entry, "DYLD_INSERT_LIBRARIES=", 22) == 0 || strncmp(entry, "LD_PRELOAD=", 11) == 0 ||
        strncmp(entry, "BASH_ENV=", 9) == 0 || strncmp(entry, "ENV=", 4) == 0) {
      const char *equals = strchr(entry, '=');
      if (equals == NULL) { index++; continue; }
      char *name = strndup(entry, (size_t)(equals - entry));
      if (name == NULL) _exit(125);
      unsetenv(name); free(name); index = 0;
    } else index++;
  }
  if (diagnostics != NULL) { setenv("PORT_MANAGER_DEV_LOG", diagnostics, 1); free(diagnostics); }
}
/* SETEXEC preserves the guarded process identity. CLOEXEC_DEFAULT closes all
 * other FDs atomically, including helper-created FDs and the readiness pipe.
 * Guard-side libproc inventory is deliberately not granted kernel permission. */
static int pm_launch_application_exec(const pm_launch_options *options, char **argv) {
#if defined(__APPLE__)
  extern char **environ;
  posix_spawnattr_t attributes; posix_spawn_file_actions_t actions;
  int error = posix_spawnattr_init(&attributes);
  if (error != 0) return error;
  error = posix_spawn_file_actions_init(&actions);
  if (error != 0) { posix_spawnattr_destroy(&attributes); return error; }
  error = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT);
  for (int fd = 0; error == 0 && fd < 3; fd++) error = posix_spawn_file_actions_addinherit_np(&actions, fd);
  if (error == 0 && pm_launch_record_write(PM_LAUNCH_EXEC_START, 0) != 0) error = errno;
  if (error == 0) {
    signal(SIGPIPE, SIG_DFL);
    error = posix_spawnp(NULL, argv[options->command_index], &actions, &attributes, &argv[options->command_index], environ);
  }
  posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes);
  return error != 0 ? error : EIO;
#else
  (void)options; (void)argv; return ENOTSUP;
#endif
}
/* No preload is active in the guard. The two probes establish actual kernel
 * denial and authorized broker transport before any application code runs. */
static int pm_launch_guard(const pm_launch_options *options, char **argv) {
  struct stat pipe_info;
  if (fstat(3, &pipe_info) != 0 || !S_ISSOCK(pipe_info.st_mode)) {
    pm_dev_log("network-launcher", "guard readiness descriptor unavailable errno=%d", errno); return 125;
  }
  if (fcntl(3, F_SETFD, FD_CLOEXEC) != 0) {
    int error = errno;
    pm_dev_log("network-launcher", "guard descriptor cleanup failed errno=%d", error);
    (void)pm_launch_record_write(PM_LAUNCH_EXEC_FAILED, error); return 125;
  }
  int private_file = open(options->profile_path, O_RDONLY | O_NOFOLLOW);
  if (private_file >= 0) { close(private_file); errno = EACCES; goto rejected; }
  if (errno != EPERM && errno != EACCES) goto rejected;
  pm_nb_request request;
  memset(&request, 0, sizeof(request)); request.magic = PM_NB_MAGIC; request.version = PM_NB_VERSION;
  request.operation = PM_NB_SOCKET; request.domain = AF_INET; request.type = SOCK_STREAM;
  pm_nb_response response; int socket = -1;
  if (pm_nb_client_call(options->broker_path, &request, -1, &response, &socket) != 0) goto rejected;
  struct sockaddr_in target;
  memset(&target, 0, sizeof(target)); target.sin_family = AF_INET;
#if defined(__APPLE__)
  target.sin_len = sizeof(target);
#endif
  target.sin_addr.s_addr = htonl(INADDR_LOOPBACK); target.sin_port = htons(9);
  int result = connect(socket, (struct sockaddr *)&target, sizeof(target));
  int error = errno; close(socket);
  if (result == 0 || (error != EPERM && error != EACCES)) { errno = EACCES; goto rejected; }
  if (pm_launch_record_write(PM_LAUNCH_POLICY_READY, 0) != 0) goto rejected;
  pm_launch_record authorized;
  if (pm_launch_record_read(3, &authorized, pm_nb_client_now() + PM_LAUNCH_START_MS) != 0) goto rejected;
  if (authorized.phase != PM_LAUNCH_AUTHORIZED) { errno = EACCES; goto rejected; }
  if (setenv("PORT_MANAGER_NETWORK_ID", options->network_id, 1) != 0 ||
      setenv("PORT_MANAGER_NETWORK_BROKER_SOCKET", options->broker_path, 1) != 0 ||
      setenv("PORT_MANAGER_HOOK", "1", 1) != 0 || setenv("PORT_MANAGER_AGENT_REQUIRED", "0", 1) != 0 ||
      setenv("PORT_MANAGER_DYLD_INSERT_LIBRARIES", options->hook_path, 1) != 0 ||
      setenv("DYLD_INSERT_LIBRARIES", options->hook_path, 1) != 0) goto rejected;
  errno = pm_launch_application_exec(options, argv);
rejected:
  error = errno != 0 ? errno : EACCES;
  pm_dev_log("network-launcher", "guard rejected errno=%d", error);
  (void)pm_launch_record_write(PM_LAUNCH_EXEC_FAILED, error);
  return 125;
}
static int pm_launch_wait_ready(int fd, long long deadline) {
  unsigned char bytes[sizeof(pm_launch_record) * 2 + 1]; size_t length = 0;
  if (fcntl(fd, F_SETFL, O_NONBLOCK) != 0) return -1;
  for (;;) {
    if (pm_launch_signal != 0) { errno = EINTR; return -1; }
    long long remaining = deadline - pm_nb_client_now();
    if (remaining <= 0) { errno = ETIMEDOUT; return -1; }
    struct pollfd descriptor = { .fd = fd, .events = POLLIN };
    int ready = poll(&descriptor, 1, remaining > 50 ? 50 : (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) return -1;
    if (ready == 0) continue;
    if (descriptor.revents & (POLLERR | POLLNVAL)) { errno = EIO; return -1; }
    ssize_t count = read(fd, bytes + length, sizeof(bytes) - length);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count < 0) return -1;
    if (count == 0) break;
    length += (size_t)count;
    if (length == sizeof(bytes)) { errno = EPROTO; return -1; }
  }
  pm_launch_record record;
  if (length == sizeof(record) * 2) {
    pm_launch_record failure; memcpy(&record, bytes, sizeof(record)); memcpy(&failure, bytes + sizeof(record), sizeof(failure));
    if (record.magic == PM_LAUNCH_MAGIC && record.phase == PM_LAUNCH_EXEC_START &&
        failure.magic == PM_LAUNCH_MAGIC && failure.phase == PM_LAUNCH_EXEC_FAILED && failure.error > 0) {
      errno = failure.error; return -1;
    }
  }
  if (length != sizeof(record)) { errno = EPROTO; return -1; }
  memcpy(&record, bytes, sizeof(record));
  if (record.magic != PM_LAUNCH_MAGIC || record.phase != PM_LAUNCH_EXEC_START || record.error != 0 || record.reserved != 0) {
    errno = record.phase == PM_LAUNCH_EXEC_FAILED && record.error > 0 ? record.error : EACCES; return -1;
  }
  return 0;
}
static void pm_launch_kill_owned(pid_t pid, unsigned long long birth, int number) {
  /* Only our still-unreaped fork child enters here. It cannot reuse its PID;
   * a missing initial libproc observation must not leave that child running. */
  if (birth != 0 && pm_launch_birth(pid) != birth) return;
  (void)kill(pid, number);
}
static int pm_launch_supervise(const pm_launch_options *options, pm_launch_members *members, pid_t child, unsigned long long birth, int startup_ok, pid_t foreground) {
  int status = 0, reaped = 0, cleanup_error = 0, menu_active = 0; long long stopping = 0;
  pm_scope_client refresh; memset(&refresh, 0, sizeof(refresh)); refresh.fd = -1;
  long long next_refresh = pm_nb_client_now() + PM_LAUNCH_SCOPE_REFRESH_MS, refresh_deadline = 0;
  if (!startup_ok) { pm_launch_kill_owned(child, birth, SIGKILL); stopping = pm_nb_client_now(); }
  for (;;) {
    pid_t done = reaped ? 0 : waitpid(child, &status, WNOHANG);
    if (!reaped && done == child) {
      reaped = 1; stopping = pm_nb_client_now() - PM_LAUNCH_STOP_MS;
      pm_dev_log("network-launcher", "root exited; cleaning members pid=%ld status=%d", (long)child, status);
    }
    if (done < 0 && errno != EINTR) {
      pm_dev_log("network-launcher", "wait failed pid=%ld errno=%d; retaining ownership", (long)child, errno);
      if (stopping == 0) stopping = pm_nb_client_now();
    }
    /* Ctrl+C in a foreground host maintenance command belongs to that command.
     * Ordinary shell interrupts arrive at the guarded child's own group. */
    if (pm_launch_signal == SIGINT && menu_active) pm_launch_signal = 0;
    if (pm_launch_signal != 0) {
      pm_dev_log("network-launcher", "forward signal child_pid=%ld signal=%d", (long)child, (int)pm_launch_signal);
      pm_scope_close(&refresh);
      if (!reaped) pm_launch_kill_owned(child, birth, pm_launch_signal);
      (void)pm_launch_members_sweep(members, pm_launch_signal); pm_launch_signal = 0;
      if (stopping == 0) stopping = pm_nb_client_now();
    }
    if (pm_launch_menu_signal != 0) {
      int active = pm_launch_menu_signal == SIGUSR1;
      pm_launch_menu_signal = 0;
      if (!reaped && stopping == 0 && foreground > 0 && tcsetpgrp(0, active ? foreground : child) == 0) {
        menu_active = active;
        if (pm_launch_publish_tty(options, active) != 0)
          pm_dev_log("network-launcher", "TTY menu acknowledgement failed errno=%d", errno);
      }
    }
    long long now = pm_nb_client_now();
    if (stopping != 0) {
      pm_scope_close(&refresh);
      if (now - stopping >= PM_LAUNCH_STOP_MS) {
        if (!reaped) pm_launch_kill_owned(child, birth, SIGKILL);
        int cleaned = pm_launch_members_sweep(members, SIGKILL);
        if (cleaned == 1 && reaped) break;
        if (cleaned < 0 && errno != cleanup_error) {
          cleanup_error = errno;
          pm_dev_log("network-launcher", "member cleanup uncertain errno=%d; retaining supervisor and TTY", errno);
        }
      }
    } else if (options->agent_path != NULL) {
      /* A replacement daemon has an empty scope table. Refresh the still-owned
       * child without blocking job control or trusting mutable workload env.
       * The kernel policy stays installed during outages; each broker operation
       * independently requires a fresh controller acknowledgement. */
      if (refresh.fd >= 0 && now >= refresh_deadline) {
        pm_dev_log("network-launcher", "scope refresh expired child_pid=%ld", (long)child);
        pm_scope_close(&refresh); next_refresh = now + PM_LAUNCH_SCOPE_REFRESH_MS;
      }
      if (refresh.fd < 0 && now >= next_refresh) {
        next_refresh = now + PM_LAUNCH_SCOPE_REFRESH_MS;
        if (pm_launch_begin_scope(options, &refresh, child, birth) == 0) refresh_deadline = now + PM_LAUNCH_START_MS;
        else pm_dev_log("network-launcher", "scope refresh failed child_pid=%ld errno=%d", (long)child, errno);
      }
    }
    struct pollfd descriptor = { .fd = refresh.fd, .events = pm_scope_events(&refresh) };
    int ready = poll(&descriptor, 1, 20);
    if (ready > 0 && refresh.fd >= 0) {
      int result = pm_scope_progress(&refresh, descriptor.revents);
      if (result != 0) {
        if (result < 0) pm_dev_log("network-launcher", "scope refresh rejected child_pid=%ld errno=%d", (long)child, errno);
        pm_scope_close(&refresh); next_refresh = pm_nb_client_now() + PM_LAUNCH_SCOPE_REFRESH_MS;
      }
    }
  }
  pm_scope_close(&refresh);
  if (!startup_ok) return 125;
  return WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 125;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--lifecycle-version") == 0) { puts("1"); return 0; }
  if (argc == 2 && strcmp(argv[1], "--terminal-menu-version") == 0) { puts("1"); return 0; }
  if (argc == 3 && strcmp(argv[1], "--recover-owner") == 0) {
    if (pm_launch_close_inherited(-1) != 0) return 125;
    signal(SIGTERM, pm_launch_on_signal); signal(SIGINT, pm_launch_on_signal);
    signal(SIGHUP, pm_launch_on_signal); signal(SIGPIPE, SIG_IGN);
    return pm_launch_recover_owner(argv[2]);
  }
  pm_launch_options options;
  if (pm_launch_parse(argc, argv, &options) != 0) return 2;
  if (options.guard) return pm_launch_guard(&options, argv);
  if (pm_launch_close_inherited(-1) != 0) return 125;
  char self[PATH_MAX];
#if defined(__APPLE__)
  if (proc_pidpath(getpid(), self, sizeof(self)) <= 0) return 125;
#else
  return 125;
#endif
  int runtime = pm_launch_open_private(self, "/.portmanager/runtime/", 1);
  if (runtime < 0) return 125; close(runtime);
  runtime = pm_launch_open_private(options.hook_path, "/.portmanager/runtime/", 1);
  if (runtime < 0) return 125; close(runtime);
  if (pm_launch_check_ready(&options) != 0) { pm_dev_log("network-launcher", "readiness destination rejected errno=%d", errno); return 125; }
  char *profile = pm_launch_read_profile(options.profile_path);
  if (profile == NULL) return 125;
  profile = pm_launch_terminal_profile(profile);
  if (profile == NULL) return 125;
  pm_launch_members members;
  profile = pm_launch_members_prepare(&members, &options, profile);
  if (profile == NULL) return 125;
  char **arguments = calloc((size_t)argc + 16, sizeof(char *));
  if (arguments == NULL) { free(profile); pm_launch_members_close(&members); return 125; }
  int index = 0;
  arguments[index++] = "/usr/bin/sandbox-exec"; arguments[index++] = "-p"; arguments[index++] = profile;
  arguments[index++] = self; arguments[index++] = "--guard";
  arguments[index++] = "--profile"; arguments[index++] = (char *)options.profile_path;
  arguments[index++] = "--broker"; arguments[index++] = (char *)options.broker_path;
  arguments[index++] = "--hook"; arguments[index++] = (char *)options.hook_path;
  arguments[index++] = "--network-id"; arguments[index++] = (char *)options.network_id;
  arguments[index++] = "--";
  for (int position = options.command_index; position < argc; position++) arguments[index++] = argv[position];
  int ready[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, ready) != 0) { free(arguments); free(profile); pm_launch_members_close(&members); return 125; }
  if (fcntl(ready[0], F_SETFD, FD_CLOEXEC) != 0) { close(ready[0]); close(ready[1]); free(arguments); free(profile); pm_launch_members_close(&members); return 125; }
  pm_launch_clean_environment();
  signal(SIGCHLD, SIG_DFL);
  signal(SIGTERM, pm_launch_on_signal); signal(SIGINT, pm_launch_on_signal);
  signal(SIGHUP, pm_launch_on_signal); signal(SIGQUIT, pm_launch_on_signal); signal(SIGPIPE, SIG_IGN);
  signal(SIGUSR1, pm_launch_on_menu_signal); signal(SIGUSR2, pm_launch_on_menu_signal);
  pid_t child = fork();
  if (child == 0) {
    close(ready[0]);
    if (dup2(ready[1], 3) != 3 || fcntl(3, F_SETFD, 0) != 0 || pm_launch_close_inherited(3) != 0 || setpgid(0, 0) != 0) _exit(125);
    execv(arguments[0], arguments); _exit(125);
  }
  close(ready[1]); free(arguments); free(profile);
  if (child < 0) { close(ready[0]); pm_launch_members_close(&members); return 125; }
  (void)setpgid(child, child);
  unsigned long long birth = pm_launch_birth(child);
  pid_t foreground = isatty(0) ? tcgetpgrp(0) : -1;
  signal(SIGTTOU, SIG_IGN);
  if (foreground > 0) (void)tcsetpgrp(0, child);
  long long deadline = pm_nb_client_now() + PM_LAUNCH_START_MS;
  pm_launch_receipt receipt;
  int recorded = pm_launch_owner_prepare(&receipt, &options, &members, child, birth) == 0;
  pm_launch_record policy;
  int accepted = recorded && birth != 0 && pm_launch_record_read(ready[0], &policy, deadline) == 0 && policy.phase == PM_LAUNCH_POLICY_READY;
  if (accepted) accepted = pm_launch_member_query(&members, child) == 1;
  if (accepted && options.agent_path != NULL) accepted = pm_launch_register_scope(&options, child, birth, deadline) == 0;
  if (accepted) {
    pm_launch_record authorized = { .magic = PM_LAUNCH_MAGIC, .phase = PM_LAUNCH_AUTHORIZED };
    accepted = write(ready[0], &authorized, sizeof(authorized)) == sizeof(authorized) && pm_launch_wait_ready(ready[0], deadline) == 0;
  }
  close(ready[0]);
  pm_launch_readiness published;
  memset(&published, 0, sizeof(published)); published.directory = -1;
  if (accepted) accepted = pm_launch_publish_ready(&published, &options, child, birth) == 0;
  if (accepted) {
    pm_dev_log("network-launcher", "policy ready child_pid=%ld birth=%llu", (long)child, birth);
    if (options.announce) { printf("ready pid=%ld birth=%llu\n", (long)child, birth); fflush(stdout); }
  } else pm_dev_log("network-launcher", "startup rejected child_pid=%ld errno=%d", (long)child, errno);
  int result = pm_launch_supervise(&options, &members, child, birth, accepted, foreground);
  while (pm_launch_receipt_publish(&receipt) != 0) {
    pm_dev_log("network-launcher", "cleanup complete but receipt publication failed errno=%d; retaining ownership", errno);
    (void)poll(NULL, 0, 1000);
  }
  pm_launch_remove_ready(&published);
  pm_launch_members_close(&members);
  if (foreground > 0) (void)tcsetpgrp(0, foreground);
  return result;
}

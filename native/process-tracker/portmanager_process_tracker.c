#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
#include <sys/event.h>
#include <sys/time.h>
#define PM_TRACKER_USE_KQUEUE 1
#endif

#if defined(__APPLE__)
#include <libproc.h>
#include <sys/proc_info.h>
#elif defined(__linux__)
#include <ctype.h>
#include <dirent.h>
#endif

/*
 * Live process -> logical network membership tracker.
 *
 * The daemon layer needs to know which logical network any process belongs to
 * without injecting an environment variable and without losing processes that
 * fork, daemonize (setsid), or get reparented to launchd/init. This helper
 * records membership at fork time via kqueue EVFILT_PROC/NOTE_TRACK on the
 * attached shell subtree, so the mapping persists even after the live parent
 * chain breaks. A periodic process scan reconciles anything the event stream
 * missed (NOTE_TRACKERR under fork storms, or platforms without kqueue).
 *
 * Control protocol (tab-delimited lines on stdin), answers on stdout:
 *   TRACK\t<pid>\t<networkId>   attach a subtree root to a network
 *   UNTRACK\t<networkId>        drop every pid mapped to a network
 *   QUERY\t<pid>                -> NETWORK\t<pid>\t<networkId|->
 *   SNAPSHOT                    -> one MEMBER line per mapping, then END
 */

#define PM_TRACKER_NETWORK_SIZE 256
#define PM_TRACKER_LINE_SIZE 1024
#define PM_TRACKER_RECONCILE_INTERVAL_MS 3000

typedef struct pm_member {
  int pid;
  int is_root; /* explicitly tracked root shell vs inherited descendant */
  char network_id[PM_TRACKER_NETWORK_SIZE];
} pm_member_t;

typedef struct pm_member_table {
  pm_member_t *items;
  size_t count;
  size_t capacity;
} pm_member_table_t;

static pm_member_table_t pm_members = {0};
static volatile sig_atomic_t pm_running = 1;
static int pm_debug_enabled = 0;

static void pm_debug(const char *format, ...) {
  va_list args;
  if (!pm_debug_enabled) {
    return;
  }
  fprintf(stderr, "portmanager-process-tracker: ");
  va_start(args, format);
  vfprintf(stderr, format, args);
  va_end(args);
  fprintf(stderr, "\n");
}

#if PM_TRACKER_USE_KQUEUE
static int pm_kqueue_fd = -1;
#endif

static pm_member_t *pm_find_member(int pid) {
  for (size_t index = 0; index < pm_members.count; index++) {
    if (pm_members.items[index].pid == pid) {
      return &pm_members.items[index];
    }
  }
  return NULL;
}

static int pm_reserve_members(size_t needed) {
  pm_member_t *next;
  size_t capacity;

  if (needed <= pm_members.capacity) {
    return 0;
  }
  capacity = pm_members.capacity == 0 ? 64 : pm_members.capacity;
  while (capacity < needed) {
    capacity *= 2;
  }
  next = (pm_member_t *)realloc(pm_members.items, capacity * sizeof(pm_member_t));
  if (next == NULL) {
    return -1;
  }
  pm_members.items = next;
  pm_members.capacity = capacity;
  return 0;
}

#if PM_TRACKER_USE_KQUEUE
/* Registers EVFILT_PROC with NOTE_TRACK so descendants are followed automatically. */
static int pm_watch_pid(int pid) {
  struct kevent change;

  if (pm_kqueue_fd < 0 || pid <= 0) {
    return -1;
  }
  EV_SET(&change, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR,
         NOTE_EXIT | NOTE_FORK | NOTE_EXEC | NOTE_TRACK, 0, NULL);
  /* ESRCH means the pid already exited; that is not a hard error. */
  return kevent(pm_kqueue_fd, &change, 1, NULL, 0, NULL) == 0 || errno == ESRCH ? 0 : -1;
}
#else
static int pm_watch_pid(int pid) {
  (void)pid;
  return 0;
}
#endif

/* Inserts or updates a pid's membership; watches it when newly added. */
static void pm_set_member(int pid, const char *network_id, int is_root) {
  pm_member_t *existing;

  if (pid <= 0 || network_id == NULL || network_id[0] == '\0') {
    return;
  }
  existing = pm_find_member(pid);
  if (existing != NULL) {
    snprintf(existing->network_id, sizeof(existing->network_id), "%s", network_id);
    if (is_root) {
      existing->is_root = 1;
    }
    return;
  }
  if (pm_reserve_members(pm_members.count + 1) != 0) {
    return;
  }
  existing = &pm_members.items[pm_members.count++];
  existing->pid = pid;
  existing->is_root = is_root;
  snprintf(existing->network_id, sizeof(existing->network_id), "%s", network_id);
  pm_watch_pid(pid);
}

static void pm_remove_member(int pid) {
  for (size_t index = 0; index < pm_members.count; index++) {
    if (pm_members.items[index].pid == pid) {
      pm_members.items[index] = pm_members.items[pm_members.count - 1];
      pm_members.count--;
      return;
    }
  }
}

/* Platform process-table read for reconciliation: fills pids[] and parents[]. */
#if defined(__APPLE__)
static size_t pm_read_process_table(int *pids, int *parents, size_t capacity) {
  int pid_count = proc_listallpids(NULL, 0);
  pid_t *raw;
  int listed;
  size_t used = 0;

  if (pid_count <= 0) {
    return 0;
  }
  raw = (pid_t *)calloc((size_t)pid_count, sizeof(pid_t));
  if (raw == NULL) {
    return 0;
  }
  listed = proc_listallpids(raw, pid_count * (int)sizeof(pid_t));
  for (int index = 0; index < listed && used < capacity; index++) {
    struct proc_bsdinfo info;
    if (raw[index] <= 0 ||
        proc_pidinfo(raw[index], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)) {
      continue;
    }
    pids[used] = (int)info.pbi_pid;
    parents[used] = (int)info.pbi_ppid;
    used++;
  }
  free(raw);
  return used;
}
#elif defined(__linux__)
static size_t pm_read_process_table(int *pids, int *parents, size_t capacity) {
  DIR *proc = opendir("/proc");
  struct dirent *entry;
  size_t used = 0;

  if (proc == NULL) {
    return 0;
  }
  while ((entry = readdir(proc)) != NULL && used < capacity) {
    char path[64];
    FILE *file;
    int pid;
    int ppid = 0;
    char comm[256];
    char state;

    if (entry->d_name[0] < '1' || entry->d_name[0] > '9') {
      continue;
    }
    pid = atoi(entry->d_name);
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    file = fopen(path, "r");
    if (file == NULL) {
      continue;
    }
    if (fscanf(file, "%d %255s %c %d", &pid, comm, &state, &ppid) == 4) {
      pids[used] = pid;
      parents[used] = ppid;
      used++;
    }
    fclose(file);
  }
  closedir(proc);
  return used;
}
#else
static size_t pm_read_process_table(int *pids, int *parents, size_t capacity) {
  (void)pids;
  (void)parents;
  (void)capacity;
  return 0;
}
#endif

/*
 * Reconciles membership against the live process table:
 *  - drop members that no longer exist,
 *  - adopt descendants whose parent is a member but were missed by the event
 *    stream (covers NOTE_TRACKERR and the no-kqueue platform).
 * A few passes propagate membership down multi-level trees each cycle.
 */
static void pm_reconcile(void) {
  static int pids[16384];
  static int parents[16384];
  size_t total = pm_read_process_table(pids, parents, sizeof(pids) / sizeof(pids[0]));

  if (total == 0) {
    return;
  }

  /* Drop dead members. */
  for (size_t index = 0; index < pm_members.count;) {
    int alive = 0;
    for (size_t scan = 0; scan < total; scan++) {
      if (pids[scan] == pm_members.items[index].pid) {
        alive = 1;
        break;
      }
    }
    if (!alive) {
      pm_members.items[index] = pm_members.items[pm_members.count - 1];
      pm_members.count--;
    } else {
      index++;
    }
  }

  /* Adopt descendants of members that the event stream missed. */
  for (int pass = 0; pass < 6; pass++) {
    int added = 0;
    for (size_t scan = 0; scan < total; scan++) {
      pm_member_t *parent_member;
      if (pids[scan] <= 0 || parents[scan] <= 0 || pm_find_member(pids[scan]) != NULL) {
        continue;
      }
      parent_member = pm_find_member(parents[scan]);
      if (parent_member != NULL) {
        pm_set_member(pids[scan], parent_member->network_id, 0);
        pm_debug("reconcile adopted pid=%d parent=%d network=%s", pids[scan], parents[scan], parent_member->network_id);
        added = 1;
      }
    }
    if (!added) {
      break;
    }
  }
}

/* Per-pid parent lookup used for the on-demand QUERY ancestor walk. */
#if defined(__APPLE__)
static int pm_parent_pid(int pid) {
  struct proc_bsdinfo info;
  if (pid <= 0 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)) {
    return -1;
  }
  return (int)info.pbi_ppid;
}
#elif defined(__linux__)
static int pm_parent_pid(int pid) {
  char path[64];
  FILE *file;
  int self = 0;
  int ppid = -1;
  char comm[256];
  char state;

  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  file = fopen(path, "r");
  if (file == NULL) {
    return -1;
  }
  if (fscanf(file, "%d %255s %c %d", &self, comm, &state, &ppid) != 4) {
    ppid = -1;
  }
  fclose(file);
  return ppid;
}
#else
static int pm_parent_pid(int pid) {
  (void)pid;
  return -1;
}
#endif

/*
 * Resolves a pid to a network: first the recorded map (which persists across
 * reparent/daemonize), then a live ancestor walk so a process that forked since
 * the last reconcile is attributed immediately. A resolved descendant is
 * recorded so repeat queries are cheap.
 */
static const char *pm_resolve_pid_network(int pid) {
  int current = pid;
  pm_member_t *member = pm_find_member(pid);

  if (member != NULL) {
    return member->network_id;
  }
  for (int depth = 0; depth < 64 && current > 1; depth++) {
    int parent = pm_parent_pid(current);
    if (parent <= 1 || parent == current) {
      break;
    }
    member = pm_find_member(parent);
    if (member != NULL) {
      pm_set_member(pid, member->network_id, 0);
      return member->network_id;
    }
    current = parent;
  }
  return NULL;
}

static void pm_write_line(const char *line) {
  size_t length = strlen(line);
  size_t written = 0;
  while (written < length) {
    ssize_t result = write(STDOUT_FILENO, line + written, length - written);
    if (result <= 0) {
      if (result < 0 && errno == EINTR) {
        continue;
      }
      return;
    }
    written += (size_t)result;
  }
}

static void pm_handle_command(char *line) {
  char *saveptr = NULL;
  char *verb = strtok_r(line, "\t\r\n", &saveptr);

  if (verb == NULL) {
    return;
  }

  if (strcmp(verb, "TRACK") == 0) {
    char *pid_text = strtok_r(NULL, "\t\r\n", &saveptr);
    char *network_id = strtok_r(NULL, "\t\r\n", &saveptr);
    int pid = pid_text == NULL ? 0 : atoi(pid_text);
    if (pid > 0 && network_id != NULL && network_id[0] != '\0') {
      pm_set_member(pid, network_id, 1);
    }
    return;
  }

  if (strcmp(verb, "UNTRACK") == 0) {
    char *network_id = strtok_r(NULL, "\t\r\n", &saveptr);
    if (network_id == NULL) {
      return;
    }
    for (size_t index = 0; index < pm_members.count;) {
      if (strcmp(pm_members.items[index].network_id, network_id) == 0) {
        pm_members.items[index] = pm_members.items[pm_members.count - 1];
        pm_members.count--;
      } else {
        index++;
      }
    }
    return;
  }

  if (strcmp(verb, "QUERY") == 0) {
    char *pid_text = strtok_r(NULL, "\t\r\n", &saveptr);
    int pid = pid_text == NULL ? 0 : atoi(pid_text);
    const char *network_id = pid > 0 ? pm_resolve_pid_network(pid) : NULL;
    char response[PM_TRACKER_LINE_SIZE];
    snprintf(response, sizeof(response), "NETWORK\t%d\t%s\n", pid, network_id != NULL ? network_id : "-");
    pm_write_line(response);
    return;
  }

  if (strcmp(verb, "SNAPSHOT") == 0) {
    char response[PM_TRACKER_LINE_SIZE];
    for (size_t index = 0; index < pm_members.count; index++) {
      snprintf(response, sizeof(response), "MEMBER\t%d\t%s\n", pm_members.items[index].pid,
               pm_members.items[index].network_id);
      pm_write_line(response);
    }
    pm_write_line("END\n");
    return;
  }
}

/* Reads available stdin, dispatching complete lines. Returns -1 on EOF. */
static int pm_read_commands(char *buffer, size_t *length, size_t capacity) {
  char chunk[512];
  ssize_t count = read(STDIN_FILENO, chunk, sizeof(chunk));

  if (count < 0) {
    return errno == EINTR ? 0 : -1;
  }
  if (count == 0) {
    return -1;
  }
  for (ssize_t index = 0; index < count; index++) {
    char value = chunk[index];
    if (value == '\n') {
      buffer[*length] = '\0';
      pm_handle_command(buffer);
      *length = 0;
      continue;
    }
    if (*length + 1 < capacity) {
      buffer[(*length)++] = value;
    }
  }
  return 0;
}

static void pm_handle_signal(int signal_number) {
  (void)signal_number;
  pm_running = 0;
}

int main(void) {
  char command_buffer[PM_TRACKER_LINE_SIZE];
  size_t command_length = 0;

  {
    const char *debug = getenv("PORT_MANAGER_PROCESS_TRACKER_DEBUG");
    pm_debug_enabled = debug != NULL && debug[0] != '\0' && strcmp(debug, "0") != 0;
  }

  signal(SIGINT, pm_handle_signal);
  signal(SIGTERM, pm_handle_signal);
  signal(SIGPIPE, SIG_IGN);

#if PM_TRACKER_USE_KQUEUE
  pm_kqueue_fd = kqueue();
  if (pm_kqueue_fd < 0) {
    fprintf(stderr, "portmanager-process-tracker: kqueue failed: %s\n", strerror(errno));
    return 1;
  }
  {
    struct kevent stdin_event;
    struct kevent timer_event;
    EV_SET(&stdin_event, STDIN_FILENO, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
    (void)kevent(pm_kqueue_fd, &stdin_event, 1, NULL, 0, NULL);
    EV_SET(&timer_event, 1, EVFILT_TIMER, EV_ADD | EV_ENABLE, 0, PM_TRACKER_RECONCILE_INTERVAL_MS, NULL);
    (void)kevent(pm_kqueue_fd, &timer_event, 1, NULL, 0, NULL);
  }
  pm_write_line("READY\n");

  while (pm_running) {
    struct kevent events[64];
    int ready = kevent(pm_kqueue_fd, NULL, 0, events, (int)(sizeof(events) / sizeof(events[0])), NULL);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;
    }
    for (int index = 0; index < ready; index++) {
      const struct kevent *event = &events[index];
      if (event->filter == EVFILT_READ && (int)event->ident == STDIN_FILENO) {
        if (pm_read_commands(command_buffer, &command_length, sizeof(command_buffer)) != 0) {
          pm_running = 0;
        }
        continue;
      }
      if (event->filter == EVFILT_TIMER) {
        pm_reconcile();
        continue;
      }
      if (event->filter == EVFILT_PROC) {
        int pid = (int)event->ident;
        pm_debug("proc event pid=%d fflags=0x%x data=%ld", pid, (unsigned)event->fflags, (long)event->data);
        if ((event->fflags & NOTE_CHILD) != 0) {
          /* data holds the parent pid; inherit its network. */
          pm_member_t *parent_member = pm_find_member((int)event->data);
          if (parent_member != NULL) {
            pm_set_member(pid, parent_member->network_id, 0);
            pm_debug("adopted child pid=%d from parent=%ld network=%s", pid, (long)event->data, parent_member->network_id);
          }
        } else if ((event->fflags & NOTE_EXIT) != 0) {
          pm_remove_member(pid);
        }
        /* NOTE_FORK/NOTE_EXEC need no action: NOTE_CHILD adds descendants and
         * the periodic reconcile backstops NOTE_TRACKERR gaps. */
      }
    }
  }

  close(pm_kqueue_fd);
#else
  /* No kqueue: rely entirely on periodic reconciliation of the process table. */
  pm_write_line("READY\n");
  while (pm_running) {
    struct timespec sleep_request = {PM_TRACKER_RECONCILE_INTERVAL_MS / 1000,
                                     (PM_TRACKER_RECONCILE_INTERVAL_MS % 1000) * 1000000L};
    if (pm_read_commands(command_buffer, &command_length, sizeof(command_buffer)) != 0) {
      break;
    }
    pm_reconcile();
    nanosleep(&sleep_request, NULL);
  }
#endif

  free(pm_members.items);
  return 0;
}

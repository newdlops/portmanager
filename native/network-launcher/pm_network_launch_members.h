#ifndef PM_NETWORK_LAUNCH_MEMBERS_H
#define PM_NETWORK_LAUNCH_MEMBERS_H

#include "../shared/pm_audit_identity.h"
#include <sys/proc.h>

#define PM_LAUNCH_CENSUS_PIDS 16384
typedef int (*pm_launch_sandbox_check_fn)(pid_t, const char *, int, ...);
typedef struct { pid_t pid; unsigned long long birth; } pm_launch_process_identity;
typedef struct {
  int directory, quiet, previous_count, previous_valid;
  char leaf[NAME_MAX + 1], marker_path[PATH_MAX];
  const char *denied_path;
  struct stat marker_identity;
  pm_launch_sandbox_check_fn check;
  pm_audit_signal_fn send_signal;
  pid_t *pids;
  pm_launch_process_identity *current, *previous;
} pm_launch_members;

static int pm_launch_member_query(const pm_launch_members *members, pid_t pid) {
  int boxed = members->check(pid, NULL, 0);
  if (boxed < 0) return -1;
  if (boxed == 0) return 0;
  int positive = members->check(pid, "file-read-data", 1 | members->quiet, members->marker_path);
  if (positive < 0) return -1;
  if (positive != 0) return 0;
  int negative = members->check(pid, "file-read-data", 1 | members->quiet, members->denied_path);
  if (negative < 0) return -1;
  return negative > 0;
}
static int pm_launch_member_signal(const pm_launch_members *members, pid_t pid, int number) {
  audit_token_t before, after;
  if (pm_audit_token_read(pid, &before) != 0) return -1;
  int owned = pm_launch_member_query(members, pid);
  if (owned < 0) return -1;
  if (!owned) { errno = EAGAIN; return -1; }
  if (pm_audit_token_read(pid, &after) != 0 || memcmp(&before, &after, sizeof(before)) != 0) { errno = EAGAIN; return -1; }
  int error = members->send_signal(&before, number);
  if (error != 0) { errno = error; return -1; }
  return 0;
}
static void pm_launch_members_close(pm_launch_members *members) {
  if (members->directory >= 0) {
    struct stat current;
    if (fstatat(members->directory, members->leaf, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
        current.st_dev == members->marker_identity.st_dev && current.st_ino == members->marker_identity.st_ino && S_ISREG(current.st_mode)) {
      (void)unlinkat(members->directory, members->leaf, 0);
    }
    close(members->directory); members->directory = -1;
  }
  free(members->pids); free(members->current); free(members->previous);
  members->pids = NULL; members->current = members->previous = NULL;
}
/* One opaque read-only file identifies this inherited kernel policy, including
 * descendants reparented before observation. It holds no command/key/token.
 * All nonmembers either lack the grant or can read the separate denied profile. */
static char *pm_launch_members_prepare(pm_launch_members *members, const pm_launch_options *options, char *profile) {
  memset(members, 0, sizeof(*members)); members->directory = -1;
  members->check = (pm_launch_sandbox_check_fn)dlsym(RTLD_DEFAULT, "sandbox_check");
  members->send_signal = (pm_audit_signal_fn)dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
  const int *quiet = dlsym(RTLD_DEFAULT, "SANDBOX_CHECK_NO_REPORT");
  audit_token_t own;
  if (members->check == NULL || members->send_signal == NULL || quiet == NULL || pm_audit_token_read(getpid(), &own) != 0) {
    errno = ENOTSUP; goto failed;
  }
  members->quiet = *quiet; members->denied_path = options->profile_path;
  char leaf[NAME_MAX + 1];
  members->directory = pm_private_parent(options->profile_path, "/.portmanager/security/profiles/", leaf, sizeof(leaf));
  if (members->directory < 0) goto failed;
  int fd = -1;
  for (int attempt = 0; attempt < 16; attempt++) {
    snprintf(members->leaf, sizeof(members->leaf), ".scope-%08x%08x%08x%08x", arc4random(), arc4random(), arc4random(), arc4random());
    fd = openat(members->directory, members->leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd >= 0 || errno != EEXIST) break;
  }
  if (fd < 0) { members->leaf[0] = '\0'; goto failed; }
  int valid = fstat(fd, &members->marker_identity) == 0 && write(fd, "scope\n", 6) == 6 &&
    fchmod(fd, 0600) == 0 && pm_private_regular(fd, &members->marker_identity) == 0;
  close(fd); if (!valid) goto failed;
  const char *slash = strrchr(options->profile_path, '/');
  int length = snprintf(members->marker_path, sizeof(members->marker_path), "%.*s/%s", (int)(slash - options->profile_path), options->profile_path, members->leaf);
  if (length < 0 || (size_t)length >= sizeof(members->marker_path)) { errno = ENAMETOOLONG; goto failed; }
  pm_buffer extended; pm_buffer_init(&extended);
  int built = pm_buffer_append(&extended, profile) == 0 && pm_buffer_append(&extended, "\n(allow file-read-data (literal ") == 0 &&
    pm_json_append_string(&extended, members->marker_path) == 0 && pm_buffer_append(&extended, "))\n") == 0;
  if (!built) { pm_buffer_free(&extended); goto failed; }
  free(profile); return extended.data;
failed:
  { int error = errno; free(profile); pm_launch_members_close(members); errno = error; return NULL; }
}
static int pm_launch_identity_order(const void *a, const void *b) {
  const pm_launch_process_identity *first = a, *second = b;
  return first->pid < second->pid ? -1 : first->pid > second->pid;
}
/* A single empty scan can miss a fork/exit handoff. Compare two complete PID+
 * birth censuses, with no live members in either. Foreign unreadable/vanished
 * identities retain a PID placeholder. Churn, truncation or unknown member
 * identity cannot acknowledge cleanup; ownership and TTY remain retained. */
static int pm_launch_members_sweep(pm_launch_members *members, int number) {
  if (members->pids == NULL || members->current == NULL || members->previous == NULL) {
    free(members->pids); free(members->current); free(members->previous);
    members->pids = malloc(PM_LAUNCH_CENSUS_PIDS * sizeof(*members->pids));
    members->current = malloc(PM_LAUNCH_CENSUS_PIDS * sizeof(*members->current));
    members->previous = malloc(PM_LAUNCH_CENSUS_PIDS * sizeof(*members->previous));
    if (members->pids == NULL || members->current == NULL || members->previous == NULL) { errno = ENOMEM; return -1; }
  }
  int capacity = proc_listallpids(NULL, 0);
  if (capacity <= 0 || capacity + 20 >= PM_LAUNCH_CENSUS_PIDS) { errno = EOVERFLOW; members->previous_valid = 0; return -1; }
  int count = proc_listallpids(members->pids, PM_LAUNCH_CENSUS_PIDS * sizeof(*members->pids));
  if (count <= 0 || count >= PM_LAUNCH_CENSUS_PIDS) { errno = EOVERFLOW; members->previous_valid = 0; return -1; }
  int identities = 0, live_members = 0, uncertain = 0;
  int failed_pid = 0, failed_kind = 0, failed_error = 0;
  for (int index = 0; index < count; index++) {
    pid_t pid = members->pids[index]; if (pid <= 0) continue;
    int owned = pid == getpid() ? 0 : pm_launch_member_query(members, pid);
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) {
      /* A foreign protected/zombie process may not expose BSD info. Keep its
       * PID in the census, but never infer membership from missing metadata.
       * A replacement live member has a nonzero birth and cannot match this
       * foreign/vanished placeholder in the next complete census. */
      if (owned == 0 || errno == ESRCH) {
        members->current[identities++] = (pm_launch_process_identity){ .pid = pid, .birth = 0 }; continue;
      }
      uncertain = 1; failed_pid = pid; failed_kind = 1; failed_error = errno; continue;
    }
    unsigned long long birth = (unsigned long long)info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec;
    members->current[identities++] = (pm_launch_process_identity){ .pid = pid, .birth = birth };
    if (pid == getpid() || info.pbi_status == SZOMB) continue;
    if (owned < 0) { uncertain = 1; failed_pid = pid; failed_kind = 2; failed_error = errno; continue; }
    if (!owned) continue;
    live_members++;
    if (pm_launch_member_signal(members, pid, number) != 0) { uncertain = 1; failed_pid = pid; failed_kind = 3; failed_error = errno; }
  }
  static long long last_diagnostic = 0;
  long long now = pm_nb_client_now();
  if (uncertain && now - last_diagnostic >= 1000) {
    last_diagnostic = now;
    pm_dev_log("network-launcher", "census uncertain pid=%d kind=%d errno=%d identities=%d live_members=%d", failed_pid, failed_kind, failed_error, identities, live_members);
  }
  if (uncertain || live_members != 0) { members->previous_valid = 0; return 0; }
  qsort(members->current, (size_t)identities, sizeof(*members->current), pm_launch_identity_order);
  int stable = members->previous_valid && members->previous_count == identities;
  for (int index = 0; stable && index < identities; index++) if (members->current[index].pid != members->previous[index].pid ||
      members->current[index].birth != members->previous[index].birth) stable = 0;
  memcpy(members->previous, members->current, (size_t)identities * sizeof(*members->current));
  members->previous_count = identities; members->previous_valid = 1;
  return stable ? 1 : 0;
}

#endif

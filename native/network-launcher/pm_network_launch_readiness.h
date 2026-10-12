#ifndef PM_NETWORK_LAUNCH_READINESS_H
#define PM_NETWORK_LAUNCH_READINESS_H

#include "../shared/pm_private_file.h"

typedef struct {
  int directory;
  char leaf[NAME_MAX + 1];
  struct stat identity;
} pm_launch_readiness;

static int pm_launch_check_ready(const pm_launch_options *options) {
  if (options->ready_path == NULL) return 0;
  char leaf[NAME_MAX + 1];
  int directory = pm_private_parent(options->ready_path, "/.portmanager/security/sessions/", leaf, sizeof(leaf));
  if (directory < 0) return -1;
  struct stat existing;
  int result = fstatat(directory, leaf, &existing, AT_SYMLINK_NOFOLLOW);
  int error = result == 0 ? EEXIST : errno; close(directory);
  if (result == 0 || error != ENOENT) { errno = error; return -1; }
  return 0;
}

/* Only the trusted supervisor publishes this record, after exec closes its
 * private guard channel. The application never inherits a writer/directory FD. */
static int pm_launch_publish_ready(pm_launch_readiness *ready, const pm_launch_options *options,
    pid_t child, unsigned long long birth) {
  memset(ready, 0, sizeof(*ready)); ready->directory = -1;
  if (options->ready_path == NULL) return 0;
  if (pm_launch_signal != 0) { errno = EINTR; return -1; }
  unsigned long long supervisor_birth = pm_launch_birth(getpid());
  if (supervisor_birth == 0) { errno = EACCES; return -1; }
  ready->directory = pm_private_parent(options->ready_path, "/.portmanager/security/sessions/", ready->leaf, sizeof(ready->leaf));
  if (ready->directory < 0) return -1;
  pm_buffer record; pm_buffer_init(&record);
  int result = pm_buffer_appendf(&record, "{\"supervisorPid\":%ld,\"supervisorBirth\":%llu,\"pid\":%ld,\"birth\":%llu,\"networkId\":", (long)getpid(), supervisor_birth, (long)child, birth) == 0 &&
    pm_json_append_string(&record, options->network_id) == 0 && pm_buffer_append(&record, "}\n") == 0;
  if (!result) { pm_buffer_free(&record); close(ready->directory); ready->directory = -1; return -1; }
  char temporary[NAME_MAX + 1]; int fd = -1, temporary_owned = 0;
  for (int attempt = 0; attempt < 16; attempt++) {
    snprintf(temporary, sizeof(temporary), ".ready-%ld-%08x.tmp", (long)getpid(), arc4random());
    fd = openat(ready->directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd >= 0 || errno != EEXIST) break;
  }
  if (fd < 0) goto rejected;
  temporary_owned = 1;
  size_t written = 0;
  while (written < record.length) {
    ssize_t count = write(fd, record.data + written, record.length - written);
    if (count < 0 && errno == EINTR && pm_launch_signal == 0) continue;
    if (count <= 0) goto rejected;
    written += (size_t)count;
  }
  if (pm_launch_signal != 0) { errno = EINTR; goto rejected; }
  if (fchmod(fd, 0600) != 0 || pm_private_regular(fd, &ready->identity) != 0) goto rejected;
  close(fd); fd = -1;
  /* Exclusive rename keeps nlink == 1 at every visible instant. link/unlink
   * exposes a two-link record that the concurrent strict reader must reject. */
  if (renameatx_np(ready->directory, temporary, ready->directory, ready->leaf, RENAME_EXCL) != 0) goto rejected;
  temporary_owned = 0;
  pm_buffer_free(&record); return 0;
rejected:
  {
    int error = errno;
    if (fd >= 0) close(fd);
    if (temporary_owned) (void)unlinkat(ready->directory, temporary, 0);
    close(ready->directory); ready->directory = -1;
    pm_buffer_free(&record); errno = error; return -1;
  }
}
/* A private, bounded acknowledgement prevents the host from opening its TTY
 * reader before tcsetpgrp completes. App code cannot publish this record. */
static int pm_launch_publish_tty(const pm_launch_options *options, int active) {
  if (options->ready_path == NULL) { errno = EINVAL; return -1; }
  char path[PATH_MAX], leaf[NAME_MAX + 1], temporary[NAME_MAX + 1];
  if (snprintf(path, sizeof(path), "%s.tty", options->ready_path) >= (int)sizeof(path)) { errno = ENAMETOOLONG; return -1; }
  int directory = pm_private_parent(path, "/.portmanager/security/sessions/", leaf, sizeof(leaf));
  if (directory < 0) return -1;
  snprintf(temporary, sizeof(temporary), ".tty-%ld-%08x.tmp", (long)getpid(), arc4random());
  int fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) { close(directory); return -1; }
  char record[128];
  int length = snprintf(record, sizeof(record), "{\"supervisorPid\":%ld,\"active\":%s}\n", (long)getpid(), active ? "true" : "false");
  struct stat identity;
  int result = length > 0 && length < (int)sizeof(record) && write(fd, record, (size_t)length) == length &&
    fchmod(fd, 0600) == 0 && pm_private_regular(fd, &identity) == 0;
  int error = errno; close(fd);
  if (result) { result = renameat(directory, temporary, directory, leaf) == 0; error = errno; }
  if (!result) (void)unlinkat(directory, temporary, 0);
  close(directory); errno = error; return result ? 0 : -1;
}

static void pm_launch_remove_ready(pm_launch_readiness *ready) {
  if (ready->directory < 0) return;
  struct stat current;
  if (fstatat(ready->directory, ready->leaf, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
      S_ISREG(current.st_mode) && current.st_dev == ready->identity.st_dev && current.st_ino == ready->identity.st_ino) {
    (void)unlinkat(ready->directory, ready->leaf, 0);
  }
  close(ready->directory); ready->directory = -1;
}

#endif

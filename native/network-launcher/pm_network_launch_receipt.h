#ifndef PM_NETWORK_LAUNCH_RECEIPT_H
#define PM_NETWORK_LAUNCH_RECEIPT_H

#define PM_LAUNCH_OWNER_BYTES 2048
typedef struct {
  char owner_path[PATH_MAX], cleaned_path[PATH_MAX], record[PM_LAUNCH_OWNER_BYTES];
  size_t length;
  struct stat parent_identity;
  int prepared;
} pm_launch_receipt;

/* A complete private record is published without replacing an existing leaf.
 * The directory is used through one validated descriptor and then closed. */
static int pm_launch_record_publish(const char *path, const char *data, size_t length, const struct stat *expected_parent) {
  char leaf[NAME_MAX + 1], temporary[NAME_MAX + 1];
  int directory = pm_private_parent(path, "/.portmanager/security/sessions/", leaf, sizeof(leaf));
  if (directory < 0) return -1;
  struct stat parent;
  if (fstat(directory, &parent) != 0 || (expected_parent != NULL &&
      (parent.st_dev != expected_parent->st_dev || parent.st_ino != expected_parent->st_ino))) { close(directory); errno = EACCES; return -1; }
  int fd = -1, owned = 0, result = -1;
  for (int attempt = 0; attempt < 16; attempt++) {
    snprintf(temporary, sizeof(temporary), ".owner-%08x%08x.tmp", arc4random(), arc4random());
    fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd >= 0 || errno != EEXIST) break;
  }
  if (fd < 0) goto done;
  owned = 1; size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, data + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) goto done; offset += (size_t)count;
  }
  struct stat identity;
  if (fchmod(fd, 0600) != 0 || pm_private_regular(fd, &identity) != 0) goto done;
  close(fd); fd = -1;
  if (linkat(directory, temporary, directory, leaf, 0) != 0) goto done;
  if (unlinkat(directory, temporary, 0) != 0) {
    int error = errno; struct stat current;
    if (fstatat(directory, leaf, &current, AT_SYMLINK_NOFOLLOW) == 0 && current.st_dev == identity.st_dev && current.st_ino == identity.st_ino) (void)unlinkat(directory, leaf, 0);
    errno = error; goto done;
  }
  owned = 0;
  result = 0;
done:
  { int error = errno; if (fd >= 0) close(fd); if (owned) (void)unlinkat(directory, temporary, 0); close(directory); errno = error; return result; }
}
static int pm_launch_owner_prepare(pm_launch_receipt *receipt, const pm_launch_options *options,
    const pm_launch_members *members, pid_t child, unsigned long long birth) {
  memset(receipt, 0, sizeof(*receipt));
  if (options->ready_path == NULL) return 0;
  if (birth == 0) { errno = ESRCH; return -1; }
  if (snprintf(receipt->owner_path, sizeof(receipt->owner_path), "%s.owner", options->ready_path) >= (int)sizeof(receipt->owner_path) ||
      snprintf(receipt->cleaned_path, sizeof(receipt->cleaned_path), "%s.cleaned", options->ready_path) >= (int)sizeof(receipt->cleaned_path)) { errno = ENAMETOOLONG; return -1; }
  char leaf[NAME_MAX + 1];
  int directory = pm_private_parent(receipt->owner_path, "/.portmanager/security/sessions/", leaf, sizeof(leaf));
  if (directory < 0) return -1;
  int valid = fstat(directory, &receipt->parent_identity) == 0;
  close(directory); if (!valid) return -1;
  directory = pm_private_parent(receipt->cleaned_path, "/.portmanager/security/sessions/", leaf, sizeof(leaf));
  if (directory < 0) return -1;
  struct stat existing;
  int absent = fstatat(directory, leaf, &existing, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
  close(directory); if (!absent) { errno = EEXIST; return -1; }
  unsigned long long own_birth = pm_launch_birth(getpid()); if (own_birth == 0) { errno = ESRCH; return -1; }
  pm_buffer record; pm_buffer_init(&record);
  int built = pm_buffer_appendf(&record, "{\"version\":1,\"supervisorPid\":%ld,\"supervisorBirth\":%llu,\"pid\":%ld,\"birth\":%llu,\"networkId\":", (long)getpid(), own_birth, (long)child, birth) == 0 &&
    pm_json_append_string(&record, options->network_id) == 0 && pm_buffer_append(&record, ",\"markerPath\":") == 0 &&
    pm_json_append_string(&record, members->marker_path) == 0 && pm_buffer_append(&record, ",\"profilePath\":") == 0 &&
    pm_json_append_string(&record, options->profile_path) == 0 && pm_buffer_appendf(&record, ",\"markerDev\":%llu,\"markerIno\":%llu}\n",
      (unsigned long long)(unsigned int)members->marker_identity.st_dev, (unsigned long long)members->marker_identity.st_ino) == 0 && record.length < sizeof(receipt->record);
  if (!built) { pm_buffer_free(&record); errno = EOVERFLOW; return -1; }
  memcpy(receipt->record, record.data, record.length); receipt->length = record.length; pm_buffer_free(&record);
  if (pm_launch_record_publish(receipt->owner_path, receipt->record, receipt->length, &receipt->parent_identity) != 0) return -1;
  receipt->prepared = 1; return 0;
}
static int pm_launch_private_record_read(const char *path, char *data, size_t capacity, struct stat *parent_identity);
static int pm_launch_receipt_publish(pm_launch_receipt *receipt) {
  if (!receipt->prepared) return 0;
  char complete[PM_LAUNCH_OWNER_BYTES + 32];
  if (receipt->length < 3 || receipt->record[receipt->length - 2] != '}') { errno = EPROTO; return -1; }
  size_t prefix = receipt->length - 2;
  memcpy(complete, receipt->record, prefix);
  const char ending[] = ",\"cleaned\":true}\n";
  memcpy(complete + prefix, ending, sizeof(ending));
  if (pm_launch_record_publish(receipt->cleaned_path, complete, prefix + sizeof(ending) - 1, &receipt->parent_identity) == 0) return 0;
  if (errno == EEXIST) {
    char existing[PM_LAUNCH_OWNER_BYTES + 32];
    if (pm_launch_private_record_read(receipt->cleaned_path, existing, sizeof(existing), NULL) == 0 && strcmp(existing, complete) == 0) return 0;
    errno = EACCES;
  }
  return -1;
}
static int pm_launch_private_record_read(const char *path, char *data, size_t capacity, struct stat *parent_identity) {
  char leaf[NAME_MAX + 1];
  int directory = pm_private_parent(path, "/.portmanager/security/sessions/", leaf, sizeof(leaf));
  if (directory < 0) return -1;
  if (parent_identity != NULL && fstat(directory, parent_identity) != 0) { close(directory); return -1; }
  int fd = openat(directory, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  close(directory); if (fd < 0) return -1;
  struct stat identity; ssize_t count = -1;
  if (pm_private_regular(fd, &identity) == 0 && identity.st_size > 0 && (size_t)identity.st_size < capacity) count = read(fd, data, capacity - 1);
  close(fd);
  if (count <= 0 || memchr(data, '\0', (size_t)count) != NULL) { errno = EPROTO; return -1; }
  data[count] = '\0'; const char *end = pm_scope_json_value(data, 0);
  if (end == NULL || *pm_scope_space(end) != '\0') { errno = EPROTO; return -1; }
  return 0;
}
static int pm_launch_recover_owner(const char *path) {
  pm_launch_receipt receipt; memset(&receipt, 0, sizeof(receipt));
  size_t path_length = path == NULL ? 0 : strlen(path);
  if (path_length < 7 || path_length >= sizeof(receipt.owner_path) || strcmp(path + path_length - 6, ".owner") != 0) return 2;
  strcpy(receipt.owner_path, path);
  if (snprintf(receipt.cleaned_path, sizeof(receipt.cleaned_path), "%.*s.cleaned", (int)(path_length - 6), path) >= (int)sizeof(receipt.cleaned_path)) return 2;
  if (pm_launch_private_record_read(path, receipt.record, sizeof(receipt.record), &receipt.parent_identity) != 0) return 125;
  receipt.length = strlen(receipt.record); receipt.prepared = 1;
  if (receipt.length < 3 || receipt.record[receipt.length - 2] != '}' || receipt.record[receipt.length - 1] != '\n') return 125;
  pid_t supervisor = (pid_t)pm_json_get_long(receipt.record, "supervisorPid", 0);
  unsigned long long supervisor_birth = (unsigned long long)pm_json_get_long(receipt.record, "supervisorBirth", 0);
  pid_t child = (pid_t)pm_json_get_long(receipt.record, "pid", 0);
  unsigned long long child_birth = (unsigned long long)pm_json_get_long(receipt.record, "birth", 0);
  char network_id[128], key[PM_NETWORK_NAMESPACE_KEY_SIZE];
  if (!pm_scope_unsigned_matches(receipt.record, "version", 1) || supervisor <= 1 || child <= 1 || supervisor_birth == 0 || child_birth == 0 ||
      !pm_scope_unsigned_matches(receipt.record, "supervisorPid", (unsigned long long)supervisor) ||
      !pm_scope_unsigned_matches(receipt.record, "supervisorBirth", supervisor_birth) ||
      !pm_scope_unsigned_matches(receipt.record, "pid", (unsigned long long)child) || !pm_scope_unsigned_matches(receipt.record, "birth", child_birth) ||
      pm_json_get_string(receipt.record, "networkId", network_id, sizeof(network_id)) != 0 || pm_network_namespace_key(network_id, key, sizeof(key)) != 0) return 125;
  struct proc_bsdinfo supervisor_info;
  if (proc_pidinfo(supervisor, PROC_PIDTBSDINFO, 0, &supervisor_info, sizeof(supervisor_info)) == sizeof(supervisor_info) &&
      pm_launch_birth(supervisor) == supervisor_birth && supervisor_info.pbi_status != SZOMB) { errno = EBUSY; return 125; }
  char complete[PM_LAUNCH_OWNER_BYTES + 32];
  if (pm_launch_private_record_read(receipt.cleaned_path, complete, sizeof(complete), NULL) == 0) {
    char expected[PM_LAUNCH_OWNER_BYTES + 32]; size_t prefix = receipt.length - 2;
    memcpy(expected, receipt.record, prefix); strcpy(expected + prefix, ",\"cleaned\":true}\n");
    if (strcmp(complete, expected) == 0) { puts("{\"cleaned\":true,\"version\":1}"); return 0; }
    return 125;
  }
  if (errno != ENOENT) return 125;
  pm_launch_members members; memset(&members, 0, sizeof(members)); members.directory = -1;
  char negative[PATH_MAX];
  if (pm_json_get_string(receipt.record, "markerPath", members.marker_path, sizeof(members.marker_path)) != 0 ||
      pm_json_get_string(receipt.record, "profilePath", negative, sizeof(negative)) != 0) return 125;
  members.denied_path = negative;
  members.directory = pm_private_parent(members.marker_path, "/.portmanager/security/profiles/", members.leaf, sizeof(members.leaf));
  if (members.directory < 0) return 125;
  int fd = openat(members.directory, members.leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  int valid = fd >= 0 && pm_private_regular(fd, &members.marker_identity) == 0 &&
    pm_scope_unsigned_matches(receipt.record, "markerDev", (unsigned long long)(unsigned int)members.marker_identity.st_dev) &&
    pm_scope_unsigned_matches(receipt.record, "markerIno", (unsigned long long)members.marker_identity.st_ino);
  if (fd >= 0) close(fd);
  if (!valid) { close(members.directory); return 125; }
  char negative_leaf[NAME_MAX + 1];
  int negative_parent = pm_private_parent(negative, "/.portmanager/security/profiles/", negative_leaf, sizeof(negative_leaf));
  struct stat parent, marker_parent, negative_file;
  int negative_fd = negative_parent < 0 ? -1 : openat(negative_parent, negative_leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  valid = negative_fd >= 0 && fstat(negative_parent, &parent) == 0 && fstat(members.directory, &marker_parent) == 0 &&
    parent.st_dev == marker_parent.st_dev && parent.st_ino == marker_parent.st_ino && pm_private_regular(negative_fd, &negative_file) == 0;
  if (negative_fd >= 0) close(negative_fd);
  if (negative_parent >= 0) close(negative_parent);
  if (!valid) { close(members.directory); return 125; }
  members.check = (pm_launch_sandbox_check_fn)dlsym(RTLD_DEFAULT, "sandbox_check");
  members.send_signal = (pm_audit_signal_fn)dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
  const int *quiet = dlsym(RTLD_DEFAULT, "SANDBOX_CHECK_NO_REPORT");
  if (members.check == NULL || members.send_signal == NULL || quiet == NULL) { close(members.directory); return 125; }
  members.quiet = *quiet;
  for (;;) {
    int result = pm_launch_members_sweep(&members, SIGKILL);
    if (result == 1) break;
    if (pm_launch_signal != 0) { close(members.directory); free(members.pids); free(members.current); free(members.previous); return 125; }
    (void)poll(NULL, 0, 20);
  }
  if (pm_launch_receipt_publish(&receipt) != 0) { close(members.directory); free(members.pids); free(members.current); free(members.previous); return 125; }
  pm_launch_members_close(&members);
  puts("{\"cleaned\":true,\"version\":1}"); return 0;
}

#endif

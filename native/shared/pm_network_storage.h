#ifndef PM_NETWORK_STORAGE_H
#define PM_NETWORK_STORAGE_H

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "pm_network_namespace.h"

/* User settings live in readable names, not encoded IDs. The small private
 * marker lets trusted process identity find its folder even with duplicate
 * names or spoofed environment names. Called at startup/exec, never per open.
 * Descriptor-relative reads reject namespace and marker symlinks. */
static int pm_network_storage_directory(const char *root, const char *network_id, char *output, size_t size) {
  char parent[4096], identity[PM_NETWORK_NAMESPACE_MAX_ID_BYTES + 1];
  char key[PM_NETWORK_NAMESPACE_KEY_SIZE];
  struct stat info;
  int found = 0, result = -1, parent_fd = -1;
  DIR *entries = NULL;
  if (pm_network_namespace_key(network_id, key, sizeof(key)) != 0) { errno = EINVAL; return -1; }
  int written = snprintf(parent, sizeof(parent), "%s/.portmanager", root);
  if (written <= 0 || (size_t)written >= sizeof(parent)) { errno = ENAMETOOLONG; return -1; }
  int state = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (state < 0) return -1;
  if (fstat(state, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == geteuid()) {
    parent_fd = openat(state, "namespaces", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  }
  close(state);
  if (parent_fd < 0) return -1;
  if (fstat(parent_fd, &info) != 0 || !S_ISDIR(info.st_mode) || info.st_uid != geteuid()) goto done;
  entries = fdopendir(parent_fd);
  if (entries == NULL) goto done;
  struct dirent *entry;
  while ((entry = readdir(entries)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    int directory = openat(parent_fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) continue;
    int marker = -1;
    if (fstat(directory, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == geteuid()) {
      marker = openat(directory, ".network-id", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    }
    close(directory);
    if (marker < 0) continue;
    ssize_t length = -1;
    if (fstat(marker, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == geteuid()) {
      length = read(marker, identity, sizeof(identity));
    }
    close(marker);
    if (length != (ssize_t)strlen(network_id) || memcmp(identity, network_id, (size_t)length) != 0) continue;
    if (found) { errno = EEXIST; goto done; }
    written = snprintf(output, size, "%s/.portmanager/namespaces/%s", root, entry->d_name);
    if (written <= 0 || (size_t)written >= size) { errno = ENAMETOOLONG; goto done; }
    found = 1;
  }
  if (found) result = 0;
  else errno = ENOENT;
done:
  {
    int saved = errno;
    if (entries != NULL) closedir(entries);
    else close(parent_fd);
    errno = saved;
  }
  return result;
}

#endif

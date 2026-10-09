#ifndef PM_PRIVATE_FILE_H
#define PM_PRIVATE_FILE_H

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Keep the validated parent descriptor through publication/read/cleanup. A
 * path check followed by reopening the path would reintroduce symlink races. */
static int pm_private_parent(const char *path, const char *boundary, char *leaf, size_t capacity) {
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX || strstr(path, boundary) == NULL) { errno = EINVAL; return -1; }
  char copy[PATH_MAX]; strcpy(copy, path);
  char *name = strrchr(copy, '/');
  if (name == NULL || name[1] == '\0' || strlen(name + 1) >= capacity || strcmp(name + 1, ".") == 0 || strcmp(name + 1, "..") == 0) {
    errno = EINVAL; return -1;
  }
  *name++ = '\0'; strcpy(leaf, name);
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  char *save = NULL;
  for (char *part = strtok_r(copy, "/", &save); directory >= 0 && part != NULL; part = strtok_r(NULL, "/", &save)) {
    if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) { close(directory); errno = EINVAL; return -1; }
    int next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(directory); directory = next;
  }
  struct stat parent;
  if (directory < 0) return -1;
  if (fstat(directory, &parent) != 0 || parent.st_uid != geteuid() || (parent.st_mode & 077) != 0) {
    close(directory); errno = EACCES; return -1;
  }
  return directory;
}
static int pm_private_regular(int fd, struct stat *identity) {
  if (fstat(fd, identity) != 0 || !S_ISREG(identity->st_mode) || identity->st_uid != geteuid() ||
      (identity->st_mode & 0777) != 0600 || identity->st_nlink != 1) { errno = EACCES; return -1; }
  return 0;
}

#endif

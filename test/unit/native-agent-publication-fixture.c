/* macOS test interposer: block only writes to this fixture's generated temp
 * files. Production code has no test gates or artificial delay settings. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* Keep the interposer in the agent only. Native arm64 macOS can reject this
 * test dylib in protected /bin/sh scan children even on a CI VM without SIP. */
__attribute__((constructor)) static void pm_test_publication_loaded(void) {
  unsetenv("DYLD_INSERT_LIBRARIES");
}

static ssize_t pm_test_publication_write(int fd, const void *bytes, size_t length) {
  int saved_errno = errno;
  const char *root = getenv("PM_PUBLICATION_TEST_ROOT");
  char target[PATH_MAX];
  if (root != NULL && fcntl(fd, F_GETPATH, target) == 0 &&
      strncmp(target, root, strlen(root)) == 0 && target[strlen(root)] == '/' &&
      strstr(target + strlen(root), "/routes") != NULL && strstr(target, ".tmp.") != NULL) {
    const char *kind = strstr(target, "-browser-dns.tsv") != NULL ? "dns" : "routes";
    char block[PATH_MAX], entered[PATH_MAX];
    snprintf(block, sizeof(block), "%s/block-%s", root, kind);
    snprintf(entered, sizeof(entered), "%s/entered-%s", root, kind);
    if (access(block, F_OK) == 0) {
      int marker = open(entered, O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
      if (marker >= 0) close(marker);
      struct timespec pause = {0, 5000000};
      while (access(block, F_OK) == 0) nanosleep(&pause, NULL);
    }
  }
  errno = saved_errno;
  return write(fd, bytes, length);
}

__attribute__((used)) static const struct { const void *replacement; const void *original; }
pm_test_publication_interpose __attribute__((section("__DATA,__interpose"))) = {
  (const void *)pm_test_publication_write, (const void *)write
};

/*
 * Port Manager development log endpoint. See pm_dev_log.h and docs/dev-logging.md.
 *
 * Design notes:
 *  - Gated entirely by the PORT_MANAGER_DEV_LOG environment variable so the
 *    facility is compiled into every build yet costs nothing when unset.
 *  - Per-call open(O_APPEND|O_CREAT) + single write() + close(): O_APPEND makes
 *    each write land at EOF atomically, so concurrent writers (multiple router
 *    worker threads, the injected hook across many processes) interleave by
 *    whole lines rather than corrupting each other. A per-call open also means
 *    no cached descriptor can leak into a hooked child across fork/exec.
 *  - No dependency on Port Manager internals, so any native binary can link it.
 */

#include "pm_dev_log.h"

#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define PM_DEV_LOG_ENV "PORT_MANAGER_DEV_LOG"
#define PM_DEV_LOG_BODY_MAX 2048
#define PM_DEV_LOG_LINE_MAX (PM_DEV_LOG_BODY_MAX + 128)
#define PM_DEV_LOG_MAX_BYTES ((off_t)64 * 1024 * 1024)

/**
 * An enabled development endpoint still stops at a bounded size. The hook is
 * loaded into every routed child, so unlimited synchronous append traffic can
 * otherwise dominate shell and process startup long after a trace is useful.
 */
static int pm_dev_log_path_has_capacity(const char *path) {
  struct stat path_stat;

  if (path == NULL || path[0] == '\0') {
    return 0;
  }
  if (stat(path, &path_stat) != 0) {
    return 1;
  }
  return path_stat.st_size < PM_DEV_LOG_MAX_BYTES;
}

int pm_dev_log_enabled(void) {
  const char *path = getenv(PM_DEV_LOG_ENV);
  return pm_dev_log_path_has_capacity(path);
}

void pm_dev_log(const char *component, const char *format, ...) {
  const char *path = getenv(PM_DEV_LOG_ENV);
  if (path == NULL || path[0] == '\0') {
    return;
  }

  char body[PM_DEV_LOG_BODY_MAX];
  va_list args;
  va_start(args, format);
  int written = vsnprintf(body, sizeof(body), format, args);
  va_end(args);
  if (written < 0) {
    body[0] = '\0';
  }

  char stamp[32];
  struct timeval now;
  if (gettimeofday(&now, NULL) == 0) {
    struct tm local_tm;
    time_t seconds = (time_t)now.tv_sec;
    if (localtime_r(&seconds, &local_tm) != NULL) {
      size_t base = strftime(stamp, sizeof(stamp), "%H:%M:%S", &local_tm);
      snprintf(stamp + base, sizeof(stamp) - base, ".%06ld", (long)now.tv_usec);
    } else {
      snprintf(stamp, sizeof(stamp), "%ld.%06ld", (long)now.tv_sec, (long)now.tv_usec);
    }
  } else {
    snprintf(stamp, sizeof(stamp), "unknown");
  }

  char line[PM_DEV_LOG_LINE_MAX];
  int total = snprintf(line, sizeof(line), "%s [%s pid=%ld] %s\n", stamp,
                       component != NULL ? component : "?", (long)getpid(), body);
  if (total < 0) {
    return;
  }
  if ((size_t)total >= sizeof(line)) {
    total = (int)sizeof(line) - 1;
  }

  int fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0644);
  if (fd < 0) {
    return;
  }
  struct stat file_stat;
  if (fstat(fd, &file_stat) != 0 ||
      file_stat.st_size >= PM_DEV_LOG_MAX_BYTES ||
      (off_t)total > PM_DEV_LOG_MAX_BYTES - file_stat.st_size) {
    close(fd);
    return;
  }
  ssize_t ignored = write(fd, line, (size_t)total);
  (void)ignored;
  close(fd);
}

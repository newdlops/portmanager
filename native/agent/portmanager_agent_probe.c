#include "portmanager_agent.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define PM_PROBE_TIMEOUT_MS 350
#define PM_PROBE_RESPONSE_MAX 8192

static void pm_agent_usage(void) {
  fprintf(stderr,
          "Usage: portmanager_agent --socket <path> [--route-table <path>] [--agent-main <path>]\n"
          "       portmanager_agent --probe --socket <path> --agent-main <path>\n"
          "       portmanager_agent --lock-stale <path>\n");
}

/** Copies one CLI path without silently accepting a truncated identity. */
static int pm_copy_cli_path(char *out, size_t out_size, const char *value) {
  int written = snprintf(out, out_size, "%s", value);
  return written < 0 || (size_t)written >= out_size ? -1 : 0;
}

int pm_parse_agent_arguments(int argc, char **argv, pm_agent_arguments *arguments) {
  memset(arguments, 0, sizeof(*arguments));

  for (int index = 1; index < argc; index++) {
    char *value;
    if (strcmp(argv[index], "--probe") == 0) {
      arguments->probe_only = 1;
      continue;
    }
    if (index + 1 >= argc) {
      pm_agent_usage();
      return -1;
    }
    value = argv[++index];
    if (strcmp(argv[index - 1], "--lock-stale") == 0) {
      arguments->lock_stale_mode = 1;
      if (pm_copy_cli_path(arguments->stale_lock_path, sizeof(arguments->stale_lock_path), value) != 0) {
        return -1;
      }
      continue;
    }
    if (strcmp(argv[index - 1], "--socket") == 0) {
      if (pm_copy_cli_path(arguments->socket_path, sizeof(arguments->socket_path), value) != 0) {
        return -1;
      }
      continue;
    }
    if (strcmp(argv[index - 1], "--route-table") == 0) {
      if (pm_copy_cli_path(arguments->route_table_path, sizeof(arguments->route_table_path), value) != 0) {
        return -1;
      }
      continue;
    }
    if (strcmp(argv[index - 1], "--agent-main") == 0) {
      if (pm_copy_cli_path(arguments->agent_main_path, sizeof(arguments->agent_main_path), value) != 0) {
        return -1;
      }
      continue;
    }
    pm_agent_usage();
    return -1;
  }

  if (arguments->lock_stale_mode) {
    return arguments->stale_lock_path[0] == '\0' || arguments->probe_only || arguments->socket_path[0] != '\0' ||
      arguments->route_table_path[0] != '\0' || arguments->agent_main_path[0] != '\0' ? -1 : 0;
  }
  if (arguments->probe_only) {
    return arguments->socket_path[0] == '\0' || arguments->agent_main_path[0] == '\0' ||
      arguments->route_table_path[0] != '\0' ? -1 : 0;
  }
  if (arguments->socket_path[0] == '\0') {
    pm_agent_usage();
    return -1;
  }
  return 0;
}

/** Returns success only when a startup lock has exceeded the recovery window. */
int pm_lock_is_stale(const char *lock_path) {
  struct stat lock_stat;
  time_t now;

  if (stat(lock_path, &lock_stat) != 0) {
    return 0;
  }

  now = time(NULL);
  return now > lock_stat.st_mtime && now - lock_stat.st_mtime > 15;
}

static int pm_probe_monotonic_milliseconds(long long *value) {
  struct timespec now;

  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    return -1;
  }
  *value = (long long)now.tv_sec * 1000LL + (long long)now.tv_nsec / 1000000LL;
  return 0;
}

/** Waits for one socket operation without extending the probe's total budget. */
static int pm_probe_wait(int fd, short events, long long deadline_ms) {
  struct pollfd descriptor;
  int ready;

  memset(&descriptor, 0, sizeof(descriptor));
  descriptor.fd = fd;
  descriptor.events = events;
  for (;;) {
    long long now;
    long long remaining;
    if (pm_probe_monotonic_milliseconds(&now) != 0) {
      return -1;
    }
    remaining = deadline_ms - now;
    if (remaining <= 0) {
      return -1;
    }
    if (remaining > PM_PROBE_TIMEOUT_MS) {
      remaining = PM_PROBE_TIMEOUT_MS;
    }
    ready = poll(&descriptor, 1, (int)remaining);
    if (ready < 0 && errno == EINTR) {
      continue;
    }
    break;
  }

  if (ready <= 0) {
    return -1;
  }
  /* A peer can close immediately after its final bytes, so readable data wins
   * over a simultaneous POLLHUP. */
  return (descriptor.revents & events) != 0 ? 0 : -1;
}

static int pm_probe_set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/** Opens the daemon socket without letting a stale endpoint hold up a prompt. */
static int pm_probe_connect(const char *socket_path, long long deadline_ms) {
  struct sockaddr_un address;
  int fd;
  int socket_error = 0;
  socklen_t socket_error_size = sizeof(socket_error);

  if (strlen(socket_path) >= sizeof(address.sun_path)) {
    return -1;
  }

  fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0 || pm_probe_set_nonblocking(fd) != 0) {
    if (fd >= 0) {
      close(fd);
    }
    return -1;
  }

  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  snprintf(address.sun_path, sizeof(address.sun_path), "%s", socket_path);
  if (connect(fd, (const struct sockaddr *)&address, sizeof(address)) != 0 &&
      (errno != EINPROGRESS || pm_probe_wait(fd, POLLOUT, deadline_ms) != 0 ||
       getsockopt(fd, SOL_SOCKET, SO_ERROR, &socket_error, &socket_error_size) != 0 || socket_error != 0)) {
    close(fd);
    return -1;
  }

  return fd;
}

static int pm_probe_write_all(int fd, const char *data, size_t length, long long deadline_ms) {
  size_t offset = 0;

  while (offset < length) {
    long long now;
    ssize_t written;
    if (pm_probe_monotonic_milliseconds(&now) != 0 || now >= deadline_ms) {
      return -1;
    }
    written = write(fd, data + offset, length - offset);
    if (written > 0) {
      offset += (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) &&
        pm_probe_wait(fd, POLLOUT, deadline_ms) == 0) {
      continue;
    }
    return -1;
  }
  return 0;
}

static int pm_is_leap_year(int year) {
  return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
}

/** Converts the daemon's ISO-8601 UTC timestamp without relying on timegm(). */
static int pm_iso8601_epoch_milliseconds(const char *value, long long *epoch_ms) {
  static const int days_per_month[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  int year;
  int month;
  int day;
  int hour;
  int minute;
  int second;
  int consumed = 0;
  int milliseconds = 0;
  int fractional_digits = 0;
  const char *cursor;
  long long era;
  long long year_of_era;
  long long day_of_year;
  long long day_of_era;
  long long days_since_epoch;

  if (sscanf(value, "%d-%d-%dT%d:%d:%d%n", &year, &month, &day, &hour, &minute, &second, &consumed) != 6 ||
      year < 1970 || year > 9999 || month < 1 || month > 12 || hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 || second < 0 || second > 59) {
    return -1;
  }
  if (day < 1 || day > days_per_month[month - 1] + (month == 2 && pm_is_leap_year(year) ? 1 : 0)) {
    return -1;
  }

  cursor = value + consumed;
  if (*cursor == '.') {
    cursor++;
    while (*cursor >= '0' && *cursor <= '9') {
      if (fractional_digits < 3) {
        milliseconds = milliseconds * 10 + (*cursor - '0');
      }
      fractional_digits++;
      cursor++;
    }
    if (fractional_digits == 0) {
      return -1;
    }
    while (fractional_digits < 3) {
      milliseconds *= 10;
      fractional_digits++;
    }
  }
  if (cursor[0] != 'Z' || cursor[1] != '\0') {
    return -1;
  }

  year -= month <= 2;
  era = (year >= 0 ? year : year - 399) / 400;
  year_of_era = year - era * 400;
  day_of_year = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
  day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  days_since_epoch = era * 146097 + day_of_era - 719468;
  *epoch_ms = (((days_since_epoch * 24 + hour) * 60 + minute) * 60 + second) * 1000 + milliseconds;
  return 0;
}

static int pm_stat_mtime_is_newer_than_milliseconds(const struct stat *file_stat, long long threshold_ms) {
  long long modified_seconds;
  long modified_nanoseconds;
  long long threshold_seconds = threshold_ms / 1000;
  long threshold_nanoseconds = (long)(threshold_ms % 1000) * 1000000L;
#if defined(__APPLE__)
  modified_seconds = (long long)file_stat->st_mtimespec.tv_sec;
  modified_nanoseconds = file_stat->st_mtimespec.tv_nsec;
#else
  modified_seconds = (long long)file_stat->st_mtim.tv_sec;
  modified_nanoseconds = file_stat->st_mtim.tv_nsec;
#endif
  return modified_seconds > threshold_seconds ||
    (modified_seconds == threshold_seconds && modified_nanoseconds > threshold_nanoseconds);
}

/**
 * Checks the existing daemon in-process instead of starting Electron/Node.
 * The metadata checks mirror the former JS startup probe: the daemon must own
 * the expected agent entrypoint and must not predate a rebuilt entrypoint.
 */
int pm_probe_daemon(const char *socket_path, const char *expected_agent_main_path) {
  static const char request[] = "{\"id\":\"native-probe\",\"method\":\"daemonStatus\"}\n";
  char response[PM_PROBE_RESPONSE_MAX];
  char ok[16];
  char actual_agent_main_path[PM_TEXT];
  char started_at[PM_TIME];
  const char *actual_comparison = actual_agent_main_path;
  const char *expected_comparison = expected_agent_main_path;
  char *actual_resolved = NULL;
  char *expected_resolved = NULL;
  const char *payload;
  struct stat expected_stat;
  size_t response_length = 0;
  long long started_at_ms;
  long long now_ms;
  long long deadline_ms;
  int saw_newline = 0;
  int fd;
  int result = -1;

  if (pm_probe_monotonic_milliseconds(&now_ms) != 0) {
    return -1;
  }
  deadline_ms = now_ms + PM_PROBE_TIMEOUT_MS;
  fd = pm_probe_connect(socket_path, deadline_ms);
  if (fd < 0 || pm_probe_write_all(fd, request, sizeof(request) - 1, deadline_ms) != 0) {
    if (fd >= 0) {
      close(fd);
    }
    return -1;
  }

  while (response_length + 1 < sizeof(response)) {
    ssize_t count;
    char *newline;
    if (pm_probe_wait(fd, POLLIN, deadline_ms) != 0) {
      goto done;
    }
    count = read(fd, response + response_length, sizeof(response) - response_length - 1);
    if (count <= 0) {
      goto done;
    }
    response_length += (size_t)count;
    response[response_length] = '\0';
    newline = memchr(response, '\n', response_length);
    if (newline != NULL) {
      *newline = '\0';
      saw_newline = 1;
      break;
    }
  }

  payload = saw_newline ? pm_json_payload(response) : NULL;
  if (payload == NULL || *payload != '{' || pm_json_get_raw(response, "ok", ok, sizeof(ok)) != 0 ||
      strcmp(ok, "true") != 0 ||
      pm_json_get_string(payload, "agentMainPath", actual_agent_main_path, sizeof(actual_agent_main_path)) != 0 ||
      actual_agent_main_path[0] == '\0') {
    goto done;
  }

  actual_resolved = realpath(actual_agent_main_path, NULL);
  expected_resolved = realpath(expected_agent_main_path, NULL);
  if (actual_resolved != NULL) {
    actual_comparison = actual_resolved;
  }
  if (expected_resolved != NULL) {
    expected_comparison = expected_resolved;
  }
  if (strcmp(actual_comparison, expected_comparison) != 0) {
    goto done;
  }

  if (pm_json_get_string(payload, "startedAt", started_at, sizeof(started_at)) == 0 &&
      pm_iso8601_epoch_milliseconds(started_at, &started_at_ms) == 0 &&
      stat(expected_agent_main_path, &expected_stat) == 0 &&
      pm_stat_mtime_is_newer_than_milliseconds(&expected_stat, started_at_ms + 1000)) {
    goto done;
  }

  result = 0;

done:
  free(actual_resolved);
  free(expected_resolved);
  close(fd);
  return result;
}

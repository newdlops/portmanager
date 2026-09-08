#include "portmanager_agent_scan.h"
#include "../shared/pm_dev_log.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#define PM_SCAN_MAX_JOBS 128
#define PM_SCAN_CONCURRENCY 4
#define PM_SCAN_MAX_OUTPUT (4 * 1024 * 1024)
#define PM_SCAN_TOTAL_OUTPUT (16 * 1024 * 1024)
#define PM_SCAN_REQUEST_MS 8000
#define PM_SCAN_COMMAND_MS 3000

/* The control thread owns this broker. In-flight commands are shared by
 * readers, while the last reference cancels and reaps their process group. */
typedef struct pm_scan_job {
  struct pm_scan_job *next;
  char *command;
  char *output;
  size_t length;
  size_t capacity;
  unsigned int references;
  pid_t pid;
  int fd;
  int done;
  int failed;
  int exited;
  int status;
  long long deadline;
  unsigned long generation;
  unsigned long registration_revision;
} pm_scan_job;

struct pm_scan_context {
  pm_scan_job *jobs[PM_SCAN_MAX_JOBS];
  size_t count;
  long long deadline;
  unsigned long generation;
  unsigned long registration_revision;
};

static pm_scan_job *pm_scan_jobs;
static pm_scan_context *pm_scan_current;
static size_t pm_scan_job_count;
static size_t pm_scan_output_bytes;

static long long pm_scan_now(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

/* Tests can shorten the deadline; production remains bounded even with a bad env value. */
static int pm_scan_timeout(void) {
  const char *value = getenv("PORT_MANAGER_AGENT_SCAN_TIMEOUT_MS");
  long parsed = value == NULL ? PM_SCAN_COMMAND_MS : strtol(value, NULL, 10);
  return parsed >= 50 && parsed <= PM_SCAN_REQUEST_MS ? (int)parsed : PM_SCAN_COMMAND_MS;
}

static void pm_scan_stop(pm_scan_job *job) {
  if (job->pid > 0 && (!job->exited || job->fd >= 0)) {
    /* Each command has its own process group, including any lsof/ps wrapper. */
    kill(-job->pid, SIGKILL);
  }
  if (job->fd >= 0) { close(job->fd); job->fd = -1; }
}

static void pm_scan_free_job(pm_scan_job *job) {
  pm_scan_output_bytes -= job->capacity;
  free(job->command);
  free(job->output);
  free(job);
  pm_scan_job_count--;
}

pm_scan_context *pm_scan_context_create(void) {
  pm_scan_context *context = calloc(1, sizeof(*context));
  if (context != NULL) context->deadline = pm_scan_now() + PM_SCAN_REQUEST_MS;
  return context;
}

static void pm_scan_release_observations(pm_scan_context *context) {
  if (context == NULL) return;
  for (size_t index = 0; index < context->count; index++) {
    pm_scan_job *job = context->jobs[index];
    if (--job->references == 0) {
      pm_scan_stop(job);
      job->failed = 1;
    }
  }
  context->count = 0;
}

void pm_scan_context_free(pm_scan_context *context) {
  pm_scan_release_observations(context);
  free(context);
}

void pm_scan_context_update_generation(pm_scan_context *context, unsigned long generation) {
  if (context != NULL && context->generation != generation) {
    pm_scan_release_observations(context);
    context->generation = generation;
  }
}

int pm_scan_context_expired(const pm_scan_context *context) {
  return context != NULL && pm_scan_now() >= context->deadline;
}

void pm_scan_context_update_registration(pm_scan_context *context, unsigned long revision) {
  if (context != NULL) context->registration_revision = revision;
}

unsigned long pm_scan_registration_revision(const char *command) {
  for (size_t index = 0; pm_scan_current != NULL && index < pm_scan_current->count; index++) {
    pm_scan_job *job = pm_scan_current->jobs[index];
    if (strcmp(job->command, command) == 0) return job->registration_revision;
  }
  return 0;
}

int pm_scan_require(pm_scan_context *context, const char *command) {
  pm_scan_job *job;
  if (context == NULL || pm_scan_context_expired(context)) return -1;
  for (size_t index = 0; index < context->count; index++) {
    job = context->jobs[index];
    if (strcmp(job->command, command) == 0) return job->done ? 0 : 1;
  }
  if (context->count >= PM_SCAN_MAX_JOBS) return -1;
  for (job = pm_scan_jobs; job != NULL; job = job->next) {
    /* Only share unfinished observations. Explicit later repair must not
     * silently reuse the result of an earlier completed repair. */
    if (job->references > 0 && !job->done && !job->failed && job->generation == context->generation &&
        strcmp(job->command, command) == 0) break;
  }
  if (job == NULL) {
    if (pm_scan_job_count >= PM_SCAN_MAX_JOBS) return -1;
    job = calloc(1, sizeof(*job));
    if (job == NULL) return -1;
    job->command = strdup(command);
    if (job->command == NULL) { free(job); return -1; }
    job->fd = -1;
    job->generation = context->generation;
    job->registration_revision = context->registration_revision;
    job->deadline = pm_scan_now() + pm_scan_timeout();
    job->next = pm_scan_jobs;
    pm_scan_jobs = job;
    pm_scan_job_count++;
  }
  job->references++;
  context->jobs[context->count++] = job;
  return job->done ? 0 : 1;
}

void pm_scan_use(pm_scan_context *context) { pm_scan_current = context; }

const char *pm_scan_output(const char *command) {
  for (size_t index = 0; pm_scan_current != NULL && index < pm_scan_current->count; index++) {
    pm_scan_job *job = pm_scan_current->jobs[index];
    if (strcmp(job->command, command) == 0) {
      if (!job->done || job->failed || !WIFEXITED(job->status) ||
          (WEXITSTATUS(job->status) != 0 && WEXITSTATUS(job->status) != 1)) return NULL;
      return job->output == NULL ? "" : job->output;
    }
  }
  /* State operations may only consume prepared output. A missed preflight
   * cannot accidentally reintroduce blocking popen into the control loop. */
  return NULL;
}

char *pm_scan_read_line(char *line, size_t size, const char **cursor) {
  if (cursor == NULL || *cursor == NULL || **cursor == '\0' || size < 2) return NULL;
  const char *newline = strchr(*cursor, '\n');
  size_t length = newline == NULL ? strlen(*cursor) : (size_t)(newline - *cursor) + 1;
  if (length >= size) length = size - 1;
  memcpy(line, *cursor, length);
  line[length] = '\0';
  *cursor += length;
  return line;
}

static void pm_scan_spawn(pm_scan_job *job) {
  int descriptors[2];
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  sigset_t empty;
  int error;
  int actions_ready = 0;
  int attributes_ready = 0;
  if (pipe(descriptors) != 0) { job->failed = job->done = 1; return; }
  if (fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) < 0 ||
      fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) < 0 ||
      fcntl(descriptors[0], F_SETFL, O_NONBLOCK) < 0) goto failed;
  if (posix_spawn_file_actions_init(&actions) != 0) goto failed;
  actions_ready = 1;
  if (posix_spawn_file_actions_adddup2(&actions, descriptors[1], STDOUT_FILENO) != 0 ||
      posix_spawn_file_actions_addclose(&actions, descriptors[0]) != 0 ||
      posix_spawn_file_actions_addclose(&actions, descriptors[1]) != 0 ||
      posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) != 0 ||
      posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) != 0) goto failed;
  if (posix_spawnattr_init(&attributes) != 0) goto failed;
  attributes_ready = 1;
  sigemptyset(&empty);
  if (posix_spawnattr_setsigmask(&attributes, &empty) != 0 ||
      posix_spawnattr_setpgroup(&attributes, 0) != 0 ||
      posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK) != 0) goto failed;
  char *argv[] = {"sh", "-c", job->command, NULL};
  error = posix_spawn(&job->pid, "/bin/sh", &actions, &attributes, argv, environ);
  if (error != 0) goto failed;
  posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions);
  close(descriptors[1]);
  job->fd = descriptors[0];
  return;
failed:
  if (attributes_ready) posix_spawnattr_destroy(&attributes);
  if (actions_ready) posix_spawn_file_actions_destroy(&actions);
  close(descriptors[0]);
  close(descriptors[1]);
  job->pid = 0; job->failed = job->done = 1;
}

static int pm_scan_append(pm_scan_job *job, const char *text, size_t length) {
  size_t needed = job->length + length + 1;
  if (needed > PM_SCAN_MAX_OUTPUT) return -1;
  if (needed > job->capacity) {
    size_t capacity = job->capacity == 0 ? 4096 : job->capacity;
    while (capacity < needed) capacity *= 2;
    if (pm_scan_output_bytes + capacity - job->capacity > PM_SCAN_TOTAL_OUTPUT) return -1;
    char *next = realloc(job->output, capacity);
    if (next == NULL) return -1;
    pm_scan_output_bytes += capacity - job->capacity;
    job->output = next; job->capacity = capacity;
  }
  memcpy(job->output + job->length, text, length);
  job->length += length;
  job->output[job->length] = '\0';
  return 0;
}

int pm_scan_poll(void) {
  int active = 0;
  int pending = 0;
  long long now = pm_scan_now();
  pm_scan_job **link = &pm_scan_jobs;
  for (pm_scan_job *job = pm_scan_jobs; job != NULL; job = job->next) {
    if (job->pid > 0 && (!job->exited || job->fd >= 0)) active++;
  }
  while (*link != NULL) {
    pm_scan_job *job = *link;
    if (!job->done && !job->failed && now >= job->deadline) {
      job->failed = 1;
      pm_scan_stop(job);
      pm_dev_log("agent-scan", "command deadline exceeded command=%s", job->command);
    }
    if (job->references == 0) { job->failed = 1; pm_scan_stop(job); }
    if (job->pid == 0 && !job->failed && !job->done && active < PM_SCAN_CONCURRENCY) {
      pm_scan_spawn(job);
      if (job->pid > 0) active++;
    }
    if (job->fd >= 0) {
      char buffer[8192];
      /* Bound one pass so a large lsof output cannot monopolize control RPCs. */
      for (int reads = 0; reads < 4; reads++) {
        ssize_t count = read(job->fd, buffer, sizeof(buffer));
        if (count > 0) {
          if (pm_scan_append(job, buffer, (size_t)count) != 0) { job->failed = 1; pm_scan_stop(job); break; }
        } else if (count == 0) { close(job->fd); job->fd = -1; break; }
        else if (errno != EINTR) {
          if (errno != EAGAIN && errno != EWOULDBLOCK) { job->failed = 1; pm_scan_stop(job); }
          break;
        }
      }
    }
    if (job->pid > 0 && !job->exited) {
      pid_t result = waitpid(job->pid, &job->status, WNOHANG);
      if (result == job->pid || (result < 0 && errno == ECHILD)) {
        job->exited = 1;
        if (result < 0) job->failed = 1;
      }
    }
    if ((job->pid == 0 && job->failed) || (job->exited && job->fd < 0)) job->done = 1;
    if (job->done && job->references == 0) {
      *link = job->next; pm_scan_free_job(job); continue;
    }
    if (!job->done) pending = 1;
    link = &job->next;
  }
  return pending;
}

int pm_scan_reaped(pid_t pid, int status) {
  for (pm_scan_job *job = pm_scan_jobs; job != NULL; job = job->next) {
    if (job->pid == pid && !job->exited) {
      job->status = status;
      job->exited = 1;
      return 1;
    }
  }
  return 0;
}

void pm_scan_dispose(void) {
  for (pm_scan_job *job = pm_scan_jobs; job != NULL; job = job->next) pm_scan_stop(job);
  while (pm_scan_jobs != NULL) {
    pm_scan_job *job = pm_scan_jobs;
    pm_scan_jobs = job->next;
    if (job->pid > 0 && !job->exited) {
      while (waitpid(job->pid, &job->status, 0) < 0 && errno == EINTR) {}
    }
    pm_scan_free_job(job);
  }
  pm_scan_current = NULL;
}

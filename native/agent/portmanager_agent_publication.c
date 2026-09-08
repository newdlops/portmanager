#include "portmanager_agent_publication.h"
#include "../shared/pm_dev_log.h"

#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <time.h>

#define PM_PUBLICATION_MAX_JOBS 32
#define PM_PUBLICATION_DEADLINE_MS 8000

/* Receipt ownership is confined to the control thread. The I/O thread sees
 * only the active job's immutable context and its atomic cancellation flag. */
struct pm_publication_receipt {
  size_t references;
  int status;
  char *response;
};

typedef struct pm_publication_job {
  struct pm_publication_job *next;
  pm_publication_operations operations;
  void *context;
  size_t bytes;
  long long deadline_ms;
  atomic_int canceled;
  pm_publication_receipt *receipt;
  int result;
} pm_publication_job;

struct pm_publication_lane {
  pthread_t thread;
  pthread_mutex_t mutex;
  pthread_cond_t wake;
  /* Only active/done/stopping cross threads, always under mutex. Queue and
   * accounting stay on the control thread, including completion callbacks. */
  pm_publication_job *active;
  int done;
  int stopping;
  pm_publication_job *head;
  pm_publication_job *tail;
  size_t count;
  size_t bytes;
  void *owner;
  size_t max_bytes;
  void (*destroy_owner)(void *);
};

static _Thread_local pm_publication_job *pm_current_publication;

long long pm_publication_now_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

int pm_publication_canceled(void) {
  return pm_current_publication != NULL &&
    (atomic_load(&pm_current_publication->canceled) ||
     pm_publication_now_ms() >= pm_current_publication->deadline_ms);
}

pm_publication_receipt *pm_publication_retain(pm_publication_receipt *receipt) {
  if (receipt != NULL) receipt->references++;
  return receipt;
}

void pm_publication_release(pm_publication_receipt *receipt) {
  if (receipt != NULL && --receipt->references == 0) {
    free(receipt->response);
    free(receipt);
  }
}

int pm_publication_status(const pm_publication_receipt *receipt) {
  return receipt == NULL ? -1 : receipt->status;
}

const char *pm_publication_response(const pm_publication_receipt *receipt) {
  return receipt == NULL ? NULL : receipt->response;
}

static void pm_publication_destroy_job(pm_publication_job *job) {
  job->operations.destroy(job->context);
  free(job);
}

static void *pm_publication_work(void *argument) {
  pm_publication_lane *lane = argument;
  pthread_mutex_lock(&lane->mutex);
  for (;;) {
    while (!lane->stopping && (lane->active == NULL || lane->done)) {
      pthread_cond_wait(&lane->wake, &lane->mutex);
    }
    if (lane->stopping) break;
    pm_publication_job *job = lane->active;
    pthread_mutex_unlock(&lane->mutex);
    pm_current_publication = job;
    int result = pm_publication_canceled() ? -1 : job->operations.run(job->context);
    if (pm_publication_canceled()) result = -1;
    pm_current_publication = NULL;
    pthread_mutex_lock(&lane->mutex);
    job->result = result;
    lane->done = 1;
  }
  pm_publication_job *abandoned = lane->active;
  pthread_mutex_unlock(&lane->mutex);
  if (abandoned != NULL) pm_publication_destroy_job(abandoned);
  if (lane->destroy_owner != NULL) lane->destroy_owner(lane->owner);
  pthread_cond_destroy(&lane->wake);
  pthread_mutex_destroy(&lane->mutex);
  free(lane);
  return NULL;
}

pm_publication_lane *pm_publication_create(size_t max_bytes, void *owner, void (*destroy_owner)(void *)) {
  pm_publication_lane *lane = calloc(1, sizeof(*lane));
  if (lane == NULL) return NULL;
  lane->owner = owner;
  lane->max_bytes = max_bytes;
  lane->destroy_owner = destroy_owner;
  if (pthread_mutex_init(&lane->mutex, NULL) != 0) { free(lane); return NULL; }
  if (pthread_cond_init(&lane->wake, NULL) != 0) {
    pthread_mutex_destroy(&lane->mutex);
    free(lane);
    return NULL;
  }
  if (pthread_create(&lane->thread, NULL, pm_publication_work, lane) != 0) {
    pthread_cond_destroy(&lane->wake);
    pthread_mutex_destroy(&lane->mutex);
    free(lane);
    return NULL;
  }
  /* No shutdown join can wait behind a stuck filesystem. The worker owns its
   * lane and snapshot until it returns; the standalone daemon then exits. */
  pthread_detach(lane->thread);
  return lane;
}

pm_publication_receipt *pm_publication_submit(pm_publication_lane *lane, void *context,
    size_t bytes, const pm_publication_operations *operations, int coalesce) {
  pm_publication_job *replaced = lane != NULL && coalesce ? lane->tail : NULL;
  if (lane == NULL || bytes > lane->max_bytes ||
      lane->bytes - (replaced == NULL ? 0 : replaced->bytes) > lane->max_bytes - bytes ||
      (replaced == NULL && lane->count >= PM_PUBLICATION_MAX_JOBS)) {
    operations->destroy(context);
    return NULL;
  }
  if (replaced != NULL) {
    lane->bytes = lane->bytes - replaced->bytes + bytes;
    replaced->operations.destroy(replaced->context);
    replaced->context = context;
    replaced->operations = *operations;
    replaced->bytes = bytes;
    return pm_publication_retain(replaced->receipt);
  }
  pm_publication_job *job = calloc(1, sizeof(*job));
  if (job != NULL) job->receipt = calloc(1, sizeof(*job->receipt));
  if (job == NULL || job->receipt == NULL) {
    free(job);
    operations->destroy(context);
    return NULL;
  }
  atomic_init(&job->canceled, 0);
  job->receipt->references = 1;
  job->context = context;
  job->operations = *operations;
  job->bytes = bytes;
  job->deadline_ms = pm_publication_now_ms() + PM_PUBLICATION_DEADLINE_MS;
  if (lane->tail != NULL) lane->tail->next = job;
  else lane->head = job;
  lane->tail = job;
  lane->count++;
  lane->bytes += bytes;
  return pm_publication_retain(job->receipt);
}

/* At most one callback and one handoff per turn. In particular a DNS revision
 * is applied on the control thread before the next job captures its baseline. */
int pm_publication_poll(pm_publication_lane *lane) {
  if (lane == NULL) return 0;
  long long now = pm_publication_now_ms();
  pm_publication_job *completed = NULL;
  int timed_out = 0;
  pthread_mutex_lock(&lane->mutex);
  if (lane->active != NULL) {
    if (now >= lane->active->deadline_ms) {
      atomic_store(&lane->active->canceled, 1);
      if (lane->active->receipt->status == 0) {
        lane->active->receipt->status = -1;
        timed_out = 1;
      }
    }
    if (lane->done) {
      completed = lane->active;
      lane->active = NULL;
      lane->done = 0;
    }
  }
  int active = lane->active != NULL;
  pthread_mutex_unlock(&lane->mutex);
  if (timed_out) pm_dev_log("agent-publication", "file publication deadline exceeded");
  if (completed != NULL) {
    int result = atomic_load(&completed->canceled) ? -1 : completed->result;
    int finished = completed->operations.finish(completed->context, result, &completed->receipt->response);
    if (completed->receipt->status == 0) completed->receipt->status = finished == 0 ? 1 : -1;
    lane->count--;
    lane->bytes -= completed->bytes;
    pm_publication_release(completed->receipt);
    pm_publication_destroy_job(completed);
  }
  /* Expire queued work even when an active write is stuck. Expiration never
   * exposes an uncommitted DNS table or acknowledges a queued repair. */
  while (lane->head != NULL && now >= lane->head->deadline_ms) {
    pm_publication_job *job = lane->head;
    lane->head = job->next;
    if (lane->head == NULL) lane->tail = NULL;
    job->receipt->status = -1;
    lane->count--;
    lane->bytes -= job->bytes;
    pm_publication_release(job->receipt);
    pm_publication_destroy_job(job);
  }
  if (!active && lane->head != NULL) {
    pm_publication_job *job = lane->head;
    lane->head = job->next;
    if (lane->head == NULL) lane->tail = NULL;
    job->next = NULL;
    if (job->operations.prepare != NULL) job->operations.prepare(job->context);
    pthread_mutex_lock(&lane->mutex);
    lane->active = job;
    pthread_cond_signal(&lane->wake);
    pthread_mutex_unlock(&lane->mutex);
    active = 1;
  }
  return active || lane->head != NULL;
}

void pm_publication_dispose(pm_publication_lane *lane) {
  if (lane == NULL) return;
  while (lane->head != NULL) {
    pm_publication_job *job = lane->head;
    lane->head = job->next;
    job->receipt->status = -1;
    pm_publication_release(job->receipt);
    pm_publication_destroy_job(job);
  }
  pthread_mutex_lock(&lane->mutex);
  if (lane->active != NULL) {
    atomic_store(&lane->active->canceled, 1);
    lane->active->receipt->status = -1;
    pm_publication_release(lane->active->receipt);
    lane->active->receipt = NULL;
  }
  lane->stopping = 1;
  pthread_cond_signal(&lane->wake);
  pthread_mutex_unlock(&lane->mutex);
  /* Nothing may access lane after unlock: the worker frees it on exit. */
}

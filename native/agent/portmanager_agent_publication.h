#ifndef PORTMANAGER_AGENT_PUBLICATION_H
#define PORTMANAGER_AGENT_PUBLICATION_H

#include <stddef.h>

typedef struct pm_publication_lane pm_publication_lane;
typedef struct pm_publication_receipt pm_publication_receipt;

/* Each lane serializes blocking file operations over owned snapshots. Prepare
 * and finish run only on the control thread; run and destroy must never access
 * live registry/client storage. Destroy also supports abandoned shutdown jobs. */
typedef struct {
  void (*prepare)(void *context);
  int (*run)(void *context);
  int (*finish)(void *context, int result, char **response);
  void (*destroy)(void *context);
} pm_publication_operations;

pm_publication_lane *pm_publication_create(size_t max_bytes, void *owner, void (*destroy_owner)(void *));
/* Submission always consumes context. A coalescing lane replaces its queued
 * snapshot, retaining the same receipt/deadline for earlier flush waiters. */
pm_publication_receipt *pm_publication_submit(pm_publication_lane *lane, void *context,
  size_t bytes, const pm_publication_operations *operations, int coalesce);
int pm_publication_poll(pm_publication_lane *lane);
void pm_publication_dispose(pm_publication_lane *lane);
pm_publication_receipt *pm_publication_retain(pm_publication_receipt *receipt);
void pm_publication_release(pm_publication_receipt *receipt);
/* 0 pending, 1 committed, -1 rejected/failed/timed out. Response is borrowed. */
int pm_publication_status(const pm_publication_receipt *receipt);
const char *pm_publication_response(const pm_publication_receipt *receipt);
long long pm_publication_now_ms(void);
/* Cooperative cancellation is checked between file operations and before
 * atomic rename. A blocked kernel operation cannot itself be interrupted. */
int pm_publication_canceled(void);

#endif

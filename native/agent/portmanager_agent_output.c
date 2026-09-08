#include "portmanager_agent_output.h"
#include "../shared/pm_dev_log.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PM_OUTPUT_CLIENT_BYTES (8 * 1024 * 1024)
#define PM_OUTPUT_TOTAL_BYTES (64 * 1024 * 1024)
#define PM_OUTPUT_CLIENT_FRAMES 128
#define PM_OUTPUT_TOTAL_FRAMES 16384
#define PM_OUTPUT_DEADLINE_MS 1000

/* Payload storage is shared across snapshot subscribers; per-client accounting
 * still caps logical backlog, and frame limits cap many tiny response objects. */
struct pm_output_message { size_t references; size_t length; char data[]; };
struct pm_output_receipt { size_t references; int status; };
typedef struct pm_output_frame {
  struct pm_output_frame *next;
  pm_output_message *message;
  size_t offset;
  int snapshot;
  long long deadline;
  pm_output_receipt *receipt;
} pm_output_frame;
struct pm_output_queue {
  int fd;
  int failed;
  pm_output_frame *head;
  pm_output_frame *tail;
  size_t bytes;
  size_t frames;
};
static size_t pm_output_bytes;
static size_t pm_output_frames;

pm_output_queue *pm_output_create(int fd) {
  pm_output_queue *queue = calloc(1, sizeof(*queue));
  if (queue != NULL) queue->fd = fd;
  return queue;
}

pm_output_message *pm_output_message_create(const char *data, size_t length) {
  if (length == 0 || length > PM_OUTPUT_CLIENT_BYTES || length > PM_OUTPUT_TOTAL_BYTES - pm_output_bytes) return NULL;
  pm_output_message *message = malloc(sizeof(*message) + length);
  if (message == NULL) return NULL;
  message->references = 1;
  message->length = length;
  memcpy(message->data, data, length);
  pm_output_bytes += length;
  return message;
}

void pm_output_message_release(pm_output_message *message) {
  if (message != NULL && --message->references == 0) {
    pm_output_bytes -= message->length;
    free(message);
  }
}

static void pm_output_remove_frame(pm_output_queue *queue, pm_output_frame *frame) {
  queue->bytes -= frame->message->length - frame->offset;
  queue->frames--;
  pm_output_frames--;
  if (frame->receipt != NULL) {
    frame->receipt->status = frame->offset == frame->message->length ? 1 : -1;
    pm_output_receipt_release(frame->receipt);
  }
  pm_output_message_release(frame->message);
  free(frame);
}

void pm_output_disconnect(pm_output_queue *queue) {
  if (queue == NULL) return;
  while (queue->head != NULL) {
    pm_output_frame *frame = queue->head;
    queue->head = frame->next;
    pm_output_remove_frame(queue, frame);
  }
  queue->tail = NULL;
  queue->fd = -1;
}

void pm_output_free(pm_output_queue *queue) {
  pm_output_disconnect(queue);
  free(queue);
}

int pm_output_enqueue(pm_output_queue *queue, pm_output_message *message, int snapshot, long long now) {
  if (queue == NULL || queue->fd < 0 || queue->failed || message == NULL) return -1;
  long long deadline = now + PM_OUTPUT_DEADLINE_MS;
  if (snapshot) {
    pm_output_frame **link = &queue->head;
    queue->tail = NULL;
    while (*link != NULL) {
      pm_output_frame *frame = *link;
      if (frame->snapshot && frame->offset == 0) {
        /* Coalescing cannot renew a non-reader's lease indefinitely. A partly
         * transmitted NDJSON frame must always finish before the next frame. */
        if (frame->deadline < deadline) deadline = frame->deadline;
        *link = frame->next;
        pm_output_remove_frame(queue, frame);
      } else {
        queue->tail = frame;
        link = &frame->next;
      }
    }
  }
  if (message->length > PM_OUTPUT_CLIENT_BYTES - queue->bytes ||
      queue->frames >= PM_OUTPUT_CLIENT_FRAMES || pm_output_frames >= PM_OUTPUT_TOTAL_FRAMES) {
    queue->failed = 1;
    pm_dev_log("agent-output", "backlog limit fd=%d bytes=%zu frames=%zu", queue->fd, queue->bytes, queue->frames);
    return -1;
  }
  pm_output_frame *frame = calloc(1, sizeof(*frame));
  if (frame == NULL) { queue->failed = 1; return -1; }
  frame->message = message;
  frame->snapshot = snapshot;
  frame->deadline = deadline;
  message->references++;
  if (queue->tail == NULL) queue->head = frame;
  else queue->tail->next = frame;
  queue->tail = frame;
  queue->bytes += message->length;
  queue->frames++;
  pm_output_frames++;
  return 0;
}

int pm_output_send(pm_output_queue *queue, const char *data, size_t length, long long now) {
  pm_output_message *message = pm_output_message_create(data, length);
  int result = pm_output_enqueue(queue, message, 0, now);
  pm_output_message_release(message);
  if (result != 0 && queue != NULL) queue->failed = 1;
  return result;
}

pm_output_receipt *pm_output_send_tracked(pm_output_queue *queue, const char *data, size_t length, long long now) {
  pm_output_receipt *receipt = calloc(1, sizeof(*receipt));
  if (receipt == NULL) return NULL;
  if (pm_output_send(queue, data, length, now) != 0) { free(receipt); return NULL; }
  receipt->references = 2; /* caller plus queued frame */
  queue->tail->receipt = receipt;
  return receipt;
}

int pm_output_receipt_status(const pm_output_receipt *receipt) { return receipt->status; }

void pm_output_receipt_release(pm_output_receipt *receipt) {
  if (receipt != NULL && --receipt->references == 0) free(receipt);
}

int pm_output_pending(const pm_output_queue *queue) {
  return queue != NULL && queue->fd >= 0 && (queue->head != NULL || queue->failed);
}

int pm_output_remaining_ms(const pm_output_queue *queue, long long now) {
  if (!pm_output_pending(queue)) return -1;
  if (queue->failed) return 0;
  long long remaining = PM_OUTPUT_DEADLINE_MS;
  for (pm_output_frame *frame = queue->head; frame != NULL; frame = frame->next) {
    if (frame->deadline - now < remaining) remaining = frame->deadline - now;
  }
  return remaining <= 0 ? 0 : (int)remaining;
}

long pm_output_flush(pm_output_queue *queue, size_t budget) {
  if (queue == NULL || queue->failed || queue->fd < 0) return -1;
  pm_output_frame *frame = queue->head;
  if (frame == NULL || budget == 0) return 0;
  size_t remaining = frame->message->length - frame->offset;
  if (remaining > budget) remaining = budget;
  ssize_t written = write(queue->fd, frame->message->data + frame->offset, remaining);
  if (written > 0) {
    frame->offset += (size_t)written;
    queue->bytes -= (size_t)written;
    if (frame->offset == frame->message->length) {
      queue->head = frame->next;
      if (queue->head == NULL) queue->tail = NULL;
      pm_output_remove_frame(queue, frame);
    }
    return written;
  }
  if (written < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
  queue->failed = 1;
  return -1;
}

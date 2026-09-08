#ifndef PORTMANAGER_AGENT_OUTPUT_H
#define PORTMANAGER_AGENT_OUTPUT_H

#include <stddef.h>

/* The control thread owns queues and immutable shared frames. No method waits
 * for a socket; the daemon's single poll loop schedules bounded progress. */
typedef struct pm_output_queue pm_output_queue;
typedef struct pm_output_message pm_output_message;
typedef struct pm_output_receipt pm_output_receipt;
pm_output_queue *pm_output_create(int fd);
void pm_output_disconnect(pm_output_queue *queue);
void pm_output_free(pm_output_queue *queue);
pm_output_message *pm_output_message_create(const char *data, size_t length);
void pm_output_message_release(pm_output_message *message);
/* FIFO responses/control pushes are never coalesced. Only wholly unsent
 * snapshots may be removed, with the newest appended after existing replies. */
int pm_output_enqueue(pm_output_queue *queue, pm_output_message *message, int snapshot, long long now);
int pm_output_send(pm_output_queue *queue, const char *data, size_t length, long long now);
/* A control RPC acknowledges delivery only once every byte reaches the socket.
 * Receipts outlive either queue/connection without retaining a client pointer. */
pm_output_receipt *pm_output_send_tracked(pm_output_queue *queue, const char *data, size_t length, long long now);
/* 0: pending, 1: fully sent, -1: discarded before complete delivery. */
int pm_output_receipt_status(const pm_output_receipt *receipt);
void pm_output_receipt_release(pm_output_receipt *receipt);
int pm_output_pending(const pm_output_queue *queue);
/* -1 means idle, 0 means disconnect now; otherwise the next deadline in ms. */
int pm_output_remaining_ms(const pm_output_queue *queue, long long now);
/* At most one nonblocking write, bounded by budget. Returns bytes or -1. */
long pm_output_flush(pm_output_queue *queue, size_t budget);
#endif

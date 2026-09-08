#ifndef PORTMANAGER_AGENT_SCAN_H
#define PORTMANAGER_AGENT_SCAN_H

#include <stddef.h>
#include <sys/types.h>

/* A request owns references to immutable command observations. Registry state
 * stays exclusively on the control thread while subprocesses inspect the OS. */
typedef struct pm_scan_context pm_scan_context;
pm_scan_context *pm_scan_context_create(void);
void pm_scan_context_free(pm_scan_context *context);
/* 1: pending, 0: complete (including command failure), -1: capacity/deadline failure. */
int pm_scan_require(pm_scan_context *context, const char *command);
int pm_scan_context_expired(const pm_scan_context *context);
/* Drop obsolete captures without extending the original request deadline. */
void pm_scan_context_update_generation(pm_scan_context *context, unsigned long generation);
/* New captures remember this watermark; sharing an older capture retains its older watermark. */
void pm_scan_context_update_registration(pm_scan_context *context, unsigned long revision);
unsigned long pm_scan_registration_revision(const char *command);
/* Set only around a synchronous state operation on the main control thread. */
void pm_scan_use(pm_scan_context *context);
/* Completed output is borrowed until the context is freed; failure returns NULL. */
const char *pm_scan_output(const char *command);
/* A fgets equivalent for immutable captured output, with no system calls. */
char *pm_scan_read_line(char *line, size_t size, const char **cursor);
/* Nonblocking subprocess progress; returns true while work still needs service. */
int pm_scan_poll(void);
/* Cooperates with the daemon's wildcard child reaper, including removed process rows. */
int pm_scan_reaped(pid_t pid, int status);
void pm_scan_dispose(void);

#endif

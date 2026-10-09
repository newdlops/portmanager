#ifndef PM_AUDIT_IDENTITY_H
#define PM_AUDIT_IDENTITY_H

#if defined(__APPLE__)
#include <dlfcn.h>
#include <errno.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

typedef int (*pm_audit_signal_fn)(audit_token_t *, int);

/* Task-name rights provide identity, not a task-termination capability. Release
 * the temporary send right on every path; callers retain only the value token. */
static inline int pm_audit_token_read(pid_t pid, audit_token_t *token) {
  mach_port_t task = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), pid, &task) != KERN_SUCCESS) { errno = EACCES; return -1; }
  mach_msg_type_number_t size = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t result = task_info(task, TASK_AUDIT_TOKEN, (task_info_t)token, &size);
  mach_port_deallocate(mach_task_self(), task);
  if (result != KERN_SUCCESS || size != TASK_AUDIT_TOKEN_COUNT || token->val[5] != (unsigned int)pid) { errno = EACCES; return -1; }
  return 0;
}

/* Controller stop must bind to the expected OS birth and current PID version.
 * A reused/executed process cannot be signalled between checking and delivery;
 * the final version comparison happens in the public kernel-backed API. */
static inline int pm_audit_signal_birth(pid_t pid, unsigned long long expected, int number) {
  pm_audit_signal_fn send_signal = (pm_audit_signal_fn)dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
  if (send_signal == NULL) { errno = ENOTSUP; return -1; }
  audit_token_t before, after; struct proc_bsdinfo info;
  if (pm_audit_token_read(pid, &before) != 0) return -1;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) { errno = ESRCH; return -1; }
  unsigned long long actual = (unsigned long long)info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec;
  if (actual != expected || info.pbi_uid != geteuid()) { errno = ESRCH; return -1; }
  if (pm_audit_token_read(pid, &after) != 0 || memcmp(&before, &after, sizeof(before)) != 0) { errno = ESRCH; return -1; }
  int error = send_signal(&before, number);
  if (error != 0) { errno = error; return -1; }
  return 0;
}
#endif

#endif

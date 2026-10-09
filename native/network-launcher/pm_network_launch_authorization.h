#ifndef PM_NETWORK_LAUNCH_AUTHORIZATION_H
#define PM_NETWORK_LAUNCH_AUTHORIZATION_H

#include "../shared/pm_agent_scope_client.h"

static int pm_launch_begin_scope(const pm_launch_options *options, pm_scope_client *request,
    pid_t child, unsigned long long birth) {
  char token[65];
  if (pm_scope_read_key(options->controller_path, token) != 0) return -1;
  int result = pm_scope_begin(request, options->agent_path, token, child, birth, options->network_id);
  memset(token, 0, sizeof(token));
  return result;
}

/* Loaded after fork in the supervisor; neither key nor controller FD can
 * enter the guarded child. Callers preserve the original startup deadline. */
static int pm_launch_register_scope(const pm_launch_options *options, pid_t child, unsigned long long birth, long long deadline) {
  pm_scope_client request;
  int result = pm_launch_begin_scope(options, &request, child, birth);
  if (result != 0) return -1;
  for (;;) {
    if (pm_launch_signal != 0) { errno = EINTR; break; }
    long long remaining = deadline - pm_nb_client_now();
    if (remaining <= 0) { errno = ETIMEDOUT; break; }
    struct pollfd descriptor = { .fd = request.fd, .events = pm_scope_events(&request) };
    int ready = poll(&descriptor, 1, remaining > 50 ? 50 : (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) break;
    if (ready == 0) continue;
    result = pm_scope_progress(&request, descriptor.revents);
    if (result == 1) return 0;
    if (result < 0) break;
  }
  int error = errno; pm_scope_close(&request); errno = error; return -1;
}

#endif

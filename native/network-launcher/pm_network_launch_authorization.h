#ifndef PM_NETWORK_LAUNCH_AUTHORIZATION_H
#define PM_NETWORK_LAUNCH_AUTHORIZATION_H

/* Included after the launcher's descriptor-rooted private-file reader. This
 * controller RPC runs only in the unsandboxed supervisor after fork, so neither
 * its credential bytes nor its transport FD can enter the guarded child. */
static int pm_launch_control_wait(int fd, short events, long long deadline) {
  for (;;) {
    if (pm_launch_signal != 0) { errno = EINTR; return -1; }
    long long remaining = deadline - pm_nb_client_now();
    if (remaining <= 0) { errno = ETIMEDOUT; return -1; }
    struct pollfd descriptor = { .fd = fd, .events = events };
    int ready = poll(&descriptor, 1, remaining > 50 ? 50 : (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) return -1;
    if (ready == 0) continue;
    if (descriptor.revents & events) return 0;
    errno = ECONNRESET; return -1;
  }
}

static int pm_launch_register_scope(const pm_launch_options *options, pid_t child, unsigned long long birth, long long deadline) {
  int key = pm_launch_open_private(options->controller_path, "/.portmanager/security/", 0);
  if (key < 0) return -1;
  char token[66] = {0};
  ssize_t length = read(key, token, sizeof(token)); close(key);
  if (length != 65 || token[64] != '\n') { errno = EACCES; return -1; }
  token[64] = '\0';
  for (size_t index = 0; index < 64; index++) {
    if (!((token[index] >= '0' && token[index] <= '9') || (token[index] >= 'a' && token[index] <= 'f'))) { errno = EACCES; return -1; }
  }
  pm_buffer request; pm_buffer_init(&request);
  int built = pm_buffer_appendf(&request, "{\"id\":\"launch-scope\",\"method\":\"registerProcessScope\",\"authorization\":\"%s\",\"payload\":{\"pid\":%ld,\"birth\":%llu,\"networkId\":", token, (long)child, birth) == 0 &&
    pm_json_append_string(&request, options->network_id) == 0 && pm_buffer_append(&request, "}}\n") == 0;
  memset(token, 0, sizeof(token));
  int fd = -1, error = EIO;
  if (!built || request.length > 2048) goto failed;
  struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  if (strlen(options->agent_path) >= sizeof(address.sun_path)) { error = ENAMETOOLONG; goto failed; }
  strcpy(address.sun_path, options->agent_path);
  fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) { error = errno; goto failed; }
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0 || fcntl(fd, F_SETFL, O_NONBLOCK) != 0) { error = errno; goto failed; }
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
    if (errno != EINPROGRESS || pm_launch_control_wait(fd, POLLOUT, deadline) != 0) { error = errno; goto failed; }
    socklen_t size = sizeof(error);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) != 0) { error = errno; goto failed; }
    if (error != 0) goto failed;
  }
#if defined(__APPLE__)
  uid_t uid; gid_t gid;
  if (getpeereid(fd, &uid, &gid) != 0 || uid != geteuid()) { error = EACCES; goto failed; }
#endif
  size_t offset = 0;
  while (offset < request.length) {
    ssize_t count = write(fd, request.data + offset, request.length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) && pm_launch_control_wait(fd, POLLOUT, deadline) == 0) continue;
    if (count <= 0) { error = errno; goto failed; }
    offset += (size_t)count;
  }
  char response[2048]; offset = 0;
  while (offset + 1 < sizeof(response)) {
    ssize_t count = read(fd, response + offset, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) && pm_launch_control_wait(fd, POLLIN, deadline) == 0) continue;
    if (count <= 0) { error = count == 0 ? EPROTO : errno; goto failed; }
    if (response[offset++] == '\n') break;
  }
  response[offset] = '\0';
  char id[32], method[64], type[32], ok[8], network_id[128];
  const char *payload = pm_json_object(response, "payload");
  if (offset == 0 || response[offset - 1] != '\n' || payload == NULL ||
      pm_json_get_string(response, "id", id, sizeof(id)) != 0 || strcmp(id, "launch-scope") != 0 ||
      pm_json_get_string(response, "method", method, sizeof(method)) != 0 || strcmp(method, "registerProcessScope") != 0 ||
      pm_json_get_string(response, "type", type, sizeof(type)) != 0 || strcmp(type, "response") != 0 ||
      pm_json_get_raw(response, "ok", ok, sizeof(ok)) != 0 || strcmp(ok, "true") != 0 ||
      pm_json_get_long(payload, "pid", 0) != child || (unsigned long long)pm_json_get_long(payload, "birth", 0) != birth ||
      pm_json_get_string(payload, "networkId", network_id, sizeof(network_id)) != 0 || strcmp(network_id, options->network_id) != 0) {
    error = EACCES; goto failed;
  }
  close(fd); pm_buffer_free(&request); return 0;
failed:
  if (fd >= 0) close(fd);
  pm_buffer_free(&request); errno = error; return -1;
}

#endif

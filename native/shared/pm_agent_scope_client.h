#ifndef PM_AGENT_SCOPE_CLIENT_H
#define PM_AGENT_SCOPE_CLIENT_H

#include "../agent/portmanager_agent.h"
#include <errno.h>
#include <ctype.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

/* One bounded controller registration. Callers own its deadline, cancellation
 * and poll slot. No controller transport or credential enters a workload. */
enum { PM_SCOPE_CONNECTING, PM_SCOPE_SENDING, PM_SCOPE_RECEIVING, PM_SCOPE_COMPLETE };
typedef struct {
  int fd, phase;
  size_t sent, request_bytes, received;
  pid_t pid;
  unsigned long long birth;
  char network_id[128];
  char request[2048], response[2048];
} pm_scope_client;

static int pm_scope_read_key(const char *path, char token[65]) {
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX || strstr(path, "/.portmanager/security/") == NULL) { errno = EINVAL; return -1; }
  char copy[PATH_MAX]; strcpy(copy, path);
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC), fd = -1;
  char *save = NULL, *part = strtok_r(copy, "/", &save);
  while (directory >= 0 && part != NULL) {
    char *next = strtok_r(NULL, "/", &save);
    if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) { errno = EINVAL; break; }
    if (next == NULL) {
      struct stat parent;
      if (fstat(directory, &parent) != 0 || parent.st_uid != geteuid() || (parent.st_mode & 077) != 0) { errno = EACCES; break; }
      fd = openat(directory, part, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC); break;
    }
    int child = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(directory); directory = child; part = next;
  }
  if (directory >= 0) close(directory);
  if (fd < 0) return -1;
  struct stat file; char contents[66];
  int valid = fstat(fd, &file) == 0 && S_ISREG(file.st_mode) && file.st_uid == geteuid() &&
    (file.st_mode & 077) == 0 && file.st_nlink == 1 && file.st_size == 65;
  ssize_t bytes = valid ? read(fd, contents, sizeof(contents)) : -1;
  close(fd);
  if (!valid || bytes != 65 || contents[64] != '\n') { errno = EACCES; return -1; }
  for (size_t index = 0; index < 64; index++) if (!((contents[index] >= '0' && contents[index] <= '9') ||
      (contents[index] >= 'a' && contents[index] <= 'f'))) { errno = EACCES; return -1; }
  memcpy(token, contents, 64); token[64] = '\0'; return 0;
}

static void pm_scope_close(pm_scope_client *client) {
  if (client->fd >= 0) close(client->fd);
  client->fd = -1;
  memset(client->request, 0, sizeof(client->request));
}

static int pm_scope_begin(pm_scope_client *client, const char *endpoint, const char *token,
    pid_t pid, unsigned long long birth, const char *network_id) {
  memset(client, 0, sizeof(*client)); client->fd = -1;
  if (endpoint == NULL || pid <= 1 || birth == 0 || network_id == NULL ||
      strlen(network_id) == 0 || strlen(network_id) >= sizeof(client->network_id)) { errno = EINVAL; return -1; }
  client->pid = pid; client->birth = birth; strcpy(client->network_id, network_id);
  pm_buffer request; pm_buffer_init(&request);
  int built = pm_buffer_appendf(&request, "{\"id\":\"scope-register\",\"method\":\"registerProcessScope\",\"authorization\":\"%s\",\"payload\":{\"pid\":%ld,\"birth\":%llu,\"networkId\":", token, (long)pid, birth) == 0 &&
    pm_json_append_string(&request, network_id) == 0 && pm_buffer_append(&request, "}}\n") == 0 && request.length < sizeof(client->request);
  if (!built) { pm_buffer_free(&request); errno = EINVAL; return -1; }
  memcpy(client->request, request.data, request.length); client->request_bytes = request.length; pm_buffer_free(&request);
  struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  if (strlen(endpoint) >= sizeof(address.sun_path)) { errno = ENAMETOOLONG; return -1; }
  strcpy(address.sun_path, endpoint);
  client->fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (client->fd < 0) return -1;
#if defined(__APPLE__)
  int no_sigpipe = 1;
  if (setsockopt(client->fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) goto failed;
#endif
  if (fcntl(client->fd, F_SETFD, FD_CLOEXEC) != 0 || fcntl(client->fd, F_SETFL, O_NONBLOCK) != 0) goto failed;
  client->phase = PM_SCOPE_CONNECTING;
  if (connect(client->fd, (struct sockaddr *)&address, sizeof(address)) != 0 && errno != EINPROGRESS) goto failed;
  return 0;
failed:
  { int error = errno; pm_scope_close(client); errno = error; return -1; }
}

static short pm_scope_events(const pm_scope_client *client) {
  return client->phase == PM_SCOPE_RECEIVING ? POLLIN : POLLOUT;
}

/* Validate the entire bounded frame before using the daemon's field accessors.
 * Prefix numbers and unterminated objects must not become successful ACKs. */
static const char *pm_scope_space(const char *cursor) {
  while (*cursor == ' ' || *cursor == '\t' || *cursor == '\r' || *cursor == '\n') cursor++;
  return cursor;
}
static const char *pm_scope_json_string(const char *cursor) {
  if (*cursor++ != '"') return NULL;
  while (*cursor != '\0' && *cursor != '"') {
    if ((unsigned char)*cursor < 0x20) return NULL;
    if (*cursor++ != '\\') continue;
    if (*cursor == 'u') {
      cursor++;
      for (int index = 0; index < 4; index++) { if (!isxdigit((unsigned char)*cursor)) return NULL; cursor++; }
    } else {
      if (*cursor == '\0' || strchr("\"\\/bfnrt", *cursor) == NULL) return NULL;
      cursor++;
    }
  }
  return *cursor == '"' ? cursor + 1 : NULL;
}
static const char *pm_scope_json_value(const char *cursor, int depth) {
  cursor = pm_scope_space(cursor);
  if (depth > 8) return NULL;
  if (*cursor == '"') return pm_scope_json_string(cursor);
  if (*cursor == '{' || *cursor == '[') {
    int object = *cursor == '{'; char close = object ? '}' : ']';
    cursor = pm_scope_space(cursor + 1);
    if (*cursor == close) return cursor + 1;
    for (;;) {
      if (object) {
        cursor = pm_scope_json_string(cursor); if (cursor == NULL) return NULL;
        cursor = pm_scope_space(cursor); if (*cursor++ != ':') return NULL;
      }
      cursor = pm_scope_json_value(cursor, depth + 1); if (cursor == NULL) return NULL;
      cursor = pm_scope_space(cursor); if (*cursor == close) return cursor + 1;
      if (*cursor++ != ',') return NULL;
      cursor = pm_scope_space(cursor);
    }
  }
  for (int index = 0; index < 3; index++) {
    const char *literal = index == 0 ? "true" : index == 1 ? "false" : "null";
    size_t size = strlen(literal); if (strncmp(cursor, literal, size) == 0) return cursor + size;
  }
  if (*cursor == '-') cursor++;
  if (*cursor == '0') cursor++;
  else { if (*cursor < '1' || *cursor > '9') return NULL; do { cursor++; } while (isdigit((unsigned char)*cursor)); }
  if (*cursor == '.') { cursor++; if (!isdigit((unsigned char)*cursor)) return NULL; do { cursor++; } while (isdigit((unsigned char)*cursor)); }
  if (*cursor == 'e' || *cursor == 'E') {
    cursor++; if (*cursor == '+' || *cursor == '-') cursor++;
    if (!isdigit((unsigned char)*cursor)) return NULL; do { cursor++; } while (isdigit((unsigned char)*cursor));
  }
  return cursor;
}
static int pm_scope_unsigned_matches(const char *json, const char *key, unsigned long long expected) {
  char value[32], decimal[32]; snprintf(decimal, sizeof(decimal), "%llu", expected);
  return pm_json_get_raw(json, key, value, sizeof(value)) == 0 && strcmp(value, decimal) == 0;
}

/* 1 complete, 0 pending, -1 rejected. At most one fixed frame is sent/read in
 * a turn; partial/extra/malformed data never extends the owner's deadline. */
static int pm_scope_progress(pm_scope_client *client, short events) {
  if (client->phase == PM_SCOPE_COMPLETE) return 1;
  if (events & (POLLERR | POLLNVAL)) { errno = ECONNRESET; return -1; }
  if (client->phase == PM_SCOPE_CONNECTING && events & (POLLOUT | POLLHUP)) {
    int error = 0; socklen_t size = sizeof(error);
    if (getsockopt(client->fd, SOL_SOCKET, SO_ERROR, &error, &size) != 0) return -1;
    if (error != 0) { errno = error; return -1; }
#if defined(__APPLE__)
    uid_t uid; gid_t gid;
    if (getpeereid(client->fd, &uid, &gid) != 0 || uid != geteuid()) { errno = EACCES; return -1; }
#elif defined(__linux__)
    struct ucred peer; size = sizeof(peer);
    if (getsockopt(client->fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) != 0 || peer.uid != geteuid()) { errno = EACCES; return -1; }
#endif
    client->phase = PM_SCOPE_SENDING;
  }
  if (client->phase == PM_SCOPE_SENDING && events & POLLOUT) {
    ssize_t count = send(client->fd, client->request + client->sent, client->request_bytes - client->sent,
#ifdef MSG_NOSIGNAL
      MSG_NOSIGNAL
#else
      0
#endif
    );
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    if (count <= 0) return -1;
    client->sent += (size_t)count;
    if (client->sent == client->request_bytes) { memset(client->request, 0, sizeof(client->request)); client->phase = PM_SCOPE_RECEIVING; }
  }
  if (client->phase != PM_SCOPE_RECEIVING || !(events & (POLLIN | POLLHUP))) return 0;
  ssize_t count = recv(client->fd, client->response + client->received, sizeof(client->response) - client->received - 1, 0);
  if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
  if (count <= 0) { if (count == 0) errno = EPROTO; return -1; }
  client->received += (size_t)count; client->response[client->received] = '\0';
  if (memchr(client->response, '\0', client->received) != NULL) { errno = EPROTO; return -1; }
  char *newline = memchr(client->response, '\n', client->received);
  if (newline == NULL) { if (client->received + 1 == sizeof(client->response)) { errno = EMSGSIZE; return -1; } return 0; }
  char id[32], method[64], type[32], ok[8], network_id[128];
  const char *end = pm_scope_json_value(client->response, 0);
  if (end == NULL || *pm_scope_space(end) != '\0') { errno = EPROTO; return -1; }
  const char *payload = pm_json_object(client->response, "payload");
  if (newline != client->response + client->received - 1 || payload == NULL ||
      pm_json_get_string(client->response, "id", id, sizeof(id)) != 0 || strcmp(id, "scope-register") != 0 ||
      pm_json_get_string(client->response, "method", method, sizeof(method)) != 0 || strcmp(method, "registerProcessScope") != 0 ||
      pm_json_get_string(client->response, "type", type, sizeof(type)) != 0 || strcmp(type, "response") != 0 ||
      pm_json_get_raw(client->response, "ok", ok, sizeof(ok)) != 0 || strcmp(ok, "true") != 0 ||
      !pm_scope_unsigned_matches(payload, "pid", (unsigned long long)client->pid) || !pm_scope_unsigned_matches(payload, "birth", client->birth) ||
      pm_json_get_string(payload, "networkId", network_id, sizeof(network_id)) != 0 || strcmp(network_id, client->network_id) != 0) {
    errno = EACCES; return -1;
  }
  client->phase = PM_SCOPE_COMPLETE; pm_scope_close(client); return 1;
}

#endif

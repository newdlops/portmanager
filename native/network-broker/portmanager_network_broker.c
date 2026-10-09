#define _GNU_SOURCE
#include "pm_network_broker_protocol.h"
#include "../shared/pm_network_namespace.h"
#include "../shared/pm_dev_log.h"
#include "../shared/pm_agent_scope_client.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <libproc.h>
#endif

/* Each slot owns one control fd, one received TCP fd and one controller or
 * returned accept fd in disjoint phases. Memory, work and shutdown are bounded. */
#define PM_NB_MAX_CLIENTS 64
#define PM_NB_DEADLINE_MS 8000
#define PM_NB_ACCEPT_BUDGET 16
#define PM_NB_RECEIVE_BUDGET 16
enum pm_nb_phase { PM_NB_RECEIVE, PM_NB_AUTHORIZING, PM_NB_CONNECTING, PM_NB_ACCEPTING, PM_NB_SEND, PM_NB_FD_ACKNOWLEDGEMENT };
typedef struct {
  int control, socket, returned, original_flags, changed_flags;
  pid_t pid;
  unsigned long long birth;
  long long deadline;
  enum pm_nb_phase phase;
  size_t received, sent;
  int rights_sent, authorizing_broker;
  pm_nb_request request;
  pm_nb_response response;
  pm_scope_client authorization;
} pm_nb_client;
typedef struct {
  char network_id[128], socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  const char *agent_path, *controller_path;
  char controller_token[65];
  struct in_addr host;
  int server;
  struct stat socket_identity;
  pm_nb_client clients[PM_NB_MAX_CLIENTS];
} pm_nb_server;
static volatile sig_atomic_t pm_nb_running = 1;
static void pm_nb_stop(int signal_number) { (void)signal_number; pm_nb_running = 0; }
static int pm_nb_close_inherited(void) {
#if defined(__APPLE__)
  int capacity = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
  if (capacity <= 0 || capacity > 65536) { errno = EOVERFLOW; return -1; }
  struct proc_fdinfo *descriptors = malloc((size_t)capacity);
  if (descriptors == NULL) return -1;
  int bytes = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, descriptors, capacity);
  if (bytes <= 0 || bytes > capacity) { free(descriptors); errno = EIO; return -1; }
  for (size_t index = 0; index < (size_t)bytes / sizeof(*descriptors); index++) {
    if (descriptors[index].proc_fd > 2) close(descriptors[index].proc_fd);
  }
  free(descriptors);
#endif
  return 0;
}
static long long pm_nb_now(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static unsigned long long pm_nb_birth(pid_t pid) {
#if defined(__APPLE__)
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
  return (unsigned long long)info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec;
#elif defined(__linux__)
  char file[64], text[4096];
  snprintf(file, sizeof(file), "/proc/%ld/stat", (long)pid);
  int fd = open(file, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  ssize_t size = read(fd, text, sizeof(text) - 1); close(fd);
  if (size <= 0) return 0;
  text[size] = '\0';
  char *cursor = strrchr(text, ')');
  if (cursor == NULL) return 0;
  cursor += 2;
  for (int field = 3; field < 22; field++) { cursor = strchr(cursor, ' '); if (cursor == NULL) return 0; cursor++; }
  return strtoull(cursor, NULL, 10);
#else
  (void)pid; return 0;
#endif
}
static int pm_nb_peer(int fd, pid_t *pid) {
#if defined(__APPLE__)
  uid_t uid; gid_t gid; socklen_t size = sizeof(*pid);
  return getpeereid(fd, &uid, &gid) == 0 && uid == geteuid() &&
    getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pid, &size) == 0 && size == sizeof(*pid) && *pid > 0 ? 0 : -1;
#elif defined(__linux__)
  struct ucred peer; socklen_t size = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) != 0 || peer.uid != geteuid() || peer.pid <= 0) return -1;
  *pid = peer.pid; return 0;
#else
  (void)fd; (void)pid; return -1;
#endif
}
static int pm_nb_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 ? 0 : -1;
}
static void pm_nb_release(pm_nb_client *client) {
  if (client->socket >= 0 && client->changed_flags) (void)fcntl(client->socket, F_SETFL, client->original_flags);
  if (client->socket >= 0) close(client->socket);
  if (client->returned >= 0) close(client->returned);
  if (client->control >= 0) close(client->control);
  pm_scope_close(&client->authorization);
  memset(client, 0, sizeof(*client));
  client->control = client->socket = client->returned = -1;
  client->authorization.fd = -1;
}
static void pm_nb_reply(pm_nb_client *client, int error) {
  pm_scope_close(&client->authorization);
  pm_dev_log("network-broker", "reply op=%u peer_pid=%ld errno=%d", client->request.operation, (long)client->pid, error);
  memset(&client->response, 0, sizeof(client->response));
  client->response.magic = PM_NB_MAGIC; client->response.version = PM_NB_VERSION;
  client->response.operation = client->request.operation;
  client->response.result = error == 0 ? 0 : -1; client->response.error = error;
  client->phase = PM_NB_SEND;
  if (client->socket >= 0 && client->changed_flags) {
    if (fcntl(client->socket, F_SETFL, client->original_flags) != 0 && error == 0) {
      client->response.result = -1; client->response.error = errno;
    }
    client->changed_flags = 0;
  }
  if (client->response.error != 0 && client->returned >= 0) { close(client->returned); client->returned = -1; }
}
static int pm_nb_v4(const struct sockaddr *address, struct in_addr *out) {
  if (address->sa_family == AF_INET) { *out = ((const struct sockaddr_in *)address)->sin_addr; return 1; }
  if (address->sa_family == AF_INET6 && IN6_IS_ADDR_V4MAPPED(&((const struct sockaddr_in6 *)address)->sin6_addr)) {
    memcpy(out, &((const struct sockaddr_in6 *)address)->sin6_addr.s6_addr[12], sizeof(*out)); return 1;
  }
  return 0;
}
static int pm_nb_is_own(const pm_nb_server *server, const struct sockaddr *address) {
  struct in_addr v4;
  return pm_nb_v4(address, &v4) && v4.s_addr == server->host.s_addr;
}
static int pm_nb_unspecified(const struct sockaddr *address) {
  struct in_addr v4;
  if (pm_nb_v4(address, &v4)) return v4.s_addr == INADDR_ANY;
  return address->sa_family == AF_INET6 && IN6_IS_ADDR_UNSPECIFIED(&((const struct sockaddr_in6 *)address)->sin6_addr);
}
static int pm_nb_logical_localhost(const struct sockaddr *address) {
  struct in_addr v4;
  if (pm_nb_v4(address, &v4)) return v4.s_addr == htonl(INADDR_LOOPBACK) || v4.s_addr == INADDR_ANY;
  return address->sa_family == AF_INET6 && (IN6_IS_ADDR_LOOPBACK(&((const struct sockaddr_in6 *)address)->sin6_addr) || pm_nb_unspecified(address));
}
static int pm_nb_same_ip(const struct sockaddr *first, const struct sockaddr *second) {
  struct in_addr a, b;
  if (pm_nb_v4(first, &a) && pm_nb_v4(second, &b)) return a.s_addr == b.s_addr;
  return first->sa_family == AF_INET6 && second->sa_family == AF_INET6 &&
    memcmp(&((const struct sockaddr_in6 *)first)->sin6_addr, &((const struct sockaddr_in6 *)second)->sin6_addr, sizeof(struct in6_addr)) == 0;
}
static int pm_nb_host_interface(const struct sockaddr *address) {
  struct ifaddrs *interfaces;
  if (getifaddrs(&interfaces) != 0) return -1;
  int found = 0;
  for (struct ifaddrs *item = interfaces; item != NULL; item = item->ifa_next) {
    if (item->ifa_addr != NULL && pm_nb_same_ip(address, item->ifa_addr)) { found = 1; break; }
  }
  freeifaddrs(interfaces); return found;
}
/* Host loopback means this logical network. Other 127/8 aliases and the
 * machine's non-loopback interfaces never become a path into another realm.
 * Explicit host-access/Compose targets need a separate trusted policy input. */
static int pm_nb_target(const pm_nb_server *server, struct sockaddr_storage *target, int binding) {
  struct sockaddr *address = (struct sockaddr *)target;
  if (pm_nb_logical_localhost(address) || pm_nb_is_own(server, address)) {
    if (address->sa_family == AF_INET) ((struct sockaddr_in *)address)->sin_addr = server->host;
    else {
      struct in6_addr *v6 = &((struct sockaddr_in6 *)address)->sin6_addr;
      memset(v6, 0, sizeof(*v6)); v6->s6_addr[10] = v6->s6_addr[11] = 0xff;
      memcpy(&v6->s6_addr[12], &server->host, sizeof(server->host));
    }
    return 0;
  }
  if (binding) return EACCES;
  struct in_addr v4;
  if (pm_nb_v4(address, &v4) && (ntohl(v4.s_addr) >> 24) == 127) return EACCES;
  int local = pm_nb_host_interface(address);
  return local == 0 ? 0 : EACCES;
}
static int pm_nb_socket_valid(const pm_nb_server *server, pm_nb_client *client, int require_bound) {
  int type; socklen_t size = sizeof(type);
  struct sockaddr_storage local; socklen_t length = sizeof(local);
  if (client->socket < 0 || getsockopt(client->socket, SOL_SOCKET, SO_TYPE, &type, &size) != 0 || type != SOCK_STREAM ||
      getsockname(client->socket, (struct sockaddr *)&local, &length) != 0 ||
      (local.ss_family != AF_INET && local.ss_family != AF_INET6)) return EINVAL;
  if (require_bound ? !pm_nb_is_own(server, (struct sockaddr *)&local) :
      (!pm_nb_unspecified((struct sockaddr *)&local) && !pm_nb_is_own(server, (struct sockaddr *)&local))) return EACCES;
  struct sockaddr_storage peer; length = sizeof(peer);
  if (getpeername(client->socket, (struct sockaddr *)&peer, &length) == 0) return EISCONN;
  return 0;
}
static int pm_nb_begin_nonblocking(pm_nb_client *client) {
  client->original_flags = fcntl(client->socket, F_GETFL, 0);
  if (client->original_flags < 0) return -1;
  if ((client->original_flags & O_NONBLOCK) == 0) {
    if (fcntl(client->socket, F_SETFL, client->original_flags | O_NONBLOCK) != 0) return -1;
    client->changed_flags = 1;
  }
  return 0;
}
static void pm_nb_accept_tcp(pm_nb_client *client) {
  struct sockaddr_storage peer; socklen_t size = sizeof(peer);
  int fd = accept(client->socket, (struct sockaddr *)&peer, &size);
  if (fd < 0) {
    if ((errno == EAGAIN || errno == EWOULDBLOCK) && !(client->original_flags & O_NONBLOCK) && !(client->request.flags & PM_NB_NONBLOCK)) {
      client->phase = PM_NB_ACCEPTING; return;
    }
    pm_nb_reply(client, errno); return;
  }
  client->returned = fd;
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0 || fcntl(fd, F_SETFL, (client->request.flags & PM_NB_NONBLOCK) ? O_NONBLOCK : 0) != 0) {
    pm_nb_reply(client, errno); return;
  }
  pm_nb_reply(client, 0);
  client->response.address_length = size;
  memcpy(client->response.address, &peer, size);
}
static void pm_nb_execute(pm_nb_server *server, pm_nb_client *client) {
  pm_nb_request *request = &client->request;
  if (request->magic != PM_NB_MAGIC || request->version != PM_NB_VERSION || request->flags & ~(PM_NB_NONBLOCK | PM_NB_CLOEXEC) ||
      pm_nb_birth(client->pid) != client->birth) { pm_nb_reply(client, EACCES); return; }
  if (request->operation == PM_NB_SOCKET) {
    if (client->socket >= 0 || (request->domain != AF_INET && request->domain != AF_INET6) || request->type != SOCK_STREAM ||
        (request->protocol != 0 && request->protocol != IPPROTO_TCP) || request->address_length != 0 || request->backlog != 0) {
      pm_nb_reply(client, EINVAL); return;
    }
    client->returned = socket(request->domain, SOCK_STREAM, IPPROTO_TCP);
    if (client->returned < 0) { pm_nb_reply(client, errno); return; }
    if (fcntl(client->returned, F_SETFD, FD_CLOEXEC) != 0 || fcntl(client->returned, F_SETFL, (request->flags & PM_NB_NONBLOCK) ? O_NONBLOCK : 0) != 0) {
      pm_nb_reply(client, errno); return;
    }
    pm_nb_reply(client, 0); return;
  }
  if (request->operation < PM_NB_BIND || request->operation > PM_NB_ACCEPT || request->domain != 0 || request->type != 0 || request->protocol != 0) {
    pm_nb_reply(client, EACCES); return;
  }
  int bound = request->operation == PM_NB_LISTEN || request->operation == PM_NB_ACCEPT;
  int validation = pm_nb_socket_valid(server, client, bound);
  if (validation != 0) { pm_nb_reply(client, validation); return; }
  if (request->operation == PM_NB_BIND || request->operation == PM_NB_CONNECT) {
    struct sockaddr_storage target, local; socklen_t size = sizeof(local);
    memset(&target, 0, sizeof(target));
    if (request->address_length != sizeof(struct sockaddr_in) && request->address_length != sizeof(struct sockaddr_in6)) { pm_nb_reply(client, EINVAL); return; }
    memcpy(&target, request->address, request->address_length);
    if (getsockname(client->socket, (struct sockaddr *)&local, &size) != 0 || target.ss_family != local.ss_family ||
        request->address_length != (target.ss_family == AF_INET ? sizeof(struct sockaddr_in) : sizeof(struct sockaddr_in6)) ||
        request->flags != 0 || request->backlog != 0) { pm_nb_reply(client, EINVAL); return; }
    validation = pm_nb_target(server, &target, request->operation == PM_NB_BIND);
    if (validation != 0) { pm_nb_reply(client, validation); return; }
    if (request->operation == PM_NB_BIND) {
      int result = bind(client->socket, (struct sockaddr *)&target, request->address_length);
      pm_nb_reply(client, result == 0 ? 0 : errno); return;
    }
    if (pm_nb_begin_nonblocking(client) != 0) { pm_nb_reply(client, errno); return; }
    int result = connect(client->socket, (struct sockaddr *)&target, request->address_length);
    if (result == 0) pm_nb_reply(client, 0);
    else if (errno == EINPROGRESS && !(client->original_flags & O_NONBLOCK)) client->phase = PM_NB_CONNECTING;
    else pm_nb_reply(client, errno);
    return;
  }
  if (request->address_length != 0 || (request->operation == PM_NB_LISTEN && request->flags != 0)) { pm_nb_reply(client, EINVAL); return; }
  if (request->operation == PM_NB_LISTEN) {
    int backlog = request->backlog;
    if (backlog < 0 || backlog > 128) backlog = 128;
    int result = listen(client->socket, backlog);
    pm_nb_reply(client, result == 0 ? 0 : errno); return;
  }
  if (request->backlog != 0 || pm_nb_begin_nonblocking(client) != 0) { pm_nb_reply(client, EINVAL); return; }
  pm_dev_log("network-broker", "accept started peer_pid=%ld original_flags=%d broker_flags=%d", (long)client->pid,
    client->original_flags, fcntl(client->socket, F_GETFL, 0));
  /* accept itself validates listening state. SO_ACCEPTCONN is not a portable
   * getsockopt query on Darwin; using it would reject a valid shared listener. */
  pm_nb_accept_tcp(client);
}
static int pm_nb_receive_one(pm_nb_server *server, pm_nb_client *client) {
  /* One data byte cannot coalesce several separate rights messages. XNU
   * installs rights before copying the control buffer and does not close the
   * uncopied tail on MSG_CTRUNC, so reserve its complete 512-FD message bound. */
  struct iovec data = { .iov_base = (unsigned char *)&client->request + client->received, .iov_len = 1 };
  union { struct cmsghdr aligned; unsigned char bytes[CMSG_SPACE(PM_NB_RIGHTS_CAPACITY * sizeof(int))]; } ancillary;
  struct msghdr message;
  memset(&message, 0, sizeof(message)); memset(&ancillary, 0, sizeof(ancillary));
  message.msg_iov = &data; message.msg_iovlen = 1;
  message.msg_control = ancillary.bytes; message.msg_controllen = sizeof(ancillary.bytes);
  ssize_t count = recvmsg(client->control, &message, 0);
  if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
  if (count < 0) pm_dev_log("network-broker", "receive failed errno=%d flags=%d ancillary_bytes=%zu", errno, message.msg_flags, (size_t)message.msg_controllen);
  int invalid = (message.msg_flags & MSG_CTRUNC) != 0;
  for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header != NULL; header = CMSG_NXTHDR(&message, header)) {
    if (header->cmsg_len < CMSG_LEN(0) || header->cmsg_len > (size_t)((unsigned char *)message.msg_control + message.msg_controllen - (unsigned char *)header)) { invalid = 1; break; }
    if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) { invalid = 1; continue; }
    size_t bytes = header->cmsg_len >= CMSG_LEN(0) ? header->cmsg_len - CMSG_LEN(0) : 0;
    if (bytes % sizeof(int) != 0) invalid = 1;
    for (size_t offset = 0; offset + sizeof(int) <= bytes; offset += sizeof(int)) {
      int fd; memcpy(&fd, (unsigned char *)CMSG_DATA(header) + offset, sizeof(fd));
      if (client->socket >= 0 || invalid) { close(fd); invalid = 1; }
      else { client->socket = fd; if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0) invalid = 1; }
    }
  }
  if (count <= 0) { pm_nb_release(client); return 0; }
  if (invalid) { pm_nb_reply(client, EPROTO); return 0; }
  client->received += (size_t)count;
  if (client->received == sizeof(client->request)) {
    if (server->agent_path == NULL) pm_nb_execute(server, client);
    else if (pm_scope_begin(&client->authorization, server->agent_path, server->controller_token,
        getpid(), pm_nb_birth(getpid()), server->network_id) != 0) pm_nb_reply(client, errno);
    else { client->authorizing_broker = 1; client->phase = PM_NB_AUTHORIZING; }
  }
  return 1;
}
static void pm_nb_receive(pm_nb_server *server, pm_nb_client *client) {
  for (int index = 0; index < PM_NB_RECEIVE_BUDGET && client->control >= 0 && client->phase == PM_NB_RECEIVE; index++) {
    if (!pm_nb_receive_one(server, client)) break;
  }
}
static void pm_nb_send(pm_nb_client *client) {
  struct iovec data = { .iov_base = (unsigned char *)&client->response + client->sent, .iov_len = sizeof(client->response) - client->sent };
  union { struct cmsghdr aligned; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } ancillary;
  struct msghdr message;
  memset(&message, 0, sizeof(message));
  message.msg_iov = &data; message.msg_iovlen = 1;
  if (client->returned >= 0 && !client->rights_sent) {
    memset(&ancillary, 0, sizeof(ancillary));
    message.msg_control = ancillary.bytes; message.msg_controllen = sizeof(ancillary.bytes);
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &client->returned, sizeof(int));
  }
  ssize_t count = sendmsg(client->control, &message, 0);
  if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return;
  if (count <= 0) { pm_nb_release(client); return; }
  client->rights_sent = 1; client->sent += (size_t)count;
  if (client->sent == sizeof(client->response)) {
    /* Keep the sending copy until the recipient confirms it has installed the
     * FD. Unacknowledged handoffs stay inside the same slot/deadline budget. */
    if (client->returned >= 0) client->phase = PM_NB_FD_ACKNOWLEDGEMENT;
    else pm_nb_release(client);
  }
}
static void pm_nb_admit(pm_nb_server *server) {
  for (int accepted = 0; accepted < PM_NB_ACCEPT_BUDGET; accepted++) {
    int fd = accept(server->server, NULL, NULL);
    if (fd < 0) return;
    size_t index;
    for (index = 0; index < PM_NB_MAX_CLIENTS; index++) if (server->clients[index].control < 0) break;
    pid_t pid;
    unsigned long long birth;
    if (index == PM_NB_MAX_CLIENTS || pm_nb_nonblocking(fd) != 0 || pm_nb_peer(fd, &pid) != 0 || (birth = pm_nb_birth(pid)) == 0) {
      close(fd); continue;
    }
    int capacity = 4096;
    (void)setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &capacity, sizeof(capacity));
    pm_nb_client *client = &server->clients[index];
    client->control = fd; client->pid = pid; client->birth = birth;
    client->deadline = pm_nb_now() + PM_NB_DEADLINE_MS;
  }
}
static void pm_nb_loop(pm_nb_server *server) {
  while (pm_nb_running) {
    struct pollfd descriptors[1 + 3 * PM_NB_MAX_CLIENTS];
    memset(descriptors, 0, sizeof(descriptors));
    descriptors[0] = (struct pollfd){ .fd = server->server, .events = POLLIN };
    for (size_t index = 0; index < PM_NB_MAX_CLIENTS; index++) {
      pm_nb_client *client = &server->clients[index];
      descriptors[1 + index * 3] = (struct pollfd){ .fd = client->control,
        .events = client->phase == PM_NB_SEND ? POLLOUT : POLLIN };
      descriptors[2 + index * 3] = (struct pollfd){ .fd = client->socket,
        .events = client->phase == PM_NB_CONNECTING ? POLLOUT : client->phase == PM_NB_ACCEPTING ? POLLIN : 0 };
      if (client->phase != PM_NB_CONNECTING && client->phase != PM_NB_ACCEPTING) descriptors[2 + index * 3].fd = -1;
      descriptors[3 + index * 3] = (struct pollfd){ .fd = client->phase == PM_NB_AUTHORIZING ? client->authorization.fd : -1,
        .events = pm_scope_events(&client->authorization) };
    }
    int ready = poll(descriptors, 1 + 3 * PM_NB_MAX_CLIENTS, 50);
    if (ready < 0 && errno != EINTR) break;
    if (descriptors[0].revents & POLLIN) pm_nb_admit(server);
    long long now = pm_nb_now();
    for (size_t index = 0; index < PM_NB_MAX_CLIENTS; index++) {
      pm_nb_client *client = &server->clients[index];
      if (client->control < 0) continue;
      if (now >= client->deadline || pm_nb_birth(client->pid) != client->birth) { pm_nb_release(client); continue; }
      short control = descriptors[1 + index * 3].revents, socket_ready = descriptors[2 + index * 3].revents;
      short authorization_ready = descriptors[3 + index * 3].revents;
      if (control & (POLLERR | POLLNVAL)) { pm_nb_release(client); continue; }
      if (client->phase == PM_NB_RECEIVE && control & (POLLIN | POLLHUP)) pm_nb_receive(server, client);
      if (client->control < 0) continue;
      if (client->phase == PM_NB_AUTHORIZING || client->phase == PM_NB_CONNECTING || client->phase == PM_NB_ACCEPTING) {
        if (control & (POLLIN | POLLHUP)) {
          char byte;
          ssize_t count = recv(client->control, &byte, 1, 0);
          /* This framed request/reply protocol does not use write EOF as a
           * request delimiter. EOF (including SHUT_WR) cancels pending work;
           * extra bytes are invalid. Never retain a slot after disconnection. */
          if (count >= 0 || (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) { pm_nb_release(client); continue; }
        }
        if (client->phase == PM_NB_AUTHORIZING && authorization_ready != 0) {
          int authorized = pm_scope_progress(&client->authorization, authorization_ready);
          if (authorized < 0) pm_nb_reply(client, errno);
          else if (authorized > 0 && client->authorizing_broker) {
            client->authorizing_broker = 0;
            if (pm_scope_begin(&client->authorization, server->agent_path, server->controller_token,
                client->pid, client->birth, server->network_id) != 0) pm_nb_reply(client, errno);
          } else if (authorized > 0) pm_nb_execute(server, client);
        }
        if ((client->phase == PM_NB_CONNECTING || client->phase == PM_NB_ACCEPTING) && socket_ready & (POLLIN | POLLOUT | POLLERR | POLLHUP)) {
          if (client->phase == PM_NB_ACCEPTING) pm_nb_accept_tcp(client);
          else {
            int error = 0; socklen_t size = sizeof(error);
            if (getsockopt(client->socket, SOL_SOCKET, SO_ERROR, &error, &size) != 0) error = errno;
            pm_nb_reply(client, error);
          }
        }
      }
      if (client->control >= 0 && client->phase == PM_NB_SEND) pm_nb_send(client);
      if (client->control >= 0 && client->phase == PM_NB_FD_ACKNOWLEDGEMENT && control & (POLLIN | POLLHUP | POLLERR)) {
        unsigned char acknowledgement;
        ssize_t count = recv(client->control, &acknowledgement, 1, 0);
        if (count >= 0 || (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) pm_nb_release(client);
      }
    }
  }
  for (size_t index = 0; index < PM_NB_MAX_CLIENTS; index++) pm_nb_release(&server->clients[index]);
}
/* Descriptor-rooted parent validation prevents credential/socket redirection
 * through a writable symlink. Existing endpoints are never unlinked at start. */
static int pm_nb_bind_control(pm_nb_server *server) {
  char path[sizeof(server->socket_path)];
  memcpy(path, server->socket_path, sizeof(path));
  char *leaf = strrchr(path, '/');
  if (leaf == NULL || leaf[1] == '\0' || !strstr(path, "/.portmanager/security/sockets/")) { errno = EINVAL; return -1; }
  *leaf++ = '\0';
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  char *save = NULL;
  for (char *part = strtok_r(path, "/", &save); directory >= 0 && part != NULL; part = strtok_r(NULL, "/", &save)) {
    if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) { close(directory); errno = EINVAL; return -1; }
    int next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(directory); directory = next;
  }
  struct stat parent;
  if (directory < 0) return -1;
  if (fstat(directory, &parent) != 0 || parent.st_uid != geteuid() || (parent.st_mode & 077) != 0) { close(directory); errno = EACCES; return -1; }
  struct stat existing;
  if (fstatat(directory, leaf, &existing, AT_SYMLINK_NOFOLLOW) == 0) { close(directory); errno = EADDRINUSE; return -1; }
  if (errno != ENOENT || fchdir(directory) != 0) { close(directory); return -1; }
  close(directory);
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  memcpy(address.sun_path, leaf, strlen(leaf) + 1);
  server->server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server->server < 0 || pm_nb_nonblocking(server->server) != 0 ||
      bind(server->server, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      chmod(leaf, 0600) != 0 || listen(server->server, 64) != 0 || lstat(leaf, &server->socket_identity) != 0) return -1;
  return 0;
}
/* The host router can observe a just-connected socket before its FD is handed
 * to the workload. Pin the broker's own fixed realm before accepting work. */
static int pm_nb_register_broker(pm_nb_server *server) {
  if (server->agent_path == NULL) return 0;
  pm_scope_client registration;
  if (pm_scope_begin(&registration, server->agent_path, server->controller_token,
      getpid(), pm_nb_birth(getpid()), server->network_id) != 0) return -1;
  long long deadline = pm_nb_now() + PM_NB_DEADLINE_MS;
  while (pm_nb_running) {
    long long remaining = deadline - pm_nb_now();
    if (remaining <= 0) { errno = ETIMEDOUT; break; }
    struct pollfd descriptor = { .fd = registration.fd, .events = pm_scope_events(&registration) };
    int ready = poll(&descriptor, 1, remaining > 50 ? 50 : (int)remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) break;
    if (ready == 0) continue;
    int result = pm_scope_progress(&registration, descriptor.revents);
    if (result == 1) return 0;
    if (result < 0) break;
  }
  int error = pm_nb_running ? errno : EINTR;
  pm_scope_close(&registration); errno = error; return -1;
}
int main(int argc, char **argv) {
#if defined(__APPLE__)
  /* The broker needs only standard IO at launch. Do not retain control-plane
   * files/sockets accidentally inherited from its trusted parent. Workload
   * launchers must independently do the same before entering kernel policy. */
  if (pm_nb_close_inherited() != 0) return 1;
#endif
  pm_nb_server server;
  memset(&server, 0, sizeof(server)); server.server = -1;
  /* Initial zeroed slots must not close the parent's stdin. */
  for (size_t index = 0; index < PM_NB_MAX_CLIENTS; index++) {
    server.clients[index].control = server.clients[index].socket = server.clients[index].returned = -1;
    server.clients[index].authorization.fd = -1;
  }
  const char *host = NULL;
  for (int index = 1; index < argc; index += 2) {
    if (index + 1 >= argc) return 2;
    if (strcmp(argv[index], "--socket") == 0 && strlen(argv[index + 1]) < sizeof(server.socket_path)) strcpy(server.socket_path, argv[index + 1]);
    else if (strcmp(argv[index], "--network-id") == 0 && strlen(argv[index + 1]) < sizeof(server.network_id)) strcpy(server.network_id, argv[index + 1]);
    else if (strcmp(argv[index], "--loopback-host") == 0) host = argv[index + 1];
    else if (strcmp(argv[index], "--agent-socket") == 0) server.agent_path = argv[index + 1];
    else if (strcmp(argv[index], "--controller-token-file") == 0) server.controller_path = argv[index + 1];
    else return 2;
  }
  char key[PM_NETWORK_NAMESPACE_KEY_SIZE];
  if (server.socket_path[0] != '/' || pm_network_namespace_key(server.network_id, key, sizeof(key)) != 0 ||
      host == NULL || inet_pton(AF_INET, host, &server.host) != 1 || (ntohl(server.host.s_addr) >> 24) != 127) return 2;
  if ((server.agent_path == NULL) != (server.controller_path == NULL)) return 2;
  if (server.controller_path != NULL && pm_scope_read_key(server.controller_path, server.controller_token) != 0) return 1;
  signal(SIGTERM, pm_nb_stop); signal(SIGINT, pm_nb_stop); signal(SIGHUP, pm_nb_stop); signal(SIGPIPE, SIG_IGN);
  if (pm_nb_register_broker(&server) != 0) { pm_dev_log("network-broker", "scope startup rejected errno=%d", errno); return 1; }
  if (pm_nb_bind_control(&server) != 0) { pm_dev_log("network-broker", "startup failed errno=%d", errno); if (server.server >= 0) close(server.server); return 1; }
  puts("ready"); fflush(stdout);
  pm_nb_loop(&server);
  close(server.server);
  struct stat current;
  if (lstat(server.socket_path, &current) == 0 && current.st_dev == server.socket_identity.st_dev &&
      current.st_ino == server.socket_identity.st_ino && S_ISSOCK(current.st_mode)) unlink(server.socket_path);
  return 0;
}

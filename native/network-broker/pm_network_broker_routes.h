#ifndef PM_NETWORK_BROKER_ROUTES_H
#define PM_NETWORK_BROKER_ROUTES_H

#include "../shared/pm_private_file.h"

#define PM_NB_ROUTE_BYTES (64 * 1024)
#define PM_NB_ROUTE_ROWS 512

static int pm_nb_routes_unchanged(const struct stat *before, const struct stat *after) {
  if (before->st_dev != after->st_dev || before->st_ino != after->st_ino || before->st_size != after->st_size) return 0;
#if defined(__APPLE__)
  return before->st_mtimespec.tv_sec == after->st_mtimespec.tv_sec && before->st_mtimespec.tv_nsec == after->st_mtimespec.tv_nsec &&
    before->st_ctimespec.tv_sec == after->st_ctimespec.tv_sec && before->st_ctimespec.tv_nsec == after->st_ctimespec.tv_nsec;
#else
  return before->st_mtim.tv_sec == after->st_mtim.tv_sec && before->st_mtim.tv_nsec == after->st_mtim.tv_nsec &&
    before->st_ctim.tv_sec == after->st_ctim.tv_sec && before->st_ctim.tv_nsec == after->st_ctim.tv_nsec;
#endif
}
static int pm_nb_routes_json(const char *line) {
  const char *end = pm_scope_json_value(line, 0);
  return strlen(line) <= 1024 && *pm_scope_space(line) == '{' && end != NULL && *pm_scope_space(end) == '\0';
}

/* A controller publishes complete private JSONL snapshots. No file path, realm
 * or target override exists in a workload request. Validate every row before
 * returning a single requested mapping; malformed snapshots never partially apply. */
static int pm_nb_routes_lookup(const char *path, const char *network_id, unsigned short requested_port, struct sockaddr_storage *mapped) {
  char leaf[NAME_MAX + 1];
  int directory = pm_private_parent(path, "/.portmanager/security/broker-routes/", leaf, sizeof(leaf));
  if (directory < 0) return -1;
  int fd = openat(directory, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  close(directory); if (fd < 0) return -1;
  struct stat before, after;
  if (pm_private_regular(fd, &before) != 0 || before.st_size <= 0 || before.st_size > PM_NB_ROUTE_BYTES) {
    close(fd); errno = EACCES; return -1;
  }
  char *contents = malloc((size_t)before.st_size + 2);
  if (contents == NULL) { close(fd); return -1; }
  ssize_t bytes = read(fd, contents, (size_t)before.st_size + 1);
  int unchanged = pm_private_regular(fd, &after) == 0 && pm_nb_routes_unchanged(&before, &after);
  close(fd);
  int result = -1, error = EPROTO;
  if (!unchanged || bytes != before.st_size || memchr(contents, '\0', (size_t)before.st_size) != NULL) goto done;
  contents[bytes] = '\0';
  char *newline = strchr(contents, '\n'), actual_id[128];
  if (newline == NULL) goto done;
  *newline = '\0';
  if (!pm_nb_routes_json(contents) || !pm_scope_unsigned_matches(contents, "version", 1) ||
      pm_json_get_string(contents, "networkId", actual_id, sizeof(actual_id)) != 0 || strcmp(actual_id, network_id) != 0) goto done;
  unsigned char ports[65536 / 8]; memset(ports, 0, sizeof(ports));
  int rows = 0, found = 0;
  for (char *line = newline + 1; *line != '\0'; line = newline + 1) {
    newline = strchr(line, '\n'); if (newline == NULL || ++rows > PM_NB_ROUTE_ROWS) goto done;
    *newline = '\0';
    long logical_port = pm_json_get_long(line, "logicalPort", 0), target_port = pm_json_get_long(line, "targetPort", 0);
    char host[INET6_ADDRSTRLEN];
    if (!pm_nb_routes_json(line) || logical_port <= 0 || logical_port > 65535 || target_port <= 0 || target_port > 65535 ||
        !pm_scope_unsigned_matches(line, "logicalPort", (unsigned long long)logical_port) ||
        !pm_scope_unsigned_matches(line, "targetPort", (unsigned long long)target_port) ||
        pm_json_get_string(line, "targetHost", host, sizeof(host)) != 0 || ports[logical_port / 8] & (1u << (logical_port % 8))) goto done;
    ports[logical_port / 8] |= (unsigned char)(1u << (logical_port % 8));
    struct sockaddr_storage target; memset(&target, 0, sizeof(target));
    struct sockaddr_in *v4 = (struct sockaddr_in *)&target;
    struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&target;
    if (inet_pton(AF_INET, host, &v4->sin_addr) == 1) {
      if (v4->sin_addr.s_addr == INADDR_ANY) goto done;
      v4->sin_family = AF_INET; v4->sin_port = htons((unsigned short)target_port);
#if defined(__APPLE__)
      v4->sin_len = sizeof(*v4);
#endif
    } else if (inet_pton(AF_INET6, host, &v6->sin6_addr) == 1) {
      if (IN6_IS_ADDR_UNSPECIFIED(&v6->sin6_addr)) goto done;
      v6->sin6_family = AF_INET6; v6->sin6_port = htons((unsigned short)target_port);
#if defined(__APPLE__)
      v6->sin6_len = sizeof(*v6);
#endif
    } else goto done;
    if (logical_port == requested_port && mapped != NULL) { *mapped = target; found = 1; }
  }
  result = found;
done:
  free(contents); if (result < 0) errno = error; return result;
}
static int pm_nb_routes_apply(const char *path, const char *network_id, struct sockaddr_storage *target) {
  struct sockaddr_storage mapped;
  unsigned short port = target->ss_family == AF_INET ? ntohs(((struct sockaddr_in *)target)->sin_port) : ntohs(((struct sockaddr_in6 *)target)->sin6_port);
  int found = pm_nb_routes_lookup(path, network_id, port, &mapped);
  if (found <= 0) return found;
  if (target->ss_family == mapped.ss_family) { *target = mapped; return 1; }
  if (target->ss_family != AF_INET6 || mapped.ss_family != AF_INET) { errno = EAFNOSUPPORT; return -1; }
  struct sockaddr_in *v4 = (struct sockaddr_in *)&mapped;
  struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)target;
  memset(v6, 0, sizeof(*v6)); v6->sin6_family = AF_INET6; v6->sin6_port = v4->sin_port;
#if defined(__APPLE__)
  v6->sin6_len = sizeof(*v6);
#endif
  v6->sin6_addr.s6_addr[10] = v6->sin6_addr.s6_addr[11] = 0xff;
  memcpy(&v6->sin6_addr.s6_addr[12], &v4->sin_addr, sizeof(v4->sin_addr)); return 1;
}

#endif

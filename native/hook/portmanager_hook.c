#define _GNU_SOURCE

#include <arpa/inet.h>
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

/*
 * Port Manager native socket hook.
 *
 * This library is injected into terminal-launched development processes. It
 * rewrites bind(logicalPort) to bind(actualPort), registers the resulting
 * route with the daemon, translates connect(logicalPort) to actualPort, and
 * maps getsockname(actualPort) back to logicalPort so the process still sees
 * its requested logical port.
 */

#define PM_MAX_RESPONSE 65536
#define PM_MAX_REQUEST 8192
#define PM_MAX_TEXT 512
#define PM_MAX_PATH 1024
#define PM_MAX_ROUTES 128
#define PM_DEFAULT_SCAN_RANGE 20
#define PM_DEFAULT_VIRTUAL_START 53000
#define PM_DEFAULT_VIRTUAL_END 59999
#define PM_DEFAULT_FIXED_PROTOCOL_PORTS "22,25,53,80,110,143,389,443,465,587,993,995,1433,1521,3306,33060,5432,5672,6379,9200,9300,11211,27017"
#define PM_BIND_ALLOCATION_ATTEMPTS 4

typedef int (*pm_bind_fn)(int, const struct sockaddr *, socklen_t);
typedef int (*pm_connect_fn)(int, const struct sockaddr *, socklen_t);
typedef int (*pm_getsockname_fn)(int, struct sockaddr *, socklen_t *);

typedef struct {
  int logical_port;
  int actual_port;
  char allocation_id[PM_MAX_TEXT];
  char host[128];
} pm_route_mapping;

#if defined(__APPLE__)
static pm_bind_fn pm_real_bind = bind;
static pm_connect_fn pm_real_connect = connect;
static pm_getsockname_fn pm_real_getsockname = getsockname;
#else
static pm_bind_fn pm_real_bind = NULL;
static pm_connect_fn pm_real_connect = NULL;
static pm_getsockname_fn pm_real_getsockname = NULL;
#endif
static __thread int pm_hook_depth = 0;
static pm_route_mapping pm_routes[PM_MAX_ROUTES];
static int pm_route_count = 0;
static unsigned long pm_request_sequence = 1;

static int pm_hook_enabled(void) {
  const char *disabled = getenv("PORT_MANAGER_HOOK_DISABLED");
  const char *enabled = getenv("PORT_MANAGER_HOOK");

  if (disabled != NULL && strcmp(disabled, "1") == 0) {
    return 0;
  }

  return enabled == NULL || strcmp(enabled, "0") != 0;
}

static int pm_debug_enabled(void) {
  const char *debug = getenv("PORT_MANAGER_HOOK_DEBUG");
  return debug != NULL && strcmp(debug, "1") == 0;
}

static void pm_debug(const char *format, ...) {
  va_list args;

  if (!pm_debug_enabled()) {
    return;
  }

  fprintf(stderr, "[portmanager-hook pid=%ld] ", (long)getpid());
  va_start(args, format);
  vfprintf(stderr, format, args);
  va_end(args);
  fprintf(stderr, "\n");
}

__attribute__((constructor)) static void pm_hook_loaded(void) {
  pm_debug("loaded");
}

static void *pm_resolve_symbol(const char *name) {
  void *symbol = dlsym(RTLD_NEXT, name);
  return symbol;
}

static void pm_ensure_symbols(void) {
  if (pm_real_bind == NULL) {
    pm_real_bind = (pm_bind_fn)pm_resolve_symbol("bind");
  }

  if (pm_real_connect == NULL) {
    pm_real_connect = (pm_connect_fn)pm_resolve_symbol("connect");
  }

  if (pm_real_getsockname == NULL) {
    pm_real_getsockname = (pm_getsockname_fn)pm_resolve_symbol("getsockname");
  }
}

static int pm_parse_int_env(const char *name, int fallback) {
  const char *value = getenv(name);
  char *end = NULL;
  long parsed;

  if (value == NULL || value[0] == '\0') {
    return fallback;
  }

  parsed = strtol(value, &end, 10);
  if (end == value || *end != '\0' || parsed < 0 || parsed > 65535) {
    return fallback;
  }

  return (int)parsed;
}

static int pm_port_list_contains(const char *ports, int target_port) {
  const char *cursor = ports;

  while (cursor != NULL && *cursor != '\0') {
    char *end = NULL;
    long parsed;

    while (*cursor != '\0' && !isdigit((unsigned char)*cursor)) {
      cursor++;
    }

    if (*cursor == '\0') {
      break;
    }

    parsed = strtol(cursor, &end, 10);
    if (end == cursor) {
      break;
    }

    if (parsed == target_port) {
      return 1;
    }

    cursor = end;
  }

  return 0;
}

static int pm_is_fixed_protocol_port(int port) {
  const char *configured_ports = getenv("PORT_MANAGER_FIXED_PROTOCOL_PORTS");
  const char *ports = configured_ports != NULL ? configured_ports : PM_DEFAULT_FIXED_PROTOCOL_PORTS;

  if (ports == NULL || ports[0] == '\0') {
    return 0;
  }

  return pm_port_list_contains(ports, port);
}

static const char *pm_routing_mode(void) {
  const char *mode = getenv("PORT_MANAGER_ROUTING_MODE");

  if (mode != NULL && (strcmp(mode, "nearest") == 0 || strcmp(mode, "hashed") == 0)) {
    return mode;
  }

  return "hashed";
}

static void pm_default_socket_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_AGENT_SOCKET");

  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-agent-%ld.sock", (long)getuid());
}

static void pm_default_route_table_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_ROUTES_FILE");

  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-routes-%ld.json", (long)getuid());
}

static void pm_default_host_access_path(char *buffer, size_t size) {
  const char *configured = getenv("PORT_MANAGER_HOST_ACCESS_FILE");

  if (configured != NULL && configured[0] != '\0') {
    snprintf(buffer, size, "%s", configured);
    return;
  }

  snprintf(buffer, size, "/tmp/newdlops-portmanager-host-access-%ld.json", (long)getuid());
}

static int pm_is_supported_sockaddr(const struct sockaddr *addr, socklen_t addrlen) {
  if (addr == NULL) {
    return 0;
  }

  if (addr->sa_family == AF_INET) {
    return addrlen >= (socklen_t)sizeof(struct sockaddr_in);
  }

  if (addr->sa_family == AF_INET6) {
    return addrlen >= (socklen_t)sizeof(struct sockaddr_in6);
  }

  return 0;
}

static int pm_sockaddr_port(const struct sockaddr *addr) {
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    return ntohs(in->sin_port);
  }

  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    return ntohs(in6->sin6_port);
  }

  return 0;
}

static void pm_set_sockaddr_port(struct sockaddr *addr, int port) {
  if (addr->sa_family == AF_INET) {
    struct sockaddr_in *in = (struct sockaddr_in *)addr;
    in->sin_port = htons((uint16_t)port);
  }

  if (addr->sa_family == AF_INET6) {
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)addr;
    in6->sin6_port = htons((uint16_t)port);
  }
}

static int pm_set_ipv4_mapped_ipv6(struct in6_addr *target, const char *host) {
  struct in_addr v4;

  if (strcmp(host, "localhost") == 0) {
    host = "127.0.0.1";
  }

  if (inet_pton(AF_INET, host, &v4) != 1) {
    return 0;
  }

  memset(target, 0, sizeof(*target));
  target->s6_addr[10] = 0xff;
  target->s6_addr[11] = 0xff;
  memcpy(&target->s6_addr[12], &v4, sizeof(v4));
  return 1;
}

static void pm_set_sockaddr_host(struct sockaddr *addr, const char *host) {
  if (host == NULL || host[0] == '\0') {
    return;
  }

  if (addr->sa_family == AF_INET) {
    struct sockaddr_in *in = (struct sockaddr_in *)addr;

    if (strcmp(host, "localhost") == 0 || strcmp(host, "::1") == 0) {
      inet_pton(AF_INET, "127.0.0.1", &in->sin_addr);
      return;
    }

    (void)inet_pton(AF_INET, host, &in->sin_addr);
    return;
  }

  if (addr->sa_family == AF_INET6) {
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)addr;

    if (pm_set_ipv4_mapped_ipv6(&in6->sin6_addr, host)) {
      return;
    }

    (void)inet_pton(AF_INET6, host, &in6->sin6_addr);
  }
}

static int pm_sockaddr_is_local(const struct sockaddr *addr) {
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    uint32_t ip = ntohl(in->sin_addr.s_addr);
    return ip == 0 || (ip >> 24) == 127;
  }

  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    static const unsigned char loopback[16] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
    static const unsigned char any[16] = {0};
    return memcmp(&in6->sin6_addr, loopback, 16) == 0 || memcmp(&in6->sin6_addr, any, 16) == 0;
  }

  return 0;
}

static void pm_sockaddr_host(const struct sockaddr *addr, char *buffer, size_t size) {
  if (addr->sa_family == AF_INET) {
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;

    if (in->sin_addr.s_addr == INADDR_ANY) {
      snprintf(buffer, size, "localhost");
      return;
    }

    inet_ntop(AF_INET, &in->sin_addr, buffer, (socklen_t)size);
    return;
  }

  if (addr->sa_family == AF_INET6) {
    const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *)addr;
    inet_ntop(AF_INET6, &in6->sin6_addr, buffer, (socklen_t)size);
    return;
  }

  snprintf(buffer, size, "localhost");
}

static void pm_json_escape(const char *input, char *output, size_t size) {
  size_t used = 0;

  if (size == 0) {
    return;
  }

  for (size_t index = 0; input != NULL && input[index] != '\0' && used + 2 < size; index++) {
    unsigned char ch = (unsigned char)input[index];

    if (ch == '"' || ch == '\\') {
      if (used + 2 >= size) {
        break;
      }

      output[used++] = '\\';
      output[used++] = (char)ch;
      continue;
    }

    if (ch == '\n' || ch == '\r' || ch == '\t') {
      output[used++] = ' ';
      continue;
    }

    output[used++] = (char)ch;
  }

  output[used] = '\0';
}

static void pm_cwd(char *buffer, size_t size) {
  if (getcwd(buffer, size) == NULL) {
    snprintf(buffer, size, ".");
  }
}

static void pm_command_name(char *buffer, size_t size) {
#if defined(__APPLE__)
  extern const char *getprogname(void);
  const char *name = getprogname();
  snprintf(buffer, size, "%s", name != NULL ? name : "process");
#else
  int fd = open("/proc/self/cmdline", O_RDONLY);
  ssize_t count;

  if (fd < 0) {
    snprintf(buffer, size, "process");
    return;
  }

  count = read(fd, buffer, size - 1);
  close(fd);

  if (count <= 0) {
    snprintf(buffer, size, "process");
    return;
  }

  for (ssize_t index = 0; index < count; index++) {
    if (buffer[index] == '\0') {
      buffer[index] = ' ';
    }
  }

  buffer[count] = '\0';
#endif
}

static int pm_agent_roundtrip(const char *request, char *response, size_t response_size) {
  char socket_path[PM_MAX_PATH];
  struct sockaddr_un server_addr;
  int fd;
  size_t request_len = strlen(request);
  ssize_t written;
  size_t total = 0;

  pm_ensure_symbols();
  if (pm_real_connect == NULL) {
    return -1;
  }

  pm_default_socket_path(socket_path, sizeof(socket_path));
  fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    return -1;
  }

  {
    struct timeval timeout;
    timeout.tv_sec = 1;
    timeout.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  }

  memset(&server_addr, 0, sizeof(server_addr));
  server_addr.sun_family = AF_UNIX;
  snprintf(server_addr.sun_path, sizeof(server_addr.sun_path), "%s", socket_path);

  pm_hook_depth++;
  if (pm_real_connect(fd, (struct sockaddr *)&server_addr, sizeof(server_addr)) != 0) {
    int saved_errno = errno;
    pm_hook_depth--;
    close(fd);
    pm_debug("agent connect failed socket=%s error=%s", socket_path, strerror(saved_errno));
    return -1;
  }
  pm_hook_depth--;

  while (request_len > 0) {
    written = write(fd, request, request_len);
    if (written <= 0) {
      pm_debug("agent write failed socket=%s", socket_path);
      close(fd);
      return -1;
    }

    request += written;
    request_len -= (size_t)written;
  }

  while (total + 1 < response_size) {
    ssize_t count = read(fd, response + total, response_size - total - 1);

    if (count <= 0) {
      break;
    }

    total += (size_t)count;
    if (memchr(response, '\n', total) != NULL) {
      break;
    }
  }

  close(fd);
  response[total] = '\0';
  if (total == 0) {
    pm_debug("agent returned empty response socket=%s", socket_path);
  }
  return total > 0 ? 0 : -1;
}

static const char *pm_find_json_key(const char *json, const char *key) {
  char pattern[128];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  return strstr(json, pattern);
}

static int pm_json_int(const char *json, const char *key, int fallback) {
  const char *cursor = pm_find_json_key(json, key);

  if (cursor == NULL) {
    return fallback;
  }

  cursor = strchr(cursor, ':');
  if (cursor == NULL) {
    return fallback;
  }

  cursor++;
  while (*cursor != '\0' && isspace((unsigned char)*cursor)) {
    cursor++;
  }

  return atoi(cursor);
}

static int pm_json_string(const char *json, const char *key, char *buffer, size_t size) {
  const char *cursor = pm_find_json_key(json, key);
  size_t used = 0;

  if (cursor == NULL || size == 0) {
    return -1;
  }

  cursor = strchr(cursor, ':');
  if (cursor == NULL) {
    return -1;
  }

  cursor++;
  while (*cursor != '\0' && isspace((unsigned char)*cursor)) {
    cursor++;
  }

  if (*cursor != '"') {
    return -1;
  }

  cursor++;
  while (*cursor != '\0' && *cursor != '"' && used + 1 < size) {
    if (*cursor == '\\' && cursor[1] != '\0') {
      cursor++;
    }

    buffer[used++] = *cursor++;
  }

  buffer[used] = '\0';
  return used > 0 ? 0 : -1;
}

static const char *pm_network_id_from_bash_env(void) {
  const char *bash_env = getenv("BASH_ENV");
  const char *base_name;
  const char *prefix = "portmanager-bash-env-";
  const char *suffix = ".sh";
  size_t prefix_length = strlen(prefix);
  size_t suffix_length = strlen(suffix);
  size_t base_length;
  size_t network_length;
  static char network_id_from_bash_env[PM_MAX_TEXT];

  /*
   * The generated BASH_ENV file is scoped to the currently attached terminal.
   * Prefer it over inherited variables so stale runtime children cannot keep
   * registering routes under a previous terminal network.
   */
  if (bash_env == NULL || bash_env[0] == '\0') {
    return NULL;
  }

  base_name = strrchr(bash_env, '/');
  base_name = base_name == NULL ? bash_env : base_name + 1;
  base_length = strlen(base_name);

  if (base_length <= prefix_length + suffix_length || strncmp(base_name, prefix, prefix_length) != 0) {
    return NULL;
  }

  if (strcmp(base_name + base_length - suffix_length, suffix) != 0) {
    return NULL;
  }

  network_length = base_length - prefix_length - suffix_length;
  if (network_length == 0 || network_length >= sizeof(network_id_from_bash_env)) {
    return NULL;
  }

  memcpy(network_id_from_bash_env, base_name + prefix_length, network_length);
  network_id_from_bash_env[network_length] = '\0';
  return network_id_from_bash_env;
}

static const char *pm_current_network_id(void) {
  const char *network_id = pm_network_id_from_bash_env();

  if (network_id != NULL && network_id[0] != '\0') {
    return network_id;
  }

  network_id = getenv("PORT_MANAGER_NETWORK_ID");

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("PORT_MANAGER_BORROWED_NETWORK_ID");
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("NEWDLOPS_PM_NETWORK_ID");
  }

  if (network_id == NULL || network_id[0] == '\0') {
    network_id = getenv("NEWDLOPS_PM_BORROWED_NETWORK_ID");
  }

  return network_id;
}

static void pm_network_scope_payload(char *buffer, size_t size) {
  const char *network_id = pm_current_network_id();
  char network_json[PM_MAX_TEXT * 2];

  if (size == 0) {
    return;
  }

  if (network_id == NULL || network_id[0] == '\0') {
    buffer[0] = '\0';
    return;
  }

  pm_json_escape(network_id, network_json, sizeof(network_json));
  snprintf(buffer, size, ",\"networkId\":\"%s\"", network_json);
}

static int pm_route_matches_network(const char *route_json) {
  const char *network_id = pm_current_network_id();
  char route_network[PM_MAX_TEXT];

  if (network_id == NULL || network_id[0] == '\0') {
    return pm_json_string(route_json, "networkId", route_network, sizeof(route_network)) != 0;
  }

  if (pm_json_string(route_json, "networkId", route_network, sizeof(route_network)) != 0) {
    return 0;
  }

  return strcmp(route_network, network_id) == 0;
}

static int pm_route_network_match_level(const char *route_json) {
  const char *network_id = pm_current_network_id();
  char route_network[PM_MAX_TEXT];

  if (network_id == NULL || network_id[0] == '\0') {
    return pm_json_string(route_json, "networkId", route_network, sizeof(route_network)) != 0 ? 2 : 0;
  }

  if (pm_json_string(route_json, "networkId", route_network, sizeof(route_network)) != 0) {
    return 1;
  }

  return strcmp(route_network, network_id) == 0 ? 2 : 0;
}

static int pm_host_access_lookup(int logical_port, char *target_host, size_t target_host_size) {
  char path[PM_MAX_PATH];
  char *buffer;
  int fd;
  struct stat stat_buffer;
  ssize_t read_count;
  char needle[64];
  char *cursor;

  pm_default_host_access_path(path, sizeof(path));
  fd = open(path, O_RDONLY);
  if (fd < 0) {
    return 0;
  }

  if (fstat(fd, &stat_buffer) != 0 || stat_buffer.st_size <= 0 || stat_buffer.st_size > 1024 * 1024) {
    close(fd);
    return 0;
  }

  buffer = (char *)malloc((size_t)stat_buffer.st_size + 1);
  if (buffer == NULL) {
    close(fd);
    return 0;
  }

  read_count = read(fd, buffer, (size_t)stat_buffer.st_size);
  close(fd);
  if (read_count <= 0) {
    free(buffer);
    return 0;
  }

  buffer[read_count] = '\0';
  snprintf(needle, sizeof(needle), "\"logicalPort\": %d", logical_port);
  cursor = buffer;

  while ((cursor = strstr(cursor, needle)) != NULL) {
    char *object_start = cursor;
    char *object_end = strchr(cursor, '}');
    int host_port;

    while (object_start > buffer && *object_start != '{') {
      object_start--;
    }

    if (object_end == NULL) {
      break;
    }

    *object_end = '\0';
    host_port = pm_json_int(object_start, "hostPort", 0);
    if (host_port > 0 && pm_route_matches_network(object_start)) {
      if (pm_json_string(object_start, "hostAddress", target_host, target_host_size) != 0) {
        snprintf(target_host, target_host_size, "127.0.0.1");
      }
      free(buffer);
      return host_port;
    }

    cursor = object_end + 1;
  }

  free(buffer);
  return 0;
}

static int pm_response_ok(const char *response) {
  return strstr(response, "\"ok\":true") != NULL || strstr(response, "\"ok\": true") != NULL;
}

static int pm_allocate_route(int logical_port, const char *host, int *actual_port, char *allocation_id, size_t allocation_size) {
  char cwd[PM_MAX_TEXT];
  char command[PM_MAX_TEXT];
  char cwd_json[PM_MAX_TEXT * 2];
  char command_json[PM_MAX_TEXT * 2];
  char host_json[256];
  char network_payload[PM_MAX_TEXT * 3];
  char request[PM_MAX_REQUEST];
  char response[PM_MAX_RESPONSE];
  unsigned long sequence = pm_request_sequence++;

  pm_cwd(cwd, sizeof(cwd));
  pm_command_name(command, sizeof(command));
  pm_json_escape(cwd, cwd_json, sizeof(cwd_json));
  pm_json_escape(command, command_json, sizeof(command_json));
  pm_json_escape(host, host_json, sizeof(host_json));
  pm_network_scope_payload(network_payload, sizeof(network_payload));
  response[0] = '\0';

  snprintf(
    request,
    sizeof(request),
    "{\"id\":\"hook-%ld-%lu\",\"method\":\"allocateRoute\",\"payload\":{\"name\":\"%s\",\"command\":\"%s\",\"cwd\":\"%s\",\"requestedPort\":%d,\"host\":\"%s\"%s,\"scanRange\":%d,\"scanDirection\":\"up\",\"routingMode\":\"%s\",\"virtualPortRangeStart\":%d,\"virtualPortRangeEnd\":%d}}\n",
    (long)getpid(),
    sequence,
    command_json,
    command_json,
    cwd_json,
    logical_port,
    host_json,
    network_payload,
    pm_parse_int_env("PORT_MANAGER_SCAN_RANGE", PM_DEFAULT_SCAN_RANGE),
    pm_routing_mode(),
    pm_parse_int_env("PORT_MANAGER_VIRTUAL_PORT_START", PM_DEFAULT_VIRTUAL_START),
    pm_parse_int_env("PORT_MANAGER_VIRTUAL_PORT_END", PM_DEFAULT_VIRTUAL_END));

  pm_debug("allocating route logical=%d host=%s mode=%s", logical_port, host, pm_routing_mode());
  if (pm_agent_roundtrip(request, response, sizeof(response)) != 0 || !pm_response_ok(response)) {
    pm_debug("allocateRoute failed logical=%d response=%.240s", logical_port, response);
    return -1;
  }

  *actual_port = pm_json_int(response, "actualPort", logical_port);
  if (pm_json_string(response, "allocationId", allocation_id, allocation_size) != 0) {
    allocation_id[0] = '\0';
  }
  pm_debug("allocated route logical=%d actual=%d allocation=%s", logical_port, *actual_port, allocation_id);

  return 0;
}

static int pm_send_simple_payload(const char *method, const char *payload) {
  char request[PM_MAX_REQUEST];
  char response[PM_MAX_RESPONSE];
  unsigned long sequence = pm_request_sequence++;

  response[0] = '\0';
  snprintf(
    request,
    sizeof(request),
    "{\"id\":\"hook-%ld-%lu\",\"method\":\"%s\",\"payload\":%s}\n",
    (long)getpid(),
    sequence,
    method,
    payload);
  if (pm_agent_roundtrip(request, response, sizeof(response)) != 0 || !pm_response_ok(response)) {
    pm_debug("%s failed response=%.240s", method, response);
    return -1;
  }

  pm_debug("%s succeeded", method);
  return 0;
}

static void pm_register_process(int logical_port, int actual_port, const char *host, const char *allocation_id) {
  char cwd[PM_MAX_TEXT];
  char command[PM_MAX_TEXT];
  char cwd_json[PM_MAX_TEXT * 2];
  char command_json[PM_MAX_TEXT * 2];
  char host_json[256];
  char allocation_json[PM_MAX_TEXT * 2];
  char network_payload[PM_MAX_TEXT * 3];
  char payload[PM_MAX_REQUEST];

  pm_cwd(cwd, sizeof(cwd));
  pm_command_name(command, sizeof(command));
  pm_json_escape(cwd, cwd_json, sizeof(cwd_json));
  pm_json_escape(command, command_json, sizeof(command_json));
  pm_json_escape(host, host_json, sizeof(host_json));
  pm_json_escape(allocation_id, allocation_json, sizeof(allocation_json));
  pm_network_scope_payload(network_payload, sizeof(network_payload));

  snprintf(
    payload,
    sizeof(payload),
    "{\"pid\":%ld,\"name\":\"%s\",\"command\":\"%s\",\"cwd\":\"%s\",\"requestedPort\":%d,\"actualPort\":%d,\"host\":\"%s\"%s,\"allocationId\":\"%s\",\"source\":\"hooked\"}",
    (long)getpid(),
    command_json,
    command_json,
    cwd_json,
    logical_port,
    actual_port,
    host_json,
    network_payload,
    allocation_json);
  pm_debug("registering hooked process logical=%d actual=%d host=%s allocation=%s", logical_port, actual_port, host, allocation_id);
  (void)pm_send_simple_payload("registerExistingProcess", payload);
}

static void pm_release_allocation(const char *allocation_id) {
  char allocation_json[PM_MAX_TEXT * 2];
  char payload[PM_MAX_TEXT * 3];

  if (allocation_id == NULL || allocation_id[0] == '\0') {
    return;
  }

  pm_json_escape(allocation_id, allocation_json, sizeof(allocation_json));
  snprintf(payload, sizeof(payload), "{\"allocationId\":\"%s\"}", allocation_json);
  (void)pm_send_simple_payload("releaseRouteAllocation", payload);
}

static void pm_remember_route(int logical_port, int actual_port, const char *host, const char *allocation_id) {
  pm_route_mapping *slot;

  for (int index = 0; index < pm_route_count; index++) {
    if (pm_routes[index].logical_port == logical_port) {
      slot = &pm_routes[index];
      slot->actual_port = actual_port;
      snprintf(slot->host, sizeof(slot->host), "%s", host);
      snprintf(slot->allocation_id, sizeof(slot->allocation_id), "%s", allocation_id);
      return;
    }
  }

  if (pm_route_count >= PM_MAX_ROUTES) {
    return;
  }

  slot = &pm_routes[pm_route_count++];
  slot->logical_port = logical_port;
  slot->actual_port = actual_port;
  snprintf(slot->host, sizeof(slot->host), "%s", host);
  snprintf(slot->allocation_id, sizeof(slot->allocation_id), "%s", allocation_id);
}

static int pm_memory_actual_for_logical(int logical_port, char *target_host, size_t target_host_size) {
  for (int index = 0; index < pm_route_count; index++) {
    if (pm_routes[index].logical_port == logical_port) {
      if (target_host != NULL && target_host_size > 0) {
        snprintf(target_host, target_host_size, "%s", pm_routes[index].host);
      }
      return pm_routes[index].actual_port;
    }
  }

  return 0;
}

static int pm_memory_logical_for_actual(int actual_port) {
  for (int index = 0; index < pm_route_count; index++) {
    if (pm_routes[index].actual_port == actual_port) {
      return pm_routes[index].logical_port;
    }
  }

  return 0;
}

static int pm_route_table_lookup(int source_port, int source_is_actual, char *target_host, size_t target_host_size) {
  char path[PM_MAX_PATH];
  char *buffer;
  int fd;
  struct stat stat_buffer;
  ssize_t read_count;
  char needle[64];
  char *cursor;
  int fallback_port = 0;
  char fallback_host[128];

  pm_default_route_table_path(path, sizeof(path));
  fd = open(path, O_RDONLY);
  if (fd < 0) {
    return 0;
  }

  if (fstat(fd, &stat_buffer) != 0 || stat_buffer.st_size <= 0 || stat_buffer.st_size > 1024 * 1024) {
    close(fd);
    return 0;
  }

  buffer = (char *)malloc((size_t)stat_buffer.st_size + 1);
  if (buffer == NULL) {
    close(fd);
    return 0;
  }

  read_count = read(fd, buffer, (size_t)stat_buffer.st_size);
  close(fd);
  if (read_count <= 0) {
    free(buffer);
    return 0;
  }

  buffer[read_count] = '\0';
  snprintf(needle, sizeof(needle), "\"%s\": %d", source_is_actual ? "actualPort" : "logicalPort", source_port);
  cursor = buffer;
  fallback_host[0] = '\0';

  while ((cursor = strstr(cursor, needle)) != NULL) {
    char *object_start = cursor;
    char *object_end = strchr(cursor, '}');
    char object_end_saved;
    int logical;
    int actual;
    int match_level;

    while (object_start > buffer && *object_start != '{') {
      object_start--;
    }

    if (object_end == NULL) {
      break;
    }

    object_end_saved = *object_end;
    *object_end = '\0';
    logical = pm_json_int(object_start, "logicalPort", 0);
    actual = pm_json_int(object_start, "actualPort", 0);
    match_level = pm_route_network_match_level(object_start);
    if (source_is_actual && actual == source_port && match_level > 0) {
      if (match_level == 2) {
        free(buffer);
        return logical;
      }

      if (fallback_port == 0) {
        fallback_port = logical;
      }
    }

    if (!source_is_actual && logical == source_port && match_level > 0) {
      if (match_level == 2) {
        if (target_host != NULL && target_host_size > 0 && pm_json_string(object_start, "host", target_host, target_host_size) != 0) {
          snprintf(target_host, target_host_size, "127.0.0.1");
        }
        free(buffer);
        return actual;
      }

      if (fallback_port == 0) {
        fallback_port = actual;
        if (pm_json_string(object_start, "host", fallback_host, sizeof(fallback_host)) != 0) {
          snprintf(fallback_host, sizeof(fallback_host), "127.0.0.1");
        }
      }
    }

    *object_end = object_end_saved;
    cursor = object_end + 1;
  }

  free(buffer);
  if (fallback_port > 0) {
    if (!source_is_actual && target_host != NULL && target_host_size > 0) {
      snprintf(target_host, target_host_size, "%s", fallback_host[0] == '\0' ? "127.0.0.1" : fallback_host);
    }
    return fallback_port;
  }

  return 0;
}

static int pm_bind_hook(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  struct sockaddr_storage rewritten;
  char host[128];
  char allocation_id[PM_MAX_TEXT];
  int logical_port;
  int actual_port;
  int result;

  pm_ensure_symbols();
  if (pm_real_bind == NULL) {
    errno = ENOSYS;
    return -1;
  }

  if (!pm_hook_enabled() || pm_hook_depth > 0 || !pm_is_supported_sockaddr(addr, addrlen)) {
    return pm_real_bind(sockfd, addr, addrlen);
  }

  logical_port = pm_sockaddr_port(addr);
  if (logical_port <= 0) {
    return pm_real_bind(sockfd, addr, addrlen);
  }

  if (pm_is_fixed_protocol_port(logical_port)) {
    pm_debug("preserving fixed protocol bind port=%d", logical_port);
    return pm_real_bind(sockfd, addr, addrlen);
  }

  pm_sockaddr_host(addr, host, sizeof(host));
  allocation_id[0] = '\0';
  actual_port = logical_port;

  result = -1;
  for (int attempt = 0; attempt < PM_BIND_ALLOCATION_ATTEMPTS; attempt++) {
    allocation_id[0] = '\0';
    actual_port = logical_port;

    pm_hook_depth++;
    if (pm_allocate_route(logical_port, host, &actual_port, allocation_id, sizeof(allocation_id)) != 0) {
      pm_hook_depth--;
      if (attempt + 1 < PM_BIND_ALLOCATION_ATTEMPTS) {
        usleep(50000);
        continue;
      }
      errno = EAGAIN;
      return -1;
    }
    pm_hook_depth--;

    memcpy(&rewritten, addr, addrlen);
    pm_set_sockaddr_port((struct sockaddr *)&rewritten, actual_port);

    result = pm_real_bind(sockfd, (struct sockaddr *)&rewritten, addrlen);
    if (result == 0) {
      break;
    }

    {
      int saved_errno = errno;
      pm_release_allocation(allocation_id);
      allocation_id[0] = '\0';

      if (saved_errno == EADDRINUSE && attempt + 1 < PM_BIND_ALLOCATION_ATTEMPTS) {
        pm_debug("bind collision logical=%d actual=%d retry=%d", logical_port, actual_port, attempt + 1);
        usleep(50000);
        errno = saved_errno;
        continue;
      }

      errno = saved_errno;
      break;
    }
  }

  if (result == 0) {
    char logical_text[16];
    char actual_text[16];

    pm_remember_route(logical_port, actual_port, host, allocation_id);
    snprintf(logical_text, sizeof(logical_text), "%d", logical_port);
    snprintf(actual_text, sizeof(actual_text), "%d", actual_port);
    setenv("PORT_MANAGER_LOGICAL_PORT", logical_text, 1);
    setenv("PORT_MANAGER_ACTUAL_PORT", actual_text, 1);
    pm_register_process(logical_port, actual_port, host, allocation_id);
  } else {
    pm_release_allocation(allocation_id);
  }

  return result;
}

static int pm_connect_hook(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  struct sockaddr_storage rewritten;
  char target_host[128];
  int logical_port;
  int actual_port;

  pm_ensure_symbols();
  if (pm_real_connect == NULL) {
    errno = ENOSYS;
    return -1;
  }

  if (!pm_hook_enabled() || pm_hook_depth > 0 || !pm_is_supported_sockaddr(addr, addrlen) || !pm_sockaddr_is_local(addr)) {
    return pm_real_connect(sockfd, addr, addrlen);
  }

  logical_port = pm_sockaddr_port(addr);
  target_host[0] = '\0';
  actual_port = pm_host_access_lookup(logical_port, target_host, sizeof(target_host));
  if (actual_port > 0) {
    memcpy(&rewritten, addr, addrlen);
    pm_set_sockaddr_port((struct sockaddr *)&rewritten, actual_port);
    pm_set_sockaddr_host((struct sockaddr *)&rewritten, target_host);
    pm_debug("connect host-access logical=%d actual=%d host=%s", logical_port, actual_port, target_host);
    return pm_real_connect(sockfd, (struct sockaddr *)&rewritten, addrlen);
  }

  actual_port = pm_memory_actual_for_logical(logical_port, target_host, sizeof(target_host));
  if (actual_port == 0) {
    actual_port = pm_route_table_lookup(logical_port, 0, target_host, sizeof(target_host));
  }

  if (actual_port <= 0 || actual_port == logical_port) {
    return pm_real_connect(sockfd, addr, addrlen);
  }

  memcpy(&rewritten, addr, addrlen);
  pm_set_sockaddr_port((struct sockaddr *)&rewritten, actual_port);
  pm_set_sockaddr_host((struct sockaddr *)&rewritten, target_host);
  pm_debug("connect route logical=%d actual=%d host=%s", logical_port, actual_port, target_host);
  return pm_real_connect(sockfd, (struct sockaddr *)&rewritten, addrlen);
}

static int pm_getsockname_hook(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  int result;
  int actual_port;
  int logical_port;

  pm_ensure_symbols();
  if (pm_real_getsockname == NULL) {
    errno = ENOSYS;
    return -1;
  }

  result = pm_real_getsockname(sockfd, addr, addrlen);
  if (result != 0 || !pm_hook_enabled() || pm_hook_depth > 0 || addr == NULL || addrlen == NULL) {
    return result;
  }

  if (!pm_is_supported_sockaddr(addr, *addrlen)) {
    return result;
  }

  actual_port = pm_sockaddr_port(addr);
  logical_port = pm_memory_logical_for_actual(actual_port);
  if (logical_port == 0) {
    logical_port = pm_route_table_lookup(actual_port, 1, NULL, 0);
  }

  if (logical_port > 0 && logical_port != actual_port) {
    pm_set_sockaddr_port(addr, logical_port);
  }

  return result;
}

#if defined(__APPLE__)
#define PM_DYLD_INTERPOSE(_replacement, _replacee) \
  __attribute__((used)) static struct { const void *replacement; const void *replacee; } \
  _pm_interpose_##_replacee __attribute__((section("__DATA,__interpose"))) = { \
    (const void *)(unsigned long)&_replacement, (const void *)(unsigned long)&_replacee \
  }

PM_DYLD_INTERPOSE(pm_bind_hook, bind);
PM_DYLD_INTERPOSE(pm_connect_hook, connect);
PM_DYLD_INTERPOSE(pm_getsockname_hook, getsockname);
#else
int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return pm_bind_hook(sockfd, addr, addrlen);
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return pm_connect_hook(sockfd, addr, addrlen);
}

int getsockname(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  return pm_getsockname_hook(sockfd, addr, addrlen);
}
#endif

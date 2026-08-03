#include "portmanager_agent.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "../shared/pm_dev_log.h"

/*
 * Browser DNS responder owned by the routing daemon.
 *
 * VS Code extension hosts previously bound this UDP socket, which tied the
 * socket's lifetime to one window and record freshness to the cross-window
 * owner lease. After an owner handoff the socket stayed in a demoted window
 * whose table never updated again, so networks created afterwards resolved as
 * NXDOMAIN. The daemon outlives windows: every window now pushes the full
 * record set through `syncBrowserDns`, and the daemon persists it next to its
 * route tables so answers survive daemon restarts and extension-less periods.
 */

#define PM_DNS_DEFAULT_PORT 53153
#define PM_DNS_HOST "127.0.0.1"
#define PM_DNS_RESPONSE_TTL_SECONDS 1
#define PM_DNS_BIND_RETRY_SECONDS 5
#define PM_DNS_MAX_RECORDS 4096
#define PM_DNS_MAX_PACKET 1500
/* Worst-case answer: 12-byte header + echoed question + 16-byte A record. */
#define PM_DNS_MAX_RESPONSE (PM_DNS_MAX_PACKET + 32)
#define PM_DNS_READ_BUDGET_PER_TURN 16
#define PM_DNS_TYPE_A 1
#define PM_DNS_TYPE_ANY 255
#define PM_DNS_CLASS_IN 1

static void pm_dns_set_error(pm_agent_state *state, const char *message) {
  snprintf(state->browser_dns_error, sizeof(state->browser_dns_error), "%s", message == NULL ? "" : message);
}

/* Lowercases in place and validates the record name: dotted labels of
 * [a-z0-9-], each 1-63 chars without leading/trailing '-', total <= 253. */
static int pm_dns_normalize_hostname(char *hostname) {
  size_t length = strlen(hostname);
  size_t label_length = 0;

  if (length > 0 && hostname[length - 1] == '.') {
    hostname[--length] = '\0';
  }
  if (length == 0 || length > 253) {
    return -1;
  }

  for (size_t index = 0; index <= length; index++) {
    char ch = hostname[index];

    if (ch == '\0' || ch == '.') {
      if (label_length == 0 || label_length > 63 || hostname[index - 1] == '-') {
        return -1;
      }
      label_length = 0;
      continue;
    }

    hostname[index] = (char)tolower((unsigned char)ch);
    ch = hostname[index];
    if (ch != '-' && !islower((unsigned char)ch) && !isdigit((unsigned char)ch)) {
      return -1;
    }
    if (label_length == 0 && ch == '-') {
      return -1;
    }
    label_length++;
  }

  return 0;
}

static int pm_dns_append_record(pm_agent_state *state, const char *hostname, const unsigned char address[4]) {
  if (state->browser_dns_count >= PM_DNS_MAX_RECORDS) {
    return -1;
  }

  if (state->browser_dns_count == state->browser_dns_capacity) {
    size_t next_capacity = state->browser_dns_capacity == 0 ? 16 : state->browser_dns_capacity * 2;
    pm_browser_dns_record *next =
      (pm_browser_dns_record *)realloc(state->browser_dns_items, next_capacity * sizeof(pm_browser_dns_record));

    if (next == NULL) {
      return -1;
    }
    state->browser_dns_items = next;
    state->browser_dns_capacity = next_capacity;
  }

  snprintf(
    state->browser_dns_items[state->browser_dns_count].hostname,
    sizeof(state->browser_dns_items[state->browser_dns_count].hostname),
    "%s",
    hostname);
  memcpy(state->browser_dns_items[state->browser_dns_count].address, address, 4);
  state->browser_dns_count++;
  return 0;
}

static const unsigned char *pm_dns_lookup(const pm_agent_state *state, const char *hostname) {
  for (size_t index = 0; index < state->browser_dns_count; index++) {
    if (strcmp(state->browser_dns_items[index].hostname, hostname) == 0) {
      return state->browser_dns_items[index].address;
    }
  }
  return NULL;
}

/* Parses one `hostname=ipv4` pair; invalid pairs are skipped like the previous
 * extension-host responder skipped invalid sync rows. */
static void pm_dns_add_pair(pm_agent_state *state, char *pair) {
  char *separator = strchr(pair, '=');
  struct in_addr parsed;
  unsigned char address[4];

  if (separator == NULL) {
    return;
  }
  *separator = '\0';

  if (pm_dns_normalize_hostname(pair) != 0) {
    return;
  }
  if (inet_pton(AF_INET, separator + 1, &parsed) != 1) {
    return;
  }

  memcpy(address, &parsed.s_addr, 4);
  pm_dns_append_record(state, pair, address);
}

/* Records persist as `hostname\tipv4` lines so a restarted daemon (or one
 * started by the shell hook with no extension running) keeps answering. */
static void pm_dns_persist_records(const pm_agent_state *state) {
  pm_buffer text;

  if (state->browser_dns_state_path[0] == '\0') {
    return;
  }

  pm_buffer_init(&text);
  for (size_t index = 0; index < state->browser_dns_count; index++) {
    const pm_browser_dns_record *record = &state->browser_dns_items[index];

    if (pm_buffer_appendf(
          &text,
          "%s\t%u.%u.%u.%u\n",
          record->hostname,
          record->address[0],
          record->address[1],
          record->address[2],
          record->address[3]) != 0) {
      pm_buffer_free(&text);
      return;
    }
  }

  if (pm_write_atomic(state->browser_dns_state_path, text.data == NULL ? "" : text.data) != 0) {
    pm_dev_log("agent-dns", "persist failed path=%s", state->browser_dns_state_path);
  }
  pm_buffer_free(&text);
}

static void pm_dns_load_persisted_records(pm_agent_state *state) {
  char line[512];
  FILE *file;

  if (state->browser_dns_state_path[0] == '\0') {
    return;
  }
  file = fopen(state->browser_dns_state_path, "r");
  if (file == NULL) {
    return;
  }

  while (fgets(line, sizeof(line), file) != NULL) {
    char *tab = strchr(line, '\t');
    char *newline;

    if (tab == NULL) {
      continue;
    }
    *tab = '=';
    newline = strpbrk(line, "\r\n");
    if (newline != NULL) {
      *newline = '\0';
    }
    pm_dns_add_pair(state, line);
  }

  fclose(file);
  if (state->browser_dns_count > 0) {
    pm_dev_log("agent-dns", "loaded %zu persisted records", state->browser_dns_count);
  }
}

/* Mirrors pm_scoped_route_table_path: sibling file of the base route table. */
static void pm_dns_build_state_path(const char *route_table_path, char *out, size_t out_size) {
  const char *slash = strrchr(route_table_path, '/');
  const char *name = slash == NULL ? route_table_path : slash + 1;
  const char *dot = strrchr(name, '.');
  size_t prefix_length = dot == NULL ? strlen(route_table_path) : (size_t)(dot - route_table_path);

  if (prefix_length >= out_size - 20) {
    out[0] = '\0';
    return;
  }
  memcpy(out, route_table_path, prefix_length);
  snprintf(out + prefix_length, out_size - prefix_length, "-browser-dns.tsv");
}

int pm_dns_maybe_rebind(pm_agent_state *state, time_t now) {
  struct sockaddr_in bind_address;
  socklen_t bound_length = sizeof(bind_address);
  int fd;
  int flags;

  if (state->browser_dns_fd >= 0 || state->browser_dns_requested_port < 0) {
    return 0;
  }
  if (state->browser_dns_bind_retry_after > now) {
    return 0;
  }
  state->browser_dns_bind_retry_after = now + PM_DNS_BIND_RETRY_SECONDS;

  fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) {
    pm_dns_set_error(state, strerror(errno));
    return 0;
  }

  memset(&bind_address, 0, sizeof(bind_address));
  bind_address.sin_family = AF_INET;
  bind_address.sin_port = htons((unsigned short)state->browser_dns_requested_port);
  if (inet_pton(AF_INET, PM_DNS_HOST, &bind_address.sin_addr) != 1 ||
      bind(fd, (struct sockaddr *)&bind_address, sizeof(bind_address)) != 0 ||
      getsockname(fd, (struct sockaddr *)&bind_address, &bound_length) != 0) {
    /* Typically EADDRINUSE while an older extension host still holds the
     * port; the retry loop takes over as soon as that window closes. */
    pm_dns_set_error(state, strerror(errno));
    close(fd);
    return 0;
  }

  flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) {
    pm_dns_set_error(state, strerror(errno));
    close(fd);
    return 0;
  }

  state->browser_dns_fd = fd;
  state->browser_dns_bound_port = (int)ntohs(bind_address.sin_port);
  pm_dns_set_error(state, "");
  pm_dev_log("agent-dns", "bound udp %s:%d records=%zu", PM_DNS_HOST, state->browser_dns_bound_port,
             state->browser_dns_count);
  return 1;
}

void pm_dns_init(pm_agent_state *state, int requested_port) {
  state->browser_dns_fd = -1;
  state->browser_dns_bound_port = 0;
  state->browser_dns_bind_retry_after = 0;
  state->browser_dns_requested_port = requested_port < 0 ? PM_DNS_DEFAULT_PORT : requested_port;
  pm_dns_build_state_path(state->route_table_path, state->browser_dns_state_path, sizeof(state->browser_dns_state_path));
  pm_dns_load_persisted_records(state);
  pm_dns_maybe_rebind(state, time(NULL));
}

void pm_dns_dispose(pm_agent_state *state) {
  if (state->browser_dns_fd >= 0) {
    close(state->browser_dns_fd);
    state->browser_dns_fd = -1;
  }
  state->browser_dns_bound_port = 0;
  free(state->browser_dns_items);
  state->browser_dns_items = NULL;
  state->browser_dns_count = 0;
  state->browser_dns_capacity = 0;
}

/* Parses the question section at offset 12. Compression pointers are rejected:
 * resolver clients send plain names and the previous responder did the same. */
static int pm_dns_parse_question(
  const unsigned char *packet,
  size_t packet_length,
  char *name,
  size_t name_size,
  int *type,
  int *klass,
  size_t *end_offset) {
  size_t cursor = 12;
  size_t name_length = 0;

  while (cursor < packet_length) {
    unsigned char label_length = packet[cursor++];

    if (label_length == 0) {
      break;
    }
    if ((label_length & 0xc0) != 0 || cursor + label_length > packet_length) {
      return -1;
    }
    if (name_length + label_length + 2 > name_size) {
      return -1;
    }
    if (name_length > 0) {
      name[name_length++] = '.';
    }
    for (size_t index = 0; index < label_length; index++) {
      name[name_length++] = (char)tolower(packet[cursor + index]);
    }
    cursor += label_length;
  }

  if (cursor + 4 > packet_length || name_length == 0) {
    return -1;
  }

  name[name_length] = '\0';
  *type = (packet[cursor] << 8) | packet[cursor + 1];
  *klass = (packet[cursor + 2] << 8) | packet[cursor + 3];
  *end_offset = cursor + 4;
  return 0;
}

static size_t pm_dns_write_header(
  unsigned char *response,
  const unsigned char *query,
  int question_count,
  int answer_count,
  int response_code) {
  int request_flags = (query[2] << 8) | query[3];
  int response_flags = 0x8000 | (request_flags & 0x0100) | 0x0080 | (response_code & 0x000f);

  response[0] = query[0];
  response[1] = query[1];
  response[2] = (unsigned char)(response_flags >> 8);
  response[3] = (unsigned char)(response_flags & 0xff);
  response[4] = (unsigned char)(question_count >> 8);
  response[5] = (unsigned char)(question_count & 0xff);
  response[6] = (unsigned char)(answer_count >> 8);
  response[7] = (unsigned char)(answer_count & 0xff);
  memset(response + 8, 0, 4);
  return 12;
}

static size_t pm_dns_build_response(
  const pm_agent_state *state,
  const unsigned char *query,
  size_t query_length,
  unsigned char *response,
  size_t response_size) {
  char name[256];
  const unsigned char *address;
  int type = 0;
  int klass = 0;
  int question_count;
  size_t question_end = 0;
  size_t length;

  if (query_length < 12 || response_size < query_length + 28) {
    return 0;
  }

  question_count = (query[4] << 8) | query[5];
  if (question_count < 1) {
    return pm_dns_write_header(response, query, 0, 0, 0);
  }

  if (pm_dns_parse_question(query, query_length, name, sizeof(name), &type, &klass, &question_end) != 0) {
    return pm_dns_write_header(response, query, 0, 0, 1);
  }

  address = pm_dns_lookup(state, name);
  if (address == NULL || klass != PM_DNS_CLASS_IN || (type != PM_DNS_TYPE_A && type != PM_DNS_TYPE_ANY)) {
    length = pm_dns_write_header(response, query, 1, 0, address == NULL ? 3 : 0);
    memcpy(response + length, query + 12, question_end - 12);
    return length + question_end - 12;
  }

  length = pm_dns_write_header(response, query, 1, 1, 0);
  memcpy(response + length, query + 12, question_end - 12);
  length += question_end - 12;

  /* One A answer: pointer to the question name, class IN, 1s TTL, 4-byte address. */
  response[length++] = 0xc0;
  response[length++] = 0x0c;
  response[length++] = 0;
  response[length++] = PM_DNS_TYPE_A;
  response[length++] = 0;
  response[length++] = PM_DNS_CLASS_IN;
  response[length++] = 0;
  response[length++] = 0;
  response[length++] = 0;
  response[length++] = PM_DNS_RESPONSE_TTL_SECONDS;
  response[length++] = 0;
  response[length++] = 4;
  memcpy(response + length, address, 4);
  return length + 4;
}

int pm_dns_handle_readable(pm_agent_state *state) {
  unsigned char query[PM_DNS_MAX_PACKET];
  unsigned char response[PM_DNS_MAX_RESPONSE];

  if (state->browser_dns_fd < 0) {
    return 0;
  }

  for (int budget = 0; budget < PM_DNS_READ_BUDGET_PER_TURN; budget++) {
    struct sockaddr_in remote;
    socklen_t remote_length = sizeof(remote);
    ssize_t received = recvfrom(
      state->browser_dns_fd, query, sizeof(query), 0, (struct sockaddr *)&remote, &remote_length);
    size_t response_length;

    if (received < 0) {
      if (errno == EINTR) {
        continue;
      }
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return 0;
      }
      /* A broken socket cannot be polled again; drop it and let the retry
       * loop bind a replacement instead of spinning on POLLERR. */
      pm_dns_set_error(state, strerror(errno));
      pm_dev_log("agent-dns", "recvfrom failed: %s", strerror(errno));
      close(state->browser_dns_fd);
      state->browser_dns_fd = -1;
      state->browser_dns_bound_port = 0;
      state->browser_dns_bind_retry_after = 0;
      return -1;
    }

    response_length = pm_dns_build_response(state, query, (size_t)received, response, sizeof(response));
    if (response_length > 0) {
      sendto(state->browser_dns_fd, response, response_length, 0, (struct sockaddr *)&remote, remote_length);
    }
  }

  return 0;
}

int pm_dns_append_status_fields(const pm_agent_state *state, pm_buffer *payload) {
  if (pm_buffer_appendf(
        payload,
        ",\"browserDnsRunning\":%s,\"browserDnsPort\":%d",
        state->browser_dns_fd >= 0 ? "true" : "false",
        state->browser_dns_bound_port > 0 ? state->browser_dns_bound_port
                                          : (state->browser_dns_requested_port < 0 ? PM_DNS_DEFAULT_PORT
                                                                                   : state->browser_dns_requested_port)) != 0) {
    return -1;
  }
  if (state->browser_dns_error[0] != '\0') {
    if (pm_buffer_append(payload, ",\"browserDnsError\":") != 0 ||
        pm_json_append_string(payload, state->browser_dns_error) != 0) {
      return -1;
    }
  }
  return 0;
}

int pm_dns_sync(pm_agent_state *state, const char *payload_json, pm_buffer *response) {
  const char *source = payload_json == NULL ? "" : payload_json;
  char *records = (char *)malloc(strlen(source) + 2);
  char *cursor;
  char *pair;

  if (records == NULL) {
    return -1;
  }
  /* An explicit empty records string is a legitimate full replace with zero
   * rows (every logical network was removed), but a payload missing the key
   * entirely is malformed and must not wipe live records. */
  if (pm_json_get_string(source, "records", records, strlen(source) + 2) != 0) {
    free(records);
    return -1;
  }

  state->browser_dns_count = 0;
  cursor = records;
  while ((pair = strsep(&cursor, ",")) != NULL) {
    if (pair[0] != '\0') {
      pm_dns_add_pair(state, pair);
    }
  }
  free(records);

  pm_dns_persist_records(state);
  /* A user-driven sync should not wait out the backoff window. */
  state->browser_dns_bind_retry_after = 0;
  pm_dns_maybe_rebind(state, time(NULL));
  pm_dev_log("agent-dns", "sync records=%zu running=%d", state->browser_dns_count, state->browser_dns_fd >= 0);

  if (pm_buffer_appendf(
        response,
        "{\"running\":%s,\"port\":%d",
        state->browser_dns_fd >= 0 ? "true" : "false",
        state->browser_dns_bound_port > 0 ? state->browser_dns_bound_port : state->browser_dns_requested_port) != 0) {
    return -1;
  }
  if (state->browser_dns_error[0] != '\0') {
    if (pm_buffer_append(response, ",\"error\":") != 0 ||
        pm_json_append_string(response, state->browser_dns_error) != 0) {
      return -1;
    }
  }
  return pm_buffer_append_char(response, '}');
}

#include "portmanager_agent.h"

#include <ctype.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int pm_buffer_reserve(pm_buffer *buffer, size_t extra) {
  size_t required;
  size_t next_capacity;
  char *next_data;

  required = buffer->length + extra + 1;
  if (required <= buffer->capacity) {
    return 0;
  }

  next_capacity = buffer->capacity == 0 ? 1024 : buffer->capacity;
  while (next_capacity < required) {
    next_capacity *= 2;
  }

  next_data = (char *)realloc(buffer->data, next_capacity);
  if (next_data == NULL) {
    return -1;
  }

  buffer->data = next_data;
  buffer->capacity = next_capacity;
  return 0;
}

void pm_buffer_init(pm_buffer *buffer) {
  buffer->data = NULL;
  buffer->length = 0;
  buffer->capacity = 0;
}

void pm_buffer_free(pm_buffer *buffer) {
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0;
  buffer->capacity = 0;
}

int pm_buffer_append(pm_buffer *buffer, const char *text) {
  size_t length;

  if (text == NULL) {
    return 0;
  }

  length = strlen(text);
  if (pm_buffer_reserve(buffer, length) != 0) {
    return -1;
  }

  memcpy(buffer->data + buffer->length, text, length);
  buffer->length += length;
  buffer->data[buffer->length] = '\0';
  return 0;
}

int pm_buffer_append_char(pm_buffer *buffer, char ch) {
  if (pm_buffer_reserve(buffer, 1) != 0) {
    return -1;
  }

  buffer->data[buffer->length++] = ch;
  buffer->data[buffer->length] = '\0';
  return 0;
}

int pm_buffer_appendf(pm_buffer *buffer, const char *format, ...) {
  va_list args;
  va_list copy;
  int length;

  va_start(args, format);
  va_copy(copy, args);
  length = vsnprintf(NULL, 0, format, copy);
  va_end(copy);

  if (length < 0) {
    va_end(args);
    return -1;
  }

  if (pm_buffer_reserve(buffer, (size_t)length) != 0) {
    va_end(args);
    return -1;
  }

  vsnprintf(buffer->data + buffer->length, buffer->capacity - buffer->length, format, args);
  buffer->length += (size_t)length;
  va_end(args);
  return 0;
}

int pm_json_append_string(pm_buffer *buffer, const char *value) {
  const unsigned char *cursor;

  if (pm_buffer_append_char(buffer, '"') != 0) {
    return -1;
  }

  cursor = (const unsigned char *)(value == NULL ? "" : value);
  while (*cursor != '\0') {
    unsigned char ch = *cursor++;

    switch (ch) {
      case '"':
        if (pm_buffer_append(buffer, "\\\"") != 0) {
          return -1;
        }
        break;
      case '\\':
        if (pm_buffer_append(buffer, "\\\\") != 0) {
          return -1;
        }
        break;
      case '\b':
        if (pm_buffer_append(buffer, "\\b") != 0) {
          return -1;
        }
        break;
      case '\f':
        if (pm_buffer_append(buffer, "\\f") != 0) {
          return -1;
        }
        break;
      case '\n':
        if (pm_buffer_append(buffer, "\\n") != 0) {
          return -1;
        }
        break;
      case '\r':
        if (pm_buffer_append(buffer, "\\r") != 0) {
          return -1;
        }
        break;
      case '\t':
        if (pm_buffer_append(buffer, "\\t") != 0) {
          return -1;
        }
        break;
      default:
        if (ch < 0x20) {
          if (pm_buffer_appendf(buffer, "\\u%04x", ch) != 0) {
            return -1;
          }
        } else if (pm_buffer_append_char(buffer, (char)ch) != 0) {
          return -1;
        }
        break;
    }
  }

  return pm_buffer_append_char(buffer, '"');
}

static const char *pm_skip_space(const char *cursor) {
  while (cursor != NULL && *cursor != '\0' && isspace((unsigned char)*cursor)) {
    cursor++;
  }

  return cursor;
}

static const char *pm_find_json_key(const char *json, const char *key) {
  char needle[PM_SMALL];
  const char *cursor;
  size_t key_length;

  if (json == NULL || key == NULL) {
    return NULL;
  }

  key_length = strlen(key);
  if (key_length + 3 >= sizeof(needle)) {
    return NULL;
  }

  snprintf(needle, sizeof(needle), "\"%s\"", key);
  cursor = json;

  for (;;) {
    const char *match = strstr(cursor, needle);
    if (match == NULL) {
      return NULL;
    }

    match += strlen(needle);
    match = pm_skip_space(match);
    if (match != NULL && *match == ':') {
      return pm_skip_space(match + 1);
    }

    cursor = match;
  }
}

static int pm_read_json_string(const char *cursor, char *out, size_t out_size) {
  size_t length = 0;

  if (cursor == NULL || *cursor != '"' || out_size == 0) {
    return -1;
  }

  cursor++;
  while (*cursor != '\0') {
    char ch = *cursor++;

    if (ch == '"') {
      out[length] = '\0';
      return 0;
    }

    if (ch == '\\') {
      char escaped = *cursor++;
      if (escaped == '\0') {
        break;
      }

      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          ch = escaped;
          break;
        case 'b':
          ch = '\b';
          break;
        case 'f':
          ch = '\f';
          break;
        case 'n':
          ch = '\n';
          break;
        case 'r':
          ch = '\r';
          break;
        case 't':
          ch = '\t';
          break;
        case 'u':
          /*
           * Protocol fields used by Port Manager are ASCII paths, ids, and
           * names. Preserve non-ASCII escape sequences as '?' instead of
           * pulling in a full UTF-16 decoder in the daemon hot path.
           */
          for (int index = 0; index < 4 && isxdigit((unsigned char)*cursor); index++) {
            cursor++;
          }
          ch = '?';
          break;
        default:
          ch = escaped;
          break;
      }
    }

    if (length + 1 < out_size) {
      out[length++] = ch;
    }
  }

  out[length] = '\0';
  return -1;
}

int pm_json_get_string(const char *json, const char *key, char *out, size_t out_size) {
  const char *cursor = pm_find_json_key(json, key);

  if (out_size > 0) {
    out[0] = '\0';
  }

  return pm_read_json_string(cursor, out, out_size);
}

int pm_json_get_int(const char *json, const char *key, int default_value) {
  const char *cursor = pm_find_json_key(json, key);
  char *end = NULL;
  long value;

  if (cursor == NULL) {
    return default_value;
  }

  value = strtol(cursor, &end, 10);
  if (end == cursor) {
    return default_value;
  }

  return (int)value;
}

long pm_json_get_long(const char *json, const char *key, long default_value) {
  const char *cursor = pm_find_json_key(json, key);
  char *end = NULL;
  long value;

  if (cursor == NULL) {
    return default_value;
  }

  value = strtol(cursor, &end, 10);
  if (end == cursor) {
    return default_value;
  }

  return value;
}

int pm_json_get_raw(const char *json, const char *key, char *out, size_t out_size) {
  const char *cursor = pm_find_json_key(json, key);
  size_t length = 0;

  if (cursor == NULL || out_size == 0) {
    return -1;
  }

  if (*cursor == '"') {
    const char *end = cursor + 1;
    int escaped = 0;

    while (*end != '\0') {
      if (!escaped && *end == '"') {
        end++;
        break;
      }
      escaped = !escaped && *end == '\\';
      if (*end != '\\') {
        escaped = 0;
      }
      end++;
    }

    length = (size_t)(end - cursor);
  } else {
    while (cursor[length] != '\0' && cursor[length] != ',' && cursor[length] != '}' && !isspace((unsigned char)cursor[length])) {
      length++;
    }
  }

  if (length + 1 > out_size) {
    length = out_size - 1;
  }

  memcpy(out, cursor, length);
  out[length] = '\0';
  return 0;
}

const char *pm_json_payload(const char *json) {
  return pm_find_json_key(json, "payload");
}

int pm_parse_request(const char *line, pm_request *request) {
  const char *payload;

  memset(request, 0, sizeof(*request));
  if (pm_json_get_raw(line, "id", request->id_raw, sizeof(request->id_raw)) != 0) {
    return -1;
  }

  if (pm_json_get_string(line, "method", request->method, sizeof(request->method)) != 0) {
    return -1;
  }

  payload = pm_json_payload(line);
  request->payload = payload == NULL ? "{}" : payload;
  return 0;
}

static void pm_default_text(char *target, size_t size, const char *fallback) {
  if (target[0] == '\0') {
    snprintf(target, size, "%s", fallback);
  }
}

int pm_parse_allocate_input(const char *payload, pm_allocate_input *input) {
  memset(input, 0, sizeof(*input));
  pm_json_get_string(payload, "name", input->name, sizeof(input->name));
  pm_json_get_string(payload, "command", input->command, sizeof(input->command));
  pm_json_get_string(payload, "cwd", input->cwd, sizeof(input->cwd));
  pm_json_get_string(payload, "host", input->host, sizeof(input->host));
  pm_json_get_string(payload, "actualHost", input->actual_host, sizeof(input->actual_host));
  pm_json_get_string(payload, "networkId", input->network_id, sizeof(input->network_id));
  pm_json_get_string(payload, "experimentalRouteOwnershipMode", input->experimental_route_ownership_mode, sizeof(input->experimental_route_ownership_mode));
  pm_json_get_string(payload, "terminalSessionId", input->terminal_session_id, sizeof(input->terminal_session_id));
  pm_json_get_string(payload, "routeDirection", input->route_direction, sizeof(input->route_direction));
  pm_json_get_string(payload, "scanDirection", input->scan_direction, sizeof(input->scan_direction));
  pm_json_get_string(payload, "routingMode", input->routing_mode, sizeof(input->routing_mode));
  input->compact_response = pm_json_get_int(payload, "compactResponse", 0) != 0;
  input->requested_port = pm_json_get_int(payload, "requestedPort", 0);
  input->process_group_id = pm_json_get_int(payload, "processGroupId", 0);
  input->scan_range = pm_json_get_int(payload, "scanRange", PM_DEFAULT_SCAN_RANGE);
  input->virtual_start = pm_json_get_int(payload, "virtualPortRangeStart", PM_DEFAULT_VIRTUAL_START);
  input->virtual_end = pm_json_get_int(payload, "virtualPortRangeEnd", PM_DEFAULT_VIRTUAL_END);
  pm_default_text(input->cwd, sizeof(input->cwd), ".");
  pm_default_text(input->host, sizeof(input->host), "localhost");
  pm_default_text(input->actual_host, sizeof(input->actual_host), input->host);
  pm_default_text(input->route_direction, sizeof(input->route_direction), "listen");
  pm_default_text(input->scan_direction, sizeof(input->scan_direction), "up");
  pm_default_text(input->routing_mode, sizeof(input->routing_mode), "nearest");
  return input->requested_port > 0 ? 0 : -1;
}

int pm_parse_register_input(const char *payload, pm_register_input *input) {
  memset(input, 0, sizeof(*input));
  input->pid = (pid_t)pm_json_get_long(payload, "pid", 0);
  pm_json_get_string(payload, "name", input->name, sizeof(input->name));
  pm_json_get_string(payload, "command", input->command, sizeof(input->command));
  pm_json_get_string(payload, "cwd", input->cwd, sizeof(input->cwd));
  pm_json_get_string(payload, "host", input->host, sizeof(input->host));
  pm_json_get_string(payload, "networkId", input->network_id, sizeof(input->network_id));
  pm_json_get_string(payload, "experimentalRouteOwnershipMode", input->experimental_route_ownership_mode, sizeof(input->experimental_route_ownership_mode));
  pm_json_get_string(payload, "terminalSessionId", input->terminal_session_id, sizeof(input->terminal_session_id));
  pm_json_get_string(payload, "allocationId", input->allocation_id, sizeof(input->allocation_id));
  pm_json_get_string(payload, "source", input->source, sizeof(input->source));
  input->requested_port = pm_json_get_int(payload, "requestedPort", 0);
  input->actual_port = pm_json_get_int(payload, "actualPort", input->requested_port);
  input->process_group_id = pm_json_get_int(payload, "processGroupId", 0);
  pm_default_text(input->name, sizeof(input->name), "Process");
  pm_default_text(input->command, sizeof(input->command), input->name);
  pm_default_text(input->cwd, sizeof(input->cwd), ".");
  pm_default_text(input->host, sizeof(input->host), "localhost");
  pm_default_text(input->source, sizeof(input->source), "registered");
  /*
   * Compose registrations are route rows for Docker-published endpoints, not a
   * directly owned OS process. Docker Desktop can hide the concrete listener
   * behind a VM/proxy, so extension-side Compose attach intentionally sends
   * pid 0 until listener reconciliation can adopt a real owner.
   */
  return (input->pid > 0 || strcmp(input->source, "compose") == 0) &&
                 input->requested_port > 0 &&
                 input->actual_port > 0
             ? 0
             : -1;
}

int pm_parse_start_input(const char *payload, pm_start_input *input) {
  memset(input, 0, sizeof(*input));
  pm_json_get_string(payload, "name", input->name, sizeof(input->name));
  pm_json_get_string(payload, "command", input->command, sizeof(input->command));
  pm_json_get_string(payload, "cwd", input->cwd, sizeof(input->cwd));
  pm_json_get_string(payload, "host", input->host, sizeof(input->host));
  pm_json_get_string(payload, "injectionMode", input->injection_mode, sizeof(input->injection_mode));
  pm_json_get_string(payload, "scanDirection", input->scan_direction, sizeof(input->scan_direction));
  pm_json_get_string(payload, "routingMode", input->routing_mode, sizeof(input->routing_mode));
  input->requested_port = pm_json_get_int(payload, "requestedPort", 0);
  input->scan_range = pm_json_get_int(payload, "scanRange", PM_DEFAULT_SCAN_RANGE);
  input->virtual_start = pm_json_get_int(payload, "virtualPortRangeStart", PM_DEFAULT_VIRTUAL_START);
  input->virtual_end = pm_json_get_int(payload, "virtualPortRangeEnd", PM_DEFAULT_VIRTUAL_END);
  pm_default_text(input->name, sizeof(input->name), input->command[0] == '\0' ? "Managed process" : input->command);
  pm_default_text(input->cwd, sizeof(input->cwd), ".");
  pm_default_text(input->host, sizeof(input->host), "localhost");
  pm_default_text(input->injection_mode, sizeof(input->injection_mode), "env");
  pm_default_text(input->scan_direction, sizeof(input->scan_direction), "up");
  pm_default_text(input->routing_mode, sizeof(input->routing_mode), "nearest");
  return input->requested_port > 0 && input->command[0] != '\0' ? 0 : -1;
}

int pm_parse_release_process_input(const char *payload, pm_release_process_input *input) {
  memset(input, 0, sizeof(*input));
  input->pid = (pid_t)pm_json_get_long(payload, "pid", 0);
  pm_json_get_string(payload, "allocationId", input->allocation_id, sizeof(input->allocation_id));
  pm_json_get_string(payload, "networkId", input->network_id, sizeof(input->network_id));
  pm_json_get_string(payload, "experimentalRouteOwnershipMode", input->experimental_route_ownership_mode, sizeof(input->experimental_route_ownership_mode));
  pm_json_get_string(payload, "terminalSessionId", input->terminal_session_id, sizeof(input->terminal_session_id));
  input->requested_port = pm_json_get_int(payload, "requestedPort", 0);
  input->actual_port = pm_json_get_int(payload, "actualPort", 0);
  input->process_group_id = pm_json_get_int(payload, "processGroupId", 0);
  return input->pid > 0 && input->requested_port > 0 && input->actual_port > 0 ? 0 : -1;
}

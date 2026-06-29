#ifndef PORTMANAGER_AGENT_H
#define PORTMANAGER_AGENT_H

#include <stddef.h>
#include <sys/types.h>
#include <time.h>

#define PM_TEXT 1024
#define PM_SMALL 256
#define PM_ID 128
#define PM_STATUS 32
#define PM_SOURCE 32
#define PM_DIRECTION 16
#define PM_TIME 64
#define PM_DEFAULT_SCAN_RANGE 20
#define PM_DEFAULT_VIRTUAL_START 53000
#define PM_DEFAULT_VIRTUAL_END 59999
#define PM_ROUTE_TTL_SECONDS 30
#define PM_EXTERNAL_LISTENER_GRACE_SECONDS 2
#define PM_EXTERNAL_LISTENER_MISSING_SCAN_THRESHOLD 2
/*
 * VS Code windows can request snapshots concurrently, and macOS lsof scans can
 * be expensive when Docker Desktop or endpoint security agents are active.
 * This cache keeps UI/background reads from spawning repeated lsof processes
 * while state-changing paths below explicitly invalidate it before publishing
 * the next snapshot.
 */
#define PM_LISTENER_SCAN_CACHE_SECONDS 300

typedef struct {
  char *data;
  size_t length;
  size_t capacity;
} pm_buffer;

typedef struct {
  int logical_port;
  int actual_port;
  char route_direction[PM_DIRECTION];
  char host[PM_SMALL];
  char cwd[PM_TEXT];
  char network_id[PM_SMALL];
  char process_id[PM_ID];
  char process_name[PM_SMALL];
  char status[PM_STATUS];
  char source[PM_SOURCE];
} pm_route;

typedef struct {
  char id[PM_ID];
  pid_t pid;
  char name[PM_SMALL];
  char command[PM_TEXT];
  char cwd[PM_TEXT];
  char network_id[PM_SMALL];
  int requested_port;
  int actual_port;
  char host[PM_SMALL];
  char status[PM_STATUS];
  char started_at[PM_TIME];
  char stopped_at[PM_TIME];
  char url[PM_TEXT];
  char error_message[PM_TEXT];
  char source[PM_SOURCE];
  int child_owned;
  time_t missing_listener_since;
  int missing_listener_count;
  char injection_mode[PM_SMALL];
  int scan_range;
  char scan_direction[PM_SMALL];
  char routing_mode[PM_SMALL];
  int virtual_start;
  int virtual_end;
} pm_process;

typedef struct {
  char id[PM_ID];
  pm_route route;
  time_t expires_at;
} pm_pending_route;

typedef struct {
  char id[PM_TEXT];
  char local_address[PM_SMALL];
  int port;
  pid_t pid;
  char process_name[PM_SMALL];
  char command[PM_SMALL];
  char source[PM_SOURCE];
  char updated_at[PM_TIME];
} pm_listener;

typedef struct {
  pm_process *processes;
  size_t process_count;
  size_t process_capacity;
  pm_pending_route *pending_routes;
  size_t pending_count;
  size_t pending_capacity;
  char **suppressed_detected_ids;
  size_t suppressed_count;
  size_t suppressed_capacity;
  char **written_network_ids;
  size_t written_network_count;
  size_t written_network_capacity;
  char **written_entry_paths;
  size_t written_entry_count;
  size_t written_entry_capacity;
  char **written_claim_paths;
  size_t written_claim_count;
  size_t written_claim_capacity;
  char **route_table_signature_paths;
  char **route_table_signatures;
  size_t route_table_signature_count;
  size_t route_table_signature_capacity;
  pm_listener *listener_cache_items;
  size_t listener_cache_count;
  time_t listener_cache_expires_at;
  char listener_cache_updated_at[PM_TIME];
  char route_table_path[PM_TEXT];
  char agent_main_path[PM_TEXT];
  char started_at[PM_TIME];
  char route_table_writer_id[PM_ID];
  long route_table_writer_started_ms;
  unsigned long route_table_sequence;
  unsigned long next_process_id;
  unsigned long next_allocation_id;
  pid_t agent_pid;
} pm_agent_state;

typedef struct {
  char id_raw[PM_SMALL];
  char method[PM_SMALL];
  const char *payload;
} pm_request;

typedef struct {
  char name[PM_SMALL];
  char command[PM_TEXT];
  char cwd[PM_TEXT];
  char host[PM_SMALL];
  char actual_host[PM_SMALL];
  char network_id[PM_SMALL];
  char route_direction[PM_DIRECTION];
  int compact_response;
  int requested_port;
  int scan_range;
  char scan_direction[PM_SMALL];
  char routing_mode[PM_SMALL];
  int virtual_start;
  int virtual_end;
} pm_allocate_input;

typedef struct {
  pid_t pid;
  char name[PM_SMALL];
  char command[PM_TEXT];
  char cwd[PM_TEXT];
  char network_id[PM_SMALL];
  char allocation_id[PM_ID];
  char source[PM_SOURCE];
  char host[PM_SMALL];
  int requested_port;
  int actual_port;
} pm_register_input;

typedef struct {
  char name[PM_SMALL];
  char command[PM_TEXT];
  char cwd[PM_TEXT];
  char host[PM_SMALL];
  char injection_mode[PM_SMALL];
  int requested_port;
  int scan_range;
  char scan_direction[PM_SMALL];
  char routing_mode[PM_SMALL];
  int virtual_start;
  int virtual_end;
} pm_start_input;

typedef struct {
  pid_t pid;
  char allocation_id[PM_ID];
  char network_id[PM_SMALL];
  int requested_port;
  int actual_port;
} pm_release_process_input;

void pm_buffer_init(pm_buffer *buffer);
void pm_buffer_free(pm_buffer *buffer);
int pm_buffer_append(pm_buffer *buffer, const char *text);
int pm_buffer_append_char(pm_buffer *buffer, char ch);
int pm_buffer_appendf(pm_buffer *buffer, const char *format, ...);
int pm_json_append_string(pm_buffer *buffer, const char *value);
int pm_json_get_string(const char *json, const char *key, char *out, size_t out_size);
int pm_json_get_int(const char *json, const char *key, int default_value);
long pm_json_get_long(const char *json, const char *key, long default_value);
int pm_json_get_raw(const char *json, const char *key, char *out, size_t out_size);
const char *pm_json_payload(const char *json);
int pm_parse_request(const char *line, pm_request *request);

void pm_iso_now(char *buffer, size_t size);
void pm_state_init(pm_agent_state *state, const char *route_table_path, const char *agent_main_path);
void pm_state_dispose(pm_agent_state *state);
int pm_state_allocate_route(pm_agent_state *state, const pm_allocate_input *input, pm_buffer *payload);
int pm_state_register_process(pm_agent_state *state, const pm_register_input *input, pm_buffer *payload);
int pm_state_release_allocation(pm_agent_state *state, const char *allocation_id, pm_buffer *payload);
int pm_state_release_process_route(pm_agent_state *state, const pm_release_process_input *input, pm_buffer *payload);
int pm_state_start_process(pm_agent_state *state, const pm_start_input *input, pm_buffer *payload);
int pm_state_stop_process(pm_agent_state *state, const char *id, const char *signal_name, pm_buffer *payload);
int pm_state_restart_process(pm_agent_state *state, const char *id, const char *signal_name, pm_buffer *payload);
int pm_state_remove_process(pm_agent_state *state, const char *id, pm_buffer *payload);
int pm_state_daemon_status(pm_agent_state *state, pm_buffer *payload);
int pm_state_snapshot(pm_agent_state *state, pm_buffer *payload);
int pm_state_refresh_snapshot(pm_agent_state *state, pm_buffer *payload);
int pm_state_reap_children(pm_agent_state *state);
int pm_state_listener_signature(pm_agent_state *state, pm_buffer *signature);
int pm_state_flush_route_tables(pm_agent_state *state);

int pm_parse_allocate_input(const char *payload, pm_allocate_input *input);
int pm_parse_register_input(const char *payload, pm_register_input *input);
int pm_parse_start_input(const char *payload, pm_start_input *input);
int pm_parse_release_process_input(const char *payload, pm_release_process_input *input);

#endif

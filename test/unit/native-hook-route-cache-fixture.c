/* Include the actual hook so deterministic clocks and allocation accounting can
 * exercise its private cache without adding test-only production entry points. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include <pthread.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdarg.h>
static long wall_shift, monotonic_shift;
static __thread unsigned allocations, comparisons;
static __thread int selecting, cache_lock_depth;
static int fixture_lock(pthread_mutex_t *mutex);
static int fixture_unlock(pthread_mutex_t *mutex);
static int fixture_stat(const char *path, struct stat *value);
static int fixture_fstat(int fd, struct stat *value);
static int fixture_open(const char *path, int flags, ...);
static ssize_t fixture_read(int fd, void *buffer, size_t size);
static pthread_mutex_t allocation_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct { void *pointer; size_t size; } tracked[10000];
static size_t retained_bytes;
static void track(void *old, void *next, size_t size) {
  pthread_mutex_lock(&allocation_mutex);
  int vacant = -1;
  for (int i = 0; i < 10000; i++) {
    if (tracked[i].pointer == old && old) { retained_bytes -= tracked[i].size; tracked[i].pointer = NULL; }
    if (!tracked[i].pointer && vacant < 0) vacant = i;
  }
  if (next) { assert(vacant >= 0); tracked[vacant].pointer = next; tracked[vacant].size = size; retained_bytes += size; }
  pthread_mutex_unlock(&allocation_mutex);
}
static int fixture_gettimeofday(struct timeval *tv, void *tz) {
  int result = gettimeofday(tv, tz); tv->tv_sec += wall_shift / 1000;
  tv->tv_usec += (wall_shift % 1000) * 1000;
  if (tv->tv_usec < 0) { tv->tv_sec--; tv->tv_usec += 1000000; }
  return result;
}
static int fixture_clock_gettime(clockid_t id, struct timespec *ts) {
  int result = clock_gettime(id, ts);
  if (id == CLOCK_MONOTONIC) ts->tv_sec += monotonic_shift / 1000;
  return result;
}
static void *fixture_malloc(size_t size) { allocations++; void *p = malloc(size); track(NULL, p, size); return p; }
static void *fixture_realloc(void *ptr, size_t size) { allocations++; void *p = realloc(ptr, size); if (p || !size) track(ptr, p, size); return p; }
static void fixture_free(void *ptr) { track(ptr, NULL, 0); free(ptr); }
#define free fixture_free
#define pthread_mutex_lock fixture_lock
#define pthread_mutex_unlock fixture_unlock
#define stat(...) fixture_stat(__VA_ARGS__)
#define fstat fixture_fstat
#define open fixture_open
#define read fixture_read
#define gettimeofday fixture_gettimeofday
#define clock_gettime fixture_clock_gettime
#define malloc fixture_malloc
#define realloc fixture_realloc
#include "../../native/hook/portmanager_hook.c"
#undef pthread_mutex_lock
#undef pthread_mutex_unlock
#undef stat
#undef fstat
#undef open
#undef read
#undef free
#undef gettimeofday
#undef clock_gettime
#undef malloc
#undef realloc

/* Refuse filesystem access from this thread while it owns the cache lock. */
static int fixture_lock(pthread_mutex_t *mutex) {
  int result = pthread_mutex_lock(mutex);
  if (result == 0 && mutex == &pm_route_file_cache_mutex) cache_lock_depth++;
  return result;
}
static int fixture_unlock(pthread_mutex_t *mutex) {
  if (mutex == &pm_route_file_cache_mutex) cache_lock_depth--;
  return pthread_mutex_unlock(mutex);
}
static int fixture_stat(const char *path, struct stat *value) { assert(!cache_lock_depth); return stat(path, value); }
static int fixture_fstat(int fd, struct stat *value) { assert(!cache_lock_depth); return fstat(fd, value); }
static int fixture_open(const char *path, int flags, ...) {
  assert(!cache_lock_depth);
  mode_t mode = 0;
  if (flags & O_CREAT) { va_list args; va_start(args, flags); mode = (mode_t)va_arg(args, int); va_end(args); }
  return open(path, flags, mode);
}
static ssize_t fixture_read(int fd, void *buffer, size_t size) { assert(!cache_lock_depth); return read(fd, buffer, size); }

/* Compiler coverage counts integer comparisons, including port-range searches.
 * Callbacks themselves are excluded from instrumentation. */
#if defined(__clang__)
#define NO_COVER __attribute__((no_sanitize("coverage")))
#else
#define NO_COVER
#endif
NO_COVER void __sanitizer_cov_trace_pc_guard(uint32_t *guard) { (void)guard; }
NO_COVER void __sanitizer_cov_trace_pc_guard_init(uint32_t *a, uint32_t *b) { while (a < b) *a++ = 1; }
#define CMP(bits, type) \
NO_COVER void __sanitizer_cov_trace_cmp##bits(type a, type b) { (void)a; (void)b; if (selecting) comparisons++; } \
NO_COVER void __sanitizer_cov_trace_const_cmp##bits(type a, type b) { (void)a; (void)b; if (selecting) comparisons++; }
CMP(1, uint8_t) CMP(2, uint16_t) CMP(4, uint32_t) CMP(8, uint64_t)
NO_COVER void __sanitizer_cov_trace_switch(uint64_t v, uint64_t *cases) { (void)v; (void)cases; if (selecting) comparisons++; }

static void table(const char *file, long expires, int actual, int count) {
  FILE *output = fopen(file, "w"); assert(output);
  fprintf(output, "{\"expiresAtMs\":%ld,\"routes\":[", expires);
  for (int i = 0; i < count; i++) fprintf(output,
    "%s{\"logicalPort\":%d,\"actualPort\":%d,\"networkId\":\"network-probe\",\"host\":\"127.0.0.1\",\"routeDirection\":\"listen\"}",
    i ? "," : "", 20000 + i, actual + i);
  fputs("]}", output); assert(fclose(output) == 0);
}
static int lookup(const char *file, int port) {
  char host[128]; return pm_route_table_lookup_file(file, port, 0, "listen", host, sizeof(host), NULL);
}
static void replacement(const char *file, int actual, int rows, long expires, int atomic) {
  struct stat original; assert(stat(file, &original) == 0);
  char next[PM_MAX_PATH]; snprintf(next, sizeof(next), "%s.next", file);
  const char *target = atomic ? next : file;
  table(target, expires, actual, rows);
  struct timespec times[2] = {{pm_stat_mtime_sec(&original), pm_stat_mtime_nsec(&original)}, {pm_stat_mtime_sec(&original), pm_stat_mtime_nsec(&original)}};
  assert(utimensat(AT_FDCWD, target, times, 0) == 0);
  if (atomic) assert(rename(target, file) == 0);
}
static void freshness(const char *mode, const char *file) {
  long deadline = pm_now_milliseconds() + (!strcmp(mode, "expiry") ? 1000 : 60000);
  table(file, deadline, 40000, 1); assert(lookup(file, 20000) == 40000);
  if (!strcmp(mode, "replace") || !strcmp(mode, "inplace")) {
    replacement(file, 41000, 1, deadline, !strcmp(mode, "replace"));
    assert(lookup(file, 20000) == 41000);
  } else {
    wall_shift = !strcmp(mode, "rollback") ? -60000 : 2000;
    monotonic_shift = 120000;
    assert(lookup(file, 20000) == 0);
    /* An unchanged expired document must not acquire a renewed monotonic TTL. */
    assert(lookup(file, 20000) == 0);
    table(file, pm_now_milliseconds() + 60000, 42000, 1);
    assert(lookup(file, 20000) == 42000);
  }
}
static void precedence(const char *file) {
  FILE *out = fopen(file, "w"); assert(out);
  fprintf(out, "{\"expiresAtMs\":%ld,\"routes\":[", pm_now_milliseconds() + 60000);
  fputs("{\"logicalPort\":20000,\"actualPort\":49000,\"networkId\":\"foreign\",\"routeDirection\":\"listen\"},"
        "{\"logicalPort\":20000,\"actualPort\":48000,\"networkId\":\"network-probe\",\"routeDirection\":\"send\"},"
        "{\"logicalPort\":20000,\"actualPort\":41000,\"networkId\":\"network-probe\",\"host\":\"127.2.3.4\",\"routeDirection\":\"listen\",\"source\":\"compose\"},"
        "{\"logicalPort\":20000,\"actualPort\":42000,\"networkId\":\"network-probe\",\"routeDirection\":\"listen\"},"
        "{\"logicalPort\":21000,\"actualPort\":41000,\"networkId\":\"network-probe\",\"routeDirection\":\"listen\"}]}", out);
  fclose(out);
  char host[128]; int compose = 0;
  assert(pm_route_table_lookup_file(file, 20000, 0, "listen", host, sizeof(host), &compose) == 41000);
  assert(compose == 1 && !strcmp(host, "127.2.3.4"));
  assert(pm_route_table_lookup_file(file, 20000, 0, "send", host, sizeof(host), NULL) == 48000);
  assert(pm_route_table_lookup_file(file, 41000, 1, "listen", NULL, 0, NULL) == 20000);
  setenv("PORT_MANAGER_NETWORK_ID", "missing", 1);
  assert(lookup(file, 20000) == 0);
}
static void hot(const char *file) {
  table(file, pm_now_milliseconds() + 600000, 40000, 2048);
  assert(lookup(file, 22047) == 42047);
  allocations = comparisons = 0;
  selecting = 1;
  int result = lookup(file, 22047);
  selecting = 0;
  unsigned used_allocations = allocations, used_comparisons = comparisons;
  assert(result == 42047);
  printf("allocations=%u comparisons=%u\n", used_allocations, used_comparisons);
  assert(used_allocations == 0);
#if defined(__clang__)
  assert(used_comparisons > 0 && used_comparisons < 250);
#endif
}
static void pending(const char *file) {
  setenv("PORT_MANAGER_GLOBAL_ROUTES_FILE", file, 1);
  /* The explicit network-scoped path is supplied by the TS harness. */
  setenv("PORT_MANAGER_ROUTES_FILE", file, 1);
  char effective[PM_MAX_PATH]; pm_effective_route_table_path(effective, sizeof(effective));
  assert(strncmp(effective, file, (size_t)(strrchr(file, '/') - file)) == 0);
  table(effective, pm_now_milliseconds() + 60000, 41000, 1);
  pm_remember_route(20000, 40000, "127.0.0.1", "pending", PM_ROUTE_ALLOCATION_TTL_MS);
  char host[128]; assert(pm_memory_actual_for_logical(20000, host, sizeof(host)) == 41000);
  unlink(effective);
  assert(pm_memory_actual_for_logical(20000, host, sizeof(host)) == 40000);
  table(effective, pm_now_milliseconds() + 60000, 41000, 1);
  pm_remember_route(20000, 43000, "127.0.0.1", "listener", 0);
  assert(pm_memory_actual_for_logical(20000, host, sizeof(host)) == 43000);
  pm_clear_memory_routes();
}
static void *reader(void *opaque) {
  const char *file = opaque;
  for (int i = 0; i < 500; i++) {
    int port = lookup(file, 20000);
    assert(port == 0 || port == 40000 || port == 41000);
  }
  return NULL;
}
static void concurrent(const char *file) {
  long deadline = pm_now_milliseconds() + 600000;
  table(file, deadline, 40000, 2048);
  pthread_t threads[4];
  for (int i = 0; i < 4; i++) assert(pthread_create(&threads[i], NULL, reader, (void *)file) == 0);
  for (int i = 0; i < 40; i++) replacement(file, i % 2 ? 40000 : 41000, 2048, deadline, 1);
  for (int i = 0; i < 4; i++) pthread_join(threads[i], NULL);
  assert(lookup(file, 20000) == 40000);
}
static void eviction(const char *file) {
  char other[PM_MAX_PATH];
  table(file, pm_now_milliseconds() + 600000, 40000, 2048);
  assert(lookup(file, 20000) == 40000);
  pthread_t threads[4];
  for (int i = 0; i < 4; i++) assert(pthread_create(&threads[i], NULL, reader, (void *)file) == 0);
  for (int i = 0; i < 16; i++) {
    snprintf(other, sizeof(other), "%s.%d", file, i);
    table(other, pm_now_milliseconds() + 600000, 41000, 2048);
    assert(lookup(other, 22047) == 43047);
    pthread_mutex_lock(&pm_route_file_cache_mutex);
    assert(pm_route_file_cache_payload_bytes + pm_route_file_cache_capacity * sizeof(pm_route_file_cache_entry) <= 16 * 1024 * 1024);
    pthread_mutex_unlock(&pm_route_file_cache_mutex);
  }
  for (int i = 0; i < 4; i++) pthread_join(threads[i], NULL);
  assert(lookup(file, 20000) == 40000);
  assert(retained_bytes <= 16 * 1024 * 1024);
}
static void bulk(const char *file) {
  table(file, pm_now_milliseconds() + 600000, 40000, 1);
  pm_cached_route *first, *second; size_t count;
  assert(pm_load_route_file_routes(file, &first, &count) == 0 && count == 1);
  replacement(file, 41000, 1, pm_now_milliseconds() + 600000, 1);
  assert(pm_load_route_file_routes(file, &second, &count) == 0 && count == 1);
  pm_clear_route_file_cache();
  assert(first[0].actual_port == 40000 && second[0].actual_port == 41000);
  fixture_free(first); fixture_free(second);
  assert(retained_bytes == 0);
}
static void legacy(const char *file) {
  table(file, 0, 40000, 1);
  assert(lookup(file, 20000) == 40000);
  wall_shift = -60000; monotonic_shift = 30000;
  assert(lookup(file, 20000) == 0);
  assert(lookup(file, 20000) == 0);
}
static void budget(const char *file) {
  char other[PM_MAX_PATH];
  for (int i = 0; i < 12; i++) {
    snprintf(other, sizeof(other), "%s.%d", file, i);
    table(other, pm_now_milliseconds() + 600000, 40000, 2048);
    assert(lookup(other, 22047) == 42047);
    assert(retained_bytes <= 16 * 1024 * 1024);
  }
  snprintf(other, sizeof(other), "%s.0", file);
  allocations = 0;
  assert(lookup(other, 22047) == 42047);
  assert(allocations > 0);
  assert(retained_bytes <= 16 * 1024 * 1024);
  pm_clear_route_file_cache();
  assert(retained_bytes == 0);
  /* Still within the 1MiB input budget, but the parsed array exceeds 16MiB. */
  unsetenv("PORT_MANAGER_NETWORK_ID");
  FILE *out = fopen(file, "w"); assert(out);
  fprintf(out, "{\"expiresAtMs\":%ld,\"routes\":[", pm_now_milliseconds() + 600000);
  for (int i = 0; i < 19000; i++) fprintf(out, "%s{\"logicalPort\":%d,\"actualPort\":%d}", i ? "," : "", 20000 + i, 40000 + i);
  fputs("]}", out); fclose(out);
  assert(lookup(file, 38999) == 58999);
  assert(retained_bytes <= 16 * 1024 * 1024);
}
int main(int argc, char **argv) {
  assert(argc == 3);
  setenv("PORT_MANAGER_NETWORK_ID", "network-probe", 1);
  setenv("PORT_MANAGER_NETWORK_IS_GLOBAL", "0", 1);
  if (!strcmp(argv[1], "eviction")) eviction(argv[2]);
  else if (!strcmp(argv[1], "bulk")) bulk(argv[2]);
  else if (!strcmp(argv[1], "legacy")) legacy(argv[2]);
  else if (!strcmp(argv[1], "budget")) budget(argv[2]);
  else if (!strcmp(argv[1], "hot")) hot(argv[2]);
  else if (!strcmp(argv[1], "precedence")) precedence(argv[2]);
  else if (!strcmp(argv[1], "pending")) pending(argv[2]);
  else if (!strcmp(argv[1], "concurrent")) concurrent(argv[2]);
  else freshness(argv[1], argv[2]);
  pm_clear_memory_routes(); pm_clear_route_file_cache();
  puts("ok"); return 0;
}

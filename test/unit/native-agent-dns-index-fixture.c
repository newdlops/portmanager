/* Exercise the actual responder; comparison instrumentation stays in this fixture. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <assert.h>

static size_t comparisons;
static size_t fail_allocation_bytes;
static size_t matched_allocations;
static void *controlled_malloc(size_t bytes) {
  if (bytes == fail_allocation_bytes) { matched_allocations++; return NULL; }
  return malloc(bytes);
}
static int counted_strcmp(const char *left, const char *right) {
#ifndef PM_DNS_BENCHMARK
  comparisons++;
#endif
  return strcmp(left, right);
}
#define strcmp counted_strcmp
#define malloc controlled_malloc
#include "../../native/agent/portmanager_agent_dns.c"
#undef strcmp
#undef malloc

static size_t question(unsigned char *packet, const char *hostname) {
  memset(packet, 0, 512);
  packet[5] = 1;
  size_t end = 12;
  const char *label = hostname;
  for (;;) {
    const char *dot = strchr(label, '.');
    size_t length = dot == NULL ? strlen(label) : (size_t)(dot - label);
    packet[end++] = (unsigned char)length;
    memcpy(packet + end, label, length);
    end += length;
    if (dot == NULL) break;
    label = dot + 1;
  }
  packet[end++] = 0;
  packet[end++] = 0; packet[end++] = 1;
  packet[end++] = 0; packet[end++] = 1;
  return end;
}

/* Saved linear algorithm from 398c8d8; noinline keeps both calls comparable. */
static __attribute__((noinline)) const unsigned char *baseline_lookup(const pm_browser_dns_record *items, size_t count, const char *hostname) {
  for (size_t index = 0; index < count; index++) {
    if (strcmp(items[index].hostname, hostname) == 0) return items[index].address;
  }
  return NULL;
}

static __attribute__((noinline)) const unsigned char *production_lookup(const pm_agent_state *state, const char *name) {
  return pm_dns_lookup(state->browser_dns_items, state->browser_dns_index, state->browser_dns_count, name);
}

static double now_ns(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (double)now.tv_sec * 1e9 + now.tv_nsec;
}

static int compare_double(const void *left, const void *right) {
  double a = *(const double *)left, b = *(const double *)right;
  return (a > b) - (a < b);
}

/* Identical query batches and compiler options compare the saved baseline
 * against the actual production lookup, excluding UDP/mutex/scheduling. */
static int benchmark(void) {
  enum { QUERIES = 1024, ITERATIONS = 20000, REPEATS = 5 };
  static volatile unsigned long checksum;
  const size_t counts[] = {32, 256, 4096};
  for (size_t size = 0; size < 3; size++) {
    pm_agent_state *state = calloc(1, sizeof(*state));
    assert(state != NULL);
    size_t count = counts[size];
    for (size_t row = 0; row < count; row++) {
      char pair[100];
      snprintf(pair, sizeof(pair), "network-%04zu.pm=127.120.5.9", row);
      pm_dns_add_pair(state, pair);
    }
    assert(pm_dns_build_index(state) == 0);
    for (size_t mode = 0; mode < 4; mode++) {
      char names[QUERIES][254];
      unsigned random = 123456;
      for (size_t query = 0; query < QUERIES; query++) {
        random = random * 1664525 + 1013904223;
        size_t row = mode == 0 ? random % count : mode == 1 ? count + 1 + query : mode == 2 ? 0 : count - 1;
        snprintf(names[query], sizeof(names[query]), "network-%04zu.pm", row);
      }
      double baseline[REPEATS], indexed[REPEATS];
      for (size_t repeat = 0; repeat < REPEATS; repeat++) {
        double start = now_ns();
        unsigned long sum = 0;
        for (size_t query = 0; query < ITERATIONS; query++) {
          const unsigned char *answer = baseline_lookup(state->browser_dns_items, count, names[query & (QUERIES - 1)]);
          sum += answer == NULL ? 0 : answer[0];
        }
        baseline[repeat] = (now_ns() - start) / ITERATIONS;
        checksum += sum;
        start = now_ns(); sum = 0;
        for (size_t query = 0; query < ITERATIONS; query++) {
          const unsigned char *answer = production_lookup(state, names[query & (QUERIES - 1)]);
          sum += answer == NULL ? 0 : answer[0];
        }
        indexed[repeat] = (now_ns() - start) / ITERATIONS;
        checksum += sum;
      }
      qsort(baseline, REPEATS, sizeof(double), compare_double);
      qsort(indexed, REPEATS, sizeof(double), compare_double);
      printf("count=%zu mode=%s linear_ns=%.1f indexed_ns=%.1f speedup=%.2fx index_bytes=%zu\n",
        count, (const char *[]){"uniform_hit", "miss", "first_hit", "last_hit"}[mode],
        baseline[REPEATS / 2], indexed[REPEATS / 2], baseline[REPEATS / 2] / indexed[REPEATS / 2],
        count * sizeof(*state->browser_dns_index));
    }
    double start = now_ns();
    for (size_t repeat = 0; repeat < 1000; repeat++) {
      free(state->browser_dns_index); state->browser_dns_index = NULL;
      assert(pm_dns_build_index(state) == 0);
    }
    printf("count=%zu build_us=%.2f\n", count, (now_ns() - start) / 1000000);
    free(state->browser_dns_index); free(state->browser_dns_items); free(state);
  }
  printf("checksum=%lu\n", checksum);
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--benchmark") == 0) return benchmark();
  pm_agent_state *state = calloc(1, sizeof(*state));
  assert(state != NULL);
  for (size_t row = 0; row < 4096; row++) {
    char pair[100];
    snprintf(pair, sizeof(pair), "network-%04zu.pm=127.120.5.9", row);
    pm_dns_add_pair(state, pair);
  }
  if (argc > 2 && strcmp(argv[1], "--publication-allocation") == 0) {
    pm_dns_publication *job = calloc(1, sizeof(*job));
    assert(job != NULL);
    job->replacement.browser_dns_items = state->browser_dns_items;
    job->replacement.browser_dns_count = state->browser_dns_count;
    job->replacement.browser_dns_capacity = state->browser_dns_capacity;
    pm_agent_state *live = calloc(1, sizeof(*live));
    assert(live != NULL);
    char original[] = "original.pm=127.120.5.7";
    pm_dns_add_pair(live, original);
    assert(pm_dns_build_index(live) == 0);
    job->source = live;
    const pm_browser_dns_record *original_items = live->browser_dns_items;
    const pm_browser_dns_record *const *original_index = live->browser_dns_index;
    snprintf(job->replacement.browser_dns_state_path, sizeof(job->replacement.browser_dns_state_path), "%s/failure.tsv", argv[2]);
    fail_allocation_bytes = 4096 * sizeof(pm_browser_dns_record *);
    assert(pm_dns_publication_run(job) == 0);
    if (job->applied != 0) {
      fprintf(stderr, "DNS publication accepted records without allocating their index\n");
      return 1;
    }
    assert(matched_allocations == 1);
    assert(access(job->replacement.browser_dns_state_path, F_OK) != 0);
    char *response = NULL;
    assert(pm_dns_publication_finish(job, 0, &response) == 0);
    assert(live->browser_dns_items == original_items && live->browser_dns_index == original_index);
    assert(strcmp((const char *)live->browser_dns_items[0].hostname, "original.pm") == 0);
    free(response);
    free(live->browser_dns_index); free(live->browser_dns_items); free(live);
    pm_dns_publication_free(job);
    free(state);
    puts("failed index allocation preserves unpublished state");
    return 0;
  }
  if (argc > 2 && strcmp(argv[1], "--startup-allocation") == 0) {
    snprintf(state->route_table_path, sizeof(state->route_table_path), "%s/startup.json", argv[2]);
    pm_dns_build_state_path(state->route_table_path, state->browser_dns_state_path, sizeof(state->browser_dns_state_path));
    assert(pm_dns_persist_records(state, NULL, NULL) == 0);
    free(state->browser_dns_items); state->browser_dns_items = NULL;
    state->browser_dns_count = state->browser_dns_capacity = 0;
    /* Suppress binding with the existing bind gate, so this allocation fixture
     * exercises real startup without needing any socket permission. */
    assert(setenv("PORT_MANAGER_AGENT_TEST_DNS_BIND_BLOCK_PATH", state->browser_dns_state_path, 1) == 0);
    fail_allocation_bytes = 4096 * sizeof(pm_browser_dns_record *);
    pm_dns_init(state, 0);
    assert(state->browser_dns_count == 4096 && state->browser_dns_index == NULL && matched_allocations == 1);
    comparisons = 0;
    assert(production_lookup(state, "network-4095.pm") != NULL);
    assert(comparisons == 4096);
    pm_dns_dispose(state); free(state);
    puts("startup index allocation failure retains persisted answers using linear fallback");
    return 0;
  }
  if (argc > 2 && strcmp(argv[1], "--replay-allocation") == 0) {
    pm_dns_publication *job = calloc(1, sizeof(*job));
    assert(job != NULL);
    job->replacement.browser_dns_items = state->browser_dns_items;
    job->replacement.browser_dns_count = state->browser_dns_count;
    snprintf(job->shared_state_path, sizeof(job->shared_state_path), "%s/authority.json", argv[2]);
    FILE *file = fopen(job->shared_state_path, "w");
    assert(file != NULL);
    assert(fputs("{\"version\":1,\"revision\":\"replay\",\"state\":{\"networks\":[],\"attachments\":[],\"exposures\":[]}}", file) >= 0);
    assert(fclose(file) == 0);
    strcpy(job->previous_revision, "replay"); strcpy(job->replacement.browser_dns_revision, "replay");
    fail_allocation_bytes = 4096 * sizeof(pm_browser_dns_record *);
    assert(pm_dns_publication_run(job) == 0);
    assert(job->applied == 2 && matched_allocations == 0 && job->replacement.browser_dns_index == NULL);
    pm_dns_publication_free(job); free(state);
    puts("same-revision replay skips index allocation");
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "--publication-budget") == 0) {
    pm_buffer payload;
    pm_buffer_init(&payload);
    assert(pm_buffer_append(&payload, "{\"records\":\"") == 0);
    for (size_t row = 0; row < 4096; row++)
      assert(pm_buffer_appendf(&payload, "%snetwork-%04zu.pm=127.120.5.9", row ? "," : "", row) == 0);
    assert(pm_buffer_append(&payload, "\"}") == 0);
    /* One byte below the full snapshot's cost, but above its record-only cost:
     * omitting future index bytes would incorrectly admit this publication. */
    size_t bytes = sizeof(pm_dns_publication) + 4096 * sizeof(pm_browser_dns_record) + 4096 * sizeof(pm_browser_dns_record *) - 1;
    state->browser_dns_publications = pm_publication_create(bytes, NULL, NULL);
    assert(state->browser_dns_publications != NULL);
    assert(pm_dns_sync(state, payload.data, NULL) == -1);
    pm_publication_dispose(state->browser_dns_publications);
    pm_buffer_free(&payload); free(state->browser_dns_items); free(state);
    puts("publication budget reserves future index bytes");
    return 0;
  }
  assert(pm_dns_build_index(state) == 0);
  assert(state->browser_dns_count * sizeof(*state->browser_dns_index) <= 32768);
  const char *names[] = {"network-0000.pm", "network-2048.pm", "network-4095.pm", "network-9999.pm"};
  for (size_t query = 0; query < 4; query++) {
    unsigned char packet[512], response[PM_DNS_MAX_RESPONSE];
    size_t packet_length = question(packet, names[query]);
    comparisons = 0;
    size_t length = pm_dns_build_response(state->browser_dns_items, state->browser_dns_index, state->browser_dns_count,
      packet, packet_length, response, sizeof(response));
    assert(length > 0);
    assert((response[3] & 15) == (query == 3 ? 3 : 0));
    printf("%s comparisons=%zu\n", names[query], comparisons);
    if (comparisons > 14) {
      fprintf(stderr, "DNS lookup comparison bound exceeded: %s used %zu, maximum 14\n", names[query], comparisons);
      return 1;
    }
  }
  free(state->browser_dns_index);
  free(state->browser_dns_items);
  free(state);
  return 0;
}

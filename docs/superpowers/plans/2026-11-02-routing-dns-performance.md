# Routing and DNS Performance Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task, with fresh task review and final integration review.

**Goal:** Faster, bounded route/DNS lookup and stable refresh/restart recovery, including TTL-expired routing.

**Architecture:** Retain the current hook/agent/extension boundaries. Add freshness-aware bounded indexed native caches and incarnation-aware coalesced DNS publication; existing connected streams stay independent.

**Tech Stack:** TypeScript/Node 22, native C/pthreads, existing VS Code adapters and test fixtures.

**Spec:** `docs/superpowers/specs/2026-11-02-routing-dns-performance-design.md`, plus `SPEC.MD` routing/DNS clauses.

## Global Constraints

- Native route cache retained allocations, including entry capacity and indexes: at most 16MiB.
- Native DNS maximum 4,096 records; sorted pointer payload at most 32KiB on 64-bit; 1-second DNS response TTL; first normalized duplicate wins.
- Preserve routing network/cwd/Compose/listen/send precedence, durable DNS order, authority fences, replay idempotence and current resource budgets.
- Preserve readable settings folders; no UI changes, user service/configuration mutations, privileged DNS setup or new background poller.
- Diagnostics use the shared dev-log endpoint, not ad hoc native stderr/file logging.
- PM/preload environment must be removed from test launchers; use login:false. No active real daemon replacement or external publication during implementation.

## Review Focus

- Explicit expiry on a warmed cache and same-metadata atomic/in-place changes.
- Duplicate logical/actual ports across networks/directions and cache eviction during concurrent reads.
- DNS duplicates, maximum-size replacement, replay and persistence failure ownership.
- Daemon PID reuse, DNS-only down/up heartbeats, late/disposed acknowledgements and deliberate stop.
- TTL expiry followed by a new server, newest route visibility, active streams, and bounded work during update bursts.

### Task 1: Native route freshness and point lookup

**Files:** `native/hook/portmanager_hook.c`; new `test/unit/native-hook-route-cache-fixture.c` and `.test.ts`; existing native-hook-connect tests/module README as needed; route benchmark script under `scripts/` if reusable.

**Interfaces:** Keep existing lookup/load callers compatible. Add internal immutable logical/actual-port indexes and a lock-scoped point-selection path; preserve caller-owned copies for existing bulk readers. No shared task interfaces.

- [ ] Write/observe RED: warmed explicit TTL expires; same-size/mtime atomic replacement yields new port; fresh rewrite after expiry recovers immediately; preserved-mtime in-place change is visible.
- [ ] Add precedence/reverse lookup and multi-thread replacement/eviction tests; compare correct network/direction against foreign sentinels. A pending sender memory entry must yield to a newer listen route; live process-owned listeners and genuine sender-first reservations remain valid.
- [ ] Implement device/inode/ctime metadata, explicit expiry plus monotonic cap, stable per-port indexes and allocation-free warm point selection. No file I/O while holding cache selection lock. Retained total <=16MiB with LRU eviction/reuse; oversized inputs still resolve safely through uncached reads.
- [ ] Assert hot lookups do not allocate full route arrays, port comparison work is bounded, retained memory stays capped, and a formerly evicted route still resolves.
- [ ] Run fixture tests, existing native connect/registration suites, same 2,048-row/2,000-lookup benchmark; record before/after with limitations. Commit only task files.

### Task 2: Native DNS immutable lookup index

**Files:** `native/agent/portmanager_agent_dns.c`, `portmanager_agent.h`, publication lane files as needed; `test/unit/native-agent-dns.test.ts`; native module README/benchmark fixture as needed.

**Interfaces:** Existing record array and persisted ordering stay unchanged. Index lifecycle travels with the existing immutable DNS publication snapshot and UDP worker. No task-1 dependencies.

- [ ] Add/observe RED with first duplicate (case/trailing-dot variants), first/middle/last/missing at 4,096 rows, row 4,097 excluded, replace/empty/replay/restart cases. Add a deterministic comparison bound or fixture benchmark that distinguishes the linear implementation.
- [ ] Build a sorted pointer index after record allocation stops, compare hostname then original row order, lower-bound lookup; construct on publication lane before persistence, count index bytes against lane limits, swap/free index and records together. Preserve old table on failed publication and allow linear startup fallback only if index allocation fails.
- [ ] Run actual daemon Unix+UDP tests including concurrent queries/replacement, native build, and before/after microbenchmark. Commit only task files.

### Task 3: DNS lifecycle, acknowledgement and coalescing

**Files:** `src/extension/browser-dns-sync-coordinator.ts`, `local-agent-client.ts`, `network-service.ts`, optional shared result type, existing coordinator/network-browser-refresh tests and client lifecycle tests.

**Interfaces:** Extend local DNS sync result with optional `suspended` if needed to signal deliberate stop without string matching or protocol break. Batch/send identity must distinguish PID+startedAt and desired revision; retain record+revision wire format and authority fencing.

- [ ] Add/observe RED for PID reuse with changed startedAt; newer responder-down status triggers replay; DNS-only health heartbeat emits an event; stale-incarnation diagnostics/acknowledgements are ignored.
- [ ] Add/observe RED for 20 identical enqueues during a gated send producing only one successful RPC, newer incarnation/revision not being dropped, success/error after dispose, and deliberate stop not resurrected by retry.
- [ ] Capture acknowledgement provenance per attempt, use incarnation-aware dedup and current DNS health, include DNS health in client snapshot signature, coalesce identical active work and fence disposal. Drop/suspend background DNS retries while deliberately stopped; explicit start/restart publishes current records.
- [ ] Run coordinator, browser refresh, local client/agent lifecycle and Node/native DNS restart suites. Commit only task files.

### Task 4: Integration and measured completion

- [ ] Run end-to-end TTL expiry/rewrite/restart and concurrent route/DNS update scenarios; preserve active TCP/HTTP/SSE and foreign-network rejection. Extend an existing fixture only where coverage is missing.
- [ ] Native build/verification, focused+broader regression suite, comparable lookup timings, resource/call-count evidence and final review.
- [ ] Update `SPEC.MD`, module README and changelog with actual behavior and measured scope. Record results and any verified baseline environment limitations below; do not infer universal speedups from microbenchmarks.

## Progress

- Baseline branch: `perf/routing-dns-refresh` from `46de6d6`, clean before this plan/spec.
- Investigation completed: native expiry/atomic replacement probes return stale port; route microbenchmark 256.277ms/2,000 lookups, 2,465,792 copied bytes each. DNS benchmark medians and lifecycle reproductions are in the design document.
- Ruling: use existing shared checkout feature branch for this coordinated work; implementation tasks run serially, each with scoped review, avoiding shared build/output conflicts.

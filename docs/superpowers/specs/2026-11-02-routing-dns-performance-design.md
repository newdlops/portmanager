# Routing and DNS refresh performance

## Intent

Improve route discovery speed and bounded resource use while preserving active connections and network isolation. Route and DNS updates must become visible after TTL expiry, atomic publication, server replacement, responder failure and daemon restart.

## Evidence

- Current native route cache returns port 40000 after the document's explicit expiry; a same-size/same-mtime atomic replacement with port 41000 also returns 40000. Reproducer: `/private/tmp/pm-route-cache-probe.c`.
- A warm 2,048-row table, 2,000 last-row lookups, copies 2,465,792 bytes per lookup and takes 256.277ms on this workstation. This is a lookup microbenchmark, not network latency.
- Native DNS scans up to 4,096 records under its records mutex. Measured medians: uniform hit 7.62µs, miss 15.29µs. A sorted pointer index measured 143ns/96ns respectively; these exclude UDP and scheduling.
- DNS acknowledgement dedup uses PID without startedAt, ignores newer responder-down status, and the client snapshot signature omits DNS running/port/error. Identical in-flight pushes duplicate work, and callbacks can run after coordinator disposal.

## Approach

Keep the existing route files, authority fences, native hook, daemon and lifecycle APIs. Strengthen freshness and add small immutable indexes at their current boundaries. Extending TTLs would hide stale routing and is rejected. Adding per-request daemon queries or a new watcher/service would increase work and is rejected. A sorted DNS index is selected over hashing for deterministic logarithmic comparisons and simple duplicate ordering.

## Requirements

- Cached route hits obey explicit expiry and legacy mtime TTL; reads do not renew deadlines. A monotonic remaining-lifetime cap prevents a warm cache from extending validity after wall-clock rollback.
- Cache file identity includes device/inode and high-resolution metadata, so atomic replacement is visible even with identical size/mtime.
- Warm point lookups allocate/copy no full route array. Use stable per-port ordering for logarithmic range selection, preserving listen/send, network/cwd and Compose precedence, including duplicate rows and reverse lookup.
- A cached pending sender reservation cannot mask a newer authoritative listen route after server restart. Preserve this process's live listener mappings and sender-first behavior when no listen route is published yet.
- Retained native route-cache allocations, including entry capacity, route arrays and indexes, stay within 16MiB. Eviction causes an ordinary fresh read, never a routing failure or cross-network fallback.
- DNS keeps the existing 4,096-record limit, first-normalized-duplicate precedence, 1-second response TTL, durable input order, authority/replay fences and independent publication lane. A sorted immutable pointer index is swapped/freed with its record array; its maximum pointer payload is 32KiB on 64-bit systems and counts against the publication budget.
- DNS acknowledgement/diagnostic provenance uses PID and startedAt. A newer down heartbeat or changed incarnation republishes the latest desired revision; stale/disposed completions do not acknowledge current work.
- Same-table in-flight churn coalesces without delaying a newer revision/incarnation. Preserve bounded backoff and explicit repair flush semantics.
- Background DNS retry must respect an explicitly stopped daemon; explicit start/restart can publish the latest table again.
- Active TCP, HTTP and SSE connections are not torn down or replayed by route refresh. Validate new connections after expiry and server replacement with actual hook/daemon fixtures, including wrong-network sentinels.
- Preserve readable name-based settings from 0.0.8272. Do not change UI, application-specific routing, system DNS/resolver files or user runtime configuration.

## Verification

Reproduce failures before fixes; assert deterministic freshness, identity, lifecycle, allocation/comparison and memory-budget properties. Re-run comparable route/DNS microbenchmarks and label them accurately. Use real Unix/UDP/TCP fixtures for route/DNS replacement, daemon restart, bind recovery and in-flight connection behavior. Run focused tests, broader regressions, native build/verification and a fresh final review. Record any environmental baseline failure separately from changed behavior.

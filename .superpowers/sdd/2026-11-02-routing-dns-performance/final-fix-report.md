# Final fix: same-second DNS health ordering

Base: `3a36d35a9823cbdd6736c408bc5503da450d4035` on `perf/routing-dns-refresh`.

## Finding and implementation

Native `pm_iso_now` uses `%Y-%m-%dT%H:%M:%SZ` (second precision), while the service records successful RPC completion with `Date.now()` (millisecond precision). An acknowledgement at `12:00:00.500` incorrectly outweighed a later responder-down observation serialized as `12:00:00Z`. Runtime diagnostics stayed healthy and queue dedup skipped replay. The next unchanged down heartbeat could update the snapshot timestamp but correctly emitted no content-change event, leaving recovery stranded.

The existing client already applies DNS RPC running/port/error to the same observed snapshot as heartbeat health, with connection-generation, PID+startedAt, stop and disposal fences. The service now treats explicit observed DNS health as canonical instead of comparing its coarse native timestamp to an RPC clock. Same-incarnation RPC fallback and its previous timestamp behavior remain only for legacy snapshots that omit DNS health. The implementation is one extra predicate in `getBrowserDnsRuntimeState`, with mechanism documentation and a module README update. No client protocol, native, UI, poller, user/system configuration, retry/backoff or coordinator changes.

## Regression scope

The real client methods (`syncBrowserDns`, `applySnapshot`, signatures, event queue and snapshot getter), service constructor process-event subscription and DNS coordinator wiring, service runtime/dedup/provenance policies, and real coordinator run together. Only daemon RPC completion, event scheduling, compatibility annotation and unrelated OS-heavy service work are replaced, as in the existing fixture.

The regression replaces the previous year-9999 heartbeat with a controlled real-precision sequence:

1. Initial down heartbeat at `2026-11-02T12:00:00Z`.
2. Successful DNS acknowledgement at `12:00:00.500` without a healthy heartbeat.
3. Later down observation with the same serialized `12:00:00Z` timestamp.
4. Require a second RPC immediately through the process-event subscription, without a registry/proxy event; diagnostics must be down while that request is pending.
5. Inject unchanged down heartbeat at `12:00:01Z`; require no event and no extra RPC, with diagnostics still down.
6. Complete recovery with a new responder port; require healthy diagnostics and the new port. A timestamp-only healthy heartbeat at `12:00:02Z` also remains quiet.

The prior standalone provenance fixture returned a healthy RPC while keeping an explicitly down fake client snapshot forever, which does not model the real client contract. It is now explicitly a legacy unknown-health snapshot fixture; the healthy result and port must still come from the actual send-time incarnation rather than the stale enqueue-time incarnation. Existing PID reuse, stale success/error, stop/start, disposal, coalescing and bounded backoff cases remain in the scoped set.

## RED

All commands use `login:false` and `/private/tmp/pm-clean-run.py` to remove inherited hook/routing environment variables.

Before the production change:

```sh
python3 /private/tmp/pm-clean-run.py npm run compile
python3 /private/tmp/pm-clean-run.py node --test --test-name-pattern='client and service immediately replay' out/test/unit/network-browser-refresh.test.js
```

Compile: exit 0. Regression: **1 test, 0 pass, 1 fail**, exit 1, 576.732792ms. Exact intended assertion:

```text
same-second down observation must replay without registry or proxy activity
1 !== 2
expected: 2
actual: 1
```

## Intermediate verification

After the production predicate and before the legacy fixture adjustment:

```sh
python3 /private/tmp/pm-clean-run.py npm run compile
python3 /private/tmp/pm-clean-run.py node --test out/test/unit/network-browser-refresh.test.js out/test/unit/browser-dns-sync-coordinator.test.js
```

Compile: exit 0. Tests: **34 total, 33 pass, 1 fail**, exit 1, 1073.065458ms. The same-second actual-client regression passed. The only failure was `actual DNS send captures current provenance rather than queued provenance`: explicit fake down snapshot now correctly wins over its healthy fake RPC (`false !== true`). Changed that fixture to omit unknown legacy health as described above, retaining the provenance-sensitive result/port assertions.

## GREEN

After the production change and fixture adjustment:

```sh
python3 /private/tmp/pm-clean-run.py npm run compile
python3 /private/tmp/pm-clean-run.py node --test out/test/unit/network-browser-refresh.test.js out/test/unit/browser-dns-sync-coordinator.test.js out/test/unit/terminal-hook-environment.test.js
```

Compile: exit 0. Tests: **101 total, 101 pass, 0 fail, 0 skipped**, exit 0, 1558.007333ms. Includes actual same-second replay and diagnostics, both healthy/down timestamp-only suppression, legacy fallback/provenance, PID reuse, stale completion, client lifecycle, disposal, manual stop, bounded backoff and coalescing coverage.

Additional scoped lifecycle checks:

```sh
python3 /private/tmp/pm-clean-run.py node --test out/test/unit/network-terminal-client.test.js out/test/unit/control-plane-cold-start.test.js
```

First sandboxed attempt: **6 total, 1 pass, 5 fail**, exit 1, 587.142958ms. Cold start passed; all five terminal fixtures failed because the sandbox rejected Unix socket bind (`listen EPERM`). Affected cases were original-shell preservation after preparation error, original-shell preservation after child exit, stalled preparation cleanup, controller EOF before launch, and terminal menu cancellation.

Reran the exact command with `sandbox_permissions=require_escalated`: **6 total, 6 pass, 0 fail, 0 skipped**, exit 0, 659.808542ms.

`git diff --check`: exit 0. Git occasionally emits an existing `fsmonitor_ipc__send_query` diagnostic in this sandbox, without changing command success or the diff.

## Limits and handoff

- No new full-suite run, reviewer/subagent, native build or native fixture run in this wave, per parent scope. Parent already owns broader baseline evidence and final release verification.
- These tests run real client/service orchestration with a gated RPC boundary, not an actual daemon socket heartbeat race; native second precision was confirmed directly in `native/agent/portmanager_agent_state.c`.
- No version bump, push, packaging or release. Parent must run four-target CI on the exact final release commit with `PM_RUN_NATIVE_E2E=1`.

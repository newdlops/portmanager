# Task 3: DNS lifecycle, acknowledgement and coalescing

Implemented on `perf/routing-dns-refresh`, based on reviewed Task 1/2 at `cd44ae1`.
No native source, native artifacts, UI, user configuration, DNS resolver/system files, or daemon wire format changes.

## Implementation

- `BrowserDnsSyncBatch.daemonIncarnation` carries local PID plus `startedAt` identity. The coordinator's optional `prepare` boundary refreshes that identity at each actual send, including retries of a table queued under an earlier daemon.
- Network service acknowledgements retain the attempt identity rather than reading the response-time PID. Stale-incarnation results cannot acknowledge work or overwrite diagnostics; stale-incarnation errors cannot clear a newer acknowledgement.
- Queue dedup requires both revision/records and incarnation, and uses current runtime DNS health. A changed daemon incarnation or newer responder-down heartbeat permits replay. Timestamp-only healthy heartbeats leave the acknowledgement intact.
- Last-sync diagnostics are used only for the same incarnation, and only until a newer daemon heartbeat supersedes the response. Recovery notifications compare the previous current runtime health, so a prior healthy response cannot hide a more recent down-to-up recovery.
- Every process-service content-change event reconciles DNS, including worker windows without a proxy ownership lease. The client content signature now includes DNS running, port and error, retaining timestamp-only event suppression.
- Identical active work coalesces; changed desired revision/incarnation remains eligible. Backoff still caps at the existing effective 3200ms sequence, newer work bypasses old backoff, fence retry/replace/drop, explicit flush, single flight and settlement-edge handoff remain covered.
- Both post-await success and error paths return immediately after disposal, before callbacks or retry queue mutation.
- `LocalAgentClient.syncBrowserDns` checks the existing stop/dispose state before entering auto-starting `request()`, returning a local optional `suspended` result. The coordinator drops this attempt without another timer. Initial automatic reconnect remains enabled; explicit start/restart can emit current daemon status and republish current shared-state records. Other explicit requests retain existing lifecycle behavior.
- Updated `src/extension/README.MD`; no new modules or abstractions beyond these local lifecycle fields and optional preparation callback.

## RED evidence

Commands used `login:false` and `python3 /private/tmp/pm-clean-run.py` to scrub inherited hook/routing environment.

Initial compile (new regression tests, original production implementation):

```sh
python3 /private/tmp/pm-clean-run.py npm run compile
python3 /private/tmp/pm-clean-run.py node --test out/test/unit/browser-dns-sync-coordinator.test.js out/test/unit/network-browser-refresh.test.js
```

Compile exit 0. Tests: **24 total, 15 pass, 9 fail**, exit 1, with the intended behavioral failures:

- Twenty identical active enqueues: sent `[A, A]`, expected `[A]`.
- Post-dispose success callback: `[result]`, expected no callbacks.
- Post-dispose error callback: `[error]`, expected no callbacks.
- Suspended result: one retry timer, expected zero.
- PID reuse/diagnostics: running true from old incarnation, expected false.
- Newer down heartbeat: zero replay enqueues, expected one.
- Stale adapter completion: old response made current runtime healthy, expected false.
- DNS-only heartbeat content: one event, expected four for initial/running/port/error changes.
- Deliberate stop: second DNS request entered the auto-start boundary, expected only the initial request.

A follow-up recovery-event test first failed before changing the health comparison:

```sh
python3 /private/tmp/pm-clean-run.py node --test --test-name-pattern='successful DNS recovery' out/test/unit/network-browser-refresh.test.js
```

**1 test, 1 fail**, exit 1: event count 1 vs expected 2. The fix compares effective runtime health before recording the new result. The fixture uses a controlled clock (no sleeps).

Additional coverage characterizes new-incarnation active work and backoff bypass, actual constructor wiring, and attempt-time provenance. Targeted mutation checks temporarily removed each respective production behavior, ran the AST-extracted actual wiring, observed the expected failure, and restored the exact original source in `finally`:

```sh
python3 /private/tmp/pm-clean-run.py node --test --test-name-pattern='actual DNS send wiring.*stale error' out/test/unit/network-browser-refresh.test.js
python3 /private/tmp/pm-clean-run.py node --test --test-name-pattern='actual DNS send captures current provenance' out/test/unit/network-browser-refresh.test.js
```

- Removing stale-error provenance guard: **1 test, 1 fail**, exit 1, stale error caused one redundant enqueue instead of zero (cleared current acknowledgement).
- Removing send preparation: **1 test, 1 fail**, exit 1, running false instead of true (queued old identity incorrectly used for a current successful attempt).

A temporary test-only TypeScript cast error was encountered while adding the actual-wiring fixture (`TS2352`); replaced the fixture's coordinator-method boundary directly. Subsequent compile exited 0. No production workaround was needed.

## GREEN verification

After implementation, compile exited 0:

```sh
python3 /private/tmp/pm-clean-run.py npm run compile
```

Focused acceptance:

```sh
python3 /private/tmp/pm-clean-run.py node --test out/test/unit/browser-dns-sync-coordinator.test.js out/test/unit/network-browser-refresh.test.js
```

**29 tests, 29 pass, 0 fail, 0 skipped**, exit 0, about 1.26s.

Scoped regression (run outside sandbox after environment restrictions appeared):

```sh
python3 /private/tmp/pm-clean-run.py node --test out/test/unit/browser-dns-sync-coordinator.test.js out/test/unit/network-browser-refresh.test.js out/test/unit/control-plane-cold-start.test.js out/test/unit/terminal-hook-environment.test.js out/test/unit/guarded-terminal-startup.test.js out/test/unit/node-agent-dns.test.js out/test/unit/native-agent-dns.test.js
```

**126 tests, 126 pass, 0 fail, 0 skipped**, exit 0, 7716ms. Includes:

- Coordinator active coalescing, latest revision/incarnation, bounded backoff, flush, fence rejection, settlement edge, disposal and suspension.
- Browser refresh/client lifecycle actual-method and constructor-wiring tests.
- Cold-start and client/guarded terminal lifecycle regressions.
- Node DNS revision fences, sidecar/restart restore, persistence failure and same-revision bind recovery.
- Native DNS restart, revision/authority fences, persistence and bind recovery, concurrent publication, independent DNS worker and 4096-record/index boundary coverage using existing Task 1/2 native binaries.

The first sandboxed attempt of the same scoped command could not execute the guarded sandbox fixture (`sandbox-exec: sandbox_apply: Operation not permitted`, exit 71) and native fixtures skipped on Unix socket bind restrictions. Re-ran the complete scoped command with escalation, which produced the 126/126 result above. Cancelled the obsolete sandboxed process after its repeated Unix-bind skips. These are environment restrictions, not claimed passing tests.

`git diff --check`: exit 0 before commit.

## Limits and handoff

- Stale-completion fixtures deliberately control the adapter boundary. Production transport already rejects old-socket RPCs on close. This report does **not** claim a successful delayed old-socket response race was reproduced in production transport; provenance fencing remains defensive and tested for both result/error paths.
- During first connection, pre-request status can still be the disconnected incarnation; a later real daemon status event invalidates that identity and permits a conservative replay. It cannot acknowledge a different current incarnation.
- No new poller, privileged DNS action, wire-field change, enlarged timing budget, native build, package, push or publish was performed.
- Per parent scope, no full-suite run or new reviewer agent. Root owns fresh committed-diff review, final integration/release and any broader validation.

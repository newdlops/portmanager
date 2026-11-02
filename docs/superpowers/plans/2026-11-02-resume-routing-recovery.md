# Resume routing recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover routing automatically when a new extension host attaches to an already-running daemon after an absence.

**Architecture:** Keep the existing daemon lifecycle and independent DNS/proxy lanes. Require one authoritative routing repair per network-service lifetime, including when an early DNS push already connected the client. Successful transition repair satisfies the requirement; failed repair leaves it pending for the next convergence pass.

**Tech Stack:** TypeScript, Node test runner, native daemon Unix/UDP/TCP fixtures.

**Spec:** `docs/superpowers/specs/2026-11-02-routing-dns-performance-design.md`, clarified by the user's report that both extension reactivation and VS Code restart can fail with name-resolution or connection errors despite unchanged loopback addresses.

## Global constraints

- Preserve stable loopback addresses, authority fences, daemon lifecycle APIs and active connections.
- Do not modify system resolver files, hosts, Keychain or live user processes during diagnosis/tests.
- Do not add scans to every background convergence or duplicate transition/manual repair scans.
- A policy regression is evidence of a recovery gap, not proof that every reported DNS failure has the same cause.

## Review focus

- DNS connects first; daemon looks current but the first snapshot has no routes.
- A daemon transition already repaired routing; startup must not scan twice.
- Repair fails once; automatic convergence retries and gates its continuation.
- Explicit repair defers scanning to its existing forced-publication step.
- New service instances recover independently; warm passes remain cheap.

### Task 1: Restore authoritative routing on extension resume

**Files:** `src/extension/network-service.ts`, `src/extension/README.MD`, `test/unit/network-browser-refresh.test.ts`, native recovery fixture coverage as needed.

**Interfaces:** Existing `ensureCurrentProcessDaemon`, `convergeDaemonLifecycle`, `PortManagerProcessService.repairRoutingState`. No public API changes.

- [x] Add behavioral regression tests using actual orchestration methods and lifecycle helper, observe startup failure before changing production code.
- [x] Add per-service pending recovery state; clear only after a successful authoritative publication, reusing lifecycle transition repair.
- [x] Verify already-connected, disconnected, stale-build, retry, deferred repair and repeated warm passes.
- [x] Exercise isolated real native DNS and routing recovery, with unchanged addresses and no manual repair command; report exact limits of this fixture.
- [x] Run compile, focused lifecycle/DNS/routing tests, broader suite and a fresh whole-change review. Document results and commit the fix.

## Execution rulings

- Continue inline in the existing checkout on `fix/resume-routing-recovery`; earlier session workspace preference and authorization persist. No additional worktree or design approval is needed for this missing recovery case.
- The current live daemon and system DNS are healthy in read-only checks. Preserve them; use isolated fixtures to reproduce the skipped recovery path.
- Carry the user's earlier version/commit/push/publish instruction through this follow-up fix after verification. Publish only exact artifacts from one successful four-target CI run, following `PUBLISHING.MD`.

## Verification evidence

- Before production changes, five selected behavior tests produced four expected failures (missing first repair/retry) and one passing existing transition case.
- Compile passed. Focused lifecycle, browser refresh, DNS coordination/verifier/drift, native DNS and terminal-hook tests: 138 passed, zero failures/skips.
- After final review wording/fixture corrections: browser refresh, cold-owner lifecycle and native DNS tests: 45 passed, zero failures/skips.
- Fresh review found no Critical or Important issues. Its scope clarification is reflected in README/test names: readiness gates this convergence continuation; other existing DNS/proxy event callbacks remain independent.
- Native resume fixture creates two fresh orchestration instances against the same live isolated daemon/backend, writes an expired shard, seeds unchanged DNS records first, then requires one automatic repair and fresh publication. It checks real UDP DNS and TCP to the repaired backend port. It does not launch VS Code, exercise browser proxy forwarding, change macOS resolver files or reproduce an hours-long OS resolver failure.
- Read-only checks before/after tests found the actual user daemon and current OS DNS healthy; no production repair or system configuration mutation was performed.
- Full local run: 980 tests, 963 passed, eight process-sampling failures, nine opt-in skips. All eight failures reproduced alone with the inherited `~/.portmanager/runtime-shims/ps`; removing PM shim directories from the test-only PATH made all eight pass without changing their source or implementation. Release CI runs the full suite on fresh native runners with opt-in integration enabled.

### Task 2: Release the verified recovery fix

- [ ] Commit the recovery change, tests and documentation separately from release metadata.
- [ ] Bump package/lock/changelog to `0.0.8274`, compile and build/verify native runtime for the new embedded version.
- [ ] Push the release commit and dispatch the four native targets at that exact commit. Require successful unit/native and fresh-profile activation checks on every target.
- [ ] Download, verify and publish those four VSIX files unchanged. Confirm Marketplace validation and fresh-profile install, and report the limits of the recovery evidence.

## Release validation follow-up

The first release run (`41387571125`, commit `a17c32d`) passed both Linux targets and the new recovery tests on both macOS targets. macOS ARM failed an unchanged native TCP fixture's FD count after its fixed 450ms cleanup sleep; macOS Intel failed an unchanged HTTP test's proxy-listener preparation before its timeout scenario began. Neither failure is evidence that the new recovery behavior failed.

The native cleanup race was reproduced deterministically by extending the fake shared DNS operation to 700ms: the old fixture checked while its two pipe descriptors were still owned. The test now waits up to 1500ms for the actual DNS-job release fence under its mutex, asserts completion explicitly, and retains the original caller deadline and zero-FD checks. This changes only tests, not native product behavior. Focused coverage after the change: 47 passed, zero failures/skips; fresh review found no Critical/Important issues. Revalidate all four packages at the final commit before release; do not publish artifacts from the failed run.

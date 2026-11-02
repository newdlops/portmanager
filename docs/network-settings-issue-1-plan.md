# Issue 1: editable network settings and legacy migration notices

The remaining issue is silent edits to inactive legacy settings, missing editor/folder commands, and unverified `UV_ENV_FILE` behavior. Preserve the readable name folders, private ID ownership, duplicate-name safety, original files and user-selected settings.

## Visible behavior

- Existing VS Code native UI: three Command Palette and network context actions open the environment overlay, dotenv substitute, or owned folder. Network choices show IDs; workspace choices show full paths. Cancel and empty/remote workspace states are explicit and cause no filesystem writes.
- Scaffold returns legacy migration notices for sources owned unambiguously by that network. Attach displays an actionable nonmodal warning naming inactive and active paths. Original bytes are preserved. Repeated identical notices are suppressed in the extension host; metadata changes re-notify. Receipts preserve discovery after network rename.
- Do not silently merge later legacy edits into active credentials. Do not infer ownership from names where receipts/registry are ambiguous. Preserve symlink and private file checks.
- Verify real hardened uv with distinct root dotenv, namespace dotenv and overlay values. Document the observed precedence and direct users to the overlay for values consumed before a hooked child starts; no uv-specific runtime policy in generic file adapters.

## Work and verification

1. Add failing behavioral tests for initial notices, edited legacy files, rename/ownership safety, notification dedup/actions and open-resource selection.
2. Implement at existing scaffold/VS Code boundaries. Add the three commands/menu contributions and explain migration in README/module docs/spec/changelog.
3. Run unit/native regressions, real uv precedence fixture and actual VS Code interaction/visual checks where tooling supports it. Native commands have no web route/mobile layout; inspect desktop native UI and long/duplicate names.
4. Commit, version and release using PUBLISHING.MD: all four native CI targets at one final SHA, exact verified artifacts, public validation and temporary-profile installation.
5. Audit issue requirements against delivered evidence, post the resolution and close issue #1 only after the remaining behavior is verified.

No new dependencies, destructive legacy edits, app-specific native behavior or new visual design system.

## Evidence so far

- RED: scaffold returned no legacy diagnostics; opening settings behavior was absent. GREEN: focused settings/terminal tests 90/90 before later edge-case additions.
- Real hardened uv 0.13.1/Python fixture passed on macOS ARM: inherited root value vs mirrored file, then overlay wins; source unchanged. Permanent opt-in regression accepts explicit local uv/Python paths, runs offline and verifies the hardened signature.
- Isolated installed VSIX validation passed with actual VS Code commands, duplicate Korean names, existing file preservation and Explorer reveal. Profile `/private/tmp/pm-vsix-D0qiyu`, log `/private/tmp/pm-issue1-packaged-ui.log`; shared daemon socket identity was checked unchanged by the runner.
- CUA selected another actively used Code window; its action was rejected because the user changed the app. No user project/window was modified. Visual signoff is not claimed; actual native command functional checks are separate evidence.
- Exclude `.superpowers/**` from VSIX so internal execution scratch/previous reports do not ship; no tracked reports are deleted.
- Review of ownership and error paths: source notices follow private ID receipts across rename, never claim another ID's receipt, reject ambiguous unclaimed names and symlink/special-file sources. The notification boundary catches editor/disposal failures and holds at most 256 source signatures. Explicit dotenv creation uses the existing private atomic publish-without-replacement helper.
- Local full-run failures so far were in unchanged fixtures: CLI read `tty-denial.json` after creation but before its write completed; publication fixture exceeded daemon readiness deadline. Both passed their isolated reruns without code changes. Final release remains gated on clean four-target CI.

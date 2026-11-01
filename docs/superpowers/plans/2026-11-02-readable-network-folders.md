# Readable Network Folders Implementation Plan

**Goal:** Store local network settings in folders named for the network, preserving Korean and spaces instead of encoding IDs in folder names.

**Architecture:** `.portmanager/namespaces/<name>/` contains `environment.env`, `files/`, and a private `.network-id` ownership marker. Names select readable locations; stable IDs only identify ownership and routing. Duplicate or filesystem-equivalent names receive readable numeric suffixes. The scaffold migrates existing ID folders by moving them, preserving settings; native readers and the sandbox resolve the same owned directory.

**Tech Stack:** TypeScript, Node filesystem adapters, native C hook, macOS sandbox.

## Design decisions

- Keep the current `namespaces` layout; only its opaque leaf changes. This avoids two new settings layouts and keeps environment and replacement files together.
- Preserve ordinary Unicode and spaces; percent-escape path separators, percent signs, controls, and filesystem-reserved characters. Bound UTF-8 bytes without cutting a character.
- Use `name (2)`, `name (3)` for collisions, never an ID/hash suffix.
- Preserve existing settings on upgrade and rename. Detect symlinks, ambiguous ownership and unsafe metadata rather than selecting someone else's files.
- Native startup resolves the namespace by its private marker, so spoofed environment names cannot select another network. Routing IDs and controller credential keys remain internal identifiers.
- Do not change UI or add commands as a substitute for readable folder names.

## Review focus

- Duplicate names, case/Unicode aliases and reserved characters must not merge settings.
- Migration must not lose environment, nested files or state symlink windows.
- Renaming must move existing values and keep the same owner.
- Native readers and guarded terminals must open the named namespace and reject foreign/symlink storage.
- Concurrent attaches must not leave partial ownership markers or overwrite completed settings.

## Tasks

- [x] 1. Add failing scaffold/native tests for readable Unicode names, numeric collisions, ID migration and rename.
- [x] 2. Implement named namespace ownership, allocation and migration in `network-file-scaffold.ts`; keep `network-identity.ts` for internal IDs only.
- [x] 3. Resolve named namespaces in the native hook and validate sandbox ownership; update dependent fixtures.
- [x] 4. Update module documentation, product instructions, README and changelog with the actual readable layout.
- [x] 5. Compile, run focused and broader regressions, build native artifacts, review the diff and verify the requested end state.

## Progress

- Baseline: clean checkout; TypeScript compile and existing scaffold tests (6/6) passed in this session.
- Implementation proceeds in the shared checkout on a feature branch, without publishing or changing user settings outside test fixtures.
- Verified RED→GREEN for readable names, migration/rename, interrupted move repair, long portable names, foreign ownership, lock interruption/race, and guarded metadata writes.
- Fresh review found marker-write authority and stale-lock recovery races. Fixed metadata writes/replacement/hardlinks/root mutation with actual sandbox probes. Fixed lock publication atomically; stale locks fail explicitly instead of deleting a possibly active successor's lock.
- Verification: TypeScript compile passed; final focused regressions 29/29 passed (scaffold, native file readers, kernel policy, guarded startup/runtime/recovery). Concurrent subprocess attaches select one readable folder per owner. Native build and verification passed for all 13 darwin-arm64 artifacts; `git diff --check` passed.
- Broad regression run: 934 tests, 918 pass, 9 skipped, 7 fail. One policy test ran before its fix and subsequently passed in the final focused run. The remaining six process-sampling failures also reproduce with the original HEAD test and sampler implementation in a temporary directory (that isolated baseline had eight process-visibility failures). Those unchanged sampler tests are outside this feature; no unrelated sampler edits made.
- Completion audit: normal names including Korean/spaces are directory leaves; duplicates receive numeric suffixes; no unattached lookup derives a storage path from an ID; existing ID data moves intact; owner markers resolve native and guarded reads; ID encoding remains only for internal auth and recognizing old folders during migration. Restart existing workloads after migration to refresh cached paths/policies.
- Integration: changes remain uncommitted on `fix/readable-network-folders`; no merge, push, PR, issue comment, installation or publication performed.

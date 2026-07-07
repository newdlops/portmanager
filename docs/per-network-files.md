# Per-network file substitution (`.portmanager/files/<network>/…`)

> **The rule.** When a per-network counterpart of a file exists under
> `.portmanager`, a hooked process talks **only** to that counterpart — the
> original is never read (or written). And process-private **state files are
> split automatically, with no user intervention**: a `.pid`/`.lock`/`.log`
> (or dot-directory) file the process creates lands in the mirror, with a
> symlink window left at the original so unhooked tools still see content.

## Layout

The substitute mirrors the original path, keyed by network name (network id
when the network has no name; `/` in names maps to `-`):

```
<root>/config.json                                # original
<root>/.portmanager/files/alphac/config.json      # what network "alphac" opens
<root>/.env                                       # original
<root>/.portmanager/files/alphac/.env             # full .env replacement for "alphac"
```

`<root>` is the nearest ancestor of the process working directory that
contains a `.portmanager` directory (resolved once at process start). The
`files/<network>/` directory is scaffolded automatically whenever anything
attaches to the network — a window binding or a per-terminal attach script —
and the app's root `.env` (when present) is **auto-split**: a copy is seeded as
`files/<network>/.env`, identical at copy time, so each network starts on its
own independent file.

## Semantics

- **Exclusive**: the substitute replaces the original completely — this is not
  an overlay. With a substitute `.env`, dotenv loads only its contents;
  original-only keys never appear.
- **All open modes**: writes and appends land in the substitute too; the
  original is left untouched.
- **dotenv copy-up (zero intervention)**: the first touch of a `.env`/`.env.*`
  file materializes this network's own copy in the mirror (bytes of the shared
  original) and serves it — every read AND write from then on lands in
  `.portmanager`; the original is never read or written again by hooked
  processes. Each network copies up independently from the original.
- **Automatic state split (zero intervention)**: an `O_CREAT` open of a
  genuinely NEW file is redirected into the mirror (parents auto-created) when
  it looks like process-private state by ecosystem convention — inside a
  dot-directory (`.celery/…`), a dotfile, an extension-less file
  (`celerybeat-schedule`), or suffixed `.pid`/`.lock`/`.log`/`.sock`/`.tmp`/
  `.state`/`.db`/`.sqlite*`. `unlink` follows the same mapping, so pidfile
  cleanup hits the mirror. New files with a source-style extension
  (`.py`, `.ts`, …) stay at the original path — a hooked `git checkout` or a
  code generator must keep producing real worktree files, not mirror links.
- **Read-side scoping**: a state path with no mirror file still resolves in the
  network's own mirror (a clean ENOENT) when the original is absent or a
  window, so another network's state never leaks through reads — and `unlink`
  behaves the same way, never removing another network's window.
- **Observation follows the caller's network**: `tail` and `cat` resolve
  through a PATH trampoline that gives them a hooked exec boundary, where argv
  tokens naming a file whose mirror exists (including `--flag=path` forms) are
  rewritten to the caller's mirror path. `tail -f .celery/celery.log` in an
  attached terminal therefore follows THAT terminal's network — each terminal
  sees its own namespace, even though tail itself is an unhooked SIP binary.
- **Symlink window**: when a state file is created in the mirror, a symlink is
  left at the original path so remaining unhooked observers (Finder, editors,
  exists-probes) still see content. With several networks the window tracks
  the most recently started one; each network's own processes — and shimmed
  tail/cat — always resolve their own mirror. A pre-existing REAL file at the
  original is never replaced — remove stale shared state once (e.g. old
  `.celery/*.log`) and the window forms on the next create.
- **Never mirrored**: background infrastructure (`.git`, `node_modules`,
  `.venv`, `venv`, `__pycache__`), pre-existing real files (committed locks
  like `yarn.lock` keep updating in place), and plain new files (generated
  source stays at the original path).
- **Fail-safe**: no network id, hook disabled, paths outside `<root>`, or
  anything already under `.portmanager/` → untouched. Opt-out:
  `PORT_MANAGER_FILE_SUBSTITUTION=0`.

## Relation to the per-network env file

[`.portmanager/env/<network>.env`](per-network-env.md) is the **overlay** tool:
injected values win, everything else stays. `files/<network>/…` is the
**replacement** tool: the whole file is swapped. Use the env file for a few
per-network values; use a substitute when the process must not see the
original at all.

## Limits

- Only `open`/`openat`/`unlink`/`unlinkat` are interposed (`AT_FDCWD` or
  absolute paths; exotic dirfd bases pass through; `rename` is not interposed —
  a renamed mirror file keeps working through its moved symlink window, but
  the mirror-side name goes stale). Runtimes that call libc `open` cross-image
  — CPython, Node, Ruby — are covered; a C program calling `fopen` may resolve
  inside libc and bypass the interpose.
- `stat`/existence probes see the original path; for auto-split state files the
  symlink window keeps those probes truthful. For hand-made substitutes of
  files that never get created, the **original must exist** (content is
  replaced, not existence).
- Paths containing `..` segments are left alone.
- Unhooked processes (SIP shells, escaped trees) see the original path — for
  auto-split state that means the symlink window (most recently started
  network), and for hand-made substitutes the untouched original.

## Source map

| Concern | Location |
|---------|----------|
| Substitution (open boundary) | `native/hook/portmanager_hook.c` (`pm_file_substitution_init`, `pm_file_substitution_target`, `pm_substitute_open_hook`, `pm_substitute_openat_hook`) |
| Scaffold on attach | `src/extension/terminal-hook-environment.ts` (`ensureNetworkEnvFileScaffold`, `ensureLocalGitExclude`) |
| Related | [per-network-env.md](per-network-env.md) — env value overlay; [per-network-hostname.md](per-network-hostname.md) — identity |

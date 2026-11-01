# Per-network environment file (`.portmanager/namespaces/<network-name>/environment.env`)

> **What it does.** A hooked process attached to logical network `<name>` looks
> for its owned `.portmanager/namespaces/<network-name>/environment.env` from its working directory upward and
> applies the KEY=VALUE lines to its own environment **before `main()` runs** —
> ahead of every runtime's env snapshot (CPython `os.environ`, JVM, Go), and
> with **overwrite** semantics, so the per-network file beats both inherited
> terminal env and the app's own `.env`.

## Why

Routing already lets one `.env` serve every network (localhost URLs are routed
per network at connect()), and [hostname virtualization](per-network-hostname.md)
splits hostname-derived identity. What neither can express is per-network
**values** — a credential path, a bucket name, a feature flag — without
app-specific configuration. The generic supply point is process startup: the
hook dylib's constructor runs before any runtime snapshots its environment, so
a value set there is visible to every runtime with zero app knowledge and zero
app changes.

## Usage

Whenever anything attaches to a network — a VS Code window binding or a
per-terminal attach script — the extension **scaffolds the file automatically**
in each workspace folder — open it and fill in values. `.portmanager/` is
machine-local, so it is added to the repo-local `.git/info/exclude` (the shared
`.gitignore` is never touched; hand-written variants of the entry are
recognized and not duplicated).
Folders use the **network name**, including Korean and spaces. For example,
the `rtcc` network uses this directly editable file:

```
repo/.portmanager/namespaces/rtcc/environment.env
repo/.portmanager/namespaces/rtcc/files/.env
```

Attach the network once to create the folder, then edit `environment.env` for
per-network variables or `files/.env` for a complete replacement dotenv file.
The scaffold never overwrites existing settings. Duplicate or filesystem-equivalent
names use readable suffixes such as `rtcc (2)`. Path separators and reserved
characters are percent-escaped, while ordinary Unicode stays readable; long
names are shortened at a complete Unicode character. A private `.network-id`
marker records ownership so duplicate names cannot select someone else's settings;
`.network-name` records the current display name. Do not edit these markers.

When upgrading from opaque `namespaces/id-<hex>/` folders, the next attach
**moves** the existing folder to its readable name, keeping all saved settings.
A later attach with a renamed network moves the same settings to the new name.
PM's exact state-file observer symlinks are retargeted during these moves.
Restart existing workloads after upgrading/renaming so their cached mirror paths
and any guarded shell policy are rebuilt. There is no ID calculation to perform.

Directories are private (`0700`) and newly published files are private
(`0600`). Publication does not expose a partial file or overwrite another
process's completed copy. Internal identities still reject IDs longer than 124 bytes.

Concurrent attaches serialize through the private `.portmanager/.namespace-lock`
file. If VS Code is killed during an attach, a later attach reports the stale
lock rather than deleting a potentially active successor's lock. After confirming
no attach is running, remove that lock file and retry; partially completed folder
moves retain an ownership marker and move receipt so the retry keeps the settings
and finishes retargeting observer symlinks.

Legacy `.portmanager/env/<name>.env` and `.portmanager/files/<name>/` settings
are copied once when the current network list identifies one owner. Originals
remain in place and are **no longer active settings** after import: edit the
named `namespaces/` folder, not the old `env/` or `files/` tree. A private ownership receipt prevents a deleted name being
automatically imported by a different ID later. If names collide after slash,
case, or Unicode normalization, attach reports the preserved legacy path's
ambiguity. Select the intended values and initialize this ID's
`environment.env` and `files/` explicitly before retrying. Symlinks or special
files also require explicit migration; automatic import never follows them.

Contents are dotenv-shaped:

```sh
# comments and blank lines are fine
GOOGLE_APPLICATION_CREDENTIALS=/repo/credential.alphac.json
export S3_BUCKET="alphac-dev-bucket"
```

The `GOOGLE_APPLICATION_CREDENTIALS` line shows the pattern for config files
whose *path* travels via env (the credential.json class): point the variable at
a per-network file and the app opens the right file by itself — no filesystem
virtualization involved.

## Semantics

- **Precedence**: per-network file > inherited terminal env > the app's own
  `.env`. Injection uses overwrite; dotenv defaults never overwrite an existing
  variable, so the injected value survives `load_dotenv()` while
  non-conflicting `.env` keys still load.
- **Once per process tree**: the marker
  `PORT_MANAGER_NETWORK_ENV_APPLIED=<network-id>` is set alongside the values, so
  children inherit rather than re-apply — a value the app deliberately changes
  mid-tree is not stomped in its children. The shell itself is unhooked and
  marker-free, so every fresh command re-reads the file; edits apply from the
  next launch.
- **Discovery**: nearest owned `.portmanager/namespaces/<network-name>/environment.env`
  from the process cwd upward (64 levels max). The hook checks the private owner
  marker against process identity rather than trusting a display name in env.
- **Format**: `KEY=VALUE` per line, optional `export ` prefix, `#` comments,
  one matching quote pair stripped from the value. No interpolation, no
  multiline values. Keys must be `[A-Za-z_][A-Za-z0-9_]*`.
- **Guardrails**: `PORT_MANAGER_*`, `NEWDLOPS_PM_*`, `PATH`, `BASH_ENV`,
  `DYLD_INSERT_LIBRARIES`, `LD_PRELOAD` are never applied from the file.
- **Fail-safe**: no network id / hook disabled → no-op. Unhooked processes
  (SIP shells themselves, escaped trees) don't receive the values — the usual
  hook coverage boundary.

## Hookless child URL handoff

A separate exec-boundary safeguard covers a common environment handoff race.
A launcher can bind a fixed-port dev server on its network loopback and then
immediately start a protected or deliberately unhooked child with an inherited
URL such as `http://localhost:5173`. The localhost compatibility router is
published asynchronously, so that child's first request can otherwise fail
before the router listener appears.

Before `execve`/`posix_spawn`/`posix_spawnp`, the parent hook rewrites absolute
loopback URLs in the child environment to the actual host and port, but **only**
when the parent already owns an in-memory route for that logical port and the
child keeps the same network id. This is synchronous with the successful bind,
requires no application or port names, and leaves unrelated host URLs alone.
It recognizes `localhost`, `127.0.0.1`, and `[::1]` URL authorities. Disable
only this handoff with `PORT_MANAGER_CHILD_LOOPBACK_URL_REWRITE=0`.
Same-port alias routes are safe whether the child retains the hook or the OS
strips it. A route that also changes the port is handed off only when the child
environment has no Port Manager preload; otherwise the hooked child could
interpret that actual port as a second logical port and route twice.

## Verifying

```sh
# in an attached terminal, with this ID's environment.env present:
python3 -c "import os; print(os.environ.get('S3_BUCKET'))"   # -> alphac-dev-bucket
```

Or enable the dev-log ([dev-logging.md](dev-logging.md)) and look for
`network-env applied file=… keys=N` on the `hook` line.

## Source map

| Concern | Location |
|---------|----------|
| Injection (constructor) | `native/hook/portmanager_hook.c` (`pm_apply_network_env_file`, `pm_network_env_apply_line`, `pm_find_network_env_file`; called from `pm_hook_loaded`) |
| Hookless child URL handoff | `native/hook/portmanager_hook.c` (`pm_rewrite_route_backed_child_environment`, wired into execve/posix_spawn/posix_spawnp) |
| Stable key | `src/core/networks/network-identity.ts`, `native/shared/pm_network_namespace.h` |
| Private scaffold/migration | `src/platform/process/network-file-scaffold.ts` |
| Related | [per-network-hostname.md](per-network-hostname.md) — per-network *identity*; this doc — per-network *values* (overlay); [per-network-files.md](per-network-files.md) — whole-file *replacement* |

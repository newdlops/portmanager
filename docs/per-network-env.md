# Per-network environment file (`.portmanager/env/<network>.env`)

> **What it does.** A hooked process attached to logical network `<name>` looks
> for `.portmanager/env/<name>.env` from its working directory upward and
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
The file is keyed by the network **name** (network id is the fallback key when
a network has no name; names are used verbatim as file names — non-ASCII
works, `/` maps to `-`):

```
repo/.portmanager/env/alphac.env     # applies inside network "alphac"
```

You can also create it by hand anywhere from the app working directory upward;
the scaffold never overwrites an existing file.

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
  `PORT_MANAGER_NETWORK_ENV_APPLIED=<network>` is set alongside the values, so
  children inherit rather than re-apply — a value the app deliberately changes
  mid-tree is not stomped in its children. The shell itself is unhooked and
  marker-free, so every fresh command re-reads the file; edits apply from the
  next launch.
- **Discovery**: nearest `.portmanager/env/<network>.env` from the process cwd
  upward (64 levels max).
- **Format**: `KEY=VALUE` per line, optional `export ` prefix, `#` comments,
  one matching quote pair stripped from the value. No interpolation, no
  multiline values. Keys must be `[A-Za-z_][A-Za-z0-9_]*`.
- **Guardrails**: `PORT_MANAGER_*`, `NEWDLOPS_PM_*`, `PATH`, `BASH_ENV`,
  `DYLD_INSERT_LIBRARIES`, `LD_PRELOAD` are never applied from the file.
- **Fail-safe**: no network id / hook disabled → no-op. Unhooked processes
  (SIP shells themselves, escaped trees) don't receive the values — the usual
  hook coverage boundary.

## Verifying

```sh
# in an attached terminal, with repo/.portmanager/env/<network>.env present:
python3 -c "import os; print(os.environ.get('S3_BUCKET'))"   # -> alphac-dev-bucket
```

Or enable the dev-log ([dev-logging.md](dev-logging.md)) and look for
`network-env applied file=… keys=N` on the `hook` line.

## Source map

| Concern | Location |
|---------|----------|
| Injection (constructor) | `native/hook/portmanager_hook.c` (`pm_apply_network_env_file`, `pm_network_env_apply_line`, `pm_find_network_env_file`; called from `pm_hook_loaded`) |
| Network name delivery | `src/extension/terminal-hook-environment.ts` (`PORT_MANAGER_NETWORK_NAME`) |
| Related | [per-network-hostname.md](per-network-hostname.md) — per-network *identity*; this doc — per-network *values* (overlay); [per-network-files.md](per-network-files.md) — whole-file *replacement* |

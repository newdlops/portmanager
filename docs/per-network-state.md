# Per-network local-state redirection

> **Problem it solves.** Port Manager isolates the *network* — the same repo
> attached to two logical networks reaches each network's own services. But when
> you run the **same working directory** in two networks, the app's *local state*
> collides: celery writes `.celery/celery1.pid` for both, the second worker
> refuses to start ("Pidfile already exists"), unix sockets clash, sqlite locks,
> etc. That's a *filesystem* collision, not a network one — network isolation
> can't touch it because it's literally the same path on one disk.
>
> This feature namespaces declared local-state paths **per network**, inside the
> hook, so the same directory can run in N networks with **zero app changes**.

## How it works

The native hook (`native/hook/portmanager_hook.c`) interposes the path-taking
libc calls — `open`, `openat`, `stat`, `lstat`, `access`, `unlink`, `rename`,
`mkdir` — for hooked processes that carry a network id. When a path falls under
a **configured state root**, the hook rewrites it to insert a per-network
segment and calls the real function with the rewritten path:

```
.celery/celery1.pid   (network alphac)      → .celery/__pmnet__/alphac/celery1.pid
.celery/celery1.pid   (network captainprod) → .celery/__pmnet__/captainprod/celery1.pid
```

Every non-matching path passes through **byte-identical**. The feature is
**opt-in** (no config → total no-op) and **fail-safe** (any error, overflow, or
missing network id → the original path). Redirection is bound to the same master
switch as socket hooking (`PORT_MANAGER_HOOK` / `PORT_MANAGER_HOOK_DISABLED`).

`stat`/`open` stay consistent, so an app's "does my pidfile exist?" check and
its subsequent write both see the same per-network file — which is exactly what
makes celery/uwsgi/etc. start cleanly in each network.

## Configuring it — `.portmanager/state-paths`

Create `.portmanager/state-paths` at the **repo root** (it is committed, so it
travels to every git worktree). One pattern per line; `#` comments allowed:

```
# Directories/files whose subtree is namespaced per network (prefix match):
.celery
tmp/sockets
# Basename globs (fnmatch), bounded to the repo root:
*.pid
*.sock
```

- **Prefix entries** (no glob metacharacters) resolve against the repo root;
  everything at or under them is redirected, with the segment inserted right
  after the matched prefix: `<prefix>/__pmnet__/<network>/…`.
- **Glob entries** (contain `* ? [`) match a file's basename anywhere under the
  repo root, with the segment inserted before the basename:
  `<dir>/__pmnet__/<network>/<file>`.

The network segment is `PORT_MANAGER_NETWORK_NAME` (e.g. `alphac`), sanitized to
`[A-Za-z0-9._-]`; it falls back to the network id when no name is set.

## Delivery (setting → hook)

`src/extension/terminal-hook-environment.ts` reads `.portmanager/state-paths`
from each workspace folder (`readPerNetworkStatePaths`) and injects, for
network-scoped terminals only, three env vars the hook parses:

| Env var | Meaning |
|---------|---------|
| `PORT_MANAGER_PER_NETWORK_STATE_ROOTS` | `:`-joined absolute prefixes |
| `PORT_MANAGER_PER_NETWORK_STATE_GLOBS` | `:`-joined basename globs |
| `PORT_MANAGER_STATE_REPO_ROOT` | repo root that bounds glob matches |

Children of a hooked process inherit these automatically, so workers spawned by
`./zz` etc. redirect consistently. **Reload the window after adding/editing
`.portmanager/state-paths`** so already-running processes pick it up.

## Verifying

With `PORT_MANAGER_DEV_LOG` set (see [dev-logging.md](dev-logging.md)), each
redirect logs `state redirect open <from> -> <to>` on the `hook` line. Or check
the tree directly:

```sh
find .celery -type f          # → .celery/__pmnet__/<network>/celery1.pid per network
lsof -p <worker-pid> | grep .celery
```

## Scope & limits

- macOS covers all eight calls via the DYLD interpose table. Linux (LD_PRELOAD)
  covers `open`/`openat`/`access`/`unlink`/`rename`/`mkdir`; `stat`/`lstat` are
  omitted there (glibc exposes them as `__xstat` inline wrappers).
- `openat` is redirected only for `AT_FDCWD` or absolute paths (a path relative
  to an arbitrary directory fd is not cheaply resolvable).
- Paths are absolutized against the cwd without resolving symlinks or `..`
  (that would change the caller's intended target).
- This isolates *declared* state paths; it is not a full filesystem namespace.
  Declare the specific state locations that must not collide.

## Source map

| Concern | Location |
|---------|----------|
| Hook interposition + rewrite | `native/hook/portmanager_hook.c` (`pm_state_redirect_path`, `pm_*_hook`, interpose table) |
| Config read + env delivery | `src/extension/terminal-hook-environment.ts` (`readPerNetworkStatePaths`, `applyPerNetworkStateEnvironment`) |
| Repo config | `<repo>/.portmanager/state-paths` |

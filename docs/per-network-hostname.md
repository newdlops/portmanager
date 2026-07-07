# Per-network hostname virtualization

> **What it does.** A hooked process attached to a logical network reports the
> **network's loopback address** as its hostname — `gethostname()` and
> `uname().nodename` return `127.93.164.7` instead of the machine's real
> hostname. The shell (bash/sh/zsh) and every child it spawns inherit this, so
> any app that derives its identity from the hostname distinguishes itself per
> network **automatically, with zero application-specific configuration in Port
> Manager.**

## Why

Port Manager already routes the *connection* per network: the in-process hook
rewrites `connect(127.0.0.1/localhost:P)` to the network's own loopback
(`loopbackAddressForNetwork`). That is enough for traffic isolation, but the
process still *believes* it is on `127.0.0.1` / the machine hostname. So every
piece of app **identity** that is derived from the hostname collides when the
same working directory runs in two networks:

- celery's default node name `celery@%h` → both become `celery@<machine>`
- pidfiles / logfiles templated on `%n` / `%h`
- distributed locks, metrics tags, `hostname`-keyed cache entries, …

The clean, generic fix is to make the *hostname itself* per-network. Then the
distinction falls out of standard tooling — no per-app logic in the extension.
This is the generic analogue of what a hand-rolled multi-cluster script does by
passing `--hostname=<cluster>` to every service; Port Manager does it once, at
the syscall layer, for **every** app.

The value is the network's **loopback address** (`loopbackAddressForNetwork`,
e.g. `127.93.164.7`) rather than the network name: it is unique by
construction, always hostname-safe (user-chosen names can be non-ASCII/spacey
and degenerate into collision-prone strings when sanitized), and — being the
address this network's servers bind on — it resolves and connects as-is.

## How it works

`native/hook/portmanager_hook.c` interposes two libc calls for a hooked process
that carries a network id (`PORT_MANAGER_NETWORK_NAME`, else `…_NETWORK_ID`),
gated by the master hook switch (`PORT_MANAGER_HOOK` / `…_HOOK_DISABLED`):

| Call | Behavior |
|------|----------|
| `gethostname(buf, len)` | writes the network's loopback address, returns 0 |
| `uname(buf)` | calls the real `uname`, then overwrites `buf.nodename` |

The value is read from `PORT_MANAGER_NETWORK_LOOPBACK_HOST` (else
`…_ACTUAL_LOOPBACK_HOST`), validated as a non-default `127.x.y.z`. When no
loopback env is delivered, the hook falls back to the network name sanitized to
hostname-safe characters (`[A-Za-z0-9.-]`, others → `-`). With no network id —
or the hook disabled — the **real** hostname passes through unchanged (opt-in,
fail-safe). The lookup uses only `getenv` + string ops (no file I/O, no
interposed calls), so it is safe to call from any thread and arbitrarily early
in process startup.

The env (`PORT_MANAGER_NETWORK_NAME`, `PORT_MANAGER_ACTUAL_LOOPBACK_HOST`, …)
is injected into attached terminals by
`src/extension/terminal-hook-environment.ts`; children inherit it, so a worker
spawned by `./zz` sees the same per-network hostname as its shell.

## Using it from an app (no extension changes)

Because the hostname is now per-network, apps get distinct identity by using
their hostname the ordinary way — Port Manager knows nothing about the app:

```sh
# celery: use the (now per-network) hostname for node name + templated paths.
celery -A app worker \
  -n "worker@%h" \            # -> worker@127.93.164.7 / worker@127.86.20.11
  --pidfile=".celery/%n.pid" \  # -> .celery/worker@127.93.164.7.pid ...
  --logfile=".celery/%n.log"    # -> .celery/worker@127.93.164.7.log ...
# broker/backend can stay amqp://localhost:5672 — the hook routes it per network.
```

Hardcoded literals in **argv** are covered at the exec boundary: for a child
that will run inside a network, the hook rewrites HOST-POSITIONED occurrences
of `localhost` — `@localhost`, `=localhost`, `://localhost`, `localhost:<port>`
— to the network loopback. So an unmodified launcher that pins
`celery multi start … --hostname=localhost` still spawns a worker named
`celery1@127.93.164.7`. A standalone `localhost` token is never touched
(`grep localhost` keeps its meaning, and standalone dial targets are already
routed by the connect() rewrite), nor is a longer hostname label
(`localhost.localdomain`, `mylocalhost`). Opt out with
`PORT_MANAGER_ARGV_LOCALHOST_REWRITE=0`. Literals baked into config **files**
remain the app's own choice — prefer `%h`/`%n` (celery's built-in templates) so
identity tracks the hostname. Per-network **values** (as opposed to identity)
are delivered by the [per-network env file](per-network-env.md).

## Verifying

```sh
# in an attached terminal:
python3 -c "import socket; print(socket.gethostname())"   # -> 127.93.164.7
uname -n                                                   # -> 127.93.164.7

# argv literal rewrite (exec boundary — the parent's hook rewrites the child argv):
python3 -c "import subprocess; subprocess.run(['/bin/echo', 'worker@localhost'])"
#                                                        -> worker@127.93.164.7
```

Or with the dev-log ([dev-logging.md](dev-logging.md)) enabled, connection
rewrites still log on the `hook` line; the hostname is observable directly as
above.

## Scope & limits

- macOS interposes `gethostname`/`uname` via the DYLD table; Linux redefines the
  same symbols (LD_PRELOAD) and resolves the originals with `pm_resolve_symbol`.
- Only the *nodename*/hostname is virtualized — not DNS, not `getaddrinfo`. Name
  resolution and connection routing are handled separately (the connect rewrite).
- The argv rewrite is textual and host-positioned only. Every
  `user@localhost`-shaped identity is rewritten by design — including
  `ssh user@localhost`; dial `127.0.0.1` explicitly to reach a machine-global
  service from inside a network.
- A literal hostname baked into a config **file** (not argv) cannot be
  virtualized; use the hostname templates instead.

## Source map

| Concern | Location |
|---------|----------|
| Hostname interpose | `native/hook/portmanager_hook.c` (`pm_network_hostname`, `pm_gethostname_hook`, `pm_uname_hook`, interpose table) |
| argv localhost rewrite (exec boundary) | `native/hook/portmanager_hook.c` (`pm_rewrite_localhost_argv`, `pm_localhost_occurrence_qualifies`; wired into execve/posix_spawn/posix_spawnp) |
| Loopback address + env names | `src/core/networks/loopback-address.ts` (`loopbackAddressForNetwork`, `*_LOOPBACK_HOST_ENV`) |
| Network name/loopback delivery | `src/extension/terminal-hook-environment.ts` (`PORT_MANAGER_NETWORK_NAME`, `applyLoopbackRoutingHosts`) |

# Per-network hostname virtualization

> **What it does.** A hooked process attached to a logical network reports the
> **network name** as its hostname — `gethostname()` and `uname().nodename`
> return `alphac` / `captainprod` instead of the machine's real hostname. The
> shell (bash/sh/zsh) and every child it spawns inherit this, so any app that
> derives its identity from the hostname distinguishes itself per network
> **automatically, with zero application-specific configuration in Port Manager.**

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

## How it works

`native/hook/portmanager_hook.c` interposes two libc calls for a hooked process
that carries a network id (`PORT_MANAGER_NETWORK_NAME`, else `…_NETWORK_ID`),
gated by the master hook switch (`PORT_MANAGER_HOOK` / `…_HOOK_DISABLED`):

| Call | Behavior |
|------|----------|
| `gethostname(buf, len)` | writes the sanitized network name, returns 0 |
| `uname(buf)` | calls the real `uname`, then overwrites `buf.nodename` |

The value is the network name sanitized to hostname-safe characters
(`[A-Za-z0-9.-]`, others → `-`). With no network id — or the hook disabled — the
**real** hostname passes through unchanged (opt-in, fail-safe). The lookup uses
only `getenv` + string ops (no file I/O, no interposed calls), so it is safe to
call from any thread and arbitrarily early in process startup.

The env (`PORT_MANAGER_NETWORK_NAME`) is injected into attached terminals by
`src/extension/terminal-hook-environment.ts`; children inherit it, so a worker
spawned by `./zz` sees the same per-network hostname as its shell.

## Using it from an app (no extension changes)

Because the hostname is now per-network, apps get distinct identity by using
their hostname the ordinary way — Port Manager knows nothing about the app:

```sh
# celery: use the (now per-network) hostname for node name + templated paths.
celery -A app worker \
  -n "worker@%h" \            # -> worker@alphac / worker@captainprod
  --pidfile=".celery/%n.pid" \  # -> .celery/worker@alphac.pid ...
  --logfile=".celery/%n.log"    # -> .celery/worker@alphac.log ...
# broker/backend can stay amqp://localhost:5672 — the hook routes it per network.
```

Hardcoded literals (e.g. `-n worker@localhost`) are *not* magically rewritten —
a literal string is the app's own choice. Prefer `%h`/`%n` (celery's built-in
templates) so identity tracks the hostname.

## Verifying

```sh
# in an attached terminal:
python3 -c "import socket; print(socket.gethostname())"   # -> alphac
uname -n                                                   # -> alphac
```

Or with the dev-log ([dev-logging.md](dev-logging.md)) enabled, connection
rewrites still log on the `hook` line; the hostname is observable directly as
above.

## Scope & limits

- macOS interposes `gethostname`/`uname` via the DYLD table; Linux redefines the
  same symbols (LD_PRELOAD) and resolves the originals with `pm_resolve_symbol`.
- Only the *nodename*/hostname is virtualized — not DNS, not `getaddrinfo`. Name
  resolution and connection routing are handled separately (the connect rewrite).
- A literal hostname baked into app config/argv cannot be virtualized; use the
  hostname templates instead.

## Source map

| Concern | Location |
|---------|----------|
| Hostname interpose | `native/hook/portmanager_hook.c` (`pm_network_hostname`, `pm_gethostname_hook`, `pm_uname_hook`, interpose table) |
| Network name delivery | `src/extension/terminal-hook-environment.ts` (`PORT_MANAGER_NETWORK_NAME`) |

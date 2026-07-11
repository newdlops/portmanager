# Port Manager development log endpoint

> **TL;DR** — Development logging is disabled by default. Set
> `portManager.developmentLogPath` (or the `PORT_MANAGER_DEV_LOG` env var),
> reload the window, then `tail -f` that file. The native hook, TCP router, and
> agent — plus the extension host — all append their routing/attribution
> decisions to that one file. Logging stops at 64 MiB so a forgotten trace
> cannot slow every routed process or grow without bound. **No rebuild needed
> to turn logging on or off.**

This endpoint exists so we can trace how a connection is attributed and routed
**without** editing C, rebuilding native binaries, and reloading for every probe
— the exact back-and-forth that motivated it. Daemon output (router/agent) that
would otherwise vanish on stderr is captured here too, on one greppable timeline
shared by every component.

## Enabling / disabling

There are two switches; either one turns the endpoint on:

1. **VS Code setting (recommended):** `portManager.developmentLogPath`
   - Default: empty (disabled).
   - Relative paths are kept under the workspace-local `.portmanager/`
     directory; a leading `.portmanager/` is accepted as already scoped.
   - Absolute paths and a leading `~/` are respected.
   - `activate()` copies it into `process.env.PORT_MANAGER_DEV_LOG` **before any
     native child is spawned**, so it propagates to the router/agent/tracker via
     `buildNodeRuntimeEnvironment` (which spreads `process.env`) and to hooked
     terminals via the terminal environment collection.
   - **Reload the window after changing it** — long-lived daemons (the gateway
     router, the agent) only read the env at spawn, so they pick up a change on
     the next reload/respawn.
   - Empty → disabled and clears `PORT_MANAGER_DEV_LOG` for children spawned by
     the extension.

2. **Raw env var:** launch VS Code (or any native binary directly) with
   `PORT_MANAGER_DEV_LOG=/abs/path`. If VS Code normalizes a relative env value,
   it is scoped under workspace `.portmanager/`; standalone native binaries use
   the env value as provided. Useful for standalone runs of
   `portmanager_tcp_router`, `portmanager_agent`, or a hooked shell in tests.

When disabled the logger is a no-op in every component (a single `getenv`
check). When enabled, native and TypeScript writers reject new lines once the
file reaches 64 MiB. Reload after clearing or changing a capped log so all
long-lived components pick up the intended sink.

## Line format

```
HH:MM:SS.mmmuuu [<component> pid=<n>] <message>
```

- Native writers (`pm_dev_log`) emit microsecond precision (`mmmuuu`).
- The TypeScript writer (`devLog`) has millisecond precision and pads to
  `mmm000` to keep the columns aligned.
- `<component>` is one of `hook`, `router`, `agent` (native) or `ts-router`,
  `ts-*` (extension host). `pid` disambiguates interleaved processes.

All writers `open(O_APPEND|O_CREAT)` + size check + one `write()` + `close()` per
line, so concurrent processes/threads interleave by whole lines instead of
corrupting each other, and no descriptor leaks into a hooked child across
`fork`/`exec`.

## What each component logs

| Component | Key lines |
|-----------|-----------|
| `router` (`portmanager_tcp_router`) | `attribute logical_port=… pid=… net=…` (source attribution per accepted connection), `route … -> host:port (forwarding)`, `resolve … -> REFUSE (no route)`, `… CONNECT FAILED`. This is the ground truth for "did the gateway demux this connection to the right per-network backend?" |
| `hook` (`libportmanager_hook`) | Every existing `pm_debug` line is tee'd here — `connect address-only …`, `connect loopback-network …`, `connect blocked by … compose …`, `bind loopback-network …`, route allocation, agent IPC, etc. |
| `agent` (`portmanager_agent`) | `dispatch method=…` for every request except the high-frequency read-only polls (`listSnapshot`/`daemonStatus`/`refreshSnapshot`). |
| `ts-router` (extension host) | `resolve logical_port=… clientPid=… clientNet=… verdictNet=… composeForNet=… composePorts=…` — the TypeScript resolver's verdict, emitted **only when it is actually consulted** (if this line is missing while `router …` lines appear, the router's control channel is bound to a different window's extension host). |

## Reading it

```sh
# follow live
tail -f "$PORT_MANAGER_DEV_LOG"

# just the router's routing decisions for AMQP (port 5672)
grep 'router.*logical_port=5672' "$PORT_MANAGER_DEV_LOG"

# one connection's full story, ordered
grep -E 'logical_port=5672' "$PORT_MANAGER_DEV_LOG" | sort
```

## Extending it

- **New call site in an already-wired binary:** `#include "../shared/pm_dev_log.h"`
  is already present in the hook/router/agent — just call
  `pm_dev_log("<component>", "fmt", …)`. In TypeScript, `import { devLog } from
  "…/platform/dev-log"` and call `devLog("ts-<area>", msg)`.
- **New native binary:** include the header, call `pm_dev_log`, and add
  `native/shared/pm_dev_log.c` to that binary's compile line in
  `scripts/build-native-hook.sh` (see how the router/agent/hook lines link it).
- Guard expensive log-argument construction with `pm_dev_log_enabled()` /
  `devLogEnabled()`.

## Source map

| Concern | File |
|---------|------|
| Native logger | `native/shared/pm_dev_log.{h,c}` |
| TypeScript logger | `src/platform/dev-log.ts` |
| Router instrumentation | `native/router/portmanager_tcp_router.c` (`pm_attribute_connection`, `pm_connection_thread`) |
| Hook instrumentation | `native/hook/portmanager_hook.c` (`pm_debug` tees to the endpoint) |
| Agent instrumentation | `native/agent/portmanager_agent.c` (`pm_dispatch`) |
| Setting → env injection | `src/extension/activate.ts` (`applyDevelopmentLogSetting`) |
| Env → native children | `src/platform/process/node-runtime.ts` (`buildNodeRuntimeEnvironment` spreads `process.env`) |
| Env → hooked terminals | `src/extension/terminal-hook-environment.ts` |
| Build wiring | `scripts/build-native-hook.sh` (`DEV_LOG_SOURCE_FILE`) |
| Setting contribution | `package.json` (`portManager.developmentLogPath`) |

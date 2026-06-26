# Port Manager

Port Manager is shifting from post-conflict port rerouting to logical development networks. The target workflow is to attach a terminal window/session to a named network, keep app-internal ports unchanged, and explicitly expose selected network ports on the host machine.

Example:

```txt
A network: frontend 3004, backend 8004, exposed as localhost:3004
B network: frontend 3004, backend 8004, exposed as localhost:3005
```

The previous managed-process routing, native hook, and rerun-on-failure implementation remains in the repository as deprecated compatibility code. It is hidden from the default sidebar and command surfaces while the logical network model is implemented.

## Target Capabilities

- Discover terminal windows across VS Code and external OS terminals. Initial implementation groups noisy shell processes by VS Code terminal instance, tty, or process group, and uses the terminal window/tab title when available.
- Let the user attach a selected terminal window title to a logical network. With the current proxy runtime this is a logical association; runtime-level isolation requires a stronger adapter.
- Let child processes launched from that terminal inherit the selected network context. This is not supported by the current local proxy adapter.
- Allow multiple networks to reuse the same internal ports when the selected runtime provides isolation.
- Configure explicit host port exposure, such as `localhost:3005 -> B network:3004`. Initial implementation provides a real local TCP proxy.
- Detect host exposure conflicts before exposing a port by actually binding the host listener.
- Keep fixed protocol ports such as SSH, MySQL, and PostgreSQL meaningful inside each logical network.
- Implement real network behavior through runtime adapters such as container runtimes, OS-native network namespaces, privileged helpers, or proxy fallbacks.

## Implemented Logical Network Mode

- Create and remove logical network records.
- Persist logical networks, terminal attachments, and host exposures in VS Code global state.
- Discover VS Code integrated terminals and OS shell processes as grouped Terminal Windows with visible titles.
- Attach a terminal window to a logical network as a persisted association.
- Attach Docker Compose published ports as logical-network service routes by moving selected services into a hidden network-scoped Compose project, so the original host ports become reusable.
- Copy an attached Compose project into another logical network as a separate hidden Compose project, including stopped services so later `docker compose start` or `up` commands keep using the copied project.
- Discover running Docker/Podman services with published ports, group Compose services by project, and attach them from the Compose / Containers sidebar section.
- Start every primary network command from sidebar action rows, not only Command Palette.
- Expose a host TCP port to a target address and port through `Local TCP Proxy`.
- Close proxy listeners when exposures or networks are removed.
- Reopen persisted active exposures when the extension starts.
- Show runtime capabilities so unsupported same-port isolation and terminal attach are explicit.

## Current Compatibility Code

- Start a managed process from the command palette or sidebar.
- Detect whether the requested port is busy.
- Keep logical requested ports unoccupied in hashed routing mode.
- Route to a deterministic available port in the virtual range, or to a nearby port in nearest mode.
- Inject the actual port through `PORT`, `${port}` replacement, or `--port`.
- Inject `PORT_MANAGER_LOGICAL_PORT`, `PORT_MANAGER_ACTUAL_PORT`, `PORT_MANAGER_ROUTES`, and `PORT_MANAGER_ROUTES_FILE`.
- Track requested and actual ports in the sidebar.
- Show daemon status, routing table, managed processes, and OS listeners as separate sidebar accordion sections.
- Start, stop, and inspect the daemon from the sidebar UI as well as the Command Palette.
- Watch all local listening TCP ports through the shared local agent and update the sidebar automatically.
- Show which process owns each visible port when the OS exposes PID/name data.
- Offer daemon-managed routing as soon as a VS Code terminal command explicitly requests a port.
- Inject the native hook into new VS Code terminals so non-fixed protocol bind ports are allocated before bind.
- Install a native shell hook for OS terminals outside VS Code.
- Detect VS Code terminal listen failures and offer to rerun the failed command through Port Manager routing.
- Stop, restart, remove, open, and copy managed process URLs.
- Keep sidebar row clicks as selection only; browser opening is an explicit action.
- Treat routed URLs as live only while the process is running.
- Register an already running process for sidebar management.

These commands and views are no longer the primary product surface. They remain available internally for migration and testing until the logical network runtime adapters replace them.

## Usage

1. Run `npm install`.
2. Run `npm run compile`.
3. Press `F5` in VS Code and choose `Run Port Manager Extension`.
4. In the Extension Development Host, open the Port Manager activity bar view.
5. Use the `Create Logical Network` row in the Logical Networks section.
6. Use the `Add Host Port Exposure` row in the Host Port Exposures section.
7. Use `Refresh Terminal Windows` in the Terminal Windows section.

The current runtime is `Local TCP Proxy`. It provides real host port exposure and records terminal-window attachments, but it does not isolate network namespaces. Same internal ports across A/B apps require a future container, namespace, native-helper, or VM-backed runtime adapter.

## Legacy Routing

By default, Port Manager uses hashed logical routing: a requested port such as `8000` remains the logical port, while the launched process binds to a deterministic actual port in `portManager.virtualPortRangeStart` through `portManager.virtualPortRangeEnd`. Set `portManager.routingMode` to `nearest` to use the older nearby-port behavior.

For new VS Code terminals, Port Manager injects the native socket hook while the daemon is running. When a terminal-launched process calls `bind()` on a port that is not in `portManager.fixedProtocolPorts`, the hook asks the daemon for an actual port before the OS bind happens, then registers the logical route. The explicit `Rerun Routed` prompt and listen-failure monitor remain fallback paths for terminals that were already open or are not running with the hook environment.

For terminals outside VS Code, run `Port Manager: Install Shell Hook` once from the Command Palette, then open a new shell. The hook is sourced from your shell profile and injects the native socket hook into descendant development processes.

```sh
daphne -b 127.0.0.1 -p 8000 myapp.asgi:application
npm run dev
```

When a hooked process calls `bind(8000)`, the hook asks the same per-user daemon to allocate an actual port, rewrites the bind call, and registers the logical route. Fixed protocol ports such as SSH, MySQL, and PostgreSQL are preserved by default because the port number itself is part of the protocol contract. When another hooked local process calls `connect(...:8000)`, the hook reads the daemon route table and redirects the connection to the actual port.

Compose published ports can be attached to a logical network from the sidebar. Refresh the Compose / Containers section to discover running Docker/Podman services, then attach a service or grouped Compose project to a network. Port Manager inspects the original containers, pins their actual volume/bind/tmpfs mounts into a generated Compose override, stops the original services, starts a hidden project whose name is derived from the logical network and original project, and discovers Docker's allocated localhost ports. For example, an original PostgreSQL publish on host `15432` can become logical `15432 -> 127.0.0.1:57001` inside the attached network while host `15432` is free for another local process or for `docker compose up` under the original project name. Removing the attachment stops the hidden services before starting the original services again, so data volumes are not mounted by both projects at the same time.

Copy Compose Attachment creates a second hidden Compose project for the destination network when runtime metadata is available. Services with routes are started, and stopped/no-port services are created in the copied project so later lifecycle commands do not fall back to the source project.

## Local Agent

Port Manager starts after VS Code startup and connects to a single local agent.

The agent listens on a per-user local socket or named pipe. If no agent is running, the first VS Code window starts one. Additional VS Code windows connect to the same agent and receive the same port snapshot. While a VS Code client is attached, the daemon rescans the OS listening table periodically so stopped external processes disappear without a manual refresh.

The sidebar shows:

- daemon status, PID, listener count, route count, and route table file
- active logical routing table rows
- managed processes launched by Port Manager
- routed requested port -> actual port mappings
- OS-level listening ports detected by the daemon
- best-effort PID, process name, command, and URL information

Stopped processes stay visible for restart or removal, but their routed URL is cleared and the sidebar no longer presents their old port mapping as an active route.

Important limitation: the agent does not transparently create isolated per-process networks. Automatic pre-launch rerouting works only for supported managed or hooked process paths. Running two ordinary host processes that both bind `127.0.0.1:3004` still requires true network isolation, runtime injection, or a proxy/runtime adapter.

## Settings

- `portManager.enabled`: enable managed process routing.
- `portManager.defaultHost`: host used to build routed URLs.
- `portManager.scanRange`: nearby port scan range.
- `portManager.scanDirection`: scan direction for routing.
- `portManager.routingMode`: `hashed` logical routing or `nearest` conflict-only routing.
- `portManager.virtualPortRangeStart`: first actual port used by hashed routing.
- `portManager.virtualPortRangeEnd`: last actual port used by hashed routing.
- `portManager.preferredPorts`: ports watched in the background and suggested by prompts.
- `portManager.fixedProtocolPorts`: ports the native hook leaves untouched; set to `[]` to make every bind port eligible for logical routing.
- `portManager.autoOpenBrowser`: open routed URLs after managed process launch.
- `portManager.showConflictNotification`: show a notification when a managed process is routed.
- `portManager.monitorAllListeningPorts`: show all listening TCP ports reported by the agent.
- `portManager.watchPreferredPorts`: watch preferred ports for external listeners.
- `portManager.watchIntervalMs`: polling interval for preferred port watching.
- `portManager.notifyOnDetectedConflict`: show a notification when a preferred port becomes occupied externally.
- `portManager.detectTerminalListenFailures`: detect VS Code terminal bind/listen failures and offer a routed rerun.
- `portManager.processKillSignal`: signal used to stop managed processes.

## Commands

- `Port Manager: Start Daemon`
- `Port Manager: Daemon Status`
- `Port Manager: Start Managed Process`
- `Port Manager: Add Existing Process`
- `Port Manager: Refresh`
- `Port Manager: Stop Process`
- `Port Manager: Restart Process`
- `Port Manager: Stop All Processes`
- `Port Manager: Copy Routed URL`
- `Port Manager: Open Routed URL`
- `Port Manager: Open Settings`

## Development

```sh
npm install
npm run compile
npm test
```

Build the optional native terminal hook with:

```sh
npm run build:hook
```

Packaging and publishing run this hook build again through `vscode:prepublish`. On macOS the generated hook library and asdf shim are ad-hoc signed when `codesign` is available.

For Marketplace release steps, publisher identity, VSIX verification, and native hook packaging checks, see [PUBLISHING.MD](PUBLISHING.MD). The Marketplace publisher ID is `newdlops`.

## Architecture

- `src/extension`: activation and command orchestration
- `src/core`: routing policy and process registry
- `src/platform`: Node and OS adapters for ports and processes
- `src/ui`: sidebar tree provider
- `src/config`: VS Code settings loader
- `src/shared`: framework-neutral contracts and event utilities

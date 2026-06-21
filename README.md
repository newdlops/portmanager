# Port Manager

Port Manager is a VS Code extension that starts managed development processes on available ports and shows the routed process list in a sidebar.

The MVP uses one local Port Manager agent per OS user. VS Code windows connect to that agent, which scans local listening TCP ports, owns managed process launches, maps logical requested ports to actual bind ports, injects route data through environment variables, and publishes a shared snapshot to every Port Manager sidebar.

## MVP Capabilities

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
- Install a native shell hook for OS terminals outside VS Code.
- Detect VS Code terminal listen failures and offer to rerun the failed command through Port Manager routing.
- Stop, restart, remove, open, and copy managed process URLs.
- Keep sidebar row clicks as selection only; browser opening is an explicit action.
- Treat routed URLs as live only while the process is running.
- Register an already running process for sidebar management.

## Usage

1. Run `npm install`.
2. Run `npm run compile`.
3. Press `F5` in VS Code and choose `Run Port Manager Extension`.
4. In the Extension Development Host, open the Port Manager activity bar view.
5. Run `Port Manager: Start Managed Process`.
6. Enter a command such as `npm run dev`, the requested port, working directory, and injection mode.

By default, Port Manager uses hashed logical routing: a requested port such as `8000` remains the logical port, while the launched process binds to a deterministic actual port in `portManager.virtualPortRangeStart` through `portManager.virtualPortRangeEnd`. Set `portManager.routingMode` to `nearest` to use the older nearby-port behavior.

If a command is run directly in a VS Code terminal and explicitly includes a port such as `--port 3000`, `PORT=8000`, or `runserver 127.0.0.1:8000`, Port Manager offers `Rerun Routed` immediately. That stops the direct terminal command and starts it through the shared agent so the daemon assigns the actual bind port before the application starts. If a command hides its port and later fails with a bind error such as `Address already in use`, Port Manager can still detect the terminal output and offer the same routed rerun.

For terminals outside VS Code, run `Port Manager: Install Shell Hook` once from the Command Palette, then open a new shell. The hook is sourced from your shell profile and injects the native socket hook into descendant development processes.

```sh
daphne -b 127.0.0.1 -p 8000 myapp.asgi:application
npm run dev
```

When a hooked process calls `bind(8000)`, the hook asks the same per-user daemon to allocate an actual port, rewrites the bind call, and registers the logical route. When another hooked local process calls `connect(...:8000)`, the hook reads the daemon route table and redirects the connection to the actual port.

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

Important limitation: the agent does not transparently intercept every arbitrary process' failed `bind()` request before it happens. Automatic pre-launch rerouting works for processes launched through `Port Manager: Start Managed Process`. For direct terminal commands, Port Manager detects supported listen-failure output after the command fails and can rerun the same command through the managed launch path. The logical route table is exposed to launched processes, but transparent rewriting of arbitrary in-process HTTP calls still requires a proxy, SDK, or runtime injection layer.

## Settings

- `portManager.enabled`: enable managed process routing.
- `portManager.defaultHost`: host used to build routed URLs.
- `portManager.scanRange`: nearby port scan range.
- `portManager.scanDirection`: scan direction for routing.
- `portManager.routingMode`: `hashed` logical routing or `nearest` conflict-only routing.
- `portManager.virtualPortRangeStart`: first actual port used by hashed routing.
- `portManager.virtualPortRangeEnd`: last actual port used by hashed routing.
- `portManager.preferredPorts`: ports watched in the background and suggested by prompts.
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

## Architecture

- `src/extension`: activation and command orchestration
- `src/core`: routing policy and process registry
- `src/platform`: Node and OS adapters for ports and processes
- `src/ui`: sidebar tree provider
- `src/config`: VS Code settings loader
- `src/shared`: framework-neutral contracts and event utilities

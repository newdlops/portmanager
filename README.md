# Port Manager

Port Manager is a VS Code extension that starts managed development processes on available ports and shows the routed process list in a sidebar.

The MVP uses one local Port Manager agent per OS user. VS Code windows connect to that agent, which scans local listening TCP ports, owns managed process launches, routes busy requested ports, injects the actual port through `PORT`, and publishes a shared snapshot to every Port Manager sidebar.

## MVP Capabilities

- Start a managed process from the command palette or sidebar.
- Detect whether the requested port is busy.
- Route to a nearby available port.
- Inject the actual port through `PORT`, `${port}` replacement, or `--port`.
- Track requested and actual ports in the sidebar.
- Watch all local listening TCP ports through the shared local agent.
- Show which process owns each visible port when the OS exposes PID/name data.
- Stop, restart, remove, open, and copy managed process URLs.
- Register an already running process for sidebar management.

## Usage

1. Run `npm install`.
2. Run `npm run compile`.
3. Press `F5` in VS Code and choose `Run Port Manager Extension`.
4. In the Extension Development Host, open the Port Manager activity bar view.
5. Run `Port Manager: Start Managed Process`.
6. Enter a command such as `npm run dev`, the requested port, working directory, and injection mode.

If the requested port is busy, the extension routes to the nearest available port according to `portManager.scanDirection` and `portManager.scanRange`.

## Local Agent

Port Manager starts after VS Code startup and connects to a single local agent.

The agent listens on a per-user local socket or named pipe. If no agent is running, the first VS Code window starts one. Additional VS Code windows connect to the same agent and receive the same port snapshot.

The sidebar shows:

- managed processes launched by Port Manager
- routed requested port -> actual port mappings
- externally detected listening ports
- best-effort PID, process name, command, and URL information

Important limitation: the agent does not transparently intercept every arbitrary process' failed `bind()` request. Automatic rerouting works for processes launched through `Port Manager: Start Managed Process`. External processes are detected after they occupy a listening port.

## Settings

- `portManager.enabled`: enable managed process routing.
- `portManager.defaultHost`: host used to build routed URLs.
- `portManager.scanRange`: nearby port scan range.
- `portManager.scanDirection`: scan direction for routing.
- `portManager.preferredPorts`: ports watched in the background and suggested by prompts.
- `portManager.autoOpenBrowser`: open routed URLs after managed process launch.
- `portManager.showConflictNotification`: show a notification when a managed process is routed.
- `portManager.monitorAllListeningPorts`: show all listening TCP ports reported by the agent.
- `portManager.watchPreferredPorts`: watch preferred ports for external listeners.
- `portManager.watchIntervalMs`: polling interval for preferred port watching.
- `portManager.notifyOnDetectedConflict`: show a notification when a preferred port becomes occupied externally.
- `portManager.processKillSignal`: signal used to stop managed processes.

## Commands

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

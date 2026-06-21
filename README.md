# Port Manager

Port Manager is a VS Code extension that starts managed development processes on available ports and shows the routed process list in a sidebar.

The MVP implements the managed-process path from `SPEC.MD`: before launching a process, the extension checks whether the requested port is available. If the port is busy, it finds a nearby port, injects that port through `PORT`, and tracks the process in the Port Manager view.

## MVP Capabilities

- Start a managed process from the command palette or sidebar.
- Detect whether the requested port is busy.
- Route to a nearby available port.
- Inject the actual port through `PORT`, `${port}` replacement, or `--port`.
- Track requested and actual ports in the sidebar.
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

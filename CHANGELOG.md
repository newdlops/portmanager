# Changelog

All notable changes to Port Manager are documented in this file.

## Unreleased

- Promote the logical port gateway to the primary client routing path. Port Manager now owns each in-use logical port on `127.0.0.1`/`::1` and forwards every accepted connection to the caller's logical network by identifying the source process, so clients route correctly regardless of how the address and port were passed (environment variables, shell variables, computed values).
- Resolve the connection source natively in the router (client pid, start time, and network id from the process environment) instead of shelling out to `lsof` on the hot path, with a per-client verdict cache.
- Route unidentified (non-network) clients to a network-less passthrough owner on `127.0.0.1`, or refuse the connection when no such owner exists, instead of guessing a route from cwd or a lone unscoped route. **Behavior change:** tooling that relied on the old cwd/unique-route guess (including Docker Desktop loopback traffic dialing back into a network's logical port) now needs an explicit Host Access Binding or exposure.
- Relocate a server started in a non-attached terminal off a gateway-owned port to a high port so it stays reachable through the gateway instead of being shadowed by the gateway listener.
- Add the `portManager.logicalPortGateway` setting (default on) to disable the gateway and fall back to in-process hook routing only.
- Remove shebang/script-content shell parsing from the native hook, the generated PATH shims, and the asdf shim. Preload survival now relies on the PATH runtime shims; a server launched by an absolute-path `#!` interpreter (not `/usr/bin/env`) in an attached terminal is the remaining case that can lose per-network isolation.
- Attribute connections to networks with a native process-membership tracker that follows the attached shell's process subtree without injecting an environment variable, keeping membership after a process daemonizes or reparents to launchd. The router queries it as the primary attribution source ahead of the process-tree/environment fallback.
- Isolate the interface view of a network-scoped process: the hook interposes `getifaddrs` so `os.networkInterfaces()` reports only `127.0.0.1` and the process's own network loopback alias, hiding other networks' host-global `lo0` aliases (e.g. dev servers like vite no longer enumerate every network's loopback).
- Serve every network-alias port through one protocol-sniffing listener instead of classifying ports as web vs raw. Each connection is demultiplexed by its first bytes: a TLS ClientHello is terminated with the dev certificate and proxied as HTTP, a plaintext HTTP request line is proxied as HTTP, and anything else is forwarded as raw TCP. **Fixes `ERR_SSL_PROTOCOL_ERROR`** on Docker Compose (and other containerized) web services, which the previous command-name heuristic misclassified as raw and served plain, so browsers rejected the HTTPS handshake. Databases and other raw protocols on the same alias continue to work over the raw path.

## 0.0.1

Initial release.

- Publish as a general Marketplace release and ship a dedicated extension icon.
- Add drag-and-drop terminal attachment from terminal rows onto logical network rows.
- Add binding preset save/apply commands and terminal network reset actions.
- Add logical network records, terminal attachments, and host port exposures backed by the local TCP proxy runtime.
- Restore persisted logical networks, terminal attachments, and active host exposures when the extension starts.
- Document the `newdlops.portmanager` Marketplace publishing flow, including prechecks, VSIX install verification, publish commands, and native hook build/codesign checks.
- Use one local Port Manager agent per OS user and share state across VS Code windows.
- Scan local listening TCP ports and show externally occupied ports in the sidebar.
- Detect VS Code terminal bind/listen failures and offer a routed rerun through the local agent.
- Start managed development processes from VS Code.
- Keep sidebar row selection separate from browser opening.
- Clear live routed URLs when managed processes stop.
- Add hashed logical routing so requested ports can remain unoccupied while actual bind ports live in a virtual range.
- Inject logical route metadata through `PORT_MANAGER_*` environment variables and a dynamic route table file.
- Detect requested port conflicts before launch.
- Route requested ports to available actual ports.
- Inject the actual port through `PORT`, `${port}`, or `--port`.
- Show managed processes and logical requested port -> actual port mappings in the sidebar.
- Stop, restart, remove, open, and copy routed process URLs.
- Register already running processes for sidebar management.

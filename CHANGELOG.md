# Changelog

All notable changes to Port Manager are documented in this file.

## Unreleased

- Add `Open Network Terminal` to every Logical Network. It opens a new VS Code integrated terminal, automatically sources that network's generated routing script, and leaves the window-wide terminal default unchanged.
- Add a guided `Create Isolated Worktree` transaction that creates or reuses a Git worktree, provisions its dedicated Logical Network, automatically copies current-worktree Compose projects in non-destructive copy mode, rebases repository-owned bind mounts into the new checkout, verifies DNS/TLS, and finishes terminal attachment in the newly opened VS Code window. Partial handoff state remains retryable without duplicating resources.
- Add a worktree-first `Initialize This Worktree` path that creates or reuses one default logical network, installs the `pm` shell integration, applies the network to the VS Code window, completes DNS/TLS setup, verifies runtime readiness, and opens a ready terminal. Partial initialization state is retained so retries do not leak duplicate networks.
- Treat clean-machine support as a release requirement: target-specific VSIX packaging now fails when native compilation is unavailable, verifies every artifact's architecture/signature/macOS deployment target, rejects Rosetta-masked CPU mismatches, and preloads the packaged hook through the OS loader instead of trusting executable bits.
- Verify browser TLS against the actual macOS Keychain and surface trust separately from DNS. Fresh-machine setup now repairs missing/unreadable TLS material, resolves the owning user/home/login shell without relying on GUI environment variables, verifies signed-leaf hostname coverage and real macOS `getaddrinfo` answers, keeps failed setup retryable, and refuses to report success while the DNS responder or alias verification is incomplete. Installed shell assets are parsed and sourced to prove `pm` is available before initialization succeeds.
- Fix intermittent Local DNS recovery that still required `Developer: Restart Extension Host`. A DNS table queued at the promise-settlement edge could remain parked with no active drain, and an accepted table whose UDP responder had not rebound yet was treated as complete. The latest-value coordinator now hands settlement-edge work to a new drain, retries same-revision binds with bounded backoff, and lets explicit repair bypass an existing delay; browser proxy reconciliation closes the same lost-wakeup window.

- Move the browser DNS responder (UDP `127.0.0.1:53153`) from the VS Code extension host into the native routing daemon. The in-window responder tied the socket to one window's lifetime while record updates followed the cross-window owner lease, so after an owner handoff (sleep/wake lease expiry, "make this window owner") the socket stayed in a demoted window whose table never updated again — networks created or attached from a new window resolved as NXDOMAIN (`<alias>`/`<alias>.pm`), and the alias data plane split across windows. Every window now pushes the full record set to the daemon over the agent socket (`syncBrowserDns`, signature-deduped), the daemon persists records next to its route tables so answers survive daemon restarts and extension-less periods, and it retries the UDP bind until windows running older extension builds release the port. `daemonStatus` reports `browserDnsRunning`/`browserDnsPort` for the Diagnostics view, and the Node fallback daemon serves the same responder.

- Fixed terminal-launched servers stalling inside `bind()` while the native agent was refreshing listeners. Hook registrations now queue a complete frame without waiting for the response, the agent consumes queued data before peer-close events, and logical route-table publication is kept ahead of expensive UI snapshots.

- Fixed **Stale Routing** recovery after VS Code or the shared daemon restarts while existing terminals and hooked servers remain alive. Repair now restores same-port per-network loopback listeners, scans each PID once, performs one authoritative LISTEN pass before slower Docker reconciliation, restores persisted terminal attachments, and synchronously rewrites missing or corrupt route shards without trusting a failed `lsof` scan.

- Fixed runtime launchers rewriting an already-complete network scope and retaining borrowed `getenv()` pointers across `setenv()`. Long network ids no longer corrupt the hooked runtime boundary or terminate the first server command.

- Fixed managed shell-profile suspension leaving `PORT_MANAGER_RUNTIME_SHIM_READY=0` after VS Code shell integration, which could force slow first-command repair paths and prevent routed server processes from being recognized under their logical ports.

- Bracket PM-managed shell profiles with a builtin-only prelude and deferred activation so inherited preload/runtime shims do not amplify NVM/asdf/pyenv startup work. Existing exact PM installs migrate safely, and `Port Manager: Restore Shell Profiles` removes only PM-owned blocks and legacy source lines.
- Stop freezing the extension host event loop during proxy reconciliation. Reclaiming orphaned native host-proxy helpers ran a synchronous full process-table scan (`execFileSync("ps")`) per browser endpoint on every sync — with dozens of endpoints that blocked the event loop for multiple seconds every ~10s, stalling TCP accepts, TLS handshakes, and the logical port gateway's route resolution (its 5s response timeout then dropped client connections entirely). The scan is now asynchronous, batched into one process-table read per reconciliation, and skipped for endpoints whose sniffing listener is already open, so the steady-state sync spawns nothing.
- Terminate TLS on loopback Host Port Exposures. `https://localhost:<hostPort>` used to raw-forward the browser's ClientHello to the plaintext upstream, which answered with plaintext (`ERR_SSL_PROTOCOL_ERROR` in Chrome) — and Chrome's HTTPS-First upgrade steered even plain `localhost:<port>` entries onto that path. Loopback TCP exposures are now served by the protocol-sniffing listener with the dev certificate (whose SANs already include `localhost` and `127.0.0.1`); plain HTTP and raw client protocols behave as before, and non-loopback exposures keep the raw native forwarder.
- Move the host-local fixed-protocol pf redirect target off the browser alias onto a hidden per-network redirect alias (`127.144–175` band). macOS pf mangles reply packets for every connection to an `rdr` target coordinate, so direct dials to the previous target (the browser alias serving the same port, e.g. `alpha1:15432`) hung forever in SYN_RCVD. A sniffing listener now binds each redirected port on the hidden alias, `127.0.0.1:<fixed port>` keeps working for hookless host clients, and the browser alias becomes directly dialable again. Applying the new anchor asks for administrator privileges once.
- Promote the logical port gateway to the primary client routing path. Port Manager now owns each in-use logical port on `127.0.0.1`/`::1` and forwards every accepted connection to the caller's logical network by identifying the source process, so clients route correctly regardless of how the address and port were passed (environment variables, shell variables, computed values).
- Resolve the connection source natively in the router (client pid, start time, and network id from the process environment) instead of shelling out to `lsof` on the hot path, with a per-client verdict cache.
- Route unidentified (non-network) clients to a network-less passthrough owner on `127.0.0.1`, or refuse the connection when no such owner exists, instead of guessing a route from cwd or a lone unscoped route. **Behavior change:** tooling that relied on the old cwd/unique-route guess (including Docker Desktop loopback traffic dialing back into a network's logical port) now needs an explicit Host Access Binding or exposure.
- Relocate a server started in a non-attached terminal off a gateway-owned port to a high port so it stays reachable through the gateway instead of being shadowed by the gateway listener.
- Add the `portManager.logicalPortGateway` setting (default on) to disable the gateway and fall back to in-process hook routing only.
- Remove shebang/script-content shell parsing from the native hook, the generated PATH shims, and the asdf shim. Preload survival now relies on the PATH runtime shims; a server launched by an absolute-path `#!` interpreter (not `/usr/bin/env`) in an attached terminal is the remaining case that can lose per-network isolation.
- Attribute connections to networks with a native process-membership tracker that follows the attached shell's process subtree without injecting an environment variable, keeping membership after a process daemonizes or reparents to launchd. The router queries it as the primary attribution source ahead of the process-tree/environment fallback.
- Isolate the interface view of a network-scoped process: the hook interposes `getifaddrs` so `os.networkInterfaces()` reports only `127.0.0.1` and the process's own network loopback alias, hiding other networks' host-global `lo0` aliases (e.g. dev servers like vite no longer enumerate every network's loopback).
- Serve every network-alias port through one protocol-sniffing listener instead of classifying ports as web vs raw. Each connection is demultiplexed by its first bytes: a TLS ClientHello is terminated with the dev certificate and proxied as HTTP, a plaintext HTTP request line is proxied as HTTP, and anything else is forwarded as raw TCP. **Fixes `ERR_SSL_PROTOCOL_ERROR`** on Docker Compose (and other containerized) web services, which the previous command-name heuristic misclassified as raw and served plain, so browsers rejected the HTTPS handshake. Databases and other raw protocols on the same alias continue to work over the raw path.

## 0.0.8254

- Reduce Docker background work by sharing one container snapshot between service discovery and Compose routing, and by polling every five minutes while healthy lifecycle events cover all active runtimes. Retain one-minute recovery polling when event coverage is unavailable or incomplete.
- Filter Docker healthcheck and exec events at the daemon, serialize event bursts with a trailing refresh, and limit Compose override validation to the affected projects or known containers. Reconnection immediately catches up missed changes.
- Preserve stopped Compose services as attachment candidates without publishing live routes for them, and share concurrent or failed inspect attempts within each refresh snapshot.

## 0.0.8253

- Restore Linux native builds with platform-specific process environment lookup and libc symbol declarations.
- Verify all four native Marketplace targets in CI, including installation and activation of each packaged VSIX in a fresh VS Code profile.
- Publish route files during sustained traffic and move route/DNS file operations off the control loop, with bounded queues, completion receipts, revision checks, and retryable partial failures.
- Keep DNS publication and status requests responsive during listener scans and slow socket reads; preserve accepted mutations and complete half-closed responses.
- Revalidate queued HTTP routes before connecting and preserve raw TCP half-close behavior.
- Reduce large network-table construction cost while preserving route ownership and output order.

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

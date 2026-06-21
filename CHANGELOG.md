# Changelog

All notable changes to Port Manager are documented in this file.

## 0.0.1

Initial preview release.

- Use one local Port Manager agent per OS user and share state across VS Code windows.
- Scan local listening TCP ports and show externally occupied ports in the sidebar.
- Detect VS Code terminal bind/listen failures and offer a routed rerun through the local agent.
- Start managed development processes from VS Code.
- Detect requested port conflicts before launch.
- Route busy requested ports to nearby available ports.
- Inject the actual port through `PORT`, `${port}`, or `--port`.
- Show managed processes and logical requested port -> actual port mappings in the sidebar.
- Stop, restart, remove, open, and copy routed process URLs.
- Register already running processes for sidebar management.

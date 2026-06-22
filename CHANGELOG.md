# Changelog

All notable changes to Port Manager are documented in this file.

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

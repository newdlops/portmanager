import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/**
 * Regression checks for terminal hook shell bootstrap generation.
 *
 * The extension module imports vscode directly, so these tests inspect the
 * source template without loading the extension host. The behavior guarded here
 * is intentionally narrow: runtime shims must be promoted to the front of PATH
 * even when they are already present later in the inherited shell environment.
 */

test("BASH_ENV restore script promotes runtime shims ahead of inherited PATH entries", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(
    source.includes('case ":\\${PATH:-}:"'),
    false,
    "runtime shim restore must not skip PATH repair just because the shim directory is already present",
  );
  assert.equal(source.includes('for __pm_path_entry in \\${PATH:-}; do'), true);
  assert.equal(
    source.includes('if [ "\\${__pm_path_entry}" = "\\${PORT_MANAGER_RUNTIME_SHIM_DIR}" ]; then'),
    true,
  );
  assert.equal(
    source.includes('export PATH="\\${PORT_MANAGER_RUNTIME_SHIM_DIR}\\${__pm_path_rest:+:$__pm_path_rest}"'),
    true,
  );
});

test("package command shims rerun client tools without native runtime alias semantics", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const launcherList = /const PRELOAD_RUNTIME_LAUNCHER_NAMES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const packageCommandList = /const PRELOAD_PACKAGE_COMMAND_NAMES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";

  for (const packageBinary of ["yarn", "concurrently", "wait-on", "retry", "vite", "dotenv", "celery", "uvicorn", "gunicorn", "daphne"]) {
    assert.equal(
      launcherList.includes(`"${packageBinary}"`),
      false,
      `${packageBinary} must not use the native runtime launcher argv semantics`,
    );
    assert.equal(
      packageCommandList.includes(`"${packageBinary}"`),
      true,
      `${packageBinary} must use the command-capturing preload shim`,
    );
  }

  assert.equal(source.includes("buildPreloadPackageCommandShimScript"), true);
  assert.equal(source.includes('exec "\\${__pm_node}" "\\${__pm_unwrapped}" "$@"'), true);
  assert.equal(
    source.includes('__pm_exec_script="$(sed -n'),
    true,
    "package command shim must parse Yarn temporary wrappers that exec node plus a JS entrypoint",
  );
  assert.equal(
    source.includes('exec "\\${__pm_node}" "\\${__pm_exec_script}" "$@"'),
    true,
    "package command shim must bypass temporary shell wrappers before they strip DYLD again",
  );
});

test("terminal attach and detach commands source generated script files", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes('const TERMINAL_HOOK_SCRIPT_DIRECTORY_NAME = "terminal-hook-scripts";'), true);
  assert.equal(source.includes("private writeTerminalHookScript(fileName: string, contents: string): string"), true);
  assert.equal(source.includes("return `. ${shellQuote(scriptPath)}`;"), true);
  assert.equal(
    source.includes("return commands.join(\"; \");"),
    false,
    "terminal injection must not inline the full bootstrap as one long command",
  );
});

test("external pm shell function selects a network and sources its attach script", () => {
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const commandSourcePath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const terminalHookEnvironmentPath = path.resolve(__dirname, "../../../src/extension/terminal-hook-environment.ts");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");
  const commandSource = fs.readFileSync(commandSourcePath, "utf8");
  const terminalHookEnvironmentSource = fs.readFileSync(terminalHookEnvironmentPath, "utf8");

  assert.equal(networkServiceSource.includes('const TERMINAL_NETWORK_SELECTION_FILE_NAME = "terminal-networks.tsv";'), true);
  assert.equal(networkServiceSource.includes("private async writeTerminalNetworkSelectionFile(): Promise<void>"), true);
  assert.equal(networkServiceSource.includes("serializeTerminalNetworkSelectionRow(network.id, network.name, scriptPath)"), true);
  assert.equal(networkServiceSource.includes("await this.writeTerminalNetworkSelectionFile().catch(() => undefined);"), true);
  assert.equal(networkServiceSource.includes('shellExport("PORT_MANAGER_NETWORK_NAME", networkName)'), true);
  assert.equal(networkServiceSource.includes("buildTerminalTitleShell(buildPortManagerTerminalTitle(networkName))"), true);
  assert.equal(networkServiceSource.includes('buildTerminalTitleShell("Port Manager: detached")'), true);
  assert.equal(terminalHookEnvironmentSource.includes("readonly networkName?: string;"), true);
  assert.equal(terminalHookEnvironmentSource.includes('collection.replace("PORT_MANAGER_NETWORK_NAME", scope.networkName'), true);
  assert.equal(commandSource.includes("readonly terminalNetworkSelectionFilePath: string;"), true);
  assert.equal(commandSource.includes('export PORT_MANAGER_NETWORKS_FILE="'), true);
  assert.equal(commandSource.includes("PORT_MANAGER_NETWORK_NAME"), true);
  assert.equal(commandSource.includes("Port Manager: \\${PORT_MANAGER_NETWORK_NAME}"), true);
  assert.equal(commandSource.includes("pm() {"), true);
  assert.equal(commandSource.includes('"pm current"'), true);
  assert.equal(commandSource.includes('= "current"'), true);
  assert.equal(commandSource.includes('= "status"'), true);
  assert.equal(commandSource.includes("Port Manager shell network: none"), true);
  assert.equal(commandSource.includes('__pm_current_id="\\${PORT_MANAGER_NETWORK_ID:-}"'), true);
  assert.equal(commandSource.includes("Select Port Manager network:"), true);
  assert.equal(commandSource.includes('printf "%s %d) %s [%s]\\\\n", marker, NR, $2, $1'), true);
  assert.equal(commandSource.includes('. \"$__pm_attach_script\"'), true);
});

test("extension auto-refreshes shell hook assets without auto-mutating profiles", () => {
  const activatePath = path.resolve(__dirname, "../../../src/extension/activate.ts");
  const commandSourcePath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const activateSource = fs.readFileSync(activatePath, "utf8");
  const commandSource = fs.readFileSync(commandSourcePath, "utf8");
  const ensureStart = commandSource.indexOf("async ensureShellHookAssets");
  const installStart = commandSource.indexOf("private async installShellHook", ensureStart);
  const ensureBody = commandSource.slice(ensureStart, installStart);
  const installEnd = commandSource.indexOf("private async writeShellHookAssets", installStart);
  const installBody = commandSource.slice(installStart, installEnd);

  assert.equal(activateSource.includes("void commandController.ensureShellHookAssets(context).catch(() => undefined);"), true);
  assert.equal(commandSource.includes("private async writeShellHookAssets"), true);
  assert.equal(ensureBody.includes("await this.writeShellHookAssets(context);"), true);
  assert.equal(ensureBody.includes("appendLineOnce"), false);
  assert.equal(installBody.includes("appendLineOnce"), true);
});

test("network removal restores compose attachments before deleting the network", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const removeNetworkBody = /async removeNetwork\(networkId: string\): Promise<LogicalNetwork \| undefined> \{([\s\S]*?)\n  \}/.exec(
    source,
  )?.[1] ?? "";

  assert.equal(removeNetworkBody.includes("await this.removeComposeAttachment(attachment.id);"), true);
  assert.equal(
    removeNetworkBody.includes("for (const port of attachment.ports)"),
    false,
    "network removal must use the compose mutation restore path, not just delete route processes",
  );
});

test("background routing refresh polls terminals and containers", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("private startRoutingSignalRefreshLoop(): void"), true);
  assert.equal(source.includes("this.refreshTerminals().catch(() => [])"), true);
  assert.equal(source.includes("this.refreshContainerServices().catch(() => [])"), true);
  assert.equal(source.includes("await this.reconcileComposeAttachmentPublishedPorts().catch(() => undefined);"), true);
  assert.equal(source.includes("await this.convergeDaemonAndRoutingState();"), true);
  assert.equal(source.includes("ROUTING_SIGNAL_REFRESH_INTERVAL_MS = 3_000"), true);
});

test("background routing refresh converges daemon version and generated route files", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const convergeStart = source.indexOf("private async convergeDaemonAndRoutingStateExclusive");
  const convergeEnd = source.indexOf("private async ensureCurrentProcessDaemon", convergeStart);
  const convergeBody = source.slice(convergeStart, convergeEnd);
  const ensureStart = source.indexOf("private async ensureCurrentProcessDaemon");
  const ensureEnd = source.indexOf("private watchTerminalAttachmentMarkers", ensureStart);
  const ensureBody = source.slice(ensureStart, ensureEnd);

  assert.equal(source.includes("DAEMON_RESTART_BACKOFF_MS = 30_000"), true);
  assert.equal(convergeBody.includes("await this.ensureCurrentProcessDaemon().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.writeHostAccessBindingsFile().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.writeComposeProjectRoutingFile().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.restorePersistedComposeRoutesIfMissing().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.processService.refresh().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.syncLogicalPortRouters().catch(() => undefined);"), true);
  assert.equal(ensureBody.includes('daemon.status !== "running"'), true);
  assert.equal(ensureBody.includes("await this.processService.start();"), true);
  assert.equal(ensureBody.includes("daemon.restartRequired"), true);
  assert.equal(ensureBody.includes("await this.processService.restartDaemon();"), true);
});

test("terminal hook markers refresh attached UI state without manual refresh", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("TERMINAL_ATTACHMENT_MARKER_POLL_INTERVAL_MS = 500"), true);
  assert.equal(source.includes("private watchTerminalAttachmentMarkers(directoryPath: string): DisposableLike"), true);
  assert.equal(source.includes("syncFs.watch(directoryPath"), true);
  assert.equal(source.includes("private scheduleTerminalAttachmentRefreshBurst(): void"), true);
  assert.equal(source.includes("private async refreshTerminalAttachmentsWhenMarkersChanged(): Promise<void>"), true);
  assert.equal(source.includes("selectLatestTerminalAttachmentMarkerCandidates"), true);
  assert.equal(source.includes("terminalAttachmentsShareIdentity"), true);
  assert.equal(source.includes("selectedMarkerPaths"), true);
  assert.equal(source.includes("this.terminalRefreshInFlight !== undefined"), true);
  assert.equal(source.includes("this.terminalRefreshQueued = true"), true);
  assert.equal(source.includes("this.startTerminalAttachmentMarkerPolling();"), true);
});

test("terminal reveal focuses injected VS Code and external terminal windows", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("async revealTerminalWindow(terminalWindowId: string): Promise<boolean>"), true);
  assert.equal(source.includes("function findMatchingVscodeTerminal"), true);
  assert.equal(source.includes("terminal.show(false);"), true);
  assert.equal(source.includes("function revealExternalTerminalWindow"), true);
  assert.equal(source.includes("function revealTerminalAppleScript"), true);
  assert.equal(source.includes("set selected tab of windowItem to tabItem"), true);
  assert.equal(source.includes("function revealITermAppleScript"), true);
  assert.equal(source.includes("select sessionItem"), true);
});

test("compose route rehydration retries recoverable error attachments after restart", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const restoreStart = source.indexOf("private async restorePersistedComposeRoutesIfMissing");
  const restoreEnd = source.indexOf("private async repairPersistedPortManagerCloneComposeAttachments", restoreStart);
  const restoreBody = source.slice(restoreStart, restoreEnd);
  const reconcileStart = source.indexOf("private async reconcileComposeAttachmentPublishedPortsExclusive");
  const reconcileEnd = source.indexOf("private async refreshComposeContainerMappings", reconcileStart);
  const reconcileBody = source.slice(reconcileStart, reconcileEnd);

  assert.equal(source.includes("function isRestorableComposeAttachment"), true);
  assert.equal(source.includes('attachment.status === "attached" || attachment.status === "error"'), true);
  assert.equal(restoreBody.includes("await this.composeAttachmentReconcileInFlight.catch(() => undefined);"), true);
  assert.equal(
    /if \(this\.composeAttachmentReconcileInFlight !== undefined\) \{\s*return;\s*\}/.test(restoreBody),
    false,
    "in-flight compose refresh must not permanently skip route restore",
  );
  assert.equal(reconcileBody.includes(".composeAttachments.filter(isRestorableComposeAttachment)"), true);
  assert.equal(
    reconcileBody.includes("await this.restorePersistedComposeRoutesIfMissing({ allowDuringComposeReconcile: true });"),
    true,
  );
  assert.equal(source.includes("attachment.errorMessage !== undefined"), true);
});

test("terminal attach script enables loopback routing only after alias readiness", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("buildLoopbackAddressRoutingShell"), true);
  assert.equal(source.includes("sudo -n ifconfig lo0 alias"), true);
  assert.equal(source.includes('sudo ifconfig lo0 alias "$__pm_loopback_host" 255.255.255.255 >/dev/null'), true);
  assert.equal(source.includes("portManager.loopbackAddressRoutingMode"), true);
  assert.equal(source.includes("Port Manager loopback IP routing unavailable; using high-port routing fallback."), true);
  assert.equal(source.includes("NETWORK_LOOPBACK_HOST_ENV"), true);
});

test("native hook lets loopback aliases own dev server ports", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("pm_network_loopback_host() == NULL && pm_current_process_looks_like_browser_dev_server()"), true);
  assert.equal(source.includes("bind loopback-network logical=%d host=%s"), true);
  assert.equal(
    source.includes("collapse sessions back onto 127.0.0.1 and defeat cookie isolation"),
    true,
  );
});

test("logical routers are opened only after logical routes are live", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const collectStart = source.indexOf("function collectLogicalRouterPorts");
  const collectEnd = source.indexOf("function isPortManagerLogicalRouterListener", collectStart);
  const collectLogicalRouterPorts = source.slice(collectStart, collectEnd);

  assert.equal(source.includes("collectLogicalRouterPorts(snapshot?.routes ?? [], snapshot?.listeners ?? [])"), true);
  assert.equal(source.includes("pending allocations stay"), true);
  assert.equal(collectLogicalRouterPorts.includes('route.source === "compose"'), false);
  assert.equal(collectLogicalRouterPorts.includes("route.actualPort !== route.logicalPort"), true);
  assert.equal(collectLogicalRouterPorts.includes("!externallyOwnedPorts.has(route.logicalPort)"), true);
  assert.equal(
    source.includes("await this.logicalPortRouter.sync([]).catch(() => undefined);"),
    false,
    "compose dependency clients such as Celery need a localhost TCP router fallback",
  );
});

test("logical router classifies clients by process tree label before hook environment fallback", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const methodStart = source.indexOf("private async findClientNetworkForRouter");
  const methodEnd = source.indexOf("private async findNetworkRouteForRouter", methodStart);
  const findClientNetworkForRouter = source.slice(methodStart, methodEnd);

  assert.equal(source.includes('from "../core/process-network-labels"'), true);
  assert.equal(
    findClientNetworkForRouter.indexOf("this.findAttachedNetworkForPid(pid, processRows)") <
      findClientNetworkForRouter.indexOf("this.processEnvironmentProvider.readRoutingNetworkId(pid)"),
    true,
    "process tree labels must be the primary router signal; inherited hook env remains fallback",
  );
  assert.equal(findClientNetworkForRouter.includes("return environmentNetworkId;"), true);
});

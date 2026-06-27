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
  const packageCommandList = /const PRELOAD_PACKAGE_COMMAND_NAMES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const packageManagerList = /const PRELOAD_PACKAGE_MANAGER_NAMES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const packageManagerShimStart = source.indexOf("function buildPreloadPackageManagerCommandShimScript");
  const packageManagerShimEnd = source.indexOf("function shellEnvRestoreFileName", packageManagerShimStart);
  const packageManagerShim = source.slice(packageManagerShimStart, packageManagerShimEnd);
  const packageManagerDevServerStart = packageManagerShim.indexOf("if __pm_text_looks_like_dev_server");
  const packageManagerDevServerEnd = packageManagerShim.indexOf('exec "\\${__pm_target}" "$@"', packageManagerDevServerStart);
  const packageManagerDevServerBlock = packageManagerShim.slice(packageManagerDevServerStart, packageManagerDevServerEnd);

  for (const packageBinary of ["concurrently", "wait-on", "retry", "vite", "dotenv", "celery", "uvicorn", "gunicorn", "daphne"]) {
    assert.equal(
      packageCommandList.includes(`"${packageBinary}"`),
      true,
      `${packageBinary} must use the command-capturing preload shim`,
    );
  }

  for (const packageManager of ["npm", "npx", "pnpm", "pnpx", "corepack", "yarn", "yarnpkg"]) {
    assert.equal(
      packageCommandList.includes(`"${packageManager}"`),
      false,
      `${packageManager} must not be hooked as a package command shim`,
    );
    assert.equal(
      packageManagerList.includes(`"${packageManager}"`),
      true,
      `${packageManager} must use the package-manager dev-server detector shim`,
    );
  }

  assert.equal(source.includes("buildPreloadPackageCommandShimScript"), true);
  assert.equal(source.includes("buildPreloadPackageManagerCommandShimScript"), true);
  assert.equal(source.includes("writePreloadPackageManagerCommandShims"), true);
  assert.equal(source.includes("removeStaleBroadRuntimeLauncherAliases"), true);
  assert.equal(
    source.includes("PRELOAD_RUNTIME_LAUNCHER_NAMES"),
    false,
    "generic runtime names must not be public PATH shims",
  );
  assert.equal(
    source.includes("for (const runtimeName"),
    false,
    "runtime-shims PATH must not shadow node/python/ruby for arbitrary /usr/bin/env scripts",
  );
  assert.equal(
    source.includes("const sourceShimDirectory = getAsdfShimDirectory()"),
    false,
    "runtime shims must not mirror arbitrary asdf shims such as vsce into PATH",
  );
  assert.equal(
    source.includes("ensureExecutableAlias(path.join(targetDirectory, entry.name), launcherPath)"),
    false,
    "only explicit runtime names should use the native runtime launcher",
  );
  assert.equal(source.includes("__pm_text_looks_like_dev_server()"), true);
  assert.equal(source.includes("__pm_package_script_text()"), true);
  assert.equal(source.includes("*vite*"), true);
  assert.equal(source.includes("*uvicorn*"), true);
  assert.equal(source.includes("removeLegacyPreloadPackageManagerShims"), true);
  assert.equal(source.includes("PRELOAD_PACKAGE_MANAGER_NAMES.includes(entry.name)"), true);
  assert.equal(source.includes("__pm_is_package_command_shim()"), true);
  assert.equal(source.includes("export PORT_MANAGER_PRELOAD_REPAIR=1"), true);
  assert.equal(
    source.includes('if [ "\\${PORT_MANAGER_PRELOAD_REPAIR:-}" = "1" ] && [ -n "\\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ]; then'),
    true,
    "BASH_ENV must not restore DYLD for package-manager lifecycle shells unless a runtime shim opted in",
  );
  assert.equal(
    source.includes('if __pm_is_package_command_shim "\\${__pm_candidate}"; then'),
    true,
    "package command shim must skip sibling Port Manager package shims in later PATH entries",
  );
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
  assert.equal(
    source.includes("function buildPreloadNodeEntrypointBypassShell"),
    true,
    "Node entrypoint bypass should be shared by package-bin and package-manager shims",
  );
  assert.equal(
    packageManagerDevServerBlock.includes("${buildPreloadNodeEntrypointBypassShell()}"),
    true,
    "package-manager dev-server commands must bypass /usr/bin/env node before DYLD is stripped",
  );
  assert.equal(
    packageManagerDevServerBlock.includes("export PORT_MANAGER_PRELOAD_REPAIR=1"),
    true,
    "package-manager shim must keep lifecycle commands unhooked unless a dev-server command was detected",
  );
  assert.equal(
    packageManagerShim.includes("__pm_exec_without_port_manager_preload()"),
    true,
    "package-manager dependency commands must run without the native preload hook",
  );
  assert.equal(packageManagerShim.includes("unset DYLD_INSERT_LIBRARIES"), true);
  assert.equal(packageManagerShim.includes("unset LD_PRELOAD"), true);
  assert.equal(packageManagerShim.includes("unset BASH_ENV"), true);
  assert.equal(packageManagerShim.includes("unset ENV"), true);
  assert.equal(packageManagerShim.includes("unset PORT_MANAGER_RUNTIME_SHIM_DIR"), true);
  assert.equal(packageManagerShim.includes("export PORT_MANAGER_HOOK=0"), true);
  assert.equal(packageManagerShim.includes("export PORT_MANAGER_HOOK_DISABLED=1"), true);
  assert.equal(
    packageManagerShim.includes("__pm_strip_port_manager_runtime_shims_from_path"),
    true,
    "non-dev package-manager commands must not resolve node through Port Manager runtime shims",
  );
  assert.equal(
    packageManagerShim.includes('__pm_exec_without_port_manager_preload "$@"'),
    true,
    "non-dev package-manager commands must use the clean execution path",
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
  assert.equal(
    source.includes("buildTerminalAttachmentMarkerRemoveShell(): string"),
    true,
    "detach script must remove the shell marker through a generated helper",
  );
  assert.equal(
    source.includes('].join("\\n");'),
    true,
    "detach marker removal must be multiline so `then` is not followed by an invalid semicolon",
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
  assert.equal(networkServiceSource.includes("const serviceSummary = buildTerminalNetworkServiceSummary"), true);
  assert.equal(networkServiceSource.includes("serializeTerminalNetworkSelectionRow(network.id, network.name, scriptPath, serviceSummary)"), true);
  assert.equal(networkServiceSource.includes("void this.writeTerminalNetworkSelectionFile();"), true);
  assert.equal(networkServiceSource.includes("await this.writeTerminalNetworkSelectionFile().catch(() => undefined);"), true);
  assert.equal(networkServiceSource.includes("private terminalNetworkSelectionWriteInFlight"), true);
  assert.equal(networkServiceSource.includes("private terminalNetworkSelectionWriteQueued = false;"), true);
  assert.equal(networkServiceSource.includes("private async writeTerminalNetworkSelectionFileSerially(): Promise<void>"), true);
  assert.equal(networkServiceSource.includes("private async writeTerminalNetworkSelectionFileExclusive(): Promise<void>"), true);
  assert.equal(networkServiceSource.includes("await writeTextFileAtomically(filePath"), true);
  assert.equal(networkServiceSource.includes("await fs.rename(tempPath, filePath)"), true);
  assert.equal(networkServiceSource.includes('const TERMINAL_NETWORK_SERVICE_ENTRY_SEPARATOR = " || ";'), true);
  assert.equal(networkServiceSource.includes("buildTerminalNetworkServiceSummary(network.id, snapshot)"), true);
  assert.equal(networkServiceSource.includes('item.status === "attached" || item.status === "error"'), true);
  assert.equal(networkServiceSource.includes("formatTerminalNetworkServiceEntry(\"compose\""), true);
  assert.equal(networkServiceSource.includes("isContainerStyleComposeAttachment(attachment)"), true);
  assert.equal(networkServiceSource.includes("formatTerminalNetworkServiceEntry(\"container\""), true);
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
  assert.equal(commandSource.includes("const networkPrintScript = ["), true);
  assert.equal(commandSource.includes("summary.split(/\\\\s+\\\\|\\\\|\\\\s+/)"), true);
  assert.equal(commandSource.includes('console.error("     "+entry.trim())'), true);
  assert.equal(commandSource.includes('summary = (NF >= 4 && $4 != "" ? " - " $4 : " - no services")'), false);
  assert.equal(commandSource.includes('. \"$__pm_attach_script\"'), true);
});

test("external pm shell function exposes doctor routes and detach diagnostics", () => {
  const commandSourcePath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const commandSource = fs.readFileSync(commandSourcePath, "utf8");

  assert.equal(commandSource.includes("routeCountScript"), true);
  assert.equal(commandSource.includes("routePrintScript"), true);
  assert.equal(commandSource.includes('"doctor"'), true);
  assert.equal(commandSource.includes('"routes"'), true);
  assert.equal(commandSource.includes('"detach"'), true);
  assert.equal(commandSource.includes("Daemon readiness flag:"), true);
  assert.equal(commandSource.includes("Route table:"), true);
  assert.equal(commandSource.includes("Network selection file:"), true);
  assert.equal(commandSource.includes("Host access:"), true);
  assert.equal(commandSource.includes("Port Manager routes:"), true);
  assert.equal(commandSource.includes("Port Manager: detached"), true);
  assert.equal(commandSource.includes('rm -f "$PORT_MANAGER_TERMINAL_ATTACHMENT_DIR/$__pm_marker_key.tsv"'), true);
  assert.equal(commandSource.includes("Port Manager routing detached from this shell."), true);
  assert.equal(commandSource.includes("shellPatternLiteral"), true);
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
  assert.equal(source.includes("this.refreshContainerServices({ background: true }).catch(() => [])"), true);
  assert.equal(source.includes("await this.reconcileComposeAttachmentPublishedPorts({ background: true }).catch(() => undefined);"), true);
  assert.equal(source.includes("await this.convergeDaemonAndRoutingState();"), true);
  assert.equal(source.includes("ROUTING_SIGNAL_REFRESH_INTERVAL_MS = 60_000"), true);
  assert.equal(source.includes("BACKGROUND_CONTAINER_REFRESH_INTERVAL_MS = 60_000"), true);
  assert.equal(source.includes("tryAcquireSharedBackgroundContainerRefreshSlot()"), true);
});

test("terminal daemon ensure serializes agent startup and preserves slow live sockets", () => {
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const commandsPath = path.resolve(__dirname, "../../../src/extension/commands.ts");
  const networkSource = fs.readFileSync(networkServicePath, "utf8");
  const commandsSource = fs.readFileSync(commandsPath, "utf8");

  for (const source of [networkSource, commandsSource]) {
    assert.equal(source.includes('__pm_agent_lock="\\${PORT_MANAGER_AGENT_SOCKET}.startup.lock"'), true);
    assert.equal(source.includes('if mkdir "$__pm_agent_lock" 2>/dev/null; then'), true);
    assert.equal(source.includes('timer=setTimeout(()=>finish(1,false),700);'), true);
    assert.equal(source.includes('socket.once("error",()=>finish(1,false));'), true);
    assert.equal(source.includes('rm -f "$PORT_MANAGER_AGENT_SOCKET" 2>/dev/null || true'), true);
    assert.equal(source.includes('rmdir "$__pm_agent_lock" 2>/dev/null || true'), true);
  }
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
  assert.equal(convergeBody.includes("this.processService !== undefined && tryAcquireLogicalRouterOwnerLease()"), true);
  assert.equal(convergeBody.includes("await this.processService.refresh().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.syncLogicalPortRouters().catch(() => undefined);"), true);
  assert.equal(ensureBody.includes('daemon.status !== "running"'), true);
  assert.equal(ensureBody.includes("await this.processService.start();"), true);
  assert.equal(ensureBody.includes("daemon.restartRequired"), true);
  assert.equal(ensureBody.includes("await this.processService.restartDaemon();"), true);
});

test("logical port routers use a single cross-window owner lease", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const syncStart = source.indexOf("private async syncLogicalPortRouters(): Promise<void>");
  const syncEnd = source.indexOf("private async findClientNetworkForRouter", syncStart);
  const syncBody = source.slice(syncStart, syncEnd);

  assert.equal(source.includes("Owner lease must outlive the routing refresh interval"), true);
  assert.equal(source.includes("LOGICAL_ROUTER_OWNER_LEASE_MS = 120_000"), true);
  assert.equal(source.includes("LOGICAL_ROUTER_OWNER_LOCK_STALE_MS = 30_000"), true);
  assert.equal(source.includes('function buildLogicalRouterOwnerControlPath(kind: "owner" | "lock"): string'), true);
  assert.equal(source.includes("function tryAcquireLogicalRouterOwnerLease(): boolean"), true);
  assert.equal(source.includes("function isActiveLogicalRouterOwner"), true);
  assert.equal(source.includes("return isProcessAlive(owner.pid);"), true);
  assert.equal(syncBody.includes("this.logicalRouterSyncInFlight !== undefined"), true);
  assert.equal(syncBody.includes("this.logicalRouterSyncQueued = true;"), true);
  assert.equal(syncBody.includes("if (!tryAcquireLogicalRouterOwnerLease())"), true);
  assert.equal(syncBody.includes("await this.logicalPortRouter.sync([]).catch(() => undefined);"), true);
  assert.equal(syncBody.includes("await this.logicalPortRouter.sync(logicalPorts).catch(() => undefined);"), true);
  assert.equal(source.includes("releaseLogicalRouterOwnerLease();"), true);
});

test("compose attach waits for routing convergence before returning", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const attachStart = source.indexOf("async attachComposePublishedPorts(input: ComposePublishedPortsInput)");
  const attachEnd = source.indexOf("async detachComposeAttachment", attachStart);
  const attachBody = source.slice(attachStart, attachEnd);
  const convergeStart = source.indexOf("private async convergeAfterComposeAttachmentChange");
  const convergeEnd = source.indexOf("private async convergeDaemonAndRoutingState", convergeStart);
  const convergeBody = source.slice(convergeStart, convergeEnd);

  assert.equal(attachBody.includes("await this.convergeAfterComposeAttachmentChange([refreshedAttachment]);"), true);
  assert.equal(attachBody.includes("await this.convergeAfterComposeAttachmentChange([updatedAttachment]);"), true);
  assert.equal(convergeBody.includes("await this.writeComposeProjectRoutingFile().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.writeTerminalNetworkSelectionFile().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.restorePersistedComposeRoutesIfMissing().catch(() => undefined);"), true);
  assert.equal(convergeBody.includes("await this.convergeDaemonAndRoutingState();"), true);
  assert.equal(convergeBody.includes("await this.refreshContainerServices().catch(() => []);"), true);
  assert.equal(convergeBody.includes("this.localChangeEvents.emit();"), true);
});

test("compose routing rows merge explicit and inferred container mappings", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("function mergeComposeRoutingContainerMappings"), true);
  assert.equal(source.includes("const inferredContainerMappings = inferContainerMappingsFromComposeRoutingFiles"), true);
  assert.equal(source.includes("const containerMappings = mergeComposeRoutingContainerMappings("), true);
  assert.equal(source.includes("!serviceNames.has(mapping.serviceName)"), true);
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
  assert.equal(source.includes("function hasComposePublishedPortListener"), true);
  assert.equal(source.includes("function isComposeRuntimeListener"), true);
  assert.equal(source.includes("hasComposePublishedPortListener(snapshot.listeners, attachment, port)"), true);
  assert.equal(source.includes("const hasRuntimeListener = hasComposePublishedPortListener"), true);
  assert.equal(source.includes("await this.removeComposeRouteProcesses(attachment, [port]);"), true);
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

test("native hook preserves listener ports only for explicit overrides", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("return pm_is_preserved_listen_port(logical_port);"), true);
  assert.equal(source.includes("pm_current_process_looks_like_browser_dev_server"), false);
  assert.equal(source.includes("stable browser alias"), true);
});

test("native hook leaves host loopback outside logical network fallback", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const source = fs.readFileSync(sourcePath, "utf8");
  const matchLevelStart = source.indexOf("static int pm_route_network_match_level");
  const matchLevelEnd = source.indexOf("static int pm_route_is_compose", matchLevelStart);
  const matchLevel = source.slice(matchLevelStart, matchLevelEnd);
  const foreignStart = source.indexOf("static int pm_route_is_foreign_to_current_network");
  const foreignEnd = source.indexOf("static int pm_host_access_lookup", foreignStart);
  const foreign = source.slice(foreignStart, foreignEnd);

  assert.equal(matchLevel.includes("Host loopback"), true);
  assert.equal(matchLevel.includes("return pm_json_string(route_json, \"networkId\", route_network, sizeof(route_network)) != 0 ? 2 : 0;"), true);
  assert.equal(foreign.includes("return 0;"), true);
});

test("native preload repair is opt-in at runtime shim boundaries", () => {
  const hookSourcePath = path.resolve(__dirname, "../../../native/hook/portmanager_hook.c");
  const asdfShimSourcePath = path.resolve(__dirname, "../../../native/asdf-shim/portmanager_asdf_shim.c");
  const hookSource = fs.readFileSync(hookSourcePath, "utf8");
  const asdfShimSource = fs.readFileSync(asdfShimSourcePath, "utf8");

  assert.equal(hookSource.includes('!pm_envp_value_is(envp, "PORT_MANAGER_PRELOAD_REPAIR", "1")'), true);
  assert.equal(hookSource.includes("Runtime/package-bin shims opt into repair"), true);
  assert.equal(asdfShimSource.includes('setenv("PORT_MANAGER_PRELOAD_REPAIR", "1", 1);'), true);
});

test("logical routers are opened only after logical routes are live", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const collectStart = source.indexOf("function collectLogicalRouterPorts");
  const collectEnd = source.indexOf("function isPortManagerLogicalRouterListener", collectStart);
  const collectLogicalRouterPorts = source.slice(collectStart, collectEnd);
  const syncStart = source.indexOf("private async syncLogicalPortRoutersExclusive(): Promise<void>");
  const syncEnd = source.indexOf("private async findClientNetworkForRouter", syncStart);
  const syncBody = source.slice(syncStart, syncEnd);

  assert.equal(source.includes("collectLogicalRouterPorts(snapshot?.routes ?? [], snapshot?.listeners ?? [])"), true);
  assert.equal(source.includes("Scoped network routes are"), true);
  assert.equal(collectLogicalRouterPorts.includes('route.source === "compose"'), false);
  assert.equal(collectLogicalRouterPorts.includes("route.networkId === undefined"), true);
  assert.equal(collectLogicalRouterPorts.includes("route.actualPort !== route.logicalPort"), true);
  assert.equal(collectLogicalRouterPorts.includes("!externallyOwnedPorts.has(route.logicalPort)"), true);
  assert.equal(
    syncBody.includes("await this.logicalPortRouter.sync(logicalPorts).catch(() => undefined);"),
    true,
    "unscoped host routes can still expose a localhost TCP router fallback",
  );
});

test("logical router classifies clients by process tree label before hook environment fallback", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const methodStart = source.indexOf("private async findClientNetworkForRouter");
  const methodEnd = source.indexOf("private async findNetworkRouteForRouter", methodStart);
  const findClientNetworkForRouter = source.slice(methodStart, methodEnd);
  const hostRouteStart = source.indexOf("private findHostRouteForRouter");
  const hostRouteEnd = source.indexOf("private findAttachedNetworkForPid", hostRouteStart);
  const findHostRouteForRouter = source.slice(hostRouteStart, hostRouteEnd);
  const resolverStart = source.indexOf("private async resolveLogicalPortRouterTarget");
  const resolverEnd = source.indexOf("private async syncLogicalPortRouters", resolverStart);
  const resolveLogicalPortRouterTarget = source.slice(resolverStart, resolverEnd);

  assert.equal(source.includes('from "../core/process-network-labels"'), true);
  assert.equal(
    findClientNetworkForRouter.indexOf("this.findAttachedNetworkForPid(pid, processRows)") <
      findClientNetworkForRouter.indexOf("this.processEnvironmentProvider.readRoutingNetworkId(pid)"),
    true,
    "process tree labels must be the primary router signal; inherited hook env remains fallback",
  );
  assert.equal(findClientNetworkForRouter.includes("return environmentNetworkId;"), true);
  assert.equal(source.includes("including a Compose route"), false);
  assert.equal(source.includes("private async findUniqueRouteForRouter"), false);
  assert.equal(source.includes("private findClientCwdRouteForRouter"), false);
  assert.equal(resolveLogicalPortRouterTarget.includes("No host route found for localhost"), true);
  assert.equal(source.includes("function isNetworkScopedComposeRoute"), false);
  assert.equal(source.includes("findSingleAttachedRouteForRouter"), false);
  assert.equal(source.includes("this.findHostRouteForRouter(connection.logicalPort)"), true);
  assert.equal(findHostRouteForRouter.includes("route.networkId === undefined"), true);
  assert.equal(findHostRouteForRouter.includes("route.actualPort !== route.logicalPort"), true);
  assert.equal(source.includes("findRoutesMatchingClientCwd"), false);
});

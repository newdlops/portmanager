import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/*
 * Shape tests pinning the idle/cold-start resource optimizations:
 * quiet workspaces must not keep spawning process scans, Docker CLI calls,
 * ifconfig probes, or shim-directory rebuilds, and multi-window cold starts
 * must not repeat per-window work whose inputs did not change.
 */

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../", relativePath), "utf8");
}

test("routing signal loop backs off while quiet and snaps back on activity", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("ROUTING_SIGNAL_REFRESH_MAX_INTERVAL_MS = 60_000"), true);
  assert.equal(source.includes("ROUTING_SIGNAL_REFRESH_DEGRADED_MAX_INTERVAL_MS = 30_000"), true);
  assert.equal(source.includes("private scheduleNextRoutingSignalRefresh(): void"), true);
  assert.equal(source.includes("private updateRoutingSignalRefreshDelay(): void"), true);
  assert.equal(source.includes("private buildRoutingActivitySignature(): string"), true);
  assert.equal(source.includes("private notifyRoutingActivity("), true);

  // The loop is a self-rescheduling timeout, not a fixed interval.
  const loopStart = source.indexOf("private startRoutingSignalRefreshLoop(): void");
  const loopEnd = source.indexOf("private updateRoutingSignalRefreshDelay", loopStart);
  const loopBody = source.slice(loopStart, loopEnd);
  assert.equal(loopBody.includes("setInterval"), false);
  assert.equal(loopBody.includes("this.scheduleNextRoutingSignalRefresh();"), true);

  // Activity signals feed the fast-cadence reset from every relevant source.
  assert.equal(source.includes("this.registry.onDidChange(() => {"), true);
  const registryChangeStart = source.indexOf("this.registry.onDidChange(() => {");
  const registryChangeBody = source.slice(registryChangeStart, registryChangeStart + 400);
  assert.equal(registryChangeBody.includes("this.notifyRoutingActivity();"), true);
});

test("compose routing freshness is decoupled from the heavy reconcile loop", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("COMPOSE_ROUTING_FRESHNESS_INTERVAL_MS = 10_000"), true);
  assert.equal(source.includes("private syncComposeRoutingFreshnessHeartbeat(): void"), true);
  assert.equal(source.includes("private async touchComposeRoutingFreshnessPaths(): Promise<void>"), true);
  assert.equal(source.includes("this.composeRoutingFreshnessPaths = freshnessPaths;"), true);

  // The heartbeat only touches mtimes; it must not run docker or rebuild rows.
  const touchStart = source.indexOf("private async touchComposeRoutingFreshnessPaths");
  const touchEnd = source.indexOf("private syncContainerEventsWatcher", touchStart);
  const touchBody = source.slice(touchStart, touchEnd);
  assert.equal(touchBody.includes("fs.utimes"), true);
  assert.equal(touchBody.includes("containerServiceDiscovery"), false);
});

test("container discovery idles without consumers and wakes through lifecycle events", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("private hasBackgroundContainerDiscoveryConsumers(): boolean"), true);
  assert.equal(source.includes("setSidebarVisible(visible: boolean): void"), true);
  assert.equal(source.includes("private syncContainerEventsWatcher(): void"), true);
  assert.equal(source.includes("private async handleContainerRuntimeEvent(): Promise<void>"), true);
  assert.equal(source.includes("readContainerEventsWatchEnabled()"), true);

  const refreshStart = source.indexOf("async refreshContainerServices(");
  const refreshEnd = source.indexOf("private hasBackgroundContainerDiscoveryConsumers", refreshStart);
  const refreshBody = source.slice(refreshStart, refreshEnd);
  assert.equal(
    refreshBody.includes("!this.hasBackgroundContainerDiscoveryConsumers()"),
    true,
    "background container refresh must skip when nothing consumes candidates",
  );

  // Compose reconcile must not poke the daemon on empty background ticks.
  const reconcileStart = source.indexOf("private async reconcileComposeAttachmentPublishedPortsExclusive");
  const reconcileEnd = source.indexOf("private async refreshComposeContainerMappings", reconcileStart);
  const reconcileBody = source.slice(reconcileStart, reconcileEnd);
  assert.equal(
    reconcileBody.indexOf("options.background === true &&") < reconcileBody.indexOf("await this.refreshComposeRouteProcessSnapshot();"),
    true,
  );

  const activateSource = readSource("src/extension/activate.ts");
  assert.equal(activateSource.includes("networkService.setSidebarVisible(treeView.visible);"), true);
  assert.equal(activateSource.includes("treeView.onDidChangeVisibility"), true);
});

test("background terminal discovery skips scans without consumers", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("private hasBackgroundTerminalDiscoveryConsumers(): boolean"), true);
  const refreshStart = source.indexOf("async refreshTerminals(options: BackgroundRefreshOptions = {})");
  const refreshEnd = source.indexOf("private hasBackgroundTerminalDiscoveryConsumers", refreshStart);
  const refreshBody = source.slice(refreshStart, refreshEnd);
  assert.equal(refreshBody.includes("!this.hasBackgroundTerminalDiscoveryConsumers()"), true);

  // User-facing pickers must refresh in the foreground before listing windows.
  const commandsSource = readSource("src/extension/commands.ts");
  const resolverStart = commandsSource.indexOf("private async resolveTerminalWindowArgument");
  const resolverBody = commandsSource.slice(resolverStart, resolverStart + 900);
  assert.equal(
    resolverBody.includes("refreshTerminals({ force: true, allowPlatformAutomation: true })"),
    true,
  );
});

test("owner lease renewals are throttled below the lease period", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("OWNER_LEASE_RENEW_INTERVAL_MS = 25_000"), true);
  assert.equal(source.includes("function isOwnOwnerLeaseRenewalCurrent"), true);
  assert.equal(
    source.includes("isOwnOwnerLeaseRenewalCurrent(owner, nowMs) || writeControlPlaneOwnerLease(nowMs)"),
    true,
  );
  assert.equal(
    source.includes("isOwnOwnerLeaseRenewalCurrent(owner, nowMs) || writeLogicalRouterOwnerLease(nowMs)"),
    true,
  );
  assert.equal(
    source.includes("isOwnOwnerLeaseRenewalCurrent(owner, nowMs) || writeBrowserNetworkProxyOwnerLease(nowMs)"),
    true,
  );
});

test("marker polling is stat-only and slows outside refresh bursts", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("TERMINAL_ATTACHMENT_MARKER_POLL_IDLE_INTERVAL_MS = 2_000"), true);
  assert.equal(source.includes("private scheduleNextTerminalAttachmentMarkerPoll(): void"), true);

  const readStateStart = source.indexOf("private async readTerminalAttachmentMarkerState()");
  const readStateEnd = source.indexOf("/** Rewrites compose route rows", readStateStart);
  const readStateBody = source.slice(readStateStart, readStateEnd);
  assert.equal(
    readStateBody.includes("previousRow !== undefined && previousRow.signature === signature"),
    true,
    "unchanged markers must reuse previous rows instead of rereading file contents",
  );
});

test("loopback alias checks share one cached ifconfig read with failure backoff", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("LOOPBACK_ALIAS_CACHE_TTL_MS = 5_000"), true);
  assert.equal(source.includes("LOOPBACK_ALIAS_SETUP_RETRY_BACKOFF_MS = 300_000"), true);
  assert.equal(source.includes("function parseLoopbackAliasAddresses"), true);
  assert.equal(source.includes("function invalidateLoopbackAliasCache"), true);
  assert.equal(source.includes("async function isLoopbackAddressAliasConfiguredAsync"), true);
  assert.equal(source.includes("loopbackAliasSetupBackoffUntilMsByAddress"), true);
  assert.equal(source.includes('execFileSync("ifconfig"'), false);
  assert.equal(source.includes("function readCachedLoopbackAliasAddresses"), true);
  assert.equal(source.includes("private browserDnsAliasStatusRefreshInFlight: Promise<void> | undefined;"), true);
  assert.equal(source.includes("private warmBrowserDnsAliasStatus(): void"), true);

  // Activation-path alias checks must not block the event loop.
  const ensureStart = source.indexOf("async function ensureLoopbackAddressRoutingHostReady");
  const ensureEnd = source.indexOf("function buildLoopbackAliasSetupScript", ensureStart);
  const ensureBody = source.slice(ensureStart, ensureEnd);
  assert.equal(ensureBody.includes("await isLoopbackAddressAliasConfiguredAsync(address)"), true);

  // Tree-render status reads reuse stat-validated system config caches.
  assert.equal(source.includes("function readTextFileWithStatCache"), true);
  assert.equal(source.includes("readTextFileWithStatCache(\"/etc/hosts\")"), true);

  const statusStart = source.indexOf("getBrowserDnsResolverStatus(): BrowserDnsResolverStatus");
  const statusEnd = source.indexOf("/** Installs macOS resolver rows", statusStart);
  const statusBody = source.slice(statusStart, statusEnd);
  assert.equal(statusBody.includes("this.warmBrowserDnsAliasStatus();"), true);
  assert.equal(statusBody.includes("if (this.browserDnsAliasStatusRefreshInFlight !== undefined)"), true);
  assert.equal(statusBody.includes("this.localChangeEvents.emit();"), true);
  assert.equal(statusBody.includes("execFileSync"), false);
});

test("shell hook assets skip rebuilds when their inputs are unchanged", () => {
  const hookSource = readSource("src/extension/terminal-hook-environment.ts");

  assert.equal(hookSource.includes("RUNTIME_SHIM_STAMP_FILE_NAME = \".portmanager-shim-stamp\""), true);
  assert.equal(hookSource.includes("function buildRuntimeShimDirectorySignature"), true);
  assert.equal(hookSource.includes("function runtimeShimDirectoryMatchesStamp"), true);
  assert.equal(
    hookSource.includes("options.force !== true && runtimeShimDirectoryMatchesStamp(targetDirectory, stampSignature)"),
    true,
  );

  const restoreStart = hookSource.indexOf("export function prepareShellEnvRestoreScript");
  const restoreEnd = hookSource.indexOf("/** Adds generated runtime launchers", restoreStart);
  const restoreBody = hookSource.slice(restoreStart, restoreEnd);
  assert.equal(restoreBody.includes("if (fs.readFileSync(targetPath, \"utf8\") === contents)"), true);

  const commandsSource = readSource("src/extension/commands.ts");
  assert.equal(commandsSource.includes("existingHookScript !== hookScriptContents"), true);
  assert.equal(commandsSource.includes("await this.writeShellHookAssets(context, { force: true });"), true);
});

test("owner startup defers container probing out of the activation burst", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("OWNER_STARTUP_CONTAINER_PROBE_DELAY_MS = 3_000"), true);
  assert.equal(source.includes("private scheduleDeferredOwnerStartupProbes(): void"), true);
  assert.equal(source.includes("async ensureContainerRuntimeDetected(): Promise<void>"), true);

  const commandsSource = readSource("src/extension/commands.ts");
  assert.equal(commandsSource.includes("await this.dependencies.networkService.ensureContainerRuntimeDetected();"), true);
});

test("idle agent daemon skips periodic listener scans with no clients or state", () => {
  const source = readSource("src/agent/port-manager-agent.ts");

  assert.equal(source.includes("private shouldSkipIdleListenerScan(): boolean"), true);
  const pollingStart = source.indexOf("private startListenerPolling(): void");
  const pollingEnd = source.indexOf("private startRouteTableHeartbeat", pollingStart);
  const pollingBody = source.slice(pollingStart, pollingEnd);
  assert.equal(pollingBody.includes("if (this.shouldSkipIdleListenerScan())"), true);

  const skipStart = source.indexOf("private shouldSkipIdleListenerScan(): boolean");
  const skipBody = source.slice(skipStart, skipStart + 700);
  assert.equal(skipBody.includes("!this.hasEventClients()"), true);
  assert.equal(skipBody.includes("this.registry.list().length === 0"), true);
  assert.equal(skipBody.includes("this.pendingRouteAllocations.size === 0"), true);
  assert.equal(skipBody.includes("this.reservedListeningEndpoints.length === 0"), true);
});

test("register-triggered broadcasts publish from cached listeners before fresh scans", () => {
  const source = readSource("src/agent/port-manager-agent.ts");

  // Route rows gate the logical port gateway open, so the register-triggered
  // broadcast must not wait for an lsof-scale scan: fast pass from any-age
  // cached listeners first, then a fresh-scan rebuild reconciles in the same
  // flush. Without this, a one-shot client (an OAuth loopback redirect) dials
  // localhost seconds before the gateway exists and is refused.
  const flushStart = source.indexOf("private async flushQueuedSnapshotBroadcast");
  const flushEnd = source.indexOf("private hasEventClients", flushStart);
  const flushBody = source.slice(flushStart, flushEnd);
  assert.equal(flushBody.includes("allowStaleListenerCache: hasCachedListeners"), true);
  assert.equal(
    flushBody.indexOf("allowStaleListenerCache: hasCachedListeners") <
      flushBody.indexOf("const freshSnapshot = await this.buildSnapshot({ allowRecentListenerCache: true })"),
    true,
    "the cached-listener fast pass must broadcast before the fresh-scan rebuild",
  );

  // The stale branch answers before both the recency check and the in-flight
  // scan join, so the fast pass can never block behind a running scan.
  const scanStart = source.indexOf("private async scanListeningPorts(");
  const scanEnd = source.indexOf("private async scanListeningPortsForPort", scanStart);
  const scanBody = source.slice(scanStart, scanEnd);
  const staleBranchAt = scanBody.indexOf("options.allowStaleCache === true");
  assert.equal(staleBranchAt >= 0, true);
  assert.equal(staleBranchAt < scanBody.indexOf("options.allowRecentCache === true"), true);
  assert.equal(staleBranchAt < scanBody.indexOf("this.listenerScanPromise !== undefined"), true);

  // The fast pass also defers the established-connection lsof pass to the
  // fresh rebuild.
  assert.equal(
    source.includes(
      "options.skipEstablishedRouteObservations !== true &&\n      (await this.refreshEstablishedRouteObservations(snapshot.routes))",
    ),
    true,
  );
});

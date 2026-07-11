import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/*
 * Shape tests pinning admin-prompt consolidation: one osascript approval must
 * prepare every logical network (terminal and browser loopback aliases plus
 * the browser DNS/TLS setup), and every prompt names the network or action
 * that triggered it.
 */

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../", relativePath), "utf8");
}

test("admin prompts name the triggering network and cover all networks", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("function formatNetworkNameList"), true);
  assert.equal(source.includes("function buildNetworkAdminSetupPromptMessage"), true);

  const messageStart = source.indexOf("function buildNetworkAdminSetupPromptMessage");
  const messageBody = source.slice(messageStart, messageStart + 1200);
  assert.equal(messageBody.includes("input.triggerDescription"), true);
  assert.equal(messageBody.includes("formatNetworkNameList(input.networkNames)"), true);
  assert.equal(messageBody.includes("This single approval configures"), true);
});

test("interactive attach runs one consolidated setup for every network", () => {
  const source = readSource("src/extension/network-service.ts");

  const ensureStart = source.indexOf("async ensureTerminalRoutingHostReadyForNetwork(");
  const ensureEnd = source.indexOf("private async installBrowserDnsResolversExclusive", ensureStart);
  const ensureBody = source.slice(ensureStart, ensureEnd < 0 ? ensureStart + 4000 : ensureEnd);

  assert.notEqual(ensureStart, -1);
  // The prompt names the attached network and the script prepares all of them.
  assert.equal(ensureBody.includes('terminal routing was attached to logical network "${network.name}"'), true);
  assert.equal(ensureBody.includes("this.collectTerminalLoopbackAddresses()"), true);
  assert.equal(ensureBody.includes("additionalLoopbackAddresses"), true);
  // A full setup approval must silence the background install offer afterwards.
  assert.equal(ensureBody.includes("this.clearBrowserDnsInstallOfferSignature();"), true);

  // Both interactive attach flows use the consolidated path.
  assert.equal(source.includes("await this.ensureTerminalRoutingHostReadyForNetwork(\n      network,"), true);
  assert.equal(source.includes("await this.ensureTerminalRoutingHostReadyForNetwork(network, loopbackMode);"), true);
  // The per-address helper keeps only its silent, promptless path.
  const helperStart = source.indexOf("async function ensureLoopbackAddressRoutingHostReady");
  const helperBody = source.slice(helperStart, source.indexOf("function buildLoopbackAliasSetupScript", helperStart));
  assert.equal(helperBody.includes("runShellScriptWithAdministratorPrivileges"), false);
});

test("browser DNS install covers terminal aliases and names missing networks", () => {
  const source = readSource("src/extension/network-service.ts");

  const installStart = source.indexOf("private async installBrowserDnsResolversExclusive");
  const installBody = source.slice(installStart, installStart + 3000);
  assert.equal(installBody.includes("additionalLoopbackAddresses: this.collectTerminalLoopbackAddresses()"), true);
  assert.equal(installBody.includes("browser alias setup is missing for logical network"), true);
  assert.equal(installBody.includes("buildNetworkAdminSetupPromptMessage"), true);

  // The setup script builder accepts extra loopback addresses to ride along.
  const scriptStart = source.indexOf("function buildBrowserDnsResolverSetupScript");
  const scriptBody = source.slice(scriptStart, scriptStart + 2200);
  assert.equal(scriptBody.includes("additionalLoopbackAddresses?: readonly string[]"), true);
  assert.equal(scriptBody.includes("options.additionalLoopbackAddresses ?? []"), true);

  // Repair and renewal pass their own trigger descriptions.
  assert.equal(source.includes('"a browser TLS certificate renewal was requested"'), true);
  assert.equal(source.includes("needs repair (${record.tlsStatusDetail"), true);
});

test("background DNS reconciliation cannot open administrator authorization", () => {
  const source = readSource("src/extension/network-service.ts");
  const offerStart = source.indexOf("private maybeOfferBrowserDnsResolverInstall(): void");
  const offerEnd = source.indexOf("private rememberBrowserDnsInstallOfferSignature", offerStart);
  const offerBody = source.slice(offerStart, offerEnd);
  const selectionGuardIndex = offerBody.indexOf("if (selection !== installAction) {");
  const privilegedInstallIndex = offerBody.indexOf("void this.installBrowserDnsResolvers({");
  const automaticBodies = [
    source.slice(
      source.indexOf("private async startControlPlaneOwnerServices"),
      source.indexOf("  /** Runs container-runtime probing", source.indexOf("private async startControlPlaneOwnerServices")),
    ),
    source.slice(
      source.indexOf("private async runControlPlaneRegistrySideEffects"),
      source.indexOf("  /** Stops owner-only automatic work", source.indexOf("private async runControlPlaneRegistrySideEffects")),
    ),
    source.slice(
      source.indexOf("private async rehydrateBrowserDnsAndProxies"),
      source.indexOf("  /** Lists generated files", source.indexOf("private async rehydrateBrowserDnsAndProxies")),
    ),
    source.slice(
      source.indexOf("private async refreshRoutingSignalsExclusive"),
      source.indexOf("private syncComposeRoutingFreshnessHeartbeat", source.indexOf("private async refreshRoutingSignalsExclusive")),
    ),
  ];

  assert.notEqual(offerStart, -1);
  assert.notEqual(offerEnd, -1);
  assert.equal(offerBody.includes("vscode.window\n      .showInformationMessage("), true);
  assert.equal(selectionGuardIndex >= 0, true);
  assert.equal(selectionGuardIndex < privilegedInstallIndex, true);
  assert.doesNotMatch(source, /installBrowserDnsResolvers\(\{\s*automatic:\s*true/);
  assert.equal(source.includes("maybeAutoInstallBrowserDnsResolvers"), false);
  assert.equal(source.includes("maybeOfferBrowserDnsResolverInstall"), true);
  for (const automaticBody of automaticBodies) {
    assert.equal(automaticBody.includes("runShellScriptWithAdministratorPrivileges("), false);
    assert.equal(automaticBody.includes("installBrowserDnsResolvers("), false);
    assert.equal(automaticBody.includes("allowAdministratorPrompt: true"), false);
  }
});

test("background terminal discovery cannot request macOS Automation access", () => {
  const source = readSource("src/extension/network-service.ts");
  const providerSource = readSource("src/platform/process/node-terminal-candidate-provider.ts");
  const commandsSource = readSource("src/extension/commands.ts");
  const providerListStart = providerSource.indexOf("async list(options: TerminalCandidateListOptions = {})");
  const providerListEnd = providerSource.indexOf("interface PosixProcessRow", providerListStart);
  const providerListBody = providerSource.slice(providerListStart, providerListEnd);
  const automationGuardIndex = providerListBody.indexOf("if (options.allowPlatformAutomation === true) {");
  const titleLookupIndex = providerListBody.indexOf("await listTerminalTitlesByTty()");
  const refreshStart = source.indexOf("async refreshTerminals(options: BackgroundRefreshOptions = {})");
  const refreshEnd = source.indexOf("  /** True when background terminal discovery", refreshStart);
  const refreshBody = source.slice(refreshStart, refreshEnd);
  const automationLatchIndex = refreshBody.indexOf("this.terminalPlatformAutomationQueued = true;");
  const inFlightIndex = refreshBody.indexOf("if (this.terminalRefreshInFlight !== undefined) {");

  assert.notEqual(providerListStart, -1);
  assert.equal(automationGuardIndex >= 0, true);
  assert.equal(automationGuardIndex < titleLookupIndex, true);
  assert.equal(providerListBody.includes("listPosixTerminals(this.terminalTitleByTerminalId)"), true);
  assert.equal(source.includes("private terminalPlatformAutomationQueued = false;"), true);
  assert.equal(automationLatchIndex >= 0, true);
  assert.equal(automationLatchIndex < inFlightIndex, true);
  assert.equal(
    source.includes("this.terminalRefreshQueued || this.terminalPlatformAutomationQueued"),
    true,
  );
  assert.equal(
    commandsSource.includes("refreshTerminals({ force: true, allowPlatformAutomation: true })"),
    true,
  );
  assert.equal(
    commandsSource.includes("refreshTerminals({ allowPlatformAutomation: true })"),
    true,
  );
});

test("background packet-filter reconciliation requires an explicit user gesture and preserves queued gestures", () => {
  const source = readSource("src/extension/network-service.ts");
  const proxySyncStart = source.indexOf("private async syncBrowserNetworkProxies(");
  const proxySyncEnd = source.indexOf("private async syncBrowserNetworkProxiesExclusive", proxySyncStart);
  const proxySyncBody = source.slice(proxySyncStart, proxySyncEnd);
  const redirectSyncStart = source.indexOf("private async syncHostLocalGatewayRedirects(");
  const redirectSyncEnd = source.indexOf("  /** Wrapper-launched dev servers", redirectSyncStart);
  const redirectSyncBody = source.slice(redirectSyncStart, redirectSyncEnd);
  const manualRefreshStart = source.indexOf("async refreshNetworkRoutingState(): Promise<void>");
  const manualRefreshEnd = source.indexOf("private async refreshContainerServicesExclusive", manualRefreshStart);
  const manualRefreshBody = source.slice(manualRefreshStart, manualRefreshEnd);
  const backgroundRefreshStart = source.indexOf("private async refreshRoutingSignalsExclusive");
  const backgroundRefreshEnd = source.indexOf("private syncComposeRoutingFreshnessHeartbeat", backgroundRefreshStart);
  const backgroundRefreshBody = source.slice(backgroundRefreshStart, backgroundRefreshEnd);
  const removeNetworkStart = source.indexOf("async removeNetwork(networkId: string)");
  const removeNetworkEnd = source.indexOf("  /** Refreshes VS Code and external OS terminal windows", removeNetworkStart);
  const removeNetworkBody = source.slice(removeNetworkStart, removeNetworkEnd);
  const administratorGuardIndex = redirectSyncBody.indexOf("if (options.allowAdministratorPrompt !== true) {");
  const signatureIndex = redirectSyncBody.indexOf("this.hostLocalGatewayRedirectInstallSignature = signature;");
  const administratorScriptIndex = redirectSyncBody.indexOf("runShellScriptWithAdministratorPrivileges(");
  const latchIndex = proxySyncBody.indexOf("this.browserProxyAdministratorPromptQueued = true;");
  const inFlightIndex = proxySyncBody.indexOf("if (this.browserProxySyncInFlight !== undefined) {");
  const captureIndex = proxySyncBody.indexOf("const allowAdministratorPrompt = this.browserProxyAdministratorPromptQueued;");
  const clearIndex = proxySyncBody.indexOf("this.browserProxyAdministratorPromptQueued = false;", captureIndex);
  const exclusiveIndex = proxySyncBody.indexOf(
    "await this.syncBrowserNetworkProxiesExclusive({ allowAdministratorPrompt });",
    clearIndex,
  );
  const removeMutationIndex = removeNetworkBody.indexOf("const removedNetwork = this.registry.removeNetwork(networkId);");
  const removeSyncIndex = removeNetworkBody.indexOf(
    "await this.syncBrowserNetworkProxies({ allowAdministratorPrompt: true })",
  );
  const removeReturnIndex = removeNetworkBody.indexOf("return removedNetwork;");

  assert.notEqual(proxySyncStart, -1);
  assert.notEqual(proxySyncEnd, -1);
  assert.notEqual(redirectSyncStart, -1);
  assert.notEqual(redirectSyncEnd, -1);
  assert.equal(source.includes("private browserProxyAdministratorPromptQueued = false;"), true);
  assert.equal(proxySyncBody.includes("this.browserProxyAdministratorPromptQueued = true;"), true);
  assert.equal(latchIndex < inFlightIndex, true);
  assert.equal(captureIndex < clearIndex && clearIndex < exclusiveIndex, true);
  assert.equal(
    proxySyncBody.includes("this.browserProxySyncQueued || this.browserProxyAdministratorPromptQueued"),
    true,
  );
  assert.equal(administratorGuardIndex >= 0, true);
  assert.equal(administratorGuardIndex < signatureIndex, true);
  assert.equal(signatureIndex < administratorScriptIndex, true);
  assert.equal(
    source.includes("await this.syncHostLocalGatewayRedirects(hostLocalGatewayRedirects, options);"),
    true,
    "the browser sync coalescer must remain active until authorization finishes",
  );
  assert.equal(source.includes("void this.syncHostLocalGatewayRedirects(hostLocalGatewayRedirects, options);"), false);
  assert.equal(
    redirectSyncBody.includes(".catch(() => {") &&
      redirectSyncBody.includes("this.hostLocalGatewayRedirectInstallSignature = undefined;"),
    true,
    "cancelled macOS authorization must be absorbed while allowing the next explicit retry",
  );
  assert.equal(
    manualRefreshBody.includes("this.syncBrowserNetworkProxies({ allowAdministratorPrompt: true })"),
    true,
  );
  assert.equal(backgroundRefreshBody.includes("allowAdministratorPrompt"), false);
  assert.equal(source.includes("HOST_LOCAL_GATEWAY_EMPTY_REDIRECT_STABLE_MS"), false);
  assert.equal(source.includes("hostLocalGatewayEmptyRedirectSinceMs"), false);
  assert.equal(redirectSyncBody.includes("buildHostLocalGatewayRedirectSetupScript(redirects)"), true);
  assert.equal(
    removeMutationIndex < removeSyncIndex && removeSyncIndex < removeReturnIndex,
    true,
    "an explicit last-network removal must clear PF rules after the registry mutation",
  );
});

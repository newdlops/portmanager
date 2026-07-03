import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/*
 * Shape tests pinning the dev TLS renewal architecture: expiry-aware staleness
 * per network alias, a manual renewal command, `pm repair` terminal renewal,
 * and per-record repair actions in the sidebar.
 */

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../", relativePath), "utf8");
}

test("TLS staleness is expiry-aware and computed per alias", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("function readBrowserTlsCertificateState"), true);
  assert.equal(source.includes("new X509Certificate(pem)"), true);
  assert.equal(source.includes("BROWSER_TLS_RENEW_WINDOW_MS"), true);
  assert.equal(source.includes("function browserTlsStateCoversRecord"), true);
  assert.equal(source.includes("function buildBrowserTlsStatusDetail"), true);

  const statusStart = source.indexOf("function buildBrowserDnsResolverStatus");
  const statusEnd = source.indexOf("function buildBrowserDnsAliasRouteStatus", statusStart);
  const statusBody = source.slice(statusStart, statusEnd);
  assert.equal(statusBody.includes("readBrowserTlsCertificateState(nowMs)"), true);
  assert.equal(statusBody.includes("tlsStale"), true);
  assert.equal(statusBody.includes("tlsStaleCount"), true);
  assert.equal(statusBody.includes("tlsValidTo"), true);

  // The https-scheme choice must treat an expired certificate as unconfigured.
  const configuredStart = source.indexOf("function isBrowserTlsCertificateConfigured");
  const configuredBody = source.slice(configuredStart, configuredStart + 600);
  assert.equal(configuredBody.includes("state.expired"), true);

  const typesSource = readSource("src/shared/types.ts");
  assert.equal(typesSource.includes("readonly tlsStale: boolean;"), true);
  assert.equal(typesSource.includes("readonly tlsStatusDetail?: string;"), true);
  assert.equal(typesSource.includes("readonly tlsStaleCount: number;"), true);
});

test("install script renews expiring certificates and supports forced renewal", () => {
  const source = readSource("src/extension/network-service.ts");

  const installStart = source.indexOf("function appendBrowserTlsCertificateInstallLines");
  const installEnd = source.indexOf("function appendBrowserDnsHostsCleanupLines", installStart);
  const installBody = source.slice(installStart, installEnd);

  // The leaf is reissued when it enters the renewal window or its CA rotated,
  // not only when the hostname set changes.
  assert.equal(installBody.includes("openssl x509 -checkend ${BROWSER_TLS_RENEW_WINDOW_SECONDS}"), true);
  assert.equal(installBody.includes("__pm_tls_ca_rotated"), true);
  assert.equal(installBody.includes("options.forceTlsRenewal === true"), true);
  assert.equal(installBody.includes('rm -f "$__pm_tls_server_cert" "$__pm_tls_server_key" "$__pm_tls_hosts_file"'), true);

  // Forced renewal bypasses the everything-configured early return.
  const exclusiveStart = source.indexOf("private async installBrowserDnsResolversExclusive");
  const exclusiveBody = source.slice(exclusiveStart, exclusiveStart + 1800);
  assert.equal(exclusiveBody.includes("status.missingCount === 0 && options.forceTlsRenewal !== true"), true);
  assert.equal(exclusiveBody.includes("forceTlsRenewal: options.forceTlsRenewal === true,"), true);

  assert.equal(source.includes("async renewBrowserTlsCertificate(): Promise<BrowserDnsResolverStatus>"), true);
  assert.equal(source.includes("async repairBrowserDnsAlias(networkId: string): Promise<BrowserDnsResolverStatus>"), true);
});

test("pm repair renews a stale certificate from the terminal", () => {
  const commandsSource = readSource("src/extension/commands.ts");

  // The standalone renewal script is written next to the shell hook assets.
  assert.equal(commandsSource.includes("portmanager-renew-browser-tls.sh"), true);
  assert.equal(commandsSource.includes("buildBrowserTlsRenewalShellScript()"), true);
  assert.equal(commandsSource.includes("tlsRenewalScriptPath"), true);

  // The hook sources the stale-check functions and repair runs them first.
  assert.equal(commandsSource.includes("buildBrowserTlsRepairShellFunctions(options.tlsRenewalScriptPath)"), true);
  assert.equal(commandsSource.includes("${browserTlsRepairFunctions}__pm_repair() {"), true);
  assert.equal(commandsSource.includes("${browserTlsRepairCall}  __pm_current_id="), true);

  // Manual renewal and per-record repair are registered commands.
  assert.equal(commandsSource.includes('"portManager.renewBrowserTlsCertificate"'), true);
  assert.equal(commandsSource.includes('"portManager.repairBrowserDnsRecord"'), true);

  const manifest = readSource("package.json");
  assert.equal(manifest.includes('"command": "portManager.renewBrowserTlsCertificate"'), true);
});

test("sidebar surfaces per-network TLS staleness with repair actions", () => {
  const treeSource = readSource("src/ui/sidebar/port-manager-tree.ts");

  const recordRowsStart = treeSource.indexOf("function buildBrowserDnsRecordRows");
  const recordRowsBody = treeSource.slice(recordRowsStart, recordRowsStart + 2600);
  assert.equal(recordRowsBody.includes("record.tlsStatusDetail"), true);
  assert.equal(recordRowsBody.includes("record.tlsStale || !record.configured"), true);
  assert.equal(recordRowsBody.includes('"portManager.repairBrowserDnsRecord"'), true);
  assert.equal(recordRowsBody.includes("{ networkId: record.networkId }"), true);

  const sectionStart = treeSource.indexOf("function buildBrowserDnsDiagnosticRows");
  const sectionBody = treeSource.slice(sectionStart, treeSource.indexOf("function buildBrowserDnsRecordRows", sectionStart));
  assert.equal(sectionBody.includes('"portManager.renewBrowserTlsCertificate"'), true);
  assert.equal(sectionBody.includes("tlsStaleCount"), true);
});

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
  // A full setup approval must silence the automatic installer afterwards.
  assert.equal(ensureBody.includes("this.clearBrowserDnsAutoInstallSignature();"), true);

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

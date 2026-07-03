import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { BrowserDnsServer, normalizeBrowserDnsHostname } from "../../src/platform/network/browser-dns-server";

test("normalizes network names into single-label DNS hostnames", () => {
  assert.equal(normalizeBrowserDnsHostname("alpha1"), "alpha1");
  assert.equal(normalizeBrowserDnsHostname("Migration T1"), "migration-t1");
  assert.equal(normalizeBrowserDnsHostname(" fix/payroll_employee "), "fix-payroll-employee");
  assert.equal(normalizeBrowserDnsHostname("!!!"), undefined);
});

test("answers A records for configured browser aliases", async () => {
  const server = new BrowserDnsServer({ port: 0 });
  await server.start();
  server.sync([
    { hostname: "alpha1", address: "127.98.202.69" },
    { hostname: "alpha1.pm", address: "127.98.202.69" },
  ]);

  try {
    const response = await queryDns(server.getPort(), buildQuery("alpha1"));
    const dottedResponse = await queryDns(server.getPort(), buildQuery("alpha1.pm"));

    assert.equal(response.readUInt16BE(0), 0x1234);
    assert.equal(response.readUInt16BE(6), 1);
    assert.deepEqual([...response.subarray(response.length - 4)], [127, 98, 202, 69]);
    assert.equal(dottedResponse.readUInt16BE(6), 1);
    assert.deepEqual([...dottedResponse.subarray(dottedResponse.length - 4)], [127, 98, 202, 69]);
  } finally {
    server.dispose();
  }
});

test("replaces stale A records when browser aliases are synced again", async () => {
  const server = new BrowserDnsServer({ port: 0 });
  await server.start();
  server.sync([{ hostname: "alpha1", address: "127.98.202.69" }]);
  server.sync([{ hostname: "alpha1", address: "127.112.19.42" }]);

  try {
    const response = await queryDns(server.getPort(), buildQuery("alpha1"));

    assert.equal(response.readUInt16BE(6), 1);
    assert.deepEqual([...response.subarray(response.length - 4)], [127, 112, 19, 42]);
  } finally {
    server.dispose();
  }
});

test("returns NXDOMAIN for unknown browser aliases", async () => {
  const server = new BrowserDnsServer({ port: 0 });
  await server.start();
  server.sync([{ hostname: "alpha1", address: "127.98.202.69" }]);

  try {
    const response = await queryDns(server.getPort(), buildQuery("missing"));

    assert.equal(response.readUInt16BE(2) & 0x0f, 3);
    assert.equal(response.readUInt16BE(6), 0);
  } finally {
    server.dispose();
  }
});

test("browser DNS resolver install is UI-driven and cleans only owned resolver files", () => {
  const root = path.resolve(__dirname, "../../..");
  const networkServiceSource = fs.readFileSync(path.join(root, "src/extension/network-service.ts"), "utf8");
  const commandSource = fs.readFileSync(path.join(root, "src/extension/commands.ts"), "utf8");
  const treeSource = fs.readFileSync(path.join(root, "src/ui/sidebar/port-manager-tree.ts"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    activationEvents?: string[];
    contributes?: { commands?: { command: string }[] };
  };

  assert.equal(networkServiceSource.includes("# Port Manager browser DNS resolver"), true);
  assert.equal(networkServiceSource.includes("# Port Manager browser DNS hosts begin"), true);
  assert.equal(networkServiceSource.includes("isBrowserDnsHostsEntryConfigured"), true);
  assert.equal(networkServiceSource.includes("hostsConfigured"), true);
  assert.equal(networkServiceSource.includes("isBrowserDnsOwnedHostsEntryCurrent"), true);
  assert.equal(networkServiceSource.includes("readBrowserDnsOwnedHostsEntries"), true);
  assert.equal(networkServiceSource.includes("macOS hosts lookup can"), true);
  assert.equal(networkServiceSource.includes("this.browserDnsAutoInstallSignature = undefined;"), true);
  assert.equal(networkServiceSource.includes("buildBrowserDnsResolverCleanupScript"), true);
  assert.equal(networkServiceSource.includes("ifconfig lo0 alias"), true);
  assert.equal(networkServiceSource.includes("ifconfig lo0 -alias"), true);
  assert.equal(networkServiceSource.includes("with administrator privileges"), true);
  assert.equal(networkServiceSource.includes("with prompt"), true);
  assert.equal(networkServiceSource.includes("maybeAutoInstallBrowserDnsResolvers"), true);
  assert.equal(networkServiceSource.includes("BROWSER_DNS_AUTO_INSTALL_SIGNATURE_KEY"), true);
  assert.equal(networkServiceSource.includes("rememberBrowserDnsAutoInstallSignature(signature)"), true);
  assert.equal(networkServiceSource.includes("clearBrowserDnsAutoInstallSignature"), true);
  assert.equal(networkServiceSource.includes("BROWSER_SECURE_DNS_SUFFIX"), true);
  assert.equal(networkServiceSource.includes("BROWSER_LEGACY_SECURE_DNS_SUFFIXES"), true);
  assert.equal(networkServiceSource.includes("*.${BROWSER_SECURE_DNS_SUFFIX}"), true);
  assert.equal(networkServiceSource.includes("browserSecureDnsHostname"), true);
  assert.equal(networkServiceSource.includes("expandBrowserDnsServerRecords"), true);
  assert.equal(networkServiceSource.includes("appendLegacyBrowserDnsResolverCleanupLines"), true);
  assert.equal(networkServiceSource.includes("secureHostname"), true);
  assert.equal(networkServiceSource.includes("tlsConfigured"), true);
  assert.equal(networkServiceSource.includes("Port Manager browser TLS certificate"), true);
  // Install prompts are built centrally and must disclose the TLS certificate scope.
  assert.equal(networkServiceSource.includes("and the dev TLS certificate"), true);
  assert.equal(networkServiceSource.includes("buildNetworkAdminSetupPromptMessage"), true);
  assert.equal(networkServiceSource.includes("BROWSER_TLS_HOSTNAMES_MARKER_PATH"), true);
  assert.equal(networkServiceSource.includes("BROWSER_TLS_SERVER_CERT_PATH"), true);
  assert.equal(networkServiceSource.includes("security add-trusted-cert"), true);
  assert.equal(networkServiceSource.includes("publicProtocol"), true);
  assert.equal(networkServiceSource.includes("Math.min(settings.scanRange, 20)"), false);
  assert.equal(networkServiceSource.includes('shellExport("PORT_MANAGER_SCAN_RANGE", String(settings.scanRange))'), true);
  assert.equal(networkServiceSource.includes("buildCandidatePorts("), false);
  assert.equal(networkServiceSource.includes("isBrowserDnsLoopbackAliasConfigured"), true);
  assert.equal(networkServiceSource.includes("ensureBrowserDnsLoopbackAliasesReady"), true);
  assert.equal(networkServiceSource.includes("loopbackAliasConfigured"), true);
  assert.equal(networkServiceSource.includes("secureHostname"), true);
  assert.equal(networkServiceSource.includes("${hostname}.localhost"), false);
  assert.equal(networkServiceSource.includes("readBrowserProxyProcessCommandTexts"), true);
  assert.equal(networkServiceSource.includes("readProcessCommand(process.pid)"), true);
  assert.equal(networkServiceSource.includes("processCommandTextByPid"), true);
  assert.equal(networkServiceSource.includes("this.browserNetworkProxy.retryFailedEndpointsNow();"), true);
  assert.equal(networkServiceSource.includes("await this.syncBrowserNetworkProxies().catch(() => undefined);"), true);
  const browserProxySyncStart = networkServiceSource.indexOf("private async syncBrowserNetworkProxiesExclusive");
  const browserProxySyncEnd = networkServiceSource.indexOf(
    "private async readBrowserProxyProcessCommandTexts",
    browserProxySyncStart,
  );
  const browserProxySyncSource = networkServiceSource.slice(browserProxySyncStart, browserProxySyncEnd);
  const browserProxyLeaseIndex = browserProxySyncSource.indexOf("this.ownsBrowserNetworkProxyLease = true;");
  const browserAliasReadyIndex = browserProxySyncSource.indexOf("ensureBrowserDnsLoopbackAliasesReady(dnsRecords)");
  const browserProxyApplyIndex = browserProxySyncSource.indexOf("await this.browserNetworkProxy.sync(endpoints)");
  const hostGatewaySyncIndex = browserProxySyncSource.indexOf(
    "await this.syncHostGatewayProxies(",
    browserProxyApplyIndex,
  );
  const hostLocalGatewayRedirectSyncIndex = browserProxySyncSource.indexOf(
    "void this.syncHostLocalGatewayRedirects(",
    hostGatewaySyncIndex,
  );
  const reloadSharedStateStart = networkServiceSource.indexOf("private async reloadSharedNetworkState");
  const reloadSharedStateEnd = networkServiceSource.indexOf(
    "private loadVscodeWindowTerminalBinding",
    reloadSharedStateStart,
  );
  const reloadSharedStateSource = networkServiceSource.slice(reloadSharedStateStart, reloadSharedStateEnd);
  const ownerStartupStart = networkServiceSource.indexOf("private async startControlPlaneOwnerServices");
  const ownerStartupEnd = networkServiceSource.indexOf("  /** Runs registry side effects only", ownerStartupStart);
  const ownerStartupSource = networkServiceSource.slice(ownerStartupStart, ownerStartupEnd);
  const ownerDnsStartIndex = ownerStartupSource.indexOf("await this.startBrowserDnsServer();");
  const ownerConvergeIndex = ownerStartupSource.indexOf("await this.convergeDaemonAndRoutingState();");
  const ownerComposeRepairIndex = ownerStartupSource.indexOf("await this.repairPersistedPortManagerCloneComposeAttachments();");
  const reloadTerminalSelectionIndex = reloadSharedStateSource.indexOf("await this.writeTerminalNetworkSelectionFile();");
  const reloadBrowserDnsIndex = reloadSharedStateSource.indexOf(
    "await this.rehydrateBrowserDnsAndProxies().catch(() => undefined);",
  );
  const convergeStart = networkServiceSource.indexOf("private async convergeDaemonAndRoutingStateExclusive");
  const convergeEnd = networkServiceSource.indexOf("private async ensureCurrentProcessDaemon", convergeStart);
  const convergeSource = networkServiceSource.slice(convergeStart, convergeEnd);
  assert.notEqual(browserProxySyncStart, -1);
  assert.notEqual(browserProxySyncEnd, -1);
  assert.notEqual(reloadSharedStateStart, -1);
  assert.notEqual(reloadSharedStateEnd, -1);
  assert.notEqual(ownerStartupStart, -1);
  assert.notEqual(ownerStartupEnd, -1);
  assert.notEqual(convergeStart, -1);
  assert.notEqual(convergeEnd, -1);
  assert.equal(ownerDnsStartIndex >= 0, true);
  assert.equal(ownerConvergeIndex > ownerDnsStartIndex, true);
  assert.equal(ownerComposeRepairIndex > ownerDnsStartIndex, true);
  assert.equal(browserProxySyncSource.includes("this.syncBrowserDnsRecordsForNetworks(networks)"), true);
  assert.equal(browserProxySyncSource.includes("const dnsRunning = this.browserDnsServer.isRunning();"), true);
  assert.equal(browserProxyLeaseIndex >= 0, true);
  assert.equal(browserAliasReadyIndex > browserProxyLeaseIndex, true);
  assert.equal(browserProxyApplyIndex > browserAliasReadyIndex, true);
  assert.equal(hostGatewaySyncIndex > browserProxyApplyIndex, true);
  assert.equal(hostLocalGatewayRedirectSyncIndex > hostGatewaySyncIndex, true);
  assert.equal(networkServiceSource.includes("releaseHostGatewayPortsForBrowserEndpoints"), true);
  assert.equal(networkServiceSource.includes("reclaimNativeEndpoint(endpoint.listenHost, listenPort)"), true);
  assert.equal(networkServiceSource.includes("private readonly hostGatewayProxy"), true);
  assert.equal(networkServiceSource.includes("collectHostGatewayExposures"), true);
  assert.match(networkServiceSource, /collectHostGatewayExposures\([\s\S]*registrySnapshot\.composeAttachments/);
  assert.equal(networkServiceSource.includes("appendHiddenHostLocalGatewayExposures"), false);
  assert.equal(networkServiceSource.includes("hostLocalGatewayExposureId"), false);
  assert.equal(networkServiceSource.includes('hostAddress: "127.0.0.1"'), false);
  assert.equal(networkServiceSource.includes('createdAt: "hidden-host-local-gateway"'), false);
  assert.equal(networkServiceSource.includes("selectHostLocalGatewayRedirects"), true);
  assert.equal(networkServiceSource.includes("syncHostLocalGatewayRedirects"), true);
  assert.equal(networkServiceSource.includes("HOST_LOCAL_GATEWAY_PF_ANCHOR"), true);
  assert.equal(networkServiceSource.includes("buildHostLocalGatewayRedirectSetupScript"), true);
  assert.equal(networkServiceSource.includes('rdr-anchor "${HOST_LOCAL_GATEWAY_PF_ANCHOR}"'), true);
  assert.equal(networkServiceSource.includes("HOST_LOCAL_GATEWAY_PF_LEGACY_ANCHOR_LINE"), true);
  assert.equal(networkServiceSource.includes("rdr pass on lo0 inet proto tcp"), true);
  assert.equal(networkServiceSource.includes("server listen calls stay free"), true);
  assert.equal(networkServiceSource.includes("occupy localhost before Django"), true);
  assert.equal(networkServiceSource.includes("selectHostDefaultGatewayExposure(portExposures"), true);
  assert.equal(networkServiceSource.includes("preferredHostDefaultNetworkId"), true);
  assert.equal(networkServiceSource.includes("resolveHostLocalGatewayNetworkId"), false);
  assert.equal(networkServiceSource.includes("hostLocalGatewayNetworkId"), false);
  assert.equal(networkServiceSource.includes("hostGatewayExposureId"), true);
  assert.equal(
    networkServiceSource.includes("const route = await this.findNetworkRoute(exposure.networkId, exposure.hostPort);"),
    true,
  );
  assert.equal(networkServiceSource.includes("isRoutableComposeAttachment(attachment)"), true);
  assert.equal(networkServiceSource.includes("targetPort: port.actualHostPort"), true);
  assert.equal(networkServiceSource.includes("targetPort: route.actualPort"), true);
  assert.equal(networkServiceSource.includes("buildDirectNetworkLoopbackUrl"), false);
  assert.equal(networkServiceSource.includes("options.routeToNetworkLoopback === true"), false);
  assert.equal(reloadBrowserDnsIndex > reloadTerminalSelectionIndex, true);
  assert.equal(
    convergeSource.includes("await this.rehydrateBrowserDnsAndProxies().catch(() => undefined);"),
    true,
  );
  assert.match(browserProxySyncSource, /collectBrowserProxyEndpoints\([\s\S]*networks,/);
  assert.equal(networkServiceSource.includes("isPublicWebEntrypointProcess"), true);
  assert.match(networkServiceSource, /\/\\bvite\\b\//);
  assert.match(networkServiceSource, /\/\\bmanage\\\.py\\s\+runserver\\b\//);
  assert.match(networkServiceSource, /\/\\bdjango-admin\\s\+runserver\\b\//);
  assert.match(networkServiceSource, /\/\\bdaphne\\b\//);
  assert.match(networkServiceSource, /\/\\buvicorn\\b\//);
  assert.match(networkServiceSource, /\/\\bgunicorn\\b\//);
  assert.equal(networkServiceSource.includes("backend ports remain"), true);
  assert.equal(
    networkServiceSource.includes("grep -q '^# Port Manager browser DNS resolver$'"),
    true,
    "cleanup must only delete resolver files marked as Port Manager-owned",
  );

  assert.equal(commandSource.includes("portManager.installBrowserDnsResolvers"), true);
  assert.equal(commandSource.includes("portManager.cleanupBrowserDnsResolvers"), true);
  assert.equal(commandSource.includes("copyBrowserDnsResolverSetup"), false);
  assert.equal(treeSource.includes("Install Browser DNS"), true);
  assert.equal(treeSource.includes("Clean Browser DNS"), true);
  assert.equal(treeSource.includes("Loopback alias: ${aliasStatus}"), true);
  assert.equal(treeSource.includes("Hosts entry: ${hostsStatus}"), true);
  assert.equal(treeSource.includes("buildBrowserDnsRecordRows"), true);
  assert.equal(treeSource.includes("Logical port: ${route.logicalPort}"), true);
  assert.equal(treeSource.includes("Proxy: ${proxy}"), true);
  assert.equal(treeSource.includes("Upstream: ${upstream}"), true);

  assert.equal(
    packageJson.activationEvents?.includes("onCommand:portManager.copyBrowserDnsResolverSetup"),
    false,
  );
  assert.equal(
    packageJson.contributes?.commands?.some((command) => command.command === "portManager.copyBrowserDnsResolverSetup"),
    false,
  );
  assert.equal(
    JSON.stringify(packageJson).includes("portManager.hostLocalGatewayNetwork"),
    false,
    "host-local localhost gateway must not expose visible-network selection as user configuration",
  );
});

function buildQuery(hostname: string): Buffer {
  const labels = hostname.split(".");
  const questionLength = labels.reduce((sum, label) => sum + 1 + label.length, 1) + 4;
  const packet = Buffer.alloc(12 + questionLength);
  let offset = 12;

  packet.writeUInt16BE(0x1234, 0);
  packet.writeUInt16BE(0x0100, 2);
  packet.writeUInt16BE(1, 4);

  for (const label of labels) {
    packet[offset] = label.length;
    offset += 1;
    packet.write(label, offset, "ascii");
    offset += label.length;
  }

  packet[offset] = 0;
  offset += 1;
  packet.writeUInt16BE(1, offset);
  offset += 2;
  packet.writeUInt16BE(1, offset);

  return packet;
}

function queryDns(port: number, packet: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("DNS query timed out."));
    }, 1000);

    socket.once("message", (message) => {
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(packet, port, "127.0.0.1");
  });
}

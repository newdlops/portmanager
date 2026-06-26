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
  server.sync([{ hostname: "alpha1", address: "127.98.202.69" }]);

  try {
    const response = await queryDns(server.getPort(), buildQuery("alpha1"));

    assert.equal(response.readUInt16BE(0), 0x1234);
    assert.equal(response.readUInt16BE(6), 1);
    assert.deepEqual([...response.subarray(response.length - 4)], [127, 98, 202, 69]);
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
  assert.equal(networkServiceSource.includes("buildBrowserDnsResolverCleanupScript"), true);
  assert.equal(networkServiceSource.includes("with administrator privileges"), true);
  assert.equal(networkServiceSource.includes("maybeAutoInstallBrowserDnsResolvers"), true);
  assert.equal(networkServiceSource.includes("isPublicWebEntrypointProcess"), true);
  assert.equal(networkServiceSource.includes("/\\bvite\\b/"), true);
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

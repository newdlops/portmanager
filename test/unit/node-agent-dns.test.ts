import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PortManagerAgent } from "../../src/agent/port-manager-agent";
import { BrowserDnsServer } from "../../src/platform/network/browser-dns-server";

/** Exercises the fallback without requiring UDP bind permission in the test sandbox. */
test("Node fallback fences DNS revisions, no-ops replays, and restores the fence", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-node-dns-"));
  const routeTablePath = path.join(directory, "routes.json");
  const sharedStatePath = path.join(directory, "logical-network-state.v1.json");
  fs.writeFileSync(
    sharedStatePath,
    JSON.stringify({ version: 1, revision: "revision-b", state: { networks: [], attachments: [], exposures: [] } }),
  );
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = createNodeDnsAgent(routeTablePath);
  context.after(() => first.dispose());
  assert.equal((await first.syncBrowserDns("current=127.120.5.9", "revision-b", sharedStatePath)).applied, true);
  // The same authority token is an idempotent replay, not permission to change rows.
  assert.equal((await first.syncBrowserDns("changed=127.120.5.10", "revision-b", sharedStatePath)).applied, true);
  const statePath = path.join(directory, ".routes-browser-dns.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { revision: "revision-b", records: "current=127.120.5.9" });
  assert.equal((await first.syncBrowserDns("legacy=127.120.5.11")).applied, false);
  first.dispose();

  const restarted = createNodeDnsAgent(routeTablePath);
  context.after(() => restarted.dispose());
  await restarted.listen(path.join(directory, "restarted-agent.sock"));
  assert.equal((await dnsQuery(restarted.daemonStatus().browserDnsPort!, "current")).rcode, 0);
  assert.equal((await restarted.syncBrowserDns("legacy=127.120.5.11")).applied, false);
  assert.equal((await restarted.syncBrowserDns("stale=127.120.5.12", "revision-a", sharedStatePath)).applied, false);
});

test("Node fallback rejects corrupt envelopes and accepts only raw legacy authority", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-node-dns-schema-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const routeTablePath = path.join(directory, "routes.json"); const authority = path.join(directory, "state.json");
  const agent = createNodeDnsAgent(routeTablePath); context.after(() => agent.dispose());
  fs.writeFileSync(authority, JSON.stringify({ version: 1, revision: "bad", state: null, networks: [], attachments: [], exposures: [] }));
  assert.equal((await agent.syncBrowserDns("bad=127.0.0.1", "bad", authority)).applied, false);
  fs.writeFileSync(authority, JSON.stringify({ networks: [], attachments: [], exposures: [] }));
  assert.equal((await agent.syncBrowserDns("legacy=127.0.0.1", "legacy", authority)).applied, true);
  fs.writeFileSync(authority, JSON.stringify({ version: 1, revision: "other", state: { networks: [], attachments: [], exposures: [] } }));
  assert.equal((await agent.syncBrowserDns("overwrite=127.0.0.2", "legacy", authority)).applied, false);
  const port = agent.daemonStatus().browserDnsPort!;
  assert.equal((await dnsQuery(port, "legacy")).rcode, 0);
  assert.equal((await dnsQuery(port, "overwrite")).rcode, 3);
});

test("Node fallback retains live DNS records when sidecar persistence fails, then retries", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-node-dns-persist-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const routeTablePath = path.join(directory, "routes.json"); const authority = path.join(directory, "state.json");
  const agent = createNodeDnsAgent(routeTablePath); context.after(() => agent.dispose());
  fs.writeFileSync(authority, JSON.stringify({ version: 1, revision: "A", state: { networks: [], attachments: [], exposures: [] } }));
  assert.equal((await agent.syncBrowserDns("old=127.0.0.1", "A", authority)).applied, true);
  const sidecar = path.join(directory, ".routes-browser-dns.json");
  fs.rmSync(sidecar); fs.mkdirSync(sidecar);
  fs.writeFileSync(authority, JSON.stringify({ version: 1, revision: "B", state: { networks: [], attachments: [], exposures: [] } }));
  assert.equal((await agent.syncBrowserDns("new=127.0.0.2", "B", authority)).applied, false);
  const port = agent.daemonStatus().browserDnsPort!;
  assert.equal((await dnsQuery(port, "old")).rcode, 0);
  assert.equal((await dnsQuery(port, "new")).rcode, 3);
  fs.rmSync(sidecar, { recursive: true });
  assert.equal((await agent.syncBrowserDns("new=127.0.0.2", "B", authority)).applied, true);
  assert.equal((await dnsQuery(port, "new")).rcode, 0);
});

test("Node fallback same-revision replay recovers a blocked UDP bind without changing records", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-node-dns-bind-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const routeTablePath = path.join(directory, "routes.json"); const authority = path.join(directory, "state.json");
  const responder = new GatedBrowserDnsServer();
  const agent = createNodeDnsAgent(routeTablePath, 0, responder); context.after(() => agent.dispose());
  fs.writeFileSync(authority, JSON.stringify({ version: 1, revision: "B", state: { networks: [], attachments: [], exposures: [] } }));
  const first = await agent.syncBrowserDns("original=127.0.0.3", "B", authority);
  assert.equal(first.applied, true); assert.equal(first.running, false);
  responder.release();
  const replay = await agent.syncBrowserDns("replacement=127.0.0.4", "B", authority);
  assert.equal(replay.applied, true); assert.equal(replay.running, true);
  const reboundPort = agent.daemonStatus().browserDnsPort!;
  assert.equal(reboundPort > 0, true);
  assert.equal((await dnsQuery(reboundPort, "original")).rcode, 0);
  assert.equal((await dnsQuery(reboundPort, "replacement")).rcode, 3);
});

test("Node fallback restores a pre-fence records-only DNS sidecar", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-node-dns-legacy-sidecar-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const routeTablePath = path.join(directory, "routes.json");
  fs.writeFileSync(path.join(directory, ".routes-browser-dns.json"), JSON.stringify({ records: "restored=127.0.0.5" }));
  const agent = createNodeDnsAgent(routeTablePath); context.after(() => agent.dispose());
  await agent.listen(path.join(directory, "restored-agent.sock"));
  assert.equal((await dnsQuery(agent.daemonStatus().browserDnsPort!, "restored")).rcode, 0);
});

function createNodeDnsAgent(routeTablePath: string, browserDnsPort = 0, browserDnsServer?: BrowserDnsServer): PortManagerAgent {
  return new PortManagerAgent({
    routeTablePath,
    browserDnsPort,
    browserDnsServer,
    processLauncher: { onExit: () => ({ dispose: () => undefined }) } as never,
    portAvailabilityProvider: { check: async () => ({ port: 1, available: true }) } as never,
    listeningPortProvider: { list: async () => [] } as never,
  });
}

class GatedBrowserDnsServer extends BrowserDnsServer {
  private blocked = true;

  constructor() { super({ port: 0 }); }
  release(): void { this.blocked = false; }
  override async start(): Promise<void> {
    if (this.blocked) throw new Error("test DNS bind blocked");
    await super.start();
  }
}

function dnsQuery(port: number, hostname: string, timeoutMs = 2_000): Promise<{ readonly rcode: number }> {
  const query = Buffer.concat([Buffer.from([0x42, 0x42, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...hostname.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
  const socket = dgram.createSocket("udp4");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error(`DNS query timed out: ${hostname}`)); }, timeoutMs);
    socket.once("message", (response) => { clearTimeout(timer); socket.close(); resolve({ rcode: response.readUInt16BE(2) & 0xf }); });
    socket.once("error", (error) => { clearTimeout(timer); socket.close(); reject(error); });
    socket.send(query, port, "127.0.0.1");
  });
}

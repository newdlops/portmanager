import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { getRouteTablePathForLogicalPort } from "../../src/agent/route-table";

const root = path.resolve(__dirname, "../../..");
const agentPath = process.env.PORT_MANAGER_TEST_NATIVE_AGENT_PATH ?? path.join(root, "media/native/portmanager_agent");
const gated = { skip: process.platform !== "darwin" };
interface Reply { type?: string; id?: string; ok?: boolean; payload?: unknown; error?: string }

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "publication fixture exceeded its deadline");
    await delay(5);
  }
}

/** Requests stay on one socket so unrelated replies must overtake blocked I/O. */
async function channel(socketPath: string) {
  const socket = net.createConnection({ path: socketPath, allowHalfOpen: true });
  const messages = new Map<string, Reply>();
  let input = "", sequence = 0;
  let failure: Error | undefined;
  socket.on("error", error => { failure = error; });
  socket.on("data", chunk => {
    input += chunk.toString();
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      const reply = JSON.parse(input.slice(0, end)) as Reply;
      input = input.slice(end + 1);
      if (reply.type === "response" && reply.id !== undefined) messages.set(reply.id, reply);
    }
  });
  try { await until(() => { if (failure) throw failure; return !socket.connecting; }); }
  catch (error) { socket.destroy(); throw error; }
  return {
    socket, messages,
    send(method: string, payload?: unknown) {
      const id = `publication-${++sequence}`;
      socket.write(`${JSON.stringify({ id, method, payload })}\n`);
      return id;
    },
    async reply<T = unknown>(id: string, timeoutMs = 2000): Promise<T> {
      await until(() => { if (failure) throw failure; return messages.has(id); }, timeoutMs);
      const reply = messages.get(id)!;
      if (!reply.ok) throw new Error(reply.error);
      return reply.payload as T;
    },
  };
}

function running(child: ChildProcess) { return child.exitCode === null && child.signalCode === null; }

/** All files, sockets and interposition gates are private to this process. The
 * real agent binary is unchanged; the dylib delays actual temporary-file writes. */
async function fixture(context: TestContext, withGate = true) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-publication-")));
  const socketPath = path.join(directory, "agent.sock");
  const routes = path.join(directory, "routes.json");
  const scan = path.join(directory, "listeners");
  const library = path.join(directory, "publication-delay.dylib");
  const clients: Awaited<ReturnType<typeof channel>>[] = [];
  let child: ChildProcess | undefined;
  context.after(async () => {
    for (const client of clients) client.socket.destroy();
    for (const kind of ["routes", "dns"]) fs.rmSync(path.join(directory, `block-${kind}`), { force: true });
    if (child && running(child)) {
      child.kill("SIGTERM");
      await until(() => !running(child!), 2500).catch(() => child!.kill("SIGKILL"));
      await until(() => !running(child!), 1000);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (withGate) execFileSync("cc", ["-Wall", "-Wextra", "-dynamiclib", "-O2",
    path.join(root, "test/unit/native-agent-publication-fixture.c"), "-o", library]);
  fs.writeFileSync(scan, "");
  fs.writeFileSync(path.join(directory, "lsof"), '#!/bin/sh\n/bin/cat "$PM_PUBLICATION_SCAN"\n', { mode: 0o755 });
  child = spawn(agentPath, ["--socket", socketPath, "--route-table", routes,
    "--agent-main", path.join(root, "out/src/agent/agent-main.js"), "--dns-port", "0"], {
    stdio: ["ignore", "ignore", "pipe"], env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "1",
      DYLD_INSERT_LIBRARIES: withGate ? library : "", PM_PUBLICATION_TEST_ROOT: directory, PM_PUBLICATION_SCAN: scan,
    },
  });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
  await until(() => { assert.ok(running(child!), stderr); return fs.existsSync(socketPath); });
  async function connect() {
    const deadline = Date.now() + 1500;
    for (;;) {
      try {
        const client = await channel(socketPath);
        clients.push(client);
        return client;
      } catch (error) {
        if (!["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() > deadline) throw error;
        await delay(5);
      }
    }
  }
  const client = await connect();
  await client.reply(client.send("daemonStatus"));
  return {
    directory, routes, scan, client, child, connect,
    shard: (port: number, network = "publication") => getRouteTablePathForLogicalPort(port, network, routes),
    block(kind: "routes" | "dns") {
      fs.rmSync(path.join(directory, `entered-${kind}`), { force: true });
      fs.writeFileSync(path.join(directory, `block-${kind}`), "");
    },
    // Repair performs an OS scan before publishing; fixture readiness must
    // allow its bounded scan budget. Responsiveness assertions stay at 500ms.
    entered: (kind: "routes" | "dns") => until(() => fs.existsSync(path.join(directory, `entered-${kind}`)), 6000),
    release(kind: "routes" | "dns") { fs.rmSync(path.join(directory, `block-${kind}`), { force: true }); },
  };
}

const registration = (port: number, name = "publication") => ({
  pid: process.pid, name, command: name, cwd: root, requestedPort: port, actualPort: port + 1,
  host: "127.0.0.1", networkId: "publication", source: "hooked",
});

async function dnsAddress(port: number, name = "publication.pm"): Promise<string> {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(42); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const packet = Buffer.concat([header, ...name.split(".").map(label => Buffer.concat([
    Buffer.from([label.length]), Buffer.from(label),
  ])), Buffer.from([0, 0, 1, 0, 1])]);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error("DNS answer timed out")); }, 500);
    socket.once("error", error => { clearTimeout(timer); socket.close(); reject(error); });
    socket.once("message", answer => {
      clearTimeout(timer); socket.close();
      if (answer.readUInt16BE(6) !== 1) reject(new Error("Expected one DNS answer"));
      else resolve([...answer.subarray(-4)].join("."));
    });
    socket.send(packet, port, "127.0.0.1");
  });
}

test("route additions and removals publish during continuous status traffic without explicit flushes", async context => {
  const f = await fixture(context, false);
  await f.client.reply(f.client.send("registerExistingProcess", registration(48500)));
  await f.client.reply(f.client.send("flushRouteTables"));
  const registered = await f.client.reply<{ id: string }>(f.client.send("registerExistingProcess", registration(48502)));
  const started = performance.now();
  let seenAt = 0, removedAt = 0, removeStarted = 0, calls = 0;
  while (performance.now() - started < 1200) {
    await f.client.reply(f.client.send("daemonStatus"), 500);
    calls++;
    if (!seenAt && fs.existsSync(f.shard(48502))) {
      seenAt = performance.now() - started;
      await f.client.reply(f.client.send("removeProcess", { id: registered.id }));
      removeStarted = performance.now();
    }
    if (seenAt && !removedAt && !fs.existsSync(f.shard(48502))) removedAt = performance.now() - removeStarted;
    await delay(10);
  }
  assert.ok(seenAt > 0 && seenAt < 800, `addition took ${seenAt}ms`);
  assert.ok(removedAt > 0 && removedAt < 800, `removal took ${removedAt}ms`);
  assert.ok(calls > 30);
  context.diagnostic(JSON.stringify({ additionMs: seenAt, removalMs: removedAt, statusCalls: calls }));
});

test("blocked route writes preserve flush receipts while status and DNS overtake them", gated, async context => {
  const f = await fixture(context);
  const seed = await f.client.reply<{ id: string }>(f.client.send("registerExistingProcess", registration(48510)));
  await f.client.reply(f.client.send("flushRouteTables"));
  f.block("routes");
  await f.client.reply(f.client.send("registerExistingProcess", registration(48512)));
  const flush = f.client.send("flushRouteTables");
  await f.entered("routes");
  const started = performance.now();
  const status = await f.client.reply<{ browserDnsPort: number }>(f.client.send("daemonStatus"), 500);
  const synced = await f.client.reply<{ applied: boolean }>(f.client.send("syncBrowserDns", { records: "publication.pm=127.120.5.40" }), 500);
  assert.equal(synced.applied, true);
  assert.equal(await dnsAddress(status.browserDnsPort), "127.120.5.40");
  assert.equal(f.client.messages.has(flush), false);
  assert.equal(fs.existsSync(f.shard(48512)), false);
  // No second flush: the older completion must not clear these later changes.
  await f.client.reply(f.client.send("registerExistingProcess", { ...registration(48512, "latest"), actualPort: 48519 }));
  await f.client.reply(f.client.send("removeProcess", { id: seed.id }));
  await delay(300);
  context.diagnostic(JSON.stringify({ statusAndDnsWhileRouteWriteBlockedMs: performance.now() - started - 300 }));
  f.release("routes");
  await f.client.reply(flush);
  await until(() => fs.existsSync(f.shard(48512)) &&
    JSON.parse(fs.readFileSync(f.shard(48512), "utf8")).routes[0]?.actualPort === 48519 && !fs.existsSync(f.shard(48510)));
});

test("blocked DNS commits keep old answers, fence stale revisions and let route flushes finish", gated, async context => {
  const f = await fixture(context);
  const sharedStatePath = path.join(f.directory, "networks.json");
  const revision = (value: string) => fs.writeFileSync(sharedStatePath, JSON.stringify({
    version: 1, revision: value, state: { networks: [], attachments: [], exposures: [] },
  }));
  revision("one");
  assert.equal((await f.client.reply<{ applied: boolean }>(f.client.send("syncBrowserDns", {
    records: "publication.pm=127.120.5.41", revision: "one", sharedStatePath,
  }))).applied, true);
  const status = await f.client.reply<{ browserDnsPort: number }>(f.client.send("daemonStatus"));
  f.block("dns");
  revision("two");
  const stale = f.client.send("syncBrowserDns", { records: "publication.pm=127.120.5.42", revision: "two", sharedStatePath });
  await f.entered("dns");
  const started = performance.now();
  await f.client.reply(f.client.send("registerExistingProcess", registration(48520)), 500);
  await f.client.reply(f.client.send("flushRouteTables"), 500);
  assert.ok(fs.existsSync(f.shard(48520)));
  assert.equal(await dnsAddress(status.browserDnsPort), "127.120.5.41");
  assert.equal(f.client.messages.has(stale), false);
  assert.match(fs.readFileSync(path.join(f.directory, "routes-browser-dns.tsv"), "utf8"), /#revision\tone/);
  context.diagnostic(JSON.stringify({ routeFlushWhileDnsWriteBlockedMs: performance.now() - started }));
  revision("three");
  const newest = f.client.send("syncBrowserDns", { records: "publication.pm=127.120.5.43", revision: "three", sharedStatePath });
  const unversioned = f.client.send("syncBrowserDns", { records: "publication.pm=127.120.5.99" });
  f.release("dns");
  assert.equal((await f.client.reply<{ applied: boolean }>(stale)).applied, false);
  assert.equal((await f.client.reply<{ applied: boolean }>(newest)).applied, true);
  assert.equal((await f.client.reply<{ applied: boolean }>(unversioned)).applied, false);
  assert.equal(await dnsAddress(status.browserDnsPort), "127.120.5.43");
  assert.match(fs.readFileSync(path.join(f.directory, "routes-browser-dns.tsv"), "utf8"), /#revision\tthree/);
});

test("repair waits for forced file replacement and coalesced repairs keep their receipts", gated, async context => {
  const f = await fixture(context);
  await f.client.reply(f.client.send("registerExistingProcess", registration(48530)));
  fs.writeFileSync(f.scan, `p${process.pid}\ncpublication\nn127.0.0.1:48531\n`);
  await f.client.reply(f.client.send("flushRouteTables"));
  const file = f.shard(48530);
  const corrupted = JSON.parse(fs.readFileSync(file, "utf8"));
  corrupted.routes = [];
  fs.writeFileSync(file, JSON.stringify(corrupted));
  f.block("routes");
  const repair = f.client.send("repairRoutingState");
  await f.entered("routes");
  const repairs = Array.from({ length: 6 }, () => f.client.send("repairRoutingState"));
  await f.client.reply(f.client.send("daemonStatus"), 500);
  await delay(100);
  assert.equal(f.client.messages.has(repair), false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).routes.length, 0);
  f.release("routes");
  await Promise.all([repair, ...repairs].map(id => f.client.reply(id)));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).routes[0].actualPort, 48531);
});

test("a failed route commit reports failure and retries after the obstruction is removed", async context => {
  const f = await fixture(context, false);
  const file = f.shard(48540);
  fs.mkdirSync(file);
  await f.client.reply(f.client.send("registerExistingProcess", registration(48540)));
  await assert.rejects(f.client.reply(f.client.send("flushRouteTables")), /Failed to publish/);
  assert.equal((await f.client.reply<{ routeCount: number }>(f.client.send("daemonStatus"))).routeCount, 1);
  fs.rmdirSync(file);
  await until(() => fs.existsSync(file), 2500);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).routes[0].actualPort, 48541);
});

test("a noncompact allocation waits for disk and survives a request writer half-close", gated, async context => {
  const f = await fixture(context);
  f.block("routes");
  const allocationClient = await f.connect();
  const id = allocationClient.send("allocateRoute", {
    requestedPort: 48550, networkId: "publication", host: "127.0.0.1", routeDirection: "listen", compactResponse: false,
  });
  allocationClient.socket.end();
  await f.entered("routes");
  await f.client.reply(f.client.send("daemonStatus"), 500);
  assert.equal(allocationClient.messages.has(id), false);
  f.release("routes");
  const allocation = await allocationClient.reply<{ actualPort: number }>(id);
  assert.ok(allocation.actualPort > 0);
  assert.ok(fs.existsSync(f.shard(48550)));
});

test("a partial publication retries stale-file cleanup after a deletion failure", async context => {
  const f = await fixture(context, false);
  const route = await f.client.reply<{ id: string }>(f.client.send("registerExistingProcess", registration(48580)));
  await f.client.reply(f.client.send("flushRouteTables"));
  const file = f.shard(48580);
  const stale = fs.readFileSync(file, "utf8");
  fs.unlinkSync(file);
  fs.mkdirSync(file); // A deterministic unlink failure, even under elevated tests.
  await f.client.reply(f.client.send("removeProcess", { id: route.id }));
  await f.client.reply(f.client.send("registerExistingProcess", registration(48582)));
  await assert.rejects(f.client.reply(f.client.send("flushRouteTables")), /Failed to publish/);
  assert.ok(fs.existsSync(f.shard(48582)), "the failed pass also published a new route");
  fs.rmdirSync(file);
  fs.writeFileSync(file, stale);
  await until(() => !fs.existsSync(file), 2500);
  assert.ok(fs.existsSync(f.shard(48582)));
});

test("an accepted repair finishes after its client disconnects", gated, async context => {
  const f = await fixture(context);
  await f.client.reply(f.client.send("registerExistingProcess", registration(48560)));
  fs.writeFileSync(f.scan, `p${process.pid}\ncpublication\nn127.0.0.1:48561\n`);
  await f.client.reply(f.client.send("flushRouteTables"));
  const file = f.shard(48560);
  const corrupted = JSON.parse(fs.readFileSync(file, "utf8"));
  corrupted.routes = [];
  fs.writeFileSync(file, JSON.stringify(corrupted));
  f.block("routes");
  const caller = await f.connect();
  caller.send("repairRoutingState");
  await f.entered("routes");
  caller.socket.destroy();
  f.release("routes");
  await until(() => JSON.parse(fs.readFileSync(file, "utf8")).routes.length === 1);
});

test("a stalled publication expires without success and does not hold daemon shutdown", gated, async context => {
  const f = await fixture(context);
  f.block("dns");
  const sync = f.client.send("syncBrowserDns", { records: "publication.pm=127.120.5.44" });
  await f.entered("dns");
  const flood = Array.from({ length: 40 }, () => f.client.send("syncBrowserDns", { records: "publication.pm=127.120.5.45" }));
  await until(() => flood.filter(id => f.client.messages.get(id)?.ok === false).length >= 9, 1000);
  await f.client.reply(f.client.send("daemonStatus"), 500);
  await assert.rejects(f.client.reply(sync, 9500), /Failed to publish/);
  await until(() => flood.every(id => f.client.messages.has(id)), 1500);
  assert.ok(flood.every(id => f.client.messages.get(id)?.ok === false));
  assert.equal(fs.existsSync(path.join(f.directory, "routes-browser-dns.tsv")), false);
  f.release("dns");
  await delay(80);
  // Completion after the deadline cannot publish or install the old table.
  assert.equal(fs.existsSync(path.join(f.directory, "routes-browser-dns.tsv")), false);
  assert.equal((await f.client.reply<{ applied: boolean }>(f.client.send("syncBrowserDns", {
    records: "publication.pm=127.120.5.46",
  }))).applied, true);
  f.block("dns");
  const abandoned = await f.connect();
  abandoned.send("syncBrowserDns", { records: "publication.pm=127.120.5.47" });
  await f.entered("dns");
  abandoned.socket.destroy();
  await delay(60);
  const started = performance.now();
  assert.equal(await f.client.reply(f.client.send("shutdownDaemon"), 500), true);
  await until(() => !running(f.child), 1500);
  context.diagnostic(JSON.stringify({ shutdownWhileWriteBlockedMs: performance.now() - started }));
});

test("a delayed route write cannot overwrite a newer live writer at commit", gated, async context => {
  const f = await fixture(context);
  f.block("routes");
  await f.client.reply(f.client.send("registerExistingProcess", registration(48570)));
  const flush = f.client.send("flushRouteTables");
  await f.entered("routes");
  const newer = JSON.stringify({
    generation: { writerId: "newer-live-writer", writerStartedAtMs: Date.now() + 60000, sequence: 1, pid: process.pid },
    updatedAt: new Date().toISOString(), expiresAtMs: Date.now() + 300000,
    routes: [{ ...registration(48570), logicalPort: 48570, actualPort: 48579 }],
  });
  fs.writeFileSync(f.shard(48570), newer);
  f.release("routes");
  await assert.rejects(f.client.reply(flush), /Failed to publish/);
  assert.equal(fs.readFileSync(f.shard(48570), "utf8"), newer);
});

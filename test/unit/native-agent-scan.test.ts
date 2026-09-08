import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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

/** A controlled OS observation captures bytes before the gate, exposing stale-result races. */
const gatedScan = [
  "#!/bin/sh",
  'printf "%s\\n" "$$" >> "$PM_SCAN_PIDS"',
  '/bin/cat "$PM_SCAN_DATA"',
  'if [ -f "$PM_SCAN_BLOCK" ]; then',
  '  : > "$PM_SCAN_ENTERED"',
  '  while [ ! -f "$PM_SCAN_RELEASE" ]; do /bin/sleep 0.01; done',
  "fi",
  "exit 0",
].join("\n");

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "scan fixture exceeded its deadline");
    await delay(5);
  }
}

interface Reply { type?: string; id?: string; ok?: boolean; payload?: unknown; error?: string }

/** One persistent NDJSON connection allows replies to overtake a scan-dependent request. */
async function channel(context: TestContext, socketPath: string) {
  const socket = net.createConnection(socketPath);
  const messages = new Map<string, Reply>();
  let input = "";
  let sequence = 0;
  let failure: Error | undefined;
  socket.on("error", (error) => { failure = error; });
  socket.on("data", (chunk) => {
    input += chunk.toString();
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      const reply = JSON.parse(input.slice(0, end)) as Reply;
      input = input.slice(end + 1);
      if (reply.type === "response" && reply.id !== undefined) messages.set(reply.id, reply);
    }
  });
  context.after(() => socket.destroy());
  await until(() => { if (failure) throw failure; return !socket.connecting; });
  return {
    socket, messages,
    send(method: string, payload?: unknown) {
      const id = `scan-test-${++sequence}`;
      socket.write(`${JSON.stringify({ id, method, payload })}\n`);
      return id;
    },
    async reply<T = unknown>(id: string, timeoutMs = 1500): Promise<T> {
      await until(() => { if (failure) throw failure; return messages.has(id); }, timeoutMs);
      const reply = messages.get(id)!;
      if (!reply.ok) throw new Error(reply.error);
      return reply.payload as T;
    },
  };
}

async function fixture(context: TestContext, timeoutMs = 3000, script = gatedScan) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-scan-"));
  const paths = Object.fromEntries(["socket", "routes", "data", "pids", "block", "entered", "release"].map((name) => [name, path.join(directory, name)])) as Record<"socket" | "routes" | "data" | "pids" | "block" | "entered" | "release", string>;
  fs.writeFileSync(paths.data, ""); fs.writeFileSync(paths.pids, "");
  fs.writeFileSync(path.join(directory, "lsof"), script, { mode: 0o755 });
  let stderr = "";
  const child = spawn(agentPath, ["--socket", paths.socket, "--route-table", paths.routes,
    "--agent-main", path.join(root, "out/src/agent/agent-main.js"), "--dns-port", "0"], {
    stdio: ["ignore", "ignore", "pipe"], env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "1",
      PORT_MANAGER_AGENT_SCAN_TIMEOUT_MS: String(timeoutMs), PM_SCAN_DATA: paths.data, PM_SCAN_PIDS: paths.pids,
      PM_SCAN_BLOCK: paths.block, PM_SCAN_ENTERED: paths.entered, PM_SCAN_RELEASE: paths.release,
    },
  });
  child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
  context.after(async () => {
    fs.writeFileSync(paths.release, "");
    if (running(child)) { child.kill("SIGTERM"); await until(() => !running(child)).catch(() => child.kill("SIGKILL")); }
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  await until(() => { assert.ok(running(child), stderr); return fs.existsSync(paths.socket); });
  const client = await channel(context, paths.socket);
  return { paths, client, child, pids: () => fs.readFileSync(paths.pids, "utf8").trim().split("\n").filter(Boolean).map(Number) };
}

function running(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }

test("identical and unrelated registrations let a slow repair complete on its first capture", async (context) => {
  const { paths, client, pids } = await fixture(context);
  const registration = {
    pid: process.pid, name: "stable", command: "stable", cwd: root,
    requestedPort: 48400, actualPort: 48401, host: "127.0.0.1", networkId: "stable", source: "hooked",
  };
  const original = await client.reply<{ id: string; startedAt: string }>(client.send("registerExistingProcess", registration));
  fs.writeFileSync(paths.data, `p${process.pid}\ncstable\nn127.0.0.1:48401\n`);
  fs.writeFileSync(paths.block, "");
  const repair = client.send("repairRoutingState");
  await until(() => fs.existsSync(paths.entered));
  // Cross a timestamp boundary as well as several main-loop turns.
  await delay(1050);
  for (let index = 0; index < 12; index++) {
    const duplicate = await client.reply<{ id: string; startedAt: string }>(client.send("registerExistingProcess", registration));
    assert.equal(duplicate.id, original.id);
    assert.equal(duplicate.startedAt, original.startedAt);
    await client.reply(client.send("registerExistingProcess", {
      ...registration, name: `unrelated-${index}`, networkId: `unrelated-${index}`,
      requestedPort: 48410 + index, actualPort: 48430 + index,
    }));
  }
  assert.equal(pids().length, 1);
  fs.writeFileSync(paths.release, "");
  const result = await client.reply<{ processes: { id: string; status: string }[] }>(repair);
  assert.equal(result.processes.find(row => row.id === original.id)?.status, "running");
  assert.equal(result.processes.length, 13);
});

test("a release observation cannot stop an owner registered after its empty capture", async (context) => {
  const { paths, client, pids } = await fixture(context);
  const route = {
    pid: process.pid, name: "before", command: "before", cwd: root, source: "hooked",
    requestedPort: 48451, actualPort: 48452, host: "127.0.0.1", networkId: "release-fence",
  };
  await client.reply(client.send("registerExistingProcess", route));
  fs.writeFileSync(paths.block, "");
  const release = client.send("releaseProcessRoute", route);
  await until(() => fs.existsSync(paths.entered));
  await client.reply(client.send("registerExistingProcess", { ...route, name: "after", command: "after" }));
  fs.writeFileSync(paths.release, "");
  assert.equal(await client.reply(release), false);
  assert.equal(pids().length, 1);
  assert.equal((await client.reply<{ routeCount: number }>(client.send("daemonStatus"))).routeCount, 1);
});
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function dnsAddress(port: number, name: string): Promise<string> {
  const header = Buffer.alloc(12); header.writeUInt16BE(42); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const packet = Buffer.concat([header, ...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error("DNS answer timed out")); }, 500);
    socket.once("error", (error) => { clearTimeout(timer); socket.close(); reject(error); });
    socket.once("message", (answer) => {
      clearTimeout(timer); socket.close();
      if (answer.readUInt16BE(6) !== 1) reject(new Error("Expected one DNS answer"));
      else resolve([...answer.subarray(-4)].join("."));
    });
    socket.send(packet, port, "127.0.0.1");
  });
}

test("DNS publication, status and scoped allocation overtake blocked scans on the same socket", async (context) => {
  const { paths, client, pids } = await fixture(context);
  fs.writeFileSync(paths.block, "");
  const first = client.send("repairRoutingState");
  const second = client.send("repairRoutingState");
  await until(() => fs.existsSync(paths.entered));
  const published = client.send("syncBrowserDns", { records: "new.pm=127.120.5.10" });
  const status = client.send("daemonStatus");
  const allocation = client.send("allocateRoute", {
    requestedPort: 48391, host: "127.0.0.1", networkId: "scan-network", routeDirection: "listen", compactResponse: true,
  });
  assert.equal((await client.reply<{ applied: boolean }>(published, 500)).applied, true);
  const daemon = await client.reply<{ browserDnsPort: number }>(status, 500);
  assert.ok((await client.reply<{ actualPort: number }>(allocation, 500)).actualPort > 0);
  assert.equal(await dnsAddress(daemon.browserDnsPort, "new.pm"), "127.120.5.10");
  assert.equal(client.messages.has(first), false);
  assert.equal(client.messages.has(second), false);
  assert.equal(pids().length, 1, "concurrent fresh readers share the running command");
  fs.writeFileSync(paths.release, "");
  await Promise.all([client.reply(first), client.reply(second)]);
});

test("a registration during a scan fences out the old listener owner", async (context) => {
  const { paths, client, pids } = await fixture(context);
  fs.writeFileSync(paths.data, "p2000000000\ncold-server\nn127.0.0.1:48392\n");
  fs.writeFileSync(paths.block, "");
  const repair = client.send("repairRoutingState");
  await until(() => fs.existsSync(paths.entered));
  fs.writeFileSync(paths.data, `p${process.pid}\ncnew-server\nn127.0.0.1:48392\n`);
  const registration = client.send("registerExistingProcess", {
    pid: process.pid, name: "new-server", command: "new-server", cwd: root,
    requestedPort: 48390, actualPort: 48392, host: "127.0.0.1", networkId: "scan-network", source: "hooked",
  });
  const registered = await client.reply<{ id: string }>(registration, 500);
  await delay(50);
  assert.equal(pids().length, 1, "registration protects its row without canceling the shared capture");
  fs.writeFileSync(paths.release, "");
  const result = await client.reply<{ processes: { id: string; pid: number; status: string }[] }>(repair);
  const current = result.processes.find((row) => row.id === registered.id);
  assert.equal(current?.pid, process.pid);
  assert.equal(current?.status, "running");
  assert.equal(result.processes.some((row) => row.pid === 2000000000), false, "stale diagnostics cannot synthesize a second process owner");
  const cached = await client.reply<{ processes: { pid: number }[] }>(client.send("listSnapshot"));
  assert.equal(cached.processes.some((row) => row.pid === 2000000000), false);
  await until(() => pids().every((pid) => !alive(pid)));
});

test("a timed out scan discards partial output, retains the last snapshot and kills its process group", async (context) => {
  const { paths, client, pids } = await fixture(context, 600);
  fs.writeFileSync(paths.data, `p${process.pid}\ncfixture\nn127.0.0.1:48393\n`);
  await client.reply(client.send("repairRoutingState"));
  fs.writeFileSync(paths.data, `p${process.pid}\ncpartial\nn127.0.0.1:48394\n`);
  fs.writeFileSync(paths.block, "");
  await assert.rejects(client.reply(client.send("repairRoutingState"), 1500), /fresh listener scan/);
  const snapshot = await client.reply<{ listeners: { port: number }[] }>(client.send("listSnapshot"));
  assert.equal(snapshot.listeners.some((row) => row.port === 48393), true);
  assert.equal(snapshot.listeners.some((row) => row.port === 48394), false);
  await until(() => pids().every((pid) => !alive(pid)), 500);
});

test("abandoning a read-only scan cancels its subprocess before the command deadline", async (context) => {
  const { paths, client, pids } = await fixture(context);
  fs.writeFileSync(paths.block, "");
  client.send("listSnapshot");
  await until(() => fs.existsSync(paths.entered));
  client.socket.destroy();
  await until(() => pids().every((pid) => !alive(pid)), 500);
});

test("a release scan timeout preserves its live route until a successful observation", async (context) => {
  const { paths, client } = await fixture(context, 600);
  const payload = { pid: process.pid, requestedPort: 48397, actualPort: 48398, host: "127.0.0.1", networkId: "release" };
  await client.reply(client.send("registerExistingProcess", { ...payload, name: "release", command: "release", cwd: root, source: "hooked" }));
  fs.writeFileSync(paths.block, "");
  assert.equal(await client.reply(client.send("releaseProcessRoute", payload)), false);
  assert.equal((await client.reply<{ routeCount: number }>(client.send("daemonStatus"))).routeCount, 1);
  fs.writeFileSync(paths.release, "");
  assert.equal(await client.reply(client.send("releaseProcessRoute", payload)), true);
  assert.equal((await client.reply<{ routeCount: number }>(client.send("daemonStatus"))).routeCount, 0);
});

test("scan deadlines also kill a descendant that holds stdout after its wrapper exits", async (context) => {
  const script = ['#!/bin/sh', '/bin/sleep 30 &', 'printf "%s\\n" "$!" >> "$PM_SCAN_PIDS"', 'exit 0'].join("\n");
  const { client, pids } = await fixture(context, 600, script);
  await assert.rejects(client.reply(client.send("repairRoutingState"), 1500), /fresh listener scan/);
  assert.equal(pids().length, 1);
  await until(() => pids().every((pid) => !alive(pid)), 1000);
});

test("an accepted send-only repair finishes after its client disconnects", async (context) => {
  const { paths, client, pids } = await fixture(context);
  await client.reply(client.send("registerExistingProcess", {
    pid: process.pid, name: "send-only", command: "send-only", cwd: root,
    requestedPort: 48395, actualPort: 48396, host: "127.0.0.1", networkId: "send-only", source: "hooked",
  }));
  await client.reply(client.send("flushRouteTables"));
  const shard = getRouteTablePathForLogicalPort(48395, "send-only", paths.routes);
  fs.writeFileSync(paths.data, `p${process.pid}\ncsend-only\nn127.0.0.1:48396\n`);
  fs.writeFileSync(paths.block, "");
  fs.writeFileSync(shard, "truncated");
  client.send("repairRoutingState");
  await until(() => fs.existsSync(paths.entered));
  client.socket.destroy();
  await delay(50);
  assert.ok(pids().some(alive), "an accepted mutation must survive peer disconnection");
  fs.writeFileSync(paths.release, "");
  await until(() => fs.readFileSync(shard, "utf8") !== "truncated");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(shard, "utf8")));
});

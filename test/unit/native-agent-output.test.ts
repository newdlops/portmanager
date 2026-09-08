import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

const root = path.resolve(__dirname, "../../..");
const agent = process.env.PORT_MANAGER_TEST_NATIVE_AGENT_PATH ?? path.join(root, "media/native/portmanager_agent");
interface Message { type?: string; id?: string; ok?: boolean; payload?: any; error?: string }

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    assert.ok(performance.now() < deadline, "output fixture exceeded its deadline");
    await delay(5);
  }
}

/** Real Unix sockets exercise partial writes and NDJSON framing. Pausing reads
 * keeps data larger than the kernel buffer pending in the daemon's own queue. */
async function connect(context: TestContext, socketPath: string) {
  const socket = net.createConnection(socketPath);
  const messages: Message[] = [];
  let input = "", failure: Error | undefined, sequence = 0;
  socket.on("error", error => { failure = error; });
  socket.on("data", chunk => {
    input += chunk.toString();
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      try { messages.push(JSON.parse(input.slice(0, end)) as Message); }
      catch (error) { failure = error as Error; }
      input = input.slice(end + 1);
    }
  });
  context.after(() => socket.destroy());
  await once(socket, "connect");
  return {
    socket, messages,
    send(method: string, payload?: unknown, extension = false) {
      const id = `${extension ? "extension-" : ""}output-${++sequence}`;
      socket.write(JSON.stringify({ id, method, payload }) + "\n");
      return id;
    },
    async reply(id: string, timeoutMs = 2000) {
      await until(() => { if (failure) throw failure; return messages.some(row => row.id === id); }, timeoutMs);
      const row = messages.find(row => row.id === id)!;
      assert.equal(row.ok, true, row.error);
      return row.payload;
    },
    check() { if (failure) throw failure; },
  };
}

async function fixture(context: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-output-"));
  const socketPath = path.join(directory, "socket");
  fs.writeFileSync(path.join(directory, "lsof"), '#!/bin/sh\n/bin/cat "$PM_OUTPUT_DATA"\n', { mode: 0o755 });
  const data = path.join(directory, "data");
  fs.writeFileSync(data, Array.from({ length: 2000 }, (_, index) => `p${1000000 + index}\ncfixture\nn127.0.0.1:${30000 + index}\n`).join(""));
  const child = spawn(agent, ["--socket", socketPath, "--route-table", path.join(directory, "routes"),
    "--agent-main", path.join(root, "out/src/agent/agent-main.js"), "--dns-port", "0"], {
    stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
      PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "1", PM_OUTPUT_DATA: data },
  });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
  const running = () => child.exitCode === null && child.signalCode === null;
  context.after(async () => {
    if (running()) { child.kill("SIGTERM"); await until(() => !running()).catch(() => child.kill("SIGKILL")); }
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  await until(() => { assert.ok(running(), stderr); return fs.existsSync(socketPath); });
  // bind creates the path before listen makes it connectable; retry only that
  // startup interval, never hide a failure after the daemon is serving RPCs.
  let healthy: Awaited<ReturnType<typeof connect>> | undefined;
  const readyDeadline = performance.now() + 2000;
  while (healthy === undefined) {
    try { healthy = await connect(context, socketPath); }
    catch (error) {
      assert.ok(running(), stderr);
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED" || performance.now() >= readyDeadline) throw error;
      await delay(5);
    }
  }
  const snapshot = await healthy.reply(healthy.send("listSnapshot"));
  assert.equal(snapshot.listeners.length, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 900_000);
  return { socketPath, healthy, child, running };
}

test("eight non-readers cannot stall DNS publication and are disconnected at their output deadline", async (context) => {
  const { socketPath, healthy } = await fixture(context);
  const slow = await Promise.all(Array.from({ length: 8 }, () => connect(context, socketPath)));
  for (const client of slow) {
    client.socket.pause();
    client.send("listSnapshot");
  }
  slow[0]!.socket.end();
  await delay(10);
  const started = performance.now();
  const applied = await healthy.reply(healthy.send("syncBrowserDns", { records: "output.pm=127.120.5.8" }), 500);
  assert.equal(applied.applied, true);
  assert.ok(performance.now() - started < 500, "output waits must not accumulate per-client 100ms stalls");
  await delay(1100);
  for (const client of slow) client.socket.resume();
  await until(() => slow.every(client => client.socket.destroyed));
  assert.equal((await healthy.reply(healthy.send("daemonStatus"))).browserDnsRunning, true);
});

test("partial responses and coalesced snapshots remain complete FIFO frames on one slow connection", async (context) => {
  const { socketPath, healthy } = await fixture(context);
  const client = await connect(context, socketPath);
  client.socket.pause();
  const first = client.send("listSnapshot", undefined, true);
  await delay(80);
  const status = client.send("daemonStatus", undefined, true);
  for (let index = 0; index < 3; index++) {
    await healthy.reply(healthy.send("registerExistingProcess", {
      pid: process.pid, name: `phase-${index}`, command: "output", cwd: root, source: "hooked",
      requestedPort: 48500, actualPort: 48501, host: "127.0.0.1", networkId: "output",
    }));
    await delay(70);
  }
  client.socket.resume();
  assert.equal((await client.reply(first)).listeners.length, 2000);
  assert.equal((await client.reply(status)).status, "running");
  await until(() => {
    client.check();
    return client.messages.some(row => row.type === "snapshot" && row.payload.processes.some((process: { name: string }) => process.name === "phase-2"));
  });
  const frames = client.messages.filter(row => row.type === "response");
  assert.deepEqual(frames.map(row => row.id), [first, status]);
  assert.equal(client.messages.filter(row => row.type === "snapshot").length, 1, "only wholly unsent snapshots coalesce");
  assert.equal(client.socket.destroyed, false);
});

test("a half-closed request writer receives the entire large response before EOF", async (context) => {
  const { socketPath } = await fixture(context);
  const client = await connect(context, socketPath);
  const closed = once(client.socket, "close");
  const id = client.send("listSnapshot");
  client.socket.end();
  assert.equal((await client.reply(id)).listeners.length, 2000);
  await closed;
  client.check();
});

test("control pushes share the same FIFO as responses and cannot block another client's DNS update", async (context) => {
  const { socketPath, healthy } = await fixture(context);
  const control = await connect(context, socketPath);
  await control.reply(control.send("controlChannel", { pid: process.pid, networkId: "control" }));
  control.socket.pause();
  const status = control.send("listSnapshot");
  // Valid JSON remains an opaque control line to the daemon.
  const line = JSON.stringify({ type: "fixture-control", body: "x".repeat(120_000) });
  const pushed = healthy.send("respawnChild", { parentPids: String(process.pid), networkId: "control", line });
  await delay(40);
  assert.equal(healthy.messages.some(row => row.id === pushed), false, "a queued control command is not delivered yet");
  assert.equal((await healthy.reply(healthy.send("syncBrowserDns", { records: "control.pm=127.120.5.9" }), 500)).applied, true);
  control.socket.resume();
  await healthy.reply(pushed);
  assert.equal((await control.reply(status)).listeners.length, 2000);
  await until(() => { control.check(); return control.messages.some(row => row.type === "fixture-control"); });
  assert.deepEqual(control.messages.map(row => row.type), ["response", "response", "fixture-control"]);
});

test("a saturated response backlog disconnects its client without discarding accepted registrations", async (context) => {
  const { socketPath, healthy } = await fixture(context);
  const slow = await connect(context, socketPath);
  slow.socket.pause();
  for (let index = 0; index < 20; index++) slow.send("listSnapshot");
  const started = performance.now();
  await healthy.reply(healthy.send("registerExistingProcess", {
    pid: process.pid, name: "survives", command: "survives", cwd: root, source: "hooked",
    requestedPort: 48502, actualPort: 48503, host: "127.0.0.1", networkId: "output",
  }), 500);
  assert.ok(performance.now() - started < 500);
  await delay(100);
  slow.socket.resume();
  await until(() => slow.socket.destroyed, 500);
  assert.equal((await healthy.reply(healthy.send("daemonStatus"))).routeCount, 1);
});

test("shutdown drains already queued replies before closing the daemon", async (context) => {
  const { healthy, running } = await fixture(context);
  const snapshot = healthy.send("listSnapshot");
  const shutdown = healthy.send("shutdownDaemon");
  assert.equal((await healthy.reply(snapshot)).listeners.length, 2000);
  assert.equal(await healthy.reply(shutdown), true);
  await until(() => !running());
});

test("a control reader that closes before delivery produces a failed respawn acknowledgement", async (context) => {
  const { socketPath, healthy } = await fixture(context);
  const control = await connect(context, socketPath);
  await control.reply(control.send("controlChannel", { pid: process.pid, networkId: "control-fail" }));
  control.socket.pause();
  control.send("listSnapshot");
  const pushed = healthy.send("respawnChild", {
    parentPids: String(process.pid), networkId: "control-fail", line: "x".repeat(120_000),
  });
  await delay(40);
  assert.equal(healthy.messages.some(row => row.id === pushed), false);
  control.socket.destroy();
  await assert.rejects(healthy.reply(pushed), /Control channel closed before command delivery/);
  assert.equal((await healthy.reply(healthy.send("daemonStatus"))).status, "running");
});

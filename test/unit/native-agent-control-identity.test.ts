import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

interface Response { id?: string; ok?: boolean; error?: string }

/** The daemon and sockets belong only to this fixture; no production service is contacted. */
test("native control registration authenticates its socket PID and keeps its network binding", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, async context => {
  const root = path.resolve(__dirname, "../../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-control-identity-"));
  const executable = path.join(directory, "agent");
  const sources = [
    "portmanager_agent.c", "portmanager_agent_probe.c", "portmanager_agent_state.c", "portmanager_agent_json.c",
    "portmanager_agent_dns.c", "portmanager_agent_scan.c", "portmanager_agent_output.c", "portmanager_agent_publication.c",
  ].map(source => path.join(root, "native/agent", source));
  execFileSync("cc", ["-O2", "-pthread", ...sources, path.join(root, "native/shared/pm_peer_process.c"),
    path.join(root, "native/shared/pm_dev_log.c"), "-o", executable], { timeout: 30_000 });
  const socketPath = path.join(directory, "socket");
  const lsof = path.join(directory, "lsof");
  fs.writeFileSync(lsof, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${directory}:${process.env.PATH}`,
    PORT_MANAGER_HOOK_DISABLED: "1", PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "1" };
  delete environment.DYLD_INSERT_LIBRARIES;
  delete environment.LD_PRELOAD;
  const child = spawn(executable, ["--socket", socketPath, "--route-table", path.join(directory, "routes"), "--dns-port", "0"], {
    env: environment, stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  child.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
  const sockets: net.Socket[] = [];
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const deadline = performance.now() + 3000;
  while (!fs.existsSync(socketPath)) {
    assert.ok(child.exitCode === null && child.signalCode === null, diagnostics);
    assert.ok(performance.now() < deadline, "isolated daemon startup timed out");
    await delay(5);
  }
  const socket = net.createConnection(socketPath);
  sockets.push(socket);
  let input = "", sequence = 0;
  const replies = new Map<string, Response>();
  let socketError: Error | undefined;
  socket.on("error", error => { socketError = error; });
  socket.on("data", chunk => {
    input += chunk.toString();
    let newline: number;
    while ((newline = input.indexOf("\n")) >= 0) {
      const row = JSON.parse(input.slice(0, newline)) as Response;
      if (row.id) replies.set(row.id, row);
      input = input.slice(newline + 1);
    }
  });
  await once(socket, "connect");
  async function request(method: string, payload: unknown): Promise<Response> {
    const id = `audit-control-${++sequence}`;
    socket.write(JSON.stringify({ id, method, payload }) + "\n");
    const deadline = performance.now() + 2000;
    while (!replies.has(id)) {
      if (socketError) throw socketError;
      assert.ok(performance.now() < deadline, "isolated control response timed out");
      await delay(5);
    }
    return replies.get(id)!;
  }
  for (const pid of [0, -1, 2147483646, child.pid!, process.ppid]) {
    const response = await request("controlChannel", { pid, networkId: "network-a" });
    assert.equal(response.ok, false, `claimed PID ${pid} must not hijack another process's control channel`);
    assert.match(response.error ?? "", /socket peer/);
  }
  assert.equal((await request("controlChannel", { pid: process.pid, networkId: "" })).ok, false);
  assert.equal((await request("controlChannel", { pid: process.pid, networkId: "x".repeat(125) })).ok, false);
  assert.equal((await request("controlChannel", { pid: process.pid, networkId: "x".repeat(500) })).ok, false);
  assert.equal((await request("controlChannel", { pid: process.pid, networkId: "network-a" })).ok, true);
  assert.equal((await request("controlChannel", { pid: process.pid, networkId: "network-a" })).ok, true);
  assert.equal((await request("controlChannel", { pid: process.pid, networkId: "network-b" })).ok, false);
  assert.equal((await request("respawnChild", { parentPids: String(process.pid), networkId: "", line: "FIXTURE_ONLY" })).ok, false);
  assert.equal((await request("respawnChild", { parentPids: String(process.pid), networkId: "network-b", line: "FIXTURE_ONLY" })).ok, false);
  assert.equal(child.exitCode, null, "rejected requests must not stop the daemon");
});

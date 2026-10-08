import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ensureAgentControllerToken, ensureAgentNetworkToken } from "../../src/agent/agent-authorization";
import { loopbackAddressForNetwork } from "../../src/core/networks/loopback-address";

interface Response { id?: string; ok?: boolean; error?: string; payload?: { allocationId?: string } }

/** The daemon and sockets belong only to this fixture; no production service is contacted. */
test("native control registration authenticates its socket PID and keeps its network binding", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, async context => {
  const root = path.resolve(__dirname, "../../..");
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pm-control-identity-"));
  const tokenPath = path.join(directory, "private", "controller.key");
  const controllerToken = ensureAgentControllerToken(tokenPath);
  const networkToken = ensureAgentNetworkToken("fixture", "network-a", tokenPath);
  const otherToken = ensureAgentNetworkToken("fixture", "network-b", tokenPath);
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
  const child = spawn(executable, ["--socket", socketPath, "--route-table", path.join(directory, "routes"), "--dns-port", "0",
    "--controller-token-file", tokenPath], {
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
  const events: unknown[] = [];
  let socketError: Error | undefined;
  socket.on("error", error => { socketError = error; });
  socket.on("data", chunk => {
    input += chunk.toString();
    let newline: number;
    while ((newline = input.indexOf("\n")) >= 0) {
      const row = JSON.parse(input.slice(0, newline)) as Response;
      if (row.id) replies.set(row.id, row);
      else events.push(row);
      input = input.slice(newline + 1);
    }
  });
  await once(socket, "connect");
  async function request(method: string, payload: unknown, authorization: string | undefined = controllerToken,
    authorizationNetworkId?: string): Promise<Response> {
    const id = `${authorization === controllerToken ? "audit-control" : "extension-forged"}-${++sequence}`;
    socket.write(JSON.stringify({ id, method, payload, authorization, authorizationNetworkId }) + "\n");
    const deadline = performance.now() + 2000;
    while (!replies.has(id)) {
      if (socketError) throw socketError;
      assert.ok(performance.now() < deadline, "isolated control response timed out");
      await delay(5);
    }
    return replies.get(id)!;
  }
  // Missing capability is deliberately different from the default controller.
  async function anonymous(method: string, payload: unknown = {}): Promise<Response> {
    return request(method, payload, "");
  }
  assert.equal((await anonymous("shutdownDaemon")).ok, false);
  assert.equal((await anonymous("daemonStatus")).ok, true, "readiness is public without granting event subscription");
  assert.equal((await anonymous("listSnapshot")).ok, false);
  assert.equal((await anonymous("registerExistingProcess", { pid: child.pid, networkId: "network-b", requestedPort: 31001 })).ok, false);
  assert.equal((await anonymous("shutdownDaemon", { authorization: controllerToken })).ok, false,
    "nested credentials cannot authorize an outer request");
  assert.equal((await anonymous("shutdownDaemon", { text: `\"authorization\":\"${controllerToken}\"` })).ok, false,
    "key-like text inside strings cannot authorize a request");
  for (const method of ["shutdownDaemon", "respawnChild", "startManagedProcess", "stopProcess", "restartProcess",
    "removeProcess", "repairRoutingState", "refreshSnapshot", "listSnapshot", "syncBrowserDns", "flushRouteTables"]) {
    assert.equal((await request(method, {}, networkToken, "network-a")).ok, false, `${method} requires a controller`);
  }
  assert.deepEqual(events, [], "rejected workload requests must not subscribe to snapshots");
  const ownedListener = net.createServer();
  context.after(() => ownedListener.close());
  await new Promise<void>(resolve => ownedListener.listen(0, "127.0.0.1", resolve));
  const selfPayload = { pid: process.pid, networkId: "network-a", requestedPort: 31001,
    actualPort: (ownedListener.address() as net.AddressInfo).port, host: "127.0.0.1", source: "hooked" };
  assert.equal((await request("registerExistingProcess", { ...selfPayload, actualPort: 1 }, networkToken, "network-a")).ok, false,
    "a route needs a TCP descriptor owned by the authenticated caller");
  assert.equal((await request("registerExistingProcess", { ...selfPayload, pid: child.pid }, networkToken, "network-a")).ok, false);
  assert.equal((await request("registerExistingProcess", { ...selfPayload, networkId: "network-b" }, networkToken, "network-a")).ok, false);
  assert.equal((await request("registerExistingProcess", { ...selfPayload, host: loopbackAddressForNetwork("network-b") }, networkToken, "network-a")).ok, false);
  assert.equal((await request("registerExistingProcess", { ...selfPayload, processGroupId: 2147483646 }, networkToken, "network-a")).ok, false);
  assert.equal((await request("registerExistingProcess", { ...selfPayload, source: "compose" }, networkToken, "network-a")).ok, false);
  assert.equal((await request("registerExistingProcess", selfPayload, networkToken, "network-a")).ok, true);
  assert.equal((await request("registerExistingProcess", { ...selfPayload, networkId: "network-b",
    host: loopbackAddressForNetwork("network-b") }, otherToken, "network-b")).ok, false, "live process identity cannot switch realms even with another capability");
  assert.equal((await request("releaseProcessRoute", { ...selfPayload, pid: child.pid }, networkToken, "network-a")).ok, false);
  assert.equal((await request("allocateRoute", { networkId: "network-b", requestedPort: 31002 }, networkToken, "network-a")).ok, false);
  const allocationB = await request("allocateRoute", { networkId: "network-b", requestedPort: 31002 });
  assert.equal(allocationB.ok, true);
  assert.equal(typeof allocationB.payload?.allocationId, "string");
  assert.equal((await request("releaseRouteAllocation", { allocationId: allocationB.payload?.allocationId }, networkToken, "network-a")).ok, false);
  assert.equal((await request("releaseProcessRoute", { ...selfPayload, allocationId: allocationB.payload?.allocationId }, networkToken, "network-a")).ok, false);
  const released = await request("releaseRouteAllocation", { allocationId: allocationB.payload?.allocationId });
  assert.equal(released.ok, true);
  assert.equal(released.payload, true, "rejected guest releases must preserve the foreign allocation");
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
  await delay(80);
  assert.deepEqual(events, [], "forged extension ids on accepted guest/anonymous requests must not receive any snapshot");
  assert.equal(child.exitCode, null, "rejected requests must not stop the daemon");
});

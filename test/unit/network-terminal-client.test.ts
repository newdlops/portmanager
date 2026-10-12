import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ProxyNetworkResources } from "../../src/platform/ports/proxy-network-resources";
import type { NetworkShellLaunch } from "../../src/platform/process/macos-network-runtime";
import { buildNetworkTerminalClientCommand, runNetworkTerminalClient } from "../../src/platform/process/network-terminal-client";
import { NetworkTerminalControl } from "../../src/platform/process/network-terminal-control";
import { buildNodeRuntimeEnvironment } from "../../src/platform/process/node-runtime";

/** Exercise the sourced command in an actual shell: exec would suppress the
 * host witness on either controller failure or a normally exited child. */
for (const outcome of ["preparation-error", "child-exit"] as const) {
  test(`pm preserves the original shell after ${outcome}`, { skip: process.platform !== "darwin", timeout: 5000 }, async context => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-cli-return-")));
    const networkId = "network ' with $(literal)";
    const closed: string[] = [];
    const control = new NetworkTerminalControl(path.join(root, "control"), {
      prepare: async (selected, cwd) => {
        assert.equal(selected, networkId);
        assert.equal(cwd, root);
        if (outcome === "preparation-error") throw new Error("Fixture preparation failed.");
        return { id: "fixture", networkId, cwd, shellPath: "/bin/sh", shellArgs: ["-c", "exit 23"], env: {} };
      }, observe: async () => {}, close: async id => { closed.push(id); },
    });
    const descriptor = await control.start();
    context.after(async () => { await control.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const command = buildNetworkTerminalClientCommand(process.execPath, path.resolve(__dirname, "../../src/cli/portmanager-cli.js"),
      descriptor.socketPath, descriptor.tokenFilePath, networkId);
    const attach = path.join(root, "attach ' quoted.sh");
    fs.writeFileSync(attach, command + "\n");
    const shell = spawn("/bin/zsh", ["-dfc", '. "$1"; printf "__HOST_RETURNED__:%s:%s\\n" "$?" "$PWD"', "pm-fixture", attach], {
      cwd: root, env: buildNodeRuntimeEnvironment(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    shell.stdout.on("data", bytes => { stdout += bytes; });
    shell.stderr.on("data", bytes => { stderr += bytes; });
    const [code] = await once(shell, "close");
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), `__HOST_RETURNED__:${outcome === "preparation-error" ? 1 : 23}:${root}`);
    if (outcome === "preparation-error") assert.match(stderr, /Fixture preparation failed/);
    else {
      const deadline = performance.now() + 2000;
      while (!closed.includes("fixture")) { assert.ok(performance.now() < deadline); await delay(5); }
    }
  });
}

test("a stalled preparation times out, removes signal handlers and closes its late launch", {
  skip: process.platform !== "darwin", timeout: 5000,
}, async context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-cli-stall-")));
  const resources = new ProxyNetworkResources();
  let release!: (launch: NetworkShellLaunch) => void;
  const preparing = new Promise<NetworkShellLaunch>(resolve => { release = resolve; });
  const closed: string[] = [];
  const control = new NetworkTerminalControl(path.join(root, "control"), {
    prepare: () => preparing, observe: async () => assert.fail("A canceled launch must not be observed."),
    close: async id => { closed.push(id); },
  }, resources);
  const descriptor = await control.start();
  context.after(async () => { await control.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const counts = signals.map(signal => process.listenerCount(signal));
  await assert.rejects(runNetworkTerminalClient([descriptor.socketPath, descriptor.tokenFilePath, "fixture", root],
    { startupTimeoutMs: 100 }), /terminal startup timed out/);
  assert.deepEqual(signals.map(signal => process.listenerCount(signal)), counts);
  release({ id: "late-launch", networkId: "fixture", cwd: root, shellPath: "/bin/sh", shellArgs: [], env: {} });
  const deadline = performance.now() + 2000;
  while (!closed.includes("late-launch")) { assert.ok(performance.now() < deadline); await delay(5); }
  await control.dispose();
  assert.ok(Object.values(resources.budget.used).every(value => value === 0));
});

test("a controller EOF before launch reports an error instead of false success", {
  skip: process.platform !== "darwin", timeout: 5000,
}, async context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-cli-eof-")));
  const socketPath = path.join(root, "control.sock"), tokenPath = path.join(root, "control.key");
  fs.writeFileSync(tokenPath, "a".repeat(64), { mode: 0o600 });
  const server = net.createServer(socket => socket.once("data", () => socket.end()));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  context.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(runNetworkTerminalClient([socketPath, tokenPath, "fixture", root]), /disconnected before the terminal started/);
});

test("terminal menu cancellation preserves its shell and only host input selects a replacement", {
  skip: process.platform !== "darwin", timeout: 10_000,
}, async context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-cli-menu-")));
  const rows = path.join(root, "networks.tsv");
  fs.writeFileSync(rows, "network-a\t알파 A\tunused\t5432 -> database\nnetwork-b\tBeta B\tunused\tno services\nnetwork-bad\tUnavailable\tunused\tno services\n");
  const launches: NetworkShellLaunch[] = [];
  const closed: string[] = [];
  const control = new NetworkTerminalControl(path.join(root, "control"), {
    prepare: async (networkId, cwd) => {
      if (networkId === "network-bad") throw new Error("Fixture network unavailable.");
      const id = `launch-${launches.length + 1}`;
      const directory = path.join(root, id); fs.mkdirSync(directory);
      const plan = { id, networkId, cwd, networkName: networkId === "network-a" ? "알파 A" : "Beta B",
        shellPath: process.execPath, shellArgs: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, "pid"))},String(process.pid));setInterval(()=>{},1000)`],
        menuRequestPath: path.join(directory, "menu.request"), env: {} };
      launches.push(plan); return plan;
    }, observe: async () => {}, close: async id => {
      closed.push(id);
      const pid = path.join(root, id, "pid");
      if (fs.existsSync(pid)) { try { process.kill(Number(fs.readFileSync(pid, "utf8")), "SIGTERM"); } catch {} }
    },
  });
  const descriptor = await control.start();
  const cli = spawn(process.execPath, [path.resolve(__dirname, "../../src/cli/portmanager-cli.js"), "terminal",
    descriptor.socketPath, descriptor.tokenFilePath, "network-a", root], {
    cwd: root, env: { ...buildNodeRuntimeEnvironment(), PORT_MANAGER_NETWORKS_FILE: rows }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  cli.stdout.on("data", () => {}); cli.stderr.on("data", bytes => { output += bytes; });
  context.after(async () => {
    if (cli.exitCode === null && cli.signalCode === null) { const exited = once(cli, "exit"); cli.kill("SIGTERM"); await exited; }
    await control.dispose(); fs.rmSync(root, { recursive: true, force: true });
  });
  const until = async (predicate: () => boolean) => {
    const deadline = performance.now() + 3000;
    while (!predicate()) { assert.equal(cli.exitCode, null, output); assert.ok(performance.now() < deadline, output); await delay(10); }
  };
  await until(() => launches.length === 1 && fs.existsSync(path.join(root, "launch-1/pid")));
  const request = launches[0].menuRequestPath!;
  // A forged payload requests UI only; it must never select the next scope.
  fs.writeFileSync(request, JSON.stringify({ networkId: "network-b", command: "clean" }));
  await until(() => output.includes("Select Port Manager network"));
  assert.match(output, /알파 A/); assert.match(output, /5432 -> database/);
  assert.match(output, /Commands: current, status, version, doctor, routes, repair, clean, detach, help/);
  assert.equal(launches.length, 1); assert.deepEqual(closed, []);
  cli.stdin.write("\n");
  await until(() => !fs.existsSync(request));
  assert.equal(launches.length, 1); assert.deepEqual(closed, []);

  output = ""; fs.writeFileSync(request, "");
  await until(() => output.includes("Select Port Manager network"));
  cli.stdin.write("3\n");
  await until(() => output.includes("Fixture network unavailable"));
  assert.equal(launches.length, 1); assert.deepEqual(closed, [], "a failed preparation preserves the current shell");

  output = ""; fs.writeFileSync(request, "");
  await until(() => output.includes("Select Port Manager network"));
  cli.stdin.write("Beta B\n");
  await until(() => launches.length === 2 && fs.existsSync(path.join(root, "launch-2/pid")));
  assert.equal(launches[1].networkId, "network-b");
  assert.deepEqual(closed, ["launch-1"]);
});

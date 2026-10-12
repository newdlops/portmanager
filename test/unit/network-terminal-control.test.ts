import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { NetworkShellLaunch } from "../../src/platform/process/macos-network-runtime";
import { NetworkTerminalControl, readTerminalControlToken } from "../../src/platform/process/network-terminal-control";
import { ProxyNetworkResources } from "../../src/platform/ports/proxy-network-resources";

/** Hold the first readiness check while trusted UI actions replace its owner.
 * Its eventual failure belongs to that earlier generation, never the new shell. */
for (const action of ["replace", "detach"] as const) {
  test(`a superseded readiness failure cannot close an external terminal after ${action}`, { timeout: 5000 }, async context => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-tctl-")));
    const resources = new ProxyNetworkResources();
    const closed: string[] = [];
    let rejectOriginal!: (error: Error) => void;
    const originalReadiness = new Promise<void>((_resolve, reject) => { rejectOriginal = reject; });
    let observing = false;
    let sequence = 0;
    const control = new NetworkTerminalControl(path.join(root, "control"), {
      prepare: async networkId => ({ id: `launch-${++sequence}`, networkId, shellPath: "/bin/sh",
        shellArgs: [], env: {}, cwd: root }),
      observe: async launch => {
        if (launch.id === "launch-1") { observing = true; await originalReadiness; }
      },
      close: async id => { closed.push(id); },
    }, resources);
    const descriptor = await control.start();
    const socket = net.createConnection(descriptor.socketPath);
    const frames: { type: string; launch?: NetworkShellLaunch }[] = [];
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", bytes => {
      buffer += bytes.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        frames.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    context.after(async () => { rejectOriginal(new Error("fixture cleanup")); socket.destroy(); await control.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    socket.once("connect", () => socket.write(JSON.stringify({ token: readTerminalControlToken(descriptor.tokenFilePath),
      networkId: "network-a", cwd: root }) + "\n"));
    await until(() => observing && frames.length === 1);
    assert.equal(await (action === "replace" ? control.replace("launch-1", "network-b", root) : control.detach("launch-1")), true);
    rejectOriginal(new Error("Original shell was canceled."));
    await until(() => frames.length >= 3);
    // Let the old rejection callback and a possible FIN reach the client.
    await delay(30);
    assert.deepEqual(frames.map(frame => frame.type), ["launch", "changing", action === "replace" ? "launch" : "detach"]);
    assert.equal(socket.destroyed, false);
    assert.deepEqual(closed, ["launch-1"]);
    if (action === "replace") assert.equal(frames[2].launch?.networkId, "network-b");
    socket.destroy();
    await control.dispose();
    assert.ok(Object.values(resources.budget.used).every(value => value === 0));
  });
}

test("detach cancels a replacement still waiting for the previous supervisor to close", { timeout: 5000 }, async context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-tctl-race-")));
  const resources = new ProxyNetworkResources();
  const closed: string[] = [];
  let releaseClose!: () => void;
  const firstClose = new Promise<void>(resolve => { releaseClose = resolve; });
  let sequence = 0;
  const control = new NetworkTerminalControl(path.join(root, "control"), {
    prepare: async networkId => ({ id: `launch-${++sequence}`, networkId, shellPath: "/bin/sh", shellArgs: [], env: {}, cwd: root }),
    observe: async () => {},
    close: async id => { closed.push(id); if (closed.length === 1) await firstClose; },
  }, resources);
  const descriptor = await control.start();
  const socket = net.createConnection(descriptor.socketPath);
  const frames: { type: string }[] = [];
  let buffer = "";
  socket.on("error", () => {});
  socket.on("data", bytes => {
    buffer += bytes.toString("utf8");
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) { frames.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  });
  context.after(async () => { releaseClose(); socket.destroy(); await control.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  socket.once("connect", () => socket.write(JSON.stringify({ token: readTerminalControlToken(descriptor.tokenFilePath), networkId: "network-a", cwd: root }) + "\n"));
  await until(() => frames.length === 1);
  const replacing = assert.rejects(control.replace("launch-1", "network-b", root), /canceled/);
  await until(() => closed.length === 1);
  assert.equal(await control.detach("launch-1"), true);
  releaseClose();
  await replacing;
  await until(() => frames.length >= 4);
  await delay(30);
  assert.deepEqual(frames.map(frame => frame.type), ["launch", "changing", "changing", "detach"]);
  assert.deepEqual(closed, ["launch-1", "launch-1", "launch-2"]);
  assert.equal(socket.destroyed, false);
  await control.dispose();
  assert.ok(Object.values(resources.budget.used).every(value => value === 0));
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate()) { assert.ok(performance.now() < deadline, "Terminal control fixture did not advance."); await delay(5); }
}

test("a failed replacement preparation does not hide the current shell's readiness failure", { timeout: 5000 }, async context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-tctl-error-")));
  const resources = new ProxyNetworkResources();
  let rejectReadiness!: (error: Error) => void;
  const readiness = new Promise<void>((_resolve, reject) => { rejectReadiness = reject; });
  const closed: string[] = [];
  const control = new NetworkTerminalControl(path.join(root, "control"), {
    prepare: async networkId => {
      if (networkId === "network-b") throw new Error("Replacement unavailable.");
      return { id: "launch-a", networkId, shellPath: "/bin/sh", shellArgs: [], env: {}, cwd: root };
    },
    observe: async () => readiness,
    close: async id => { closed.push(id); },
  }, resources);
  const descriptor = await control.start();
  const socket = net.createConnection(descriptor.socketPath);
  const frames: { type: string; message?: string }[] = [];
  let buffer = "";
  socket.on("error", () => {});
  socket.on("data", bytes => {
    buffer += bytes.toString("utf8");
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) { frames.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  });
  context.after(async () => { rejectReadiness(new Error("fixture cleanup")); socket.destroy(); await control.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  socket.once("connect", () => socket.write(JSON.stringify({ token: readTerminalControlToken(descriptor.tokenFilePath), networkId: "network-a", cwd: root }) + "\n"));
  await until(() => frames.length === 1);
  await assert.rejects(control.replace("launch-a", "network-b", root), /Replacement unavailable/);
  rejectReadiness(new Error("Current shell startup failed."));
  await until(() => socket.destroyed);
  assert.deepEqual(frames.map(frame => frame.type), ["launch", "error"]);
  assert.equal(frames[1].message, "Current shell startup failed.");
  await until(() => closed.includes("launch-a"));
  await control.dispose();
  assert.ok(Object.values(resources.budget.used).every(value => value === 0));
});

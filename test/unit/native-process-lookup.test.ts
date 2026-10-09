import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NativeProcessLookupProvider,
  parseNativeProcessLookupDetails,
  parseNativeProcessIdentity,
  parseNativeProcessTableRows,
} from "../../src/platform/process/native-process-lookup";

/**
 * Parser coverage for the optional native process lookup helper.
 *
 * The helper is a performance/capability improvement only; TypeScript callers
 * must tolerate missing fields and fall back to the existing command adapters.
 */

test("parses native process table rows", () => {
  const rows = parseNativeProcessTableRows(
    JSON.stringify({
      rows: [
        { pid: 10, parentPid: 1, processGroupId: 10, terminalId: "ttys001" },
        { pid: 20, parentPid: 10, processGroupId: 20 },
        { pid: "bad", parentPid: 10, processGroupId: 20 },
      ],
    }),
  );

  assert.deepEqual(rows, [
    { pid: 10, parentPid: 1, processGroupId: 10, terminalId: "ttys001" },
    { pid: 20, parentPid: 10, processGroupId: 20 },
  ]);
});

test("parses inspect details with optional cwd, network id and exact process birth", () => {
  const details = parseNativeProcessLookupDetails(
    JSON.stringify({
      pid: 30,
      row: { pid: 30, parentPid: 20, processGroupId: 20, terminalId: "ttys001" },
      ancestorPids: [20, 10, "ignored"],
      cwd: "/Users/lky/project/portmanager",
      networkId: "network-a",
      birth: 1791487047875746,
    }),
  );

  assert.deepEqual(details, {
    row: { pid: 30, parentPid: 20, processGroupId: 20, terminalId: "ttys001" },
    ancestorPids: [20, 10],
    cwd: "/Users/lky/project/portmanager",
    networkId: "network-a",
    birth: 1791487047875746,
  });
  for (const birth of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1791487047875746"]) {
    assert.equal(parseNativeProcessLookupDetails(JSON.stringify({ birth })).birth, undefined);
  }
});

test("returns undefined after native helper failure so callers can fall back", async () => {
  let calls = 0;
  const provider = new NativeProcessLookupProvider({
    helperPath: "/missing/portmanager_process_lookup",
    commandRunner: async () => {
      calls += 1;
      throw new Error("missing helper");
    },
  });

  assert.equal(await provider.inspectProcess(101), undefined);
  assert.equal(await provider.listProcessTableRows(), undefined);
  assert.equal(calls, 1);
});

test("direct identity lookup preserves exact birth, rejects mismatches and tolerates an exited PID", async () => {
  const birth = 1791487047875746;
  assert.deepEqual(parseNativeProcessIdentity(JSON.stringify({ pid: 10, birth })), { pid: 10, birth });
  for (const value of [{ pid: 0, birth }, { pid: 10, birth: 1.5 }, { pid: 10, birth: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(parseNativeProcessIdentity(JSON.stringify(value)), undefined);
  }
  const calls: string[][] = [];
  const provider = new NativeProcessLookupProvider({ commandRunner: async (_file, args) => {
    calls.push([...args]);
    if (args[1] === "10") throw new Error("exited fixture PID");
    return { stdout: JSON.stringify({ pid: Number(args[1]) === 12 ? 13 : 11, birth }) };
  } });
  assert.equal(await provider.readProcessIdentity(10), undefined);
  assert.deepEqual(await provider.readProcessIdentity(11), { pid: 11, birth });
  assert.equal(await provider.readProcessIdentity(12), undefined);
  assert.deepEqual(calls, [["identity", "10"], ["identity", "11"], ["identity", "12"]]);
  const separated = new NativeProcessLookupProvider({ commandRunner: async (_file, args) => {
    if (args[0] === "inspect") throw new Error("legacy inspection unavailable");
    return { stdout: JSON.stringify({ pid: 11, birth }) };
  } });
  assert.equal(await separated.inspectProcess(11), undefined);
  assert.deepEqual(await separated.readProcessIdentity(11), { pid: 11, birth }, "a legacy env/TTY failure must not disable the independent identity query");
});

test("native descriptor count measures real opens and closes and rejects stale or exited identities", {
  skip: process.platform !== "darwin" || process.env.PM_RUN_NATIVE_E2E !== "1",
}, async context => {
  const helper = path.resolve(__dirname, "../../../media/native/portmanager_process_lookup");
  const child = spawn(process.execPath, ["-e", `
    const fs = require('node:fs');
    let descriptors = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', command => {
      if (command.trim() === 'open') descriptors = Array.from({length: 12}, () => fs.openSync('/dev/null', 'r'));
      if (command.trim() === 'close') { for (const fd of descriptors) fs.closeSync(fd); descriptors = []; }
      process.stdout.write('ready\\n');
    });
    setInterval(() => {}, 1000);
    process.stdout.write('ready\\n');
  `], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout!, "data");
  const measure = (birth?: number) => {
    const args = ["fd-count", String(child.pid), ...(birth === undefined ? [] : [String(birth)])];
    const result = spawnSync(helper, args, { encoding: "utf8", timeout: 2000 });
    assert.equal(result.error, undefined);
    return { status: result.status, value: JSON.parse(result.stdout) as { pid: number; birth: number; fdCount?: number; error: number } };
  };
  const baseline = measure();
  assert.equal(baseline.status, 0);
  assert.equal(baseline.value.pid, child.pid);
  assert.equal(baseline.value.error, 0);
  assert.ok(baseline.value.birth > 0 && baseline.value.fdCount! > 0);
  const command = async (text: string) => {
    const response = once(child.stdout!, "data");
    child.stdin!.write(`${text}\n`);
    await response;
  };
  await command("open");
  assert.equal(measure(baseline.value.birth).value.fdCount, baseline.value.fdCount! + 12);
  await command("close");
  assert.equal(measure(baseline.value.birth).value.fdCount, baseline.value.fdCount);
  const stale = measure(baseline.value.birth + 1);
  assert.equal(stale.status, 1);
  assert.equal(stale.value.error, os.constants.errno.ESTALE);
  assert.equal(stale.value.fdCount, undefined);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  const gone = measure(baseline.value.birth);
  assert.equal(gone.status, 1);
  assert.equal(gone.value.error, os.constants.errno.ESRCH);
  assert.equal(gone.value.fdCount, undefined);
});

test("native descriptor count rejects malformed PID and birth arguments", {
  skip: process.platform !== "darwin" || process.env.PM_RUN_NATIVE_E2E !== "1",
}, () => {
  const helper = path.resolve(__dirname, "../../../media/native/portmanager_process_lookup");
  for (const args of [["-1"], ["1"], ["2147483648"], ["12x"], ["12", "-1"], ["12", "0"], ["12", "1x"]]) {
    const result = spawnSync(helper, ["fd-count", ...args], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "");
  }
});

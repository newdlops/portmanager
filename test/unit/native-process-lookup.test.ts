import assert from "node:assert/strict";
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeProcessLookupProvider,
  parseNativeProcessLookupDetails,
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

test("parses inspect details with optional cwd and network id", () => {
  const details = parseNativeProcessLookupDetails(
    JSON.stringify({
      pid: 30,
      row: { pid: 30, parentPid: 20, processGroupId: 20, terminalId: "ttys001" },
      ancestorPids: [20, 10, "ignored"],
      cwd: "/Users/lky/project/portmanager",
      networkId: "network-a",
    }),
  );

  assert.deepEqual(details, {
    row: { pid: 30, parentPid: 20, processGroupId: 20, terminalId: "ttys001" },
    ancestorPids: [20, 10],
    cwd: "/Users/lky/project/portmanager",
    networkId: "network-a",
  });
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

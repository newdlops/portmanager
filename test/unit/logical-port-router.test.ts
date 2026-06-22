import assert from "node:assert/strict";
import test from "node:test";

import { parseClientProcessFromLsof } from "../../src/platform/ports/tcp-connection-process-resolver";
import { buildProcessTreeContext, parsePosixProcessTable } from "../../src/platform/process/node-process-table";

/**
 * Unit tests for application-agnostic logical routing helpers.
 *
 * The runtime router must reason from TCP tuples and terminal process ancestry,
 * not from framework names such as Vite, Django, or wait-on.
 */

test("resolves client PID from an established TCP tuple without process-name rules", () => {
  const output = [
    "p101",
    "canything",
    "n127.0.0.1:49152->127.0.0.1:8004",
    "p202",
    "cPort Manager",
    "n127.0.0.1:8004->127.0.0.1:49152",
  ].join("\n");

  const process = parseClientProcessFromLsof(output, {
    logicalPort: 8004,
    localAddress: "127.0.0.1",
    localPort: 8004,
    remoteAddress: "127.0.0.1",
    remotePort: 49152,
  });

  assert.equal(process?.pid, 101);
});

test("builds process ancestry from PID, PPID, PGID, and TTY only", () => {
  const rows = parsePosixProcessTable(`
    10 1 10 ttys001
    20 10 20 ttys001
    30 20 20 ttys001
  `);

  const context = buildProcessTreeContext(rows, 30);

  assert.deepEqual(context?.ancestorPids, [20, 10]);
  assert.equal(context?.row.processGroupId, 20);
  assert.equal(context?.row.terminalId, "ttys001");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProcessTreeNetworkLabel,
  type ProcessNetworkLabelRow,
} from "../../src/core/process-network-labels";
import type { TerminalAttachment } from "../../src/shared/types";

test("process tree labels prefer direct PID before broader process labels", () => {
  const rows: ProcessNetworkLabelRow[] = [
    { pid: 10, parentPid: 1, processGroupId: 10, terminalId: "ttys001" },
    { pid: 20, parentPid: 10, processGroupId: 10, terminalId: "ttys001" },
  ];

  const resolution = resolveProcessTreeNetworkLabel(
    [
      attachment("network-direct", 20, { processGroupId: 10, terminalWindowId: "tty:ttys001" }),
      attachment("network-terminal", 10, { processGroupId: 10, terminalWindowId: "tty:ttys001" }),
    ],
    rows,
    20,
  );

  assert.deepEqual(resolution, {
    networkId: "network-direct",
    source: "direct-pid",
  });
});

test("process tree labels resolve descendants by ancestor PID", () => {
  const rows: ProcessNetworkLabelRow[] = [
    { pid: 10, parentPid: 1, processGroupId: 10, terminalId: "ttys001" },
    { pid: 20, parentPid: 10, processGroupId: 20, terminalId: "ttys001" },
    { pid: 30, parentPid: 20, processGroupId: 20 },
  ];

  const resolution = resolveProcessTreeNetworkLabel([attachment("network-a", 10)], rows, 30);

  assert.deepEqual(resolution, {
    networkId: "network-a",
    source: "ancestor-pid",
  });
});

test("process tree labels resolve detached children by process group before tty", () => {
  const rows: ProcessNetworkLabelRow[] = [
    { pid: 10, parentPid: 1, processGroupId: 10, terminalId: "ttys001" },
    { pid: 20, parentPid: 1, processGroupId: 10 },
  ];

  const resolution = resolveProcessTreeNetworkLabel(
    [
      attachment("network-pgid", 100, { processGroupId: 10 }),
      attachment("network-tty", 200, { terminalWindowId: "tty:ttys001" }),
    ],
    rows,
    20,
  );

  assert.deepEqual(resolution, {
    networkId: "network-pgid",
    source: "process-group",
  });
});

test("process tree labels return undefined for ambiguous same-tier labels", () => {
  const rows: ProcessNetworkLabelRow[] = [{ pid: 20, parentPid: 1, processGroupId: 10, terminalId: "ttys001" }];

  const resolution = resolveProcessTreeNetworkLabel(
    [
      attachment("network-a", 100, { processGroupId: 10 }),
      attachment("network-b", 200, { processGroupId: 10 }),
    ],
    rows,
    20,
  );

  assert.equal(resolution, undefined);
});

function attachment(
  networkId: string,
  rootPid: number,
  overrides: Partial<TerminalAttachment> = {},
): TerminalAttachment {
  return {
    id: `attachment-${networkId}-${rootPid}`,
    networkId,
    rootPid,
    status: "attached",
    attachedAt: "2026-06-25T00:00:00Z",
    ...overrides,
  };
}

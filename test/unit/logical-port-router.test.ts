import assert from "node:assert/strict";
import test from "node:test";

import { findRoutesMatchingClientCwd } from "../../src/core/networks/logical-route-selection";
import {
  NodeTcpConnectionProcessResolver,
  parseClientProcessFromLsof,
  parseProcessCwdFromLsof,
} from "../../src/platform/ports/tcp-connection-process-resolver";
import type { LogicalPortRouterConnection } from "../../src/platform/ports/logical-port-router";
import { parseNativeRouterQueryLine } from "../../src/platform/ports/logical-port-router";
import {
  buildProcessTreeContext,
  NodeProcessTableProvider,
  parsePosixProcessTable,
} from "../../src/platform/process/node-process-table";
import type { LogicalPortRoute } from "../../src/shared/types";

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

test("parses native logical router control requests", () => {
  const query = parseNativeRouterQueryLine("CONNECT\t42\t15432\t127.0.0.1\t15432\t127.0.0.1\t49152");

  assert.deepEqual(query, {
    id: "42",
    logicalPort: 15432,
    localAddress: "127.0.0.1",
    localPort: 15432,
    remoteAddress: "127.0.0.1",
    remotePort: 49152,
  });
});

test("parses client cwd from a cwd-only lsof query", () => {
  const cwd = parseProcessCwdFromLsof(["p101", "n/Users/lky/project/fix-payroll"].join("\n"));

  assert.equal(cwd, "/Users/lky/project/fix-payroll");
});

test("coalesces concurrent TCP and cwd lookups during router bursts", async () => {
  let establishedConnectionCalls = 0;
  let cwdCalls = 0;
  const establishedConnections = createDeferred<{ readonly stdout: string }>();
  const resolver = new NodeTcpConnectionProcessResolver({
    commandRunner: async (_file, args) => {
      if (args.includes("-iTCP")) {
        establishedConnectionCalls += 1;
        return establishedConnections.promise;
      }

      if (args.includes("-d") && args.includes("cwd")) {
        cwdCalls += 1;
        return {
          stdout: ["p101", "n/Users/lky/project/fix-payroll"].join("\n"),
        };
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    },
  });

  const first = resolver.resolveClientProcess(connection(49152));
  const second = resolver.resolveClientProcess(connection(49153));

  assert.equal(establishedConnectionCalls, 1);

  establishedConnections.resolve({
    stdout: [
      "p101",
      "cwait-on",
      "n127.0.0.1:49152->127.0.0.1:8004",
      "n127.0.0.1:49153->127.0.0.1:8004",
    ].join("\n"),
  });

  const [firstProcess, secondProcess] = await Promise.all([first, second]);

  assert.equal(firstProcess?.pid, 101);
  assert.equal(secondProcess?.pid, 101);
  assert.equal(firstProcess?.cwd, "/Users/lky/project/fix-payroll");
  assert.equal(secondProcess?.cwd, "/Users/lky/project/fix-payroll");
  assert.equal(cwdCalls, 1);
});

test("narrows ambiguous logical routes by client working directory", () => {
  const routes: LogicalPortRoute[] = [
    route("captain-network", 8004, 54084, "/Users/lky/project/captain"),
    route("payroll-network", 8004, 58465, "/Users/lky/project/fix-payroll"),
    route("payroll-network", 8007, 55608, "/Users/lky/project/fix-payroll"),
  ];

  const matches = findRoutesMatchingClientCwd(routes, 8004, "/Users/lky/project/fix-payroll");

  assert.deepEqual(matches.map((item) => item.actualPort), [58465]);
});

test("does not match sibling projects when route cwd fallback is used", () => {
  const routes: LogicalPortRoute[] = [
    route("captain-network", 8004, 54084, "/Users/lky/project/captain"),
    route("payroll-network", 8004, 58465, "/Users/lky/project/fix-payroll"),
  ];

  const matches = findRoutesMatchingClientCwd(routes, 8004, "/Users/lky/project/fix-payroll/api");

  assert.deepEqual(matches.map((item) => item.actualPort), [58465]);
});

test("selects compose routes through cwd fallback when project scope matches", () => {
  const routes: LogicalPortRoute[] = [
    {
      ...route("compose-network", 15432, 57001, "/Users/lky/project/fix-payroll/docker"),
      source: "compose",
    },
  ];

  const matches = findRoutesMatchingClientCwd(routes, 15432, "/Users/lky/project/fix-payroll");

  assert.deepEqual(matches.map((item) => item.actualPort), [57001]);
});

test("does not select sibling compose projects through cwd fallback", () => {
  const routes: LogicalPortRoute[] = [
    {
      ...route("compose-network", 15432, 57001, "/Users/lky/project/fix-payroll/docker"),
      source: "compose",
    },
  ];

  const matches = findRoutesMatchingClientCwd(routes, 15432, "/Users/lky/project/other-payroll");

  assert.deepEqual(matches, []);
});

test("does not select pending starting routes through cwd fallback", () => {
  const routes: LogicalPortRoute[] = [
    {
      ...route("payroll-network", 8004, 58465, "/Users/lky/project/fix-payroll"),
      status: "starting",
      source: "allocated",
    },
  ];

  const matches = findRoutesMatchingClientCwd(routes, 8004, "/Users/lky/project/fix-payroll");

  assert.deepEqual(matches, []);
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

test("coalesces concurrent process table snapshots during router bursts", async () => {
  if (process.platform === "win32") {
    return;
  }

  let calls = 0;
  const table = createDeferred<{ readonly stdout: string }>();
  const provider = new NodeProcessTableProvider({
    commandRunner: async () => {
      calls += 1;
      return table.promise;
    },
  });

  const first = provider.list();
  const second = provider.list();

  assert.equal(calls, 1);

  table.resolve({
    stdout: "10 1 10 ttys001\n20 10 20 ttys001",
  });

  const [firstRows, secondRows] = await Promise.all([first, second]);
  const cachedRows = await provider.list();

  assert.equal(firstRows.length, 2);
  assert.equal(secondRows.length, 2);
  assert.equal(cachedRows.length, 2);
  assert.equal(calls, 1);
});

function route(networkId: string, logicalPort: number, actualPort: number, cwd: string): LogicalPortRoute {
  return {
    logicalPort,
    actualPort,
    host: "127.0.0.1",
    cwd,
    networkId,
    status: "running",
    source: "hooked",
  };
}

function connection(remotePort: number): LogicalPortRouterConnection {
  return {
    logicalPort: 8004,
    localAddress: "127.0.0.1",
    localPort: 8004,
    remoteAddress: "127.0.0.1",
    remotePort,
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

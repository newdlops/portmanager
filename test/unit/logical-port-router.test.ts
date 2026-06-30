import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { findRoutesMatchingClientCwd } from "../../src/core/networks/logical-route-selection";
import {
  NodeTcpConnectionProcessResolver,
  parseClientProcessFromLsof,
  parseProcessCwdFromLsof,
} from "../../src/platform/ports/tcp-connection-process-resolver";
import type { LogicalPortRouterConnection } from "../../src/platform/ports/logical-port-router";
import { LogicalPortRouterManager, parseNativeRouterQueryLine } from "../../src/platform/ports/logical-port-router";
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

test("native logical router helper starts without inherited hook environment", async () => {
  const logicalPort = 61234;
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-router-env-"));
  const routerPath = path.join(tempDirectory, "router.js");
  const capturedEnvPath = path.join(tempDirectory, "env.json");
  fs.writeFileSync(
    routerPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.PM_ROUTER_ENV_PATH, JSON.stringify(process.env));',
      'process.stdout.write(`READY\\t${process.argv[2]}\\n`);',
      "process.stdin.resume();",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(routerPath, 0o755);

  const previousEnvironment = setProcessEnvironment({
    BASH_ENV: "/tmp/portmanager-bash-env.sh",
    DYLD_INSERT_LIBRARIES: "/tmp/libportmanager_hook.dylib",
    LD_PRELOAD: "/tmp/libportmanager_hook.so",
    PM_ROUTER_ENV_PATH: capturedEnvPath,
    PORT_MANAGER_DYLD_INSERT_LIBRARIES: "/tmp/libportmanager_hook.dylib",
    PORT_MANAGER_HOOK: "1",
    PORT_MANAGER_NETWORK_ID: "network-a",
    PORT_MANAGER_RUNTIME_SHIM_DIR: "/tmp/runtime-shims",
  });
  const manager = new LogicalPortRouterManager(
    {
      resolve: () => ({ host: "127.0.0.1", port: logicalPort }),
    },
    {
      nativeRouterPath: routerPath,
      nativeStartupTimeoutMs: 1000,
    },
  );

  try {
    await manager.open(logicalPort);

    const capturedEnvironment = JSON.parse(fs.readFileSync(capturedEnvPath, "utf8")) as NodeJS.ProcessEnv;
    assert.equal(capturedEnvironment.PORT_MANAGER_HOOK_DISABLED, "1");
    assert.equal(capturedEnvironment.PORT_MANAGER_HOOK, undefined);
    assert.equal(capturedEnvironment.PORT_MANAGER_NETWORK_ID, undefined);
    assert.equal(capturedEnvironment.PORT_MANAGER_RUNTIME_SHIM_DIR, undefined);
    assert.equal(capturedEnvironment.PORT_MANAGER_DYLD_INSERT_LIBRARIES, undefined);
    assert.equal(capturedEnvironment.BASH_ENV, undefined);
    assert.equal(capturedEnvironment.DYLD_INSERT_LIBRARIES, undefined);
    assert.equal(capturedEnvironment.LD_PRELOAD, undefined);
    assert.equal(capturedEnvironment.PM_ROUTER_ENV_PATH, capturedEnvPath);
  } finally {
    await manager.close(logicalPort).catch(() => undefined);
    restoreProcessEnvironment(previousEnvironment);
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("native logical router pending route requests time out instead of blocking forever", () => {
  const root = path.resolve(__dirname, "../../..");
  const routerSource = fs.readFileSync(path.join(root, "native/router/portmanager_tcp_router.c"), "utf8");
  const buildScript = fs.readFileSync(path.join(root, "scripts/build-native-hook.sh"), "utf8");

  assert.equal(routerSource.includes("PM_ROUTER_ROUTE_RESPONSE_TIMEOUT_MS 5000"), true);
  assert.equal(routerSource.includes("clock_gettime(CLOCK_REALTIME, &deadline)"), true);
  assert.equal(routerSource.includes("pthread_cond_timedwait(&route.condition, &pm_pending_mutex, &deadline)"), true);
  assert.equal(routerSource.includes("if (!route.resolved || route.failed"), true);
  assert.match(buildScript, /-pthread "\$TCP_ROUTER_SOURCE_FILE"/);
});

test("keeps opening later logical routers when one desired port is already owned", async () => {
  const occupied = await occupyRouterPort();
  const targetServer = net.createServer((socket) => {
    socket.end("ok");
  });
  await listenServer(targetServer, 0, "127.0.0.1");
  const targetPort = serverPort(targetServer);
  const freeLogicalPort = await findFreeLoopbackPort();
  const manager = new LogicalPortRouterManager({
    resolve: () => ({ host: "127.0.0.1", port: targetPort }),
  });

  try {
    await manager.sync([occupied.port, freeLogicalPort]);

    assert.equal(await readFromPort(freeLogicalPort), "ok");
  } finally {
    await manager.close(freeLogicalPort).catch(() => undefined);
    await Promise.all(occupied.servers.map((server) => closeServer(server).catch(() => undefined)));
    await closeServer(targetServer).catch(() => undefined);
  }
});

test("keeps logical router TCP streams across transient route gaps", async () => {
  const targetServer = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      socket.write(`echo:${chunk.toString("utf8")}`);
    });
  });
  await listenServer(targetServer, 0, "127.0.0.1");
  const targetPort = serverPort(targetServer);
  const logicalPort = await findFreeLoopbackPort();
  const manager = new LogicalPortRouterManager(
    {
      resolve: () => ({ host: "127.0.0.1", port: targetPort }),
    },
    { retireDelayMs: 1000 },
  );
  let socket: net.Socket | undefined;

  try {
    await manager.sync([logicalPort]);
    socket = net.createConnection({ host: "127.0.0.1", port: logicalPort });
    assert.equal(await writeAndReadSocket(socket, "first", "echo:first"), "echo:first");

    await manager.sync([]);
    await manager.sync([logicalPort]);

    assert.equal(await writeAndReadSocket(socket, "second", "echo:second"), "echo:second");
  } finally {
    socket?.destroy();
    await manager.close(logicalPort).catch(() => undefined);
    await closeServer(targetServer).catch(() => undefined);
  }
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

interface OccupiedRouterPort {
  readonly port: number;
  readonly servers: readonly net.Server[];
}

async function occupyRouterPort(): Promise<OccupiedRouterPort> {
  const ipv4Server = net.createServer();
  await listenServer(ipv4Server, 0, "127.0.0.1");
  const port = serverPort(ipv4Server);
  const servers: net.Server[] = [ipv4Server];

  const ipv6Server = net.createServer();
  try {
    await listenServer(ipv6Server, port, "::1", true);
    servers.push(ipv6Server);
  } catch {
    await closeServer(ipv6Server).catch(() => undefined);
  }

  return { port, servers };
}

async function findFreeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await listenServer(server, 0, "127.0.0.1");
  const port = serverPort(server);
  await closeServer(server);
  return port;
}

function listenServer(server: net.Server, port: number, host: string, ipv6Only?: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      port,
      host,
      ...(ipv6Only === undefined ? {} : { ipv6Only }),
    });
  });
}

function setProcessEnvironment(values: Record<string, string>): Map<string, string | undefined> {
  const previousEnvironment = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previousEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }

  return previousEnvironment;
}

function restoreProcessEnvironment(previousEnvironment: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

function readFromPort(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let output = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out reading from ${port}.`));
    }, 1000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      resolve(output);
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      output += chunk;
    });
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function writeAndReadSocket(socket: net.Socket, message: string, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}.`));
    }, 1000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const write = () => {
      socket.write(message);
    };
    const onConnect = () => {
      write();
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.on("data", onData);
    socket.once("error", onError);
    if (socket.connecting) {
      socket.once("connect", onConnect);
    } else {
      write();
    }
  });
}

function serverPort(server: net.Server): number {
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return address.port;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }

      resolve();
    });
  });
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

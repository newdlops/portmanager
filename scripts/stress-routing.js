#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const routeCount = Number(process.argv[2] ?? "10000");
const networkCount = Number(process.argv[3] ?? process.env.PORT_MANAGER_ROUTING_STRESS_NETWORKS ?? "1");
const timeoutMs = Number(process.env.PORT_MANAGER_ROUTING_STRESS_TIMEOUT_MS ?? "180000");

if (!Number.isInteger(routeCount) || routeCount <= 0) {
  throw new Error(`Invalid route count: ${process.argv[2]}`);
}
if (!Number.isInteger(networkCount) || networkCount <= 0 || networkCount > routeCount) {
  throw new Error(`Invalid network count: ${process.argv[3] ?? process.env.PORT_MANAGER_ROUTING_STRESS_NETWORKS}`);
}

function withTimeout(promise, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function listen(server, port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off("error", onError);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      cleanup();
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function readRouteTable(routeTablePath) {
  return JSON.parse(fs.readFileSync(routeTablePath, "utf8"));
}

function networkIdForIndex(index) {
  return `network-${String((index % networkCount) + 1).padStart(3, "0")}`;
}

function expectedRouteCountForNetwork(count, networkIndex) {
  const baseCount = Math.floor(count / networkCount);
  return baseCount + (networkIndex < count % networkCount ? 1 : 0);
}

function createFakeLauncher() {
  return {
    launch: async (request) => ({
      pid: 1,
      command: request.command,
    }),
    stop: async () => undefined,
    onExit: () => ({ dispose: () => undefined }),
  };
}

async function stressRouteTableRefresh(count) {
  const { PortManagerAgent } = require(path.join(root, "out/src/agent/port-manager-agent.js"));
  const {
    ROUTE_TABLE_TTL_MS,
    getRouteTablePathForNetwork,
    routeTableRefreshMarginMs,
  } = require(path.join(root, "out/src/agent/route-table.js"));
  const { ManagedProcessRegistry } = require(path.join(root, "out/src/core/process-registry.js"));
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-route-table-stress-"));
  const routeTablePath = path.join(tempDirectory, "routes.json");
  const networkIds = Array.from({ length: networkCount }, (_, index) => `network-${String(index + 1).padStart(3, "0")}`);
  let nowMs = Date.parse("2026-06-21T10:00:00.000Z");
  let establishedConnections = [];

  try {
    const registry = new ManagedProcessRegistry({
      now: () => new Date(nowMs),
      idFactory: (() => {
        let nextId = 1;
        return () => `stress-process-${nextId++}`;
      })(),
    });

    for (let index = 0; index < count; index += 1) {
      registry.add({
        id: `stress-process-${index}`,
        pid: 20_000 + index,
        name: "node",
        command: `node server-${index}.js`,
        cwd: `/workspace/cluster-${Math.floor(index / 16)}`,
        requestedPort: 8_000 + index,
        actualPort: 58_000 + index,
        status: "running",
        startedAt: new Date(nowMs).toISOString(),
        url: `http://127.0.0.1:${58_000 + index}`,
        source: "hooked",
        networkId: networkIdForIndex(index),
      });
    }

    const agent = new PortManagerAgent({
      registry,
      processLauncher: createFakeLauncher(),
      portAvailabilityProvider: {
        check: async (port) => ({ port, available: true }),
      },
      listeningPortProvider: {
        list: async () => [],
      },
      establishedConnectionProvider: {
        list: async () => establishedConnections,
      },
      agentPid: 777,
      now: () => new Date(nowMs),
      routeTablePath,
    });

    try {
      const initialRouteTable = readRouteTable(routeTablePath);
      if (initialRouteTable.routes.length !== count) {
        throw new Error(`route table wrote ${initialRouteTable.routes.length}/${count} routes`);
      }
      if (initialRouteTable.ttlStartsAfterFirstHandshake !== true || !Number.isFinite(initialRouteTable.preHandshakeLeaseMs)) {
        throw new Error("route table did not publish pre-handshake TTL metadata");
      }
      for (let networkIndex = 0; networkIndex < networkIds.length; networkIndex += 1) {
        const networkRouteTable = readRouteTable(getRouteTablePathForNetwork(networkIds[networkIndex], routeTablePath));
        const expectedCount = expectedRouteCountForNetwork(count, networkIndex);
        if (networkRouteTable.routes.length !== expectedCount) {
          throw new Error(
            `network route table ${networkIds[networkIndex]} wrote ${networkRouteTable.routes.length}/${expectedCount} routes`,
          );
        }
        if (networkRouteTable.ttlStartsAfterFirstHandshake !== true) {
          throw new Error(`network route table ${networkIds[networkIndex]} did not wait for first handshake`);
        }
      }

      nowMs = initialRouteTable.expiresAtMs - routeTableRefreshMarginMs(ROUTE_TABLE_TTL_MS) + 1;
      await agent.refreshSnapshot();

      const refreshedRouteTable = readRouteTable(routeTablePath);
      if (refreshedRouteTable.routes.length !== count) {
        throw new Error(`route table refreshed ${refreshedRouteTable.routes.length}/${count} routes`);
      }
      if (refreshedRouteTable.expiresAtMs !== nowMs + initialRouteTable.preHandshakeLeaseMs) {
        throw new Error(`route table pre-handshake lease was not refreshed for ${count} running routes`);
      }
      for (const networkId of networkIds) {
        const networkRouteTable = readRouteTable(getRouteTablePathForNetwork(networkId, routeTablePath));
        if (networkRouteTable.expiresAtMs !== nowMs + networkRouteTable.preHandshakeLeaseMs) {
          throw new Error(`network route table pre-handshake lease was not refreshed for ${networkId}`);
        }
      }

      establishedConnections = Array.from({ length: count }, (_, index) => ({
        localAddress: "127.0.0.1",
        localPort: 58_000 + index,
        remoteAddress: "127.0.0.1",
        remotePort: 40_000 + index,
      }));
      nowMs += 2_001;
      await agent.refreshSnapshot();

      const observedRouteTable = readRouteTable(routeTablePath);
      if (observedRouteTable.ttlStartsAfterFirstHandshake === true) {
        throw new Error("route table stayed in pre-handshake mode after observed connections");
      }
      if (observedRouteTable.expiresAtMs !== nowMs + ROUTE_TABLE_TTL_MS) {
        throw new Error(`route table observed TTL was not refreshed for ${count} routes`);
      }
    } finally {
      agent.dispose();
    }

    console.log(`route-table stress ok: ${count} running routes across ${networkCount} networks`);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function reservePreferredPorts(count) {
  const servers = [];
  let candidate = 20_000;

  try {
    while (servers.length < count && candidate <= 55_000) {
      const server = net.createServer();
      try {
        await listen(server, candidate);
        servers.push(server);
      } catch {
        await close(server);
      }
      candidate += 1;
    }

    if (servers.length !== count) {
      throw new Error(`reserved only ${servers.length}/${count} preferred logical ports`);
    }

    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map(close));
  }
}

function readFromPort(port) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.once("end", () => resolve(data));
      socket.once("error", reject);
    }),
    `timed out reading ${port}`,
  );
}

async function stressNativeRouter(count) {
  const routerPath = path.join(root, "media/native/portmanager_tcp_router");
  if (!fs.existsSync(routerPath)) {
    throw new Error(`Missing native router helper: ${routerPath}`);
  }

  const logicalPorts = await reservePreferredPorts(count);
  console.log(`reserved logical ports: ${logicalPorts[0]}-${logicalPorts.at(-1)}`);

  const targetServer = net.createServer((socket) => {
    socket.end("ok");
  });
  await listen(targetServer, 0);
  const targetPort = targetServer.address().port;

  const child = spawn(routerPath, ["--control"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let controlReady;
  const controlReadyPromise = new Promise((resolve, reject) => {
    controlReady = { resolve, reject };
  });
  const readyWaiters = new Map();

  function waitForReady(port) {
    return withTimeout(
      new Promise((resolve, reject) => {
        readyWaiters.set(port, { resolve, reject });
      }),
      `timed out waiting for LISTEN ${port}`,
    );
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const lineEnd = stdoutBuffer.indexOf("\n");
      if (lineEnd < 0) {
        break;
      }

      const line = stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
      const parts = line.split("\t");

      if (line === "READY\tcontrol") {
        controlReady.resolve();
        continue;
      }

      if (parts[0] === "READY") {
        const port = Number(parts[1]);
        const waiter = readyWaiters.get(port);
        readyWaiters.delete(port);
        waiter?.resolve();
        continue;
      }

      if (parts[0] === "LISTEN_ERROR") {
        const port = Number(parts[1]);
        const waiter = readyWaiters.get(port);
        readyWaiters.delete(port);
        waiter?.reject(new Error(`LISTEN_ERROR ${port}`));
        continue;
      }

      if (parts[0] === "CONNECT") {
        const [, id] = parts;
        child.stdin.write(`ROUTE\t${id}\t127.0.0.1\t${targetPort}\n`);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
  });
  child.once("exit", (code, signal) => {
    const error = new Error(`router exited ${code ?? signal}: ${stderrBuffer.trim()}`);
    controlReady.reject(error);
    for (const waiter of readyWaiters.values()) {
      waiter.reject(error);
    }
    readyWaiters.clear();
  });

  try {
    await withTimeout(controlReadyPromise, "timed out waiting for control READY");

    const listenPromises = logicalPorts.map((port) => {
      const promise = waitForReady(port);
      child.stdin.write(`LISTEN\t${port}\n`);
      return promise;
    });
    await Promise.all(listenPromises);
    console.log(`native listen ok: ${count}`);

    for (let index = 0; index < logicalPorts.length; index += 1) {
      const result = await readFromPort(logicalPorts[index]);
      if (result !== "ok") {
        throw new Error(`unexpected route response for ${logicalPorts[index]}: ${result}`);
      }
      if ((index + 1) % 1000 === 0) {
        console.log(`native routed ok: ${index + 1}`);
      }
    }

    console.log(`native router stress ok: ${count} logical ports`);
  } finally {
    child.kill("SIGTERM");
    await close(targetServer);
  }
}

(async () => {
  console.log(`routing stress count: ${routeCount}, networks: ${networkCount}`);
  await stressRouteTableRefresh(routeCount);
  await stressNativeRouter(routeCount);
})();

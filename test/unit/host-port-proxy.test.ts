import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import test from "node:test";

import { HostPortProxyManager, parseNativeHostProxyQueryLine } from "../../src/platform/ports/host-port-proxy";
import type { HostPortExposure } from "../../src/shared/types";

test("forwards TCP bytes from a host exposure to the target listener", async () => {
  const target = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      socket.end(`target:${chunk.toString("utf8")}`);
    });
  });

  await listen(target, 0, "127.0.0.1");
  const targetPort = getServerPort(target);
  const hostPort = await getAvailablePort();
  const proxy = new HostPortProxyManager();
  const exposure = createExposure({ hostPort, targetPort });

  await proxy.open(exposure);

  const response = await sendTcpMessage(exposure.hostPort, "127.0.0.1", "hello");

  assert.equal(response, "target:hello");

  await proxy.dispose();
  await closeServer(target);
});

test("rejects a host exposure when the host port is already occupied", async () => {
  const occupied = net.createServer();
  await listen(occupied, 0, "127.0.0.1");
  const occupiedPort = getServerPort(occupied);
  const proxy = new HostPortProxyManager();

  await assert.rejects(
    () => proxy.open(createExposure({ hostPort: occupiedPort, targetPort: occupiedPort })),
    /EADDRINUSE/,
  );

  await proxy.dispose();
  await closeServer(occupied);
});

test("resolves host exposure targets when each inbound connection starts", async () => {
  const target = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      socket.end(`dynamic:${chunk.toString("utf8")}`);
    });
  });

  await listen(target, 0, "127.0.0.1");
  const targetPort = getServerPort(target);
  const hostPort = await getAvailablePort();
  const proxy = new HostPortProxyManager({
    resolve: (exposure) => ({
      host: exposure.targetAddress,
      port: targetPort,
    }),
  });
  const exposure = createExposure({ hostPort, targetPort: 3004 });

  await proxy.open(exposure);

  const response = await sendTcpMessage(exposure.hostPort, "127.0.0.1", "hello");

  assert.equal(response, "dynamic:hello");

  await proxy.dispose();
  await closeServer(target);
});

test("reuses host exposure target resolutions during short connection bursts", async () => {
  let resolveCalls = 0;
  const target = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      socket.end(`cached:${chunk.toString("utf8")}`);
    });
  });

  await listen(target, 0, "127.0.0.1");
  const originalDateNow = Date.now;
  let nowMs = 1_000;
  const targetPort = getServerPort(target);
  const hostPort = await getAvailablePort();
  const proxy = new HostPortProxyManager(
    {
      resolve: (exposure) => {
        resolveCalls += 1;
        return {
          host: exposure.targetAddress,
          port: targetPort,
        };
      },
    },
    {
      targetCacheTtlMs: 60,
    },
  );
  const exposure = createExposure({ hostPort, targetPort: 3004 });

  try {
    Date.now = () => nowMs;
    await proxy.open(exposure);

    assert.equal(await sendTcpMessage(exposure.hostPort, "127.0.0.1", "first"), "cached:first");
    assert.equal(await sendTcpMessage(exposure.hostPort, "127.0.0.1", "second"), "cached:second");
    assert.equal(resolveCalls, 1);

    nowMs += 61;

    assert.equal(await sendTcpMessage(exposure.hostPort, "127.0.0.1", "third"), "cached:third");
    assert.equal(resolveCalls, 2);
  } finally {
    Date.now = originalDateNow;
    await proxy.dispose();
    await closeServer(target);
  }
});

test("parses native host exposure connection query lines", () => {
  assert.deepEqual(parseNativeHostProxyQueryLine("CONNECT\t7\t127.0.0.1\t3000\t127.0.0.1\t49152"), {
    id: "7",
    localAddress: "127.0.0.1",
    localPort: 3000,
    remoteAddress: "127.0.0.1",
    remotePort: 49152,
  });
  assert.equal(parseNativeHostProxyQueryLine("READY\t127.0.0.1\t3000"), undefined);
  assert.deepEqual(parseNativeHostProxyQueryLine("CONNECT\t8\t127.0.0.1\tbad\t127.0.0.1\talso-bad"), {
    id: "8",
    localAddress: "127.0.0.1",
    remoteAddress: "127.0.0.1",
  });
});

test("native host exposure pending route requests time out instead of blocking forever", () => {
  const root = path.resolve(__dirname, "../../..");
  const hostProxySource = fs.readFileSync(
    path.join(root, "native/host-exposure/portmanager_host_exposure_proxy.c"),
    "utf8",
  );

  assert.equal(hostProxySource.includes("PM_HOST_PROXY_ROUTE_RESPONSE_TIMEOUT_MS 5000"), true);
  assert.equal(hostProxySource.includes("clock_gettime(CLOCK_REALTIME, &deadline)"), true);
  assert.equal(hostProxySource.includes("pthread_cond_timedwait(&route.condition, &pm_pending_mutex, &deadline)"), true);
  assert.equal(hostProxySource.includes("if (!route.resolved || route.failed"), true);
});

test(
  "forwards TCP bytes through the native host exposure helper when available",
  { skip: !isExecutableFile(getNativeHostExposureProxyPath()) },
  async () => {
    const target = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        socket.end(`native:${chunk.toString("utf8")}`);
      });
    });

    await listen(target, 0, "127.0.0.1");
    const targetPort = getServerPort(target);
    const hostPort = await getAvailablePort();
    const proxy = new HostPortProxyManager(
      {
        resolve: (exposure) => ({
          host: exposure.targetAddress,
          port: targetPort,
        }),
      },
      {
        nativeProxyPath: getNativeHostExposureProxyPath(),
      },
    );
    const exposure = createExposure({ hostPort, targetPort: 3004 });

    await proxy.open(exposure);

    const response = await sendTcpMessage(exposure.hostPort, "127.0.0.1", "hello");

    assert.equal(response, "native:hello");

    await proxy.dispose();
    await closeServer(target);
  },
);

function createExposure(overrides: Partial<HostPortExposure> = {}): HostPortExposure {
  return {
    id: `exposure-${Math.random()}`,
    networkId: "network-1",
    hostAddress: "127.0.0.1",
    hostPort: 0,
    targetAddress: "127.0.0.1",
    targetPort: 0,
    protocol: "tcp",
    status: "active",
    createdAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

function listen(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function getServerPort(server: net.Server): number {
  const address = server.address();

  if (typeof address !== "object" || address === null) {
    throw new Error("Server did not expose an address.");
  }

  return address.port;
}

function sendTcpMessage(port: number, host: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = "";

    socket.once("connect", () => {
      socket.write(message);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

async function getAvailablePort(): Promise<number> {
  const server = net.createServer();
  await listen(server, 0, "127.0.0.1");
  const port = getServerPort(server);
  await closeServer(server);

  return port;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getNativeHostExposureProxyPath(): string {
  return path.join(process.cwd(), "media", "native", "portmanager_host_exposure_proxy");
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

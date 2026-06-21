import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";

import { HostPortProxyManager } from "../../src/platform/ports/host-port-proxy";
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

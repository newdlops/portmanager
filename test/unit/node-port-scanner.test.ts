import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import test from "node:test";
import { NodePortScanner } from "../../src/platform/ports/node-port-scanner";

/**
 * Unit coverage for the Node port scanner uses a real local TCP listener.
 * That keeps the assertion focused on the bind-based mechanism without relying
 * on platform owner commands being present in the test environment.
 */
test("NodePortScanner reports a busy port when another server is listening", async () => {
  const server = createServer();

  await listenOnLoopback(server);

  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");

    // The OS-assigned port is held open for the duration of the scanner check.
    const busyPort = address.port;
    const scanner = new NodePortScanner();

    const result = await scanner.check(busyPort, "127.0.0.1");

    assert.equal(result.port, busyPort);
    assert.equal(result.available, false);
  } finally {
    await closeServer(server);
  }
});

/**
 * Starts a listener on the loopback interface so the test does not expose a
 * network service outside the local machine.
 */
async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Closes the temporary listener and converts callback errors into rejections. */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

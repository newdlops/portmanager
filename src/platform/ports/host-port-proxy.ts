import * as net from "node:net";
import type { HostPortExposure } from "../../shared/types";

/**
 * Owns local host listeners used by proxy-capable runtime adapters.
 *
 * This class is intentionally low-level: it binds sockets and forwards TCP
 * bytes, but it does not decide which exposures should exist. Domain and
 * extension layers validate user intent before calling it.
 */
export class HostPortProxyManager {
  /** Active TCP servers keyed by host exposure id. */
  private readonly servers = new Map<string, net.Server>();

  /** Active inbound sockets keyed by host exposure id for prompt teardown. */
  private readonly sockets = new Map<string, Set<net.Socket>>();

  /**
   * Opens a host listener and forwards each connection to the exposure target.
   * Successful resolution means the host port is reserved by Port Manager.
   */
  async open(exposure: HostPortExposure): Promise<void> {
    if (exposure.protocol !== "tcp") {
      throw new Error(`Host proxy only supports tcp exposures, got ${exposure.protocol}.`);
    }

    if (this.servers.has(exposure.id)) {
      return;
    }

    const sockets = new Set<net.Socket>();
    const server = net.createServer((incoming) => {
      sockets.add(incoming);
      incoming.once("close", () => sockets.delete(incoming));

      const outgoing = net.createConnection({
        host: exposure.targetAddress,
        port: exposure.targetPort,
      });

      incoming.on("error", () => outgoing.destroy());
      outgoing.on("error", () => incoming.destroy());
      incoming.pipe(outgoing);
      outgoing.pipe(incoming);
    });

    await listen(server, exposure.hostPort, exposure.hostAddress);
    this.servers.set(exposure.id, server);
    this.sockets.set(exposure.id, sockets);
  }

  /** Closes one active host listener. */
  async close(exposureId: string): Promise<void> {
    const server = this.servers.get(exposureId);
    if (server === undefined) {
      return;
    }

    this.servers.delete(exposureId);
    for (const socket of this.sockets.get(exposureId) ?? []) {
      socket.destroy();
    }
    this.sockets.delete(exposureId);
    await closeServer(server);
  }

  /** Closes every listener during extension shutdown. */
  async dispose(): Promise<void> {
    const servers = [...this.servers.entries()];
    this.servers.clear();
    for (const sockets of this.sockets.values()) {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
    this.sockets.clear();

    await Promise.all(servers.map(([, server]) => closeServer(server)));
  }
}

/** Converts Node's callback-based listen path into a precise promise. */
function listen(server: net.Server, port: number, host: string): Promise<void> {
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
    server.listen(port, host);
  });
}

/** Closes a server and treats already-closed handles as success. */
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

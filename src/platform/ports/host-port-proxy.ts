import * as net from "node:net";
import type { HostPortExposure } from "../../shared/types";

export interface HostPortProxyTarget {
  /** Address the local proxy should connect to after resolving network scope. */
  readonly host: string;
  /** Actual TCP port the target process is listening on. */
  readonly port: number;
}

export interface HostPortProxyTargetResolver {
  /**
   * Resolves a persisted host binding to its current connection target.
   * Runtime adapters can map a network-local logical port to a live actual port
   * without leaking that policy into this socket-forwarding class.
   */
  resolve(exposure: HostPortExposure): HostPortProxyTarget | Promise<HostPortProxyTarget>;
}

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

  constructor(private readonly targetResolver: HostPortProxyTargetResolver = STATIC_TARGET_RESOLVER) {}

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

      void this.forwardConnection(exposure, incoming, sockets);
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

  /** Resolves the current target and wires one inbound socket to it. */
  private async forwardConnection(
    exposure: HostPortExposure,
    incoming: net.Socket,
    sockets: Set<net.Socket>,
  ): Promise<void> {
    let target: HostPortProxyTarget;

    try {
      target = await this.targetResolver.resolve(exposure);
    } catch {
      incoming.destroy();
      return;
    }

    if (incoming.destroyed) {
      return;
    }

    const outgoing = net.createConnection({
      host: target.host,
      port: target.port,
    });
    sockets.add(outgoing);
    outgoing.once("close", () => sockets.delete(outgoing));
    incoming.once("close", () => outgoing.destroy());

    incoming.on("error", () => outgoing.destroy());
    outgoing.on("error", () => incoming.destroy());
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  }
}

const STATIC_TARGET_RESOLVER: HostPortProxyTargetResolver = {
  resolve: (exposure) => ({
    host: exposure.targetAddress,
    port: exposure.targetPort,
  }),
};

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

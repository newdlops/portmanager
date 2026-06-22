import * as net from "node:net";
import type { DisposableLike } from "../../shared/types";

export interface LogicalPortRouterConnection {
  /** Logical TCP port the local client connected to. */
  readonly logicalPort: number;
  /** Address that accepted the client connection. */
  readonly localAddress?: string;
  /** Accepted listener port, normally the same as logicalPort. */
  readonly localPort?: number;
  /** Client-side address reported by the OS socket. */
  readonly remoteAddress?: string;
  /** Client-side ephemeral TCP port used to identify the caller process. */
  readonly remotePort?: number;
}

export interface LogicalPortRouterTarget {
  /** Concrete host the router should forward to. */
  readonly host: string;
  /** Concrete actual TCP port selected for the caller's logical network. */
  readonly port: number;
}

export interface LogicalPortRouterTargetResolver {
  /**
   * Resolves one accepted localhost connection to the current actual target.
   * The caller can inspect client PID, terminal attachment, and route state
   * without leaking those higher-level policies into this TCP adapter.
   */
  resolve(connection: LogicalPortRouterConnection): LogicalPortRouterTarget | Promise<LogicalPortRouterTarget>;
}

/**
 * Opens real localhost listeners for logical ports and forwards per connection.
 *
 * Native bind hooks keep application servers off their requested logical ports.
 * This router occupies those logical ports instead, then chooses the actual
 * target from the client process' terminal/network context.
 */
export class LogicalPortRouterManager implements DisposableLike {
  /** Active listener sockets keyed by logical port. */
  private readonly servers = new Map<number, net.Server>();

  /** In-flight client and target sockets, grouped for prompt teardown. */
  private readonly sockets = new Map<number, Set<net.Socket>>();

  constructor(private readonly targetResolver: LogicalPortRouterTargetResolver) {}

  /** Reconciles active localhost routers with the latest logical route table. */
  async sync(logicalPorts: Iterable<number>): Promise<void> {
    const desiredPorts = new Set([...logicalPorts].filter(isTcpPort));

    for (const port of [...this.servers.keys()]) {
      if (!desiredPorts.has(port)) {
        await this.close(port);
      }
    }

    for (const port of desiredPorts) {
      await this.open(port);
    }
  }

  /** Opens one logical localhost listener if it is not already active. */
  async open(logicalPort: number): Promise<void> {
    if (this.servers.has(logicalPort)) {
      return;
    }

    const sockets = new Set<net.Socket>();
    const server = net.createServer((incoming) => {
      sockets.add(incoming);
      incoming.once("close", () => sockets.delete(incoming));
      void this.forwardConnection(logicalPort, incoming, sockets);
    });

    await listen(server, logicalPort, "127.0.0.1");
    this.servers.set(logicalPort, server);
    this.sockets.set(logicalPort, sockets);
  }

  /** Closes one logical localhost listener. */
  async close(logicalPort: number): Promise<void> {
    const server = this.servers.get(logicalPort);
    if (server === undefined) {
      return;
    }

    this.servers.delete(logicalPort);
    for (const socket of this.sockets.get(logicalPort) ?? []) {
      socket.destroy();
    }
    this.sockets.delete(logicalPort);
    await closeServer(server);
  }

  /** Closes every listener owned by this router. */
  dispose(): void {
    const ports = [...this.servers.keys()];
    void Promise.all(ports.map((port) => this.close(port)));
  }

  /** Resolves and pipes one accepted connection to its actual target. */
  private async forwardConnection(
    logicalPort: number,
    incoming: net.Socket,
    sockets: Set<net.Socket>,
  ): Promise<void> {
    let target: LogicalPortRouterTarget;

    try {
      target = await this.targetResolver.resolve({
        logicalPort,
        localAddress: incoming.localAddress,
        localPort: incoming.localPort,
        remoteAddress: incoming.remoteAddress,
        remotePort: incoming.remotePort,
      });
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

function isTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

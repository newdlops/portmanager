import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { NetworkShellLaunch } from "./macos-network-runtime";
import { ensurePrivateDirectory, writePrivateAtomic, readPrivateBytes } from "./macos-network-runtime";
import type { ProxyNetworkResources } from "../ports/proxy-network-resources";
import type { ProxyResourceLease } from "../../core/networks/proxy-resource-budget";

export interface NetworkTerminalControlDescriptor { readonly socketPath: string; readonly tokenFilePath: string }
export interface NetworkTerminalControlOwner {
  prepare(networkId: string, cwd: string): Promise<NetworkShellLaunch>;
  observe(launch: NetworkShellLaunch): Promise<void>;
  close(id: string): Promise<void>;
}
interface ClientOwner {
  socket: net.Socket; launch?: NetworkShellLaunch; preparing: boolean;
  /** Latest requested UI action, including preparation that may still fail. */
  generation: number;
  /** Advances only when an action actually starts retiring the current shell. */
  readinessGeneration: number;
}

/**
 * A private host-side launch seam keeps lazily sourced external commands under
 * the extension host's existing budget. Kernel-restricted workloads cannot
 * read this key or connect this endpoint. Requests contain network/cwd only;
 * PID, program, profile and agent credentials are selected by the controller.
 * The channel is never inherited by the native launcher or guarded child.
 */
export class NetworkTerminalControl {
  private server: net.Server | undefined;
  private descriptor: NetworkTerminalControlDescriptor | undefined;
  private readonly token = randomBytes(32).toString("hex");
  private readonly clients = new Set<ClientOwner>();
  private starting: Promise<NetworkTerminalControlDescriptor> | undefined;
  private disposed = false;
  private listenerLease: ProxyResourceLease | undefined;

  constructor(private readonly directory: string, private readonly owner: NetworkTerminalControlOwner,
    private readonly resources?: ProxyNetworkResources) {}

  start(): Promise<NetworkTerminalControlDescriptor> {
    if (this.disposed) return Promise.reject(new Error("Terminal control is disposed."));
    if (this.descriptor !== undefined) return Promise.resolve(this.descriptor);
    if (this.starting !== undefined) return this.starting;
    this.starting = this.startOnce().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Only the trusted UI invokes replacement; a workload has no switch RPC. */
  async replace(id: string, networkId: string, cwd: string): Promise<boolean> {
    const client = [...this.clients].find(row => row.launch?.id === id);
    if (client === undefined) return false;
    const generation = ++client.generation;
    const launch = await this.owner.prepare(networkId, cwd);
    let readinessGeneration: number | undefined;
    try {
      if (this.disposed || client.socket.destroyed || client.generation !== generation) throw new Error("Terminal switch was canceled.");
      readinessGeneration = ++client.readinessGeneration;
      this.send(client, { type: "changing" });
      await this.owner.close(id);
      // Closing an old supervisor can outlive a newer switch, detach or socket
      // cancellation. Only the latest UI action may install the next owner.
      if (this.disposed || client.socket.destroyed || client.generation !== generation) throw new Error("Terminal switch was canceled.");
      client.launch = launch;
      this.send(client, { type: "launch", launch });
      await this.owner.observe(launch);
      return true;
    } catch (error) {
      await this.owner.close(launch.id);
      if (!this.disposed && !client.socket.destroyed && (readinessGeneration === undefined
        ? client.generation === generation : client.readinessGeneration === readinessGeneration)) {
        this.send(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
        client.socket.end();
      }
      throw error;
    }
  }

  async detach(id: string): Promise<boolean> {
    const client = [...this.clients].find(row => row.launch?.id === id);
    if (client === undefined) return false;
    const generation = ++client.generation;
    client.readinessGeneration++;
    this.send(client, { type: "changing" });
    await this.owner.close(id);
    if (this.disposed || client.socket.destroyed || client.generation !== generation) return false;
    client.launch = undefined;
    this.send(client, { type: "detach" });
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.starting?.catch(() => undefined);
    await Promise.allSettled([...this.clients].map(async client => {
      client.generation++;
      client.readinessGeneration++;
      // destroy() initiates close; the budget lease belongs to the socket until
      // its actual close event, which can follow the server's close callback.
      const closed = new Promise<void>(resolve => client.socket.once("close", () => resolve()));
      client.socket.destroy();
      await Promise.all([closed, client.launch === undefined ? undefined : this.owner.close(client.launch.id)]);
    }));
    if (this.server !== undefined) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.descriptor !== undefined) {
      fs.rmSync(this.descriptor.socketPath, { force: true });
      fs.rmSync(this.descriptor.tokenFilePath, { force: true });
    }
  }

  private async startOnce(): Promise<NetworkTerminalControlDescriptor> {
    ensurePrivateDirectory(this.directory);
    const name = randomUUID().slice(0, 12);
    const descriptor = { socketPath: path.join(this.directory, name + ".sock"), tokenFilePath: path.join(this.directory, name + ".key") };
    if (Buffer.byteLength(descriptor.socketPath) >= 104) throw new Error("Terminal controller socket path exceeds the macOS limit.");
    writePrivateAtomic(descriptor.tokenFilePath, this.token);
    const server = net.createServer(socket => this.accept(socket));
    this.listenerLease = this.resources?.budget.acquire({ listeners: 1 });
    server.once("close", () => { this.listenerLease?.release(); this.listenerLease = undefined; });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(descriptor.socketPath, resolve); });
      fs.chmodSync(descriptor.socketPath, 0o600);
      this.descriptor = descriptor;
      return descriptor;
    } catch (error) { this.listenerLease?.release(); this.listenerLease = undefined;
      fs.rmSync(descriptor.tokenFilePath, { force: true }); throw error; }
  }

  private accept(socket: net.Socket): void {
    if (this.disposed || this.clients.size >= 32) { socket.destroy(); return; }
    const lease = this.resources?.budget.tryAcquire({ connections: 1, controlBytes: (8 + 128) * 1024 });
    if (this.resources !== undefined && lease === undefined) { socket.destroy(); return; }
    const client: ClientOwner = { socket, preparing: false, generation: 0, readinessGeneration: 0 };
    this.clients.add(client);
    const deadline = performance.now() + 10_000;
    let buffer = Buffer.alloc(0), requested = false;
    const timer = setTimeout(() => { if (!requested) socket.destroy(); }, 10_000);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      client.generation++;
      client.readinessGeneration++;
      this.clients.delete(client);
      lease?.release();
      if (client.launch !== undefined) void this.owner.close(client.launch.id).catch(() => {});
    });
    socket.on("data", bytes => {
      if (requested || buffer.length + bytes.length > 8192 || performance.now() >= deadline) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, bytes]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      if (end !== buffer.length - 1) { socket.destroy(); return; }
      requested = true;
      clearTimeout(timer);
      try {
        const request = JSON.parse(buffer.subarray(0, end).toString("utf8")) as { token?: unknown; networkId?: unknown; cwd?: unknown };
        if (typeof request.token !== "string" || typeof request.networkId !== "string" || typeof request.cwd !== "string" ||
            !path.isAbsolute(request.cwd) || Object.keys(request).some(key => !["token", "networkId", "cwd"].includes(key))) throw new Error("Invalid terminal request.");
        const supplied = Buffer.from(request.token), expected = Buffer.from(this.token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Unauthorized terminal launch.");
        client.preparing = true;
        const readinessGeneration = client.readinessGeneration;
        void this.prepare(client, request.networkId, request.cwd).catch(error => {
          // Replacing/detaching deliberately cancels the previous readiness
          // check; its late rejection must not close the replacement channel.
          if (this.disposed || socket.destroyed || client.readinessGeneration !== readinessGeneration) return;
          this.send(client, { type: "error", message: error instanceof Error ? error.message : String(error) }); socket.end();
        });
      } catch { socket.destroy(); }
    });
  }

  private async prepare(client: ClientOwner, networkId: string, cwd: string): Promise<void> {
    const generation = client.generation;
    const launch = await this.owner.prepare(networkId, cwd);
    if (client.socket.destroyed || this.disposed || client.generation !== generation) { await this.owner.close(launch.id); return; }
    client.launch = launch;
    client.preparing = false;
    this.send(client, { type: "launch", launch });
    await this.owner.observe(launch);
  }

  private send(client: ClientOwner, value: unknown): void {
    // Inherited extension-host env can contain credentials. Only bootstrap
    // coordinates cross this private channel; the host client keeps its env.
    const message = value as { type?: string; launch?: NetworkShellLaunch };
    if (message.launch !== undefined) value = { ...message, launch: { ...message.launch,
      env: { SHELL: message.launch.env.SHELL, ZDOTDIR: message.launch.env.ZDOTDIR } } };
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > 64 * 1024 || client.socket.writableLength + Buffer.byteLength(text) > 128 * 1024) {
      client.socket.destroy(); return;
    }
    client.socket.write(text);
  }
}

/** Client reads a private file; the key never appears in argv or workload env. */
export function readTerminalControlToken(filePath: string): string {
  return readPrivateBytes(filePath, 128).toString("utf8");
}

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthenticatedProcessScope } from "../../agent/protocol";
import { networkStorageKey } from "../../core/networks/network-identity";
import type { ProxyResourceLease } from "../../core/networks/proxy-resource-budget";
import type { ProxyNetworkResources } from "../ports/proxy-network-resources";
import { devLog } from "../dev-log";
import { buildMacosNetworkSandboxProfile } from "./macos-network-sandbox";
import { ensureNetworkNamespaceScaffold, networkNamespacePaths } from "./network-file-scaffold";
import { buildNodeRuntimeEnvironment } from "./node-runtime";
import { readNativeBinaryArchitectures } from "./native-executable";

/** The controller supplies policy; neither shell env nor a broker frame owns it. */
export interface NetworkRuntimeRoute {
  readonly port: number;
  readonly targetHost: string;
  readonly targetPort: number;
}

export interface NetworkRuntimeScope {
  readonly id: string;
  readonly name: string;
  readonly loopbackHost: string;
  readonly workspaceDirectories: readonly string[];
  readonly routes: readonly NetworkRuntimeRoute[];
  /** Shell/SIP shims are prepared by the controller; fixed scope exports win. */
  readonly bootstrapEnvironment?: Readonly<Record<string, string>>;
}

export interface MacosNetworkRuntimeOptions {
  readonly artifactDirectory: string;
  readonly stateDirectory?: string;
  readonly resources: ProxyNetworkResources;
  readonly agentSocketPath: string;
  readonly controllerTokenFilePath: string;
  readonly ensureController: () => Promise<void>;
  readonly resolveScope: (identity: { pid: number; birth: number }) => Promise<AuthenticatedProcessScope | null>;
  readonly readIdentity: (pid: number) => Promise<{ pid: number; birth: number } | undefined>;
}

/** A real terminal/PTY owner launches this command and then supplies its PID. */
export interface NetworkShellLaunch {
  readonly id: string;
  readonly networkId: string;
  readonly shellPath: string;
  readonly shellArgs: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

interface BrokerOwner {
  readonly scope: NetworkRuntimeScope;
  readonly process: ChildProcess;
  readonly lease: ProxyResourceLease;
  readonly endpoint: string;
  readonly routesPath: string;
  readonly sessions: Set<string>;
  exited: boolean;
}

interface ShellOwner {
  readonly launch: NetworkShellLaunch;
  readonly broker: BrokerOwner;
  readonly lease: ProxyResourceLease;
  readonly readyPath: string;
  readonly readyDirectory: string;
  readonly bootstrapDirectory: string;
  readonly preparedAt: number;
  supervisor?: { pid: number; birth: number };
  identity?: AuthenticatedProcessScope;
  closing?: Promise<void>;
}

const STARTUP_MS = 10_000;
const STOP_MS = 2_000;
const BROKER_SLOTS = 64;
const BROKER_SCOPE_BYTES = BROKER_SLOTS * (2048 + 2048 + 160 + 148);
const MAX_ROUTE_ROWS = 512;
const MAX_ROUTE_BYTES = 64 * 1024;

/**
 * Owns the trusted native parents of kernel-restricted shells. Prepared shells
 * keep reservations until their actual supervisor exits; an EOF/readiness file
 * is never enough to free a live process. Each new shell receives a fresh policy
 * and nonce, so a switch cannot relax the previous shell's inherited sandbox.
 * VS Code and external-terminal adapters own terminal rendering and PTY input.
 */
export class MacosNetworkRuntime {
  private readonly stateDirectory: string;
  private readonly brokers = new Map<string, BrokerOwner>();
  private readonly starting = new Map<string, Promise<BrokerOwner>>();
  private readonly shells = new Map<string, ShellOwner>();
  private generation = 0;
  private disposed = false;
  private artifactPaths: { broker: string; launcher: string; hook: string } | undefined;

  constructor(private readonly options: MacosNetworkRuntimeOptions) {
    this.stateDirectory = options.stateDirectory ?? path.join(os.homedir(), ".portmanager");
    if (!path.isAbsolute(this.stateDirectory) || path.basename(this.stateDirectory) !== ".portmanager") {
      throw new Error("Guarded runtime state must use a canonical .portmanager directory.");
    }
  }

  /** Reserve before terminal creation; a failed caller must cancel this handle. */
  async prepareShell(scope: NetworkRuntimeScope, cwd: string, shell = process.env.SHELL ?? "/bin/zsh"): Promise<NetworkShellLaunch> {
    this.assertAvailable();
    const generation = this.generation;
    if (!path.isAbsolute(cwd) || !path.isAbsolute(shell) || !["zsh", "bash", "sh"].includes(path.basename(shell))) {
      throw new Error("Guarded terminals require an absolute supported shell and workspace.");
    }
    const canonicalCwd = fs.realpathSync(cwd);
    const broker = await this.ensureBroker(scope);
    if (this.disposed || generation !== this.generation || broker.exited) throw new Error("Network shell preparation was canceled.");
    let lease: ProxyResourceLease | undefined;
    const id = randomUUID();
    const readyDirectory = path.join(this.stateDirectory, "security", "sessions", id);
    try {
      lease = this.options.resources.budget.acquire({ nativeHelpers: 1, nativeScopeJobs: 1, controlBytes: 4096 });
      ensurePrivateDirectory(readyDirectory);
      const readyPath = path.join(readyDirectory, "ready.json");
      const profilePath = path.join(this.stateDirectory, "security", "profiles", id + ".sb");
      ensurePrivateDirectory(path.dirname(profilePath));
      const workspaces = [...new Set(scope.workspaceDirectories.map(directory => fs.realpathSync(directory)))];
      if (!workspaces.includes(canonicalCwd) && !workspaces.some(directory => canonicalCwd.startsWith(directory + path.sep))) {
        throw new Error("Terminal cwd must belong to its explicitly shared workspace.");
      }
      for (const directory of workspaces) ensureNetworkNamespaceScaffold(directory, scope.id, scope.name);
      const namespaceDirectories = workspaces.map(directory => networkNamespacePaths(directory, scope.id).directory);
      writePrivateAtomic(profilePath, buildMacosNetworkSandboxProfile({ networkId: scope.id, namespaceDirectories,
        sharedWorkspaceDirectories: workspaces, agentSocketPath: broker.endpoint }));
      const bootstrap = this.prepareBootstrap(scope, workspaces, shell, id);
      const artifacts = this.prepareArtifacts();
      const env = buildNodeRuntimeEnvironment();
      delete env.ELECTRON_RUN_AS_NODE;
      env.SHELL = shell;
      env.ZDOTDIR = bootstrap.directory;
      const args = ["--profile", profilePath, "--broker", broker.endpoint, "--hook", artifacts.hook,
        "--network-id", scope.id, "--agent-socket", this.options.agentSocketPath,
        "--controller-token-file", this.options.controllerTokenFilePath, "--ready-file", readyPath,
        "--", ...(path.basename(shell) === "sh"
          ? ["/bin/sh", "-c", `. ${shellQuote(bootstrap.common)}; export ENV=${shellQuote(bootstrap.common)}; exec ${shellQuote(shell)} -i`]
          : [shell, ...(path.basename(shell) === "bash" ? ["--noprofile", "--rcfile", bootstrap.bashrc, "-i"] : ["-i"])])];
      const launch: NetworkShellLaunch = { id, networkId: scope.id, shellPath: artifacts.launcher, shellArgs: args, env, cwd: canonicalCwd };
      const owner: ShellOwner = { launch, broker, lease, readyPath, readyDirectory,
        bootstrapDirectory: bootstrap.directory, preparedAt: performance.now() };
      this.shells.set(id, owner);
      broker.sessions.add(id);
      return launch;
    } catch (error) {
      lease?.release();
      fs.rmSync(readyDirectory, { recursive: true, force: true });
      fs.rmSync(path.join(this.stateDirectory, "security", "profiles", id + ".sb"), { force: true });
      fs.rmSync(path.join(this.stateDirectory, "runtime", "shells", id), { recursive: true, force: true });
      if (broker.sessions.size === 0) await this.closeBroker(broker);
      throw error;
    }
  }

  /** The PTY host's PID is stronger than any PID printed by the workload. */
  async adoptSupervisor(id: string, pid: number): Promise<void> {
    const owner = this.requireShell(id);
    const identity = await this.options.readIdentity(pid);
    if (identity === undefined || identity.pid !== pid) throw new Error("Terminal supervisor has no current OS identity.");
    if (owner.supervisor !== undefined && (owner.supervisor.pid !== pid || owner.supervisor.birth !== identity.birth)) {
      throw new Error("A prepared terminal cannot change its supervisor identity.");
    }
    owner.supervisor = identity;
  }

  /** Confirm private parent readiness, current birth and controller scope together. */
  async waitReady(id: string): Promise<AuthenticatedProcessScope> {
    const owner = this.requireShell(id);
    const deadline = owner.preparedAt + STARTUP_MS;
    try {
      while (performance.now() < deadline) {
        if (owner.closing !== undefined || owner.broker.exited || this.disposed) throw new Error("Terminal startup was canceled.");
        const document = readPrivateJson(owner.readyPath, 2048);
        if (document !== undefined) {
          const ready = document as Partial<AuthenticatedProcessScope> & { supervisorPid?: number; supervisorBirth?: number };
          if (!Number.isSafeInteger(ready.pid) || !Number.isSafeInteger(ready.birth) || ready.networkId !== owner.launch.networkId ||
              !Number.isSafeInteger(ready.supervisorPid) || !Number.isSafeInteger(ready.supervisorBirth)) {
            throw new Error("Terminal readiness has an invalid identity tuple.");
          }
          if (owner.supervisor === undefined) await this.adoptSupervisor(id, ready.supervisorPid!);
          if (owner.supervisor!.pid !== ready.supervisorPid || owner.supervisor!.birth !== ready.supervisorBirth) {
            throw new Error("Terminal readiness does not belong to its trusted supervisor.");
          }
          const current = await this.options.readIdentity(ready.pid!);
          const scope = current !== undefined && current.birth === ready.birth ? await this.options.resolveScope(current) : null;
          if (scope === null || scope.pid !== ready.pid || scope.birth !== ready.birth || scope.networkId !== ready.networkId) {
            throw new Error("Terminal readiness is not authenticated by the current daemon.");
          }
          owner.identity = scope;
          return scope;
        }
        if (owner.supervisor !== undefined && !(await this.isCurrent(owner.supervisor))) throw new Error("Terminal supervisor exited before readiness.");
        await delay(20);
      }
      throw new Error("Guarded terminal startup exceeded its original deadline.");
    } catch (error) {
      await this.closeShell(id);
      throw error;
    }
  }

  /** Update only controller policy; child input never selects the route file. */
  updateRoutes(networkId: string, routes: readonly NetworkRuntimeRoute[]): void {
    const broker = this.brokers.get(networkId);
    if (broker !== undefined && !broker.exited) writePrivateAtomic(broker.routesPath, serializeRoutes(networkId, routes));
  }

  /** Switch adapters close the previous owner before launching a fresh shell. */
  async closeShell(id: string): Promise<void> {
    const owner = this.shells.get(id);
    if (owner === undefined) return;
    if (owner.closing !== undefined) return owner.closing;
    owner.closing = this.closeShellOwner(owner).catch(error => { owner.closing = undefined; throw error; });
    return owner.closing;
  }

  get activeShells(): readonly NetworkShellLaunch[] { return [...this.shells.values()].map(owner => owner.launch); }

  /** Disposal fences pending startup before waiting for actual child exit. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    await Promise.allSettled([...this.shells.keys()].map(id => this.closeShell(id)));
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.brokers.values()].map(broker => this.closeBroker(broker)));
  }

  private async ensureBroker(scope: NetworkRuntimeScope): Promise<BrokerOwner> {
    const current = this.brokers.get(scope.id);
    if (current !== undefined && !current.exited) { this.updateRoutes(scope.id, scope.routes); return current; }
    const pending = this.starting.get(scope.id);
    if (pending !== undefined) return pending;
    const generation = this.generation;
    const start = this.startBroker(scope, generation).finally(() => this.starting.delete(scope.id));
    this.starting.set(scope.id, start);
    return start;
  }

  private async startBroker(scope: NetworkRuntimeScope, generation: number): Promise<BrokerOwner> {
    if (Buffer.byteLength(scope.id) >= 128 || networkStorageKey(scope.id).length === 0) throw new Error("Invalid broker network identity.");
    await this.options.ensureController();
    this.assertAvailable();
    const artifacts = this.prepareArtifacts();
    const socketDirectory = path.join(this.stateDirectory, "security", "sockets");
    const routesDirectory = path.join(this.stateDirectory, "security", "broker-routes");
    ensurePrivateDirectory(socketDirectory);
    ensurePrivateDirectory(routesDirectory);
    const token = createHash("sha256").update(scope.id + randomUUID()).digest("hex").slice(0, 16);
    const endpoint = path.join(socketDirectory, token + ".sock");
    if (Buffer.byteLength(endpoint) >= 104) throw new Error("Protected broker socket path exceeds the macOS limit.");
    const routesPath = path.join(routesDirectory, token + ".json");
    writePrivateAtomic(routesPath, serializeRoutes(scope.id, scope.routes));
    const lease = this.options.resources.budget.acquire({ nativeHelpers: 1, listeners: 1, connections: BROKER_SLOTS,
      upstreams: BROKER_SLOTS * 2, nativeScopeJobs: BROKER_SLOTS, controlBytes: BROKER_SCOPE_BYTES });
    const child = spawn(artifacts.broker, ["--socket", endpoint, "--network-id", scope.id, "--loopback-host", scope.loopbackHost,
      "--agent-socket", this.options.agentSocketPath, "--controller-token-file", this.options.controllerTokenFilePath,
      "--routes", routesPath], { env: buildNodeRuntimeEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const owner: BrokerOwner = { scope, process: child, endpoint, routesPath, lease, sessions: new Set(), exited: false };
    this.brokers.set(scope.id, owner);
    let spawned = false;
    child.once("spawn", () => { spawned = true; });
    const release = () => {
      if (owner.exited) return;
      owner.exited = true;
      lease.release();
      if (this.brokers.get(scope.id) === owner) this.brokers.delete(scope.id);
      for (const id of owner.sessions) void this.closeShell(id).catch(error => devLog("network-runtime", `broker exit cleanup failed: ${String(error)}`));
    };
    child.once("exit", release);
    child.once("error", () => { if (!spawned) release(); });
    child.stderr?.on("data", () => {});
    try {
      await readBrokerReady(child);
      if (this.disposed || this.generation !== generation || owner.exited) throw new Error("Broker startup was canceled.");
      return owner;
    } catch (error) {
      await this.closeBroker(owner);
      throw error;
    }
  }

  private async closeShellOwner(owner: ShellOwner): Promise<void> {
    if (owner.supervisor !== undefined) {
      await this.stopIdentity(owner.supervisor);
    } else {
      // A PTY adapter must adopt its PID even if readiness fails. A handle
      // canceled before terminal creation has no native process to reclaim.
      const ready = readPrivateJson(owner.readyPath, 2048) as { supervisorPid?: number } | undefined;
      if (ready?.supervisorPid !== undefined) {
        const identity = await this.options.readIdentity(ready.supervisorPid);
        if (identity !== undefined) await this.stopIdentity(identity);
      }
    }
    owner.lease.release();
    owner.broker.sessions.delete(owner.launch.id);
    this.shells.delete(owner.launch.id);
    fs.rmSync(owner.readyDirectory, { recursive: true, force: true });
    fs.rmSync(owner.bootstrapDirectory, { recursive: true, force: true });
    fs.rmSync(path.join(this.stateDirectory, "security", "profiles", owner.launch.id + ".sb"), { force: true });
    if (owner.broker.sessions.size === 0) await this.closeBroker(owner.broker);
  }

  private async closeBroker(owner: BrokerOwner): Promise<void> {
    if (!owner.exited) {
      owner.process.kill("SIGTERM");
      const deadline = performance.now() + STOP_MS;
      while (!owner.exited && performance.now() < deadline) await delay(20);
      if (!owner.exited) owner.process.kill("SIGKILL");
      const finalDeadline = performance.now() + STOP_MS;
      while (!owner.exited && performance.now() < finalDeadline) await delay(20);
      if (!owner.exited) throw new Error("Broker has not exited; its reservation remains held.");
    }
    fs.rmSync(owner.routesPath, { force: true });
  }

  private async stopIdentity(identity: { pid: number; birth: number }): Promise<void> {
    if (!(await this.isCurrent(identity))) return;
    try { process.kill(identity.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = performance.now() + STOP_MS;
    while (performance.now() < deadline && await this.isCurrent(identity)) await delay(20);
    if (await this.isCurrent(identity)) {
      try { process.kill(identity.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      const finalDeadline = performance.now() + STOP_MS;
      while (performance.now() < finalDeadline && await this.isCurrent(identity)) await delay(20);
      if (await this.isCurrent(identity)) throw new Error("Shell supervisor has not exited; its reservation remains held.");
    }
  }

  private async isCurrent(identity: { pid: number; birth: number }): Promise<boolean> {
    const current = await this.options.readIdentity(identity.pid);
    if (current !== undefined) return current.birth === identity.birth;
    // A failed identity helper does not prove exit. Preserve the reservation
    // while an unverified process with that PID still exists.
    try { process.kill(identity.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    throw new Error("Live supervisor identity could not be verified; reservation remains held.");
  }

  private prepareArtifacts(): { broker: string; launcher: string; hook: string } {
    if (this.artifactPaths !== undefined) return this.artifactPaths;
    const names = { broker: "portmanager_network_broker", launcher: "portmanager_network_launch", hook: "libportmanager_hook.dylib" };
    const paths = {} as { broker: string; launcher: string; hook: string };
    for (const [key, name] of Object.entries(names)) {
      const source = path.join(this.options.artifactDirectory, name);
      if (!readNativeBinaryArchitectures(source).includes(process.arch === "arm64" ? "arm64" : "x64")) throw new Error("Guarded native artifact has the wrong architecture.");
      const bytes = fs.readFileSync(source);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const directory = path.join(this.stateDirectory, "runtime", "guarded", digest);
      ensurePrivateDirectory(directory);
      const target = path.join(directory, name);
      if (!fs.existsSync(target)) writePrivateAtomic(target, bytes, 0o700);
      else if (!readPrivateBytes(target, bytes.length + 1).equals(bytes)) throw new Error("Protected native runtime bytes do not match their content identity.");
      paths[key as keyof typeof paths] = target;
    }
    this.artifactPaths = paths;
    return paths;
  }

  /** Profiles remain host-readable; PM bootstrap runs last with fixed values. */
  private prepareBootstrap(scope: NetworkRuntimeScope, workspaces: readonly string[], shell: string, id: string): { directory: string; common: string; bashrc: string } {
    const directory = path.join(this.stateDirectory, "runtime", "shells", id);
    ensurePrivateDirectory(directory);
    const originalZdotdir = process.env.ZDOTDIR ?? os.homedir();
    const common = path.join(directory, "network.sh");
    const namespace = networkNamespacePaths(workspaces[0], scope.id).directory;
    const artifacts = this.prepareArtifacts();
    const exports: Record<string, string> = { ...scope.bootstrapEnvironment,
      PORT_MANAGER_NETWORK_ID: scope.id, PORT_MANAGER_NETWORK_NAME: scope.name,
      PORT_MANAGER_NETWORK_LOOPBACK_HOST: scope.loopbackHost, PORT_MANAGER_ACTUAL_LOOPBACK_HOST: scope.loopbackHost,
      PORT_MANAGER_NETWORK_BROKER_SOCKET: this.brokers.get(scope.id)!.endpoint,
      PORT_MANAGER_HOOK: "1", PORT_MANAGER_AGENT_REQUIRED: "0", PORT_MANAGER_HOOK_DISABLED: "0",
      PORT_MANAGER_DYLD_INSERT_LIBRARIES: artifacts.hook,
      DYLD_INSERT_LIBRARIES: artifacts.hook, HISTFILE: path.join(namespace, "shell-history") };
    if (Object.keys(exports).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error("Invalid bootstrap environment key.");
    writePrivateAtomic(common, Object.entries(exports).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n") + "\n");
    writePrivateAtomic(path.join(directory, ".zshenv"), `unset ZDOTDIR\n[ ! -f ${shellQuote(path.join(originalZdotdir, ".zshenv"))} ] || . ${shellQuote(path.join(originalZdotdir, ".zshenv"))}\nexport ZDOTDIR=${shellQuote(directory)}\n`);
    writePrivateAtomic(path.join(directory, ".zshrc"), `[ ! -f ${shellQuote(path.join(originalZdotdir, ".zshrc"))} ] || . ${shellQuote(path.join(originalZdotdir, ".zshrc"))}\n. ${shellQuote(common)}\n`);
    const bashrc = path.join(directory, "bashrc");
    writePrivateAtomic(bashrc, `[ ! -f ${shellQuote(path.join(os.homedir(), ".bashrc"))} ] || . ${shellQuote(path.join(os.homedir(), ".bashrc"))}\n. ${shellQuote(common)}\n`);
    void shell;
    return { directory, common, bashrc };
  }

  private requireShell(id: string): ShellOwner {
    const owner = this.shells.get(id);
    if (owner === undefined) throw new Error("Unknown guarded terminal owner.");
    return owner;
  }

  private assertAvailable(): void {
    if (process.platform !== "darwin") throw new Error("Guarded host-runtime terminals currently require macOS.");
    if (this.disposed) throw new Error("Network runtime has been disposed.");
  }
}

/** Walk existing parents instead of following an attacker-supplied symlink. */
function ensurePrivateDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw new Error("Runtime path is not canonical.");
  const components = directory.split(path.sep).filter(Boolean);
  let current = path.parse(directory).root;
  for (const component of components) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Runtime directory traverses a non-directory or symlink.");
    if (current.includes(`${path.sep}.portmanager${path.sep}`) || component === ".portmanager") {
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error("Runtime directory is not owned by its controller.");
    }
  }
  fs.chmodSync(directory, 0o700);
}

/** Fresh inode + atomic rename preserves already mapped code and complete policy. */
function writePrivateAtomic(file: string, value: string | Buffer, mode = 0o600): void {
  ensurePrivateDirectory(path.dirname(file));
  const prior = fs.lstatSync(file, { throwIfNoEntry: false });
  if (prior !== undefined && (!prior.isFile() || prior.isSymbolicLink() || prior.uid !== process.getuid?.() || prior.nlink !== 1)) throw new Error("Runtime file has an unsafe owner or identity.");
  const temporary = path.join(path.dirname(file), "." + randomUUID());
  try { fs.writeFileSync(temporary, value, { mode, flag: "wx" }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function readPrivateBytes(file: string, limit: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > limit) throw new Error("Runtime file is not bounded private regular data.");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function readPrivateJson(file: string, limit: number): unknown | undefined {
  try { return JSON.parse(readPrivateBytes(file, limit).toString("utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Route coordinates come from controller state and stay fixed to this id. */
function serializeRoutes(networkId: string, routes: readonly NetworkRuntimeRoute[]): string {
  if (routes.length > MAX_ROUTE_ROWS) throw new Error("Broker route policy exceeds its row limit.");
  const ports = new Set<number>();
  for (const route of routes) {
    if (!Number.isSafeInteger(route.port) || route.port < 1 || route.port > 65535 ||
        !Number.isSafeInteger(route.targetPort) || route.targetPort < 1 || route.targetPort > 65535 ||
        net.isIP(route.targetHost) === 0 || ports.has(route.port)) throw new Error("Broker route policy requires unique numeric endpoints.");
    ports.add(route.port);
  }
  const value = [JSON.stringify({ version: 1, networkId }), ...routes.map(route =>
    JSON.stringify({ logicalPort: route.port, targetHost: route.targetHost, targetPort: route.targetPort }))].join("\n") + "\n";
  if (Buffer.byteLength(value) > MAX_ROUTE_BYTES) throw new Error("Broker route policy exceeds its byte limit.");
  return value;
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Shell value contains NUL.");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Broker output belongs solely to its trusted native parent, not a workload. */
function readBrokerReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", output);
      child.off("error", failed);
      child.off("exit", exited);
      if (error !== undefined) reject(error); else resolve();
    };
    const output = (bytes: Buffer) => {
      text += bytes.toString("utf8");
      if (Buffer.byteLength(text) > 1024) finish(new Error("Broker readiness exceeds its frame limit."));
      else if (text.includes("\n")) finish(text === "ready\n" ? undefined : new Error("Invalid broker readiness frame."));
    };
    const failed = (error: Error) => finish(error);
    const exited = () => finish(new Error("Broker exited before authenticated readiness."));
    const timer = setTimeout(() => finish(new Error("Broker startup timed out.")), STARTUP_MS);
    child.stdout?.on("data", output);
    child.once("error", failed);
    child.once("exit", exited);
  });
}

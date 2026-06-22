import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ContainerRuntimePreference,
  ContainerRuntimeSettings,
  HostPortExposure,
  LogicalNetwork,
  NetworkRuntimeDescriptor,
} from "../../shared/types";

/**
 * Docker/Podman-backed runtime for network-namespace logical networks.
 *
 * The adapter owns low-level CLI calls and deterministic resource naming. The
 * extension service decides when a logical network should exist and records the
 * resulting domain state after this adapter has prepared the namespace holder.
 */

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15_000;
const INSPECT_TIMEOUT_MS = 2_000;
const PORT_MANAGER_LABEL = "newdlops.portmanager";
const GLOBAL_NETWORK_NAME = "portmanager-global";

export interface ContainerRuntimeTarget {
  /** Host address reachable from the VS Code extension host. */
  readonly host: string;
  /** TCP port inside the isolated network namespace. */
  readonly port: number;
}

export interface ContainerCommandResult {
  /** Standard output captured from the runtime CLI. */
  readonly stdout: string;
  /** Standard error captured from the runtime CLI. */
  readonly stderr: string;
}

export type ContainerCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number },
) => Promise<ContainerCommandResult>;

export interface ContainerNetworkRuntimeAdapterOptions {
  /** Injected command runner used by unit tests to avoid real Docker calls. */
  readonly runCommand?: ContainerCommandRunner;
  /** Whether the host can enter container network namespaces without changing filesystem/runtime. */
  readonly supportsHostNetworkNamespace?: boolean;
}

/**
 * Manages a single global bridge network and one namespace holder per logical network.
 *
 * The holder container is not a development environment. It only keeps a
 * network namespace alive. On Linux, attach uses nsenter for that namespace
 * only, so processes keep the user's host filesystem, binaries, and shell
 * environment while their sockets bind away from the host namespace.
 */
export class ContainerNetworkRuntimeAdapter {
  /** Concrete CLI selected by capability probing. */
  private executable: "docker" | "podman" | undefined;

  /** True when host processes can enter a container network namespace directly. */
  private readonly supportsHostNetworkNamespace: boolean;

  /** Low-level command runner; production uses child_process.execFile. */
  private readonly runCommand: ContainerCommandRunner;

  constructor(options: ContainerNetworkRuntimeAdapterOptions = {}) {
    this.runCommand = options.runCommand ?? runContainerCommand;
    this.supportsHostNetworkNamespace = options.supportsHostNetworkNamespace ?? process.platform === "linux";
  }

  /** Returns a runtime descriptor when Docker or Podman is available. */
  async detect(settings: ContainerRuntimeSettings): Promise<NetworkRuntimeDescriptor | undefined> {
    for (const executable of runtimeCandidates(settings.containerRuntime)) {
      if (await this.canRun(executable)) {
        this.executable = executable;
        return descriptorForExecutable(executable, this.supportsHostNetworkNamespace);
      }
    }

    this.executable = undefined;
    return undefined;
  }

  /** Creates or starts the namespace holder backing one logical network. */
  async createNetwork(network: LogicalNetwork, settings: ContainerRuntimeSettings): Promise<void> {
    const executable = this.requireExecutable();
    const resourceNames = containerResourceNames(network.id);

    await this.ensureGlobalBridgeNetwork(executable);
    await this.ensureNamespaceHolder(executable, resourceNames, network, settings);
  }

  /** Stops and removes the namespace holder for one logical network. */
  async removeNetwork(networkId: string): Promise<void> {
    const executable = this.requireExecutable();
    const resourceNames = containerResourceNames(networkId);

    await this.runCommand(executable, ["rm", "-f", resourceNames.containerName], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch(() => undefined);
  }

  /** Builds the host-shell command that enters only the holder's network namespace. */
  async buildAttachCommand(networkId: string): Promise<string> {
    if (!this.supportsHostNetworkNamespace) {
      throw new Error("Container network attach without changing the runtime environment requires Linux nsenter.");
    }

    const executable = this.requireExecutable();
    const { containerName } = containerResourceNames(networkId);
    const holderPid = await this.inspectContainerPid(executable, containerName);

    if (holderPid <= 0) {
      throw new Error(`Container namespace holder ${containerName} is not running.`);
    }

    return [
      "nsenter",
      "--target",
      String(holderPid),
      "--net",
      "--preserve-credentials",
      "--",
      "sh",
      "-lc",
      shellQuote('cd "$PWD" && exec "${SHELL:-/bin/sh}" -l'),
    ].join(" ");
  }

  /**
   * Resolves a host exposure target to the backing container IP.
   *
   * The current proxy path requires the container address to be reachable from
   * the host. Docker Desktop may need a later sidecar/published-port adapter.
   */
  async resolveExposureTarget(exposure: HostPortExposure): Promise<ContainerRuntimeTarget> {
    const executable = this.requireExecutable();
    const { containerName } = containerResourceNames(exposure.networkId);
    const containerIp = await this.inspectContainerIp(executable, containerName);

    if (containerIp.length === 0) {
      throw new Error(`Container ${containerName} has no reachable bridge IP address.`);
    }

    return {
      host: containerIp,
      port: exposure.targetPort,
    };
  }

  /** Returns the selected runtime descriptor after a successful detect call. */
  getDescriptor(): NetworkRuntimeDescriptor | undefined {
    return this.executable === undefined
      ? undefined
      : descriptorForExecutable(this.executable, this.supportsHostNetworkNamespace);
  }

  /** Checks whether a candidate CLI is installed and responsive. */
  private async canRun(executable: "docker" | "podman"): Promise<boolean> {
    try {
      await this.runCommand(executable, ["info"], { timeoutMs: INSPECT_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /** Ensures the singleton bridge network exists before starting namespace holders. */
  private async ensureGlobalBridgeNetwork(executable: string): Promise<void> {
    if (await this.resourceExists(executable, ["network", "inspect", GLOBAL_NETWORK_NAME])) {
      return;
    }

    await this.runCommand(
      executable,
      [
        "network",
        "create",
        "--label",
        `${PORT_MANAGER_LABEL}=1`,
        "--label",
        `${PORT_MANAGER_LABEL}.scope=global-network`,
        GLOBAL_NETWORK_NAME,
      ],
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
  }

  /** Creates the long-lived network namespace holder if needed, otherwise starts it. */
  private async ensureNamespaceHolder(
    executable: string,
    resourceNames: ContainerRuntimeResourceNames,
    network: LogicalNetwork,
    settings: ContainerRuntimeSettings,
  ): Promise<void> {
    if (await this.resourceExists(executable, ["container", "inspect", resourceNames.containerName])) {
      await this.runCommand(executable, ["start", resourceNames.containerName], {
        timeoutMs: COMMAND_TIMEOUT_MS,
      }).catch(() => undefined);
      return;
    }

    const args = [
      "run",
      "-d",
      "--name",
      resourceNames.containerName,
      "--hostname",
      resourceNames.hostname,
      "--label",
      `${PORT_MANAGER_LABEL}=1`,
      "--label",
      `${PORT_MANAGER_LABEL}.network-id=${network.id}`,
      "--label",
      `${PORT_MANAGER_LABEL}.network-name=${network.name}`,
      "--network",
      GLOBAL_NETWORK_NAME,
    ];

    args.push(settings.containerImage, "sh", "-lc", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done");

    await this.runCommand(executable, args, { timeoutMs: COMMAND_TIMEOUT_MS });
  }

  /** Reads the container's bridge IP from Docker/Podman inspect output. */
  private async inspectContainerIp(executable: string, containerName: string): Promise<string> {
    const result = await this.runCommand(
      executable,
      ["container", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerName],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    );

    return result.stdout.trim();
  }

  /** Reads the host-visible init PID so nsenter can borrow only the network namespace. */
  private async inspectContainerPid(executable: string, containerName: string): Promise<number> {
    const result = await this.runCommand(
      executable,
      ["container", "inspect", "-f", "{{.State.Pid}}", containerName],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    );
    const pid = Number.parseInt(result.stdout.trim(), 10);

    return Number.isInteger(pid) ? pid : 0;
  }

  /** Tests for CLI resource existence without surfacing missing-resource errors. */
  private async resourceExists(executable: string, args: readonly string[]): Promise<boolean> {
    try {
      await this.runCommand(executable, args, { timeoutMs: INSPECT_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /** Requires detect() to have selected a concrete runtime first. */
  private requireExecutable(): "docker" | "podman" {
    if (this.executable === undefined) {
      throw new Error("No container runtime is available. Install Docker or Podman and refresh Port Manager.");
    }

    return this.executable;
  }
}

interface ContainerRuntimeResourceNames {
  /** Long-lived container name for the logical network namespace holder. */
  readonly containerName: string;
  /** Container hostname used only for runtime diagnostics. */
  readonly hostname: string;
}

/** Executes a container CLI command and preserves stderr in thrown errors. */
async function runContainerCommand(
  executable: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<ContainerCommandResult> {
  try {
    const result = await execFileAsync(executable, [...args], {
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const stderr = readCommandText(error, "stderr");
    const stdout = readCommandText(error, "stdout");
    const detail = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(`${executable} ${args.join(" ")} failed: ${detail}`);
  }
}

/** Orders candidate runtimes according to user preference. */
function runtimeCandidates(preference: ContainerRuntimePreference): readonly ("docker" | "podman")[] {
  switch (preference) {
    case "docker":
      return ["docker"];
    case "podman":
      return ["podman"];
    case "auto":
      return ["docker", "podman"];
  }
}

/** Builds a capability descriptor for the selected container CLI. */
function descriptorForExecutable(
  executable: "docker" | "podman",
  supportsHostNetworkNamespace: boolean,
): NetworkRuntimeDescriptor {
  return {
    id: executable,
    name: executable === "docker" ? "Docker Network Namespace" : "Podman Network Namespace",
    kind: "container",
    capabilities: {
      supportsSameInternalPorts: supportsHostNetworkNamespace,
      supportsTerminalAttach: supportsHostNetworkNamespace,
      supportsHostExposure: true,
      requiresPrivilegedHelper: supportsHostNetworkNamespace,
      requiresContainerRuntime: true,
    },
  };
}

/** Produces deterministic Docker-safe names from a logical network id. */
function containerResourceNames(networkId: string): ContainerRuntimeResourceNames {
  const suffix = sanitizeResourceName(networkId).slice(0, 48);

  return {
    containerName: `portmanager-netns-${suffix}`,
    hostname: `pm-${suffix}`.slice(0, 63),
  };
}

/** Keeps resource names inside Docker's conservative name character set. */
function sanitizeResourceName(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "network";
}

/** Quotes one value for a POSIX-like shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Reads stdout/stderr from execFile errors without depending on Node internals. */
function readCommandText(error: unknown, property: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(property in error)) {
    return "";
  }

  const value = (error as Record<typeof property, unknown>)[property];
  return typeof value === "string" ? value.trim() : "";
}

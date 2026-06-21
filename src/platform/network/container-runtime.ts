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
 * Docker/Podman-backed runtime for container-level logical networks.
 *
 * The adapter owns low-level CLI calls and deterministic resource naming. The
 * extension service decides when a logical network should exist and records the
 * resulting domain state after this adapter has prepared the container.
 */

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15_000;
const INSPECT_TIMEOUT_MS = 2_000;
const PORT_MANAGER_LABEL = "newdlops.portmanager";

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
}

/**
 * Manages one long-lived container per logical network.
 *
 * A terminal "attach" enters that container through `docker exec`; application
 * servers therefore bind inside the container namespace instead of the host
 * namespace. Host ports are still opened only by explicit Host Port Exposure.
 */
export class ContainerNetworkRuntimeAdapter {
  /** Concrete CLI selected by capability probing. */
  private executable: "docker" | "podman" | undefined;

  /** Low-level command runner; production uses child_process.execFile. */
  private readonly runCommand: ContainerCommandRunner;

  constructor(options: ContainerNetworkRuntimeAdapterOptions = {}) {
    this.runCommand = options.runCommand ?? runContainerCommand;
  }

  /** Returns a runtime descriptor when Docker or Podman is available. */
  async detect(settings: ContainerRuntimeSettings): Promise<NetworkRuntimeDescriptor | undefined> {
    for (const executable of runtimeCandidates(settings.containerRuntime)) {
      if (await this.canRun(executable)) {
        this.executable = executable;
        return descriptorForExecutable(executable);
      }
    }

    this.executable = undefined;
    return undefined;
  }

  /** Creates or starts the isolated container backing one logical network. */
  async createNetwork(
    network: LogicalNetwork,
    settings: ContainerRuntimeSettings,
    workspaceFolder: string | undefined,
  ): Promise<void> {
    const executable = this.requireExecutable();
    const resourceNames = containerResourceNames(network.id);

    await this.ensureBridgeNetwork(executable, resourceNames.networkName, network.id);
    await this.ensureContainer(executable, resourceNames, network, settings, workspaceFolder);
  }

  /** Stops and removes runtime resources for one logical network. */
  async removeNetwork(networkId: string): Promise<void> {
    const executable = this.requireExecutable();
    const resourceNames = containerResourceNames(networkId);

    await this.runCommand(executable, ["rm", "-f", resourceNames.containerName], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch(() => undefined);
    await this.runCommand(executable, ["network", "rm", resourceNames.networkName], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch(() => undefined);
  }

  /** Builds the host-shell command that enters the network container. */
  buildAttachCommand(networkId: string, settings: ContainerRuntimeSettings): string {
    const executable = this.requireExecutable();
    const { containerName } = containerResourceNames(networkId);
    const shell = normalizeContainerShell(settings.containerShell);
    const workspacePath = normalizeContainerWorkspacePath(settings.containerWorkspacePath);
    const innerCommand = `cd ${shellQuote(workspacePath)} && exec ${shellQuote(shell)} -l`;

    return [
      executable,
      "exec",
      "-it",
      "-w",
      shellQuote(workspacePath),
      shellQuote(containerName),
      shellQuote(shell),
      "-lc",
      shellQuote(innerCommand),
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
    return this.executable === undefined ? undefined : descriptorForExecutable(this.executable);
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

  /** Ensures the per-network bridge network exists before starting containers. */
  private async ensureBridgeNetwork(executable: string, networkName: string, networkId: string): Promise<void> {
    if (await this.resourceExists(executable, ["network", "inspect", networkName])) {
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
        `${PORT_MANAGER_LABEL}.network-id=${networkId}`,
        networkName,
      ],
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
  }

  /** Creates the long-lived container if needed, otherwise starts it. */
  private async ensureContainer(
    executable: string,
    resourceNames: ContainerRuntimeResourceNames,
    network: LogicalNetwork,
    settings: ContainerRuntimeSettings,
    workspaceFolder: string | undefined,
  ): Promise<void> {
    if (await this.resourceExists(executable, ["container", "inspect", resourceNames.containerName])) {
      await this.runCommand(executable, ["start", resourceNames.containerName], {
        timeoutMs: COMMAND_TIMEOUT_MS,
      }).catch(() => undefined);
      return;
    }

    const workspacePath = normalizeContainerWorkspacePath(settings.containerWorkspacePath);
    const shell = normalizeContainerShell(settings.containerShell);
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
      resourceNames.networkName,
    ];

    if (workspaceFolder !== undefined) {
      args.push("-v", `${workspaceFolder}:${workspacePath}`, "-w", workspacePath);
    }

    args.push(settings.containerImage, shell, "-lc", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done");

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
  /** Docker/Podman bridge network name for this logical network. */
  readonly networkName: string;
  /** Long-lived container name for terminal shells. */
  readonly containerName: string;
  /** Container hostname shown inside the shell. */
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
function descriptorForExecutable(executable: "docker" | "podman"): NetworkRuntimeDescriptor {
  return {
    id: executable,
    name: executable === "docker" ? "Docker Container Runtime" : "Podman Container Runtime",
    kind: "container",
    capabilities: {
      supportsSameInternalPorts: true,
      supportsTerminalAttach: true,
      supportsHostExposure: true,
      requiresPrivilegedHelper: false,
      requiresContainerRuntime: true,
    },
  };
}

/** Produces deterministic Docker-safe names from a logical network id. */
function containerResourceNames(networkId: string): ContainerRuntimeResourceNames {
  const suffix = sanitizeResourceName(networkId).slice(0, 48);

  return {
    networkName: `portmanager-net-${suffix}`,
    containerName: `portmanager-dev-${suffix}`,
    hostname: `pm-${suffix}`.slice(0, 63),
  };
}

/** Keeps resource names inside Docker's conservative name character set. */
function sanitizeResourceName(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "network";
}

/** Normalizes the in-container workspace path used by run and exec commands. */
function normalizeContainerWorkspacePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.startsWith("/") ? trimmed : "/workspace";
}

/** Normalizes the shell path used for keepalive and interactive attach. */
function normalizeContainerShell(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "/bin/sh";
}

/** Quotes one value for a POSIX-like host or container shell. */
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

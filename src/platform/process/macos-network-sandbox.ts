import * as path from "node:path";
import { networkStorageKey } from "../../core/networks/network-identity";

export interface MacosNetworkSandboxScope {
  readonly networkId: string;
  /** Canonical project namespace roots belonging to this id, not shared source roots. */
  readonly namespaceDirectories: readonly string[];
  /** Mutable shared source is an explicit user choice; PM private state stays excluded. */
  readonly sharedWorkspaceDirectories: readonly string[];
  /** The broker endpoint is scoped independently of caller-controlled env/JSON. */
  readonly agentSocketPath?: string;
}

/**
 * Kernel policy candidate for host-runtime execution. Shared host files stay
 * readable; shared source writes remain allowed. Other PM state,
 * Unix sockets, signals and process inspection remain denied by default.
 * This policy is deliberately not wired to the cooperative attach path until
 * a scoped broker and terminal replacement lifecycle enforce it end-to-end.
 */
export function buildMacosNetworkSandboxProfile(scope: MacosNetworkSandboxScope): string {
  const key = networkStorageKey(scope.networkId);
  const directories = scope.namespaceDirectories.map(directory => {
    if (!path.isAbsolute(directory) || path.basename(directory) !== key ||
        path.basename(path.dirname(directory)) !== "namespaces" ||
        path.basename(path.dirname(path.dirname(directory))) !== ".portmanager" ||
        path.normalize(directory) !== directory) throw new Error("Sandbox writes require a canonical namespace owned by its network id.");
    return directory;
  });
  if (directories.length === 0) throw new Error("Sandbox execution requires a network namespace.");
  const sharedDirectories = scope.sharedWorkspaceDirectories.map(directory => {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory === "/") {
      throw new Error("Shared workspace must be an explicit canonical directory.");
    }
    return directory;
  });
  // The nofollow mirror walk opens these common parents as directories.
  // Allow enumeration/traversal of their names, never data in another realm.
  const namespaceParents = [...new Set(directories.flatMap(directory => [path.dirname(directory), path.dirname(path.dirname(directory))]))];
  const profile = [
    "(version 1)", "(deny default)",
    "(allow process-exec process-fork)",
    "(deny process-info*)",
    "(deny sysctl-read (sysctl-name \"kern.procargs\") (sysctl-name \"kern.procargs2\"))",
    "(allow sysctl-read (sysctl-name-regex #\"^hw[.]\") (sysctl-name \"kern.osrelease\") (sysctl-name \"kern.ostype\") (sysctl-name \"kern.osversion\") (sysctl-name \"kern.osproductversion\") (sysctl-name \"kern.hostname\") (sysctl-name \"kern.maxfilesperproc\"))",
    "(allow signal (target self) (target children))",
    "(allow process-info-pidinfo (target self))",
    "(allow system-sched (target self))",
    "(allow file-read* file-map-executable (require-all (require-not (regex #\"/[.]portmanager(/|$)\")) (require-not (regex #\"^/dev/tty\"))))",
    "(allow file-read-metadata (subpath \"/\"))",
    "(allow file-read* file-map-executable (require-all (regex #\"/[.]portmanager/runtime/\") (require-not (regex #\"/[.]portmanager/namespaces/\"))))",
    ...sharedDirectories.map(directory => `(allow file-write* (require-all (subpath ${profileString(directory)}) (require-not (regex #\"/[.]portmanager(/|$)\"))))`),
    ...directories.map(directory => `(allow file-read* file-write* file-map-executable (subpath ${profileString(directory)}))`),
    ...namespaceParents.map(directory => `(allow file-read-data (require-all (vnode-type DIRECTORY) (literal ${profileString(directory)})))`),
    "(allow file-read-data file-write-data (literal \"/dev/null\"))",
    "(allow mach-lookup (global-name \"com.apple.logd\") (global-name \"com.apple.system.logger\") (global-name \"com.apple.system.opendirectoryd.libinfo\"))",
  ];
  if (scope.agentSocketPath !== undefined) {
    if (!path.isAbsolute(scope.agentSocketPath) || path.normalize(scope.agentSocketPath) !== scope.agentSocketPath ||
        !scope.agentSocketPath.includes(`${path.sep}.portmanager${path.sep}security${path.sep}sockets${path.sep}`) ||
        directories.some(directory => scope.agentSocketPath!.startsWith(`${directory}${path.sep}`))) {
      throw new Error("Sandbox broker socket must live in protected control-plane storage.");
    }
    profile.push(`(allow network-outbound (literal ${profileString(scope.agentSocketPath)}))`);
  }
  // Seatbelt network addresses accept only '*' and 'localhost', not per-id
  // 127.x aliases. Permit no direct IP sockets: the fixed-scope Unix broker
  // must validate the operation and transfer only an authorized socket FD.
  return profile.join("\n") + "\n";
}

/** SBPL string syntax shares these escapes; reject control bytes rather than emitting policy syntax. */
function profileString(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Sandbox path contains control characters.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

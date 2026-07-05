/**
 * Pure decision for reaping a respawned "escaped server" replacement.
 *
 * When Port Manager re-hooks a dev server that escaped the preload, macOS (which
 * has no reparent API) leaves the replacement orphaned to launchd. To retire it
 * with its dev-server run — without moving it out of its tree — the daemon watches
 * the run's process subtree and reaps the replacement when that run ends. This
 * function is the KILL DECISION, isolated so it can be exhaustively unit-tested:
 * it must never kill a still-running server, never kill across a network boundary,
 * and never react to transient churn.
 *
 * A replacement is reaped ONLY when every one of these holds:
 *  - network scope: its CURRENT network still equals the network recorded at
 *    respawn (a mismatch — e.g. pid reuse or misattribution — never reaps);
 *  - whole invocation subtree dead: EVERY launcher-subtree ancestor recorded at
 *    respawn is gone (one transient intermediate dying is never enough — the
 *    long-lived launcher must also be gone, i.e. the run truly ended);
 *  - confirmation delay: the subtree has stayed fully dead for >= confirmMs, so a
 *    momentary disappearance during startup/respawn churn cannot trigger a kill.
 */
export interface RespawnReapInput {
  /** Network id recorded in the replacement's marker at respawn time. */
  readonly recordedNetworkId: string;
  /** The replacement's network id as observed right now (undefined if unknown). */
  readonly currentNetworkId: string | undefined;
  /** Launcher-subtree ancestor pids captured at respawn (the run's processes). */
  readonly invocationAncestorPids: readonly number[];
  /** Liveness probe for an ancestor pid (should err toward "alive" on uncertainty). */
  readonly isAncestorAlive: (pid: number) => boolean;
  /** When the caller first observed the whole subtree dead; undefined if not (yet). */
  readonly allDeadSinceMs: number | undefined;
  readonly nowMs: number;
  readonly confirmMs: number;
}

export type RespawnReapReason =
  | "scope-mismatch"
  | "no-evidence"
  | "run-alive"
  | "awaiting-confirmation"
  | "reap";

export interface RespawnReapDecision {
  /** Kill the replacement now. */
  readonly reap: boolean;
  /** Whether the whole invocation subtree is dead at this instant (caller stamps the clock). */
  readonly subtreeDeadNow: boolean;
  readonly reason: RespawnReapReason;
}

export function evaluateRespawnReap(input: RespawnReapInput): RespawnReapDecision {
  // Scope guard: never signal a process outside the recorded network. This also
  // catches pid reuse — a reused pid in another (or no) network fails here.
  if (input.currentNetworkId === undefined || input.currentNetworkId !== input.recordedNetworkId) {
    return { reap: false, subtreeDeadNow: false, reason: "scope-mismatch" };
  }
  // No recorded run processes → no basis to conclude the run ended → never reap.
  if (input.invocationAncestorPids.length === 0) {
    return { reap: false, subtreeDeadNow: false, reason: "no-evidence" };
  }
  // Any launcher-subtree ancestor still alive → the run is still going.
  const subtreeDeadNow = !input.invocationAncestorPids.some((pid) => input.isAncestorAlive(pid));
  if (!subtreeDeadNow) {
    return { reap: false, subtreeDeadNow: false, reason: "run-alive" };
  }
  // Whole subtree dead — require it to have stayed dead for confirmMs before killing.
  if (input.allDeadSinceMs === undefined || input.nowMs - input.allDeadSinceMs < input.confirmMs) {
    return { reap: false, subtreeDeadNow: true, reason: "awaiting-confirmation" };
  }
  return { reap: true, subtreeDeadNow: true, reason: "reap" };
}

/** Serializes a respawn marker value: `<networkId>~<pid,pid,...>`. */
export function encodeRespawnInvocationMarker(networkId: string, invocationAncestorPids: readonly number[]): string {
  return `${networkId}~${invocationAncestorPids.join(",")}`;
}

/** Parses a respawn marker value; returns undefined when malformed or empty. */
export function decodeRespawnInvocationMarker(
  value: string,
): { networkId: string; invocationAncestorPids: number[] } | undefined {
  const separator = value.indexOf("~");
  if (separator <= 0) {
    return undefined;
  }
  const networkId = value.slice(0, separator);
  const pids = value
    .slice(separator + 1)
    .split(",")
    .map((part) => Number(part))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  if (pids.length === 0) {
    return undefined;
  }
  return { networkId, invocationAncestorPids: pids };
}

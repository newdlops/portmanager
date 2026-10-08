/**
 * Maps a logical network id to a stable loopback IPv4 address.
 *
 * The native hook can then keep the original TCP port and isolate networks by
 * binding each one to a different 127.x.x.x address. macOS requires that this
 * address first exists as a lo0 alias; Linux commonly routes 127/8 without it.
 */

import type { ExperimentalRouteOwnershipMode, LoopbackAddressRoutingMode } from "../../shared/types";

export const ACTUAL_LOOPBACK_HOST_ENV = "PORT_MANAGER_ACTUAL_LOOPBACK_HOST";
export const NETWORK_LOOPBACK_HOST_ENV = "PORT_MANAGER_NETWORK_LOOPBACK_HOST";

/**
 * Reserved id of the global logical network that absorbs processes attached to
 * no user network. Distinct from the container bridge constant
 * `portmanager-global` in platform/network/container-runtime.ts; user network
 * ids are `network-<uuid>` so this literal cannot collide with one.
 */
export const GLOBAL_LOGICAL_NETWORK_ID = "network-global";
/** Env flag telling the native hook a scope is the global network (identity stays host-real). */
export const NETWORK_IS_GLOBAL_ENV = "PORT_MANAGER_NETWORK_IS_GLOBAL";

/*
 * The global network's coordinates are fixed constants outside every hashed
 * band (networks 127.80-111, browser 127.112-143, pf targets 127.144-175) so
 * they are recognizable at a glance in logs, pf rules, and lsof output.
 */
const GLOBAL_NETWORK_LOOPBACK_ADDRESS = "127.1.0.1";
const GLOBAL_NETWORK_BROWSER_LOOPBACK_ADDRESS = "127.1.1.1";
const GLOBAL_NETWORK_HOST_LOCAL_GATEWAY_ADDRESS = "127.1.2.1";

export function isGlobalNetworkId(networkId: string | undefined): networkId is string {
  return networkId === GLOBAL_LOGICAL_NETWORK_ID;
}
export const LOOPBACK_ADDRESS_ONLY_ROUTE_OWNERSHIP_MODE: ExperimentalRouteOwnershipMode = "loopback-address-only";
const DEFAULT_LOOPBACK_ADDRESS_ROUTING_MODE: LoopbackAddressRoutingMode = "loopback";

export function isLoopbackAddressRoutingEnabled(settings: {
  readonly enableLoopbackAddressRouting?: boolean;
  readonly loopbackAddressRoutingMode?: LoopbackAddressRoutingMode;
}): boolean {
  return resolveLoopbackAddressRoutingMode(settings) !== "high-port";
}

/** True when the experimental terminal hook should preserve ports and isolate only by loopback IP. */
export function usesLoopbackAddressOnlyRouting(settings: {
  readonly experimentalRouteOwnershipMode?: ExperimentalRouteOwnershipMode;
}): boolean {
  return settings.experimentalRouteOwnershipMode === LOOPBACK_ADDRESS_ONLY_ROUTE_OWNERSHIP_MODE;
}

/** Decides whether terminal hooks should expose the same-port network loopback host. */
export function shouldExposeNetworkLoopbackHost(settings: {
  readonly enableLoopbackAddressRouting?: boolean;
  readonly experimentalRouteOwnershipMode?: ExperimentalRouteOwnershipMode;
  readonly loopbackAddressRoutingMode?: LoopbackAddressRoutingMode;
}): boolean {
  return isLoopbackAddressRoutingEnabled(settings) || usesLoopbackAddressOnlyRouting(settings);
}

/** Resolves the attach-time alias policy after applying address-only experimental routing. */
export function resolveTerminalLoopbackAddressRoutingMode(settings: {
  readonly enableLoopbackAddressRouting?: boolean;
  readonly experimentalRouteOwnershipMode?: ExperimentalRouteOwnershipMode;
  readonly loopbackAddressRoutingMode?: LoopbackAddressRoutingMode;
}): LoopbackAddressRoutingMode {
  const mode = resolveLoopbackAddressRoutingMode(settings);
  return usesLoopbackAddressOnlyRouting(settings) && mode === "high-port" ? "loopback" : mode;
}

export function resolveLoopbackAddressRoutingMode(settings: {
  readonly enableLoopbackAddressRouting?: boolean;
  readonly loopbackAddressRoutingMode?: LoopbackAddressRoutingMode;
}): LoopbackAddressRoutingMode {
  if (settings.loopbackAddressRoutingMode !== undefined) {
    return settings.loopbackAddressRoutingMode;
  }

  if (settings.enableLoopbackAddressRouting !== undefined) {
    return settings.enableLoopbackAddressRouting ? "auto" : "high-port";
  }

  return DEFAULT_LOOPBACK_ADDRESS_ROUTING_MODE;
}

export function loopbackAddressForNetwork(networkId: string): string {
  if (isGlobalNetworkId(networkId)) {
    return GLOBAL_NETWORK_LOOPBACK_ADDRESS;
  }

  const hash = fnv1a32(networkId);
  const secondOctet = 80 + (hash & 0x1f);
  const thirdOctet = (hash >>> 8) & 0xff;
  const fourthOctet = 1 + ((hash >>> 16) % 254);

  return `127.${secondOctet}.${thirdOctet}.${fourthOctet}`;
}

export function browserLoopbackAddressForNetwork(networkId: string): string {
  if (isGlobalNetworkId(networkId)) {
    return GLOBAL_NETWORK_BROWSER_LOOPBACK_ADDRESS;
  }

  const hash = fnv1a32(`browser:${networkId}`);
  const secondOctet = 112 + (hash & 0x1f);
  const thirdOctet = (hash >>> 8) & 0xff;
  const fourthOctet = 1 + ((hash >>> 16) % 254);

  return `127.${secondOctet}.${thirdOctet}.${fourthOctet}`;
}

/**
 * Hidden per-network alias used only as the pf host-local redirect target
 * (127.144–175 band). macOS pf mangles replies for every connection to an
 * `rdr` target coordinate — direct dials hang in SYN_RCVD — so the target must
 * be an address nothing ever dials directly, separate from the browser alias.
 */
export function hostLocalGatewayLoopbackAddressForNetwork(networkId: string): string {
  if (isGlobalNetworkId(networkId)) {
    return GLOBAL_NETWORK_HOST_LOCAL_GATEWAY_ADDRESS;
  }

  const hash = fnv1a32(`host-local:${networkId}`);
  const secondOctet = 144 + (hash & 0x1f);
  const thirdOctet = (hash >>> 8) & 0xff;
  const fourthOctet = 1 + ((hash >>> 16) % 254);

  return `127.${secondOctet}.${thirdOctet}.${fourthOctet}`;
}

/**
 * Allocate identity before creating OS resources. Hashes give stable addresses,
 * but not uniqueness; a UUID which collides in any of the three address bands
 * must be retried before a listener, DNS row, or terminal can use it.
 */
export function allocateNetworkIdWithUniqueAddresses(
  existingIds: readonly string[],
  createCandidate: () => string,
): string {
  const ids = new Set(existingIds);
  const addresses = new Set(existingIds.flatMap(networkAddresses));

  for (let attempt = 0; attempt < 128; attempt++) {
    const candidate = createCandidate();
    if (candidate.length === 0 || isGlobalNetworkId(candidate) || ids.has(candidate)) {
      continue;
    }
    if (networkAddresses(candidate).every(address => !addresses.has(address))) {
      return candidate;
    }
  }

  throw new Error("Could not allocate a logical network with unique loopback addresses.");
}

/** Rejects an identity collision even for callers which do not use the allocator. */
export function assertNetworkAddressesAreUnique(networkId: string, existingIds: readonly string[]): void {
  const candidate = new Set(networkAddresses(networkId));
  const collision = existingIds.find(id => id !== networkId && networkAddresses(id).some(address => candidate.has(address)));
  if (collision !== undefined) {
    throw new Error(`Logical networks ${networkId} and ${collision} share a loopback address.`);
  }
}

/** All addresses participate: a browser or host gateway collision also mixes realms. */
function networkAddresses(networkId: string): string[] {
  return [
    loopbackAddressForNetwork(networkId),
    browserLoopbackAddressForNetwork(networkId),
    hostLocalGatewayLoopbackAddressForNetwork(networkId),
  ];
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

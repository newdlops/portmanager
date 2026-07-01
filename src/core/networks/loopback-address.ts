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
  const hash = fnv1a32(networkId);
  const secondOctet = 80 + (hash & 0x1f);
  const thirdOctet = (hash >>> 8) & 0xff;
  const fourthOctet = 1 + ((hash >>> 16) % 254);

  return `127.${secondOctet}.${thirdOctet}.${fourthOctet}`;
}

export function browserLoopbackAddressForNetwork(networkId: string): string {
  const hash = fnv1a32(`browser:${networkId}`);
  const secondOctet = 112 + (hash & 0x1f);
  const thirdOctet = (hash >>> 8) & 0xff;
  const fourthOctet = 1 + ((hash >>> 16) % 254);

  return `127.${secondOctet}.${thirdOctet}.${fourthOctet}`;
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

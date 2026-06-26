/**
 * Maps a logical network id to a stable loopback IPv4 address.
 *
 * The native hook can then keep the original TCP port and isolate networks by
 * binding each one to a different 127.x.x.x address. macOS requires that this
 * address first exists as a lo0 alias; Linux commonly routes 127/8 without it.
 */

import type { LoopbackAddressRoutingMode } from "../../shared/types";

export const NETWORK_LOOPBACK_HOST_ENV = "PORT_MANAGER_NETWORK_LOOPBACK_HOST";

export function isLoopbackAddressRoutingEnabled(settings: {
  readonly enableLoopbackAddressRouting?: boolean;
  readonly loopbackAddressRoutingMode?: LoopbackAddressRoutingMode;
}): boolean {
  return resolveLoopbackAddressRoutingMode(settings) !== "high-port";
}

export function resolveLoopbackAddressRoutingMode(settings: {
  readonly enableLoopbackAddressRouting?: boolean;
  readonly loopbackAddressRoutingMode?: LoopbackAddressRoutingMode;
}): LoopbackAddressRoutingMode {
  if (settings.loopbackAddressRoutingMode !== undefined) {
    return settings.loopbackAddressRoutingMode;
  }

  return settings.enableLoopbackAddressRouting === true ? "auto" : "high-port";
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

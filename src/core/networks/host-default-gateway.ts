import type { HostPortExposure, LogicalNetwork } from "../../shared/types";

/**
 * Selects the network endpoint that should satisfy hookless host-machine
 * localhost clients for one logical port.
 *
 * The data plane still lives in the extension/platform layers. This policy only
 * chooses a stable target and refuses candidates that would proxy back into the
 * same host localhost port.
 */

export interface HostDefaultGatewaySelectionOptions {
  /** User/window-selected network wins when it has a candidate for the port. */
  readonly preferredNetworkId?: string;
  /** Stable logical network order used when no explicit preference exists. */
  readonly networks?: readonly Pick<LogicalNetwork, "id" | "name">[];
}

export function selectHostDefaultGatewayExposure(
  exposures: readonly HostPortExposure[],
  options: HostDefaultGatewaySelectionOptions = {},
): HostPortExposure | undefined {
  const candidates = exposures.filter((exposure) => !isSelfLoopingLocalhostTarget(exposure));
  if (candidates.length === 0) {
    return undefined;
  }

  const sortedCandidates = sortHostDefaultGatewayCandidates(candidates, options.networks ?? []);
  if (options.preferredNetworkId !== undefined) {
    const preferred = sortedCandidates.find((exposure) => exposure.networkId === options.preferredNetworkId);
    if (preferred !== undefined) {
      return preferred;
    }
  }

  return sortedCandidates[0];
}

function sortHostDefaultGatewayCandidates(
  exposures: readonly HostPortExposure[],
  networks: readonly Pick<LogicalNetwork, "id" | "name">[],
): HostPortExposure[] {
  const networkOrder = new Map(networks.map((network, index) => [network.id, index]));
  const networkNameById = new Map(networks.map((network) => [network.id, network.name.toLowerCase()]));

  return [...exposures].sort((left, right) => {
    return (
      compareNumber(networkOrder.get(left.networkId) ?? Number.MAX_SAFE_INTEGER, networkOrder.get(right.networkId) ?? Number.MAX_SAFE_INTEGER) ||
      compareString(networkNameById.get(left.networkId) ?? "", networkNameById.get(right.networkId) ?? "") ||
      compareString(left.networkId, right.networkId) ||
      compareString(left.targetAddress, right.targetAddress) ||
      compareNumber(left.targetPort, right.targetPort) ||
      compareString(left.id, right.id)
    );
  });
}

function isSelfLoopingLocalhostTarget(exposure: HostPortExposure): boolean {
  return exposure.targetPort === exposure.hostPort && isHostLocalAddress(exposure.targetAddress);
}

function isHostLocalAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)]$/, "$1");
  return (
    normalized.length === 0 ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "::"
  );
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

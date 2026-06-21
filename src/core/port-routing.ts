import type {
  PortAvailability,
  PortAvailabilityProvider,
  PortRoutingDecision,
  PortRoutingRequest,
  ScanDirection,
} from "../shared/types";

/**
 * Core port-routing policy for managed processes.
 *
 * The service owns only the decision mechanism: it builds nearby candidate
 * ports from the request, asks a provider whether each port is usable, and
 * returns the first valid routing decision. Socket probing and OS commands stay
 * behind PortAvailabilityProvider implementations in the platform layer.
 */

const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65_535;

/**
 * Error raised when the routing policy cannot produce a usable actual port.
 * Keeping a domain-specific error type gives command handlers a stable way to
 * distinguish routing failures from lower-level provider failures.
 */
export class PortRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortRoutingError";
  }
}

/**
 * Chooses the actual port for a managed process while preserving the requested
 * logical port. The requested port is always checked first; nearby candidates
 * are only scanned after the requested port is unavailable.
 */
export class PortRoutingService {
  /**
   * The provider is the only low-level dependency. It may use sockets, lsof, or
   * other platform mechanisms, while this class remains pure domain policy.
   */
  constructor(private readonly availabilityProvider: PortAvailabilityProvider) {}

  /**
   * Resolves a requested port to the actual port that should be injected into a
   * process launch. Candidate checks stop as soon as the closest allowed port is
   * available so callers can expose the checked sequence in diagnostics.
   */
  async route(request: PortRoutingRequest): Promise<PortRoutingDecision> {
    this.validateRequest(request);

    const requestedPortStatus = await this.availabilityProvider.check(
      request.requestedPort,
      request.host,
    );

    if (requestedPortStatus.available) {
      return {
        requestedPort: request.requestedPort,
        actualPort: request.requestedPort,
        routed: false,
        requestedPortStatus,
        checkedCandidates: [],
      };
    }

    const checkedCandidates: PortAvailability[] = [];

    for (const candidatePort of buildCandidatePorts(
      request.requestedPort,
      request.scanRange,
      request.scanDirection,
    )) {
      const candidateStatus = await this.availabilityProvider.check(candidatePort, request.host);
      checkedCandidates.push(candidateStatus);

      if (candidateStatus.available) {
        return {
          requestedPort: request.requestedPort,
          actualPort: candidateStatus.port,
          routed: true,
          requestedPortStatus,
          checkedCandidates,
        };
      }
    }

    throw new PortRoutingError(
      `No available port found near requested port ${request.requestedPort} ` +
        `using direction "${request.scanDirection}" and scan range ${request.scanRange}.`,
    );
  }

  /**
   * Validates inputs at the domain boundary so platform adapters can assume
   * they receive real TCP port numbers and a finite search range.
   */
  private validateRequest(request: PortRoutingRequest): void {
    if (!isValidPort(request.requestedPort)) {
      throw new PortRoutingError(
        `Requested port ${request.requestedPort} is outside the TCP port range ${MIN_TCP_PORT}-${MAX_TCP_PORT}.`,
      );
    }

    if (!Number.isInteger(request.scanRange) || request.scanRange < 0) {
      throw new PortRoutingError(`Scan range must be a non-negative integer; received ${request.scanRange}.`);
    }
  }
}

/**
 * Builds the deterministic nearby-port sequence for a scan policy.
 * "both" alternates upward then downward for each distance so the service keeps
 * the closest match while preferring the common upward development-server path
 * when both sides are equally close.
 */
export function buildCandidatePorts(
  requestedPort: number,
  scanRange: number,
  scanDirection: ScanDirection,
): readonly number[] {
  const candidates: number[] = [];

  for (let offset = 1; offset <= scanRange; offset += 1) {
    if (scanDirection === "up" || scanDirection === "both") {
      pushIfValidPort(candidates, requestedPort + offset);
    }

    if (scanDirection === "down" || scanDirection === "both") {
      pushIfValidPort(candidates, requestedPort - offset);
    }
  }

  return candidates;
}

/**
 * Keeps candidate generation from passing invalid TCP ports into lower-level
 * scanners. This is especially relevant for downward scans near port 1.
 */
function pushIfValidPort(candidates: number[], port: number): void {
  if (isValidPort(port)) {
    candidates.push(port);
  }
}

/**
 * Centralizes TCP port validation so request checks and candidate pruning use
 * the same boundary rules.
 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_TCP_PORT && port <= MAX_TCP_PORT;
}

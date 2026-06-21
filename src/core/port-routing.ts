import type {
  PortAvailability,
  PortAvailabilityProvider,
  PortRoutingDecision,
  PortRoutingMode,
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
const DEFAULT_ROUTING_MODE: PortRoutingMode = "nearest";
const DEFAULT_VIRTUAL_PORT_RANGE_START = 53_000;
const DEFAULT_VIRTUAL_PORT_RANGE_END = 59_999;

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
    const routingMode = request.routingMode ?? DEFAULT_ROUTING_MODE;

    if (routingMode === "hashed") {
      return this.routeHashed(request, requestedPortStatus);
    }

    if (requestedPortStatus.available) {
      return {
        requestedPort: request.requestedPort,
        actualPort: request.requestedPort,
        routed: false,
        requestedPortStatus,
        checkedCandidates: [],
        routingMode,
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
          routingMode,
        };
      }
    }

    throw new PortRoutingError(
      `No available port found near requested port ${request.requestedPort} ` +
        `using direction "${request.scanDirection}" and scan range ${request.scanRange}.`,
    );
  }

  /**
   * Routes a logical port into the configured virtual range even when the
   * requested port is free, keeping logical ports unoccupied by managed apps.
   */
  private async routeHashed(
    request: PortRoutingRequest,
    requestedPortStatus: PortAvailability,
  ): Promise<PortRoutingDecision> {
    const checkedCandidates: PortAvailability[] = [];

    for (const candidatePort of buildHashedPortCandidates({
      requestedPort: request.requestedPort,
      routeScope: request.routeScope ?? request.host,
      scanRange: request.scanRange,
      virtualPortRangeStart: request.virtualPortRangeStart ?? DEFAULT_VIRTUAL_PORT_RANGE_START,
      virtualPortRangeEnd: request.virtualPortRangeEnd ?? DEFAULT_VIRTUAL_PORT_RANGE_END,
    })) {
      const candidateStatus = await this.availabilityProvider.check(candidatePort, request.host);
      checkedCandidates.push(candidateStatus);

      if (candidateStatus.available) {
        return {
          requestedPort: request.requestedPort,
          actualPort: candidateStatus.port,
          routed: candidateStatus.port !== request.requestedPort,
          requestedPortStatus,
          checkedCandidates,
          routingMode: "hashed",
        };
      }
    }

    throw new PortRoutingError(
      `No available hashed port found for logical port ${request.requestedPort} ` +
        `in virtual range ${request.virtualPortRangeStart ?? DEFAULT_VIRTUAL_PORT_RANGE_START}-` +
        `${request.virtualPortRangeEnd ?? DEFAULT_VIRTUAL_PORT_RANGE_END}.`,
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

    if ((request.routingMode ?? DEFAULT_ROUTING_MODE) === "hashed") {
      validateVirtualPortRange(
        request.virtualPortRangeStart ?? DEFAULT_VIRTUAL_PORT_RANGE_START,
        request.virtualPortRangeEnd ?? DEFAULT_VIRTUAL_PORT_RANGE_END,
      );
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

export interface HashedPortCandidateRequest {
  /** Logical port used as part of the deterministic hash input. */
  readonly requestedPort: number;
  /** Namespace that keeps duplicate projects from hashing to the same slot. */
  readonly routeScope: string;
  /** Maximum number of linear-probe candidates after the hashed slot. */
  readonly scanRange: number;
  /** First TCP port in the virtual actual-port range. */
  readonly virtualPortRangeStart: number;
  /** Last TCP port in the virtual actual-port range. */
  readonly virtualPortRangeEnd: number;
}

/**
 * Builds deterministic actual-port candidates inside a virtual range.
 * The first slot is a stable hash of route scope and logical port; subsequent
 * candidates linearly probe the range to resolve collisions without falling
 * back to the logical port itself.
 */
export function buildHashedPortCandidates(request: HashedPortCandidateRequest): readonly number[] {
  validateVirtualPortRange(request.virtualPortRangeStart, request.virtualPortRangeEnd);

  if (!Number.isInteger(request.scanRange) || request.scanRange < 0) {
    throw new PortRoutingError(`Scan range must be a non-negative integer; received ${request.scanRange}.`);
  }

  const rangeSize = request.virtualPortRangeEnd - request.virtualPortRangeStart + 1;
  const maxCandidates = Math.min(rangeSize, request.scanRange + 1);
  const startOffset = hashText(`${request.routeScope}:${request.requestedPort}`) % rangeSize;
  const candidates: number[] = [];

  for (let offset = 0; offset < maxCandidates; offset += 1) {
    candidates.push(request.virtualPortRangeStart + ((startOffset + offset) % rangeSize));
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

/** Validates the dedicated actual-port pool used by hashed routing. */
function validateVirtualPortRange(start: number, end: number): void {
  if (!isValidPort(start) || !isValidPort(end) || start > end) {
    throw new PortRoutingError(`Invalid virtual port range ${start}-${end}.`);
  }
}

/** Small FNV-1a hash for stable cross-platform route-slot selection. */
function hashText(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash;
}

/**
 * One extension host budgets every proxy owner and its native children together.
 * Native processes reserve their possible usage before spawn; Node adapters
 * return leases on actual completion. This policy knows no sockets or timers.
 */
export const DEFAULT_PROXY_RESOURCE_LIMITS = {
  listeners: 256,
  connections: 1024,
  upstreams: 1024,
  nativeHelpers: 8,
  dnsJobs: 32,
  routeJobs: 64,
  httpRequests: 256,
  queuedHttpRequests: 256,
  idleSockets: 64,
  controlBytes: 512 * 1024,
} as const;

export type ProxyResource = keyof typeof DEFAULT_PROXY_RESOURCE_LIMITS;
export type ProxyResourceLimits = Readonly<Record<ProxyResource, number>>;
export type ProxyResourceDemand = Partial<ProxyResourceLimits>;

/** A lease may be returned more than once by racing error/close callbacks. */
export interface ProxyResourceLease {
  release(): void;
}

/** Resource exhaustion is overload, never evidence for a different route. */
export class ProxyResourceLimitError extends Error {
  readonly code = "EPMRESOURCE";
  constructor(readonly resource: ProxyResource) {
    super(`Proxy resource budget exhausted: ${resource}.`);
    this.name = "ProxyResourceLimitError";
  }
}

export class ProxyResourceBudget {
  readonly limits: ProxyResourceLimits;
  /** Counts include conservative native reservations, even while idle. */
  private readonly occupied: Record<ProxyResource, number>;

  constructor(limits: ProxyResourceDemand = {}) {
    const effective = { ...DEFAULT_PROXY_RESOURCE_LIMITS } as Record<ProxyResource, number>;
    for (const resource of Object.keys(effective) as ProxyResource[]) {
      const value = limits[resource];
      if (value !== undefined) {
        const maximum = resource === "controlBytes" ? 16 * 1024 * 1024 : 65536;
        if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
          throw new RangeError(`Invalid proxy resource limit: ${resource}.`);
        }
        effective[resource] = value;
      }
    }
    this.limits = Object.freeze(effective);
    this.occupied = Object.fromEntries(Object.keys(effective).map(resource => [resource, 0])) as Record<ProxyResource, number>;
  }

  /** All dimensions are checked before changing any count; partial admission cannot leak. */
  acquire(demand: ProxyResourceDemand): ProxyResourceLease {
    const lease = this.tryAcquire(demand);
    if (lease !== undefined) return lease;
    const resource = (Object.keys(demand) as ProxyResource[]).find(key => demand[key]! > this.limits[key] - this.occupied[key])!;
    throw new ProxyResourceLimitError(resource);
  }

  /** Hot accept paths reject bursts without allocating an Error/stack per socket. */
  tryAcquire(demand: ProxyResourceDemand): ProxyResourceLease | undefined {
    const amounts = Object.entries(demand) as [ProxyResource, number][];
    for (const [resource, amount] of amounts) {
      if (!Number.isSafeInteger(amount) || amount < 0 || !Object.hasOwn(this.occupied, resource)) {
        throw new RangeError(`Invalid proxy resource demand: ${resource}.`);
      }
      if (amount > this.limits[resource] - this.occupied[resource]) return undefined;
    }
    for (const [resource, amount] of amounts) this.occupied[resource] += amount;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      for (const [resource, amount] of amounts) this.occupied[resource] -= amount;
    } };
  }

  /** Inspection copies never expose mutable bookkeeping to callers. */
  get used(): ProxyResourceLimits { return { ...this.occupied }; }
}

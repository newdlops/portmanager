/**
 * Decides whether browser DNS needs an administrator-privileged rewrite.
 *
 * Every alias maps a network hostname to a loopback address derived from the
 * network id, so the address only moves when the mapping itself changes (a new
 * or renamed network) or macOS drops the lo0 alias (reboot). The privileged
 * setup script rewrites root-owned state: lo0 aliases, `/etc/resolver`, the
 * owned `/etc/hosts` block, and the dev TLS material. This policy compares that
 * state, observed freshly by the platform layer, with the expected mapping and
 * reports only genuine drift.
 *
 * Deliberately NOT drift, because none of them is fixed by a root rewrite:
 * - Keychain trust (`checking`/`untrusted`): lives in the user's login keychain.
 * - A certificate inside its renewal window but still valid.
 * - An lo0 probe that failed: unknown is not missing.
 * - Daemon DNS table, resolver answers, or proxy listeners: user-owned layers.
 *
 * This module is pure so the escalation rule stays testable without macOS.
 */

/** Freshly observed root-owned state for one browser alias. */
export interface BrowserDnsAliasObservation {
  readonly hostname: string;
  /** Loopback address the alias must resolve to; stable for the network's lifetime. */
  readonly expectedAddress: string;
  /**
   * lo0 addresses from a fresh `ifconfig lo0`. `undefined` means the probe
   * failed, which must never be read as "every alias is missing".
   */
  readonly loopbackAliases: ReadonlySet<string> | undefined;
  /** `/etc/resolver` entries for the hostname and the secure suffix target the Port Manager DNS port. */
  readonly resolverConfigured: boolean;
  /** Addresses of every `/etc/hosts` row that lists this hostname. */
  readonly hostsAddresses: readonly string[];
  /** Addresses of rows inside the Port Manager-owned hosts block for this hostname. */
  readonly ownedHostsAddresses: readonly string[];
  /** Dev TLS leaf material; only root can reissue it. */
  readonly tls: {
    /** Certificate, key, and hostname marker are installed and readable. */
    readonly available: boolean;
    readonly coversHostname: boolean;
    readonly expired: boolean;
  };
}

export type BrowserDnsDriftReason =
  | {
      /** The owned hosts block still maps the hostname to a previous address. */
      readonly kind: "addressChanged";
      readonly hostname: string;
      readonly previousAddresses: readonly string[];
      readonly address: string;
    }
  | { readonly kind: "hostsEntryMissing"; readonly hostname: string; readonly address: string }
  | { readonly kind: "resolverMissing"; readonly hostname: string }
  | { readonly kind: "loopbackAliasMissing"; readonly hostname: string; readonly address: string }
  | { readonly kind: "tlsMaterialMissing" }
  | { readonly kind: "tlsHostnameUncovered"; readonly hostname: string }
  | { readonly kind: "tlsExpired" };

/** Lists every piece of root-owned state that disagrees with the alias mapping; empty means no escalation. */
export function detectBrowserDnsDrift(
  observations: readonly BrowserDnsAliasObservation[],
): readonly BrowserDnsDriftReason[] {
  const reasons: BrowserDnsDriftReason[] = [];
  // TLS material is one shared leaf, so its global states are reported once.
  let tlsMaterialReported = false;

  for (const observation of observations) {
    const { hostname, expectedAddress: address } = observation;
    const previousAddresses = [...new Set(observation.ownedHostsAddresses.filter((entry) => entry !== address))];

    if (previousAddresses.length > 0) {
      reasons.push({ kind: "addressChanged", hostname, previousAddresses, address });
    } else if (!observation.hostsAddresses.includes(address)) {
      reasons.push({ kind: "hostsEntryMissing", hostname, address });
    }
    if (!observation.resolverConfigured) {
      reasons.push({ kind: "resolverMissing", hostname });
    }
    if (observation.loopbackAliases !== undefined && !observation.loopbackAliases.has(address)) {
      reasons.push({ kind: "loopbackAliasMissing", hostname, address });
    }

    if (!observation.tls.available) {
      if (!tlsMaterialReported) {
        reasons.push({ kind: "tlsMaterialMissing" });
        tlsMaterialReported = true;
      }
    } else if (observation.tls.expired) {
      if (!tlsMaterialReported) {
        reasons.push({ kind: "tlsExpired" });
        tlsMaterialReported = true;
      }
    } else if (!observation.tls.coversHostname) {
      reasons.push({ kind: "tlsHostnameUncovered", hostname });
    }
  }

  return reasons;
}

/**
 * One clause for the administrator prompt and the dev log, naming what moved
 * (`browser alias "alpha" moved from 127.9.9.9 to 127.1.2.3`). Returns
 * `undefined` when there is no drift. The first three reasons are spelled out
 * so the macOS prompt stays readable.
 */
export function describeBrowserDnsDrift(reasons: readonly BrowserDnsDriftReason[]): string | undefined {
  if (reasons.length === 0) {
    return undefined;
  }

  const clauses = reasons.slice(0, 3).map(describeReason);
  const remaining = reasons.length - clauses.length;
  return remaining > 0 ? `${clauses.join(", ")} and ${remaining} more change${remaining === 1 ? "" : "s"}` : clauses.join(", ");
}

function describeReason(reason: BrowserDnsDriftReason): string {
  switch (reason.kind) {
    case "addressChanged":
      return `browser alias "${reason.hostname}" moved from ${reason.previousAddresses.join("/")} to ${reason.address}`;
    case "hostsEntryMissing":
      return `browser alias "${reason.hostname}" (${reason.address}) is missing from /etc/hosts`;
    case "resolverMissing":
      return `the macOS resolver for "${reason.hostname}" is missing`;
    case "loopbackAliasMissing":
      return `loopback alias ${reason.address} for "${reason.hostname}" is missing from lo0`;
    case "tlsMaterialMissing":
      return "the dev TLS certificate is not installed";
    case "tlsHostnameUncovered":
      return `the dev TLS certificate does not cover "${reason.hostname}"`;
    case "tlsExpired":
      return "the dev TLS certificate expired";
  }
}

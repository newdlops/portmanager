import assert from "node:assert/strict";
import test from "node:test";
import {
  describeBrowserDnsDrift,
  detectBrowserDnsDrift,
  type BrowserDnsAliasObservation,
} from "../../src/core/networks/browser-dns-drift";

/** A fully current alias: every root-owned piece matches the expected address. */
function currentAlias(overrides: Partial<BrowserDnsAliasObservation> = {}): BrowserDnsAliasObservation {
  return {
    hostname: "alpha",
    expectedAddress: "127.120.1.2",
    loopbackAliases: new Set(["127.0.0.1", "127.120.1.2"]),
    resolverConfigured: true,
    hostsAddresses: ["127.120.1.2"],
    ownedHostsAddresses: ["127.120.1.2"],
    tls: { available: true, coversHostname: true, expired: false },
    ...overrides,
  };
}

test("an unchanged alias mapping never asks for administrator privileges", () => {
  // Keychain trust (`checking` after its cache lapses) and the certificate's
  // renewal window are not inputs at all: neither is fixed by a root rewrite.
  assert.deepEqual(detectBrowserDnsDrift([currentAlias(), currentAlias({ hostname: "beta", expectedAddress: "127.121.3.4", loopbackAliases: new Set(["127.120.1.2", "127.121.3.4"]), hostsAddresses: ["127.121.3.4"], ownedHostsAddresses: ["127.121.3.4"] })]), []);
  assert.equal(describeBrowserDnsDrift([]), undefined);
});

test("a failed lo0 probe is unknown, not a missing alias", () => {
  assert.deepEqual(detectBrowserDnsDrift([currentAlias({ loopbackAliases: undefined })]), []);
});

test("hosts still mapping the alias to its previous address is the address-changed case", () => {
  const drift = detectBrowserDnsDrift([
    currentAlias({ hostsAddresses: ["127.99.9.9"], ownedHostsAddresses: ["127.99.9.9"] }),
  ]);

  assert.deepEqual(drift, [
    { kind: "addressChanged", hostname: "alpha", previousAddresses: ["127.99.9.9"], address: "127.120.1.2" },
  ]);
  assert.equal(describeBrowserDnsDrift(drift), 'browser alias "alpha" moved from 127.99.9.9 to 127.120.1.2');
});

test("a stale owned row is drift even when another hosts line has the right address", () => {
  assert.deepEqual(
    detectBrowserDnsDrift([
      currentAlias({ hostsAddresses: ["127.120.1.2", "127.99.9.9"], ownedHostsAddresses: ["127.99.9.9"] }),
    ]).map((reason) => reason.kind),
    ["addressChanged"],
  );
});

test("root-owned pieces that are truly absent are drift", () => {
  const drift = detectBrowserDnsDrift([
    currentAlias({
      loopbackAliases: new Set(["127.0.0.1"]),
      resolverConfigured: false,
      hostsAddresses: [],
      ownedHostsAddresses: [],
      tls: { available: true, coversHostname: false, expired: false },
    }),
  ]);

  assert.deepEqual(
    drift.map((reason) => reason.kind),
    ["hostsEntryMissing", "resolverMissing", "loopbackAliasMissing", "tlsHostnameUncovered"],
  );
  assert.equal(
    describeBrowserDnsDrift(drift),
    'browser alias "alpha" (127.120.1.2) is missing from /etc/hosts, the macOS resolver for "alpha" is missing, loopback alias 127.120.1.2 for "alpha" is missing from lo0 and 1 more change',
  );
});

test("shared TLS material problems are reported once, and expiry outranks coverage", () => {
  const missing = { available: false, coversHostname: false, expired: false };
  assert.deepEqual(
    detectBrowserDnsDrift([currentAlias({ tls: missing }), currentAlias({ hostname: "beta", tls: missing })]).map(
      (reason) => reason.kind,
    ),
    ["tlsMaterialMissing"],
  );

  const expired = { available: true, coversHostname: false, expired: true };
  assert.deepEqual(
    detectBrowserDnsDrift([currentAlias({ tls: expired }), currentAlias({ hostname: "beta", tls: expired })]).map(
      (reason) => reason.kind,
    ),
    ["tlsExpired"],
  );
});

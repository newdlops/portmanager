import assert from "node:assert/strict";
import test from "node:test";

import { verifyBrowserDnsAliasesResolve } from "../../src/platform/network/browser-dns-verifier";

const record = {
  hostname: "feature-a",
  secureHostname: "feature-a.pm",
  address: "127.93.10.7",
};

test("browser DNS verification checks both public names through the OS lookup adapter", async () => {
  const checked: string[] = [];
  await verifyBrowserDnsAliasesResolve([record], {
    lookupIpv4: async (hostname) => {
      checked.push(hostname);
      return [record.address, record.address];
    },
  });

  assert.deepEqual(checked.sort(), [record.hostname, record.secureHostname].sort());
});

test("browser DNS verification rejects stale or ambiguous resolver answers", async () => {
  await assert.rejects(
    verifyBrowserDnsAliasesResolve([record], {
      lookupIpv4: async (hostname) =>
        hostname === record.hostname ? [record.address] : [record.address, "127.93.10.8"],
      settleTimeoutMs: 0,
    }),
    /resolved Port Manager alias feature-a\.pm.*expected only 127\.93\.10\.7/,
  );
});

test("browser DNS verification reports failed and stalled system lookups", async () => {
  await assert.rejects(
    verifyBrowserDnsAliasesResolve([record], {
      lookupIpv4: async () => {
        throw new Error("resolver unavailable");
      },
      settleTimeoutMs: 0,
    }),
    /macOS cannot resolve Port Manager alias/,
  );

  await assert.rejects(
    verifyBrowserDnsAliasesResolve([record], {
      lookupIpv4: async () => new Promise<readonly string[]>((resolve) => setTimeout(() => resolve([]), 50)),
      settleTimeoutMs: 3,
      singleLookupTimeoutMs: 1,
      retryIntervalMs: 1,
    }),
    /macOS cannot resolve Port Manager alias/,
  );
});

test("browser DNS verification tolerates bounded post-flush resolver propagation", async () => {
  const attempts = new Map<string, number>();
  await verifyBrowserDnsAliasesResolve([record], {
    lookupIpv4: async (hostname) => {
      const count = (attempts.get(hostname) ?? 0) + 1;
      attempts.set(hostname, count);
      if (count === 1) {
        throw new Error("cache has not refreshed yet");
      }
      return [record.address];
    },
    settleTimeoutMs: 50,
    singleLookupTimeoutMs: 10,
    retryIntervalMs: 1,
  });

  assert.equal(attempts.get(record.hostname), 2);
  assert.equal(attempts.get(record.secureHostname), 2);
});

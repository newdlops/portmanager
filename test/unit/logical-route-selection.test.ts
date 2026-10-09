import assert from "node:assert/strict";
import test from "node:test";

import { GuardedRoutePolicyCache, selectNonNetworkOwnerRoute } from "../../src/core/networks/logical-route-selection";
import type { LogicalPortRoute } from "../../src/shared/types";

test("guarded route refresh keeps unchanged numeric authority available during unrelated events", () => {
  const cache = new GuardedRoutePolicyCache();
  const input = { port: 4567, targetHost: "127.0.0.1", targetPort: 54001 };
  const first = cache.capture("a", [input], () => true);
  assert.deepEqual(cache.currentRoutes(first), [input]);
  const same = cache.capture("a", [{ ...input }], () => true);
  assert.equal(same, first);
  assert.deepEqual(cache.currentRoutes(same), [input]);
});

test("guarded route revocation is immediate and an older resolution cannot restore it", () => {
  const cache = new GuardedRoutePolicyCache();
  const input = { port: 4567, targetHost: "backend.test", targetPort: 54001 };
  const old = cache.capture("a", [input], () => false);
  const resolved = [{ ...input, targetHost: "127.0.0.1" }];
  assert.equal(cache.publish(old, resolved), true);
  const removed = cache.capture("a", [], () => false);
  assert.deepEqual(cache.currentRoutes(removed), []);
  assert.equal(cache.publish(old, resolved), false);
  const readded = cache.capture("a", [input], () => false);
  assert.equal(cache.publish(old, resolved), false, "a later regrant must not revive an old resolver token");
  assert.deepEqual(cache.currentRoutes(readded), []);
});

test("guarded route changes revoke the previous endpoint while retaining other authorized routes", () => {
  const cache = new GuardedRoutePolicyCache();
  const inputs = [
    { port: 4567, targetHost: "backend.test", targetPort: 54001 },
    { port: 7890, targetHost: "127.0.0.1", targetPort: 54002 },
  ];
  const old = cache.capture("a", inputs, host => host.startsWith("127."));
  const resolved = [{ ...inputs[0], targetHost: "127.0.0.2" }, inputs[1]];
  assert.equal(cache.publish(old, resolved), true);
  const changed = cache.capture("a", [{ ...inputs[0], targetPort: 54003 }, inputs[1]], host => host.startsWith("127."));
  assert.deepEqual(cache.currentRoutes(changed), [inputs[1]]);
  assert.equal(cache.publish(old, resolved), false);
  assert.equal(cache.publish(changed, [{ ...inputs[0], targetPort: 54003, targetHost: "127.0.0.2" },
    { ...inputs[1], targetHost: "127.0.0.2" }]), false, "literal authority cannot be redirected by a resolver reply");
  assert.equal(cache.publish(changed, [{ ...inputs[0], targetHost: "127.0.0.2" }, inputs[1]]), false,
    "the new policy cannot publish an endpoint with its old target port");
});

test("guarded policies remain network-scoped and disposal invalidates pending publications", () => {
  const cache = new GuardedRoutePolicyCache();
  const a = { port: 4567, targetHost: "127.0.0.1", targetPort: 54001 };
  const b = { ...a, targetHost: "127.0.0.2", targetPort: 54002 };
  const first = cache.capture("a", [a], () => true);
  const second = cache.capture("b", [b], () => true);
  assert.deepEqual(cache.currentRoutes(first), [a]);
  assert.deepEqual(cache.currentRoutes(second), [b]);
  cache.clear();
  assert.equal(cache.publish(first, [a]), false);
  assert.deepEqual(cache.currentRoutes(second), []);
});

/**
 * Coverage for the non-network owner selection used by the logical port
 * gateway's passthrough path. The gateway must forward an unattributed client
 * only to a relocated network-less server, and refuse when the owner is
 * missing or ambiguous rather than leak an unrelated network's port.
 */

function route(overrides: Partial<LogicalPortRoute>): LogicalPortRoute {
  return {
    logicalPort: 3004,
    actualPort: 53004,
    host: "127.0.0.1",
    status: "running",
    source: "hooked",
    routeDirection: "listen",
    ...overrides,
  };
}

test("selects the single network-less relocated owner for a port", () => {
  const routes = [
    route({ logicalPort: 3004, actualPort: 53004, networkId: undefined }),
    route({ logicalPort: 3004, actualPort: 8004, networkId: "network-a" }),
  ];

  const owner = selectNonNetworkOwnerRoute(routes, 3004, undefined);

  assert.equal(owner?.actualPort, 53004);
});

test("refuses when only a networked route exists for the port", () => {
  const routes = [route({ logicalPort: 3004, actualPort: 8004, networkId: "network-a" })];

  assert.equal(selectNonNetworkOwnerRoute(routes, 3004, undefined), undefined);
});

test("refuses ambiguous non-network owners without a client cwd", () => {
  const routes = [
    route({ logicalPort: 3004, actualPort: 53004, networkId: undefined, cwd: "/work/one" }),
    route({ logicalPort: 3004, actualPort: 53005, networkId: undefined, cwd: "/work/two" }),
  ];

  assert.equal(selectNonNetworkOwnerRoute(routes, 3004, undefined), undefined);
});

test("disambiguates sibling non-network owners by client cwd", () => {
  const routes = [
    route({ logicalPort: 3004, actualPort: 53004, networkId: undefined, cwd: "/work/one" }),
    route({ logicalPort: 3004, actualPort: 53005, networkId: undefined, cwd: "/work/two" }),
  ];

  const owner = selectNonNetworkOwnerRoute(routes, 3004, "/work/two/src");

  assert.equal(owner?.actualPort, 53005);
});

test("ignores stopped and sender-reservation rows", () => {
  const routes = [
    route({ logicalPort: 3004, actualPort: 53004, networkId: undefined, status: "stopped" }),
    route({ logicalPort: 3004, actualPort: 53005, networkId: undefined, routeDirection: "send" }),
  ];

  assert.equal(selectNonNetworkOwnerRoute(routes, 3004, undefined), undefined);
});

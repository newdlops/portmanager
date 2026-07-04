import assert from "node:assert/strict";
import test from "node:test";

import { selectNonNetworkOwnerRoute } from "../../src/core/networks/logical-route-selection";
import type { LogicalPortRoute } from "../../src/shared/types";

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

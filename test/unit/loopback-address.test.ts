import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTUAL_LOOPBACK_HOST_ENV,
  browserLoopbackAddressForNetwork,
  isLoopbackAddressRoutingEnabled,
  loopbackAddressForNetwork,
  NETWORK_LOOPBACK_HOST_ENV,
  resolveLoopbackAddressRoutingMode,
  resolveTerminalLoopbackAddressRoutingMode,
  shouldExposeNetworkLoopbackHost,
  usesLoopbackAddressOnlyRouting,
} from "../../src/core/networks/loopback-address";

test("loopback address routing maps network ids to stable non-default loopback hosts", () => {
  const first = loopbackAddressForNetwork("network-a");
  const second = loopbackAddressForNetwork("network-a");
  const other = loopbackAddressForNetwork("network-b");

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^127\.(8[0-9]|9[0-9]|10[0-9]|11[01])\.\d{1,3}\.\d{1,3}$/);
  assert.notEqual(first, "127.0.0.1");
});

test("browser loopback addresses are stable and separate from app bind addresses", () => {
  const appAddress = loopbackAddressForNetwork("network-a");
  const browserAddress = browserLoopbackAddressForNetwork("network-a");

  assert.equal(browserAddress, browserLoopbackAddressForNetwork("network-a"));
  assert.notEqual(browserAddress, appAddress);
  assert.match(browserAddress, /^127\.(11[2-9]|12[0-9]|13[0-9]|14[0-3])\.\d{1,3}\.\d{1,3}$/);
});

test("loopback address routing mode keeps high-port as the default actual-port policy", () => {
  assert.equal(ACTUAL_LOOPBACK_HOST_ENV, "PORT_MANAGER_ACTUAL_LOOPBACK_HOST");
  assert.equal(NETWORK_LOOPBACK_HOST_ENV, "PORT_MANAGER_NETWORK_LOOPBACK_HOST");
  assert.equal(isLoopbackAddressRoutingEnabled({}), false);
  assert.equal(resolveLoopbackAddressRoutingMode({}), "high-port");
  assert.equal(isLoopbackAddressRoutingEnabled({ enableLoopbackAddressRouting: true }), true);
  assert.equal(resolveLoopbackAddressRoutingMode({ enableLoopbackAddressRouting: true }), "auto");
  assert.equal(isLoopbackAddressRoutingEnabled({ enableLoopbackAddressRouting: false }), false);
  assert.equal(resolveLoopbackAddressRoutingMode({ enableLoopbackAddressRouting: false }), "high-port");
  assert.equal(resolveLoopbackAddressRoutingMode({ loopbackAddressRoutingMode: "loopback" }), "loopback");
  assert.equal(usesLoopbackAddressOnlyRouting({ experimentalRouteOwnershipMode: "loopback-address-only" }), true);
  assert.equal(shouldExposeNetworkLoopbackHost({ experimentalRouteOwnershipMode: "loopback-address-only" }), true);
  assert.equal(resolveTerminalLoopbackAddressRoutingMode({ experimentalRouteOwnershipMode: "loopback-address-only" }), "loopback");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  isLoopbackAddressRoutingEnabled,
  loopbackAddressForNetwork,
  NETWORK_LOOPBACK_HOST_ENV,
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

test("loopback address routing remains enabled for legacy settings", () => {
  assert.equal(NETWORK_LOOPBACK_HOST_ENV, "PORT_MANAGER_NETWORK_LOOPBACK_HOST");
  assert.equal(isLoopbackAddressRoutingEnabled({}), true);
  assert.equal(isLoopbackAddressRoutingEnabled({ enableLoopbackAddressRouting: true }), true);
  assert.equal(isLoopbackAddressRoutingEnabled({ enableLoopbackAddressRouting: false }), false);
});

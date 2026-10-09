import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import {
  ACTUAL_LOOPBACK_HOST_ENV,
  allocateNetworkIdWithUniqueAddresses,
  assertNetworkAddressesAreUnique,
  browserLoopbackAddressForNetwork,
  GLOBAL_LOGICAL_NETWORK_ID,
  hostLocalGatewayLoopbackAddressForNetwork,
  isGlobalNetworkId,
  isLoopbackAddressRoutingEnabled,
  loopbackAddressForNetwork,
  NETWORK_IS_GLOBAL_ENV,
  NETWORK_LOOPBACK_HOST_ENV,
  resolveLoopbackAddressRoutingMode,
  resolveTerminalLoopbackAddressRoutingMode,
  shouldExposeNetworkLoopbackHost,
  usesLoopbackAddressOnlyRouting,
} from "../../src/core/networks/loopback-address";
import { DEFAULT_PORT_MANAGER_SETTINGS } from "../../src/shared/default-settings";

/** Actual UUID-shaped ids from the bounded isolation audit, not a mocked hash. */
const COLLIDING_NETWORK_IDS = [
  "network-00000000-0000-4000-8000-00000000130b",
  "network-00000000-0000-4000-8000-0000000016a8",
] as const;

for (const [band, address, first, second] of [
  ["browser", browserLoopbackAddressForNetwork, "network-00000000-0000-4000-8000-000000000f81", "network-00000000-0000-4000-8000-000000001130"],
  ["host gateway", hostLocalGatewayLoopbackAddressForNetwork, "network-00000000-0000-4000-8000-00000000000b", "network-00000000-0000-4000-8000-0000000005a8"],
] as const) {
  test(`network allocation rejects an actual ${band} address collision`, () => {
    assert.equal(address(first), address(second));
    assert.notEqual(loopbackAddressForNetwork(first), loopbackAddressForNetwork(second));
    assert.throws(() => assertNetworkAddressesAreUnique(second, [first]), /share a loopback address/);
    let attempts = 0;
    const candidates = [second, "network-unique-audit"];
    assert.equal(allocateNetworkIdWithUniqueAddresses([first], () => candidates[attempts++]), "network-unique-audit");
    assert.equal(attempts, 2);
  });
}

test("network identity allocation retries actual loopback collisions before resource creation", () => {
  const [existing, collision] = COLLIDING_NETWORK_IDS;
  assert.equal(loopbackAddressForNetwork(existing), loopbackAddressForNetwork(collision));
  const candidates = [collision, existing, GLOBAL_LOGICAL_NETWORK_ID, "network-unique-audit"];
  let attempts = 0;
  const id = allocateNetworkIdWithUniqueAddresses([existing], () => candidates[attempts++]);
  assert.equal(id, "network-unique-audit");
  assert.equal(attempts, 4);
  assert.doesNotThrow(() => assertNetworkAddressesAreUnique(id, [existing]));
  assert.throws(() => assertNetworkAddressesAreUnique(collision, [existing]), /share a loopback address/);
});

test("network identity allocation fails closed when its bounded candidates collide", () => {
  const [existing, collision] = COLLIDING_NETWORK_IDS;
  let attempts = 0;
  assert.throws(() => allocateNetworkIdWithUniqueAddresses([existing], () => {
    attempts++;
    return collision;
  }), /unique loopback addresses/);
  assert.equal(attempts, 128);
});

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

test("host-local gateway redirect addresses live in their own hidden band", () => {
  const appAddress = loopbackAddressForNetwork("network-a");
  const browserAddress = browserLoopbackAddressForNetwork("network-a");
  const redirectAddress = hostLocalGatewayLoopbackAddressForNetwork("network-a");

  assert.equal(redirectAddress, hostLocalGatewayLoopbackAddressForNetwork("network-a"));
  // pf reply translation breaks direct dials to an rdr target coordinate, so
  // the redirect target must never collide with a user-dialable alias band.
  assert.notEqual(redirectAddress, appAddress);
  assert.notEqual(redirectAddress, browserAddress);
  assert.match(redirectAddress, /^127\.(14[4-9]|15[0-9]|16[0-9]|17[0-5])\.\d{1,3}\.\d{1,3}$/);
});

test("the global network resolves to fixed band-external coordinates", () => {
  assert.equal(isGlobalNetworkId(GLOBAL_LOGICAL_NETWORK_ID), true);
  assert.equal(isGlobalNetworkId("network-a"), false);
  assert.equal(isGlobalNetworkId(undefined), false);
  assert.equal(NETWORK_IS_GLOBAL_ENV, "PORT_MANAGER_NETWORK_IS_GLOBAL");

  // Fixed constants outside every hashed band so the global coordinates are
  // recognizable in logs, pf rules, and lsof output.
  assert.equal(loopbackAddressForNetwork(GLOBAL_LOGICAL_NETWORK_ID), "127.1.0.1");
  assert.equal(browserLoopbackAddressForNetwork(GLOBAL_LOGICAL_NETWORK_ID), "127.1.1.1");
  assert.equal(hostLocalGatewayLoopbackAddressForNetwork(GLOBAL_LOGICAL_NETWORK_ID), "127.1.2.1");
});

test("loopback address routing mode uses loopback as the default actual-port policy", () => {
  assert.equal(ACTUAL_LOOPBACK_HOST_ENV, "PORT_MANAGER_ACTUAL_LOOPBACK_HOST");
  assert.equal(NETWORK_LOOPBACK_HOST_ENV, "PORT_MANAGER_NETWORK_LOOPBACK_HOST");
  assert.equal(isLoopbackAddressRoutingEnabled({}), true);
  assert.equal(resolveLoopbackAddressRoutingMode({}), "loopback");
  assert.equal(isLoopbackAddressRoutingEnabled({ enableLoopbackAddressRouting: true }), true);
  assert.equal(resolveLoopbackAddressRoutingMode({ enableLoopbackAddressRouting: true }), "auto");
  assert.equal(isLoopbackAddressRoutingEnabled({ enableLoopbackAddressRouting: false }), false);
  assert.equal(resolveLoopbackAddressRoutingMode({ enableLoopbackAddressRouting: false }), "high-port");
  assert.equal(resolveLoopbackAddressRoutingMode({ loopbackAddressRoutingMode: "loopback" }), "loopback");
  assert.equal(usesLoopbackAddressOnlyRouting({ experimentalRouteOwnershipMode: "loopback-address-only" }), true);
  assert.equal(shouldExposeNetworkLoopbackHost({ experimentalRouteOwnershipMode: "loopback-address-only" }), true);
  assert.equal(resolveTerminalLoopbackAddressRoutingMode({ experimentalRouteOwnershipMode: "loopback-address-only" }), "loopback");
});

test("loopback experiment mode is the manifest default while legacy mode settings stay hidden from UI", () => {
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    contributes?: {
      configuration?: {
        properties?: Record<string, { default?: unknown; included?: boolean }>;
      };
    };
  };
  const properties = manifest.contributes?.configuration?.properties ?? {};
  const hiddenModeSettings = [
    "portManager.routingMode",
    "portManager.experimentalRouteOwnershipMode",
    "portManager.enableLoopbackAddressRouting",
    "portManager.loopbackAddressRoutingMode",
    "portManager.virtualPortRangeStart",
    "portManager.virtualPortRangeEnd",
  ];

  assert.equal(properties["portManager.experimentalRouteOwnershipMode"]?.default, "loopback-address-only");
  assert.equal(properties["portManager.enableLoopbackAddressRouting"]?.default, true);
  assert.equal(properties["portManager.loopbackAddressRoutingMode"]?.default, "loopback");
  assert.equal(properties["portManager.globalNetwork"]?.default, true);
  assert.equal(DEFAULT_PORT_MANAGER_SETTINGS.globalNetwork, true);

  for (const settingName of hiddenModeSettings) {
    assert.equal(properties[settingName]?.included, false, `${settingName} must be hidden from Settings UI`);
  }
});

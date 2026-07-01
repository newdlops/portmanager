import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
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

  for (const settingName of hiddenModeSettings) {
    assert.equal(properties[settingName]?.included, false, `${settingName} must be hidden from Settings UI`);
  }
});

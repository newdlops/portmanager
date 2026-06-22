import assert from "node:assert/strict";
import test from "node:test";

import { parseRoutingNetworkIdFromProcessEnvironment } from "../../src/platform/process/node-process-environment";

/**
 * Unit tests for extracting native-hook routing scope from process metadata.
 *
 * The logical-port router uses this as a fallback when OS terminal attachment
 * ancestry is ambiguous but the client inherited Port Manager environment.
 */

test("parses the primary Port Manager network id from ps output", () => {
  const networkId = parseRoutingNetworkIdFromProcessEnvironment(
    "65384 s003 node wait-on PORT_MANAGER_NETWORK_ID=network-a PWD=/workspace/app",
  );

  assert.equal(networkId, "network-a");
});

test("parses legacy borrowed-network aliases when the primary variable is absent", () => {
  const networkId = parseRoutingNetworkIdFromProcessEnvironment(
    "65401 s003 node wait-on NEWDLOPS_PM_BORROWED_NETWORK_ID=network-b PORT_MANAGER_ROUTES_FILE=/tmp/routes.json",
  );

  assert.equal(networkId, "network-b");
});

test("ignores similar text that is not an environment assignment", () => {
  const networkId = parseRoutingNetworkIdFromProcessEnvironment(
    "node script-with-PORT_MANAGER_NETWORK_ID=network-c npm_package_script=PORT_MANAGER_NETWORK_ID=network-d",
  );

  assert.equal(networkId, undefined);
});

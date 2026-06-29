import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAllocationRequest,
  resolveRunNetworkId,
  type RunOptions,
} from "../../src/cli/portmanager-cli";

const baseRunOptions: RunOptions = {
  requestedPort: 3004,
  host: "localhost",
  cwd: "/workspace/app",
  name: "vite",
  command: "npm run dev",
  injectionMode: "env",
  scanRange: 20,
  scanDirection: "up",
  routingMode: "nearest",
  virtualPortRangeStart: 45000,
  virtualPortRangeEnd: 65000,
};

test("resolves CLI run network scope from attached terminal environment", () => {
  assert.equal(
    resolveRunNetworkId({
      PORT_MANAGER_NETWORK_ID: "",
      PORT_MANAGER_ROUTE_TABLE_NETWORK_ID: " network-a ",
      PORT_MANAGER_BORROWED_NETWORK_ID: "network-b",
    }),
    "network-a",
  );
  assert.equal(resolveRunNetworkId({ NEWDLOPS_PM_BORROWED_NETWORK_ID: "network-c" }), "network-c");
  assert.equal(resolveRunNetworkId({ PORT_MANAGER_NETWORK_ID: "   " }), undefined);
});

test("builds scoped allocation requests for portmanager run", () => {
  const previousNetworkId = process.env.PORT_MANAGER_NETWORK_ID;
  const previousRouteTableNetworkId = process.env.PORT_MANAGER_ROUTE_TABLE_NETWORK_ID;

  try {
    process.env.PORT_MANAGER_NETWORK_ID = "";
    process.env.PORT_MANAGER_ROUTE_TABLE_NETWORK_ID = "network-a";

    assert.deepEqual(buildAllocationRequest(baseRunOptions), {
      name: "vite",
      command: "npm run dev",
      cwd: "/workspace/app",
      requestedPort: 3004,
      host: "localhost",
      networkId: "network-a",
      scanRange: 20,
      scanDirection: "up",
      routingMode: "nearest",
      virtualPortRangeStart: 45000,
      virtualPortRangeEnd: 65000,
    });
  } finally {
    restoreEnvValue("PORT_MANAGER_NETWORK_ID", previousNetworkId);
    restoreEnvValue("PORT_MANAGER_ROUTE_TABLE_NETWORK_ID", previousRouteTableNetworkId);
  }
});

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

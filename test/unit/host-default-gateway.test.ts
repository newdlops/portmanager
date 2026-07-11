import assert from "node:assert/strict";
import test from "node:test";

import { selectHostDefaultGatewayExposure } from "../../src/core/networks/host-default-gateway";
import type { HostPortExposure, LogicalNetwork } from "../../src/shared/types";

test("host default gateway prefers the current window network for duplicate localhost ports", () => {
  const selected = selectHostDefaultGatewayExposure(
    [
      exposure({ id: "production1", networkId: "production1", targetAddress: "127.81.154.127" }),
      exposure({ id: "production2", networkId: "production2", targetAddress: "127.83.116.219" }),
    ],
    {
      networks: networks(["production1", "production2"]),
      preferredNetworkId: "production2",
    },
  );

  assert.equal(selected?.networkId, "production2");
});

test("host default gateway uses stable network order when no preferred network matches", () => {
  const selected = selectHostDefaultGatewayExposure(
    [
      exposure({ id: "production2", networkId: "production2", targetAddress: "127.83.116.219" }),
      exposure({ id: "production1", networkId: "production1", targetAddress: "127.81.154.127" }),
    ],
    {
      networks: networks(["production1", "production2"]),
      preferredNetworkId: "missing",
    },
  );

  assert.equal(selected?.networkId, "production1");
});

test("host default gateway refuses arbitrary networks when an explicit preference is required", () => {
  const exposures = [
    exposure({ id: "production1", networkId: "production1", targetAddress: "127.81.154.127" }),
    exposure({ id: "production2", networkId: "production2", targetAddress: "127.83.116.219" }),
  ];

  assert.equal(
    selectHostDefaultGatewayExposure(exposures, {
      networks: networks(["production1", "production2"]),
      requirePreferredNetwork: true,
    }),
    undefined,
  );
  assert.equal(
    selectHostDefaultGatewayExposure(exposures, {
      networks: networks(["production1", "production2"]),
      preferredNetworkId: "missing",
      requirePreferredNetwork: true,
    }),
    undefined,
  );
});

test("host default gateway refuses targets that would loop back to the same localhost port", () => {
  const selected = selectHostDefaultGatewayExposure(
    [
      exposure({ id: "loop", networkId: "loop", targetAddress: "localhost", targetPort: 15432 }),
      exposure({ id: "safe", networkId: "safe", targetAddress: "127.90.10.20", targetPort: 15432 }),
    ],
    { networks: networks(["loop", "safe"]) },
  );

  assert.equal(selected?.networkId, "safe");
});

test("host default gateway returns undefined when every candidate would self-loop", () => {
  const selected = selectHostDefaultGatewayExposure([
    exposure({ id: "loop", networkId: "loop", targetAddress: "127.0.0.1", targetPort: 15432 }),
  ]);

  assert.equal(selected, undefined);
});

function exposure(overrides: Partial<HostPortExposure>): HostPortExposure {
  return {
    id: "exposure",
    networkId: "network",
    hostAddress: "127.0.0.1",
    hostPort: 15432,
    targetAddress: "127.80.10.20",
    targetPort: 15432,
    protocol: "tcp",
    status: "active",
    createdAt: "host-gateway",
    ...overrides,
  };
}

function networks(ids: readonly string[]): readonly LogicalNetwork[] {
  return ids.map((id) => ({
    id,
    name: id,
    status: "running",
    runtimeKind: "nativeHelper",
    createdAt: "2026-07-01T00:00:00.000Z",
  }));
}

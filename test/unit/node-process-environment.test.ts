import assert from "node:assert/strict";
import test from "node:test";

import {
  NodeProcessEnvironmentProvider,
  parseRoutingNetworkIdFromProcessEnvironment,
} from "../../src/platform/process/node-process-environment";

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

test("coalesces concurrent process environment reads for the same PID", async () => {
  if (process.platform === "win32") {
    return;
  }

  let calls = 0;
  const environment = createDeferred<{ readonly stdout: string }>();
  const provider = new NodeProcessEnvironmentProvider({
    commandRunner: async () => {
      calls += 1;
      return environment.promise;
    },
  });

  const first = provider.readRoutingNetworkId(101);
  const second = provider.readRoutingNetworkId(101);

  assert.equal(calls, 1);

  environment.resolve({
    stdout: "101 s003 node wait-on PORT_MANAGER_NETWORK_ID=network-a PWD=/workspace/app",
  });

  assert.equal(await first, "network-a");
  assert.equal(await second, "network-a");
  assert.equal(await provider.readRoutingNetworkId(101), "network-a");
  assert.equal(calls, 1);
});

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

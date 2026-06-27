import assert from "node:assert/strict";
import test from "node:test";

import {
  inferRequestedPortFromCommand,
  inferRequestedPortFromProcessEnvironment,
  NodeProcessEnvironmentProvider,
  parseRoutingNetworkIdFromProcessEnvironment,
} from "../../src/platform/process/node-process-environment";
import type { ListeningPort } from "../../src/shared/types";

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

test("infers requested ports from common server command lines", () => {
  assert.equal(inferRequestedPortFromCommand("python manage.py runserver 8004", 57282), 8004);
  assert.equal(inferRequestedPortFromCommand("vite --host --port=3004", 57291), 3004);
  assert.equal(inferRequestedPortFromCommand("node server.js --listen-port 9000", 58000), 9000);
});

test("infers requested ports from explicit dev server environment variables", () => {
  assert.equal(
    inferRequestedPortFromProcessEnvironment("node vite PORT_MANAGER_HOOK=1 VITE_CLIENT_PORT=3004", 53743),
    3004,
  );
  assert.equal(inferRequestedPortFromProcessEnvironment("node server PORT=53743", 53743), undefined);
});

test("recovers hook route registration from listener process metadata", async () => {
  if (process.platform === "win32") {
    return;
  }

  const listener = createListener({
    port: 57282,
    pid: 64255,
    processName: "python3.11",
  });
  const provider = new NodeProcessEnvironmentProvider({
    nativeLookupProvider: {
      inspectProcess: async () => ({
        ancestorPids: [],
        cwd: "/workspace/app",
        networkId: "network-a",
      }),
    },
    commandRunner: async (_file, args) => {
      if (args.includes("eww")) {
        return {
          stdout:
            "64255 s003 python3 manage.py runserver 8004 PORT_MANAGER_HOOK=1 PORT_MANAGER_NETWORK_ID=network-a PWD=/workspace/app",
        };
      }

      return {
        stdout: "python3 manage.py runserver 8004\n",
      };
    },
  });

  const recovered = await provider.recoverHookRoute(listener);

  assert.deepEqual(recovered, {
    pid: 64255,
    name: "python3.11",
    command: "python3 manage.py runserver 8004",
    cwd: "/workspace/app",
    requestedPort: 8004,
    actualPort: 57282,
    host: "127.0.0.1",
    networkId: "network-a",
    source: "hooked",
  });
});

test("recovers wrapper-launched Vite routes from environment port metadata", async () => {
  if (process.platform === "win32") {
    return;
  }

  const listener = createListener({
    port: 53743,
    pid: 70925,
    processName: "node",
    command: "node",
  });
  const provider = new NodeProcessEnvironmentProvider({
    nativeLookupProvider: {
      inspectProcess: async () => ({
        ancestorPids: [],
        cwd: "/workspace/client",
        networkId: "network-a",
      }),
    },
    commandRunner: async (_file, args) => {
      if (args.includes("eww")) {
        return {
          stdout:
            "70925 s005 node /workspace/node_modules/.bin/vite --host PORT_MANAGER_HOOK=1 PORT_MANAGER_NETWORK_ID=network-a VITE_CLIENT_PORT=3004 PWD=/workspace",
        };
      }

      return {
        stdout: "node /workspace/node_modules/.bin/vite --host\n",
      };
    },
  });

  const recovered = await provider.recoverHookRoute(listener);

  assert.equal(recovered?.requestedPort, 3004);
  assert.equal(recovered?.actualPort, 53743);
  assert.equal(recovered?.command, "node /workspace/node_modules/.bin/vite --host");
});

test("does not recover no-network or disabled hook marker environments as app routes", async () => {
  if (process.platform === "win32") {
    return;
  }

  const cases = [
    {
      name: "global shell route metadata without hook marker",
      environment:
        "72931 s004 node server.js --port 3004 PORT_MANAGER_AGENT_SOCKET=/tmp/pm.sock PORT_MANAGER_ROUTES_FILE=/tmp/routes.json PWD=/workspace/app",
    },
    {
      name: "explicit hook opt-out",
      environment:
        "72931 s004 node server.js --port 3004 PORT_MANAGER_HOOK=0 PORT_MANAGER_DYLD_INSERT_LIBRARIES=/tmp/libportmanager_hook.dylib DYLD_INSERT_LIBRARIES=/tmp/libportmanager_hook.dylib",
    },
    {
      name: "disabled hook process",
      environment:
        "72931 s004 node server.js --port 3004 PORT_MANAGER_HOOK=1 PORT_MANAGER_HOOK_DISABLED=1 PORT_MANAGER_DYLD_INSERT_LIBRARIES=/tmp/libportmanager_hook.dylib",
    },
  ];

  for (const current of cases) {
    const listener = createListener({
      port: 53743,
      pid: 72931,
      processName: "node",
      command: "node",
    });
    const provider = new NodeProcessEnvironmentProvider({
      commandRunner: async (_file, args) => {
        if (args.includes("eww")) {
          return { stdout: current.environment };
        }

        return { stdout: "node server.js --port 3004\n" };
      },
    });

    assert.equal(await provider.recoverHookRoute(listener), undefined, current.name);
  }
});

test("does not recover debug adapter helper listeners as app routes", async () => {
  if (process.platform === "win32") {
    return;
  }

  const listener = createListener({
    port: 56474,
    pid: 82648,
    processName: "python3.11",
  });
  const provider = new NodeProcessEnvironmentProvider({
    nativeLookupProvider: {
      inspectProcess: async () => ({
        ancestorPids: [],
        cwd: "/workspace/app",
        networkId: "network-a",
      }),
    },
    commandRunner: async (_file, args) => {
      if (args.includes("eww")) {
        return {
          stdout:
            "82648 s001 python debugpy/adapter --for-server 56469 PORT_MANAGER_HOOK=1 PORT_MANAGER_NETWORK_ID=network-a",
        };
      }

      return {
        stdout: "python .venv/lib/python3.11/site-packages/debugpy/adapter --for-server 56469 --port 0\n",
      };
    },
  });

  assert.equal(await provider.recoverHookRoute(listener), undefined);
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

function createListener(overrides: Partial<ListeningPort> = {}): ListeningPort {
  return {
    id: "tcp:127.0.0.1:57282:64255",
    protocol: "tcp",
    localAddress: "127.0.0.1",
    port: 57282,
    pid: 64255,
    processName: "python3.11",
    command: "python3.11",
    source: "external",
    updatedAt: "2026-06-21T10:00:00.000Z",
    ...overrides,
  };
}

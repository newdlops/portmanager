import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNodeRuntimeEnvironment,
  disableNativeHookForCurrentProcess,
  ELECTRON_RUN_AS_NODE,
} from "../../src/platform/process/node-runtime";

/**
 * Unit tests for internal Node runtime launch environment.
 *
 * The daemon performs actual-port availability probes, so it must not inherit
 * the terminal socket hook that rewrites application bind/connect calls.
 */

test("daemon runtime environment disables native socket hook variables", () => {
  const environment = buildNodeRuntimeEnvironment({
    PORT_MANAGER_HOOK: "1",
    PORT_MANAGER_NETWORK_ID: "network-a",
    PORT_MANAGER_ROUTE_TABLE_NETWORK_ID: "network-a",
    PORT_MANAGER_ROUTES_FILE: "/tmp/routes-network-a.json",
    PORT_MANAGER_GLOBAL_ROUTES_FILE: "/tmp/routes.json",
    PORT_MANAGER_COMPOSE_ROUTING_FILE: "/tmp/compose-network-a.tsv",
    PORT_MANAGER_TERMINAL_ATTACHMENT_DIR: "/tmp/attachments",
    PORT_MANAGER_DYLD_INSERT_LIBRARIES: "/tmp/libportmanager_hook.dylib",
    PORT_MANAGER_LD_PRELOAD: "/tmp/libportmanager_hook.so",
    PORT_MANAGER_RUNTIME_SHIM_DIR: "/tmp/runtime-shims",
    PORT_MANAGER_ESCAPED_SERVER_RESPAWN: "1",
    BASH_ENV: "/tmp/portmanager-bash-env.sh",
    DYLD_INSERT_LIBRARIES: "/tmp/libportmanager_hook.dylib",
    LD_PRELOAD: "/tmp/libportmanager_hook.so",
    PATH: "/usr/bin",
  });

  assert.equal(environment[ELECTRON_RUN_AS_NODE], "1");
  assert.equal(environment.PORT_MANAGER_HOOK_DISABLED, "1");
  assert.equal(environment.PORT_MANAGER_HOOK, undefined);
  assert.equal(environment.PORT_MANAGER_NETWORK_ID, undefined);
  assert.equal(environment.PORT_MANAGER_ROUTE_TABLE_NETWORK_ID, undefined);
  assert.equal(environment.PORT_MANAGER_ROUTES_FILE, undefined);
  assert.equal(environment.PORT_MANAGER_GLOBAL_ROUTES_FILE, undefined);
  assert.equal(environment.PORT_MANAGER_COMPOSE_ROUTING_FILE, undefined);
  assert.equal(environment.PORT_MANAGER_TERMINAL_ATTACHMENT_DIR, undefined);
  assert.equal(environment.PORT_MANAGER_DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(environment.PORT_MANAGER_LD_PRELOAD, undefined);
  assert.equal(environment.PORT_MANAGER_RUNTIME_SHIM_DIR, undefined);
  assert.equal(environment.PORT_MANAGER_ESCAPED_SERVER_RESPAWN, undefined);
  assert.equal(environment.BASH_ENV, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(environment.LD_PRELOAD, undefined);
  assert.equal(environment.PATH, "/usr/bin");
});

test("current daemon process can disable an already loaded hook", () => {
  const environment: NodeJS.ProcessEnv = {
    PORT_MANAGER_HOOK: "1",
    PORT_MANAGER_BORROWED_NETWORK_ID: "network-a",
    PORT_MANAGER_ROUTE_TABLE_NETWORK_ID: "network-a",
    PORT_MANAGER_ROUTES_FILE: "/tmp/routes-network-a.json",
    PORT_MANAGER_TERMINAL_SESSION_ID: "network-a_ttys001_123_123",
    DYLD_INSERT_LIBRARIES: "/tmp/libportmanager_hook.dylib",
  };

  disableNativeHookForCurrentProcess(environment);

  assert.equal(environment.PORT_MANAGER_HOOK_DISABLED, "1");
  assert.equal(environment.PORT_MANAGER_HOOK, undefined);
  assert.equal(environment.PORT_MANAGER_BORROWED_NETWORK_ID, undefined);
  assert.equal(environment.PORT_MANAGER_ROUTE_TABLE_NETWORK_ID, undefined);
  assert.equal(environment.PORT_MANAGER_ROUTES_FILE, undefined);
  assert.equal(environment.PORT_MANAGER_TERMINAL_SESSION_ID, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
});

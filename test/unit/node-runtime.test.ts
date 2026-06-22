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
    PORT_MANAGER_RUNTIME_SHIM_DIR: "/tmp/runtime-shims",
    DYLD_INSERT_LIBRARIES: "/tmp/libportmanager_hook.dylib",
    LD_PRELOAD: "/tmp/libportmanager_hook.so",
    PATH: "/usr/bin",
  });

  assert.equal(environment[ELECTRON_RUN_AS_NODE], "1");
  assert.equal(environment.PORT_MANAGER_HOOK_DISABLED, "1");
  assert.equal(environment.PORT_MANAGER_HOOK, undefined);
  assert.equal(environment.PORT_MANAGER_NETWORK_ID, undefined);
  assert.equal(environment.PORT_MANAGER_RUNTIME_SHIM_DIR, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(environment.LD_PRELOAD, undefined);
  assert.equal(environment.PATH, "/usr/bin");
});

test("current daemon process can disable an already loaded hook", () => {
  const environment: NodeJS.ProcessEnv = {
    PORT_MANAGER_HOOK: "1",
    PORT_MANAGER_BORROWED_NETWORK_ID: "network-a",
    DYLD_INSERT_LIBRARIES: "/tmp/libportmanager_hook.dylib",
  };

  disableNativeHookForCurrentProcess(environment);

  assert.equal(environment.PORT_MANAGER_HOOK_DISABLED, "1");
  assert.equal(environment.PORT_MANAGER_HOOK, undefined);
  assert.equal(environment.PORT_MANAGER_BORROWED_NETWORK_ID, undefined);
  assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
});

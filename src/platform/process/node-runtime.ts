/**
 * Utilities for starting packaged JavaScript entrypoints from VS Code.
 *
 * VS Code extensions often inherit an Electron executable as `process.execPath`.
 * Running that executable without Node mode can open another VS Code window, so
 * every internal daemon/shim launch must carry this environment contract.
 */

export const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const NATIVE_HOOK_ENVIRONMENT_KEYS = [
  "DYLD_INSERT_LIBRARIES",
  "LD_PRELOAD",
  "BASH_ENV",
  "PORT_MANAGER_HOOK",
  "PORT_MANAGER_DYLD_INSERT_LIBRARIES",
  "PORT_MANAGER_NETWORK_ID",
  "PORT_MANAGER_BORROWED_NETWORK_ID",
  "PORT_MANAGER_RUNTIME_SHIM_DIR",
  "NEWDLOPS_PM_NETWORK_ID",
  "NEWDLOPS_PM_BORROWED_NETWORK_ID",
];

/**
 * Builds the environment used when a VS Code/Electron executable should behave
 * as a Node runtime for Port Manager's compiled JavaScript entrypoints.
 *
 * The local daemon must never route its own socket probes. If the daemon
 * inherits the terminal hook, its availability checks can be rewritten and
 * falsely report occupied actual ports as free during concurrent launches.
 */
export function buildNodeRuntimeEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnv,
    [ELECTRON_RUN_AS_NODE]: "1",
    PORT_MANAGER_HOOK_DISABLED: "1",
  };

  for (const key of NATIVE_HOOK_ENVIRONMENT_KEYS) {
    delete environment[key];
  }

  return environment;
}

/** Disables native socket routing inside the already-started daemon process. */
export function disableNativeHookForCurrentProcess(environment: NodeJS.ProcessEnv = process.env): void {
  environment.PORT_MANAGER_HOOK_DISABLED = "1";

  for (const key of NATIVE_HOOK_ENVIRONMENT_KEYS) {
    delete environment[key];
  }
}

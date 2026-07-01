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
  "ENV",
  "PORT_MANAGER_HOOK",
  "PORT_MANAGER_DYLD_INSERT_LIBRARIES",
  "PORT_MANAGER_LD_PRELOAD",
  "PORT_MANAGER_NETWORK_ID",
  "PORT_MANAGER_NETWORK_NAME",
  "PORT_MANAGER_NETWORK_DNS_ALIAS",
  "PORT_MANAGER_ROUTE_TABLE_NETWORK_ID",
  "PORT_MANAGER_BORROWED_NETWORK_ID",
  "PORT_MANAGER_ROUTES_FILE",
  "PORT_MANAGER_GLOBAL_ROUTES_FILE",
  "PORT_MANAGER_COMPOSE_ROUTING_FILE",
  "PORT_MANAGER_COMPOSE_LOGICAL_PORTS",
  "PORT_MANAGER_COMPOSE_REFRESH_WAIT_MS",
  "PORT_MANAGER_TERMINAL_ATTACHMENT_DIR",
  "PORT_MANAGER_TERMINAL_SESSION_ID",
  "PORT_MANAGER_TERMINAL_SESSION_NETWORK_ID",
  "PORT_MANAGER_TERMINAL_PROCESS_GROUP_ID",
  "PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE",
  "PORT_MANAGER_PRELOAD_REPAIR",
  "PORT_MANAGER_RUNTIME_SHIM_READY",
  "PORT_MANAGER_RUNTIME_SHIM_DIR",
  "PORT_MANAGER_HOOK_DAEMON_STARTED",
  "PORT_MANAGER_EXPECTED_VERSION",
  "PORT_MANAGER_ACTUAL_LOOPBACK_HOST",
  "PORT_MANAGER_NETWORK_LOOPBACK_HOST",
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

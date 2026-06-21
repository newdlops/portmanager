/**
 * Utilities for starting packaged JavaScript entrypoints from VS Code.
 *
 * VS Code extensions often inherit an Electron executable as `process.execPath`.
 * Running that executable without Node mode can open another VS Code window, so
 * every internal daemon/shim launch must carry this environment contract.
 */

export const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

/**
 * Builds the environment used when a VS Code/Electron executable should behave
 * as a Node runtime for Port Manager's compiled JavaScript entrypoints.
 */
export function buildNodeRuntimeEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [ELECTRON_RUN_AS_NODE]: "1",
  };
}

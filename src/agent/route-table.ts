import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared route-table path helpers.
 *
 * The daemon writes this JSON file, managed children read it through
 * environment variables, and native socket hooks use it to translate logical
 * connect targets to actual listening ports.
 */

/** Builds the per-user route table file path shared by one local agent. */
export function getDefaultRouteTablePath(): string {
  const userId = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `newdlops-portmanager-routes-${userId}.json`);
}

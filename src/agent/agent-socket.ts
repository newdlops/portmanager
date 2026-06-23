import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared local-agent socket helpers.
 *
 * VS Code extension clients and external terminal CLI clients must resolve the
 * same OS-user endpoint so every window and shell talks to one daemon.
 */

/**
 * Builds a per-user singleton socket path. POSIX uses a Unix domain socket in
 * the temp directory; Windows uses a named pipe.
 */
export function getAgentSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\newdlops-portmanager-agent";
  }

  const userId = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `newdlops-portmanager-agent-${userId}.sock`);
}

/** Lock file used so concurrent VS Code windows do not spawn duplicate agents. */
export function getAgentStartupLockPath(): string {
  if (process.platform === "win32") {
    return path.join(os.tmpdir(), "newdlops-portmanager-agent.lock");
  }

  const userId = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return path.join(os.tmpdir(), `newdlops-portmanager-agent-${userId}.lock`);
}

/**
 * Removes a stale Unix-domain socket after connection has already failed.
 * Active agents are not touched because a healthy socket would have accepted
 * the initial connection before this cleanup path runs.
 */
export function removeStaleSocketFile(socketPath: string): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {
    // A concurrent client may have removed or recreated the socket. The next
    // connection attempt decides whether startup actually worked.
  }
}

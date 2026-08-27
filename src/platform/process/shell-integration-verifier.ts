import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import { buildNodeRuntimeEnvironment } from "./node-runtime";

const execFileAsync = promisify(execFile);

export interface InstalledShellIntegrationVerification {
  readonly hookScriptPath: string;
  readonly commandLibraryPath: string;
  readonly profilePaths: readonly string[];
  readonly requiredProfileLines: readonly string[];
}

/**
 * Verifies the installed artifact rather than assuming successful writes mean
 * a new terminal can see `pm`. The hook must parse in POSIX sh, define `pm`
 * when sourced, and remain referenced by every selected startup profile.
 */
export async function verifyInstalledShellIntegration(
  verification: InstalledShellIntegrationVerification,
): Promise<void> {
  try {
    for (const scriptPath of [verification.hookScriptPath, verification.commandLibraryPath]) {
      await execFileAsync("/bin/sh", ["-n", scriptPath], {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
        env: buildNodeRuntimeEnvironment(process.env),
      });
    }
    await execFileAsync(
      "/bin/sh",
      ["-c", '. "$1"\ncommand -v pm >/dev/null 2>&1', "portmanager-shell-verifier", verification.hookScriptPath],
      {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
        env: {
          ...buildNodeRuntimeEnvironment(process.env),
          TERM_PROGRAM: "vscode",
          VSCODE_ENV_REPLACE: "1",
        },
      },
    );
  } catch (error) {
    throw new Error(`Installed Port Manager shell integration cannot load pm: ${verification.hookScriptPath}`, {
      cause: error,
    });
  }

  for (const profilePath of verification.profilePaths) {
    let profile: string;
    try {
      profile = await fs.readFile(profilePath, "utf8");
    } catch (error) {
      throw new Error(`Port Manager shell profile is unreadable after installation: ${profilePath}`, { cause: error });
    }

    for (const requiredLine of verification.requiredProfileLines) {
      if (!profile.includes(requiredLine)) {
        throw new Error(`Port Manager shell profile did not retain its managed integration: ${profilePath}`);
      }
    }
  }
}

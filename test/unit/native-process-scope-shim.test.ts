import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Network-scoped process observation shim (ps/pgrep/pkill/killall).
 *
 * These tests run the built native shim against real tagged child processes.
 * Children use the test runner's node binary: dev-installed runtimes are not
 * macOS platform binaries, so their environment is readable via procargs —
 * the same reason real dev servers and workers are attributable. Platform
 * binaries (e.g. /bin/sleep) hide their env from procargs and legitimately
 * stay visible as shared host substrate.
 */

const projectRoot = path.resolve(__dirname, "../../..");
const shimPath = path.join(projectRoot, "media", "native", "portmanager_process_scope_shim");

function runShim(
  linkDirectory: string,
  toolName: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(linkDirectory, toolName),
      [...args],
      { env: { PATH: "/usr/bin:/bin", ...environment }, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ exitCode: error === null ? 0 : (error.code as number), stdout, stderr });
      },
    );
  });
}

function spawnTaggedSleeper(networkId: string, marker: string): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000);", marker], {
    env: { PORT_MANAGER_NETWORK_ID: networkId },
    stdio: "ignore",
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

if (process.platform !== "darwin" || !fs.existsSync(shimPath)) {
  test("process scope shim hides foreign-network rows", { skip: "native process scope shim is not built" }, () => undefined);
} else {
  test("process scope shim hides foreign-network rows from ps and pgrep", async (context) => {
    const linkDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-process-scope-"));
    for (const name of ["ps", "pgrep", "pkill"]) {
      fs.symlinkSync(shimPath, path.join(linkDirectory, name));
    }
    const marker = `pm-scope-test-${process.pid}`;
    const own = spawnTaggedSleeper("network-scope-own", marker);
    const foreign = spawnTaggedSleeper("network-scope-foreign", marker);

    context.after(async () => {
      own.kill("SIGKILL");
      foreign.kill("SIGKILL");
      await fs.promises.rm(linkDirectory, { recursive: true, force: true });
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    const scopeEnv = { PORT_MANAGER_NETWORK_ID: "network-scope-own" };

    const psResult = await runShim(linkDirectory, "ps", ["-ef"], scopeEnv);
    const psRows = psResult.stdout.split("\n").filter((line) => line.includes(marker));
    assert.equal(psRows.some((line) => line.includes(` ${own.pid} `) || line.match(new RegExp(`\\b${own.pid}\\b`)) !== null), true);
    assert.equal(psRows.some((line) => line.match(new RegExp(`\\b${foreign.pid}\\b`)) !== null), false);

    const pgrepResult = await runShim(linkDirectory, "pgrep", ["-f", marker], scopeEnv);
    const pgrepPids = pgrepResult.stdout.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(pgrepPids.includes(String(own.pid)), true);
    assert.equal(pgrepPids.includes(String(foreign.pid)), false);

    // The escape hatch restores the machine-wide view.
    const unscoped = await runShim(linkDirectory, "pgrep", ["-f", marker], {
      ...scopeEnv,
      PORT_MANAGER_PROCESS_SCOPE: "0",
    });
    const unscopedPids = unscoped.stdout.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(unscopedPids.includes(String(own.pid)), true);
    assert.equal(unscopedPids.includes(String(foreign.pid)), true);
  });

  test("process scope shim pkill signals only the caller's network", async (context) => {
    const linkDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-process-scope-kill-"));
    fs.symlinkSync(shimPath, path.join(linkDirectory, "pkill"));
    const marker = `pm-scope-kill-test-${process.pid}`;
    const own = spawnTaggedSleeper("network-scope-own", marker);
    const foreign = spawnTaggedSleeper("network-scope-foreign", marker);

    context.after(async () => {
      own.kill("SIGKILL");
      foreign.kill("SIGKILL");
      await fs.promises.rm(linkDirectory, { recursive: true, force: true });
    });

    await new Promise((resolve) => setTimeout(resolve, 400));

    const result = await runShim(linkDirectory, "pkill", ["-f", marker], {
      PORT_MANAGER_NETWORK_ID: "network-scope-own",
    });

    assert.equal(result.exitCode, 0);
    assert.equal(await waitForExit(own, 3_000), true, "own-scope process must be signalled");
    assert.equal(await waitForExit(foreign, 500), false, "foreign-scope process must survive");
  });
}

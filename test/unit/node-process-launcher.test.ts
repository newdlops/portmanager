import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildNodeRuntimeEnvironment } from "../../src/platform/process/node-runtime";
import { NodeProcessLauncher } from "../../src/platform/process/node-process-launcher";

test("a successful launch retains its PID and reports its exit once", { timeout: 5000 }, async () => {
  const launcher = new NodeProcessLauncher();
  const exits: { pid: number; code: number | null }[] = [];
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const subscription = launcher.onExit((pid, code) => { exits.push({ pid, code }); resolveExit(); });
  try {
    const result = await launcher.launch({ name: "fixture", command: "exit 7", cwd: os.tmpdir(),
      requestedPort: 3000, actualPort: 3001, host: "127.0.0.1", injectionMode: "env" });
    await exited;
    assert.ok(result.pid > 0);
    assert.deepEqual(exits, [{ pid: result.pid, code: 7 }]);
    await launcher.stop(result.pid, "SIGTERM");
    assert.equal(exits.length, 1);
  } finally { subscription.dispose(); }
});

/** Exercise spawn failures in a separate process so an uncaught child error is
 * detected without taking down the test runner or its other fixtures. */
test("a missing launch cwd rejects without terminating the process owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-launch-failure-"));
  const launcher = require.resolve("../../src/platform/process/node-process-launcher");
  const program = `
    const { NodeProcessLauncher } = require(${JSON.stringify(launcher)});
    new NodeProcessLauncher().launch({
      command: "echo unused", cwd: ${JSON.stringify(path.join(root, "missing"))},
      requestedPort: 3000, actualPort: 3000, injectionMode: "env"
    }).then(() => { process.exitCode = 2; }, error => {
      if (error.code !== "ENOENT") throw error;
      setImmediate(() => process.stdout.write("owner-alive\\n"));
    });
  `;
  try {
    const result = await promisify(execFile)(process.execPath, ["-e", program], {
      env: buildNodeRuntimeEnvironment(), timeout: 5000,
    });
    assert.equal(result.stdout, "owner-alive\n");
    assert.equal(result.stderr, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

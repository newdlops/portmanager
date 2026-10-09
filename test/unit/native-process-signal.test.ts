import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("controller signal binds expected birth and PID version before stopping a protected host process", {
  skip: process.platform !== "darwin", timeout: 15_000,
}, async context => {
  const root = fs.mkdtempSync("/private/tmp/pm-signal-"), helper = path.join(root, "lookup");
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", path.resolve(__dirname, "../../../native/process-lookup/portmanager_process_lookup.c"), "-o", helper]);
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await once(child, "spawn"); await delay(25);
  const expected = JSON.parse((await run(helper, ["identity", String(child.pid)], { timeout: 2000 })).stdout) as { pid: number; birth: number };
  assert.equal(expected.pid, child.pid); assert.ok(Number.isSafeInteger(expected.birth) && expected.birth > 0);
  await assert.rejects(run(helper, ["signal", String(expected.pid), String(expected.birth + 1), "SIGKILL"], { timeout: 2000 }), error => {
    const rejected = error as { code?: number; stdout?: string };
    const response = JSON.parse(rejected.stdout ?? "{}"); return rejected.code === 1 && response.sent === false && response.error !== 0;
  });
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null, "wrong birth must never deliver a signal");
  for (const args of [["signal", "1", String(expected.birth), "SIGTERM"], ["signal", String(expected.pid), "-1", "SIGTERM"],
    ["signal", String(expected.pid), String(expected.birth), "SIGSTOP"], ["signal", `${expected.pid}junk`, String(expected.birth), "SIGTERM"]]) {
    await assert.rejects(run(helper, args, { timeout: 2000 }), error => (error as { code?: number }).code === 2);
  }
  const exited = once(child, "exit");
  const result = JSON.parse((await run(helper, ["signal", String(expected.pid), String(expected.birth), "SIGTERM"], { timeout: 2000 })).stdout);
  assert.deepEqual(result, { ...expected, signal: "SIGTERM", sent: true, error: 0 });
  assert.equal((await exited)[1], "SIGTERM");
  await assert.rejects(run(helper, ["signal", String(expected.pid), String(expected.birth), "SIGKILL"], { timeout: 2000 }), error =>
    (error as { code?: number }).code === 1, "an exited identity cannot be signalled again");
});

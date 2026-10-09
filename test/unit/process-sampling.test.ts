import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { processSamples } from "../integration/proxy-resource-soak";

const execute = promisify(execFile);

test("resource sampling excludes an actual unreaped child with no descriptors", {
  skip: process.platform !== "darwin", timeout: 20_000,
}, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pm-sample-zombie-"));
  const binary = path.join(temporary, "zombie-parent");
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2",
    path.resolve("test/unit/process-sampling-zombie-fixture.c"), "-o", binary], { timeout: 10_000 });
  const parent = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  parent.stdin.on("error", () => {});
  t.after(async () => {
    const exited = parent.exitCode !== null ? undefined : once(parent, "exit");
    parent.stdin.end("\n");
    await exited;
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const [output] = await once(parent.stdout, "data");
  const childPid = Number(String(output).trim());
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  let zombie = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await execute("ps", ["-p", String(childPid), "-o", "stat="], { timeout: 3000 });
    if (status.stdout.trim().startsWith("Z")) { zombie = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(zombie, true, "the parent must keep this child unreaped");
  process.kill(childPid, 0); // A zombie still passes this existing liveness check.
  const samples = await processSamples(parent.pid!);
  assert.equal(samples.some(sample => sample.pid === childPid), false);
  assert.ok(samples.find(sample => sample.pid === parent.pid)!.descriptors > 0);
});

test("resource sampling rejects descriptor failures for a live host", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const failure = new Error("live descriptor query failed");
  await assert.rejects(processSamples(process.pid, undefined, async () => { throw failure; }),
    error => error === failure);
});

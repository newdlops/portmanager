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
  assert.ok(samples.find(sample => sample.pid === parent.pid)!.descriptors! > 0);
});

test("resource sampling rejects descriptor failures for a live host", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const failure = new Error("live descriptor query failed");
  await assert.rejects(processSamples(process.pid, undefined, async () => { throw failure; }),
    error => error === failure);
});

test("resource sampling preserves a live native descriptor error reply in its diagnostics", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const reply = JSON.stringify({ pid: process.pid, error: 1 });
  const failure = Object.assign(new Error("native descriptor query denied"), {
    code: 1, signal: null, stdout: reply, stderr: "",
  });
  await assert.rejects(processSamples(process.pid, undefined, async () => { throw failure; }), error => {
    assert.equal(error, failure);
    assert.match(failure.message, /queryCode/);
    assert.ok(failure.message.includes(JSON.stringify(reply)), "retain the structured native error without replacing it with zero");
    return true;
  });
});

test("resource sampling excludes its actual process-table child before descriptor queries", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const queried: number[] = [];
  let measurementPid: number | undefined;
  const samples = await processSamples(process.pid, undefined, async pid => {
    queried.push(pid); return 1;
  }, (pid, snapshotPids) => {
    measurementPid = pid;
    assert.ok(snapshotPids.includes(pid), "the actual ps snapshot must include its own command");
  });
  assert.ok(measurementPid !== undefined && measurementPid !== process.pid);
  assert.ok(queried.includes(process.pid));
  assert.equal(queried.includes(measurementPid!), false);
  assert.equal(samples.some(row => row.pid === measurementPid), false);
});

test("resource sampling retains a live product child named ps and rejects its descriptor failure", {
  skip: process.platform === "win32", timeout: 10_000,
}, async t => {
  const child = spawn(process.execPath, ["-e", "process.title='ps';process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  });
  await once(child.stdout, "data");
  const observed = await processSamples(process.pid, undefined, async () => 1);
  const row = observed.find(sample => sample.pid === child.pid);
  assert.ok(row, "the independent product child must remain in the process sample");
  assert.equal(path.basename(row.command), "ps");
  const failure = new Error("live product ps descriptor failure");
  await assert.rejects(processSamples(process.pid, undefined, async pid => {
    if (pid === child.pid) throw failure;
    return 1;
  }), error => error === failure);
});

test("resource sampling reports a kernel-denied privileged descendant as unknown and keeps host counts strict", {
  skip: process.platform !== "darwin", timeout: 15_000,
}, async t => {
  const child = spawn(process.execPath, ["-e", "process.title='ps';process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  });
  await once(child.stdout!, "data");
  const uid = process.getuid!();
  const nativeFailure = (pid: number, record: object) => Object.assign(new Error("kernel FD access denied"), {
    code: 1, signal: null, stderr: "", stdout: JSON.stringify({ pid, error: os.constants.errno.EPERM, ...record }),
  });
  const permittedBoundary = { effectiveUid: uid === 0 ? 1 : 0, realUid: uid,
    processUniqueId: "18446744073709551615", identityVersion: 1 };
  const samples = await processSamples(process.pid, undefined, async pid => {
    if (pid === child.pid) throw nativeFailure(pid, permittedBoundary);
    return 3;
  });
  const row = samples.find(sample => sample.pid === child.pid)!;
  assert.equal(path.basename(row.command), "ps");
  assert.equal(row.descriptors, null, "an inaccessible child is neither dropped nor counted as zero");
  assert.equal(row.descriptorUnavailable?.reason, "privileged-real-owner");
  assert.ok(row.rssKiB > 0);
  assert.equal(samples.find(sample => sample.pid === process.pid)!.descriptors, 3);
  for (const record of [
    { ...permittedBoundary, pid: child.pid! + 1 },
    { ...permittedBoundary, effectiveUid: uid },
    { ...permittedBoundary, realUid: uid + 1 },
    { ...permittedBoundary, fdCount: 0 },
    { ...permittedBoundary, error: os.constants.errno.EIO },
    { ...permittedBoundary, processUniqueId: undefined },
    { ...permittedBoundary, processUniqueId: "18446744073709551616" },
    { ...permittedBoundary, processUniqueId: "0" },
    { ...permittedBoundary, identityVersion: -1 },
    { ...permittedBoundary, identityVersion: 0x100000000 },
  ]) {
    const failure = nativeFailure(child.pid!, record);
    await assert.rejects(processSamples(process.pid, undefined, async pid => {
      if (pid === child.pid) throw failure;
      return 3;
    }), error => error === failure);
  }
  for (const requiredPid of [process.pid, child.pid!]) {
    const failure = nativeFailure(requiredPid, permittedBoundary);
    await assert.rejects(processSamples(process.pid, child.pid, async pid => {
      if (pid === requiredPid) throw failure;
      return 3;
    }), error => error === failure, "host and daemon must have real measured FD counts");
  }
});

test("resource sampling re-observes a clean no-match only when a live host subsequently has a real FD count", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const noMatch = Object.assign(new Error("lsof selected no process"), { code: 1, stdout: "", stderr: "", signal: null });
  let hostQueries = 0;
  const samples = await processSamples(process.pid, undefined, async pid => {
    if (pid === process.pid && hostQueries++ === 0) throw noMatch;
    if (process.platform === "linux") return fs.readdirSync(`/proc/${pid}/fd`).length;
    const result = await execute("lsof", ["-nP", "-a", "-p", String(pid), "-Ff"], { timeout: 5000 });
    return result.stdout.split("\n").filter(line => /^f\d/.test(line)).length;
  });
  assert.equal(hostQueries, 2);
  assert.ok(samples.find(row => row.pid === process.pid)!.descriptors! > 0);
});

test("resource sampling rejects a repeated clean no-match for a live host", {
  skip: process.platform === "win32", timeout: 10_000,
}, async () => {
  const noMatch = Object.assign(new Error("persistent live no-match"), { code: 1, stdout: "", stderr: "", signal: null });
  let hostQueries = 0;
  await assert.rejects(processSamples(process.pid, undefined, async pid => {
    if (pid === process.pid) { hostQueries++; throw noMatch; }
    return 1;
  }), error => error === noMatch);
  assert.equal(hostQueries, 2);
});

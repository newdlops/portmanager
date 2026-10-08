#!/usr/bin/env node
/**
 * One continuous packaged soak runs outside the runner's output pipes. Separate
 * CI steps snapshot its existing numeric journal while that same host stays
 * alive. Interrupted snapshots keep their running status and cannot pass a gate.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), "..");

/** Atomically publish lifecycle state; readers never see a partial JSON file. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** Copy only records covered by the producer's current atomic checkpoint. */
export function readSnapshot(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (Array.isArray(report.samples)) return report;
  assert.equal(report.status, "running");
  const journalPath = path.join(path.dirname(reportPath), path.basename(report.samplesJournal));
  const journal = fs.readFileSync(journalPath, "utf8");
  const complete = journal.slice(0, journal.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
  report.samples = complete.filter(sample => sample.elapsedSeconds <= report.latestSample.elapsedSeconds);
  assert.deepEqual(report.samples.at(-1), report.latestSample);
  return report;
}

/** File stdio keeps a grandchild from holding the CI step's output pipe open. */
export function runDetached({ executable, args, env, logPath, timeoutMs, onSpawn = () => {}, onTimeout = () => {} }) {
  return new Promise((resolve, reject) => {
    const output = fs.openSync(logPath, "a");
    let child;
    try { child = spawn(executable, args, { env, detached: true, stdio: ["ignore", output, output] }); }
    finally { fs.closeSync(output); }
    let finished = false;
    let timedOut = false;
    const finish = (error, code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // This exact group was created by this call, including inherited writers.
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      if (error) reject(error); else resolve({ code, signal, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { onTimeout(); } catch {}
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    }, timeoutMs);
    child.once("error", error => finish(error));
    child.once("exit", (code, signal) => finish(undefined, code, signal));
    try { onSpawn(child.pid); } catch (error) { finish(error); }
  });
}

/** Reject stale PID records instead of signaling an unrelated reused process. */
function stopRecordedGroup(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 1 || !marker) return;
  let command;
  try { command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=,pgid=,args="], { encoding: "utf8", timeout: 3000 }).trim(); }
  catch { return; }
  const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(command);
  if (!match || Number(match[1]) !== pid || Number(match[2]) !== pid || !match[3].includes(marker)) return;
  try { process.kill(-pid, "SIGKILL"); } catch {}
}

function stopApp(appRecord, ownerPid) {
  if (!fs.existsSync(appRecord)) return;
  const app = JSON.parse(fs.readFileSync(appRecord, "utf8"));
  if (app.ownerPid === ownerPid) stopRecordedGroup(app.codePid, app.marker);
}

/** CLI orchestration is available only on the already-authorized disposable VM. */
async function main() {
  assert.equal(process.env.CI, "true", "Packaged supervision requires disposable CI.");
  assert.ok(process.env.RUNNER_TEMP);
  const seconds = Number(process.env.PM_TEST_RESOURCE_SOAK_SECONDS);
  assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600);
  const reportPath = process.env.PM_TEST_RESOURCE_SOAK_REPORT;
  assert.ok(reportPath && path.isAbsolute(reportPath));
  const directory = path.dirname(reportPath);
  const statePath = path.join(directory, "packaged-session.json");
  const resultPath = path.join(directory, "packaged-result.json");
  const appRecord = path.join(directory, "packaged-app.json");
  const logPath = path.join(directory, "activation.log");
  const launcher = path.join(root, "scripts", "test-packaged-extension.mjs");
  const [mode, argument] = process.argv.slice(2);

  if (mode === "start") {
    assert.ok(!fs.existsSync(statePath), "A session already exists; do not reset the measured host.");
    const token = randomUUID();
    writeJson(statePath, { token, seconds, startedAt: Date.now(), deadline: Date.now() + (seconds + 480) * 1000 });
    const supervisor = spawn(process.execPath, [self, "supervise", token], { detached: true, stdio: "ignore", env: process.env });
    supervisor.once("error", error => writeJson(resultPath, { token, code: 1, error: String(error) }));
    supervisor.unref();
    console.log(`Continuous packaged validation supervisor pid=${supervisor.pid}`);
    return;
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.seconds, seconds);
  if (mode === "supervise") {
    assert.equal(state.token, argument);
    let childPid;
    try {
      const result = await runDetached({ executable: process.execPath, args: [launcher],
        env: { ...process.env, PM_TEST_RESOURCE_APP_RECORD: appRecord }, logPath,
        timeoutMs: Math.max(1, state.deadline - Date.now()),
        onSpawn: pid => { childPid = pid; writeJson(statePath, { ...state, supervisorPid: process.pid, childPid: pid }); },
        onTimeout: () => stopApp(appRecord, childPid) });
      writeJson(resultPath, { token: state.token, ...result, finishedAt: Date.now() });
    } catch (error) { writeJson(resultPath, { token: state.token, code: 1, error: String(error), finishedAt: Date.now() }); }
    return;
  }
  if (mode === "stop") {
    stopApp(appRecord, state.childPid);
    stopRecordedGroup(state.childPid, launcher);
    stopRecordedGroup(state.supervisorPid, state.token);
    return;
  }
  assert.ok(mode === "snapshot" || mode === "wait", "Unknown supervision mode.");
  const threshold = mode === "snapshot" ? Number(argument) : seconds;
  assert.ok(Number.isInteger(threshold) && threshold >= 0 && threshold <= seconds);
  while (Date.now() < state.deadline + 5000) {
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : undefined;
    const report = fs.existsSync(reportPath) ? readSnapshot(reportPath) : undefined;
    if (report && (mode === "snapshot" && report.seconds >= threshold || mode === "wait" && result)) {
      const snapshot = path.join(directory, "snapshots", mode === "wait" ? "final" : String(threshold), "resource-soak.json");
      writeJson(snapshot, report);
      console.log(JSON.stringify({ snapshot, status: report.status, hostPid: report.hostPid, seconds: report.seconds,
        requestedSeconds: report.requestedSeconds, cycles: report.cycles, profile: report.profile, launcherResult: result }));
      if (mode === "wait") {
        assert.equal(result.token, state.token);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.equal(result.timedOut, false);
        assert.equal(report.status, "passed", report.error);
        assert.equal(report.requestedSeconds, seconds);
        assert.ok(report.seconds >= seconds);
        assert.equal(report.scope, "real-extension-host-and-daemon");
      }
      return;
    }
    if (result) throw new Error(`Packaged validation ended before the requested snapshot: ${JSON.stringify(result)}`);
    await delay(1000);
  }
  stopApp(appRecord, state.childPid);
  stopRecordedGroup(state.childPid, launcher);
  throw new Error("Continuous packaged validation exceeded its original CI execution budget.");
}

// Importing the two low-level helpers for isolated tests never activates VS Code.
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

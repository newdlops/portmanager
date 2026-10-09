#!/usr/bin/env node
/**
 * Installs the VSIX into an empty profile on a disposable native CI runner, then
 * loads those installed bytes as the development extension for the smoke test.
 * The CI guard prevents touching a developer's shared daemon or shell assets.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";

const isolatedLocal = process.argv.includes("--isolated-local");
assert.ok(process.env.CI === "true" || isolatedLocal, "Packaged activation requires CI or explicit --isolated-local.");
if (!isolatedLocal) assert.ok(process.env.RUNNER_TEMP, "RUNNER_TEMP must identify the disposable runner.");
// A borrowed-network hook in this launcher can repair a child's environment
// after JS sanitizes it. Disable that inherited hook in this dedicated parent;
// the fresh extension host and its guarded fixtures load their own native code.
const inheritedRuntimeShim = process.env.PORT_MANAGER_RUNTIME_SHIM_DIR;
process.env.PORT_MANAGER_HOOK_DISABLED = "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const soakSeconds = Number(process.env.PM_TEST_RESOURCE_SOAK_SECONDS ?? 0);
assert.ok(Number.isInteger(soakSeconds) && soakSeconds >= 0 && soakSeconds <= 3600, "Invalid resource soak duration.");
const resourceReportPath = process.env.PM_TEST_RESOURCE_SOAK_REPORT ?? path.join(root, ".tmp", "resource-soak.json");
if (process.argv[2] && !isolatedLocal) {
  const recovery = /^--resource-report-annotations=([0-3])$/.exec(process.argv[2]);
  assert.ok(recovery && process.argv.length === 3, "Invalid report recovery argument.");
  // Recovery runs after the app measurement in separate CI steps. It cannot
  // install/activate VS Code or change the measured process's allocation/GC.
  publishReportAnnotations(resourceReportPath, Number(recovery[1]));
  process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
const vsix = path.join(root, `portmanager-${target}-${manifest.version}.vsix`);
assert.ok(fs.existsSync(vsix), `Missing native target package: ${vsix}`);
// macOS Unix sockets have a short path limit; the runner's default TMPDIR can
// consume most of it before the daemon's socket basename is appended.
const temporaryRoot = fs.realpathSync(fs.mkdtempSync("/tmp/pm-vsix-"));
const userData = path.join(temporaryRoot, "user");
const extensions = path.join(temporaryRoot, "extensions");
const runtimeTemp = path.join(temporaryRoot, "tmp");
const workspace = path.join(temporaryRoot, "workspace");
const privateHome = path.join(runtimeTemp, "home");
const agentRecordPath = path.join(runtimeTemp, "owned-agent.json");
const originalHome = os.homedir();
const originalSharedSocket = path.join(os.tmpdir(), `newdlops-portmanager-agent-${process.getuid?.()}.sock`);
const sharedSocketBefore = socketIdentity(originalSharedSocket);
for (const directory of [userData, extensions, runtimeTemp, workspace]) fs.mkdirSync(directory);
if (isolatedLocal) fs.mkdirSync(privateHome, { mode: 0o700 });
fs.mkdirSync(path.join(userData, "User"));
fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
  "security.workspace.trust.enabled": false,
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "telemetry.telemetryLevel": "off",
  "portManager.developmentLogPath": "",
  // Avoid unrelated host ingress ownership during the controlled soak. The
  // workload opens the production managers explicitly under their shared budget.
  ...(soakSeconds > 0 ? {
    "portManager.globalNetwork": false,
    "portManager.logicalPortGateway": false,
    "portManager.watchPreferredPorts": false,
    "portManager.monitorAllListeningPorts": false,
    "portManager.containerEventsWatch": false,
  } : {}),
}));
console.log(isolatedLocal ? `Packaged validation: isolated local profile ${temporaryRoot}` : "Packaged validation: download VS Code");
const vscodeExecutablePath = isolatedLocal
  ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
  : await withinBudget(downloadAndUnzipVSCode("stable"), 120_000, "VS Code download");
fs.accessSync(vscodeExecutablePath, fs.constants.X_OK);
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
const profileArgs = ["--user-data-dir", userData, "--extensions-dir", extensions];
console.log("Packaged validation: install VSIX");
const install = spawn(cli, [...cliArgs, ...profileArgs, "--install-extension", vsix, "--force"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
  timeout: 120_000,
  // A synchronous spawn can keep its caller blocked after the default TERM
  // if Electron ignores it. Keep the watchdog alive and force this CI-only CLI.
  killSignal: "SIGKILL",
});
await new Promise((resolve, reject) => {
  install.once("error", reject);
  install.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`VSIX installation failed: ${code ?? signal}.`)));
});
const installed = fs.readdirSync(extensions).find((entry) => entry.startsWith(`${manifest.publisher}.${manifest.name}-${manifest.version}`));
assert.ok(installed, "Installed extension directory is missing.");
const extensionPath = path.join(extensions, installed);
// Bound the test runner as well as individual workload operations so a VS Code
// startup/exit stall still uploads a useful CI log instead of waiting an hour.
console.log("Packaged validation: run extension host tests");
const guiEnvironment = { ...process.env };
delete guiEnvironment.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(guiEnvironment)) {
  if (key.startsWith("PORT_MANAGER_") || key.startsWith("NEWDLOPS_PM_") || key.startsWith("DYLD_") ||
      ["LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV", "ENV"].includes(key)) delete guiEnvironment[key];
}
if (inheritedRuntimeShim) guiEnvironment.PATH = guiEnvironment.PATH?.split(path.delimiter)
  .filter(entry => entry !== inheritedRuntimeShim).join(path.delimiter);
try { await runOwnedProcess(vscodeExecutablePath, [...profileArgs, "--disable-extensions", "--skip-welcome",
  "--skip-release-notes", "--no-sandbox", "--disable-gpu-sandbox", "--disable-updates", "--no-cached-data",
  "--disable-workspace-trust", `--extensionDevelopmentPath=${extensionPath}`,
  `--extensionTestsPath=${path.join(root, "out", "test", "integration", "packaged-extension.js")}`, workspace], {
    ...guiEnvironment,
    ...(isolatedLocal ? { PM_TEST_EXECUTION_ENVIRONMENT: "isolated-local", PM_TEST_PRIVATE_HOME: privateHome, ZDOTDIR: privateHome } : {}),
    PM_TEST_EXTENSION_PATH: extensionPath,
    PM_TEST_EXTENSION_VERSION: manifest.version,
    PM_TEST_NODE_EXECUTABLE: process.execPath,
    PM_TEST_PRIVATE_AGENT_RECORD: agentRecordPath,
    PM_TEST_RESOURCE_SOAK_SECONDS: process.env.PM_TEST_RESOURCE_SOAK_SECONDS ?? "0",
    PM_TEST_RESOURCE_SOAK_REPORT: resourceReportPath,
    TMPDIR: runtimeTemp,
    TMP: runtimeTemp,
    TEMP: runtimeTemp,
  }, (soakSeconds + 180) * 1000); }
finally {
  if (isolatedLocal) {
    await stopOwnedDaemon();
    assert.deepEqual(socketIdentity(originalSharedSocket), sharedSocketBefore, "The user's shared daemon socket changed during isolated validation.");
    assert.equal(os.homedir(), originalHome);
  }
  // Preserve the failure and cleanup counters in the job log even if the
  // separate artifact transport fails. Full samples remain in the JSON file.
  if (fs.existsSync(resourceReportPath)) {
    try {
      const report = readResourceReport(resourceReportPath);
      const { status, error, scope, platform, arch, seconds, requestedSeconds, cycles, exchanges, profile } = report;
      console.log("Resource report summary:", JSON.stringify({ status, error, scope, platform, arch,
        seconds, requestedSeconds, cycles, exchanges, profile, cleanup: report.samples?.at(-1)?.resources,
        latestResources: report.latestSample?.resources }));
      // ArtifactService can time out even when this job's ordinary logs remain
      // downloadable. Numeric samples contain no object values or snapshots;
      // retain the full report through that independent existing log transport.
      const encoded = gzipSync(JSON.stringify(report)).toString("base64");
      const chunks = encoded.match(/.{1,8192}/g) ?? [];
      console.log(`PM_RESOURCE_REPORT_GZIP_BASE64_BEGIN ${chunks.length}`);
      for (let index = 0; index < chunks.length; index++) console.log(`PM_RESOURCE_REPORT_GZIP_BASE64 ${index + 1}/${chunks.length} ${chunks[index]}`);
      console.log("PM_RESOURCE_REPORT_GZIP_BASE64_END");
    } catch (error) { console.error("Resource report summary unavailable:", error); }
  }
}
console.log(`Verified installed ${manifest.publisher}.${manifest.name}@${manifest.version} (${target}).`);

/** A failed GUI startup still leaves only this fixture's authenticated daemon eligible for shutdown. */
async function stopOwnedDaemon() {
  if (!fs.existsSync(agentRecordPath)) return;
  const record = JSON.parse(fs.readFileSync(agentRecordPath, "utf8"));
  assert.equal(record.extensionPath, extensionPath);
  assert.ok(path.dirname(record.socketPath) === runtimeTemp && record.tokenFilePath.startsWith(`${privateHome}${path.sep}`));
  const helper = path.join(extensionPath, "media/native/portmanager_process_lookup");
  const readIdentity = () => {
    try { return JSON.parse(execFileSync(helper, ["identity", String(record.pid)], { encoding: "utf8", timeout: 3000,
      env: { ...guiEnvironment, PORT_MANAGER_HOOK_DISABLED: "1" } })); } catch { return undefined; }
  };
  const current = () => { const identity = readIdentity(); return identity?.pid === record.pid && identity.birth === record.birth; };
  if (!current()) return;
  const authorization = fs.readFileSync(record.tokenFilePath, "utf8").trim();
  await new Promise(resolve => {
    const socket = net.createConnection(record.socketPath);
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 3000);
    socket.once("error", () => { clearTimeout(timer); resolve(); });
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    socket.once("connect", () => socket.end(JSON.stringify({ id: "owned-final-cleanup", method: "shutdownDaemon", authorization }) + "\n"));
  });
  const deadline = Date.now() + 5000;
  while (current() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(current(), false, "Private daemon did not exit after authenticated shutdown.");
}

/** Inode identity detects replacement without reading credentials or process environments. */
function socketIdentity(socketPath) {
  const stat = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  return stat ? { device: stat.dev, inode: stat.ino, socket: stat.isSocket() } : undefined;
}

/** Recover only complete journal records without promoting an interrupted run. */
function readResourceReport(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!Array.isArray(report.samples) && report.samplesJournal) {
    const journalPath = path.join(path.dirname(reportPath), path.basename(report.samplesJournal));
    const journal = fs.readFileSync(journalPath, "utf8");
    report.samples = journal.slice(0, journal.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
  }
  return report;
}

/**
 * Check annotations remain available when the artifact and job-log blobs do
 * not. The runner truncates messages at 4096 characters and keeps only ten
 * notices per step, so four independent steps each emit at most eight 4000-byte
 * data frames plus the begin/end markers. Oversize reports are never truncated.
 */
function publishReportAnnotations(reportPath, segment) {
  if (!fs.existsSync(reportPath)) {
    console.log("Resource report annotations unavailable: no report was written.");
    return;
  }
  const report = readResourceReport(reportPath);
  const chunks = gzipSync(JSON.stringify(report)).toString("base64").match(/.{1,4000}/g) ?? [];
  const notice = message => console.log(`::notice title=Port Manager resource trace ${segment + 1}/4::${message}`);
  if (chunks.length > 32) {
    if (segment === 0) notice(`Resource report annotations unavailable: ${chunks.length} frames exceed the 32-frame limit. The complete file is required.`);
    return;
  }
  const first = segment * 8;
  const end = Math.min(first + 8, chunks.length);
  if (first >= chunks.length) return;
  if (first === 0) notice(`PM_RESOURCE_REPORT_GZIP_BASE64_BEGIN ${chunks.length}`);
  for (let index = first; index < end; index++) notice(`PM_RESOURCE_REPORT_GZIP_BASE64 ${index + 1}/${chunks.length} ${chunks[index]}`);
  if (end === chunks.length) notice("PM_RESOURCE_REPORT_GZIP_BASE64_END");
}

/** Keeps external downloads and application lifecycle failures reviewable in CI. */
async function withinBudget(work, milliseconds, operation) {
  let timer;
  try { return await Promise.race([work, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} exceeded ${milliseconds}ms.`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

/** Own the disposable app's process group so a timeout also closes inherited
 * output pipes. Rejecting the SDK Promise alone leaves its child running. */
function runOwnedProcess(executable, args, env, milliseconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: "inherit", detached: true });
    // An external CI supervisor may need to stop this separate app group if the
    // launcher itself stalls. The unique profile marker prevents PID reuse bugs.
    const appRecord = process.env.PM_TEST_RESOURCE_APP_RECORD;
    if (appRecord && child.pid) fs.writeFileSync(appRecord, JSON.stringify({ ownerPid: process.pid,
      codePid: child.pid, marker: args[args.indexOf("--user-data-dir") + 1] }));
    let wakeGuard;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      wakeGuard?.kill("SIGTERM");
      if (appRecord) { try { fs.unlinkSync(appRecord); } catch {} }
      // Only descendants of this freshly-created CI process group are owned.
      // Close their inherited pipes even after the app's main process exits.
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Packaged extension test runner exceeded ${milliseconds}ms.`));
    }, milliseconds);
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(code === 0 ? undefined
      : new Error(`Packaged extension tests failed: ${code ?? signal}.`)));
    if (process.platform === "darwin" && child.pid) {
      // A command wrapper keeps the VM awake; -w additionally associates the
      // assertion with the actual GUI app rather than npm's process identity.
      wakeGuard = spawn("/usr/bin/caffeinate", ["-dis", "-w", String(child.pid)], { stdio: "ignore" });
      wakeGuard.once("error", finish);
      wakeGuard.once("exit", (code, signal) => {
        if (!finished && (code !== 0 || signal)) finish(new Error(`macOS app wake guard failed: ${code ?? signal}.`));
      });
      console.log(`Packaged validation: macOS app wake assertion pid=${child.pid}`);
    }
  });
}

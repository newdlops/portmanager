#!/usr/bin/env node
/**
 * Installs the VSIX into an empty profile on a disposable native CI runner, then
 * loads those installed bytes as the development extension for the smoke test.
 * The CI guard prevents touching a developer's shared daemon or shell assets.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";

assert.equal(process.env.CI, "true", "Packaged activation requires a disposable CI runner.");
assert.ok(process.env.RUNNER_TEMP, "RUNNER_TEMP must identify the disposable runner.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const soakSeconds = Number(process.env.PM_TEST_RESOURCE_SOAK_SECONDS ?? 0);
assert.ok(Number.isInteger(soakSeconds) && soakSeconds >= 0 && soakSeconds <= 3600, "Invalid resource soak duration.");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
const vsix = path.join(root, `portmanager-${target}-${manifest.version}.vsix`);
assert.ok(fs.existsSync(vsix), `Missing native target package: ${vsix}`);
// macOS Unix sockets have a short path limit; the runner's default TMPDIR can
// consume most of it before the daemon's socket basename is appended.
const temporaryRoot = fs.mkdtempSync("/tmp/pm-vsix-");
const userData = path.join(temporaryRoot, "user");
const extensions = path.join(temporaryRoot, "extensions");
const runtimeTemp = path.join(temporaryRoot, "tmp");
const workspace = path.join(temporaryRoot, "workspace");
for (const directory of [userData, extensions, runtimeTemp, workspace]) fs.mkdirSync(directory);
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
console.log("Packaged validation: download VS Code");
const vscodeExecutablePath = await withinBudget(downloadAndUnzipVSCode("stable"), 120_000, "VS Code download");
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
await runOwnedProcess(vscodeExecutablePath, [...profileArgs, "--disable-extensions", "--skip-welcome",
  "--skip-release-notes", "--no-sandbox", "--disable-gpu-sandbox", "--disable-updates", "--no-cached-data",
  "--disable-workspace-trust", `--extensionDevelopmentPath=${extensionPath}`,
  `--extensionTestsPath=${path.join(root, "out", "test", "integration", "packaged-extension.js")}`, workspace], {
    ...process.env,
    PM_TEST_EXTENSION_PATH: extensionPath,
    PM_TEST_EXTENSION_VERSION: manifest.version,
    PM_TEST_RESOURCE_SOAK_SECONDS: process.env.PM_TEST_RESOURCE_SOAK_SECONDS ?? "0",
    PM_TEST_RESOURCE_SOAK_REPORT: process.env.PM_TEST_RESOURCE_SOAK_REPORT ?? path.join(root, ".tmp", "resource-soak.json"),
    TMPDIR: runtimeTemp,
    TMP: runtimeTemp,
    TEMP: runtimeTemp,
  }, (soakSeconds + 180) * 1000);
console.log(`Verified installed ${manifest.publisher}.${manifest.name}@${manifest.version} (${target}).`);

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
    let wakeGuard;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      wakeGuard?.kill("SIGTERM");
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

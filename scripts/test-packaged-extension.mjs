#!/usr/bin/env node
/**
 * Installs the VSIX into an empty profile on a disposable native CI runner, then
 * loads those installed bytes as the development extension for the smoke test.
 * The CI guard prevents touching a developer's shared daemon or shell assets.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

assert.equal(process.env.CI, "true", "Packaged activation requires a disposable CI runner.");
assert.ok(process.env.RUNNER_TEMP, "RUNNER_TEMP must identify the disposable runner.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
}));
const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
const profileArgs = ["--user-data-dir", userData, "--extensions-dir", extensions];
const install = spawnSync(cli, [...cliArgs, ...profileArgs, "--install-extension", vsix, "--force"], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
  timeout: 120_000,
});
if (install.error) throw install.error;
assert.equal(install.status, 0, "VSIX installation failed.");
const installed = fs.readdirSync(extensions).find((entry) => entry.startsWith(`${manifest.publisher}.${manifest.name}-${manifest.version}`));
assert.ok(installed, "Installed extension directory is missing.");
const extensionPath = path.join(extensions, installed);
await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: extensionPath,
  extensionTestsPath: path.join(root, "out", "test", "integration", "packaged-extension.js"),
  launchArgs: [...profileArgs, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--no-sandbox", workspace],
  extensionTestsEnv: {
    PM_TEST_EXTENSION_PATH: extensionPath,
    PM_TEST_EXTENSION_VERSION: manifest.version,
    TMPDIR: runtimeTemp,
    TMP: runtimeTemp,
    TEMP: runtimeTemp,
  },
});
console.log(`Verified installed ${manifest.publisher}.${manifest.name}@${manifest.version} (${target}).`);

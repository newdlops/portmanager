import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  canLoadNativeHookLibrary,
  getPersistentNativeHookLibraryPath,
  preparePersistentNativeHookLibrary,
  readNativeBinaryArchitectures,
} from "../../src/platform/process/native-executable";

const root = path.resolve(__dirname, "../../..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("terminal preload survives VSIX removal and updates without changing an open binary", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-upgrade-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtimeDirectory = path.join(directory, "runtime");
  const libraryName = "libportmanager_hook.dylib";
  const oldPackagedPath = path.join(directory, "extension-old", libraryName);
  const newPackagedPath = path.join(directory, "extension-new", libraryName);
  fs.mkdirSync(path.dirname(oldPackagedPath));
  fs.mkdirSync(path.dirname(newPackagedPath));
  fs.writeFileSync(oldPackagedPath, "old-hook");
  fs.writeFileSync(newPackagedPath, "new-hook");

  const preloadPath = preparePersistentNativeHookLibrary(oldPackagedPath, runtimeDirectory);
  assert.equal(preloadPath, getPersistentNativeHookLibraryPath(newPackagedPath, runtimeDirectory));
  assert.equal(fs.lstatSync(preloadPath).isSymbolicLink(), false, "a symlink still depends on the old VSIX");
  const originalInode = fs.statSync(preloadPath).ino;
  assert.equal(preparePersistentNativeHookLibrary(oldPackagedPath, runtimeDirectory), preloadPath);
  assert.equal(fs.statSync(preloadPath).ino, originalInode, "unchanged hooks must not be republished");
  fs.rmSync(path.dirname(oldPackagedPath), { recursive: true });
  assert.equal(fs.readFileSync(preloadPath, "utf8"), "old-hook");

  // A mapped dylib holds the old inode. Updating the shared pathname must not
  // modify its bytes or its code signature underneath a running process.
  const mappedBinary = fs.openSync(preloadPath, "r");
  try {
    assert.equal(preparePersistentNativeHookLibrary(newPackagedPath, runtimeDirectory), preloadPath);
    assert.equal(fs.readFileSync(preloadPath, "utf8"), "new-hook");
    assert.equal(fs.readFileSync(mappedBinary, "utf8"), "old-hook");
  } finally {
    fs.closeSync(mappedBinary);
  }
  fs.rmSync(path.dirname(newPackagedPath), { recursive: true });
  assert.equal(fs.readFileSync(preloadPath, "utf8"), "new-hook");
  assert.throws(() => preparePersistentNativeHookLibrary(newPackagedPath, runtimeDirectory), { code: "ENOENT" });
  assert.equal(fs.readFileSync(preloadPath, "utf8"), "new-hook", "failed publication preserves the active copy");
});

test("unchanged hook publications avoid binary reads and still repair same-size mutations", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-refresh-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packagedPath = path.join(directory, "libportmanager_hook.dylib");
  fs.writeFileSync(packagedPath, "old-hook");
  const persistentPath = preparePersistentNativeHookLibrary(packagedPath, path.join(directory, "runtime"));
  const sourceStats = fs.statSync(packagedPath);
  const targetStats = fs.statSync(persistentPath);
  // Patch the underlying Node export: TypeScript's import-star object exposes
  // getters, so mocking that wrapper would not observe the platform module.
  const binaryReads = context.mock.method(require("node:fs") as typeof fs, "readFileSync");
  for (let index = 0; index < 20; index++) {
    assert.equal(preparePersistentNativeHookLibrary(packagedPath, path.join(directory, "runtime")), persistentPath);
  }
  assert.equal(binaryReads.mock.callCount(), 0, "steady refreshes only stat unchanged copies");

  fs.writeFileSync(persistentPath, "bad-hook");
  fs.utimesSync(persistentPath, targetStats.atime, targetStats.mtime);
  assert.equal(preparePersistentNativeHookLibrary(packagedPath, path.join(directory, "runtime")), persistentPath);
  assert.equal(fs.readFileSync(persistentPath, "utf8"), "old-hook", "ctime invalidates a damaged copy even when size/mtime match");

  fs.writeFileSync(packagedPath, "new-hook");
  fs.utimesSync(packagedPath, sourceStats.atime, sourceStats.mtime);
  preparePersistentNativeHookLibrary(packagedPath, path.join(directory, "runtime"));
  assert.equal(fs.readFileSync(persistentPath, "utf8"), "new-hook", "source mutations still publish the new bytes");
});

test("cached hook publication never accepts a replacement symlink", (context) => {
  if (process.platform === "win32") {
    context.skip("Windows symlink creation requires a separate privilege");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-symlink-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packagedPath = path.join(directory, "libportmanager_hook.dylib");
  fs.writeFileSync(packagedPath, "hook");
  const persistentPath = preparePersistentNativeHookLibrary(packagedPath, path.join(directory, "runtime"));
  fs.unlinkSync(persistentPath);
  fs.symlinkSync(packagedPath, persistentPath);
  preparePersistentNativeHookLibrary(packagedPath, path.join(directory, "runtime"));
  assert.equal(fs.lstatSync(persistentPath).isSymbolicLink(), false);
  fs.unlinkSync(packagedPath);
  assert.equal(fs.readFileSync(persistentPath, "utf8"), "hook", "the repaired copy survives package removal");
});

test("a persisted signed hook still loads after its packaged file is deleted", (context) => {
  const hookName = process.platform === "darwin" ? "libportmanager_hook.dylib" : "libportmanager_hook.so";
  const hookPath = path.join(root, "media", "native", hookName);
  const agentPath = path.join(root, "media", "native", "portmanager_agent");
  if (process.platform === "win32" || !fs.existsSync(hookPath) || !fs.existsSync(agentPath)) {
    context.skip("native hook and agent not built for this platform");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-hook-loader-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packagedPath = path.join(directory, hookName);
  fs.copyFileSync(hookPath, packagedPath);
  const persistentPath = preparePersistentNativeHookLibrary(packagedPath, path.join(directory, "runtime"));
  fs.unlinkSync(packagedPath);

  assert.equal(canLoadNativeHookLibrary(agentPath, persistentPath), true, "the OS loader must accept the surviving copy");
});

test("native release scripts fail closed and package one explicit Marketplace target", () => {
  const manifest = JSON.parse(readSource("package.json")) as { readonly scripts?: Readonly<Record<string, string>> };
  const buildSource = readSource("scripts/build-native-hook.sh");
  const packageSource = readSource("scripts/package-native-target.js");
  const verifySource = readSource("scripts/verify-native-artifacts.js");

  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    assert.equal(manifest.scripts?.[`package:${target}`]?.includes(target), true);
    assert.equal(buildSource.includes(`${target})`), true);
  }

  assert.equal(buildSource.includes("cc not found; Port Manager native artifacts cannot be built"), true);
  assert.equal(buildSource.includes("PORT_MANAGER_NATIVE_OUTPUT_DIR"), true);
  assert.equal(buildSource.includes("-mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET"), true);
  assert.equal(buildSource.includes('node "$ROOT_DIR/scripts/verify-native-artifacts.js" "$NATIVE_TARGET"'), true);
  assert.equal(packageSource.includes('[operation, "--target", target]'), true);
  assert.equal(packageSource.includes("PORT_MANAGER_NATIVE_TARGET: target"), true);
  assert.equal(packageSource.includes("PORT_MANAGER_NATIVE_OUTPUT_DIR is test-only"), true);
  assert.equal(verifySource.includes('execFileSync("file"'), true);
  assert.equal(verifySource.includes('execFileSync("otool"'), true);
  assert.equal(verifySource.includes('execFileSync("codesign"'), true);
  assert.equal(verifySource.includes("spawnSync(agentPath, [\"--probe\"]"), true);
  assert.equal(verifySource.includes("DYLD_INSERT_LIBRARIES"), true);
  assert.equal(verifySource.includes("compareVersions(version, deploymentTarget) > 0"), true);
});

test("native packaging scripts pass their language syntax checks", () => {
  for (const relativePath of ["scripts/package-native-target.js", "scripts/verify-native-artifacts.js"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, relativePath)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }

  if (process.platform !== "win32") {
    const result = spawnSync("sh", ["-n", path.join(root, "scripts/build-native-hook.sh")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("native agent compatibility is executed instead of inferred from file mode", () => {
  const body = readSource("src/platform/process/native-executable.ts");
  const commands = readSource("src/extension/commands.ts");
  const extensionClient = readSource("src/extension/local-agent-client.ts");
  const cliClient = readSource("src/cli/portmanager-cli.ts");

  assert.equal(body.includes("fs.constants.X_OK"), true);
  assert.equal(body.includes('spawnSync(nativeAgentPath, ["--probe"]'), true);
  assert.equal(body.includes("timeout: 1_000"), true);
  assert.equal(body.includes("probe.error === undefined"), true);
  assert.equal(body.includes("probe.status === 1"), true);
  assert.equal(body.includes("readNativeBinaryArchitectures(nativeAgentPath)"), true);
  assert.equal(body.includes('"DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"'), true);
  assert.equal(extensionClient.includes("canRunNativeAgentBinary(nativeAgentPath)"), true);
  assert.equal(cliClient.includes("canRunNativeAgentBinary(this.nativeAgentPath)"), true);
  assert.equal(commands.includes("canLoadNativeHookLibrary(nativeAgentPath, hookLibraryPath)"), true);
});

test("runtime architecture parser distinguishes Intel and Apple Silicon headers without Rosetta", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-header-"));
  try {
    const armMach = Buffer.alloc(64);
    armMach.writeUInt32LE(0xfeedfacf, 0);
    armMach.writeUInt32LE(0x0100000c, 4);
    const armMachPath = path.join(directory, "arm64-macho");
    fs.writeFileSync(armMachPath, armMach);

    const intelMach = Buffer.alloc(64);
    intelMach.writeUInt32LE(0xfeedfacf, 0);
    intelMach.writeUInt32LE(0x01000007, 4);
    const intelMachPath = path.join(directory, "x64-macho");
    fs.writeFileSync(intelMachPath, intelMach);

    const armElf = Buffer.alloc(64);
    armElf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    armElf.writeUInt16LE(183, 18);
    const armElfPath = path.join(directory, "arm64-elf");
    fs.writeFileSync(armElfPath, armElf);

    assert.deepEqual(readNativeBinaryArchitectures(armMachPath), ["arm64"]);
    assert.deepEqual(readNativeBinaryArchitectures(intelMachPath), ["x64"]);
    assert.deepEqual(readNativeBinaryArchitectures(armElfPath), ["arm64"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

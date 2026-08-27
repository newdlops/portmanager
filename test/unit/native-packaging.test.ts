import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { readNativeBinaryArchitectures } from "../../src/platform/process/native-executable";

const root = path.resolve(__dirname, "../../..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

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

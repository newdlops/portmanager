import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { networkStorageKey } from "../../src/core/networks/network-identity";
import { ensureNetworkNamespaceScaffold, networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

const execFileAsync = promisify(execFile);

/** Real native copy-up must preserve privacy and never replace another file. */
test("native dotenv copy-up publishes a private, complete file without replacing existing data", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, async context => {
  const root = path.resolve(__dirname, "../../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-file-boundary-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fixture");
  execFileSync("cc", [
    "-O2", "-pthread", path.join(root, "test/unit/native-hook-file-boundaries-fixture.c"),
    path.join(root, "native/shared/pm_dev_log.c"),
    ...(process.platform === "linux" ? ["-ldl"] : []), "-o", executable,
  ], { timeout: 30_000 });
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1" };
  delete environment.DYLD_INSERT_LIBRARIES;
  delete environment.LD_PRELOAD;
  const copy = (source: string, destination: string) => execFileSync(executable, ["copy", source, destination], {
    cwd: directory, env: environment, timeout: 5_000,
  });
  const source = path.join(directory, "original.env");
  const destination = path.join(directory, "network.env");
  const bytes = Buffer.alloc(140_000, 0x41);
  bytes.write("SYNTHETIC_AUDIT_VALUE=", 0);
  fs.writeFileSync(source, bytes, { mode: 0o600 });
  copy(source, destination);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600, "copy-up must not grant group/other access");
  assert.deepEqual(fs.readFileSync(destination), bytes, "copy-up must publish all bytes");
  assert.equal(fs.statSync(source).mode & 0o777, 0o600);
  fs.writeFileSync(destination, "existing network-specific value\n");
  copy(source, destination);
  assert.equal(fs.readFileSync(destination, "utf8"), "existing network-specific value\n");
  const outside = path.join(directory, "unrelated.env");
  const symlink = path.join(directory, "symlink.env");
  fs.writeFileSync(outside, "must remain untouched\n", { mode: 0o600 });
  fs.symlinkSync(outside, symlink);
  assert.throws(() => copy(source, symlink), "copy-up must reject a destination symlink");
  assert.equal(fs.readFileSync(outside, "utf8"), "must remain untouched\n");
  const missing = path.join(directory, "missing-parent", "copy.env");
  assert.throws(() => copy(source, missing));
  const competingSource = path.join(directory, "competing.env");
  const competingBytes = Buffer.alloc(140_000, 0x42);
  fs.writeFileSync(competingSource, competingBytes, { mode: 0o600 });
  const sharedDestination = path.join(directory, "race.env");
  const copies = await Promise.allSettled([source, competingSource].map(input => execFileAsync(
    executable, ["copy", input, sharedDestination], { cwd: directory, env: environment, timeout: 5_000 },
  )));
  for (const result of copies) assert.equal(result.status, "fulfilled", "both concurrent readers must accept the published winner");
  const published = fs.readFileSync(sharedDestination);
  assert.ok(published.equals(bytes) || published.equals(competingBytes), "copy-up must never publish mixed or partial bytes");
  assert.equal(fs.statSync(sharedDestination).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    "competing.env", "fixture", "network.env", "original.env", "race.env", "symlink.env", "unrelated.env",
  ].sort(), "failed and successful copies must leave no partial temporary files");
});

test("native env and file readers use stable identities even when display names collide", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, context => {
  const root = path.resolve(__dirname, "../../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-native-namespace-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fixture");
  execFileSync("cc", ["-O2", "-pthread", path.join(root, "test/unit/native-hook-file-boundaries-fixture.c"),
    path.join(root, "native/shared/pm_dev_log.c"), ...(process.platform === "linux" ? ["-ldl"] : []), "-o", executable], { timeout: 30_000 });
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1" };
  delete environment.DYLD_INSERT_LIBRARIES;
  delete environment.LD_PRELOAD;
  const run = (...args: string[]) => execFileSync(executable, args, { cwd: directory, env: environment, timeout: 5_000, encoding: "utf8" });
  for (const id of ["network-a", ".", "..", "a/b", "한글", "é", "e\u0301", "x".repeat(124)]) {
    assert.equal(run("key", id).trim(), networkStorageKey(id));
  }
  assert.throws(() => run("key", "x".repeat(125)));
  fs.writeFileSync(path.join(directory, ".env"), "APP=original\n", { mode: 0o600 });
  const networks = [{ id: "network-a", name: "same" }, { id: "network-b", name: "same" }];
  for (const network of networks) {
    ensureNetworkNamespaceScaffold(directory, network.id, network.name, networks);
    const paths = networkNamespacePaths(fs.realpathSync(directory), network.id);
    fs.writeFileSync(paths.envFilePath, `PM_AUDIT_VALUE=${network.id}\nPORT_MANAGER_NETWORK_ID=must-not-overwrite\n`);
    fs.writeFileSync(path.join(paths.filesDirectory, ".env"), `APP=${network.id}\n`);
    assert.equal(run("context", network.id).trim(), paths.filesDirectory);
    for (const name of [network.name, ".", "..", "alpha/beta", "한".repeat(500)]) {
      assert.equal(run("apply", network.id, name).trim(), network.id);
      assert.equal(run("read", network.id, name, ".env"), `APP=${network.id}\n`);
    }
  }
  assert.equal(fs.readFileSync(path.join(directory, ".env"), "utf8"), "APP=original\n");
  fs.writeFileSync(path.join(directory, ".env.new"), "fresh copy-up\n", { mode: 0o600 });
  assert.equal(run("read", "network-a", "same", ".env.new"), "fresh copy-up\n");
  assert.equal(fs.statSync(path.join(networkNamespacePaths(directory, "network-a").filesDirectory, ".env.new")).mode & 0o777, 0o600);
  run("write", "network-a", "same", "worker.pid", "state-a");
  run("write", "network-b", "same", "worker.pid", "state-b");
  assert.equal(run("read", "network-a", "same", "worker.pid"), "state-a");
  assert.equal(run("read", "network-b", "same", "worker.pid"), "state-b");
  assert.throws(() => run("read", "network-c", "same", "worker.pid"), "a clean network must not read another network's symlink window");
  const privateEnv = path.join(networkNamespacePaths(directory, "network-a").filesDirectory, ".env");
  fs.unlinkSync(privateEnv);
  fs.symlinkSync(path.join(networkNamespacePaths(directory, "network-b").filesDirectory, ".env"), privateEnv);
  assert.throws(() => run("read", "network-a", "same", ".env"), "a mirror symlink must not read another network's dotenv");
  const otherFiles = networkNamespacePaths(directory, "network-b").filesDirectory;
  fs.writeFileSync(path.join(otherFiles, "configuration.env"), "network-b configuration");
  fs.symlinkSync(otherFiles, path.join(networkNamespacePaths(directory, "network-a").filesDirectory, "linked"), "dir");
  assert.throws(() => run("read", "network-a", "same", "linked/configuration.env"), "a mirror parent symlink must not escape to another namespace");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { networkStorageKey } from "../../src/core/networks/network-identity";
import { ensureNetworkNamespaceScaffold, networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

function workspace(context: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-namespace-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("stable identity keys cannot collide through display-name or filesystem normalization", () => {
  const ids = [".", "..", "alpha/beta", "alpha-beta", "A", "a", "é", "e\u0301", "네트워크"];
  const keys = ids.map(networkStorageKey);
  assert.equal(new Set(keys.map(key => key.toLowerCase().normalize("NFC"))).size, ids.length);
  for (const key of keys) assert.match(key, /^id-[0-9a-f]+$/);
  assert.equal(networkStorageKey("a".repeat(124)).length, 251);
  for (const id of ["", "a".repeat(125), "\ud800", "x\0y"]) assert.throws(() => networkStorageKey(id));
});

test("duplicate, slash and dot display names retain private independent id-scoped files", context => {
  const root = workspace(context);
  fs.writeFileSync(path.join(root, ".env"), "ORIGINAL=unchanged\n", { mode: 0o600 });
  const names = ["same", "same", "alpha/beta", "alpha-beta", ".", "..", "한".repeat(500)];
  const networks = names.map((name, index) => ({ id: `network-${index}`, name }));
  for (const network of networks) ensureNetworkNamespaceScaffold(root, network.id, network.name, networks);
  for (const network of networks) {
    const paths = networkNamespacePaths(root, network.id);
    assert.equal(fs.readFileSync(path.join(paths.filesDirectory, ".env"), "utf8"), "ORIGINAL=unchanged\n");
    assert.equal(fs.statSync(paths.envFilePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(paths.filesDirectory, ".env")).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(paths.filesDirectory, ".env"), `PRIVATE=${network.id}\n`);
    ensureNetworkNamespaceScaffold(root, network.id, "renamed", networks);
    assert.equal(fs.readFileSync(path.join(paths.filesDirectory, ".env"), "utf8"), `PRIVATE=${network.id}\n`);
  }
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "ORIGINAL=unchanged\n");
});

test("unique legacy settings migrate once without replacing user data or originals", context => {
  const root = workspace(context);
  const network = { id: "network-old", name: "old/name" };
  const oldEnv = path.join(root, ".portmanager", "env", "old-name.env");
  const oldFiles = path.join(root, ".portmanager", "files", "old-name");
  fs.mkdirSync(path.dirname(oldEnv), { recursive: true });
  fs.mkdirSync(path.join(oldFiles, "nested"), { recursive: true });
  fs.writeFileSync(oldEnv, "PRIVATE=legacy\n", { mode: 0o600 });
  fs.writeFileSync(path.join(oldFiles, ".env"), "APP=legacy\n");
  fs.writeFileSync(path.join(oldFiles, "nested", "state.db"), "saved state");
  ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]);
  const paths = networkNamespacePaths(root, network.id);
  assert.equal(fs.readFileSync(paths.envFilePath, "utf8"), "PRIVATE=legacy\n");
  assert.equal(fs.readFileSync(path.join(paths.filesDirectory, "nested", "state.db"), "utf8"), "saved state");
  fs.writeFileSync(paths.envFilePath, "PRIVATE=edited\n");
  fs.writeFileSync(oldEnv, "PRIVATE=older copy edited\n");
  ensureNetworkNamespaceScaffold(root, network.id, "renamed", [{ ...network, name: "renamed" }]);
  assert.equal(fs.readFileSync(paths.envFilePath, "utf8"), "PRIVATE=edited\n");
  assert.equal(fs.readFileSync(oldEnv, "utf8"), "PRIVATE=older copy edited\n");
  assert.equal(fs.readFileSync(path.join(oldFiles, "nested", "state.db"), "utf8"), "saved state");
  const reused = { id: "network-new", name: network.name };
  assert.throws(() => ensureNetworkNamespaceScaffold(root, reused.id, reused.name, [reused]), /owned by another network/);
});

test("ambiguous legacy name storage is preserved and never automatically imported", context => {
  const root = workspace(context);
  const networks = [{ id: "network-a", name: "alpha/beta" }, { id: "network-b", name: "alpha-beta" }];
  const oldEnv = path.join(root, ".portmanager", "env", "alpha-beta.env");
  fs.mkdirSync(path.dirname(oldEnv), { recursive: true });
  fs.writeFileSync(oldEnv, "PRIVATE=unknown owner\n");
  for (const network of networks) {
    assert.throws(() => ensureNetworkNamespaceScaffold(root, network.id, network.name, networks), /ambiguous/);
    assert.equal(fs.existsSync(networkNamespacePaths(root, network.id).envFilePath), false);
  }
  assert.equal(fs.readFileSync(oldEnv, "utf8"), "PRIVATE=unknown owner\n");
});

test("different legacy names cannot import one aliased file into two identities", context => {
  const root = workspace(context);
  const networks = [{ id: "network-a", name: "one" }, { id: "network-b", name: "two" }];
  const envDirectory = path.join(root, ".portmanager", "env");
  fs.mkdirSync(envDirectory, { recursive: true });
  fs.writeFileSync(path.join(envDirectory, "one.env"), "PRIVATE=single owner\n", { mode: 0o600 });
  fs.linkSync(path.join(envDirectory, "one.env"), path.join(envDirectory, "two.env"));
  for (const network of networks) assert.throws(() => ensureNetworkNamespaceScaffold(root, network.id, network.name, networks), /ambiguous/);
});

test("scaffolding rejects namespace and legacy symlinks without modifying their referents", context => {
  const root = workspace(context);
  const outside = workspace(context);
  const network = { id: "network-a", name: "safe" };
  fs.mkdirSync(path.join(root, ".portmanager"));
  fs.symlinkSync(outside, path.join(root, ".portmanager", "namespaces"), "dir");
  assert.throws(() => ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]));
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(root, ".portmanager", "namespaces"));
  const legacy = path.join(root, ".portmanager", "files", "safe");
  fs.mkdirSync(legacy, { recursive: true });
  const secret = path.join(outside, "other-network.env");
  fs.writeFileSync(secret, "must not be imported\n", { mode: 0o600 });
  fs.symlinkSync(secret, path.join(legacy, "config.env"));
  assert.throws(() => ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]), /symlink/);
  assert.equal(fs.existsSync(path.join(networkNamespacePaths(root, network.id).filesDirectory, "config.env")), false);
  assert.equal(fs.readFileSync(secret, "utf8"), "must not be imported\n");
});

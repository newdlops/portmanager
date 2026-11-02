import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { networkStorageKey } from "../../src/core/networks/network-identity";
import { ensureNetworkNamespaceScaffold, ensureNetworkDotenvSubstitute, networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

function workspace(context: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-namespace-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("legacy settings return actionable notices again after edits and follow ownership across rename", context => {
  const root = fs.realpathSync(workspace(context));
  const network = { id: "network-notice", name: "rtcc" };
  const legacy = path.join(root, ".portmanager/files/rtcc/.env");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "VALUE=original\n");
  type Notice = { sourcePath: string; destinationPath: string; signature: string };
  const first = ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]) as unknown as Notice[];
  assert.ok(Array.isArray(first), "attach must report inactive legacy paths instead of silently ignoring them");
  assert.equal(first.length, 1);
  assert.equal(first[0].sourcePath, path.dirname(legacy));
  assert.equal(first[0].destinationPath, networkNamespacePaths(root, network.id).filesDirectory);
  const repeated = ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]) as unknown as Notice[];
  assert.equal(repeated[0].signature, first[0].signature);
  fs.writeFileSync(legacy, "VALUE=edited legacy\n");
  const edited = ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]) as unknown as Notice[];
  assert.notEqual(edited[0].signature, first[0].signature);
  assert.equal(fs.readFileSync(path.join(edited[0].destinationPath, ".env"), "utf8"), "VALUE=original\n");
  const renamed = { ...network, name: "새 이름" };
  const afterRename = ensureNetworkNamespaceScaffold(root, network.id, renamed.name, [renamed]) as unknown as Notice[];
  assert.equal(afterRename[0].sourcePath, path.dirname(legacy));
  assert.equal(afterRename[0].destinationPath, networkNamespacePaths(root, network.id).filesDirectory);
  assert.equal(fs.readFileSync(legacy, "utf8"), "VALUE=edited legacy\n");
});

test("upgraded existing namespaces also report inactive legacy settings without replacing either copy", context => {
  const root = fs.realpathSync(workspace(context));
  const network = { id: "network-existing", name: "existing" };
  ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]);
  const active = networkNamespacePaths(root, network.id);
  fs.writeFileSync(active.envFilePath, "VALUE=active\n");
  const legacy = path.join(root, ".portmanager/env/existing.env");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "VALUE=inactive\n");
  const notices = ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]) as unknown as { sourcePath: string; destinationPath: string }[];
  assert.deepEqual(notices.map(({ sourcePath, destinationPath }) => ({ sourcePath, destinationPath })), [{ sourcePath: legacy, destinationPath: active.envFilePath }]);
  assert.equal(fs.readFileSync(active.envFilePath, "utf8"), "VALUE=active\n");
  assert.equal(fs.readFileSync(legacy, "utf8"), "VALUE=inactive\n");
});

test("explicit dotenv opening preserves existing data and rejects a substituted symlink", context => {
  const root = fs.realpathSync(workspace(context));
  const network = { id: "dotenv-open", name: "dotenv" };
  ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]);
  const dotenv = ensureNetworkDotenvSubstitute(root, network.id);
  assert.equal(fs.statSync(dotenv).mode & 0o777, 0o600);
  fs.writeFileSync(dotenv, "EXISTING=keep\n");
  ensureNetworkDotenvSubstitute(root, network.id);
  assert.equal(fs.readFileSync(dotenv, "utf8"), "EXISTING=keep\n");
  fs.unlinkSync(dotenv);
  const outside = path.join(root, "outside.env");
  fs.writeFileSync(outside, "OUTSIDE=keep\n");
  fs.symlinkSync(outside, dotenv);
  assert.throws(() => ensureNetworkDotenvSubstitute(root, network.id));
  assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE=keep\n");
});

test("existing namespaces cannot claim ambiguous legacy names or another network's receipt", context => {
  const root = fs.realpathSync(workspace(context));
  const networks = [{ id: "receipt-first", name: "same" }, { id: "receipt-second", name: "same" }];
  for (const network of networks) ensureNetworkNamespaceScaffold(root, network.id, network.name, networks);
  const legacy = path.join(root, ".portmanager/env/same.env");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "VALUE=legacy\n");
  assert.throws(() => ensureNetworkNamespaceScaffold(root, networks[0].id, "same", networks), /ambiguous/);
  const firstNotices = ensureNetworkNamespaceScaffold(root, networks[0].id, "same", [networks[0]]);
  assert.equal(firstNotices.length, 1);
  assert.deepEqual(ensureNetworkNamespaceScaffold(root, networks[1].id, "same", networks), []);
  fs.unlinkSync(legacy);
  fs.symlinkSync(path.join(root, "outside"), legacy);
  assert.throws(() => ensureNetworkNamespaceScaffold(root, networks[0].id, "same", networks));
});

test("local settings folders use readable network names including Korean and spaces", context => {
  const root = workspace(context);
  const networks = [{ id: "network-random-uuid", name: "알파 개발" }, { id: "network-other-uuid", name: "rtcc" }];
  for (const network of networks) {
    ensureNetworkNamespaceScaffold(root, network.id, network.name, networks);
    const paths = networkNamespacePaths(root, network.id);
    assert.equal(path.basename(paths.directory), network.name);
    assert.equal(fs.readFileSync(path.join(paths.directory, ".network-id"), "utf8"), network.id);
    assert.equal(fs.statSync(path.join(paths.directory, ".network-id")).mode & 0o777, 0o600);
  }
});

test("duplicate names use readable numeric suffixes and keep independent settings", context => {
  const root = workspace(context);
  const networks = [{ id: "network-first", name: "rtcc" }, { id: "network-second", name: "rtcc" }];
  for (const network of networks) ensureNetworkNamespaceScaffold(root, network.id, network.name, networks);
  const first = networkNamespacePaths(root, networks[0].id);
  const second = networkNamespacePaths(root, networks[1].id);
  assert.equal(path.basename(first.directory), "rtcc");
  assert.equal(path.basename(second.directory), "rtcc (2)");
  fs.writeFileSync(first.envFilePath, "VALUE=first\n");
  fs.writeFileSync(second.envFilePath, "VALUE=second\n");
  for (const network of networks) ensureNetworkNamespaceScaffold(root, network.id, network.name, networks);
  assert.equal(fs.readFileSync(first.envFilePath, "utf8"), "VALUE=first\n");
  assert.equal(fs.readFileSync(second.envFilePath, "utf8"), "VALUE=second\n");
});

test("filesystem aliases, unsafe characters and long names stay readable without collisions", context => {
  const root = workspace(context);
  const names = ["Alpha", "alpha", "é", "e\u0301", "alpha/beta", "alpha%2Fbeta", ".", "..", "CON", "한".repeat(500), " ".repeat(500), "x".repeat(219) + "." + "y".repeat(500), " ".repeat(250) + "b"];
  const networks = names.map((name, index) => ({ id: `network-safe-${index}`, name }));
  for (const network of networks) ensureNetworkNamespaceScaffold(root, network.id, network.name, networks);
  const basenames = networks.map(network => path.basename(networkNamespacePaths(root, network.id).directory));
  assert.deepEqual(basenames.slice(0, 9), ["Alpha", "alpha (2)", "é", "e\u0301 (2)", "alpha%2Fbeta", "alpha%252Fbeta", "%2E", "%2E%2E", "_CON"]);
  assert.equal(new Set(basenames.map(name => name.normalize("NFC").toLowerCase())).size, names.length);
  for (const name of basenames) {
    assert.ok(Buffer.byteLength(name) <= 240);
    assert.doesNotMatch(name, /[. ]$/);
  }
  assert.ok(basenames[9].startsWith("한한"));
  const unnamed = { id: "network-no-name", name: "" };
  ensureNetworkNamespaceScaffold(root, unnamed.id, undefined);
  assert.equal(path.basename(networkNamespacePaths(root, unnamed.id).directory), "Network");
});

test("migration never adopts an opaque-looking folder already owned by a different network", context => {
  const root = workspace(context);
  const targetId = "network-target";
  const owner = { id: "network-actual-owner", name: networkStorageKey(targetId) };
  ensureNetworkNamespaceScaffold(root, owner.id, owner.name, [owner]);
  const original = networkNamespacePaths(root, owner.id);
  fs.writeFileSync(original.envFilePath, "VALUE=owner\n");
  assert.throws(() => ensureNetworkNamespaceScaffold(root, targetId, "target"), /another network/);
  assert.equal(fs.readFileSync(original.envFilePath, "utf8"), "VALUE=owner\n");
});

test("upgrade moves opaque ID folders and rename preserves settings in the new name", context => {
  const root = workspace(context);
  const network = { id: "network-upgrade", name: "rtcc" };
  const opaque = path.join(root, ".portmanager", "namespaces", networkStorageKey(network.id));
  fs.mkdirSync(path.join(opaque, "files", "nested"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(opaque, "environment.env"), "VALUE=upgraded\n", { mode: 0o600 });
  fs.writeFileSync(path.join(opaque, "files", ".env"), "APP=private\n", { mode: 0o600 });
  fs.writeFileSync(path.join(opaque, "files", "nested", "worker.pid"), "12345", { mode: 0o600 });
  fs.mkdirSync(path.join(root, "nested"));
  fs.symlinkSync(path.join(opaque, "files", "nested", "worker.pid"), path.join(root, "nested", "worker.pid"));
  ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]);
  const current = networkNamespacePaths(root, network.id);
  assert.equal(path.basename(current.directory), "rtcc");
  assert.equal(fs.existsSync(opaque), false);
  assert.equal(fs.readFileSync(current.envFilePath, "utf8"), "VALUE=upgraded\n");
  assert.equal(fs.readFileSync(path.join(current.filesDirectory, ".env"), "utf8"), "APP=private\n");
  assert.equal(fs.readFileSync(path.join(root, "nested", "worker.pid"), "utf8"), "12345");
  ensureNetworkNamespaceScaffold(root, network.id, "새 이름", [{ ...network, name: "새 이름" }]);
  const renamed = networkNamespacePaths(root, network.id);
  assert.equal(path.basename(renamed.directory), "새 이름");
  assert.equal(fs.existsSync(current.directory), false);
  assert.equal(fs.readFileSync(renamed.envFilePath, "utf8"), "VALUE=upgraded\n");
  assert.equal(fs.readFileSync(path.join(root, "nested", "worker.pid"), "utf8"), "12345");
});

test("interrupted window repair keeps migrated settings discoverable and retry repairs windows", context => {
  const root = workspace(context);
  const network = { id: "network-interrupted", name: "recoverable" };
  const opaque = path.join(root, ".portmanager", "namespaces", networkStorageKey(network.id));
  fs.mkdirSync(path.join(opaque, "files"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(opaque, "environment.env"), "VALUE=keep\n", { mode: 0o600 });
  fs.writeFileSync(path.join(opaque, "files", "worker.pid"), "12345", { mode: 0o600 });
  fs.symlinkSync(path.join(opaque, "files", "worker.pid"), path.join(root, "worker.pid"));
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (String(source).includes(".pm-window-")) throw new Error("simulated interrupted state-window repair");
    return rename(source, destination);
  };
  try { assert.throws(() => ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]), /interrupted/); }
  finally { fs.renameSync = rename; }
  const recovered = networkNamespacePaths(root, network.id);
  assert.equal(fs.readFileSync(recovered.envFilePath, "utf8"), "VALUE=keep\n");
  ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]);
  assert.equal(path.basename(networkNamespacePaths(root, network.id).directory), "recoverable");
  assert.equal(fs.readFileSync(path.join(root, "worker.pid"), "utf8"), "12345");
});

test("stale lock observations never remove an active successor lock", context => {
  const root = workspace(context);
  const state = path.join(root, ".portmanager");
  const lock = path.join(state, ".namespace-lock");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(lock, "2147483647", { mode: 0o600 });
  const kill = process.kill;
  process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid === 2147483647) {
      // Another contender recovered the observed stale lock before this
      // contender returns from its liveness check.
      fs.writeFileSync(lock, String(process.pid));
      throw Object.assign(new Error("observed owner exited"), { code: "ESRCH" });
    }
    return kill(pid, signal);
  }) as typeof process.kill;
  try { assert.throws(() => ensureNetworkNamespaceScaffold(root, "network-lock", "locked"), /interrupted|busy/); }
  finally { process.kill = kill; }
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
});

test("interrupted lock publication leaves no ownerless lock and the next attach succeeds", context => {
  const root = workspace(context);
  const write = fs.writeFileSync;
  fs.writeFileSync = (() => { throw new Error("interrupted lock publication"); }) as typeof fs.writeFileSync;
  try { assert.throws(() => ensureNetworkNamespaceScaffold(root, "network-lock-retry", "retry"), /interrupted lock publication/); }
  finally { fs.writeFileSync = write; }
  assert.equal(fs.existsSync(path.join(root, ".portmanager", ".namespace-lock")), false);
  ensureNetworkNamespaceScaffold(root, "network-lock-retry", "retry");
  assert.equal(path.basename(networkNamespacePaths(root, "network-lock-retry").directory), "retry");
});

test("settings lookup requires an attached named folder rather than deriving a path from an ID", context => {
  const root = workspace(context);
  assert.throws(() => networkNamespacePaths(root, "network-unattached"), /attach/i);
});

test("concurrent attaches allocate readable names once per network without mixing settings", async context => {
  const root = workspace(context);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(PORT_MANAGER_|NEWDLOPS_PM_|DYLD_|LD_PRELOAD$)/.test(key)) delete environment[key];
  }
  const script = "const m=require(process.argv[1]); m.ensureNetworkNamespaceScaffold(process.argv[2],process.argv[3],'parallel');";
  const run = promisify(execFile);
  await Promise.all(["network-a", "network-b", "network-a", "network-b"].map(id => run(process.execPath,
    ["-e", script, require.resolve("../../src/platform/process/network-file-scaffold"), root, id], { env: environment, timeout: 15_000 })));
  const a = networkNamespacePaths(root, "network-a");
  const b = networkNamespacePaths(root, "network-b");
  assert.deepEqual([path.basename(a.directory), path.basename(b.directory)].sort(), ["parallel", "parallel (2)"]);
  assert.notEqual(a.directory, b.directory);
  assert.deepEqual(fs.readdirSync(path.join(root, ".portmanager")).sort(), ["namespaces"]);
});

test("stable identity keys cannot collide through display-name or filesystem normalization", () => {
  const ids = [".", "..", "alpha/beta", "alpha-beta", "A", "a", "é", "e\u0301", "네트워크"];
  const keys = ids.map(networkStorageKey);
  assert.equal(new Set(keys.map(key => key.toLowerCase().normalize("NFC"))).size, ids.length);
  for (const key of keys) assert.match(key, /^id-[0-9a-f]+$/);
  assert.equal(networkStorageKey("a".repeat(124)).length, 251);
  for (const id of ["", "a".repeat(125), "\ud800", "x\0y"]) assert.throws(() => networkStorageKey(id));
});

test("duplicate, slash and dot display names retain private independent named files", context => {
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
    const renamed = networkNamespacePaths(root, network.id);
    assert.equal(fs.readFileSync(path.join(renamed.filesDirectory, ".env"), "utf8"), `PRIVATE=${network.id}\n`);
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
  assert.equal(fs.readFileSync(networkNamespacePaths(root, network.id).envFilePath, "utf8"), "PRIVATE=edited\n");
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

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { readPrivateBytes } from "../../src/platform/process/macos-network-runtime";

/** A file that is complete but transiently has two links fails the production
 * readiness reader. Stop the real publisher immediately before its final move. */
test("private native readiness and receipt publication never exposes a transient multi-link file", {
  skip: process.platform !== "darwin", timeout: 20_000,
}, async context => {
  const root = fs.mkdtempSync("/private/tmp/pm-publish-");
  const sessions = path.join(root, ".portmanager/security/sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const fixture = path.join(root, "publisher"), source = path.resolve(__dirname, "../../..");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("cc", ["-O2", "-Wall", "-Wextra", "-Werror", path.join(source, "test/unit/native-network-launcher-publication-fixture.c"),
    path.join(source, "native/agent/portmanager_agent_json.c"), path.join(source, "native/shared/pm_dev_log.c"), "-o", fixture]);
  for (const mode of ["ready", "receipt"]) {
    const gate = path.join(root, mode); fs.mkdirSync(gate, { mode: 0o700 });
    const record = path.join(sessions, `${mode}.json`);
    const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1" };
    delete environment.DYLD_INSERT_LIBRARIES; delete environment.LD_PRELOAD;
    const child = spawn(fixture, [mode, record, gate], { env: environment, stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(path.join(gate, "entered.js"))) { assert.ok(Date.now() < deadline, "Publisher did not enter its controlled checkpoint."); await delay(5); }
      if (fs.existsSync(record)) {
        const stat = fs.statSync(record);
        context.diagnostic(JSON.stringify({ mode, nlink: stat.nlink, permissions: stat.mode & 0o777, bytes: stat.size }));
        assert.throws(() => readPrivateBytes(record, 2048), /Runtime file is not bounded private regular data/);
      }
      assert.equal(fs.existsSync(record), false, "A paused publisher must not expose a record rejected by the strict consumer.");
      assert.throws(() => readPrivateBytes(record, 2048), error => (error as NodeJS.ErrnoException).code === "ENOENT");
      fs.writeFileSync(path.join(gate, "release.js"), "release");
      assert.equal((await exited)[0], 0);
      assert.equal(fs.statSync(record).nlink, 1); assert.equal(fs.statSync(record).mode & 0o777, 0o600);
      const value = JSON.parse(readPrivateBytes(record, 2048).toString());
      if (mode === "ready") assert.equal(value.networkId, "publication");
      else assert.deepEqual(value, { version: 1, cleaned: true });
      const original = fs.readFileSync(record), collisionGate = path.join(root, mode + "-collision");
      fs.mkdirSync(collisionGate, { mode: 0o700 }); fs.writeFileSync(path.join(collisionGate, "release.js"), "release");
      const collision = spawn(fixture, [mode, record, collisionGate], { env: environment, stdio: "ignore" });
      assert.equal((await once(collision, "exit"))[0], 1, "Exclusive publication must refuse an existing record.");
      assert.deepEqual(fs.readFileSync(record), original); assert.equal(fs.statSync(record).nlink, 1);
      assert.ok(fs.readdirSync(sessions).every(name => !name.endsWith(".tmp")), "Failed publication must remove its temporary inode.");
    } finally {
      fs.writeFileSync(path.join(gate, "release.js"), "release");
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
  }
});

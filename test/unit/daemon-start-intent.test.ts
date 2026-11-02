import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonStartIntentStore } from "../../src/agent/daemon-start-intent";

test("Stop is shared across windows and reloads; an older Restart cannot clear a later Stop", context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-daemon-intent-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credential = path.join(root, "private", "controller.key");
  const first = new DaemonStartIntentStore(credential);
  const second = new DaemonStartIntentStore(credential);
  assert.equal(first.isSuspended(), false);
  const restarting = first.suspend();
  assert.equal(second.isSuspended(), true);
  assert.equal(new DaemonStartIntentStore(credential).isSuspended(), true);
  second.suspend();
  assert.equal(first.resume(restarting), false, "a late Restart clears only its own observed suspension set");
  assert.equal(second.isSuspended(), true);
  assert.equal(first.resume(), true, "explicit Start clears all stops observed at that action");
  assert.equal(second.isSuspended(), false);
  assert.equal(fs.statSync(`${credential}.stopped`).mode & 0o777, 0o700);
});

test("unsafe suspension storage is rejected without following a symlink", context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-daemon-intent-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credential = path.join(root, "controller.key");
  const target = path.join(root, "foreign");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, `${credential}.stopped`);
  assert.throws(() => new DaemonStartIntentStore(credential).isSuspended(), /private owned directory/);
  assert.deepEqual(fs.readdirSync(target), []);
});

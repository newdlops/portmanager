import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentControllerTokenMatches, ensureAgentControllerToken, ensureAgentNetworkToken,
  getAgentNetworkTokenPath, readAgentControllerToken } from "../../src/agent/agent-authorization";

test("controller and network credentials are private, stable and distinct", context => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pm-auth-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controllerPath = path.join(directory, "private", "controller.key");
  const controller = ensureAgentControllerToken(controllerPath);
  assert.match(controller, /^[0-9a-f]{64}$/);
  assert.equal(ensureAgentControllerToken(controllerPath), controller);
  assert.equal(fs.statSync(controllerPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(controllerPath)).mode & 0o777, 0o700);
  const a = ensureAgentNetworkToken("fixture", "network-a", controllerPath);
  const b = ensureAgentNetworkToken("fixture", "network-b", controllerPath);
  assert.equal(ensureAgentNetworkToken("fixture", "network-a", controllerPath), a);
  assert.notEqual(a, b);
  assert.notEqual(a, controller);
  assert.equal(agentControllerTokenMatches(controller, a), false);
  assert.equal(agentControllerTokenMatches(controller, controller), true);
  assert.equal(agentControllerTokenMatches("invalid", controller), false);
  for (const supplied of [null, {}, controller + "f", controller.slice(1), controller.toUpperCase()]) {
    assert.equal(agentControllerTokenMatches(controller, supplied), false);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(controllerPath)).sort(), ["controller.key", "controller.key.scopes"]);
  assert.equal(fs.statSync(getAgentNetworkTokenPath(controllerPath, "network-a")).mode & 0o777, 0o600);
});

test("credential reads reject symlinks, public files, invalid values and public parents", context => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pm-auth-invalid-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controllerPath = path.join(directory, "private", "controller.key");
  const controller = ensureAgentControllerToken(controllerPath);
  fs.chmodSync(controllerPath, 0o644);
  assert.throws(() => readAgentControllerToken(controllerPath), /private/);
  assert.throws(() => ensureAgentControllerToken(controllerPath), /private/);
  fs.chmodSync(controllerPath, 0o600);
  const link = path.join(directory, "link.key");
  fs.symlinkSync(controllerPath, link);
  assert.throws(() => readAgentControllerToken(link));
  fs.symlinkSync(path.dirname(controllerPath), path.join(directory, "linked-parent"));
  assert.throws(() => ensureAgentControllerToken(path.join(directory, "linked-parent", "other.key")), /symlink/);
  assert.equal(readAgentControllerToken(controllerPath), controller);
  fs.writeFileSync(controllerPath, "x".repeat(64) + "\n");
  assert.throws(() => readAgentControllerToken(controllerPath), /Invalid/);
  fs.writeFileSync(controllerPath, controller + "\n");
  fs.chmodSync(path.dirname(controllerPath), 0o755);
  assert.throws(() => readAgentControllerToken(controllerPath), /directory.*private/);
});

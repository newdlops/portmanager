import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canRunNativeAgentBinary } from "../../src/platform/process/native-executable";

const children = require("node:child_process") as typeof import("node:child_process");
const parserExit = { status: 1, signal: null, error: undefined, stdout: "", stderr: "" };
const timedOut = { ...parserExit, status: null, signal: "SIGTERM",
  error: Object.assign(new Error("parser probe timed out"), { code: "ETIMEDOUT" }) };

/** A matching executable header lets tests isolate the actual loader verdict boundary. */
function executableFixture(t: import("node:test").TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-parser-verdict-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "agent");
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0xcffaedfe, 0);
  header.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  fs.writeFileSync(file, header, { mode: 0o700 });
  return file;
}

test("native parser retries a timeout only after requiring a successful parser verdict", {
  skip: process.platform === "win32",
}, t => {
  const file = executableFixture(t);
  let calls = 0;
  t.mock.method(children, "spawnSync", (executable: string, args: string[], options: { timeout: number }) => {
    assert.equal(executable, file);
    assert.deepEqual(args, ["--probe"]);
    assert.equal(options.timeout, 1000);
    return calls++ === 0 ? timedOut : parserExit;
  });
  assert.equal(canRunNativeAgentBinary(file), true);
  assert.equal(calls, 2);
});

test("native parser never accepts repeated timeouts, loader errors or a wrong exit contract", {
  skip: process.platform === "win32",
}, t => {
  const file = executableFixture(t);
  let replies: unknown[] = [];
  let calls = 0;
  t.mock.method(children, "spawnSync", () => { calls++; return replies.shift(); });
  for (const [results, expectedCalls] of [
    [[timedOut, timedOut], 2],
    [[timedOut, { ...parserExit, stderr: "dyld: incompatible architecture" }], 2],
    [[{ ...timedOut, stderr: "dyld: incompatible architecture" }], 1],
    [[{ ...parserExit, status: 0 }], 1],
    [[{ ...parserExit, error: Object.assign(new Error("denied"), { code: "EACCES" }) }], 1],
  ] as const) {
    replies = [...results]; calls = 0;
    assert.equal(canRunNativeAgentBinary(file), false);
    assert.equal(calls, expectedCalls);
  }
});

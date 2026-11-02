import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { stopRefreshClient } from "./native-hook-refresh-fixture";

/** A signalled child leaves exitCode null even after its exit event has fired. */
test("hook refresh cleanup settles for a child already terminated by signal", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGKILL");
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      stopRefreshClient(child, 100),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("cleanup did not settle after the child's signal exit")), 300);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

/** The live-child branch must still signal and reap its own child. */
test("hook refresh cleanup terminates a live child before its deadline", async (context) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  context.after(() => stopRefreshClient(child));
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await stopRefreshClient(child, 1_000);
  assert.equal(child.signalCode, "SIGKILL");
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildSecureLocalBrowserArgs,
  openUrlWithSecureLocalOrigin,
  secureLocalOriginForUrl,
} from "../../src/platform/browser-opener";

/**
 * Browser opener tests avoid launching real Chrome. They pin the command-line
 * contract that makes Port Manager's local DNS aliases usable as secure origins.
 */

test("extracts secure origins only for local development HTTP URLs", () => {
  assert.equal(secureLocalOriginForUrl("http://captainprod2:8004/path"), "http://captainprod2:8004");
  assert.equal(secureLocalOriginForUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(secureLocalOriginForUrl("http://127.106.129.94:8004"), "http://127.106.129.94:8004");
  assert.equal(secureLocalOriginForUrl("http://[::1]:3000/graphql"), "http://[::1]:3000");
  assert.equal(secureLocalOriginForUrl("https://captainprod2:8004"), undefined);
  assert.equal(secureLocalOriginForUrl("http://example.com"), undefined);
});

test("builds Chrome secure-context args for the exact local origin", () => {
  const args = buildSecureLocalBrowserArgs(
    "http://captainprod2:8004/admin",
    "http://captainprod2:8004",
    "/tmp/pm-profile",
  );

  assert.deepEqual(args, [
    "--user-data-dir=/tmp/pm-profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "--unsafely-treat-insecure-origin-as-secure=http://captainprod2:8004",
    "http://captainprod2:8004/admin",
  ]);
});

test("opens local URLs with a dedicated Chrome profile and secure-origin flag", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-browser-opener-"));
  const calls: { command: string; args: readonly string[] }[] = [];

  try {
    const opened = await openUrlWithSecureLocalOrigin("http://captainprod2:8004/admin", {
      userDataRoot: tempDir,
      executableCandidates: ["chrome"],
      spawnBrowser: async (command, args) => {
        calls.push({ command, args });
        return true;
      },
    });

    assert.equal(opened, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "chrome");
    assert.equal(
      calls[0]!.args.some(
        (arg) => arg === "--unsafely-treat-insecure-origin-as-secure=http://captainprod2:8004",
      ),
      true,
    );
    assert.equal(calls[0]!.args.at(-1), "http://captainprod2:8004/admin");
    assert.equal(fs.readdirSync(tempDir).length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

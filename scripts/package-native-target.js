#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SUPPORTED_TARGETS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);

/**
 * Packages or publishes exactly one Marketplace target and forwards that target
 * to the native build. This prevents a generic VSIX from inheriting binaries
 * produced by whichever developer machine happened to run `vsce`.
 */

const operation = process.argv[2] ?? "package";
if (operation !== "package" && operation !== "publish") {
  throw new Error(`Unsupported vsce operation: ${operation}`);
}
if (process.env.PORT_MANAGER_NATIVE_OUTPUT_DIR !== undefined) {
  throw new Error("PORT_MANAGER_NATIVE_OUTPUT_DIR is test-only and must be unset while packaging a VSIX.");
}

const inferredTarget = (() => {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  return undefined;
})();
const target = process.argv[3] ?? inferredTarget;

if (target === undefined) {
  throw new Error(`Port Manager cannot package native artifacts for ${process.platform}-${process.arch}.`);
}
if (!SUPPORTED_TARGETS.has(target)) {
  throw new Error(`Unsupported Port Manager package target: ${target}.`);
}

const targetPlatform = target.split("-", 1)[0];
if (targetPlatform !== process.platform) {
  throw new Error(`Target ${target} must be packaged on ${targetPlatform}, not ${process.platform}.`);
}
if (process.platform === "linux" && !target.endsWith(process.arch === "x64" ? "-x64" : `-${process.arch}`)) {
  throw new Error(`Linux target ${target} requires a matching build runner architecture.`);
}

const root = path.resolve(__dirname, "..");
const vscePath = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
const result = spawnSync(vscePath, [operation, "--target", target], {
  cwd: root,
  env: { ...process.env, PORT_MANAGER_NATIVE_TARGET: target },
  stdio: "inherit",
});

if (result.error !== undefined) {
  throw result.error;
}
process.exit(result.status ?? 1);

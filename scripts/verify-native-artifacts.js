#!/usr/bin/env node
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Release gate for native artifacts. Presence alone is insufficient: every
 * helper must match the VSIX target and macOS binaries must retain the declared
 * deployment baseline instead of the release machine's current SDK version.
 */

const root = path.resolve(__dirname, "..");
const nativeDirectory = process.env.PORT_MANAGER_NATIVE_OUTPUT_DIR ?? path.join(root, "media", "native");
const inferredTarget = (() => {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  return undefined;
})();
const target = process.argv[2] ?? process.env.PORT_MANAGER_NATIVE_TARGET ?? inferredTarget;
if (target === undefined) {
  throw new Error(`Cannot infer native artifact target for ${process.platform}-${process.arch}.`);
}

const commonHelpers = [
  "portmanager_agent",
  "portmanager_container_map",
  "portmanager_docker_shim",
  "portmanager_host_exposure_proxy",
  "portmanager_process_lookup",
  "portmanager_process_tracker",
  "portmanager_tcp_router",
  "portmanager_tty_input",
];
const expected = target.startsWith("darwin-")
  ? ["libportmanager_hook.dylib", "portmanager_asdf_shim", "portmanager_process_scope_shim", ...commonHelpers]
  : ["libportmanager_hook.so", ...commonHelpers];
const expectedArchitectures = target.endsWith("-arm64") ? ["arm64", "aarch64"] : ["x86_64", "x86-64"];

for (const name of expected) {
  const artifactPath = path.join(nativeDirectory, name);
  fs.accessSync(artifactPath, fs.constants.R_OK | fs.constants.X_OK);
  const fileDescription = execFileSync("file", [artifactPath], { encoding: "utf8" });
  const normalizedDescription = fileDescription.toLowerCase();
  if (!expectedArchitectures.some((architecture) => normalizedDescription.includes(architecture))) {
    throw new Error(`${name} does not match ${target}: ${fileDescription.trim()}`);
  }

  if (target.startsWith("darwin-")) {
    const loadCommands = execFileSync("otool", ["-l", artifactPath], { encoding: "utf8" });
    const minVersions = [...loadCommands.matchAll(/\bminos\s+([0-9.]+)/g)].map((match) => match[1]);
    const deploymentTarget = process.env.PORT_MANAGER_MACOS_DEPLOYMENT_TARGET ?? "11.0";
    if (minVersions.length === 0 || minVersions.some((version) => compareVersions(version, deploymentTarget) > 0)) {
      throw new Error(`${name} requires macOS ${minVersions.join(", ") || "unknown"}; expected <= ${deploymentTarget}.`);
    }
    execFileSync("codesign", ["--verify", "--strict", artifactPath], { stdio: "ignore" });
  }
}

const incompatibleHook = target.startsWith("darwin-") ? "libportmanager_hook.so" : "libportmanager_hook.dylib";
if (fs.existsSync(path.join(nativeDirectory, incompatibleHook))) {
  throw new Error(`Stale native hook must not be packaged for ${target}: ${incompatibleHook}`);
}

if (target === inferredTarget) {
  const agentPath = path.join(nativeDirectory, "portmanager_agent");
  const hookPath = path.join(
    nativeDirectory,
    target.startsWith("darwin-") ? "libportmanager_hook.dylib" : "libportmanager_hook.so",
  );
  const environment = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1" };
  delete environment.DYLD_INSERT_LIBRARIES;
  delete environment.LD_PRELOAD;
  environment[target.startsWith("darwin-") ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"] = hookPath;
  const loaderProbe = spawnSync(agentPath, ["--probe"], {
    env: environment,
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 256 * 1024,
  });
  const loaderError = /cannot be preloaded|wrong elf class|image not found|incompatible architecture|dyld:/i.test(
    loaderProbe.stderr ?? "",
  );
  if (loaderProbe.error !== undefined || loaderProbe.signal !== null || loaderProbe.status !== 1 || loaderError) {
    const detail = loaderProbe.error?.message || loaderProbe.stderr?.trim() || `status ${loaderProbe.status}`;
    throw new Error(`Native agent/hook loader probe failed for ${target}: ${detail}`);
  }
}

process.stdout.write(`Verified ${expected.length} native artifacts for ${target}.\n`);

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

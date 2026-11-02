import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureNetworkNamespaceScaffold, networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

/** Opt-in real tool check: no package installation, downloads, or user configuration writes. */
test("real hardened uv inherits its dotenv values before the hooked child applies network overrides", {
  skip: process.platform !== "darwin" || !process.env.PORT_MANAGER_TEST_REAL_UV_PATH || !process.env.PORT_MANAGER_TEST_REAL_PYTHON_PATH,
  timeout: 45_000,
}, context => {
  const repo = path.resolve(__dirname, "../../..");
  const uv = fs.realpathSync(process.env.PORT_MANAGER_TEST_REAL_UV_PATH!);
  const python = fs.realpathSync(process.env.PORT_MANAGER_TEST_REAL_PYTHON_PATH!);
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", uv], { encoding: "utf8" });
  assert.equal(signature.status, 0);
  assert.match(signature.stderr, /flags=0x[0-9a-f]+\([^\n]*runtime/);
  const loader = require("node:module");
  const original = loader._load;
  loader._load = (request: string, parent: NodeModule, main: boolean) => request === "vscode" ? {} : original(request, parent, main);
  let prepare: typeof import("../../src/extension/terminal-hook-environment").prepareRuntimeShimLauncherDirectory;
  try { ({ prepareRuntimeShimLauncherDirectory: prepare } = require("../../src/extension/terminal-hook-environment")); }
  finally { loader._load = original; }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-real-uv-env-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = path.join(root, "tools");
  fs.mkdirSync(tools);
  fs.symlinkSync(uv, path.join(tools, "uv"));
  fs.symlinkSync(python, path.join(tools, "python"));
  const network = { id: "uv-env-audit", name: "uv audit" };
  fs.writeFileSync(path.join(root, ".env"), "PM_AUDIT_VALUE=root\n");
  ensureNetworkNamespaceScaffold(root, network.id, network.name, [network]);
  const settings = networkNamespacePaths(root, network.id);
  fs.writeFileSync(path.join(settings.filesDirectory, ".env"), "PM_AUDIT_VALUE=mirror\n");
  fs.writeFileSync(settings.envFilePath, "# initially no overlay\n");
  const shims = prepare!(path.join(root, "extension"), path.join(repo, "media/native/portmanager_asdf_shim"), undefined, { force: true })!;
  const script = 'import json,os; print(json.dumps({"inherited":os.getenv("PM_AUDIT_VALUE"),"file":open(".env").read().strip()}))';
  const environment: NodeJS.ProcessEnv = {
    ...process.env, PATH: [shims, tools, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    PORT_MANAGER_RUNTIME_SHIM_DIR: shims,
    PORT_MANAGER_DYLD_INSERT_LIBRARIES: path.join(repo, "media/native/libportmanager_hook.dylib"),
    PORT_MANAGER_NETWORK_ID: network.id, PORT_MANAGER_NETWORK_NAME: network.name, PORT_MANAGER_HOOK: "1",
    UV_ENV_FILE: ".env", UV_NO_ENV_FILE: "0", UV_CACHE_DIR: path.join(root, "uv-cache"),
  };
  for (const key of ["DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "PORT_MANAGER_NETWORK_ENV_APPLIED", "PM_AUDIT_VALUE"]) delete environment[key];
  const run = () => JSON.parse(execFileSync(path.join(shims, "uv"), ["run", "--no-config", "--offline", "--no-project", "--no-python-downloads", "--python", python, "python", "-c", script], {
    cwd: root, env: environment, encoding: "utf8", timeout: 20_000,
  }).trim());
  assert.deepEqual(run(), { inherited: "root", file: "PM_AUDIT_VALUE=mirror" });
  fs.writeFileSync(settings.envFilePath, "PM_AUDIT_VALUE=overlay\n");
  assert.deepEqual(run(), { inherited: "overlay", file: "PM_AUDIT_VALUE=mirror" });
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "PM_AUDIT_VALUE=root\n");
  context.diagnostic(execFileSync(uv, ["--version"], { encoding: "utf8" }).trim());
});

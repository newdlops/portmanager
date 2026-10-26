import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildUvRunPreloadRepairFunctions,
  NATIVE_SH_C_PRELOAD_PREAMBLE,
  UV_RUN_PRELOAD_TRAMPOLINE,
} from "../../src/extension/uv-run-preload-repair";

/** terminal-hook-environment imports VS Code types only; an empty module stands in for it. */
function loadTerminalHookEnvironment(): typeof import("../../src/extension/terminal-hook-environment") {
  const loader = require("node:module") as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const original = loader._load;
  loader._load = (request, parent, isMain) => request === "vscode" ? {} : original(request, parent, isMain);
  try { return require(path.resolve(__dirname, "../../src/extension/terminal-hook-environment.js")); }
  finally { loader._load = original; }
}

test("uv run trampoline is the native hook's sh -c preload repair", () => {
  const nativeHookSource = fs.readFileSync(path.resolve(__dirname, "../../../native/hook/portmanager_hook.c"), "utf8");
  const literal = /#define PM_SH_C_PREAMBLE \\\s*\n\s*("(?:[^"\\]|\\.)*")/.exec(nativeHookSource)?.[1];

  assert.notEqual(literal, undefined, "PM_SH_C_PREAMBLE must stay a single string literal");
  assert.equal(NATIVE_SH_C_PRELOAD_PREAMBLE, JSON.parse(literal!), "the uv run repair must not drift from the native sh -c repair");
  assert.equal(UV_RUN_PRELOAD_TRAMPOLINE, `${NATIVE_SH_C_PRELOAD_PREAMBLE}exec "$@"`);
});

/*
 * Checked on the predicate itself: whether dyld then ignores a stale DYLD value
 * for a hardened binary depends on SIP, which is off on CI macOS runners.
 */
test("uv run preload repair stays off without a readable hook library or with the hook disabled", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-uv-run-enabled-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = path.join(root, "libfixture-preload.dylib");
  fs.writeFileSync(library, "");
  const enabled = (env: NodeJS.ProcessEnv) =>
    spawnSync("/bin/sh", ["-c", `${buildUvRunPreloadRepairFunctions()}\n__pm_uv_preload_repair_enabled`], {
      env: { PATH: "/usr/bin:/bin", ...env },
    }).status === 0;

  assert.equal(enabled({ PORT_MANAGER_DYLD_INSERT_LIBRARIES: library, PORT_MANAGER_HOOK: "1" }), true);
  assert.equal(
    enabled({ PORT_MANAGER_DYLD_INSERT_LIBRARIES: path.join(root, "missing.dylib"), PORT_MANAGER_HOOK: "1" }),
    false,
    "a hint left by an upgraded extension must not reach dyld, which aborts the child before main()",
  );
  assert.equal(enabled({ PORT_MANAGER_DYLD_INSERT_LIBRARIES: library, PORT_MANAGER_HOOK: "0" }), false);
  assert.equal(enabled({ PORT_MANAGER_DYLD_INSERT_LIBRARIES: library, PORT_MANAGER_HOOK_DISABLED: "1" }), false);
  assert.equal(enabled({}), false);
});

/** A hardened uv strips DYLD_* from itself and its children; the shim must hand the hook to the command uv runs. */
test("uv shim restores the preload for commands run by a preload-dropping uv", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, context => {
  const { prepareRuntimeShimLauncherDirectory } = loadTerminalHookEnvironment();
  const root = fs.realpathSync(fs.mkdtempSync(path.join("/private/tmp", "pm-uv-run-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureSource = path.resolve(__dirname, "../../../test/unit/uv-run-preload-repair-fixture.c");
  const hardenedTools = path.join(root, "hardened-tools");
  const plainTools = path.join(root, "plain-tools");
  const venvBin = path.join(root, "venv", "bin");
  for (const directory of [hardenedTools, plainTools, venvBin, path.join(root, "preload")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  execFileSync("cc", [fixtureSource, "-o", path.join(hardenedTools, "uv")], { timeout: 30_000 });
  execFileSync("codesign", ["--force", "--sign", "-", "--options", "runtime", path.join(hardenedTools, "uv")], { stdio: "pipe", timeout: 30_000 });
  fs.copyFileSync(path.join(hardenedTools, "uv"), path.join(hardenedTools, "uvx"));
  fs.chmodSync(path.join(hardenedTools, "uvx"), 0o755);
  execFileSync("cc", [fixtureSource, "-o", path.join(plainTools, "uv")], { timeout: 30_000 });
  execFileSync("cc", [fixtureSource, "-o", path.join(venvBin, "python")], { timeout: 30_000 });
  fs.copyFileSync(path.join(venvBin, "python"), path.join(venvBin, "celery"));
  fs.chmodSync(path.join(venvBin, "celery"), 0o755);
  // dyld must load whatever the trampoline restores; an empty dylib keeps the children unhooked but observable.
  const preload = path.join(root, "preload", "libfixture-preload.dylib");
  execFileSync("cc", ["-dynamiclib", "-x", "c", "-", "-o", preload], { input: "int pm_uv_fixture_preload;\n", timeout: 30_000 });
  const launcher = path.resolve(__dirname, "../../../media/native/portmanager_asdf_shim");
  const active = prepareRuntimeShimLauncherDirectory(path.join(root, "extension"), launcher, undefined, { force: true })!;
  fs.writeFileSync(path.join(root, "manage.py"), "print('django')\n");
  fs.writeFileSync(path.join(root, "inline.py"), "# /// script\n# dependencies = []\n# ///\nprint('isolated')\n");
  const argsFile = path.join(root, "forwarded-args");

  function runShim(command: string, args: string[], tools = hardenedTools, extraEnv: NodeJS.ProcessEnv = {}) {
    fs.rmSync(argsFile, { force: true });
    const result = spawnSync(path.join(active, command), args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        // uv puts the environment's bin directory first; the shim directory follows, as in a hooked terminal.
        PATH: [venvBin, active, tools, "/usr/bin", "/bin"].join(":"),
        PORT_MANAGER_RUNTIME_SHIM_DIR: active,
        PORT_MANAGER_DYLD_INSERT_LIBRARIES: preload,
        PORT_MANAGER_HOOK: "1",
        PM_FIXTURE_ARGS_FILE: argsFile,
        ...extraEnv,
      },
    });
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
    const forwarded = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").split("\0").slice(0, -1) : undefined;
    return { forwarded, stdout: result.stdout, stderr: result.stderr };
  }
  const trampoline = ["/bin/sh", "-c", UV_RUN_PRELOAD_TRAMPOLINE];

  const server = runShim("uv", ["run", "python", "manage.py", "runserver", "8004"]);
  assert.deepEqual(server.forwarded, ["run", ...trampoline, "python", "python", "manage.py", "runserver", "8004"]);
  assert.equal(server.stderr, "");
  const report = server.stdout.trim().split("\n");
  assert.equal(report[0], `preload=${preload}`, "the command must start with the hook restored after uv dropped it");
  assert.equal(report[1]?.split(":")[0], `path=${active}`, "the runtime shim directory must lead PATH so later launches stay repaired");
  assert.deepEqual(report.slice(2), ["arg=manage.py", "arg=runserver", "arg=8004"], "the environment's python must receive uv's arguments unchanged");

  assert.deepEqual(
    runShim("uv", ["--no-cache", "run", "--no-sync", "--env-file", ".env", "--", "python", "-c", "pass"]).forwarded,
    ["--no-cache", "run", "--no-sync", "--env-file", ".env", "--", ...trampoline, "python", "python", "-c", "pass"],
    "known options keep their values; the command after -- is the one repaired",
  );
  assert.deepEqual(
    runShim("uv", ["run", "-p3.12", "--with=httpx", "celery", "worker"]).forwarded,
    ["run", "-p3.12", "--with=httpx", ...trampoline, "celery", "celery", "worker"],
  );
  const moduleRun = runShim("uv", ["-q", "run", "-m", "http.server", "8000"]);
  assert.deepEqual(moduleRun.forwarded, ["-q", "run", ...trampoline, "python", "python", "-m", "http.server", "8000"]);
  assert.deepEqual(moduleRun.stdout.trim().split("\n").slice(2), ["arg=-m", "arg=http.server", "arg=8000"]);
  assert.deepEqual(
    runShim("uv", ["run", "manage.py", "migrate"]).forwarded,
    ["run", ...trampoline, "python", "python", "manage.py", "migrate"],
    "a plain script is the project python running that file",
  );

  // Uncertain shapes keep uv's own handling and say once that they escape the network.
  for (const args of [["run", "inline.py"], ["run", "--script", "tool"], ["run", "--brand-new-option", "python"], ["run", "./bin/tool"]]) {
    const unrepaired = runShim("uv", args);
    assert.deepEqual(unrepaired.forwarded, args, `${args.join(" ")} must reach uv untouched`);
    assert.match(unrepaired.stderr, /^Port Manager: .*\/uv is signed with the hardened runtime and drops DYLD_INSERT_LIBRARIES;/);
    assert.equal(unrepaired.stdout, "");
  }

  // Nothing to repair: no rewrite, no codesign notice.
  for (const [command, args, tools, extraEnv] of [
    ["uv", ["sync", "--frozen"], hardenedTools, {}],
    ["uvx", ["ruff", "check"], hardenedTools, {}],
    ["uv", ["run", "python", "-c", "pass"], plainTools, {}],
    ["uv", ["run", "python", "-c", "pass"], hardenedTools, { PORT_MANAGER_HOOK: "0" }],
  ] as const) {
    const untouched = runShim(command, [...args], tools, extraEnv);
    assert.deepEqual(untouched.forwarded, args, `${command} ${args.join(" ")} must reach the real tool untouched`);
    assert.equal(untouched.stderr, "", `${command} ${args.join(" ")} must stay silent`);
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  buildShellProfilePostludeScript,
  buildShellProfilePreludeScript,
  getManagedShellProfilePlans,
  migrateExistingManagedShellProfiles,
  restoreShellProfileContent,
  rewriteManagedShellProfile,
  upsertManagedShellProfile,
  type ManagedShellProfileOptions,
} from "../../src/platform/process/shell-profile";

const profileOptions: ManagedShellProfileOptions = {
  preludeLine: '. "/home/user/.portmanager/portmanager-profile-pre.sh"',
  postludeLine: '. "/home/user/.portmanager/portmanager-profile-post.sh"',
  legacyLines: ['. "/home/user/.portmanager/portmanager-hook.sh"'],
};

test("zsh profiles bracket both login and interactive startup files", () => {
  assert.deepEqual(getManagedShellProfilePlans("/bin/zsh", "/home/user"), [
    { filePath: "/home/user/.zprofile" },
    { filePath: "/home/user/.zshrc" },
  ]);
  assert.deepEqual(getManagedShellProfilePlans("/bin/bash", "/home/user"), [
    { filePath: "/home/user/.bash_profile" },
    { filePath: "/home/user/.bashrc" },
  ]);

  const bashHome = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-bash-profile-"));
  fs.writeFileSync(path.join(bashHome, ".bash_login"), "export FROM_BASH_LOGIN=1\n");
  assert.deepEqual(getManagedShellProfilePlans("/bin/bash", bashHome), [
    { filePath: path.join(bashHome, ".bash_login") },
    { filePath: path.join(bashHome, ".bashrc") },
  ]);
});

test("restore shell profiles command is contributed and activation-backed", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
    readonly activationEvents?: readonly string[];
    readonly contributes?: {
      readonly commands?: ReadonlyArray<{ readonly command: string }>;
      readonly menus?: { readonly commandPalette?: ReadonlyArray<{ readonly command: string; readonly when?: string }> };
    };
  };
  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.restoreShellProfiles"), true);
  assert.equal(
    manifest.contributes?.commands?.some((command) => command.command === "portManager.restoreShellProfiles"),
    true,
  );
  assert.equal(
    manifest.contributes?.menus?.commandPalette?.some(
      (entry) => entry.command === "portManager.restoreShellProfiles" && entry.when === "false",
    ),
    false,
  );
});

test("profile migration is positioned, byte-stable, and removes exact legacy lines only", () => {
  const original = [
    "\uFEFFexport PATH=/user/bin:$PATH",
    '# user-owned variant remains: source "/home/user/.portmanager/portmanager-hook.sh"',
    '. "/home/user/.portmanager/portmanager-hook.sh"',
    "export KEEP=1",
    "",
  ].join("\r\n");

  const migrated = rewriteManagedShellProfile(original, profileOptions);
  assert.equal(migrated.startsWith(`\uFEFF# >>> Port Manager profile prelude >>>\r\n${profileOptions.preludeLine}\r\n`), true);
  assert.equal(migrated.endsWith(`${profileOptions.postludeLine}\r\n# <<< Port Manager profile activation <<<\r\n`), true);
  assert.equal(migrated.includes("export PATH=/user/bin:$PATH\r\n"), true);
  assert.equal(migrated.includes("# user-owned variant remains:"), true);
  assert.equal(migrated.includes(`\r\n${profileOptions.legacyLines[0]}\r\n`), false);
  assert.equal(rewriteManagedShellProfile(migrated, profileOptions), migrated);
});

test("restore removes only complete PM blocks and exact historical source lines", () => {
  const userBody = "export FIRST=1\n# keep me\nexport LAST=2\n";
  const installed = rewriteManagedShellProfile(
    `${userBody}${profileOptions.legacyLines[0]}\n`,
    profileOptions,
  );
  assert.equal(restoreShellProfileContent(installed, profileOptions), userBody);

  const incomplete = "# >>> Port Manager profile prelude >>>\n# user repaired this manually\n";
  assert.equal(restoreShellProfileContent(incomplete, profileOptions), incomplete);
});

test("install and restore preserve mixed line endings and an absent final newline", () => {
  const original = "export ONE=1\r\nexport TWO=2\nexport THREE=3";
  const installed = rewriteManagedShellProfile(original, profileOptions);
  assert.equal(restoreShellProfileContent(installed, profileOptions), original);

  const incompleteThenManaged = [
    "# >>> Port Manager profile prelude >>>",
    "# user content inside an incomplete marker",
    rewriteManagedShellProfile("export SAFE=1\n", profileOptions),
  ].join("\n");
  const restored = restoreShellProfileContent(incompleteThenManaged, profileOptions);
  assert.match(restored, /user content inside an incomplete marker/);
  assert.match(restored, /export SAFE=1/);
});

test("invalid UTF-8 profile bytes are rejected without modification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-shell-invalid-"));
  const profile = path.join(root, ".zshrc");
  const invalid = Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0xff, 0x0a]);
  fs.writeFileSync(profile, invalid);
  await assert.rejects(() => upsertManagedShellProfile(profile, profileOptions));
  assert.deepEqual(fs.readFileSync(profile), invalid);
});

test("background migration requires PM evidence and never creates missing profiles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-shell-migration-"));
  const zprofile = path.join(root, ".zprofile");
  const zshrc = path.join(root, ".zshrc");
  const missing = path.join(root, ".zlogin");
  fs.writeFileSync(zprofile, "export USER_PROFILE=1\n");
  fs.writeFileSync(zshrc, `${profileOptions.legacyLines[0]}\nexport USER_RC=1\n`);

  const migrated = await migrateExistingManagedShellProfiles(
    [{ filePath: zprofile }, { filePath: zshrc }, { filePath: missing }],
    profileOptions,
  );
  assert.deepEqual(migrated, [zprofile, zshrc]);
  assert.equal(fs.readFileSync(zprofile, "utf8").includes(profileOptions.preludeLine), true);
  assert.equal(fs.readFileSync(zshrc, "utf8").includes(profileOptions.legacyLines[0]), false);
  assert.equal(fs.existsSync(missing), false);

  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-shell-fresh-"));
  const fresh = path.join(freshRoot, ".zshrc");
  fs.writeFileSync(fresh, "export FRESH=1\n");
  assert.deepEqual(await migrateExistingManagedShellProfiles([{ filePath: fresh }], profileOptions), []);
  assert.equal(fs.readFileSync(fresh, "utf8"), "export FRESH=1\n");
});

test("prelude uses builtins, suspends dynamic PM activation, and postlude restores", (t) => {
  if (!fs.existsSync("/bin/zsh")) {
    t.skip("zsh is unavailable");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-shell-profile-"));
  const hookLibrary = path.join(root, "extension", "media", "native", "libportmanager_hook.dylib");
  const staleHook = path.join(root, "old", "media", "native", "libportmanager_hook.dylib");
  const runtimeShims = path.join(root, "runtime-shims");
  const externalRuntimeShims = path.join(root, "external-runtime-shims");
  const bashRestore = path.join(root, "portmanager-bash-env.sh");
  const externalBashRestore = path.join(root, "external-portmanager-bash-env.sh");
  const preludePath = path.join(root, "pre.sh");
  const hookPath = path.join(root, "hook.sh");
  const postludePath = path.join(root, "post.sh");
  const prelude = buildShellProfilePreludeScript({
    hookLibraryPath: hookLibrary,
    runtimeShimDirectory: externalRuntimeShims,
    shellEnvRestorePath: externalBashRestore,
  });
  const postlude = buildShellProfilePostludeScript(hookPath);

  assert.doesNotMatch(prelude, /\b(?:grep|tail|printf|awk|sed|stat)\b/);
  fs.writeFileSync(preludePath, prelude);
  fs.writeFileSync(
    hookPath,
    `export PORT_MANAGER_HOOK=1\nexport DYLD_INSERT_LIBRARIES="${hookLibrary}:\${DYLD_INSERT_LIBRARIES:-}"\nexport PATH="${runtimeShims}:$PATH"\n`,
  );
  fs.writeFileSync(postludePath, postlude);

  const command = [
    `source ${shellQuote(preludePath)}`,
    'print -r -- "during=$PORT_MANAGER_HOOK|$PATH|${DYLD_INSERT_LIBRARIES:-}|${LD_PRELOAD:-}|${BASH_ENV:-}|$PORT_MANAGER_NETWORK_ID|${PORT_MANAGER_PRELOAD_REPAIR:-}"',
    `source ${shellQuote(postludePath)}`,
    'print -r -- "nested=$PORT_MANAGER_HOOK"',
    `source ${shellQuote(preludePath)}`,
    `source ${shellQuote(postludePath)}`,
    'print -r -- "after=$PORT_MANAGER_HOOK|$PATH|${DYLD_INSERT_LIBRARIES:-}"',
  ].join("; ");
  const result = spawnSync("/bin/zsh", ["-dfc", command], {
    encoding: "utf8",
    env: {
      HOME: root,
      PATH: `${externalRuntimeShims}:${runtimeShims}:/user/bin:/usr/bin:/bin`,
      DYLD_INSERT_LIBRARIES: `${hookLibrary}:${staleHook}:/user/lib.dylib`,
      LD_PRELOAD: `/user/lib.so:${hookLibrary}`,
      BASH_ENV: bashRestore,
      PORT_MANAGER_PREV_BASH_ENV: "/user/bash-env.sh",
      PORT_MANAGER_HOOK: "1",
      PORT_MANAGER_HOOK_DISABLED: "",
      PORT_MANAGER_RUNTIME_SHIM_DIR: runtimeShims,
      PORT_MANAGER_RUNTIME_SHIM_READY: "1",
      PORT_MANAGER_PRELOAD_REPAIR: "1",
      PORT_MANAGER_NETWORK_ID: "network-a",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const [during, nested, after] = result.stdout.trim().split("\n");
  // macOS strips DYLD_* while launching the protected /bin/zsh fixture; LD_PRELOAD
  // proves the same list filter preserves unrelated entries.
  assert.equal(during, "during=0|/user/bin:/usr/bin:/bin||/user/lib.so|/user/bash-env.sh|network-a|1");
  assert.equal(nested, "nested=1");
  assert.equal(after, `after=1|${runtimeShims}:/user/bin:/usr/bin:/bin|${hookLibrary}:`);
});

test("managed zsh login profiles keep user initialization clean and prompt commands routed", (t) => {
  if (!fs.existsSync("/bin/zsh")) {
    t.skip("zsh is unavailable");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-zsh-login-"));
  const preludePath = path.join(root, "pre.sh");
  const postludePath = path.join(root, "post.sh");
  const hookPath = path.join(root, "hook.sh");
  const runtimeShims = path.join(root, "runtime-shims");
  const hookLibrary = path.join(root, "media", "native", "libportmanager_hook.dylib");
  const options: ManagedShellProfileOptions = {
    preludeLine: `. ${shellQuote(preludePath)}`,
    postludeLine: `. ${shellQuote(postludePath)}`,
    legacyLines: [`. ${shellQuote(hookPath)}`],
  };

  fs.writeFileSync(
    preludePath,
    buildShellProfilePreludeScript({ hookLibraryPath: hookLibrary, runtimeShimDirectory: runtimeShims }),
  );
  fs.writeFileSync(
    hookPath,
    `export PORT_MANAGER_HOOK=1\ncase ":$PATH:" in *":${runtimeShims}:"*) ;; *) export PATH="${runtimeShims}:$PATH" ;; esac\n`,
  );
  fs.writeFileSync(postludePath, buildShellProfilePostludeScript(hookPath));
  fs.writeFileSync(
    path.join(root, ".zprofile"),
    rewriteManagedShellProfile('ZPROFILE_STATE="$PORT_MANAGER_HOOK|$PATH"\n', options),
  );
  fs.writeFileSync(
    path.join(root, ".zshrc"),
    rewriteManagedShellProfile('ZSHRC_STATE="$PORT_MANAGER_HOOK|$PATH"\n', options),
  );

  const result = spawnSync(
    "/bin/zsh",
    ["-d", "-lic", 'print -rl -- "zprofile=$ZPROFILE_STATE" "zshrc=$ZSHRC_STATE" "final=$PORT_MANAGER_HOOK|$PATH"'],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        ZDOTDIR: root,
        PATH: `${runtimeShims}:/usr/bin:/bin`,
        PORT_MANAGER_HOOK: "1",
        PORT_MANAGER_RUNTIME_SHIM_DIR: runtimeShims,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "zprofile=0|/usr/bin:/bin",
    "zshrc=0|/usr/bin:/bin",
    `final=1|${runtimeShims}:/usr/bin:/bin`,
  ]);
});

test("login bash keeps a sourced bashrc clean until bash_profile finishes", (t) => {
  if (!fs.existsSync("/bin/bash")) {
    t.skip("bash is unavailable");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-bash-login-"));
  const preludePath = path.join(root, "pre.sh");
  const postludePath = path.join(root, "post.sh");
  const hookPath = path.join(root, "hook.sh");
  const runtimeShims = path.join(root, "runtime-shims");
  const hookLibrary = path.join(root, "media", "native", "libportmanager_hook.dylib");
  const options: ManagedShellProfileOptions = {
    preludeLine: `. ${shellQuote(preludePath)}`,
    postludeLine: `. ${shellQuote(postludePath)}`,
    legacyLines: [`. ${shellQuote(hookPath)}`],
  };

  fs.writeFileSync(
    preludePath,
    buildShellProfilePreludeScript({ hookLibraryPath: hookLibrary, runtimeShimDirectory: runtimeShims }),
  );
  fs.writeFileSync(
    hookPath,
    `export PORT_MANAGER_HOOK=1\ncase ":$PATH:" in *":${runtimeShims}:"*) ;; *) export PATH="${runtimeShims}:$PATH" ;; esac\n`,
  );
  fs.writeFileSync(postludePath, buildShellProfilePostludeScript(hookPath));
  fs.writeFileSync(
    path.join(root, ".bashrc"),
    rewriteManagedShellProfile('BASHRC_STATE="$PORT_MANAGER_HOOK|$PATH"\n', options),
  );
  fs.writeFileSync(
    path.join(root, ".bash_profile"),
    rewriteManagedShellProfile(
      '. "$HOME/.bashrc"\nBASH_PROFILE_AFTER_RC="$PORT_MANAGER_HOOK|$PATH"\n',
      options,
    ),
  );

  const result = spawnSync(
    "/bin/bash",
    ["-lic", 'printf "%s\\n" "bashrc=$BASHRC_STATE" "profile=$BASH_PROFILE_AFTER_RC" "final=$PORT_MANAGER_HOOK|$PATH"'],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: `${runtimeShims}:/usr/bin:/bin`,
        PORT_MANAGER_HOOK: "1",
        PORT_MANAGER_RUNTIME_SHIM_DIR: runtimeShims,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const [bashrcState, profileState, finalState] = result.stdout.trim().split("\n");
  assert.equal(bashrcState.startsWith("bashrc=0|"), true);
  assert.equal(bashrcState.includes(runtimeShims), false);
  assert.equal(profileState.startsWith("profile=0|"), true);
  assert.equal(profileState.includes(runtimeShims), false);
  assert.equal(finalState.startsWith(`final=1|${runtimeShims}:`), true);
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

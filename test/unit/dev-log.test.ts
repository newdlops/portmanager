import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEV_LOG_ENV,
  DEV_LOG_MAX_BYTES,
  devLog,
  devLogEnabled,
  devLogPathAtCapacity,
} from "../../src/platform/dev-log";

/** The development endpoint is opt-in because it runs in every routed child. */
test("development logging is disabled by default in the extension manifest", () => {
  const manifestPath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    readonly contributes?: {
      readonly configuration?: {
        readonly properties?: Record<string, { readonly default?: unknown }>;
      };
    };
  };

  assert.equal(manifest.contributes?.configuration?.properties?.["portManager.developmentLogPath"]?.default, "");
});

test("TypeScript development logging stops at the shared size limit", (context) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-dev-log-"));
  const logPath = path.join(tempDirectory, "trace.log");
  const previousPath = process.env[DEV_LOG_ENV];

  context.after(() => {
    if (previousPath === undefined) {
      delete process.env[DEV_LOG_ENV];
    } else {
      process.env[DEV_LOG_ENV] = previousPath;
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  process.env[DEV_LOG_ENV] = logPath;
  assert.equal(devLogEnabled(), true);
  devLog("test", "before-cap");
  assert.match(fs.readFileSync(logPath, "utf8"), /\[test pid=\d+\] before-cap\n$/);

  // truncate creates a sparse file, so the boundary is tested without writing
  // or allocating 64 MiB of fixture data.
  fs.truncateSync(logPath, DEV_LOG_MAX_BYTES);
  assert.equal(devLogPathAtCapacity(logPath), true);
  assert.equal(devLogEnabled(), false);
  devLog("test", "after-cap");
  assert.equal(fs.statSync(logPath).size, DEV_LOG_MAX_BYTES);
});

test("native development logging checks the same bounded sink", () => {
  const sourcePath = path.resolve(__dirname, "../../../native/shared/pm_dev_log.c");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("PM_DEV_LOG_MAX_BYTES ((off_t)64 * 1024 * 1024)"), true);
  assert.equal(source.includes("pm_dev_log_path_has_capacity"), true);
  assert.equal(source.includes("fstat(fd, &file_stat)"), true);
  assert.equal(source.includes("PM_DEV_LOG_MAX_BYTES - file_stat.st_size"), true);
});

test("built native hook leaves a capped development log unchanged", (context) => {
  const libraryName = process.platform === "darwin" ? "libportmanager_hook.dylib" : "libportmanager_hook.so";
  const hookPath = path.resolve(__dirname, "../../../media/native", libraryName);
  if ((process.platform !== "darwin" && process.platform !== "linux") || !fs.existsSync(hookPath)) {
    context.skip("native hook is not built for this platform");
    return;
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-dev-log-"));
  const logPath = path.join(tempDirectory, "trace.log");
  context.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
  fs.closeSync(fs.openSync(logPath, "w"));
  fs.truncateSync(logPath, DEV_LOG_MAX_BYTES);

  const preloadVariable = process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
  const preloadHintVariable =
    process.platform === "darwin" ? "PORT_MANAGER_DYLD_INSERT_LIBRARIES" : "PORT_MANAGER_LD_PRELOAD";
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>server.close());",
    ],
    {
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        TMPDIR: os.tmpdir(),
        [preloadVariable]: hookPath,
        [preloadHintVariable]: hookPath,
        PORT_MANAGER_HOOK: "1",
        PORT_MANAGER_HOOK_DISABLED: "",
        PORT_MANAGER_PRELOAD_REPAIR: "0",
        [DEV_LOG_ENV]: logPath,
        BASH_ENV: "",
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(logPath).size, DEV_LOG_MAX_BYTES);
});

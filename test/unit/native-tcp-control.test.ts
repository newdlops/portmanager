import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = path.resolve(__dirname, "../../..");

test("native control output stays bounded and preserves complete FIFO frames under partial drain",
  { skip: process.platform === "win32", timeout: 20_000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-control-output-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const fixture = path.join(directory, "fixture");
    await run("cc", ["-Wall", "-Wextra", "-Werror", "-O2", "-pthread",
      path.join(root, "test/unit/native-tcp-control-output-fixture.c"),
      path.join(root, "native/shared/pm_tcp_proxy.c"), path.join(root, "native/shared/pm_dev_log.c"),
      "-o", fixture], { timeout: 10_000 });
    const { stdout } = await run(fixture, [], { timeout: 10_000 });
    assert.deepEqual(JSON.parse(stdout), { accepted: 4096, rejected: 904, verifiedBytes: 4 * 1024 * 1024 });
  });

for (const kind of ["host", "router"]) {
  test(kind + " control backpressure preserves route deadlines, established bytes, and FIFO recovery",
    { skip: process.platform === "win32", timeout: 20_000 }, async t => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-tcp-control-"));
      t.after(() => fs.rm(directory, { recursive: true, force: true }));
      const fixture = path.join(directory, "fixture");
      await run("cc", ["-Wall", "-Wextra", "-Werror", "-O2",
        path.join(root, "test/unit/native-tcp-control-fixture.c"), "-o", fixture], { timeout: 10_000 });
      const helper = kind === "host"
        ? process.env.PORT_MANAGER_TEST_NATIVE_HOST_PROXY_PATH ?? path.join(root, "media/native/portmanager_host_exposure_proxy")
        : process.env.PORT_MANAGER_TEST_NATIVE_ROUTER_PATH ?? path.join(root, "media/native/portmanager_tcp_router");
      const env: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1" };
      delete env.DYLD_INSERT_LIBRARIES;
      delete env.LD_PRELOAD;
      const { stdout } = await run(fixture, [helper, kind], { env, timeout: 12_000 });
      const result = JSON.parse(stdout) as {
        expiredClients: number; elapsedMs: number; survived: number; lateTargets: number; recovered: number;
      };
      assert.equal(result.expiredClients, 4);
      assert.ok(result.elapsedMs < 3500, "a blocked write cannot extend route response deadlines");
      assert.equal(result.survived, 1, "the existing data plane must remain connected");
      assert.equal(result.lateTargets, 0, "late answers cannot open a target for expired clients");
      assert.equal(result.recovered, 1, "control resumption must free admission and keep framing intact");
    });
}

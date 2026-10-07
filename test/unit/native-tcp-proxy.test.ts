import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = path.resolve(__dirname, "../../..");

test("native TCP preparation has one deadline across addresses/EINTR and releases failed sockets",
  { skip: process.platform === "win32", timeout: 15_000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-tcp-setup-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "fixture");
    await run("cc", ["-Wall", "-Wextra", "-Werror", "-O2", "-pthread",
      path.join(root, "test/unit/native-tcp-proxy-fixture.c"),
      path.join(root, "native/shared/pm_dev_log.c"), "-o", executable], { timeout: 10_000 });
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    for (const mode of ["timeout", "interrupt", "addresses", "refused", "dns", "shared", "late-ready", "late-immediate"]) {
      const { stdout } = await run(executable, [mode, String(port)], {
        env: { ...process.env, PORT_MANAGER_HOOK: "0", PORT_MANAGER_PROXY_CONNECT_TIMEOUT_MS: "35" },
        timeout: 2000,
      });
      const result = JSON.parse(stdout) as {
        failures: number; elapsedMs: number; polls: number; fdDelta: number;
        dnsCalls: number; connectCalls: number; maxPollMs: number;
      };
      assert.equal(result.failures, mode === "dns" ? 6 : mode === "shared" ? 8 : 4, mode);
      assert.equal(result.fdDelta, 0, mode);
      assert.ok(result.elapsedMs < 600, mode + " must not restart its budget for each retry/address");
      if (mode !== "refused" && mode !== "shared") assert.ok(result.elapsedMs >= 120, mode + " must exercise an actual deadline");
      if (mode === "interrupt") {
        assert.equal(result.polls, 16, "each attempt has three interruptions and one final wait");
        assert.equal(result.elapsedMs, 140, "interruptions consume four original 35ms budgets");
      }
      if (mode === "addresses") {
        assert.ok(result.connectCalls >= 8, "both addresses must be attempted");
        assert.ok(result.maxPollMs <= 20, "the first address already consumed 20ms of the 35ms budget");
      }
      if (mode === "dns") {
        assert.equal(result.dnsCalls, 4, "blocked resolver jobs must stay bounded");
        assert.equal(result.connectCalls, 1, "numeric targets must bypass occupied DNS workers");
      }
      if (mode === "shared") {
        assert.equal(result.dnsCalls, 1, "matching in-flight names share one resolver job");
        assert.ok(result.elapsedMs < 200, "callers must time out before their resolver returns");
      }
    }
    const { stdout } = await run(executable, ["dns", String(port)], {
      env: { ...process.env, PORT_MANAGER_HOOK: "0", PORT_MANAGER_PROXY_CONNECT_TIMEOUT_MS: "35",
        PORT_MANAGER_PROXY_MAX_DNS_JOBS: "1" }, timeout: 2000,
    });
    const smaller = JSON.parse(stdout);
    assert.equal(smaller.dnsCalls, 1, "native OS lookups must obey the capacity reserved by their parent");
    assert.equal(smaller.failures, 6);
    assert.equal(smaller.fdDelta, 0);
  });

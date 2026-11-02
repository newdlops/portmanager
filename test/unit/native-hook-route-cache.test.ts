import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "../../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pm-route-cache-"));
const binary = path.join(temporary, "fixture");
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(PORT_MANAGER_|NEWDLOPS_PM_|DYLD_|LD_PRELOAD$)/.test(key)));

test.before(() => {
  // Clang comparison tracing measures search work without production counters.
  // Hosts with only GCC still run all routing/allocation/budget assertions.
  const hasClang = spawnSync("clang", ["--version"], { env: environment }).status === 0;
  const coverage = hasClang ? ["-fsanitize-coverage=trace-pc-guard,trace-cmp"] : [];
  const result = spawnSync(hasClang ? "clang" : "cc", ["-O1", "-pthread", ...coverage,
    path.join(root, "test/unit/native-hook-route-cache-fixture.c"),
    path.join(root, "native/shared/pm_dev_log.c"), "-o", binary, ...(process.platform === "linux" ? ["-ldl"] : [])], { env: environment, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
for (const scenario of ["expiry", "rollback", "replace", "inplace", "precedence", "hot", "pending", "concurrent", "budget", "bulk", "legacy", "eviction"]) {
  test(`native route cache ${scenario}`, () => {
    const directory = path.join(temporary, scenario);
    fs.mkdirSync(directory);
    const route = path.join(directory, "routes.network-network-probe.json");
    const result = spawnSync(binary, [scenario, route], { env: environment, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** Exercises the kernel-backed identity guard without sending any signals. */
test("native respawn identity uses process environment precedence and fails closed", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, context => {
  const root = path.resolve(__dirname, "../../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-identity-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "identity.c");
  const executable = path.join(directory, "identity");
  fs.writeFileSync(source, `#include ${JSON.stringify(path.join(root, "native/hook/portmanager_hook.c"))}
int main(int argc, char **argv) {
  char network[128];
  pid_t pid = argc > 1 ? (pid_t)strtol(argv[1], NULL, 10) : getpid();
  int result = pm_read_process_network_id(pid, network, sizeof(network));
  printf("%d:%s", result, network);
  return 0;
}
`);
  execFileSync("cc", ["-O2", "-pthread", source, path.join(root, "native/shared/pm_dev_log.c"),
    ...(process.platform === "linux" ? ["-ldl"] : []), "-o", executable], { timeout: 30_000 });
  const base = { ...process.env };
  for (const key of Object.keys(base)) {
    if (/^(PORT_MANAGER_|NEWDLOPS_PM_)/.test(key) || ["DYLD_INSERT_LIBRARIES", "LD_PRELOAD"].includes(key)) delete base[key];
  }
  const read = (values: NodeJS.ProcessEnv = {}, args: string[] = []) => execFileSync(executable, args, {
    encoding: "utf8", timeout: 3_000, env: { ...base, PORT_MANAGER_HOOK_DISABLED: "1", ...values },
  });
  assert.equal(read({ PORT_MANAGER_NETWORK_ID: "primary", PORT_MANAGER_ROUTE_TABLE_NETWORK_ID: "fallback" }), "0:primary");
  assert.equal(read({ PORT_MANAGER_ROUTE_TABLE_NETWORK_ID: "fallback", NEWDLOPS_PM_NETWORK_ID: "legacy" }), "0:fallback");
  assert.equal(read({ NEWDLOPS_PM_NETWORK_ID: "legacy" }), "0:legacy");
  assert.equal(read(), "-1:");
  assert.equal(read({ PORT_MANAGER_NETWORK_ID: "primary" }, ["2147483647"]), "-1:");
});

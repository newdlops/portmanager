import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

/**
 * End-to-end coverage for network-scoped interface isolation (native hook).
 *
 * The per-network loopback aliases live on the host-global lo0, so without the
 * hook any process can enumerate every other network's alias via getifaddrs()
 * (Node's os.networkInterfaces()). The hook interposes getifaddrs so a
 * network-scoped process sees only 127.0.0.1 and its own network alias; an
 * unscoped process still sees the full host view.
 *
 * Creating lo0 aliases needs sudo, so this reads whatever aliases already
 * exist and skips when there are too few to observe isolation. Opt-in and
 * darwin-only (the interpose is macOS/DYLD):
 *   PM_RUN_NATIVE_E2E=1 node --test out/test/unit/native-hook-getifaddrs-isolation.test.js
 */

const projectRoot = path.resolve(__dirname, "../../..");
const hookPath = path.join(projectRoot, "media/native/libportmanager_hook.dylib");
const optedIn = process.env.PM_RUN_NATIVE_E2E === "1";
const supported = optedIn && process.platform === "darwin" && fs.existsSync(hookPath);

function localLoopbackAliases(): string[] {
  return (os.networkInterfaces().lo0 ?? [])
    .filter((entry) => entry.family === "IPv4" && entry.address !== "127.0.0.1")
    .map((entry) => entry.address);
}

function hookedLoopbackView(env: Record<string, string>): Promise<string[]> {
  const script =
    'process.stdout.write(JSON.stringify((require("os").networkInterfaces().lo0||[])' +
    '.filter(e=>e.family==="IPv4").map(e=>e.address).sort()))';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      env: {
        ...process.env,
        DYLD_INSERT_LIBRARIES: hookPath,
        PORT_MANAGER_HOOK: "1",
        PORT_MANAGER_HOOK_DISABLED: "",
        BASH_ENV: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", () => {
      try {
        resolve(JSON.parse(stdout) as string[]);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("a network-scoped process sees only localhost and its own loopback alias", async (t) => {
  if (!supported) {
    t.skip("native hook not built / not darwin / not opted in");
    return;
  }
  const aliases = localLoopbackAliases();
  if (aliases.length < 2) {
    t.skip("need >=2 pre-existing lo0 aliases to observe isolation (creating them needs sudo)");
    return;
  }

  const own = aliases[0];
  const foreign = aliases[1];

  const scoped = await hookedLoopbackView({
    PORT_MANAGER_NETWORK_ID: "net-isolation-test",
    PORT_MANAGER_NETWORK_LOOPBACK_HOST: own,
  });

  assert.deepEqual(scoped, ["127.0.0.1", own].sort(), "scoped process must see only localhost + its own alias");
  assert.ok(!scoped.includes(foreign), "another network's alias must be hidden from a scoped process");
});

test("an unscoped hooked process still sees the full host loopback view", async (t) => {
  if (!supported) {
    t.skip("native hook not built / not darwin / not opted in");
    return;
  }
  const aliases = localLoopbackAliases();
  if (aliases.length < 1) {
    t.skip("need >=1 pre-existing lo0 alias to observe passthrough");
    return;
  }

  const unscoped = await hookedLoopbackView({
    PORT_MANAGER_NETWORK_ID: "",
    PORT_MANAGER_NETWORK_LOOPBACK_HOST: "",
  });

  for (const alias of aliases) {
    assert.ok(unscoped.includes(alias), `unscoped process should still see ${alias}`);
  }
});

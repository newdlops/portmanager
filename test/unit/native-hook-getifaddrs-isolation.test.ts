import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

/**
 * Child environment that carries none of the developer shell's Port Manager state.
 * A pm-integrated shell exports the global network flag, a terminal session network id
 * and an actual loopback host; inheriting any of them changes how the hook scopes the
 * child (the actual loopback counts as "own"), so each test passes only what it means.
 */
function hermeticEnv(env: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(PORT_MANAGER_|NEWDLOPS_PM_|DYLD_)/.test(key)) {
      continue;
    }
    base[key] = value;
  }
  return { ...base, BASH_ENV: "", ...env };
}

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
      env: hermeticEnv({
        DYLD_INSERT_LIBRARIES: hookPath,
        PORT_MANAGER_HOOK: "1",
        ...env,
      }),
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

/**
 * C probe that walks the raw getifaddrs() list the way native callers do.
 * Node's os.networkInterfaces() silently skips entries whose ifa_addr is NULL,
 * so it cannot tell "hidden" apart from "left in the list with a NULL address".
 * Chromium's network service does not skip them and crashes, so the probe
 * counts NULL addresses, lists lo0 IPv4 addresses, and frees the list to prove
 * freeifaddrs() still accepts what the hook returned.
 */
const INTERFACE_PROBE_SOURCE = String.raw`
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
int main(void) {
  struct ifaddrs *head = NULL;
  int entries = 0, null_addresses = 0, first = 1;
  if (getifaddrs(&head) != 0) return 2;
  printf("{\"lo0\":[");
  for (struct ifaddrs *entry = head; entry != NULL; entry = entry->ifa_next) {
    char address[INET_ADDRSTRLEN];
    entries++;
    if (entry->ifa_addr == NULL) { null_addresses++; continue; }
    if (entry->ifa_addr->sa_family != AF_INET || strcmp(entry->ifa_name, "lo0") != 0) continue;
    inet_ntop(AF_INET, &((struct sockaddr_in *)entry->ifa_addr)->sin_addr, address, sizeof address);
    printf("%s\"%s\"", first ? "" : ",", address);
    first = 0;
  }
  freeifaddrs(head);
  printf("],\"entries\":%d,\"nullAddresses\":%d}", entries, null_addresses);
  return 0;
}
`;

type InterfaceProbeResult = { lo0: string[]; entries: number; nullAddresses: number };

function compileInterfaceProbe(directory: string): string | undefined {
  const sourcePath = path.join(directory, "interface_probe.c");
  const binaryPath = path.join(directory, "interface_probe");
  fs.writeFileSync(sourcePath, INTERFACE_PROBE_SOURCE);
  const result = spawnSync("cc", ["-o", binaryPath, sourcePath], { encoding: "utf8" });
  return result.status === 0 ? binaryPath : undefined;
}

function runInterfaceProbe(binaryPath: string, env: Record<string, string>): InterfaceProbeResult {
  const result = spawnSync(binaryPath, [], { env: hermeticEnv(env), encoding: "utf8" });
  assert.equal(result.status, 0, `interface probe exited abnormally: ${result.stderr}`);
  return JSON.parse(result.stdout) as InterfaceProbeResult;
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

test("a network-scoped process gets a well-formed list with hidden aliases unlinked", (t) => {
  if (!supported) {
    t.skip("native hook not built / not darwin / not opted in");
    return;
  }
  const aliases = localLoopbackAliases();
  if (aliases.length < 2) {
    t.skip("need >=2 pre-existing lo0 aliases to observe isolation (creating them needs sudo)");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-getifaddrs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const probe = compileInterfaceProbe(directory);
  if (probe === undefined) {
    t.skip("cc is not available to build the interface probe");
    return;
  }

  const own = aliases[0];
  const hostView = runInterfaceProbe(probe, {});
  const scoped = runInterfaceProbe(probe, {
    DYLD_INSERT_LIBRARIES: hookPath,
    PORT_MANAGER_HOOK: "1",
    PORT_MANAGER_NETWORK_ID: "net-isolation-test",
    PORT_MANAGER_NETWORK_LOOPBACK_HOST: own,
  });

  assert.deepEqual(scoped.lo0.sort(), ["127.0.0.1", own].sort(), "scoped process must see only localhost + its own alias");
  assert.equal(
    scoped.nullAddresses,
    hostView.nullAddresses,
    "hidden aliases must be unlinked, not left behind with a NULL ifa_addr (Chromium's network service crashes on them)",
  );
  assert.ok(scoped.entries < hostView.entries, "hidden alias entries must be removed from the list");
});

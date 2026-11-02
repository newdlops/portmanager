import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { BrowserDnsSyncCoordinator, type BrowserDnsSyncBatch } from "../../src/extension/browser-dns-sync-coordinator";
import { createTestAgentCredential, testAgentAuthorization } from "./native-agent-test-authorization";
import { exerciseHookedRouteRefresh } from "./native-hook-refresh-fixture";

/**
 * Black-box coverage for the daemon-owned browser DNS responder.
 *
 * The responder moved from the extension host into the native daemon so that
 * records survive VS Code window churn: the old in-window responder froze its
 * table as soon as cross-window ownership moved away from the socket-holding
 * window. These tests drive the real binary over its Unix socket and UDP.
 */

const projectRoot = path.resolve(__dirname, "../../..");
const nativeAgentPath = process.env.PORT_MANAGER_TEST_NATIVE_AGENT_PATH ?? path.join(projectRoot, "media", "native", "portmanager_agent");

interface DnsAnswer {
  readonly rcode: number;
  readonly answerCount: number;
  readonly address?: string;
}

interface AgentResponse<T> {
  readonly type?: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly payload?: T;
  readonly error?: string;
}

interface DnsFixture {
  readonly socketPath: string;
  readonly routeTablePath: string;
  readonly directory: string;
  readonly agent: ChildProcess;
}

test("native DNS bounds maximum-table response lookup comparisons", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
}, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-dns-index-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "index-test");
  const sources = ["portmanager_agent_json.c", "portmanager_agent_state.c", "portmanager_agent_scan.c",
    "portmanager_agent_output.c", "portmanager_agent_publication.c"]
    .map((source) => path.join(projectRoot, "native", "agent", source));
  execFileSync("cc", ["-Wall", "-Wextra", "-O2", "-pthread", "-ffunction-sections",
    process.platform === "darwin" ? "-Wl,-dead_strip" : "-Wl,--gc-sections",
    path.join(projectRoot, "test", "unit", "native-agent-dns-index-fixture.c"), ...sources,
    path.join(projectRoot, "native", "shared", "pm_peer_process.c"),
    path.join(projectRoot, "native", "shared", "pm_dev_log.c"), "-o", binary], { timeout: 30_000 });
  const output = execFileSync(binary, [], { encoding: "utf8", timeout: 10_000 });
  assert.equal(output.includes("network-4095.pm comparisons="), true);
  context.diagnostic(output.trim());
  execFileSync(binary, ["--publication-allocation", directory], { timeout: 10_000 });
  execFileSync(binary, ["--startup-allocation", directory], { timeout: 10_000 });
  execFileSync(binary, ["--replay-allocation", directory], { timeout: 10_000 });
  execFileSync(binary, ["--publication-budget"], { timeout: 10_000 });
});

test("network service pushes browser DNS records from every window, not only the owner", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "extension", "network-service.ts"), "utf8");
  const registryHandler = source.slice(
    source.indexOf("this.registry.onDidChange(() => {"),
    source.indexOf("this.reconcileVscodeWindowTerminalBinding();"),
  );

  // The un-gated push is the multi-window fix: gating record sync on the
  // control-plane lease froze the resolver whenever ownership moved windows.
  assert.equal(registryHandler.includes("this.syncBrowserDnsRecords();"), true);
  assert.equal(source.includes("BrowserDnsSyncCoordinator"), true);
  assert.equal(source.includes("browserDnsSyncCoordinator?.enqueue"), true);
  assert.equal(source.includes("syncBrowserDns(batch.records, batch.revision, batch.sharedStatePath)"), true);
  assert.equal(source.includes("resolveRejectedBrowserDnsSync"), true);
  assert.equal(source.includes("flushPendingNow"), true);
  // The extension host must no longer own a responder socket of its own.
  assert.equal(source.includes("new BrowserDnsServer("), false);
  assert.equal(source.includes("encodeBrowserDnsSyncRecords"), true);
});

test("native agent sources wire the DNS responder into dispatch, poll loop, and status", () => {
  const header = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.h"), "utf8");
  const agentSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.c"), "utf8");
  const stateSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");
  const dnsSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_dns.c"), "utf8");

  assert.equal(header.includes("pm_browser_dns_record"), true);
  assert.equal(header.includes("int browser_dns_fd;"), true);
  assert.equal(agentSource.includes('strcmp(request->method, "syncBrowserDns")'), true);
  assert.equal(agentSource.includes("pm_dns_maybe_rebind(state, time(NULL));"), true);
  assert.equal(dnsSource.includes("pm_dns_handle_readable(worker)"), true);
  assert.equal(agentSource.includes("pm_dns_handle_readable(state);"), false);
  assert.equal(agentSource.includes("pm_dns_init(&state, arguments.dns_port);"), true);
  // Both status payloads must publish responder state for extension diagnostics.
  assert.equal((stateSource.match(/pm_dns_append_status_fields/g) ?? []).length >= 2, true);
  // A zeroed state struct must never look like a bound responder (fd 0 is real).
  assert.equal(stateSource.includes("state->browser_dns_fd = -1;"), true);
  // A failed UDP bind stays non-fatal so the routing data plane survives.
  assert.equal(dnsSource.includes("EADDRINUSE"), true);
  assert.equal(dnsSource.includes("pm_write_atomic"), true);
});

if (!fs.existsSync(nativeAgentPath)) {
  test("native agent answers browser DNS queries", { skip: "native agent binary is not built" }, () => undefined);
} else {
  test("one hooked client refreshes expired routes while streams survive DNS publication and daemon restart", { timeout: 20_000 }, async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) return;
    const port = await readDnsPort(fixture.socketPath);
    assert.ok(port);
    await requestOnce(fixture.socketPath, {
      id: "refresh-initial", method: "syncBrowserDns", payload: { records: "refresh.pm=127.120.5.9" },
    });
    await exerciseHookedRouteRefresh(context, fixture.directory, async () => {
      // DNS work overlaps the warmed client's route expiry/rewrite. The larger
      // whole-table swap stress and authority fences remain in their own cases.
      await Promise.all([
        (async () => {
          for (let index = 0; index < 12; index++) {
            await requestOnce(fixture.socketPath, {
              id: `refresh-dns-${index}`, method: "syncBrowserDns",
              payload: { records: `refresh.pm=${index % 2 ? "127.120.5.9" : "127.120.5.10"}` },
            });
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
        })(),
        (async () => {
          for (let index = 0; index < 50; index++) {
            const answer = await dnsQuery(port, "refresh.pm");
            assert.ok(answer.address === "127.120.5.9" || answer.address === "127.120.5.10");
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
        })(),
      ]);
    }, async () => {
      await requestOnce(fixture.socketPath, { id: "refresh-shutdown", method: "shutdownDaemon" });
      await waitForProcessExit(fixture.agent, 3_000);
      const restarted = await startDnsAgent(context, fixture.directory);
      assert.ok(restarted, "the test daemon must restart");
      const restartedPort = await readDnsPort(restarted.socketPath);
      assert.ok(restartedPort);
      assert.deepEqual(await dnsQuery(restartedPort, "refresh.pm"), {
        rcode: 0, answerCount: 1, address: "127.120.5.9",
      });
    });
  });

  test("native DNS retains first normalized duplicate and the 4096-row boundary through replay and restart", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) return;
    const authorityPath = path.join(fixture.directory, "state.json");
    fs.writeFileSync(authorityPath, JSON.stringify({ version: 1, revision: "maximum", state: { networks: [], attachments: [], exposures: [] } }));
    const pairs = ["Z-DUP.PM.=127.120.5.7", "z-dup.pm=127.120.5.8", ...Array.from({ length: 4094 }, (_, row) => `network-${String(row).padStart(4, "0")}.pm=127.120.5.9`), "excluded.pm=127.120.5.10"];
    const payload = { records: pairs.join(","), revision: "maximum", sharedStatePath: authorityPath };
    assert.equal((await requestOnce<{ applied: boolean }>(fixture.socketPath, { id: "maximum", method: "syncBrowserDns", payload })).applied, true);
    const port = (await readDnsPort(fixture.socketPath))!;
    for (const [name, address] of [["Z-DUP.PM", "127.120.5.7"], ["network-0000.pm", "127.120.5.9"], ["network-2048.pm", "127.120.5.9"], ["network-4093.pm", "127.120.5.9"]]) {
      assert.deepEqual(await dnsQuery(port, name!), { rcode: 0, answerCount: 1, address });
    }
    assert.equal((await dnsQuery(port, "excluded.pm")).rcode, 3);
    assert.equal((await dnsQuery(port, "missing.pm")).rcode, 3);
    const sidecar = path.join(fixture.directory, "routes-browser-dns.tsv");
    const persisted = fs.readFileSync(sidecar, "utf8");
    assert.deepEqual(persisted.trimEnd().split("\n").slice(0, 4), ["#revision\tmaximum", "z-dup.pm\t127.120.5.7", "z-dup.pm\t127.120.5.8", "network-0000.pm\t127.120.5.9"]);
    assert.equal(persisted.trimEnd().split("\n").length, 4097);
    assert.equal((await requestOnce<{ applied: boolean }>(fixture.socketPath, { id: "maximum-replay", method: "syncBrowserDns", payload: { ...payload, records: "z-dup.pm=127.120.5.99" } })).applied, true);
    assert.equal((await dnsQuery(port, "z-dup.pm")).address, "127.120.5.7");
    assert.equal(fs.readFileSync(sidecar, "utf8"), persisted);
    await requestOnce(fixture.socketPath, { id: "maximum-shutdown", method: "shutdownDaemon" });
    await waitForProcessExit(fixture.agent, 3000);
    const restarted = await startDnsAgent(context, fixture.directory);
    if (restarted === undefined) return;
    const restartedPort = (await readDnsPort(restarted.socketPath))!;
    assert.equal((await dnsQuery(restartedPort, "z-dup.pm")).address, "127.120.5.7");
    assert.equal((await dnsQuery(restartedPort, "network-4093.pm")).address, "127.120.5.9");
    fs.writeFileSync(authorityPath, JSON.stringify({ version: 1, revision: "empty", state: { networks: [], attachments: [], exposures: [] } }));
    assert.equal((await requestOnce<{ applied: boolean }>(restarted.socketPath, { id: "maximum-empty", method: "syncBrowserDns", payload: { ...payload, revision: "empty", records: "" } })).applied, true);
    assert.equal((await dnsQuery(restartedPort, "z-dup.pm")).rcode, 3);
    assert.equal((await dnsQuery(restartedPort, "network-4093.pm")).rcode, 3);
  });

  test("managed shells inherit prepared routing env while the DNS worker is running", async (context) => {
    const fixture = await startDnsAgent(context, undefined, 0, undefined, {
      PORT: "old", PORT_MANAGER_ACTUAL_PORT: "old", PORT_MANAGER_LOGICAL_PORT: "old",
      PM_DNS_TEST_INHERITED: "preserved",
    });
    if (fixture === undefined) return;
    assert.ok(await readDnsPort(fixture.socketPath));
    fs.writeFileSync(path.join(fixture.directory, "capture.sh"),
      'printf \'%s\\n\' "$PORT" "$PORT_MANAGER_ACTUAL_PORT" "$PORT_MANAGER_LOGICAL_PORT" "$PORT_MANAGER_ROUTES" "$PORT_MANAGER_ROUTES_FILE" "$PM_DNS_TEST_INHERITED" > result.txt\n');
    const reservation = net.createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const requestedPort = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const started = await requestOnce<{ readonly actualPort: number }>(fixture.socketPath, {
      id: "managed-env", method: "startManagedProcess", payload: {
        name: "env fixture", command: "/bin/sh ./capture.sh", cwd: fixture.directory,
        requestedPort, host: "127.0.0.1", injectionMode: "env", routingMode: "nearest", scanRange: 5,
      },
    });
    const resultPath = path.join(fixture.directory, "result.txt");
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(resultPath) || fs.readFileSync(resultPath, "utf8").split("\n").length < 7) {
      assert.ok(Date.now() < deadline, "managed shell did not produce its inherited environment");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const lines = fs.readFileSync(resultPath, "utf8").trimEnd().split("\n");
    assert.deepEqual(lines.slice(0, 3), [String(started.actualPort), String(started.actualPort), String(requestedPort)]);
    assert.ok(Array.isArray(JSON.parse(lines[3]!)));
    assert.equal(lines[4], fixture.routeTablePath);
    assert.equal(lines[5], "preserved");
  });

  test("native DNS answers while the control thread waits for a listener scan", async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-dns-worker-"));
    const bin = path.join(directory, "bin");
    fs.mkdirSync(bin);
    const block = path.join(directory, "block");
    const entered = path.join(directory, "entered");
    const release = path.join(directory, "release");
    // A test subprocess gate, not production instrumentation. Returning an
    // empty successful scan keeps the fixture independent of the host topology.
    fs.writeFileSync(path.join(bin, "lsof"), '#!/bin/sh\nif [ -f "$PM_DNS_TEST_BLOCK" ]; then\n  : > "$PM_DNS_TEST_ENTERED"\n  while [ ! -f "$PM_DNS_TEST_RELEASE" ]; do /bin/sleep 0.01; done\nfi\nexit 1\n', { mode: 0o755 });
    const fixture = await startDnsAgent(context, directory, 0, undefined, {
      PATH: `${bin}:${process.env.PATH}`, PM_DNS_TEST_BLOCK: block,
      PM_DNS_TEST_ENTERED: entered, PM_DNS_TEST_RELEASE: release,
    });
    context.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
    if (fixture === undefined) return;
    const port = await readDnsPort(fixture.socketPath);
    assert.ok(port);
    await requestOnce(fixture.socketPath, { id: "worker-sync", method: "syncBrowserDns", payload: { records: "responsive.pm=127.120.5.9" } });
    fs.writeFileSync(block, "");
    let repaired = false;
    const repair = requestOnce(fixture.socketPath, { id: "blocked-repair", method: "repairRoutingState" })
      .then(() => { repaired = true; });
    // Attach rejection handling before awaiting the controlled scan boundary.
    const settled = repair.then(() => undefined, (error: unknown) => error);
    try {
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(entered)) {
        assert.ok(Date.now() < deadline, "listener scan did not start");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal((await dnsQuery(port, "responsive.pm", 1, 1000)).address, "127.120.5.9");
      assert.equal(repaired, false, "DNS must complete before the scan is released");
    } finally { fs.writeFileSync(release, ""); }
    const error = await settled;
    if (error) throw error;
  });

  test("native DNS publishes whole tables during concurrent UDP queries", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) return;
    const port = await readDnsPort(fixture.socketPath);
    assert.ok(port);
    await requestOnce(fixture.socketPath, { id: "atomic-initial", method: "syncBrowserDns", payload: { records: "atomic.pm=127.120.5.9" } });
    await Promise.all([
      (async () => {
        for (let index = 0; index < 20; index++) {
          const address = index % 2 ? "127.120.5.9" : "127.120.5.10";
          const records = [`atomic.pm=${address}`, ...Array.from({ length: 4095 }, (_, row) => `row-${row}.pm=${address}`)].join(",");
          await requestOnce(fixture.socketPath, { id: `atomic-${index}`, method: "syncBrowserDns", payload: { records } });
        }
      })(),
      (async () => {
        for (let index = 0; index < 100; index++) {
          const answer = await dnsQuery(port, "atomic.pm");
          assert.ok(answer.address === "127.120.5.9" || answer.address === "127.120.5.10");
        }
      })(),
    ]);
  });

  test("DNS publication recovers a stale revision within the same drain before the first alias query", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) return;

    const sharedStatePath = path.join(fixture.directory, "state.json");
    fs.writeFileSync(sharedStatePath, JSON.stringify({
      version: 1, revision: "B", state: { networks: [], attachments: [], exposures: [] },
    }));
    const current: BrowserDnsSyncBatch = {
      records: "fresh.pm=127.120.5.9", revision: "B", sharedStatePath, signature: "B",
    };
    const sent: string[] = [];
    const retries: number[] = [];
    const coordinator = new BrowserDnsSyncCoordinator({
      send: async (batch) => {
        sent.push(batch.signature);
        return requestOnce(fixture.socketPath, {
          id: `publication-${batch.signature}`, method: "syncBrowserDns", payload: batch,
        });
      },
      resolveRejected: () => ({ kind: "replace", batch: current }),
      onResult: () => undefined,
      onError: () => assert.fail("DNS publication transport failed"),
      schedule: (delay) => { retries.push(delay); return delay; },
      cancel: () => undefined,
    });
    context.after(() => coordinator.dispose());

    coordinator.enqueue({ ...current, records: "stale.pm=127.120.5.10", revision: "A", signature: "A" });
    await coordinator.waitForCurrentDrain();

    assert.deepEqual(sent, ["A", "B"]);
    assert.deepEqual(retries, []);
    const port = (await readDnsPort(fixture.socketPath))!;
    assert.deepEqual(await dnsQuery(port, "fresh.pm"), { rcode: 0, answerCount: 1, address: "127.120.5.9" });
    assert.equal((await dnsQuery(port, "stale.pm")).rcode, 3);
  });

  test("native agent answers A queries from synced records and NXDOMAINs unknown names", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) {
      return;
    }

    const port = await readDnsPort(fixture.socketPath);
    assert.notEqual(port, undefined);

    const beforeSync = await dnsQuery(port!, "alphac.pm");
    assert.equal(beforeSync.rcode, 3);
    assert.equal(beforeSync.answerCount, 0);

    const sync = await requestOnce<{ readonly running: boolean; readonly port: number }>(fixture.socketPath, {
      id: "dns-sync",
      method: "syncBrowserDns",
      payload: { records: "alphac=127.130.102.126,alphac.pm=127.130.102.126,vcm=127.142.101.164" },
    });
    assert.equal(sync.running, true);
    assert.equal(sync.port, port);

    assert.deepEqual(await dnsQuery(port!, "alphac.pm"), { rcode: 0, answerCount: 1, address: "127.130.102.126" });
    // Query names match case-insensitively, mirroring the old responder.
    assert.deepEqual(await dnsQuery(port!, "ALPHAC.PM"), { rcode: 0, answerCount: 1, address: "127.130.102.126" });
    // ANY answers with the A record; AAAA is NOERROR with zero answers.
    assert.deepEqual(await dnsQuery(port!, "vcm", 255), { rcode: 0, answerCount: 1, address: "127.142.101.164" });
    assert.deepEqual(await dnsQuery(port!, "vcm", 28), { rcode: 0, answerCount: 0 });
    assert.equal((await dnsQuery(port!, "missing")).rcode, 3);
  });

  test("native agent skips invalid sync pairs and applies the rest", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) {
      return;
    }

    const port = await readDnsPort(fixture.socketPath);
    await requestOnce(fixture.socketPath, {
      id: "dns-sync-invalid",
      method: "syncBrowserDns",
      payload: { records: "no-separator,bad=999.1.1.1,-lead=127.1.1.1,good=127.120.5.9" },
    });

    assert.deepEqual(await dnsQuery(port!, "good"), { rcode: 0, answerCount: 1, address: "127.120.5.9" });
    assert.equal((await dnsQuery(port!, "bad")).rcode, 3);
  });

  test("native agent persists DNS records across a daemon restart", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) {
      return;
    }

    await requestOnce(fixture.socketPath, {
      id: "dns-sync-persist",
      method: "syncBrowserDns",
      payload: { records: "alphac=127.130.102.126" },
    });
    const persistedPath = path.join(fixture.directory, "routes-browser-dns.tsv");
    assert.equal(fs.readFileSync(persistedPath, "utf8").includes("alphac\t127.130.102.126"), true);

    await requestOnce(fixture.socketPath, { id: "dns-shutdown", method: "shutdownDaemon" });
    await waitForProcessExit(fixture.agent, 3_000);

    const restarted = await startDnsAgent(context, fixture.directory);
    if (restarted === undefined) {
      return;
    }
    const port = await readDnsPort(restarted.socketPath);
    assert.deepEqual(await dnsQuery(port!, "alphac"), { rcode: 0, answerCount: 1, address: "127.130.102.126" });

    // A full replace with zero records must also wipe the persisted rows.
    await requestOnce(restarted.socketPath, {
      id: "dns-sync-wipe",
      method: "syncBrowserDns",
      payload: { records: "" },
    });
    assert.equal((await dnsQuery(port!, "alphac")).rcode, 3);
    assert.equal(fs.readFileSync(persistedPath, "utf8").trim(), "");
  });

  test("native agent fences delayed and unversioned DNS writers across restart", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) return;
    const authorityPath = path.join(fixture.directory, "logical-network-state.v1.json");
    const publish = async (revision: string, records: string) => {
      fs.writeFileSync(authorityPath, JSON.stringify({ version: 1, revision, state: { networks: [], attachments: [], exposures: [] } }));
      return requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, {
        id: `dns-${revision}`,
        method: "syncBrowserDns",
        payload: { records, revision, sharedStatePath: authorityPath },
      });
    };
    const port = await readDnsPort(fixture.socketPath);
    assert.equal((await publish("revision-b", "current=127.120.5.9")).applied, true);
    const replay = await requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, {
      id: "dns-replay",
      method: "syncBrowserDns",
      payload: { records: "changed=127.120.5.10", revision: "revision-b", sharedStatePath: authorityPath },
    });
    assert.equal(replay.applied, true);
    fs.writeFileSync(authorityPath, JSON.stringify({ version: 1, revision: "revision-b", state: { networks: [], attachments: [], exposures: [] } }));
    const stale = await requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, {
      id: "dns-stale",
      method: "syncBrowserDns",
      payload: { records: "stale=127.120.5.10", revision: "revision-a", sharedStatePath: authorityPath },
    });
    assert.equal(stale.applied, false);
    const legacy = await requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, {
      id: "dns-legacy",
      method: "syncBrowserDns",
      payload: { records: "legacy=127.120.5.11" },
    });
    assert.equal(legacy.applied, false);
    assert.deepEqual(await dnsQuery(port!, "current"), { rcode: 0, answerCount: 1, address: "127.120.5.9" });
    assert.equal((await dnsQuery(port!, "changed")).rcode, 3);
    assert.equal((await dnsQuery(port!, "stale")).rcode, 3);
    await requestOnce(fixture.socketPath, { id: "dns-shutdown-fenced", method: "shutdownDaemon" });
    await waitForProcessExit(fixture.agent, 3_000);
    const restarted = await startDnsAgent(context, fixture.directory);
    if (restarted === undefined) return;
    const restartedPort = await readDnsPort(restarted.socketPath);
    assert.deepEqual(await dnsQuery(restartedPort!, "current"), { rcode: 0, answerCount: 1, address: "127.120.5.9" });
  });

  test("native agent accepts only direct complete authority documents", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) return;
    const authorityPath = path.join(fixture.directory, "logical-network-state.v1.json");
    const sync = (revision: string, records = "current=127.120.5.9") => requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, {
      id: `dns-authority-${revision}`, method: "syncBrowserDns",
      payload: { records, revision, sharedStatePath: authorityPath },
    });
    const valid = { version: 1, revision: "revision-b", state: { networks: [], attachments: [], exposures: [] } };
    fs.writeFileSync(authorityPath, JSON.stringify(valid));
    assert.equal((await sync("revision-b")).applied, true);
    for (const [invalid, candidate] of [
      ["{", "malformed=127.120.5.10"],
      [JSON.stringify({ version: 1, revision: "revision-b", state: { nested: { networks: [], attachments: [], exposures: [] } } }), "nested=127.120.5.11"],
      [JSON.stringify({ version: 1, revision: "revision-b", state: { networks: "wrong", attachments: [], exposures: [] } }), "wrongtype=127.120.5.12"],
    ] as const) {
      fs.writeFileSync(authorityPath, invalid);
      assert.equal((await sync("revision-b", candidate)).applied, false);
    }
    fs.writeFileSync(authorityPath, JSON.stringify(valid));
    assert.equal((await sync("legacy")).applied, false);
    assert.equal((await dnsQuery((await readDnsPort(fixture.socketPath))!, "current")).rcode, 0);
    for (const candidate of ["malformed", "nested", "wrongtype"]) {
      assert.equal((await dnsQuery((await readDnsPort(fixture.socketPath))!, candidate)).rcode, 3);
    }
  });

  test("native agent accepts a complete raw legacy authority before a revision fence", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) return;
    const authorityPath = path.join(fixture.directory, "legacy-network-state.json");
    fs.writeFileSync(authorityPath, JSON.stringify({ networks: [], attachments: [], exposures: [] }));
    const result = await requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, {
      id: "dns-raw-legacy", method: "syncBrowserDns",
      payload: { records: "legacy=127.120.5.10", revision: "legacy", sharedStatePath: authorityPath },
    });
    assert.equal(result.applied, true);
    assert.equal((await dnsQuery((await readDnsPort(fixture.socketPath))!, "legacy")).rcode, 0);
  });

  test("native agent retains live DNS records when sidecar persistence fails, then retries", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) return;
    const authorityPath = path.join(fixture.directory, "logical-network-state.v1.json");
    fs.writeFileSync(authorityPath, JSON.stringify({ version: 1, revision: "A", state: { networks: [], attachments: [], exposures: [] } }));
    assert.equal((await requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, { id: "dns-persist-old", method: "syncBrowserDns", payload: { records: "old=127.0.0.1", revision: "A", sharedStatePath: authorityPath } })).applied, true);
    const sidecar = path.join(fixture.directory, "routes-browser-dns.tsv");
    fs.rmSync(sidecar); fs.mkdirSync(sidecar);
    fs.writeFileSync(authorityPath, JSON.stringify({ version: 1, revision: "B", state: { networks: [], attachments: [], exposures: [] } }));
    assert.equal((await requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, { id: "dns-persist-fail", method: "syncBrowserDns", payload: { records: "new=127.0.0.2", revision: "B", sharedStatePath: authorityPath } })).applied, false);
    const port = await readDnsPort(fixture.socketPath);
    assert.equal((await dnsQuery(port!, "old")).rcode, 0);
    assert.equal((await dnsQuery(port!, "new")).rcode, 3);
    fs.rmSync(sidecar, { recursive: true });
    assert.equal((await requestOnce<{ readonly applied?: boolean }>(fixture.socketPath, { id: "dns-persist-retry", method: "syncBrowserDns", payload: { records: "new=127.0.0.2", revision: "B", sharedStatePath: authorityPath } })).applied, true);
    assert.equal((await dnsQuery(port!, "new")).rcode, 0);
  });

  test("native agent same-revision replay recovers a blocked UDP bind without changing records", async (context) => {
    const markerDirectory = fs.mkdtempSync(path.join(projectRoot, ".tmp", "dns-bind-block-"));
    const markerPath = path.join(markerDirectory, "block");
    fs.writeFileSync(markerPath, "block");
    context.after(() => fs.rmSync(markerDirectory, { recursive: true, force: true }));
    const fixture = await startDnsAgent(context, undefined, 0, markerPath);
    if (fixture === undefined) return;
    const authorityPath = path.join(fixture.directory, "logical-network-state.v1.json");
    fs.writeFileSync(authorityPath, JSON.stringify({ version: 1, revision: "B", state: { networks: [], attachments: [], exposures: [] } }));
    const first = await requestOnce<{ readonly applied?: boolean; readonly running?: boolean }>(fixture.socketPath, { id: "dns-bind-first", method: "syncBrowserDns", payload: { records: "original=127.0.0.3", revision: "B", sharedStatePath: authorityPath } });
    assert.equal(first.applied, true); assert.equal(first.running, false);
    fs.rmSync(markerPath);
    const replay = await requestOnce<{ readonly applied?: boolean; readonly running?: boolean }>(fixture.socketPath, { id: "dns-bind-replay", method: "syncBrowserDns", payload: { records: "replacement=127.0.0.4", revision: "B", sharedStatePath: authorityPath } });
    assert.equal(replay.applied, true); assert.equal(replay.running, true);
    const reboundPort = await readDnsPort(fixture.socketPath);
    assert.equal(reboundPort! > 0, true);
    assert.equal((await dnsQuery(reboundPort!, "original")).rcode, 0);
    assert.equal((await dnsQuery(reboundPort!, "replacement")).rcode, 3);
  });

  test("native agent reports responder state in daemonStatus", async (context) => {
    const fixture = await startDnsAgent(context);
    if (fixture === undefined) {
      return;
    }

    const daemon = await requestOnce<{
      readonly browserDnsRunning?: boolean;
      readonly browserDnsPort?: number;
    }>(fixture.socketPath, { id: "dns-status", method: "daemonStatus" });

    assert.equal(daemon.browserDnsRunning, true);
    assert.equal(typeof daemon.browserDnsPort, "number");
    assert.equal(daemon.browserDnsPort! > 0, true);
  });

  test("native agent rejects an out-of-range --dns-port", async () => {
    const invalid = spawn(nativeAgentPath, [
      "--socket",
      "/tmp/pm-dns-unused.sock",
      "--dns-port",
      "70000",
    ], { stdio: "ignore" });
    assert.notEqual(await waitForProcessExit(invalid, 2_000), 0);
  });
}

async function startDnsAgent(context: TestContext, reuseDirectory?: string, dnsPort = 0, dnsBindBlockPath?: string, extraEnvironment: NodeJS.ProcessEnv = {}): Promise<DnsFixture | undefined> {
  // Keep the socket below sockaddr_un's path limit even in deeply nested CI checkouts.
  const directory = reuseDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), "pm-dns-"));
  fs.mkdirSync(directory, { recursive: true });
  const socketPath = path.join(directory, "agent.sock");
  const routeTablePath = path.join(directory, "routes.json");
  fs.rmSync(socketPath, { force: true });
  const stderrChunks: Buffer[] = [];
  const agent = spawn(nativeAgentPath, [
    "--socket",
    socketPath,
    "--route-table",
    routeTablePath,
    "--agent-main",
    path.join(projectRoot, "out", "src", "agent", "agent-main.js"),
    "--dns-port",
    String(dnsPort),
    "--controller-token-file",
    createTestAgentCredential(socketPath),
  ], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...extraEnvironment, ...(dnsBindBlockPath === undefined ? {} : { PORT_MANAGER_AGENT_TEST_DNS_BIND_BLOCK_PATH: dnsBindBlockPath }) } });
  agent.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  context.after(async () => {
    if (agent.exitCode === null) {
      agent.kill("SIGTERM");
      await waitForProcessExit(agent, 2_000).catch(() => undefined);
    }
    if (reuseDirectory === undefined) {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  try {
    await waitForAgent(socketPath);
  } catch (error) {
    if (stderrChunks.some((chunk) => chunk.toString("utf8").includes("Operation not permitted"))) {
      context.skip("native agent cannot bind Unix sockets in this sandbox");
      return undefined;
    }
    throw error;
  }

  return { socketPath, routeTablePath, directory, agent };
}

async function readDnsPort(socketPath: string): Promise<number | undefined> {
  const daemon = await requestOnce<{ readonly browserDnsPort?: number; readonly browserDnsRunning?: boolean }>(
    socketPath,
    { id: `dns-port-${Date.now().toString(36)}`, method: "daemonStatus" },
  );
  return daemon.browserDnsRunning === true ? daemon.browserDnsPort : undefined;
}

function dnsQuery(port: number, name: string, type = 1, timeoutMs = 2_000): Promise<DnsAnswer> {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x4242, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const question = Buffer.concat([
    ...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])),
    Buffer.from([0]),
    Buffer.from([type >> 8, type & 0xff, 0, 1]),
  ]);

  return new Promise<DnsAnswer>((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out waiting for a DNS answer for ${name}`));
    }, timeoutMs);

    socket.once("message", (response) => {
      clearTimeout(timer);
      socket.close();
      const answerCount = response.readUInt16BE(6);
      if (answerCount > 0) assert.equal(response.readUInt32BE(response.length - 10), 1, "DNS answer TTL stays one second");
      resolve({
        rcode: response.readUInt16BE(2) & 0xf,
        answerCount,
        ...(answerCount > 0
          ? { address: [...response.subarray(response.length - 4)].join(".") }
          : {}),
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(Buffer.concat([header, question]), port, "127.0.0.1");
  });
}

async function requestOnce<T = unknown>(
  socketPath: string,
  request: { readonly id: string; readonly method: string; readonly payload?: unknown },
  timeoutMs = 5_000,
): Promise<T> {
  const socket = await connectSocket(socketPath);

  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for native agent response: ${request.method}`));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;

      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as AgentResponse<T>;
        if (message.type !== "response" || message.id !== request.id) {
          continue;
        }

        clearTimeout(timer);
        socket.destroy();
        if (message.ok !== true) {
          reject(new Error(message.error ?? "Native agent request failed."));
          return;
        }
        resolve(message.payload as T);
        return;
      }
    });
    socket.write(`${JSON.stringify({ ...request, authorization: testAgentAuthorization(socketPath) })}\n`);
  });
}

function connectSocket(socketPath: string, timeoutMs = 1_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out connecting to the native agent socket."));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForAgent(socketPath: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const socket = await connectSocket(socketPath);
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Native agent did not start.");
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for process exit.")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

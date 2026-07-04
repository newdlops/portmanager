import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

/**
 * End-to-end coverage for scope-less gateway bind relocation (native hook).
 *
 * When the logical port gateway owns a port, it publishes a claim file. A
 * server launched in a terminal with no network attachment must then relocate
 * off that port to a daemon-assigned high port and register a network-less
 * listen route, which is the coordinate the gateway forwards non-network
 * clients to. Without a claim the same bind must pass through untouched.
 *
 * Drives the real compiled agent + hook; skipped when they are not built or on
 * platforms without the preload hook.
 */

const projectRoot = path.resolve(__dirname, "../../..");
const agentPath = path.join(projectRoot, "media/native/portmanager_agent");
const hookPath = path.join(projectRoot, "media/native/libportmanager_hook.dylib");
const agentMainPath = path.join(projectRoot, "out/src/agent/agent-main.js");
/*
 * This drives the full daemon (spawn agent + allocateRoute round trip + listener
 * scan), which is too resource-heavy to run reliably alongside the whole unit
 * suite. Like scripts/stress-routing.js it is opt-in: run it directly, or with
 * PM_RUN_NATIVE_E2E=1 node --test out/test/unit/native-hook-gateway-relocation.test.js
 */
const optedIn = process.env.PM_RUN_NATIVE_E2E === "1";
const supported = optedIn && process.platform === "darwin" && fs.existsSync(agentPath) && fs.existsSync(hookPath);

interface AgentRoute {
  readonly logicalPort: number;
  readonly actualPort: number;
  readonly networkId?: string;
}

/** Sends one NDJSON request and resolves with the response frame's payload. */
function requestSnapshot(socketPath: string): Promise<readonly AgentRoute[]> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("agent request timed out"));
    }, 3000);

    client.on("connect", () =>
      client.write(`${JSON.stringify({ id: `probe-${process.pid}`, method: "listSnapshot", payload: {} })}\n`),
    );
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd < 0) {
          break;
        }
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        let frame: { type?: string; payload?: { routes?: readonly AgentRoute[] } };
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.type === "response") {
          clearTimeout(timer);
          client.end();
          resolve(frame.payload?.routes ?? []);
          return;
        }
      }
    });
    client.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Builds a child environment with every inherited Port Manager/preload var removed. */
function cleanBinderEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("PORT_MANAGER_") ||
      key.startsWith("NEWDLOPS_") ||
      key === "DYLD_INSERT_LIBRARIES" ||
      key === "LD_PRELOAD" ||
      key === "BASH_ENV"
    ) {
      continue;
    }
    base[key] = value;
  }
  return { ...base, ...overrides };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Fixture {
  readonly dir: string;
  readonly socketPath: string;
  readonly baseRoutes: string;
  readonly agent: ChildProcess;
}

async function startFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-gateway-reloc-"));
  const socketPath = path.join(dir, "agent.sock");
  const baseRoutes = path.join(dir, "routes.json");
  const agent = spawn(agentPath, ["--socket", socketPath, "--route-table", baseRoutes, "--agent-main", agentMainPath], {
    env: cleanBinderEnvironment({}),
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitFor(() => fs.existsSync(socketPath), 3000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { dir, socketPath, baseRoutes, agent };
}

/**
 * Launches the scope-less binder and keeps it alive for the caller to observe.
 * A generous lifetime keeps the registered route present while the (possibly
 * loaded) test host polls the agent, avoiding fixed-sleep flakiness.
 */
function spawnBinder(fixture: Fixture, logicalPort: number): ChildProcess {
  return spawn(
    process.execPath,
    [
      "-e",
      `const net=require('net');const s=net.createServer(()=>{});s.on('error',()=>process.exit(3));s.listen(${logicalPort},'127.0.0.1',()=>setTimeout(()=>process.exit(0),6000));`,
    ],
    {
      env: cleanBinderEnvironment({
        DYLD_INSERT_LIBRARIES: hookPath,
        PORT_MANAGER_HOOK: "1",
        PORT_MANAGER_GLOBAL_ROUTES_FILE: fixture.baseRoutes,
        PORT_MANAGER_ROUTES_FILE: fixture.baseRoutes,
        PORT_MANAGER_AGENT_SOCKET: fixture.socketPath,
        PORT_MANAGER_VIRTUAL_PORT_START: "53000",
        PORT_MANAGER_VIRTUAL_PORT_END: "59999",
        PORT_MANAGER_SCAN_RANGE: "20",
        PORT_MANAGER_ROUTING_MODE: "hashed",
      }),
      stdio: "ignore",
    },
  );
}

/** Polls the agent snapshot until a route for the port appears or the deadline passes. */
async function pollForRoute(socketPath: string, logicalPort: number, timeoutMs: number): Promise<AgentRoute | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const routes = await requestSnapshot(socketPath).catch(() => [] as readonly AgentRoute[]);
    const row = routes.find((route) => route.logicalPort === logicalPort);
    if (row !== undefined || Date.now() >= deadline) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function claimPathFor(baseRoutes: string, port: number): string {
  return baseRoutes.replace(/\.json$/, `-mux-claim-port-${port}.json`);
}

test("scope-less server relocates off a claimed gateway port", async (t) => {
  if (!supported) {
    t.skip("native agent/hook not built for this platform");
    return;
  }

  const fixture = await startFixture();
  t.after(() => {
    fixture.agent.kill("SIGKILL");
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const logicalPort = await reserveLoopbackPort();
  fs.writeFileSync(claimPathFor(fixture.baseRoutes, logicalPort), JSON.stringify({ expiresAtMs: Date.now() + 15_000 }));

  const binder = spawnBinder(fixture, logicalPort);
  t.after(() => binder.kill("SIGKILL"));
  const row = await pollForRoute(fixture.socketPath, logicalPort, 5000);

  assert.ok(row, "a route row should be registered for the claimed port");
  assert.notEqual(row?.actualPort, logicalPort, "the server should be relocated to a different actual port");
  assert.ok(!row?.networkId, "the relocated owner row must carry no network id");
});

test("scope-less server binds normally when no gateway claim exists", async (t) => {
  if (!supported) {
    t.skip("native agent/hook not built for this platform");
    return;
  }

  const fixture = await startFixture();
  t.after(() => {
    fixture.agent.kill("SIGKILL");
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const logicalPort = await reserveLoopbackPort();
  // No claim file: the bind must pass through and register no relocation route.
  const binder = spawnBinder(fixture, logicalPort);
  t.after(() => binder.kill("SIGKILL"));

  // Give the binder ample time to have bound, then confirm no route was created.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const routes = await requestSnapshot(fixture.socketPath);
  const row = routes.find((route) => route.logicalPort === logicalPort);

  assert.equal(row, undefined, "an unclaimed scope-less bind should not register a gateway route");
});

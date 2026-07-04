import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import test from "node:test";

/**
 * End-to-end coverage for the native source attribution the logical port router
 * performs (protocol v2). The router must map an accepted loopback connection
 * back to the connecting process and read its Port Manager network scope.
 *
 * This drives the real compiled helper because the behavior is entirely native
 * (pcb/socket table walk + environment read); it is skipped when the binary is
 * not built or on platforms where attribution is unsupported.
 */

const routerPath = path.resolve(__dirname, "../../../media/native/portmanager_tcp_router");
/*
 * Spawns the real router plus a child process, so it is timing-sensitive under
 * the full concurrent suite. Like scripts/stress-routing.js it is opt-in: run
 * with PM_RUN_NATIVE_E2E=1 node --test out/test/unit/native-router-attribution.test.js
 */
const attributionSupported =
  process.env.PM_RUN_NATIVE_E2E === "1" && (process.platform === "darwin" || process.platform === "linux");

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

interface AttributionResult {
  readonly fields: readonly string[];
  readonly childPid: number;
}

/**
 * Runs one router connection and returns the parsed CONNECT line the resolver
 * would receive, plus the pid of the child that actually dialed the port.
 */
function captureConnectLine(networkId: string): Promise<AttributionResult> {
  return new Promise((resolve, reject) => {
    const cleanups: Array<() => void> = [];
    const finish = (error: Error | undefined, value?: AttributionResult) => {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          // best effort teardown
        }
      }
      if (error !== undefined) {
        reject(error);
      } else if (value !== undefined) {
        resolve(value);
      }
    };

    const upstream = net.createServer((socket) => socket.end("ok"));
    upstream.listen(0, "127.0.0.1", () => {
      const upstreamAddress = upstream.address();
      const upstreamPort = typeof upstreamAddress === "object" && upstreamAddress !== null ? upstreamAddress.port : 0;

      const router = spawn(routerPath, ["--control"], { stdio: ["pipe", "pipe", "pipe"] });
      let child: ChildProcess | undefined;
      let logicalPort = 0;
      let buffer = "";
      let stderr = "";

      cleanups.push(() => upstream.close());
      cleanups.push(() => router.kill("SIGKILL"));
      cleanups.push(() => child?.kill("SIGKILL"));

      const timer = setTimeout(() => finish(new Error(`attribution timed out; router stderr: ${stderr}`)), 8000);
      cleanups.push(() => clearTimeout(timer));

      router.stderr.setEncoding("utf8");
      router.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      router.once("error", (error) => finish(error));

      router.stdout.setEncoding("utf8");
      router.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const lineEnd = buffer.indexOf("\n");
          if (lineEnd < 0) {
            break;
          }
          const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
          buffer = buffer.slice(lineEnd + 1);
          const parts = line.split("\t");

          if (parts[0] === "READY" && parts[1] === "control") {
            void reserveLoopbackPort()
              .then((port) => {
                logicalPort = port;
                router.stdin.write(`LISTEN\t${port}\n`);
              })
              .catch((error) => finish(error as Error));
          } else if (parts[0] === "READY" && Number(parts[1]) === logicalPort) {
            child = spawn(
              process.execPath,
              [
                "-e",
                `const net=require('net');const c=net.connect(${logicalPort},'127.0.0.1');c.on('data',()=>{});c.on('error',()=>{});setTimeout(()=>process.exit(0),2000);`,
              ],
              {
                env: { ...process.env, PORT_MANAGER_NETWORK_ID: networkId },
                stdio: "ignore",
              },
            );
            child.once("error", (error) => finish(error));
          } else if (parts[0] === "LISTEN_ERROR" && Number(parts[1]) === logicalPort) {
            finish(new Error(`router failed to listen on ${logicalPort}`));
          } else if (parts[0] === "CONNECT") {
            router.stdin.write(`ROUTE\t${parts[1]}\t127.0.0.1\t${upstreamPort}\n`);
            finish(undefined, { fields: parts, childPid: child?.pid ?? -1 });
          }
        }
      });
    });
    upstream.once("error", (error) => finish(error));
  });
}

test("native router attributes a loopback connection to its source process and network", async (t) => {
  if (!attributionSupported || !fs.existsSync(routerPath)) {
    t.skip("native router helper is not built for this platform");
    return;
  }

  const networkId = "network-attribution-test";
  const result = await captureConnectLine(networkId);

  // CONNECT<TAB>id<TAB>logicalPort<TAB>localAddr<TAB>localPort<TAB>remoteAddr<TAB>remotePort<TAB>pid<TAB>startTime<TAB>networkId
  assert.equal(result.fields[0], "CONNECT");
  assert.ok(result.fields.length >= 10, `expected v2 CONNECT line, got ${result.fields.length} fields`);
  assert.ok(result.childPid > 0, "child process pid should be known");
  assert.equal(Number(result.fields[7]), result.childPid, "resolved pid should match the dialing child");
  assert.notEqual(result.fields[8], "-", "start time should be resolved");
  assert.equal(result.fields[9], networkId, "network id should be read from the child environment");
});

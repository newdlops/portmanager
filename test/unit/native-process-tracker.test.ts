import assert from "node:assert/strict";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/**
 * End-to-end coverage for the native process-membership tracker.
 *
 * It must attribute a subtree to its network without any environment injection
 * and, crucially, keep a process mapped after its parent dies and it reparents
 * to launchd (the daemonize case). Drives the real binary; opt-in and darwin
 * only because it uses kqueue/libproc and real process trees.
 */

const trackerPath = path.resolve(__dirname, "../../../media/native/portmanager_process_tracker");
const optedIn = process.env.PM_RUN_NATIVE_E2E === "1";
const supported = optedIn && process.platform === "darwin" && fs.existsSync(trackerPath);

interface Tracker {
  readonly child: ChildProcess;
  query(pid: number): Promise<string>;
  track(pid: number, networkId: string): void;
  stop(): void;
}

function startTracker(): Promise<Tracker> {
  return new Promise((resolve, reject) => {
    const child = spawn(trackerPath, [], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const lineWaiters: Array<(line: string) => void> = [];

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd < 0) {
          break;
        }
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        for (const waiter of lineWaiters.slice()) {
          waiter(line);
        }
      }
    });
    child.once("error", reject);

    const waitFor = (predicate: (line: string) => boolean, timeoutMs: number): Promise<string> =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const index = lineWaiters.indexOf(waiter);
          if (index >= 0) {
            lineWaiters.splice(index, 1);
          }
          rej(new Error("tracker line timeout"));
        }, timeoutMs);
        const waiter = (line: string) => {
          if (predicate(line)) {
            clearTimeout(timer);
            const index = lineWaiters.indexOf(waiter);
            if (index >= 0) {
              lineWaiters.splice(index, 1);
            }
            res(line);
          }
        };
        lineWaiters.push(waiter);
      });

    waitFor((line) => line === "READY", 2000)
      .then(() =>
        resolve({
          child,
          track: (pid, networkId) => child.stdin.write(`TRACK\t${pid}\t${networkId}\n`),
          query: (pid) => {
            child.stdin.write(`QUERY\t${pid}\n`);
            return waitFor((line) => line.startsWith(`NETWORK\t${pid}\t`), 2000);
          },
          stop: () => child.kill("SIGKILL"),
        }),
      )
      .catch(reject);
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("tracker attributes a subtree and keeps membership after the parent reparents", async (t) => {
  if (!supported) {
    t.skip("native process tracker not built for this platform");
    return;
  }

  const tracker = await startTracker();
  // A shell that waits, then backgrounds a long child and prints its pid. The
  // delay lets us TRACK the shell before it forks the child.
  const shell = spawn("/bin/bash", ["-c", "sleep 0.6; sleep 60 & echo CHILD=$!; wait"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let childPid = 0;
  shell.stdout.setEncoding("utf8");
  shell.stdout.on("data", (chunk: string) => {
    const match = /CHILD=(\d+)/.exec(chunk);
    if (match) {
      childPid = Number(match[1]);
    }
  });

  t.after(() => {
    tracker.stop();
    shell.kill("SIGKILL");
    if (childPid > 0) {
      try {
        execSync(`kill ${childPid} 2>/dev/null`);
      } catch {
        // already gone
      }
    }
  });

  tracker.track(shell.pid ?? 0, "net-tracker-test");
  await delay(900); // past the shell's fork, well before the ~3s reconcile

  assert.ok(childPid > 0, "child pid should be known");
  const whileAlive = await tracker.query(childPid);
  assert.equal(whileAlive, `NETWORK\t${childPid}\tnet-tracker-test`, "live child resolves via on-demand ancestor walk");

  // Kill the shell so the child reparents to launchd (ppid becomes 1).
  shell.kill("SIGKILL");
  await delay(500);
  const reparentedPpid = execSync(`ps -o ppid= -p ${childPid}`).toString().trim();
  assert.equal(reparentedPpid, "1", "child should have reparented to launchd");

  const afterReparent = await tracker.query(childPid);
  assert.equal(
    afterReparent,
    `NETWORK\t${childPid}\tnet-tracker-test`,
    "membership must survive the parent dying and the child reparenting",
  );
});

import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { MacosNetworkRuntime } from "../../src/platform/process/macos-network-runtime";

/** Optional bounded observations; installed methods keep their result and failure. */
export function tracePackagedRuntime(moduleRoot: string, reportPath: string): () => void {
  if (process.env.PM_TEST_RUNTIME_TRACE !== "1") return () => {};
  const { MacosNetworkRuntime: Runtime } = require(path.join(moduleRoot,
    "out/src/platform/process/macos-network-runtime")) as { MacosNetworkRuntime: typeof MacosNetworkRuntime };
  const prototype = Runtime.prototype;
  const methods = ["prepareShell", "adoptSupervisor", "waitReady", "closeShell"] as const;
  const events: unknown[] = [];
  const started = performance.now();
  const originals = methods.map(method => prototype[method]);
  const record = (runtime: MacosNetworkRuntime, method: string, phase: string, id?: string, error?: unknown) => {
    // Keep the last transitions when a long churn run fills the diagnostic ring.
    if (events.length === 128) events.shift();
    const owner = runtime.activeShells.find(launch => launch.id === id);
    events.push({ elapsedMs: performance.now() - started, method, phase, id,
      active: owner !== undefined, activeShellCount: runtime.activeShells.length,
      networkId: owner?.networkId, error: error === undefined ? undefined : String(error),
      caller: phase === "begin" && method === "closeShell" ? new Error().stack?.split("\n").slice(2, 6) : undefined });
  };
  for (const method of methods) {
    const original = prototype[method];
    const wrapped = function (this: MacosNetworkRuntime, ...args: unknown[]) {
      const id = typeof args[0] === "string" ? args[0] : undefined;
      record(this, method, "begin", id);
      return Reflect.apply(original, this, args).then((value: unknown) => {
        const preparedId = method === "prepareShell" ? (value as { id: string }).id : id;
        record(this, method, "end", preparedId);
        return value;
      }, (error: unknown) => { record(this, method, "failed", id, error); throw error; });
    };
    // The fixture's observer leaves all installed package bytes untouched.
    Object.defineProperty(prototype, method, { configurable: true, writable: true, value: wrapped });
  }
  return () => {
    methods.forEach((method, index) => Object.defineProperty(prototype, method,
      { configurable: true, writable: true, value: originals[index] }));
    fs.writeFileSync(`${reportPath}.runtime-trace.json`, JSON.stringify({ capacity: 128, events }, null, 2));
  };
}

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { once } from "node:events";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { constants, monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { getHeapCodeStatistics, getHeapSpaceStatistics, getHeapStatistics } from "node:v8";
import type { PortManagerNetworkService } from "../../src/extension/network-service";
import type { ProxyResourceLimits } from "../../src/core/networks/proxy-resource-budget";
import type { HostPortExposure, LogicalNetwork } from "../../src/shared/types";

const execute = promisify(execFile);
interface ProcessSample { pid: number; parent: number; command: string; rssKiB: number; cpuSeconds: number; descriptors: number }
interface Sample {
  elapsedSeconds: number; phase: string; cycle: number; resources: ProxyResourceLimits;
  heapBytes: number; heapCapacityBytes: number; externalBytes: number; arrayBufferBytes: number;
  heapSpaces: ReturnType<typeof getHeapSpaceStatistics>;
  heapCode: ReturnType<typeof getHeapCodeStatistics>;
  nativeContexts: number; detachedContexts: number; globalHandleBytes: number;
  gc: { count: number; major: number; minor: number; durationMs: number };
  allocationSites?: ReturnType<typeof summarizeAllocations>;
  eventLoopP99Ms: number; processes: ProcessSample[];
}
export interface ResourceSoakOptions {
  moduleRoot: string;
  seconds: number;
  reportPath: string;
  /** Supplied only inside the disposable real extension host. */
  service?: PortManagerNetworkService;
}

/**
 * Exercises production proxy owners under one budget. Native runs additionally
 * create/remove real service networks; Windows checks the Node data plane and
 * in-memory network lifecycle without claiming native isolation support.
 * Reports include the actual host, daemon and descendants, not just one helper.
 */
export async function runResourceSoak(options: ResourceSoakOptions): Promise<void> {
  assert.ok(Number.isInteger(options.seconds) && options.seconds >= 1 && options.seconds <= 3600);
  const load = (relative: string) => require(path.join(options.moduleRoot, "out", "src", relative));
  const { defaultProxyNetworkResources: resources } = load("platform/ports/proxy-network-resources") as typeof import("../../src/platform/ports/proxy-network-resources");
  const { HostPortProxyManager } = load("platform/ports/host-port-proxy") as typeof import("../../src/platform/ports/host-port-proxy");
  const { BrowserNetworkProxyManager } = load("platform/ports/browser-network-proxy") as typeof import("../../src/platform/ports/browser-network-proxy");
  const { LogicalPortRouterManager } = load("platform/ports/logical-port-router") as typeof import("../../src/platform/ports/logical-port-router");
  const { LogicalNetworkRegistry } = load("core/networks/logical-network-registry") as typeof import("../../src/core/networks/logical-network-registry");
  const registry = new LogicalNetworkRegistry([]);
  const nativePath = (name: string): string | undefined => {
    if (process.platform === "win32") return undefined;
    const candidate = path.join(options.moduleRoot, "media", "native", name);
    return fs.existsSync(candidate) ? candidate : undefined;
  };
  const nativeProxyPath = nativePath("portmanager_host_exposure_proxy");
  const nativeRouterPath = nativePath("portmanager_tcp_router");
  const liveSockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    liveSockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => liveSockets.delete(socket));
  };
  const echoServer = net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket));
  echoServer.on("connection", track);
  const httpServer = http.createServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write("data: ready\n\n");
      const heartbeat = setInterval(() => response.write("data: alive\n\n"), 1000);
      response.once("close", () => clearInterval(heartbeat));
    } else {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => response.end(request.method === "POST" ? body : "soak-ok"));
    }
  });
  httpServer.on("connection", track);
  const echoPort = await listen(echoServer);
  const httpPort = await listen(httpServer);
  const sentinel = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: httpPort }) }, { resources });
  const sentinelPort = await availablePort();
  const sentinelEndpoint = await sentinel.ensure({ id: "soak-sentinel", networkId: "soak-sentinel", logicalPort: httpPort,
    listenHost: "127.0.0.1", listenPorts: [sentinelPort], publicHost: "localhost" });
  assert.ok(sentinelEndpoint);
  let heartbeats = 0;
  let streamError: Error | undefined;
  const sse = http.get({ host: "127.0.0.1", port: sentinelPort, path: "/events", agent: false }, response => {
    response.on("data", chunk => { if (chunk.toString().includes("data:")) heartbeats++; });
    response.on("error", error => { streamError = error; });
  });
  sse.on("error", error => { streamError = error; });
  await until(() => heartbeats > 0);
  // Built-in VS Code services start lazily after activation. Let their initial
  // process/FD growth settle before measuring the extension's steady state.
  if (options.service) await delay(30_000);
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const started = performance.now();
  const samples: Sample[] = [];
  const baseline = resources.budget.used;
  let cycle = 0;
  let exchanges = 0;
  let failure: unknown;
  const gc = { count: 0, major: 0, minor: 0, durationMs: 0 };
  const gcObserver = new PerformanceObserver(entries => {
    for (const entry of entries.getEntries()) {
      const kind = (entry as typeof entry & { detail: { kind: number } }).detail.kind;
      gc.count++;
      gc.durationMs += entry.duration;
      if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) gc.major++;
      if (kind === constants.NODE_PERFORMANCE_GC_MINOR) gc.minor++;
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });
  // Sampling is diagnostic-only: no object values or heap snapshot are saved,
  // and the normal 20-minute gate never changes GC behavior or its thresholds.
  const heapSession = process.env.PM_TEST_RESOURCE_HEAP_SAMPLING === "1" ? new Session() : undefined;
  const writeReport = (status: "running" | "passed" | "failed"): void => {
    const report = { platform: process.platform, arch: process.arch,
      nodeVersion: process.version, osRelease: os.release(), osVersion: os.version(), commit: process.env.GITHUB_SHA,
      scope: options.service ? "real-extension-host-and-daemon" : "standalone-proxy-managers",
      warmupSeconds: options.service ? 30 : 0, heapSampling: heapSession !== undefined,
      nativeProxy: nativeProxyPath !== undefined, nativeRouter: nativeRouterPath !== undefined,
      seconds: (performance.now() - started) / 1000, requestedSeconds: options.seconds, cycles: cycle,
      exchanges, sseHeartbeats: heartbeats, limits: resources.budget.limits, baseline,
      status, error: failure === undefined ? undefined : String(failure),
      profile: summarize(samples, process.pid), samples };
    fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
    // Replace complete checkpoints so interrupted CI uploads retain readable
    // evidence. A running checkpoint can never be mistaken for a pass.
    fs.writeFileSync(`${options.reportPath}.tmp`, JSON.stringify(report, null, 2));
    fs.renameSync(`${options.reportPath}.tmp`, options.reportPath);
  };
  const sample = async (phase: string): Promise<void> => {
    const processes = await processSamples(process.pid, options.service?.getDaemonStatus().pid);
    const current = resources.budget.used;
    for (const [key, value] of Object.entries(current)) {
      assert.ok(value <= resources.budget.limits[key as keyof ProxyResourceLimits], `Exceeded ${key} budget`);
    }
    const memory = process.memoryUsage();
    const heap = getHeapStatistics();
    const allocations = heapSession && (phase === "after-cleanup" || phase === "settled" && cycle % 25 === 0)
      ? summarizeAllocations((await heapSession.post("HeapProfiler.getSamplingProfile")).profile) : undefined;
    samples.push({ elapsedSeconds: (performance.now() - started) / 1000, phase, cycle, resources: current,
      heapBytes: memory.heapUsed, heapCapacityBytes: memory.heapTotal, externalBytes: memory.external,
      arrayBufferBytes: memory.arrayBuffers, heapSpaces: getHeapSpaceStatistics(), heapCode: getHeapCodeStatistics(),
      nativeContexts: heap.number_of_native_contexts, detachedContexts: heap.number_of_detached_contexts,
      globalHandleBytes: heap.used_global_handles_size, gc: { ...gc }, allocationSites: allocations,
      eventLoopP99Ms: lag.percentile(99) / 1e6, processes });
    lag.reset();
    writeReport("running");
  };
  try {
    if (heapSession) {
      heapSession.connect();
      await heapSession.post("HeapProfiler.startSampling", { samplingInterval: 64 * 1024 });
    }
    await sample("baseline");
    while (performance.now() - started < options.seconds * 1000) {
      cycle++;
      const networks: LogicalNetwork[] = [];
      const exposures: HostPortExposure[] = [];
      const host = new HostPortProxyManager({ resolve: () => ({ host: "127.0.0.1", port: echoPort }) }, { resources, nativeProxyPath });
      const browser = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: httpPort }) }, { resources });
      const router = new LogicalPortRouterManager({ resolve: () => ({ host: "127.0.0.1", port: echoPort }) }, { resources, nativeRouterPath });
      let routerPort: number | undefined;
      try {
        const endpoints: { raw: number; http: number }[] = [];
        for (let index = 0; index < 3; index++) {
          const name = `soak-${cycle}-${index}`;
          const network = options.service ? await within(options.service.createNetwork(name, "nativeHelper"), "create network")
            : registry.addNetwork({ id: name, name, status: "running", runtimeKind: "nativeHelper", createdAt: new Date().toISOString() });
          networks.push(network);
          const rawPort = await availablePort();
          // The real service chooses the raw native path for a wildcard bind;
          // all clients and fixture targets still use ordinary loopback.
          const exposure = options.service ? await within(options.service.createExposure({ networkId: network.id,
            hostAddress: "0.0.0.0", hostPort: rawPort, targetAddress: "127.0.0.1", targetPort: echoPort }), "create exposure")
            : { id: name, networkId: network.id, hostAddress: "127.0.0.1", hostPort: rawPort,
              targetAddress: "127.0.0.1", targetPort: echoPort, protocol: "tcp" as const,
              status: "active" as const, createdAt: new Date().toISOString() };
          exposures.push(exposure);
          if (!options.service) await within(host.open(exposure), "open host listener");
          const browserPort = await availablePort();
          assert.ok(await within(browser.ensure({ id: name, networkId: network.id, logicalPort: httpPort,
            listenHost: "127.0.0.1", listenPorts: [browserPort], publicHost: "localhost" }), "open browser listener"));
          endpoints.push({ raw: rawPort, http: browserPort });
        }
        routerPort = await availablePort();
        await within(router.open(routerPort), "open logical router");
        if (cycle === 1 || cycle % 5 === 0) await sample("active");
        for (let burst = 0; burst < 4; burst++) {
          await Promise.all(endpoints.flatMap(endpoint => [
            rawExchange(endpoint.raw, `raw-${cycle}-${burst}`),
            httpExchange(endpoint.http, "GET", "soak-ok"),
            httpExchange(endpoint.http, "POST", `post-${cycle}-${burst}`),
          ]).concat([rawExchange(routerPort, `router-${cycle}-${burst}`)]));
          exchanges += 10;
          // Peer cancellation must release route/socket state without waiting
          // for the next periodic reconciliation or destroying the SSE stream.
          await Promise.all(endpoints.map(endpoint => cancelConnection(endpoint.raw)));
        }
        assert.equal(streamError, undefined, "Existing SSE stream failed during churn");
      } finally {
        if (routerPort !== undefined) await within(router.close(routerPort), "close logical router");
        await within(router.releaseAll(), "release logical routers");
        router.dispose();
        await within(browser.dispose(), "dispose browser listeners");
        await within(host.dispose(), "dispose host listeners");
        for (const exposure of exposures) if (options.service) await within(options.service.removeExposure(exposure.id), "remove exposure");
        for (const network of networks) {
          if (options.service) await within(options.service.removeNetwork(network.id), "remove network");
          else registry.removeNetwork(network.id);
        }
      }
      await until(() => equalResources(resources.budget.used, baseline), 10_000);
      if (cycle === 1 || cycle % 5 === 0) await sample("settled");
      await delay(1000);
      if (cycle % 10 === 0) console.log(`Resource soak: cycle=${cycle} exchanges=${exchanges} elapsed=${Math.round((performance.now() - started) / 1000)}s`);
    }
    assert.ok(heartbeats >= Math.floor(options.seconds / 2), "SSE heartbeats stopped during the soak");
    assert.equal(streamError, undefined);
    await sample("final-stream-active");
    const settled = samples.filter(entry => entry.phase === "settled");
    const first = settled[0];
    const last = settled[settled.length - 1];
    // The live service periodically launches discovery commands. Compare the
    // data-plane helpers only; keep all other descendants in the raw metrics.
    const proxyChildren = (entry: Sample) => entry.processes.filter(row => /portmanager_(?:tcp_router|host_exposure_proxy)(?:\.exe)?$/.test(row.command)).length;
    assert.ok(proxyChildren(last) <= proxyChildren(first), "Proxy children accumulated after cleanup");
    const firstHost = first.processes.find(entry => entry.pid === process.pid)!;
    const lastHost = last.processes.find(entry => entry.pid === process.pid)!;
    assert.ok(lastHost.descriptors <= firstHost.descriptors + 8, "Host FD/handle count grew after warmup");
    // RSS includes allocator and V8 high-water retention. Keep a generous
    // failure threshold and retain every sample for trend review, rather than
    // treating immediate return to the initial RSS as a correctness invariant.
    assert.ok(lastHost.rssKiB <= firstHost.rssKiB + 96 * 1024, "Host RSS grew more than 96 MiB after warmup");
  } catch (error) { failure = error; }
  finally {
    sse.destroy();
    await within(sentinel.dispose(), "close SSE sentinel").catch(error => { failure ??= error; });
    for (const socket of liveSockets) socket.destroy();
    await within(Promise.all([close(echoServer), close(httpServer)]), "close fixture backends").catch(error => { failure ??= error; });
    lag.disable();
    const cleanedBaseline = { ...baseline, listeners: baseline.listeners - 1, connections: baseline.connections - 1,
      upstreams: baseline.upstreams - 1, httpRequests: baseline.httpRequests - 1 };
    await until(() => equalResources(resources.budget.used, cleanedBaseline), 10_000).catch(error => { failure ??= error; });
    await sample("after-cleanup").catch(error => { failure ??= error; });
    gcObserver.disconnect();
    heapSession?.disconnect();
    writeReport(failure === undefined ? "passed" : "failed");
  }
  if (failure !== undefined) throw failure;
  console.log(`Resource soak passed: ${cycle} cycles, ${exchanges} exchanges; ${options.reportPath}`);
}

/** Sampled allocation stacks contain code locations, never application object values. */
function summarizeAllocations(profile: HeapProfiler.SamplingHeapProfile) {
  const sites = new Map<string, { functionName: string; url: string; line: number; bytes: number; callers: string[] }>();
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, parents: string[]): void => {
    const frame = node.callFrame;
    const location = `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.lineNumber + 1}`;
    const callers = parents.slice(-8);
    if (node.selfSize > 0) {
      const key = JSON.stringify([...callers, location]);
      const site = sites.get(key) ?? { functionName: frame.functionName, url: frame.url, line: frame.lineNumber + 1, bytes: 0, callers };
      site.bytes += node.selfSize;
      sites.set(key, site);
    }
    for (const child of node.children) visit(child, [...parents, location]);
  };
  visit(profile.head, []);
  const entries = [...sites.values()].sort((left, right) => right.bytes - left.bytes);
  return { sampledLiveBytes: entries.reduce((sum, site) => sum + site.bytes, 0), sites: entries.slice(0, 40) };
}

/** OS counters are sampled infrequently; short-lived measurement commands are excluded. */
async function processSamples(hostPid: number, daemonPid?: number): Promise<ProcessSample[]> {
  let rows: ProcessSample[];
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { [PSCustomObject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;command=$_.Name;rssKiB=[math]::Round($p.WorkingSet64/1024);cpuSeconds=$p.CPU;descriptors=$p.HandleCount} } } | ConvertTo-Json -Compress";
    const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    rows = JSON.parse(result.stdout);
  } else {
    const result = await execute("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="], { timeout: 5000 });
    rows = result.stdout.trim().split("\n").map(line => {
      const [pid, parent, rss, time, ...command] = line.trim().split(/\s+/);
      return { pid: Number(pid), parent: Number(parent), command: command.join(" "),
        rssKiB: Number(rss), cpuSeconds: cpuTime(time), descriptors: 0 };
    });
  }
  const selected = new Set([hostPid, ...(daemonPid ? [daemonPid] : [])]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (selected.has(row.parent) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
  }
  const result = rows.filter(row => selected.has(row.pid));
  if (process.platform !== "win32") await Promise.all(result.map(async row => {
    try {
      if (process.platform === "linux") row.descriptors = fs.readdirSync(`/proc/${row.pid}/fd`).length;
      else {
        const listing = await execute("lsof", ["-nP", "-a", "-p", String(row.pid), "-Ff"], { timeout: 5000 });
        row.descriptors = listing.stdout.split("\n").filter(line => /^f\d/.test(line)).length;
      }
    } catch (error) {
      // A child may exit between the process table and descriptor query.
      try { process.kill(row.pid, 0); } catch { return; }
      throw error;
    }
  }));
  // ps/PowerShell itself was a short-lived child of the measured host.
  return result.filter(row => { try { process.kill(row.pid, 0); return true; } catch { return false; } });
}

function summarize(samples: readonly Sample[], hostPid: number) {
  const settled = samples.filter(entry => entry.phase === "settled");
  const first = settled[0];
  const last = settled[settled.length - 1];
  const host = (entry: Sample) => entry.processes.find(row => row.pid === hostPid)!;
  return { peakTreeRssKiB: Math.max(...samples.map(entry => entry.processes.reduce((sum, row) => sum + row.rssKiB, 0))),
    peakTreeDescriptors: Math.max(...samples.map(entry => entry.processes.reduce((sum, row) => sum + row.descriptors, 0))),
    peakEventLoopP99Ms: Math.max(...samples.map(entry => entry.eventLoopP99Ms)),
    settledSamples: settled.length,
    hostRssGrowthKiB: first && last ? host(last).rssKiB - host(first).rssKiB : undefined,
    hostDescriptorGrowth: first && last ? host(last).descriptors - host(first).descriptors : undefined,
    hostMeanCpuPercent: first && last && last.elapsedSeconds > first.elapsedSeconds
      ? 100 * (host(last).cpuSeconds - host(first).cpuSeconds) / (last.elapsedSeconds - first.elapsedSeconds) : undefined };
}

function cpuTime(value: string): number {
  const [days, remainder] = value.includes("-") ? value.split("-") : ["0", value];
  return Number(days) * 86400 + remainder.split(":").reduce((total, component) => total * 60 + Number(component), 0);
}
function equalResources(left: ProxyResourceLimits, right: ProxyResourceLimits): boolean {
  return Object.keys(right).every(key => left[key as keyof ProxyResourceLimits] === right[key as keyof ProxyResourceLimits]);
}
async function until(condition: () => boolean, milliseconds = 5000): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Soak resource/readiness deadline exceeded");
    await delay(20);
  }
}
async function within<T>(work: Promise<T>, operation = "exchange"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Soak ${operation} deadline exceeded`)), 10_000);
  })]); } finally { clearTimeout(timer); }
}
async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return (server.address() as net.AddressInfo).port;
}
async function close(server: net.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function availablePort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
async function rawExchange(port: number, message: string): Promise<void> {
  const socket = net.createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
  socket.on("error", () => {});
  try {
    await within(once(socket, "connect"));
    let received = "";
    const ended = within(new Promise<void>((resolve, reject) => {
      socket.on("data", chunk => { received += chunk.toString(); });
      socket.once("end", resolve);
      socket.once("error", reject);
    }));
    socket.end(message);
    await ended;
    assert.equal(received, message, "FIN must drain the complete opposite-direction reply");
  } finally { socket.destroy(); }
}
async function cancelConnection(port: number): Promise<void> {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  try { await within(once(socket, "connect")); }
  finally { socket.destroy(); }
}
async function httpExchange(port: number, method: string, expected: string): Promise<void> {
  let request!: http.ClientRequest;
  try {
    const body = await within(new Promise<string>((resolve, reject) => {
      request = http.request({ host: "127.0.0.1", port, method, agent: false }, response => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { received += chunk; });
        response.once("error", reject);
        response.once("end", () => {
          if (response.statusCode !== 200) reject(new Error(`Unexpected soak HTTP status: ${response.statusCode}`));
          else resolve(received);
        });
      });
      request.once("error", reject);
      request.end(method === "POST" ? expected : undefined);
    }));
    assert.equal(body, expected);
  } finally { request?.destroy(); }
}

/** Standalone rehearsals never activate the extension or write shell/DNS assets. */
if (require.main === module) {
  void runResourceSoak({ moduleRoot: path.resolve(__dirname, "../../.."),
    seconds: Number(process.env.PM_TEST_RESOURCE_SOAK_SECONDS ?? 1200),
    reportPath: path.resolve(process.env.PM_TEST_RESOURCE_SOAK_REPORT ?? ".tmp/resource-soak.json")
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

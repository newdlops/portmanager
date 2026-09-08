import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  GeneratedRouteTableWatcher,
  readGeneratedRouteTableRoutes,
  type GeneratedRouteTableFileSystem,
} from "../../src/platform/network/generated-route-table-reader";

/** Uses distinct targets to make a changed table/shard precedence observable. */
function route(actualPort: number) {
  return { networkId: "network-1", logicalPort: 3000, actualPort, host: "127.0.0.1", status: "running", source: "hook" };
}

test("enumerates a shared route directory once and preserves route order with bounded parallel reads", async () => {
  const directory = path.join(os.tmpdir(), "pm-route-reader-order");
  const tables = Array.from({ length: 24 }, (_, index) => path.join(directory, `network-${index}.json`));
  const shards = tables.map((table) => table.replace(/\.json$/, "-port-3000.json"));
  const desiredOrder = tables.flatMap((table, index) => [table, shards[index]!]);
  const calls: string[] = [];
  let scans = 0;
  let active = 0;
  let maxActive = 0;
  const fileSystem: GeneratedRouteTableFileSystem = {
    readDirectory: async (target) => {
      scans++;
      assert.equal(target, directory);
      return [
        ...shards.map((shard) => ({ name: path.basename(shard), isFile: () => true })),
        { name: "unrelated-port-3000.json", isFile: () => true },
        { name: "network-0-port-4000.json", isFile: () => false },
        { name: "network-0-port-3000.tsv", isFile: () => true },
      ];
    },
    readTextFile: async (filePath) => {
      calls.push(filePath);
      maxActive = Math.max(maxActive, ++active);
      const index = desiredOrder.indexOf(filePath);
      assert.notEqual(index, -1);
      // Unequal I/O completion order must never let a shard displace its table.
      await new Promise((resolve) => setTimeout(resolve, index % 2 === 0 ? 5 : 1));
      active--;
      return JSON.stringify({ routes: [route(50_000 + index)] });
    },
  };

  const result = await readGeneratedRouteTableRoutes([...tables, tables[0]!], { fileSystem });
  assert.equal(scans, 1);
  assert.equal(calls.length, desiredOrder.length);
  assert.ok(maxActive > 1 && maxActive <= 8, `unexpected concurrent read count: ${maxActive}`);
  assert.deepEqual(result.map((entry) => entry.actualPort), desiredOrder.map((_, index) => 50_000 + index));
});

test("keeps valid peers when one shard is corrupt, missing, invalid, or expired", async () => {
  const directory = path.join(os.tmpdir(), "pm-route-reader-invalid");
  const table = path.join(directory, "network.json");
  const contents = new Map([
    [table, JSON.stringify({ routes: [route(50_000), null, { ...route(50_001), actualPort: 0 }] })],
    [path.join(directory, "network-port-3001.json"), "null"],
    [path.join(directory, "network-port-3002.json"), "{broken"],
    [path.join(directory, "network-port-3003.json"), JSON.stringify({ expiresAtMs: Date.now() - 120_000, routes: [route(50_003)] })],
    [path.join(directory, "network-port-3004.json"), JSON.stringify({ expiresAtMs: Date.now() - 1_000, routes: [route(50_004)] })],
    [path.join(directory, "network-port-3005.json"), JSON.stringify({ routes: [route(50_005)] })],
  ]);
  const fileSystem: GeneratedRouteTableFileSystem = {
    readDirectory: async () => [...contents.keys(), path.join(directory, "network-port-3006.json")]
      .map((filePath) => ({ name: path.basename(filePath), isFile: () => true })),
    readTextFile: async (filePath) => {
      const content = contents.get(filePath);
      if (content === undefined) throw new Error("ENOENT: shard replaced");
      return content;
    },
  };

  const result = await readGeneratedRouteTableRoutes([table], { fileSystem, expirationGraceMs: 30_000 });
  assert.deepEqual(result.map((entry) => entry.actualPort), [50_000, 50_004, 50_005]);
});

test("still reads known network tables when directory enumeration fails", async () => {
  let reads = 0;
  const fileSystem: GeneratedRouteTableFileSystem = {
    readDirectory: async () => { throw new Error("directory unavailable"); },
    readTextFile: async () => { reads++; return JSON.stringify({ routes: [route(50_000)] }); },
  };
  assert.deepEqual(await readGeneratedRouteTableRoutes([], { fileSystem }), []);
  assert.equal(reads, 0);
  assert.equal((await readGeneratedRouteTableRoutes(["network.json"], { fileSystem })).length, 1);
  assert.equal(reads, 1);
});

test("observes new shards and atomic replacements immediately without retaining deleted routes", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-route-reader-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const table = path.join(directory, "network.json");
  const shard = path.join(directory, "network-port-3000.json");

  assert.deepEqual(await readGeneratedRouteTableRoutes([table]), []);
  await fs.writeFile(shard, JSON.stringify({ routes: [route(50_000)] }));
  assert.equal((await readGeneratedRouteTableRoutes([table]))[0]?.actualPort, 50_000);

  const replacement = `${shard}.tmp`;
  await fs.writeFile(replacement, JSON.stringify({ routes: [route(50_001)] }));
  await fs.rename(replacement, shard);
  assert.equal((await readGeneratedRouteTableRoutes([table]))[0]?.actualPort, 50_001);

  await fs.unlink(shard);
  assert.deepEqual(await readGeneratedRouteTableRoutes([table]), []);
});

/** Wait for an observable file event/read instead of depending on the heavy routing poll. */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, "route file signal did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("one heartbeat reads only its changed shard among many networks", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-watch-incremental-"));
  const tables: string[] = [];
  for (let index = 0; index < 24; index++) {
    const table = path.join(directory, `network-${index}.json`);
    tables.push(table);
    await fs.writeFile(table, JSON.stringify({ routes: [route(50_000 + index)] }));
    for (let port = 0; port < 8; port++) {
      await fs.writeFile(path.join(directory, `network-${index}-port-${3000 + port}.json`), JSON.stringify({ routes: [route(50_000 + index)] }));
    }
  }
  let reads = 0, directoryReads = 0, signals = 0;
  const readPaths: string[] = [];
  const watcher = new GeneratedRouteTableWatcher({ onChanged: () => { signals++; }, fileSystem: {
    readDirectory: (target) => { directoryReads++; return fs.readdir(target, { withFileTypes: true }); },
    readTextFile: async (target) => { const text = await fs.readFile(target, "utf8"); reads++; readPaths.push(target); return text; },
  } });
  context.after(async () => { watcher.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  watcher.setPaths(tables);
  await waitFor(() => signals === 1);
  assert.equal(reads, 216);
  reads = 0; directoryReads = 0; readPaths.length = 0;
  const shard = path.join(directory, "network-0-port-3000.json");
  await fs.writeFile(`${shard}.tmp`, JSON.stringify({ expiresAtMs: Date.now() + 60_000, routes: [route(50_000)] }));
  await fs.rename(`${shard}.tmp`, shard);
  await waitFor(() => reads > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // fs.watch may report both replacement and metadata events for the same
  // atomic rename. Neither event may reread any of the 215 unchanged files.
  assert.deepEqual([...new Set(readPaths)], [shard]);
  assert.equal(directoryReads, 0);
  assert.equal(signals, 1);
});

test("cached watch content expires without another filesystem write", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-watch-expiry-"));
  const table = path.join(directory, "network.json");
  // Supply the document through the adapter so a delayed OS creation event
  // cannot be mistaken for an expiry-triggered read in this policy test.
  const document = JSON.stringify({ expiresAtMs: Date.now() + 300, routes: [route(50_000)] });
  let reads = 0, signals = 0;
  const watcher = new GeneratedRouteTableWatcher({ onChanged: () => { signals++; }, fileSystem: {
    readDirectory: (target) => fs.readdir(target, { withFileTypes: true }),
    readTextFile: async () => { reads++; return document; },
  } });
  context.after(async () => { watcher.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  watcher.setPaths([table]);
  await waitFor(() => signals === 1);
  await waitFor(() => signals === 2);
  assert.equal(reads, 1, "expiry must not reread an unchanged file or retain its route");
});

test("watches shard creation, atomic replacement and deletion while suppressing heartbeat-only changes", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-route-watch-"));
  const table = path.join(directory, "network.json");
  const shard = path.join(directory, "network-port-3000.json");
  let signals = 0;
  let completedReads = 0;
  const watcher = new GeneratedRouteTableWatcher({
    onChanged: () => { signals++; },
    fileSystem: {
      readDirectory: (target) => fs.readdir(target, { withFileTypes: true }),
      readTextFile: async (target) => {
        try { return await fs.readFile(target, "utf8"); }
        finally { completedReads++; }
      },
    },
  });
  context.after(async () => { watcher.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  watcher.setPaths([table]);
  await waitFor(() => signals === 1);

  await fs.writeFile(shard, JSON.stringify({ expiresAtMs: Date.now() + 60_000, routes: [route(50_000)] }));
  await waitFor(() => signals === 2);

  const readsBeforeHeartbeat = completedReads;
  await fs.writeFile(`${shard}.tmp`, JSON.stringify({
    updatedAt: "heartbeat", expiresAtMs: Date.now() + 90_000,
    routes: [{ ...route(50_000), updatedAt: "heartbeat" }],
  }));
  await fs.rename(`${shard}.tmp`, shard);
  await waitFor(() => completedReads > readsBeforeHeartbeat);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signals, 2);

  await fs.writeFile(`${shard}.tmp`, JSON.stringify({ routes: [route(50_001)] }));
  await fs.rename(`${shard}.tmp`, shard);
  await waitFor(() => signals === 3);
  assert.equal((await readGeneratedRouteTableRoutes([table]))[0]?.actualPort, 50_001);

  await fs.unlink(shard);
  await waitFor(() => signals === 4);
  assert.deepEqual(await readGeneratedRouteTableRoutes([table]), []);

  const readsBeforeUnrelated = completedReads;
  await fs.writeFile(path.join(directory, "other-port-3000.json"), JSON.stringify({ routes: [route(50_002)] }));
  await fs.writeFile(`${shard}.tmp`, "temporary write");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(completedReads, readsBeforeUnrelated);
  watcher.clear();
  await fs.writeFile(shard, JSON.stringify({ routes: [route(50_002)] }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(signals, 4, "a former owner must stop observing files");
});

test("replays a file signal arriving while the previous route read is pending", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-route-watch-burst-"));
  const table = path.join(directory, "network.json");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  let signals = 0;
  let actualPort = 50_000;
  const watcher = new GeneratedRouteTableWatcher({
    onChanged: () => { signals++; },
    fileSystem: {
      readDirectory: async () => [],
      readTextFile: async () => {
        const content = JSON.stringify({ routes: [route(actualPort)] });
        if (++reads === 1) await gate;
        return content;
      },
    },
  });
  context.after(async () => { release(); watcher.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  watcher.setPaths([table]);
  await waitFor(() => reads === 1);
  actualPort = 50_001;
  await fs.writeFile(table, JSON.stringify({ routes: [route(actualPort)] }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  await waitFor(() => signals === 2);
  assert.ok(reads >= 2);
});

test("network replacement and disposal fence stale watcher reads", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-route-watch-owner-"));
  const first = path.join(directory, "first.json");
  const second = path.join(directory, "second.json");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  let signals = 0;
  const watcher = new GeneratedRouteTableWatcher({
    onChanged: () => { signals++; },
    fileSystem: {
      readDirectory: async () => [],
      readTextFile: async (target) => {
        reads++;
        if (target === first) await gate;
        return JSON.stringify({ routes: [route(target === first ? 50_000 : 50_001)] });
      },
    },
  });
  context.after(async () => { release(); watcher.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  watcher.setPaths([first]);
  await waitFor(() => reads === 1);
  watcher.setPaths([second]);
  release();
  await waitFor(() => signals === 1);
  assert.equal(reads, 2);
  watcher.dispose();
  watcher.setPaths([first]);
  await fs.writeFile(second, JSON.stringify({ routes: [route(50_002)] }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(signals, 1);
});

test("a normal owner refresh reinstalls a failed route directory watcher", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-route-watch-retry-"));
  const table = path.join(directory, "network.json");
  const fsModule = require("node:fs") as typeof import("node:fs");
  const originalWatch = fsModule.watch;
  let attempts = 0;
  context.mock.method(fsModule, "watch", (...args: Parameters<typeof originalWatch>) => {
    if (++attempts === 1) throw new Error("watch temporarily unavailable");
    return originalWatch(...args);
  });
  let signals = 0;
  const watcher = new GeneratedRouteTableWatcher({ onChanged: () => { signals++; } });
  context.after(async () => { watcher.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  watcher.setPaths([table]);
  await waitFor(() => signals === 1);
  watcher.setPaths([table]);
  await fs.writeFile(table, JSON.stringify({ routes: [route(50_000)] }));
  await waitFor(() => signals === 2);
  assert.equal(attempts, 2);
});

test("disposing a watcher suppresses a late initial observation", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pm-route-watch-dispose-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let signals = 0;
  const watcher = new GeneratedRouteTableWatcher({
    onChanged: () => { signals++; },
    fileSystem: {
      readDirectory: async () => [],
      readTextFile: async () => { started = true; await gate; return JSON.stringify({ routes: [route(50_000)] }); },
    },
  });
  context.after(async () => { release(); watcher.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  watcher.setPaths([path.join(directory, "network.json")]);
  await waitFor(() => started);
  watcher.dispose();
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(signals, 0);
});

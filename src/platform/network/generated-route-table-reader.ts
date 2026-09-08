import { watch, type Dirent, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LogicalPortRoute } from "../../shared/types";

/** Filesystem boundary for reading daemon fallback snapshots without starting a scan. */
export interface GeneratedRouteTableFileSystem {
  readDirectory(directory: string): Promise<readonly Pick<Dirent, "name" | "isFile">[]>;
  readTextFile(filePath: string): Promise<string>;
}

export interface GeneratedRouteTableReaderOptions {
  /** Caller-owned grace period for a daemon heartbeat racing an expiring file. */
  readonly expirationGraceMs?: number;
  readonly fileSystem?: GeneratedRouteTableFileSystem;
}

const FILE_SYSTEM: GeneratedRouteTableFileSystem = {
  readDirectory: (directory) => fs.readdir(directory, { withFileTypes: true }),
  readTextFile: (filePath) => fs.readFile(filePath, "utf8"),
};

/** Bounds descriptors and thread-pool work when many networks publish port shards. */
const MAX_CONCURRENT_READS = 8;

/**
 * Reads network tables and their per-port shards as one fallback snapshot.
 *
 * Each directory is enumerated once, then a bounded worker pool reads files.
 * Results retain table-before-shard and caller network order so parallel I/O
 * cannot change first-match route precedence. Nothing is cached: a newly
 * published server or replacement shard must be visible on the next refresh.
 */
export async function readGeneratedRouteTableRoutes(
  networkTablePaths: readonly string[],
  options: GeneratedRouteTableReaderOptions = {},
): Promise<readonly LogicalPortRoute[]> {
  if (networkTablePaths.length === 0) return [];

  const fileSystem = options.fileSystem ?? FILE_SYSTEM;
  const paths = await listRouteTableFiles(networkTablePaths, fileSystem);
  const documents = await readRouteTables(paths, fileSystem);
  return documents.flatMap((document) => liveDocumentRoutes(document, options.expirationGraceMs ?? 0));
}

/** Full observations discover new/deleted shards; named watch events skip this enumeration. */
async function listRouteTableFiles(
  networkTablePaths: readonly string[], fileSystem: GeneratedRouteTableFileSystem,
): Promise<readonly string[]> {
  const directories = new Map<string, Awaited<ReturnType<GeneratedRouteTableFileSystem["readDirectory"]>>>();
  for (const filePath of networkTablePaths) {
    const directory = path.dirname(filePath);
    if (!directories.has(directory)) {
      directories.set(directory, await fileSystem.readDirectory(directory).catch(() => []));
    }
  }

  const filePaths = new Set<string>();
  for (const tablePath of networkTablePaths) {
    const parsed = path.parse(tablePath);
    const extension = parsed.ext || ".json";
    const shardPrefix = `${parsed.name}-port-`;
    filePaths.add(tablePath);
    for (const entry of directories.get(path.dirname(tablePath)) ?? []) {
      if (entry.isFile() && entry.name.startsWith(shardPrefix) && entry.name.endsWith(extension)) {
        filePaths.add(path.join(parsed.dir, entry.name));
      }
    }
  }

  return [...filePaths];
}

interface RouteTableDocument {
  readonly routes: readonly LogicalPortRoute[];
  readonly expiresAtMs?: number;
}

/** Both full snapshots and event bursts share the same bounded read workers. */
async function readRouteTables(
  paths: readonly string[], fileSystem: GeneratedRouteTableFileSystem,
): Promise<readonly (RouteTableDocument | undefined)[]> {
  const results: (RouteTableDocument | undefined)[] = new Array(paths.length);
  // Workers claim an index before awaiting I/O; output order stays independent
  // of disk completion order, and a malformed shard cannot discard its peers.
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_READS, paths.length) }, async () => {
    while (nextIndex < paths.length) {
      const index = nextIndex++;
      results[index] = await readRouteTable(paths[index]!, fileSystem);
    }
  }));
  return results;
}

/** Rejects one missing, corrupt, or expired document without dropping the rest of the snapshot. */
async function readRouteTable(
  filePath: string,
  fileSystem: GeneratedRouteTableFileSystem,
): Promise<RouteTableDocument | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fileSystem.readTextFile(filePath));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const document = parsed as { readonly expiresAtMs?: unknown; readonly routes?: unknown };
    return {
      routes: Array.isArray(document.routes) ? document.routes.filter(isLogicalPortRoute) : [],
      ...(typeof document.expiresAtMs === "number" && Number.isFinite(document.expiresAtMs)
        ? { expiresAtMs: document.expiresAtMs } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Cached watch observations expire even if the writer stops producing events. */
function liveDocumentRoutes(document: RouteTableDocument | undefined, graceMs: number): readonly LogicalPortRoute[] {
  if (document === undefined || (document.expiresAtMs !== undefined && Date.now() > document.expiresAtMs + graceMs)) return [];
  return document.routes;
}

/** Keeps legacy optional metadata while requiring valid TCP routing coordinates. */
function isLogicalPortRoute(value: unknown): value is LogicalPortRoute {
  if (typeof value !== "object" || value === null) return false;
  const route = value as Partial<LogicalPortRoute>;
  return (
    isTcpPort(route.logicalPort) &&
    isTcpPort(route.actualPort) &&
    typeof route.host === "string" &&
    typeof route.status === "string" &&
    typeof route.source === "string" &&
    (route.networkId === undefined || typeof route.networkId === "string") &&
    (route.routeDirection === undefined || route.routeDirection === "listen" || route.routeDirection === "send") &&
    (route.cwd === undefined || typeof route.cwd === "string") &&
    (route.processName === undefined || typeof route.processName === "string")
  );
}

function isTcpPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export interface GeneratedRouteTableWatcherOptions extends GeneratedRouteTableReaderOptions {
  /** Signals changed routing content; the caller owns reconciliation and lease checks. */
  readonly onChanged: () => void;
}

/**
 * Watches directory entries so atomic table/shard replacement remains visible.
 * Only routing content triggers reconciliation: publication timestamps and TTL
 * heartbeats alone must not repeatedly rebuild all browser listeners.
 */
export class GeneratedRouteTableWatcher {
  /** The current owner's network tables define the accepted shard filenames. */
  private tablePaths: readonly string[] = [];
  /** One OS watcher per directory, recreated by setPaths after a watch error. */
  private readonly watchers = new Map<string, FSWatcher>();
  /** Fixed burst window, independent of the owner's low-frequency polling timer. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Signals arriving during an async read require one more observation. */
  private dirty = false;
  private reading = false;
  /** Only the watcher caches observations; public snapshot reads always read current files. */
  private readonly documents = new Map<string, RouteTableDocument>();
  private readonly changedFiles = new Set<string>();
  /** Missing filenames and watcher reattachment require full directory reconciliation. */
  private fullRead = true;
  /** Wakes at the earliest document expiry without rereading unchanged files. */
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Discards late reads after network changes, owner loss, or disposal. */
  private generation = 0;
  /** Last routing content, excluding publication-only metadata and heartbeat timestamps. */
  private signature: string | undefined;
  private disposed = false;

  constructor(private readonly options: GeneratedRouteTableWatcherOptions) {}

  /** Called by the active owner; normal polls also restore a failed directory watcher. */
  setPaths(tablePaths: readonly string[]): void {
    if (this.disposed) return;
    const paths = [...new Set(tablePaths)];
    if (paths.length === 0) {
      this.clear();
      return;
    }
    const changed = JSON.stringify(paths) !== JSON.stringify(this.tablePaths);
    if (changed) {
      this.tablePaths = paths;
      this.generation++;
      this.signature = undefined;
      this.documents.clear();
      this.changedFiles.clear();
      this.fullRead = true;
    }
    const directories = new Set(paths.map((filePath) => path.dirname(filePath)));
    for (const [directory, watcher] of this.watchers) {
      if (!directories.has(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    }
    let added = false;
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (filename === null) {
            this.fullRead = true;
            this.scheduleRead();
          } else if (this.isRouteFile(directory, String(filename))) {
            this.changedFiles.add(path.join(directory, String(filename)));
            this.scheduleRead();
          }
        });
        watcher.on("error", () => {
          watcher.close();
          if (this.watchers.get(directory) === watcher) this.watchers.delete(directory);
        });
        this.watchers.set(directory, watcher);
        added = true;
      } catch {
        // Missing/recreated storage is repaired by the caller's existing poll.
      }
    }
    if (changed || added) {
      this.fullRead = true;
      this.scheduleRead();
    }
  }

  /** Owner handoff cancels pending signals and invalidates reads already in flight. */
  clear(): void {
    this.generation++;
    this.tablePaths = [];
    this.signature = undefined;
    this.dirty = false;
    this.fullRead = true;
    this.documents.clear();
    this.changedFiles.clear();
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  /** Ignore temporary files, lease heartbeats, DNS sidecars, and unrelated networks. */
  private isRouteFile(directory: string, name: string): boolean {
    return this.tablePaths.some((filePath) => {
      const parsed = path.parse(filePath);
      return path.dirname(filePath) === directory && (name === parsed.base ||
        (name.startsWith(`${parsed.name}-port-`) && name.endsWith(parsed.ext || ".json")));
    });
  }

  /** A fixed 50ms burst window cannot be postponed indefinitely by ongoing writes. */
  private scheduleRead(): void {
    if (this.disposed || this.tablePaths.length === 0) return;
    this.dirty = true;
    if (this.timer !== undefined || this.reading) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.readChanges();
    }, 50);
    this.timer.unref?.();
  }

  private async readChanges(): Promise<void> {
    this.reading = true;
    this.dirty = false;
    const generation = this.generation;
    const fullRead = this.fullRead;
    const changedFiles = [...this.changedFiles];
    this.fullRead = false;
    this.changedFiles.clear();
    try {
      const fileSystem = this.options.fileSystem ?? FILE_SYSTEM;
      const paths = fullRead ? await listRouteTableFiles(this.tablePaths, fileSystem) : changedFiles;
      const documents = await readRouteTables(paths, fileSystem);
      if (this.disposed || generation !== this.generation) return;
      if (fullRead) this.documents.clear();
      paths.forEach((filePath, index) => {
        const document = documents[index];
        if (document === undefined) this.documents.delete(filePath);
        else this.documents.set(filePath, document);
      });
      // File order is stable even when atomic replacement changes event order.
      // This signature detects routing changes; the owner still reads a fresh
      // full snapshot to preserve table/shard route precedence when applying it.
      const routes = [...this.documents].sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, document]) => liveDocumentRoutes(document, this.options.expirationGraceMs ?? 0));
      const signature = JSON.stringify(routes.map((route) => [
        route.networkId, route.logicalPort, route.actualPort, route.host, route.routeDirection,
        route.status, route.source, route.processId, route.processName, route.cwd,
        route.terminalSessionId, route.processGroupId,
      ]));
      if (signature !== this.signature) {
        this.signature = signature;
        // The first observation also signals: a write racing startup must not
        // become an invisible baseline after the owner's initial route read.
        this.options.onChanged();
      }
      this.scheduleExpiry();
    } catch {
      // File observation is best effort; the periodic reconciliation survives.
    } finally {
      this.reading = false;
      if (this.dirty) this.scheduleRead();
    }
  }

  /** TTL metadata is retained even when its heartbeat does not change routing. */
  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const now = Date.now();
    const deadlines = [...this.documents.values()].flatMap((document) => {
      const deadline = document.expiresAtMs === undefined ? undefined
        : document.expiresAtMs + (this.options.expirationGraceMs ?? 0) + 1;
      return deadline !== undefined && deadline > now ? [deadline] : [];
    });
    if (deadlines.length === 0) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.scheduleRead();
    }, Math.min(Math.min(...deadlines) - now, 2_147_483_647));
    this.expiryTimer.unref?.();
  }
}

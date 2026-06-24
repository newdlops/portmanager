import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LogicalNetworkRegistryState } from "../../core/networks/logical-network-registry";
import type { DisposableLike } from "../../shared/types";

/**
 * File-backed logical network state shared by every VS Code window.
 *
 * VS Code `globalState` is durable, but each extension host keeps its own
 * in-memory copy and does not broadcast updates to sibling windows. This store
 * makes the persistable logical-network model observable through one atomic
 * JSON document under globalStorage while the daemon remains the route owner.
 */

const STATE_FILE_NAME = "logical-network-state.v1.json";
const STATE_VERSION = 1;
const WATCH_DEBOUNCE_MS = 50;

export interface SharedLogicalNetworkStateDocument {
  /** Schema version for future migrations. */
  readonly version: 1;
  /** Monotonic-enough token used only to ignore duplicate watcher events. */
  readonly revision: string;
  /** ISO timestamp of the last persisted state mutation. */
  readonly updatedAt: string;
  /** Persisted logical network state shared by extension windows. */
  readonly state: LogicalNetworkRegistryState;
}

export interface SharedLogicalNetworkStateStoreOptions {
  /** VS Code extension globalStorage directory. */
  readonly storageDirectory: string;
}

export class SharedLogicalNetworkStateStore {
  /** Absolute path of the shared state document. */
  readonly filePath: string;

  constructor(options: SharedLogicalNetworkStateStoreOptions) {
    this.filePath = path.join(options.storageDirectory, STATE_FILE_NAME);
  }

  /** Reads the current shared state document, accepting legacy raw-state JSON. */
  load(): SharedLogicalNetworkStateDocument | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      return parseSharedStateDocument(parsed);
    } catch {
      return undefined;
    }
  }

  /** Atomically writes a new shared state revision. */
  save(state: LogicalNetworkRegistryState): SharedLogicalNetworkStateDocument {
    const document: SharedLogicalNetworkStateDocument = {
      version: STATE_VERSION,
      revision: createRevision(),
      updatedAt: new Date().toISOString(),
      state: cloneState(state),
    };
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.filePath);

    return document;
  }

  /**
   * Watches the storage directory instead of the file itself.
   *
   * Atomic rename replaces the file inode, so watching the parent directory is
   * the portable way to observe both create and replace events.
   */
  watch(listener: () => void): DisposableLike {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let timer: NodeJS.Timeout | undefined;
    const watcher = fs.watch(path.dirname(this.filePath), (_eventType, filename) => {
      if (filename !== null && filename !== undefined && filename.toString() !== path.basename(this.filePath)) {
        return;
      }

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = undefined;
        listener();
      }, WATCH_DEBOUNCE_MS);
    });

    return {
      dispose: () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        watcher.close();
      },
    };
  }
}

function parseSharedStateDocument(value: unknown): SharedLogicalNetworkStateDocument | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.version === STATE_VERSION && typeof value.revision === "string" && isRegistryState(value.state)) {
    return {
      version: STATE_VERSION,
      revision: value.revision,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      state: cloneState(value.state),
    };
  }

  if (isRegistryState(value)) {
    return {
      version: STATE_VERSION,
      revision: "legacy",
      updatedAt: new Date(0).toISOString(),
      state: cloneState(value),
    };
  }

  return undefined;
}

function isRegistryState(value: unknown): value is LogicalNetworkRegistryState {
  if (!isRecord(value)) {
    return false;
  }

  return Array.isArray(value.networks) && Array.isArray(value.attachments) && Array.isArray(value.exposures);
}

function cloneState(state: LogicalNetworkRegistryState): LogicalNetworkRegistryState {
  return JSON.parse(JSON.stringify(state)) as LogicalNetworkRegistryState;
}

function createRevision(): string {
  return `${Date.now()}-${process.pid}-${randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import type { DisposableLike } from "./types";

/**
 * Minimal synchronous event emitter used by framework-neutral modules.
 *
 * VS Code has its own EventEmitter, but core modules should not import VS Code.
 * This class provides the small subset needed for registry updates and launcher
 * process-exit notifications.
 */
export class SimpleEventEmitter<T> {
  /** Active listeners kept in insertion order so update events are predictable. */
  private readonly listeners = new Set<(event: T) => void>();

  /**
   * Subscribes to future events and returns a small disposable object.
   * Disposing more than once is safe because Set.delete is idempotent.
   */
  subscribe(listener: (event: T) => void): DisposableLike {
    this.listeners.add(listener);

    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Emits an event to a snapshot of current listeners. Snapshotting prevents a
   * listener that unsubscribes itself from changing the current dispatch loop.
   */
  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  /** Removes every listener during extension deactivation or test cleanup. */
  clear(): void {
    this.listeners.clear();
  }
}

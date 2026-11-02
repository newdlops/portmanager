import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { ensureAgentControllerToken } from "./agent-authorization";

/**
 * Shares explicit suspension between extension hosts beside the private
 * controller credential. Each Stop owns an immutable marker. Start removes
 * only markers it observed, so a concurrent/later Stop cannot be erased by an
 * older restart finishing its shutdown grace period. No timer or watcher is
 * needed; automatic startup checks the current intent at its existing gates.
 */
export class DaemonStartIntentStore {
  private readonly directory: string;

  constructor(private readonly controllerTokenPath: string) {
    this.directory = `${controllerTokenPath}.stopped`;
  }

  /** A missing store is the default automatic-start policy. Errors fail closed. */
  isSuspended(): boolean { return this.markers().length > 0; }

  /** Capture before a Restart awaits shutdown; later Stops are a different set. */
  observe(): readonly string[] { return this.markers(); }

  /** Returns the exact suspension set that an associated Restart may clear. */
  suspend(): readonly string[] {
    ensureAgentControllerToken(this.controllerTokenPath);
    try { fs.mkdirSync(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const previous = this.markers();
    const marker = randomBytes(16).toString("hex");
    const descriptor = fs.openSync(`${this.directory}/${marker}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.closeSync(descriptor);
    return [...previous, marker];
  }

  /** Explicit Start clears current stops; Restart supplies its earlier set. */
  resume(markers: readonly string[] = this.markers()): boolean {
    this.markers(); // Validate even when an older Restart supplies its own set.
    for (const marker of markers) {
      if (!/^[0-9a-f]{32}$/.test(marker)) throw new Error("Invalid daemon suspension marker.");
      try { fs.unlinkSync(`${this.directory}/${marker}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return !this.isSuspended();
  }

  private markers(): readonly string[] {
    let stats: fs.Stats;
    try { stats = fs.lstatSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stats.uid !== process.getuid())) {
      throw new Error("Daemon suspension storage must be a private owned directory.");
    }
    const markers = fs.readdirSync(this.directory);
    if (markers.some(marker => !/^[0-9a-f]{32}$/.test(marker))) throw new Error("Invalid daemon suspension storage.");
    return markers;
  }
}

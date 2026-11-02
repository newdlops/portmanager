import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { networkStorageKey } from "../../core/networks/network-identity";

export interface NamespaceNetworkIdentity {
  readonly id: string;
  readonly name: string;
}

/** Inactive originals are preserved; callers must show where edits now belong. */
export interface LegacyNetworkSettingsNotice {
  readonly sourcePath: string;
  readonly destinationPath: string;
  /** Metadata-only change token for notification deduplication; never contains file values. */
  readonly signature: string;
  readonly isDirectory: boolean;
}

/** Resolve ownership independently of the readable name, including duplicate names. */
export function networkNamespacePaths(root: string, networkId: string): {
  directory: string; envFilePath: string; filesDirectory: string;
} {
  networkStorageKey(networkId); // Validate identity; it no longer determines the settings folder name.
  const directory = findOwnedNamespace(root, networkId);
  if (directory === undefined) throw new Error("Attach the network to this workspace before opening its settings folder.");
  return { directory, envFilePath: path.join(directory, "environment.env"), filesDirectory: path.join(directory, "files") };
}

/** Keep human text intact; escape only bytes unsafe in a portable path component. */
function readableNetworkName(name: string): string {
  let result = "";
  const characters = [...(name || "Network")];
  let trailing = characters.length;
  while (trailing > 0 && /[. ]/.test(characters[trailing - 1])) trailing--;
  for (const [index, character] of characters.entries()) {
    const escaped = index >= trailing || /[\u0000-\u001f\u007f/\\%<>:"|?*]/.test(character)
      ? [...Buffer.from(character)].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("")
      : character;
    if (Buffer.byteLength(result + escaped) > 220) break;
    result += escaped;
  }
  // Windows aliases and trailing dots/spaces must not select a different folder.
  // Truncation can expose a formerly interior dot/space at the new end.
  const suffix = result.match(/[. ]+$/)?.[0];
  if (suffix !== undefined) {
    result = result.slice(0, -suffix.length);
    for (const character of suffix) {
      const escaped = character === "." ? "%2E" : "%20";
      if (Buffer.byteLength(result + escaped) > 220) break;
      result += escaped;
    }
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result || "Network";
}

/** Only an owned regular marker can identify a network, never an env display name. */
function findOwnedNamespace(root: string, networkId: string): string | undefined {
  const parent = path.join(root, ".portmanager", "namespaces");
  if (!exists(parent)) return undefined;
  verifyOwnedDirectory(path.dirname(parent));
  verifyOwnedDirectory(parent);
  let found: string | undefined;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(parent, entry.name);
    const marker = path.join(directory, ".network-id");
    if (!exists(marker)) continue;
    verifyOwnedDirectory(directory);
    const descriptor = openRegularFile(marker);
    let owner: string;
    try { owner = fs.readFileSync(descriptor, "utf8"); }
    finally { fs.closeSync(descriptor); }
    if (owner !== networkId) continue;
    if (found !== undefined) throw new Error(`Multiple settings folders belong to network ${JSON.stringify(networkId)}. Resolve ${found} and ${directory} before attaching.`);
    found = directory;
  }
  return found;
}

/** A short filesystem lock serializes attaches from different VS Code windows. */
function withNamespaceLock(root: string, action: () => void): void {
  const lock = path.join(root, ".portmanager", ".namespace-lock");
  const temporary = path.join(root, ".portmanager", `.pm-lock-${randomUUID()}`);
  const deadline = Date.now() + 5_000;
  let acquired = false;
  try {
    // Publish a complete PID atomically; a failed write cannot strand an
    // ownerless lock between mkdir and owner-file creation.
    fs.writeFileSync(temporary, String(process.pid), { mode: 0o600, flag: "wx" });
    for (;;) {
      try { fs.linkSync(temporary, lock); acquired = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      let descriptor: number;
      try { descriptor = openRegularFile(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      let owner: number;
      try { owner = Number(fs.readFileSync(descriptor, "utf8")); }
      finally { fs.closeSync(descriptor); }
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === "ESRCH") {
            // Do not remove a pathname observed earlier: it may now hold a
            // successor's live lock. Stale locks require explicit recovery.
            throw new Error(`A previous network settings attach was interrupted. After confirming no attach is running, remove ${lock} and retry.`);
          }
        }
      }
      if (Date.now() >= deadline) throw new Error(`Network settings are busy. Retry attach; if a previous attach was interrupted, inspect ${lock}.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    action();
  } finally {
    if (acquired) fs.unlinkSync(lock);
    if (exists(temporary)) fs.unlinkSync(temporary);
  }
}

/** Move rather than copy on upgrade/rename: there is exactly one editable settings folder. */
function ensureNamedNamespace(root: string, networkId: string, name: string): void {
  const parent = path.join(root, ".portmanager", "namespaces");
  let previous = findOwnedNamespace(root, networkId);
  const opaque = path.join(parent, networkStorageKey(networkId));
  if (previous === undefined && exists(opaque)) {
    verifyOwnedDirectory(opaque);
    const marker = path.join(opaque, ".network-id");
    if (exists(marker)) {
      const descriptor = openRegularFile(marker);
      try {
        if (fs.readFileSync(descriptor, "utf8") !== networkId) throw new Error(`Existing settings folder belongs to another network: ${opaque}`);
      } finally { fs.closeSync(descriptor); }
    }
    previous = opaque;
  }
  if (previous !== undefined) {
    // Establish ownership before any move, so even an interrupted window
    // repair leaves the original settings discoverable on the next attach.
    publishPrivateFile(path.join(previous, ".network-id"), descriptor => fs.writeFileSync(descriptor, networkId));
    completeNamespaceMove(root, previous);
  }
  if (previous !== undefined && previous !== opaque) {
    const nameFile = path.join(previous, ".network-name");
    if (exists(nameFile)) {
      const descriptor = openRegularFile(nameFile);
      try { if (fs.readFileSync(descriptor, "utf8") === name) return; }
      finally { fs.closeSync(descriptor); }
    }
  }
  const base = readableNetworkName(name);
  // Apply the same collision rule on case-sensitive and normalizing filesystems.
  const equivalent = (value: string) => value.normalize("NFC").toLocaleLowerCase("en-US");
  const occupied = new Set(fs.readdirSync(parent).map(equivalent));
  let directory: string | undefined;
  for (let number = 1; number <= 10_000; number++) {
    const candidate = number === 1 ? base : `${base} (${number})`;
    if (previous !== undefined && equivalent(path.basename(previous)) === equivalent(candidate)) {
      directory = path.join(parent, candidate);
      if (previous !== directory) {
        publishPrivateFile(path.join(previous, ".previous-directory"), descriptor => fs.writeFileSync(descriptor, previous!));
        fs.renameSync(previous, directory);
        completeNamespaceMove(root, directory);
      }
      break;
    }
    if (occupied.has(equivalent(candidate))) continue;
    directory = path.join(parent, candidate);
    fs.mkdirSync(directory, { mode: 0o700 });
    if (previous !== undefined) {
      publishPrivateFile(path.join(previous, ".previous-directory"), descriptor => fs.writeFileSync(descriptor, previous!));
      try { fs.renameSync(previous, directory); }
      catch (error) { fs.rmdirSync(directory); throw error; }
      completeNamespaceMove(root, directory);
    }
    break;
  }
  if (directory === undefined) throw new Error(`Too many settings folders named ${JSON.stringify(name)}.`);
  publishPrivateFile(path.join(directory, ".network-id"), descriptor => fs.writeFileSync(descriptor, networkId));
  const nameFile = path.join(directory, ".network-name");
  // Only this metadata changes on rename; user settings never get overwritten.
  if (exists(nameFile)) {
    const descriptor = openRegularFile(nameFile);
    try { fs.fchmodSync(descriptor, 0o600); }
    finally { fs.closeSync(descriptor); }
    fs.unlinkSync(nameFile);
  }
  publishPrivateFile(nameFile, descriptor => fs.writeFileSync(descriptor, name));
}

/** A move receipt travels with the folder; retries finish only its exact observer windows. */
function completeNamespaceMove(root: string, directory: string): void {
  const receipt = path.join(directory, ".previous-directory");
  if (!exists(receipt)) return;
  const descriptor = openRegularFile(receipt);
  let previous: string;
  try { previous = fs.readFileSync(descriptor, "utf8"); }
  finally { fs.closeSync(descriptor); }
  if (path.dirname(previous) !== path.dirname(directory) || path.normalize(previous) !== previous) {
    throw new Error(`Invalid network settings move receipt: ${receipt}`);
  }
  repairStateWindows(root, previous, directory);
  fs.unlinkSync(receipt);
}

/** Retarget only PM's exact observer symlinks, without traversing shared directories. */
function repairStateWindows(root: string, previous: string, directory: string): void {
  const files = path.join(directory, "files");
  if (!exists(files)) return;
  const visit = (current: string, relative: string): void => {
    verifyOwnedDirectory(current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const next = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { visit(child, next); continue; }
      const original = path.join(root, next);
      // A shared parent symlink is outside the state-window contract.
      let parent = path.dirname(original);
      let safe = true;
      while (parent !== root) {
        const stats = fs.lstatSync(parent, { throwIfNoEntry: false });
        if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) { safe = false; break; }
        parent = path.dirname(parent);
      }
      if (!safe || !fs.lstatSync(original, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
      const target = fs.readlinkSync(original);
      const suffix = path.sep + path.join(path.relative(root, previous), "files", next);
      if (!path.isAbsolute(target) || !target.endsWith(suffix)) continue;
      try { if (fs.realpathSync(target.slice(0, -suffix.length) || path.sep) !== root) continue; }
      catch { continue; }
      const temporary = path.join(path.dirname(original), `.pm-window-${randomUUID()}`);
      fs.symlinkSync(path.join(files, next), temporary);
      try { fs.renameSync(temporary, original); }
      finally { if (exists(temporary)) fs.unlinkSync(temporary); }
    }
  };
  visit(files, "");
}

/**
 * Creates private, readable name-based storage and imports an unambiguous legacy name
 * once. Publishing each file without replacement makes repeated/concurrent
 * scaffolds safe. An ambiguous legacy namespace requires explicit migration;
 * it must never be silently assigned to a second logical network.
 */
export function ensureNetworkNamespaceScaffold(
  root: string,
  networkId: string,
  networkName: string | undefined,
  knownNetworks: readonly NamespaceNetworkIdentity[] = [],
): readonly LegacyNetworkSettingsNotice[] {
  root = fs.realpathSync(root);
  networkStorageKey(networkId);
  const stateDirectory = path.join(root, ".portmanager");
  ensurePrivateDirectory(stateDirectory);
  ensurePrivateDirectory(path.join(stateDirectory, "namespaces"));
  let notices: readonly LegacyNetworkSettingsNotice[] = [];
  withNamespaceLock(root, () => {
    ensureNamedNamespace(root, networkId, networkName || "Network");
    scaffoldNamespaceContents(root, networkId, networkName, knownNetworks);
    notices = collectLegacySettingsNotices(root, networkId, networkName, knownNetworks);
  });
  return notices;
}

/** Receipts retain the old name after rename, including imports made by earlier versions. */
function collectLegacySettingsNotices(root: string, networkId: string, networkName: string | undefined,
  knownNetworks: readonly NamespaceNetworkIdentity[]): readonly LegacyNetworkSettingsNotice[] {
  const state = path.join(root, ".portmanager");
  const receipts = path.join(state, "legacy-owners");
  const owners = new Map<string, Set<string>>();
  if (exists(receipts)) {
    verifyOwnedDirectory(receipts);
    for (const entry of fs.readdirSync(receipts)) {
      const descriptor = openRegularFile(path.join(receipts, entry));
      let receipt: { networkId?: unknown; legacyKey?: unknown };
      try { receipt = JSON.parse(fs.readFileSync(descriptor, "utf8")); }
      finally { fs.closeSync(descriptor); }
      if (typeof receipt.networkId !== "string" || typeof receipt.legacyKey !== "string" ||
          safeLegacyKey(receipt.legacyKey) !== receipt.legacyKey) throw new Error(`Invalid legacy settings receipt: ${entry}`);
      const ids = owners.get(receipt.legacyKey) ?? new Set<string>();
      ids.add(receipt.networkId);
      owners.set(receipt.legacyKey, ids);
    }
  }
  const keys = new Set([...owners].filter(([, ids]) => ids.has(networkId)).map(([key]) => key));
  const currentKey = safeLegacyKey(networkName || networkId);
  if (currentKey !== undefined && (!owners.has(currentKey) || owners.get(currentKey)!.has(networkId))) keys.add(currentKey);
  const paths = networkNamespacePaths(root, networkId);
  const notices: LegacyNetworkSettingsNotice[] = [];
  for (const key of keys) {
    const candidates = [
      [path.join(state, "env", `${key}.env`), paths.envFilePath],
      [path.join(state, "files", key), paths.filesDirectory],
    ].filter(([source]) => exists(source));
    if (candidates.length === 0) continue;
    if (!owners.has(key)) {
      const equivalent = (value: string) => value.normalize("NFC").toLocaleLowerCase("en-US");
      const users = knownNetworks.filter(network => {
        const candidate = safeLegacyKey(network.name || network.id);
        return candidate !== undefined && equivalent(candidate) === equivalent(key);
      });
      if (users.length !== 1 || users[0].id !== networkId) {
        throw new Error(`Legacy network files for ${JSON.stringify(networkName || networkId)} are ambiguous. Preserve them and explicitly migrate this network to ${paths.directory}.`);
      }
      claimLegacyNamespace(state, key, networkId);
    } else if (owners.get(key)!.size !== 1) {
      throw new Error(`Legacy settings have multiple owners: ${key}`);
    }
    for (const [sourcePath, destinationPath] of candidates) {
      verifyOwnedDirectory(path.dirname(sourcePath));
      const fingerprint = createHash("sha256").update(sourcePath).update(destinationPath);
      const visit = (file: string): void => {
        const stats = fs.lstatSync(file);
        if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
          throw new Error(`Legacy network storage contains a symlink or special file requiring explicit migration: ${file}`);
        }
        fingerprint.update(JSON.stringify([file, stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]));
        if (stats.isDirectory()) {
          verifyOwnedDirectory(file);
          for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
        } else {
          const descriptor = openRegularFile(file);
          fs.closeSync(descriptor);
        }
      };
      visit(sourcePath);
      notices.push({ sourcePath, destinationPath, signature: fingerprint.digest("hex"), isDirectory: fs.lstatSync(sourcePath).isDirectory() });
    }
  }
  return notices;
}

/** Explicit editor requests may create an empty private substitute, never overwrite one. */
export function ensureNetworkDotenvSubstitute(root: string, networkId: string): string {
  const paths = networkNamespacePaths(fs.realpathSync(root), networkId);
  verifyOwnedDirectory(paths.filesDirectory);
  const dotenv = path.join(paths.filesDirectory, ".env");
  publishPrivateFile(dotenv, descriptor => fs.writeFileSync(descriptor,
    "# Network-specific dotenv substitute. Use environment.env for inherited overrides.\n"));
  return dotenv;
}

/** Populate only missing files after ownership and readable location are established. */
function scaffoldNamespaceContents(root: string, networkId: string, networkName: string | undefined,
  knownNetworks: readonly NamespaceNetworkIdentity[]): void {
  const stateDirectory = path.join(root, ".portmanager");
  const paths = networkNamespacePaths(root, networkId);
  ensurePrivateDirectory(paths.directory);
  ensurePrivateDirectory(paths.filesDirectory);

  if (exists(paths.envFilePath)) {
    validatePrivateFile(paths.envFilePath);
  } else {
    const legacyKey = safeLegacyKey(networkName || networkId);
    const legacyEnv = legacyKey === undefined ? undefined : path.join(stateDirectory, "env", `${legacyKey}.env`);
    const legacyFiles = legacyKey === undefined ? undefined : path.join(stateDirectory, "files", legacyKey);
    const hasLegacy = (legacyEnv !== undefined && exists(legacyEnv)) || (legacyFiles !== undefined && exists(legacyFiles));
    if (hasLegacy && legacyKey !== undefined) {
      const equivalent = (value: string) => value.normalize("NFC").toLocaleLowerCase("en-US");
      const physicalIdentities = legacyPhysicalIdentities(stateDirectory, legacyKey);
      const users = knownNetworks.filter(network => {
        const candidate = safeLegacyKey(network.name || network.id);
        return candidate !== undefined && (equivalent(candidate) === equivalent(legacyKey) ||
          legacyPhysicalIdentities(stateDirectory, candidate).some(identity => physicalIdentities.includes(identity)));
      });
      if (users.length !== 1 || users[0].id !== networkId) {
        throw new Error(`Legacy network files for ${JSON.stringify(networkName || networkId)} are ambiguous. Preserve them and explicitly migrate this network to ${paths.directory}.`);
      }
      claimLegacyNamespace(stateDirectory, legacyKey, networkId);
      if (legacyFiles !== undefined && exists(legacyFiles)) {
        verifyOwnedDirectory(path.dirname(legacyFiles));
        copyLegacyDirectory(legacyFiles, paths.filesDirectory);
      }
      if (legacyEnv !== undefined && exists(legacyEnv)) {
        verifyOwnedDirectory(path.dirname(legacyEnv));
        copyPrivateFileExclusive(legacyEnv, paths.envFilePath);
      }
    }
    // Env publication is last: a failed import remains retryable, while a
    // completed namespace keeps its values across renames and reloads.
    if (!exists(paths.envFilePath)) {
      publishPrivateFile(paths.envFilePath, descriptor => {
        fs.writeFileSync(descriptor, [
          `# Port Manager per-network environment for ${JSON.stringify(networkName || networkId)}.`,
          `# Stable network id: ${JSON.stringify(networkId)}`,
          "# KEY=VALUE lines apply before main(); existing network files are never overwritten.",
          "# PORT_MANAGER_*/NEWDLOPS_PM_*/PATH/BASH_ENV/preload keys are ignored.",
          "# See docs/per-network-env.md.", "",
        ].join("\n"));
      });
    }
  }
  const originalDotenv = path.join(root, ".env");
  const networkDotenv = path.join(paths.filesDirectory, ".env");
  if (exists(originalDotenv) && !exists(networkDotenv)) {
    copyPrivateFileExclusive(originalDotenv, networkDotenv);
  } else if (exists(networkDotenv)) {
    validatePrivateFile(networkDotenv);
  }
}

/** Dot segments and overlong legacy keys are never candidates for migration. */
function safeLegacyKey(name: string): string | undefined {
  const key = name.replace(/\//g, "-");
  if (key.length === 0 || key === "." || key === ".." || key.includes("\\") || key.includes("\0") ||
      Buffer.byteLength(key, "utf8") > 251) return undefined;
  return key;
}

function exists(filePath: string): boolean {
  return fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
}

/** Verify through the descriptor, so chmod never follows a substituted symlink. */
function ensurePrivateDirectory(directory: string): void {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isDirectory() || (process.getuid !== undefined && stats.uid !== process.getuid())) {
      throw new Error(`Network storage directory has an unexpected owner or type: ${directory}`);
    }
    fs.fchmodSync(descriptor, 0o700);
  } finally { fs.closeSync(descriptor); }
}

function openRegularFile(filePath: string): number {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || (process.getuid !== undefined && stats.uid !== process.getuid())) {
      throw new Error(`Network file has an unexpected owner or type: ${filePath}`);
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

/** Legacy parents cannot redirect an import through a symlink. */
function verifyOwnedDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isDirectory() || (process.getuid !== undefined && stats.uid !== process.getuid())) {
      throw new Error(`Legacy network directory has an unexpected owner or type: ${directory}`);
    }
  } finally { fs.closeSync(descriptor); }
}

function validatePrivateFile(filePath: string): void {
  const descriptor = openRegularFile(filePath);
  try { fs.fchmodSync(descriptor, 0o600); }
  finally { fs.closeSync(descriptor); }
}

/** No visible destination exists until all bytes have been written and closed. */
function publishPrivateFile(destination: string, write: (descriptor: number) => void): void {
  const temporary = path.join(path.dirname(destination), `.pm-copy-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    write(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try { fs.linkSync(temporary, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    validatePrivateFile(destination);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (exists(temporary)) fs.unlinkSync(temporary);
  }
}

function copyPrivateFileExclusive(source: string, destination: string): void {
  if (exists(destination)) { validatePrivateFile(destination); return; }
  const input = openRegularFile(source);
  try {
    publishPrivateFile(destination, output => {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let count: number;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
        let offset = 0;
        while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
      }
    });
  } finally { fs.closeSync(input); }
}

/** A private ownership receipt prevents a reused/deleted name importing another id's secrets. */
function claimLegacyNamespace(stateDirectory: string, legacyKey: string, networkId: string): void {
  const owners = path.join(stateDirectory, "legacy-owners");
  ensurePrivateDirectory(owners);
  for (const identity of [`name:${legacyKey.normalize("NFC").toLocaleLowerCase("en-US")}`, ...legacyPhysicalIdentities(stateDirectory, legacyKey)]) {
    const hash = createHash("sha256").update(identity).digest("hex");
    const receipt = path.join(owners, `${hash}.json`);
    publishPrivateFile(receipt, descriptor => fs.writeFileSync(descriptor, JSON.stringify({ networkId, legacyKey })));
    const descriptor = openRegularFile(receipt);
    try {
      const owner = JSON.parse(fs.readFileSync(descriptor, "utf8")) as { networkId?: string };
      if (owner.networkId !== networkId) throw new Error(`Legacy namespace is owned by another network. Explicitly migrate preserved files to ${networkNamespacePaths(path.dirname(stateDirectory), networkId).directory}.`);
    } finally { fs.closeSync(descriptor); }
  }
}

/** Actual inodes cover filesystem case-folding and aliases that JS normalization misses. */
function legacyPhysicalIdentities(stateDirectory: string, legacyKey: string): string[] {
  const identities: string[] = [];
  for (const candidate of [path.join(stateDirectory, "env", `${legacyKey}.env`), path.join(stateDirectory, "files", legacyKey)]) {
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stats !== undefined) identities.push(`inode:${stats.dev}:${stats.ino}`);
  }
  return identities;
}

/** Never follow legacy symlinks into another network or outside the project. */
function copyLegacyDirectory(source: string, destination: string): void {
  const stats = fs.lstatSync(source);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (process.getuid !== undefined && stats.uid !== process.getuid())) {
    throw new Error(`Legacy network storage must be an owned directory: ${source}`);
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      ensurePrivateDirectory(to);
      copyLegacyDirectory(from, to);
    } else if (entry.isFile()) {
      copyPrivateFileExclusive(from, to);
    } else {
      throw new Error(`Legacy network storage contains a symlink or special file requiring explicit migration: ${from}`);
    }
  }
}

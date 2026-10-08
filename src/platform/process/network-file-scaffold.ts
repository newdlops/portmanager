import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { networkStorageKey } from "../../core/networks/network-identity";

export interface NamespaceNetworkIdentity {
  readonly id: string;
  readonly name: string;
}

/** Stable paths are also constructed by the native hook; legacy files remain untouched. */
export function networkNamespacePaths(root: string, networkId: string): {
  directory: string; envFilePath: string; filesDirectory: string;
} {
  const directory = path.join(root, ".portmanager", "namespaces", networkStorageKey(networkId));
  return { directory, envFilePath: path.join(directory, "environment.env"), filesDirectory: path.join(directory, "files") };
}

/**
 * Creates private, id-scoped storage and imports an unambiguous legacy name
 * once. Publishing each file without replacement makes repeated/concurrent
 * scaffolds safe. An ambiguous legacy namespace requires explicit migration;
 * it must never be silently assigned to a second logical network.
 */
export function ensureNetworkNamespaceScaffold(
  root: string,
  networkId: string,
  networkName: string | undefined,
  knownNetworks: readonly NamespaceNetworkIdentity[] = [],
): void {
  root = fs.realpathSync(root);
  const paths = networkNamespacePaths(root, networkId);
  const stateDirectory = path.join(root, ".portmanager");
  ensurePrivateDirectory(stateDirectory);
  ensurePrivateDirectory(path.join(stateDirectory, "namespaces"));
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

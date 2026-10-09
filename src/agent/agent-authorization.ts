import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { networkStorageKey } from "../core/networks/network-identity";
import { loopbackAddressForNetwork } from "../core/networks/loopback-address";

export const AGENT_NETWORK_TOKEN_ENV = "PORT_MANAGER_AGENT_NETWORK_TOKEN";

/** Controller credentials live outside every writable network namespace. */
export function getAgentControllerTokenPath(socketPath: string): string {
  const key = Buffer.from(socketPath, "utf8").toString("hex");
  if (key.length === 0 || key.length > 224) throw new Error("Agent socket identity is too long for its private credential.");
  return path.join(os.homedir(), ".portmanager", "security", "agent-control", `${key}.key`);
}

/**
 * Publish a complete secret without replacing an existing controller key.
 * The sandbox denies this directory even when project source is shared.
 * A same-UID program outside that sandbox remains outside the selected threat
 * model; filesystem modes alone do not exclude it.
 */
export function ensureAgentControllerToken(tokenPath: string): string {
  try { return readAgentControllerToken(tokenPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  publishPrivateCredential(tokenPath, randomBytes(32).toString("hex") + "\n");
  return readAgentControllerToken(tokenPath);
}

/** A network key grants route ownership only; it never grants controller methods. */
export function getAgentNetworkTokenPath(controllerTokenPath: string, networkId: string): string {
  return path.join(`${controllerTokenPath}.scopes`, `${networkStorageKey(networkId)}.key`);
}

export function ensureAgentNetworkToken(socketPath: string, networkId: string, controllerPath = getAgentControllerTokenPath(socketPath)): string {
  ensureAgentControllerToken(controllerPath);
  const tokenPath = getAgentNetworkTokenPath(controllerPath, networkId);
  const host = loopbackAddressForNetwork(networkId);
  try { readPrivateCredential(tokenPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    publishPrivateCredential(tokenPath, `${randomBytes(32).toString("hex")}\n${host}\n`);
  }
  const contents = readPrivateCredential(tokenPath);
  if (!/^[0-9a-f]{64}\n127\.\d{1,3}\.\d{1,3}\.\d{1,3}\n$/.test(contents) || contents.slice(65, -1) !== host) {
    throw new Error("Invalid agent network credential.");
  }
  return contents.slice(0, 64);
}

function publishPrivateCredential(tokenPath: string, contents: string): void {
  const parent = path.dirname(tokenPath);
  ensurePrivateDirectoryTree(parent);
  const temporary = path.join(parent, `.token-${randomBytes(12).toString("hex")}`);
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    created = true;
    fs.writeFileSync(descriptor, contents);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try { fs.linkSync(temporary, tokenPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) fs.unlinkSync(temporary);
  }
}

/** Read through a non-following descriptor and reject a public or foreign key. */
export function readAgentControllerToken(tokenPath: string): string {
  const contents = readPrivateCredential(tokenPath);
  if (!/^[0-9a-f]{64}\n$/.test(contents)) throw new Error("Invalid agent controller credential.");
  return contents.slice(0, -1);
}

function readPrivateCredential(tokenPath: string): string {
  assertDirectoryAncestors(path.dirname(tokenPath));
  const parent = fs.statSync(path.dirname(tokenPath));
  if ((parent.mode & 0o077) !== 0 || (process.getuid !== undefined && parent.uid !== process.getuid())) {
    throw new Error("Agent credential directory must be private and owned.");
  }
  const descriptor = fs.openSync(tokenPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size < 65 || stats.size > 82 || (stats.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stats.uid !== process.getuid())) {
      throw new Error("Agent controller credential must be a private owned regular file.");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally { fs.closeSync(descriptor); }
}

/** Never compare attacker-sized strings or log secret values. */
export function agentControllerTokenMatches(expected: string, supplied: unknown): boolean {
  return /^[0-9a-f]{64}$/.test(expected) && typeof supplied === "string" && /^[0-9a-f]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

function ensurePrivateDirectoryTree(directory: string): void {
  const missing: string[] = [];
  let cursor = directory;
  while (fs.lstatSync(cursor, { throwIfNoEntry: false }) === undefined) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("No existing parent for agent credential storage.");
    cursor = parent;
  }
  // Inspect every existing ancestor, not just the final component: a link in
  // the middle could redirect secrets into shared project state.
  assertDirectoryAncestors(directory);
  for (const candidate of missing.reverse()) {
    try { fs.mkdirSync(candidate, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stats = fs.lstatSync(candidate);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Unsafe agent credential directory.");
  }
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fs.fstatSync(descriptor);
    if (process.getuid !== undefined && stats.uid !== process.getuid()) throw new Error("Foreign agent credential directory.");
    fs.fchmodSync(descriptor, 0o700);
  } finally { fs.closeSync(descriptor); }
}

function assertDirectoryAncestors(directory: string): void {
  for (let probe = path.resolve(directory); probe !== path.dirname(probe); probe = path.dirname(probe)) {
    const stats = fs.lstatSync(probe, { throwIfNoEntry: false });
    if (stats !== undefined && (!stats.isDirectory() || stats.isSymbolicLink())) {
      throw new Error("Agent credential storage must not traverse a symlink.");
    }
  }
}

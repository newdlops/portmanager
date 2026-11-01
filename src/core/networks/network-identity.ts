import { Buffer } from "node:buffer";

/** Shared with pm_network_namespace.h: keys fit a filesystem component without truncation. */
export const MAX_NETWORK_ID_BYTES = 124;

/**
 * Internal credential keys belong to the stable id, never the display name. Encoding UTF-8
 * bytes is injective even on case-insensitive/Unicode-normalizing filesystems;
 * slashes and dot segments cannot redirect a key. User-editable local settings
 * use readable network-name folders in the filesystem adapter instead.
 */
export function networkStorageKey(networkId: string): string {
  const bytes = Buffer.from(networkId, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_NETWORK_ID_BYTES || networkId.includes("\0") ||
      bytes.toString("utf8") !== networkId) {
    throw new Error("Logical network identity must contain 1–124 valid UTF-8 bytes without NUL.");
  }
  return `id-${bytes.toString("hex")}`;
}

/**
 * Error types shared across layers. They live here so the command layer can
 * branch on a failure kind without importing the service implementation.
 */

/**
 * Local DNS recovery failed while no root-owned drift was found (lo0 alias,
 * `/etc/resolver`, `/etc/hosts`, TLS material versus the alias → loopback
 * mapping; an lo0 probe that could not run counts as unknown, not drift), so
 * no administrator prompt was opened. The failure lies in
 * a user-owned layer (daemon DNS table, resolver answer, proxy listener, or
 * Keychain trust). Commands may offer an explicit privileged reapply in response.
 */
export class LocalDnsRecoveryWithoutPrivilegesError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "LocalDnsRecoveryWithoutPrivilegesError";
  }
}

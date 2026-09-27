import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  invalidateBrowserTlsTrustStatus,
  isTrustVerificationVerdict,
  readCachedBrowserTlsTrustStatus,
  refreshBrowserTlsTrustStatus,
} from "../../src/platform/network/browser-tls-trust";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../", relativePath), "utf8");
}

test("missing TLS material is never reported as trusted", async () => {
  const missingRoot = path.join(os.tmpdir(), `portmanager-missing-ca-${process.pid}.crt`);
  const missingLeaf = path.join(os.tmpdir(), `portmanager-missing-leaf-${process.pid}.crt`);
  invalidateBrowserTlsTrustStatus();

  const cached = readCachedBrowserTlsTrustStatus(missingRoot, missingLeaf);
  const refreshed = await refreshBrowserTlsTrustStatus(missingRoot, missingLeaf);
  const expectedState = process.platform === "darwin" ? "untrusted" : "unsupported";
  assert.equal(cached.state, expectedState);
  assert.equal(refreshed.state, expectedState);
});

test("only a completed verify-cert rejection counts as untrusted", async () => {
  // Real execFile error shapes: a timed-out or unlaunchable check has no trust
  // verdict, and treating it as untrusted re-registered the CA through a macOS
  // password dialog while trust was unchanged.
  const run = promisify(execFile);
  const settle = async (command: string, args: string[], timeout?: number): Promise<unknown> =>
    run(command, args, timeout === undefined ? {} : { timeout }).then(() => undefined, (error: unknown) => error);

  assert.equal(isTrustVerificationVerdict(await settle("/bin/sh", ["-c", "exit 1"])), true);
  assert.equal(isTrustVerificationVerdict(await settle("/bin/sleep", ["5"], 50)), false);
  assert.equal(isTrustVerificationVerdict(await settle("/nonexistent/portmanager-security", [])), false);
  assert.equal(isTrustVerificationVerdict(undefined), false);
  assert.equal(isTrustVerificationVerdict(new Error("no code")), false);
});

test("TLS readiness evaluates the real leaf against the default macOS keychain", () => {
  const trustSource = readSource("src/platform/network/browser-tls-trust.ts");
  const certificateSource = readSource("src/platform/network/browser-tls-certificate.ts");
  const dnsVerifierSource = readSource("src/platform/network/browser-dns-verifier.ts");
  const serviceSource = readSource("src/extension/network-service.ts");

  assert.equal(trustSource.includes('"verify-cert", "-c", leafCertificatePath'), true);
  assert.equal(trustSource.includes('"-p", "ssl", "-n", "localhost", "-L", "-q"'), true);
  assert.equal(trustSource.includes('"-r", caCertificatePath'), false);
  assert.equal(certificateSource.includes("certificate.checkHost(hostname)"), true);
  assert.equal(dnsVerifierSource.includes("lookupHost(hostname, { family: 4, all: true })"), true);
  assert.equal(serviceSource.includes("await verifyBrowserDnsAliasesResolve(status.records)"), true);
  assert.equal(serviceSource.includes("syncFs.readFileSync(BROWSER_TLS_SERVER_KEY_PATH)"), true);
  assert.equal(serviceSource.includes("resolveCurrentUserName()"), true);
  assert.equal(serviceSource.includes("os.userInfo().username"), true);
  assert.equal(serviceSource.includes("resolveCurrentUserHomeDirectory()"), true);
  assert.equal(serviceSource.includes("os.userInfo().homedir"), true);
  assert.equal(serviceSource.includes("await refreshBrowserTlsTrustStatus"), true);
  assert.equal(
    serviceSource.includes('["add-trusted-cert", "-r", "trustRoot", "-k", keychainPath'),
    true,
  );
  assert.equal(
    serviceSource.includes('["add-trusted-cert", "-d", "-r", "trustRoot", "-k", keychainPath'),
    false,
  );
  assert.equal(serviceSource.includes("Browser DNS files were installed, but the Port Manager DNS responder is not running."), true);
});

test("failed browser setup remains retryable and reports the actual failure", () => {
  const source = readSource("src/extension/network-service.ts");
  const start = source.indexOf("private maybeOfferBrowserDnsResolverInstall(): void");
  const end = source.indexOf("private rememberBrowserDnsInstallOfferSignature", start);
  const body = source.slice(start, end);

  assert.equal(body.includes("this.rememberBrowserDnsInstallOfferSignature(signature);"), true);
  assert.equal(body.includes("this.clearBrowserDnsInstallOfferSignature();"), true);
  assert.equal(body.includes("browser DNS/TLS setup failed"), true);
  assert.equal(body.includes('"Retry Setup"'), true);
  assert.equal(body.includes('executeCommand("portManager.installBrowserDnsResolvers")'), true);
});

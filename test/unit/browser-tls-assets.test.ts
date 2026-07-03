import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  BROWSER_TLS_DIRECTORY,
  BROWSER_TLS_RENEW_WINDOW_SECONDS,
  buildBrowserTlsRenewalShellScript,
  buildBrowserTlsRepairShellFunctions,
} from "../../src/platform/network/browser-tls-assets";

const hasPosixShell = process.platform !== "win32";
const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function shellSyntaxErrors(script: string): string {
  const result = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  return result.status === 0 ? "" : result.stderr || `sh -n exited ${result.status}`;
}

/** Retargets baked-in /Library paths into a sandbox and stubs privileged tools. */
function createRenewalSandbox(testDirPrefix: string): {
  readonly tlsDir: string;
  readonly runScript: (script: string) => SpawnSyncReturns<string>;
  readonly retarget: (script: string) => string;
} {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), testDirPrefix));
  const tlsDir = path.join(sandboxDir, "browser-tls");
  const stubBinDir = path.join(sandboxDir, "bin");
  fs.mkdirSync(stubBinDir, { recursive: true });
  // The real script must run as root and registers keychain trust; the sandbox
  // stubs those platform tools so the certificate pipeline itself stays real.
  fs.writeFileSync(path.join(stubBinDir, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(stubBinDir, "security"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(stubBinDir, "dscl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(stubBinDir, "sudo"), '#!/bin/sh\nshift 0\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stubBinDir, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const retarget = (script: string): string => script.split(BROWSER_TLS_DIRECTORY).join(tlsDir);
  const runScript = (script: string) => {
    const scriptPath = path.join(sandboxDir, "renew.sh");
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    return spawnSync("sh", [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubBinDir}${path.delimiter}${process.env.PATH ?? ""}`, SUDO_USER: "" },
    });
  };

  return { tlsDir, runScript, retarget };
}

test("renewal window matches the documented 30-day policy", () => {
  assert.equal(BROWSER_TLS_RENEW_WINDOW_SECONDS, 30 * 24 * 60 * 60);
});

test("standalone renewal script parses as POSIX shell", { skip: !hasPosixShell }, () => {
  const script = buildBrowserTlsRenewalShellScript();
  assert.equal(shellSyntaxErrors(script), "");
  assert.equal(script.includes('if [ "$(id -u)" != "0" ]; then'), true);
  assert.equal(script.includes("openssl x509 -checkend"), true);
  assert.equal(script.includes("PORTMANAGER_TLS_SERVER_CONF"), true);
  assert.equal(script.includes("security add-trusted-cert"), true);
  // Renewal must never invent hostnames: SANs come from the marker file.
  assert.equal(script.includes('"$__pm_tls_hosts_file" >> "$__pm_tls_server_conf"'), true);
});

test("pm repair TLS shell functions parse as POSIX shell", { skip: !hasPosixShell }, () => {
  const fragment = buildBrowserTlsRepairShellFunctions("/tmp/portmanager-renew-browser-tls.sh");
  assert.equal(shellSyntaxErrors(fragment), "");
  assert.equal(fragment.includes("__pm_browser_tls_cert_stale()"), true);
  assert.equal(fragment.includes("__pm_browser_tls_repair_if_stale()"), true);
  assert.equal(fragment.includes(`openssl x509 -checkend ${BROWSER_TLS_RENEW_WINDOW_SECONDS}`), true);
  assert.equal(fragment.includes("sudo /bin/sh"), true);
});

test(
  "renewal script reissues the leaf for marker hostnames end to end",
  { skip: !hasPosixShell || !hasOpenssl },
  () => {
    const sandbox = createRenewalSandbox("portmanager-tls-renew-");
    fs.mkdirSync(sandbox.tlsDir, { recursive: true });
    fs.writeFileSync(path.join(sandbox.tlsDir, "hostnames.txt"), "localhost\nproduction1\nproduction1.pm\n", "utf8");

    const result = sandbox.runScript(sandbox.retarget(buildBrowserTlsRenewalShellScript()));
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout ?? "", /Port Manager browser TLS certificate renewed/);

    const certPath = path.join(sandbox.tlsDir, "portmanager-browser.crt");
    const certText = execFileSync("openssl", ["x509", "-noout", "-text", "-in", certPath], { encoding: "utf8" });
    assert.match(certText, /DNS:localhost/);
    assert.match(certText, /DNS:production1/);
    assert.match(certText, /DNS:production1\.pm/);
    assert.match(certText, /IP Address:127\.0\.0\.1/);

    // A second run keeps the still-valid CA so existing trust stays intact.
    const caPath = path.join(sandbox.tlsDir, "portmanager-root-ca.crt");
    const caBefore = fs.readFileSync(caPath, "utf8");
    const secondRun = sandbox.runScript(sandbox.retarget(buildBrowserTlsRenewalShellScript()));
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(fs.readFileSync(caPath, "utf8"), caBefore);
  },
);

test(
  "stale check flags missing and short-lived leaves but keeps fresh ones",
  { skip: !hasPosixShell || !hasOpenssl },
  () => {
    const sandbox = createRenewalSandbox("portmanager-tls-stale-");
    const fragment = sandbox.retarget(buildBrowserTlsRepairShellFunctions("/tmp/unused-renew.sh"));
    const staleProbe = `${fragment}\nif __pm_browser_tls_cert_stale; then echo STALE; else echo FRESH; fi\n`;

    // No marker: TLS was never installed, so repair leaves it alone.
    let result = sandbox.runScript(staleProbe);
    assert.equal((result.stdout ?? "").trim(), "FRESH", result.stderr);

    // Marker without leaf files: renewal can restore them, so it is stale.
    fs.mkdirSync(sandbox.tlsDir, { recursive: true });
    fs.writeFileSync(path.join(sandbox.tlsDir, "hostnames.txt"), "localhost\n", "utf8");
    result = sandbox.runScript(staleProbe);
    assert.equal((result.stdout ?? "").trim(), "STALE", result.stderr);

    // A freshly renewed certificate (825 days) is not stale.
    const renewal = sandbox.runScript(sandbox.retarget(buildBrowserTlsRenewalShellScript()));
    assert.equal(renewal.status, 0, renewal.stderr);
    result = sandbox.runScript(staleProbe);
    assert.equal((result.stdout ?? "").trim(), "FRESH", result.stderr);

    // A leaf expiring within the renewal window is stale again.
    const certPath = path.join(sandbox.tlsDir, "portmanager-browser.crt");
    const keyPath = path.join(sandbox.tlsDir, "portmanager-browser.key");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=short-lived", "-keyout", keyPath, "-out", certPath],
      { stdio: "ignore" },
    );
    result = sandbox.runScript(staleProbe);
    assert.equal((result.stdout ?? "").trim(), "STALE", result.stderr);
  },
);

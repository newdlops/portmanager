import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

/*
 * Shape tests pinning stability while the container daemon is stopped: compose
 * attachments must not oscillate between attached and error on refresh ticks,
 * because that teardown respawns every host gateway helper and re-prompts for
 * packet-filter admin rights on each cycle.
 */

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../", relativePath), "utf8");
}

test("daemon-down override regeneration keeps attachments and existing overrides", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("function isDockerDaemonUnavailableError"), true);
  assert.equal(source.includes("DOCKER_DAEMON_UNAVAILABLE_RETRY_BACKOFF_MS = 30_000"), true);
  assert.equal(source.includes("private dockerDaemonUnavailableUntilMs = 0;"), true);

  const reconcileStart = source.indexOf("private async reconcileComposeOverrideFileForAttachment");
  const reconcileEnd = source.indexOf("private async reconcileMutationlessComposeOverrideFile", reconcileStart);
  const reconcileBody = source.slice(reconcileStart, reconcileEnd);

  // The catch path must keep a readable override attached instead of flipping
  // the attachment into an error state that tears down live gateways.
  assert.equal(reconcileBody.includes("isDockerDaemonUnavailableError(error)"), true);
  assert.equal(
    reconcileBody.indexOf("isDockerDaemonUnavailableError(error)") <
      reconcileBody.indexOf('status: "error"'),
    true,
  );
  assert.equal(reconcileBody.includes("await this.composeOverrideFileIsReadable(attachment)"), true);

  // While the daemon is known to be down, forced refreshes skip spawning
  // doomed docker commands for every attachment on every tick.
  assert.equal(reconcileBody.includes("Date.now() < this.dockerDaemonUnavailableUntilMs"), true);
  assert.equal(
    reconcileBody.indexOf("this.dockerDaemonUnavailableUntilMs") <
      reconcileBody.indexOf("await this.composePublishMutator.restoreHiddenPortsOverride"),
    true,
  );

  // The daemon-unavailable matcher covers the docker CLI's connection failures.
  const matcherStart = source.indexOf("function isDockerDaemonUnavailableError");
  const matcherBody = source.slice(matcherStart, matcherStart + 900);
  assert.equal(matcherBody.includes("cannot connect to the docker daemon"), true);
  assert.equal(matcherBody.includes("is the docker daemon running"), true);
});

test("empty packet-filter redirect selections wait out transient blinks", () => {
  const source = readSource("src/extension/network-service.ts");

  assert.equal(source.includes("HOST_LOCAL_GATEWAY_EMPTY_REDIRECT_STABLE_MS = 30_000"), true);
  assert.equal(source.includes("private hostLocalGatewayEmptyRedirectSinceMs = 0;"), true);

  const syncStart = source.indexOf("private async syncHostLocalGatewayRedirects");
  const syncBody = source.slice(syncStart, syncStart + 2600);
  assert.equal(syncBody.includes("if (redirects.length === 0) {"), true);
  assert.equal(syncBody.includes("HOST_LOCAL_GATEWAY_EMPTY_REDIRECT_STABLE_MS"), true);
  // Non-empty selections stay immediate for explicit attach flows.
  assert.equal(syncBody.includes("this.hostLocalGatewayEmptyRedirectSinceMs = 0;"), true);
  // A matching anchor resets both the signature and the empty-blink clock.
  assert.equal(
    syncBody.indexOf("isHostLocalGatewayRedirectAnchorCurrent(redirects)") <
      syncBody.indexOf("if (redirects.length === 0) {"),
    true,
  );
});

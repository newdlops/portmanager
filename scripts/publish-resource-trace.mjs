#!/usr/bin/env node
/**
 * Preserve a completed or interrupted numeric trace through the public Checks
 * API. This separate CI process never changes the measured host or its report.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readSnapshot } from "./supervise-packaged-validation.mjs";

/** Keep the complete report in one bounded request; never publish a prefix. */
export function tracePayload({ report, repository, sha, runId, runAttempt, checkpoint }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(String(runId), /^[1-9]\d*$/);
  assert.match(String(runAttempt), /^[1-9]\d*$/);
  assert.ok(["baseline", "5m", "10m", "15m", "final"].includes(checkpoint));
  assert.ok(["running", "passed", "failed"].includes(report.status));
  assert.ok(Array.isArray(report.samples) && report.samples.length > 0);
  const raw = JSON.stringify(report);
  const encoded = gzipSync(raw).toString("base64");
  const chunks = encoded.match(/.{1,4000}/g) ?? [];
  assert.ok(chunks.length <= 48, "The complete resource trace exceeds one 50-annotation request.");
  const messages = [`PM_RESOURCE_REPORT_GZIP_BASE64_BEGIN ${chunks.length}`,
    ...chunks.map((chunk, index) => `PM_RESOURCE_REPORT_GZIP_BASE64 ${index + 1}/${chunks.length} ${chunk}`),
    "PM_RESOURCE_REPORT_GZIP_BASE64_END"];
  return {
    name: `Port Manager resource trace / ${checkpoint}`,
    head_sha: sha,
    external_id: `portmanager-resource-trace:${runId}:${runAttempt}:${checkpoint}`,
    details_url: `https://github.com/${repository}/actions/runs/${runId}`,
    status: "completed",
    // This check records transport success, not a workload/resource gate pass.
    conclusion: "neutral",
    completed_at: new Date().toISOString(),
    output: {
      title: `Resource trace (${checkpoint}); validation status: ${report.status}`,
      summary: JSON.stringify({ checkpoint, status: report.status, error: report.error,
        scope: report.scope, hostPid: report.hostPid, seconds: report.seconds,
        requestedSeconds: report.requestedSeconds, cycles: report.cycles, profile: report.profile,
        samples: report.samples.length, rawBytes: Buffer.byteLength(raw), frames: chunks.length,
        sha256: createHash("sha256").update(raw).digest("hex") }),
      annotations: messages.map(message => ({ path: "test/integration/proxy-resource-soak.ts",
        start_line: 1, end_line: 1, annotation_level: "notice", message })),
    },
  };
}

/** Never redirect the installation token or leave a failed request unbounded. */
export async function publishTrace({ token, request = fetch, ...options }) {
  assert.ok(typeof token === "string" && token.length > 0, "A checks:write CI token is required.");
  const payload = tracePayload(options);
  const response = await request(`https://api.github.com/repos/${options.repository}/check-runs`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
      "content-type": "application/json", "x-github-api-version": "2022-11-28" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 201, `Resource trace metadata upload failed (HTTP ${response.status}).`);
  const result = await response.json();
  assert.ok(Number.isSafeInteger(result.id) && result.id > 0, "Missing check run acknowledgement.");
  assert.equal(result.head_sha, options.sha);
  assert.equal(result.output?.annotations_count, payload.output.annotations.length);
  return { checkRunId: result.id, headSha: result.head_sha, checkpoint: options.checkpoint,
    annotations: result.output.annotations_count, ...JSON.parse(payload.output.summary) };
}

async function main() {
  assert.equal(process.env.CI, "true", "Trace publishing requires disposable CI.");
  assert.ok(process.env.RUNNER_TEMP);
  const [checkpoint, reportPath] = process.argv.slice(2);
  assert.ok(reportPath && path.isAbsolute(reportPath));
  const acknowledgement = await publishTrace({ checkpoint, report: readSnapshot(reportPath),
    repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    token: process.env.PM_TEST_TRACE_TOKEN });
  fs.writeFileSync(`${reportPath}.check.json`, JSON.stringify(acknowledgement, null, 2));
  console.log(JSON.stringify(acknowledgement));
}

// Pure payload and HTTP-boundary tests do not activate VS Code or publish data.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

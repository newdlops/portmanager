import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReroutableCommand,
  detectTerminalListenFailure,
} from "../../src/core/terminal-conflict-parser";

/**
 * Unit tests for terminal listen-failure parsing.
 *
 * These rules are intentionally framework-neutral because VS Code shell
 * integration provides raw terminal text, while rerun decisions should be
 * testable without the VS Code API.
 */

test("detects Daphne listen failures with host and port", () => {
  const failure = detectTerminalListenFailure(
    "[CRITICAL] [daphne.server] Listen failure: Couldn't listen on 127.0.0.1:8004: [Errno 48] Address already in use.",
  );

  assert.equal(failure?.host, "127.0.0.1");
  assert.equal(failure?.port, 8004);
  assert.equal(failure?.reason, "address already in use");
});

test("detects generic EADDRINUSE output with host and port", () => {
  const failure = detectTerminalListenFailure("Error: listen EADDRINUSE: address already in use 0.0.0.0:3000");

  assert.equal(failure?.host, "0.0.0.0");
  assert.equal(failure?.port, 3000);
});

test("rewrites commands that already contain the requested port into template mode", () => {
  const reroutable = buildReroutableCommand("daphne -b 127.0.0.1 -p 8004 myapp.asgi:application", 8004);

  assert.equal(reroutable.injectionMode, "template");
  assert.equal(reroutable.command, "daphne -b 127.0.0.1 -p ${port} myapp.asgi:application");
});

test("uses argument mode when the failed command does not expose the requested port", () => {
  const reroutable = buildReroutableCommand("npm run dev", 5173);

  assert.equal(reroutable.injectionMode, "argument");
  assert.equal(reroutable.command, "npm run dev");
});

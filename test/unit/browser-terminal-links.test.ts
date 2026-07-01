import assert from "node:assert/strict";
import test from "node:test";

import { findSecureLocalTerminalBrowserUrls } from "../../src/platform/browser-terminal-links";

test("finds local development URLs that should open through Port Manager browser routing", () => {
  const line = "Local: http://localhost:3006/ Network: https://production1:3006/admin http://example.com/";
  const links = findSecureLocalTerminalBrowserUrls(line);

  assert.deepEqual(
    links.map((link) => ({ startIndex: link.startIndex, length: link.length, url: link.url })),
    [
      {
        startIndex: 7,
        length: "http://localhost:3006/".length,
        url: "http://localhost:3006/",
      },
      {
        startIndex: 39,
        length: "https://production1:3006/admin".length,
        url: "https://production1:3006/admin",
      },
    ],
  );
});

test("trims terminal punctuation without stripping balanced URL brackets", () => {
  const line = "open (http://production1:3006/login), then http://[::1]:3000/path(ok).";
  const links = findSecureLocalTerminalBrowserUrls(line);

  assert.deepEqual(
    links.map((link) => link.url),
    ["http://production1:3006/login", "http://[::1]:3000/path(ok)"],
  );
});

test("ignores public URLs because they do not use Port Manager browser routing", () => {
  assert.deepEqual(findSecureLocalTerminalBrowserUrls("https://example.com http://example.com"), []);
});

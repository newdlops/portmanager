import assert from "node:assert/strict";
import test from "node:test";

import { findSecureLocalTerminalBrowserUrls, resolveNetworkBrowserTargetUrl, selectTerminalNetworkFallback, selectUniqueTerminalNetworkId } from "../../src/platform/browser-terminal-links";

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

test("canonicalizes an exact routed loopback URL to the HTTPS alias without losing URL components", () => {
  const resolved = resolveNetworkBrowserTargetUrl("http://127.96.185.16:3004/path?x=1#section", [
    {
      networkId: "network-a",
      routedLoopbackHost: "127.96.185.16",
      browserLoopbackHost: "127.112.185.16",
      publicHost: "alpha1.pm",
      publicProtocol: "https",
      logicalPort: 3004,
      publicPort: 23004,
    },
  ]);

  assert.equal(resolved, "https://alpha1.pm:23004/path?x=1#section");
  assert.equal(resolveNetworkBrowserTargetUrl("http://127.96.185.17:3004/", []), "http://127.96.185.17:3004/");
  assert.equal(resolveNetworkBrowserTargetUrl("https://example.com:3004/", []), "https://example.com:3004/");
});

test("accepts known source aliases and preserves an explicit effective HTTP default port", () => {
  const target = {
    networkId: "network-a",
    routedLoopbackHost: "127.96.185.16",
    browserLoopbackHost: "127.112.185.16",
    publicHost: "published-alpha.pm",
    sourceHosts: ["alpha", "alpha.pm"],
    publicProtocol: "https" as const,
    logicalPort: 80,
  };
  assert.equal(resolveNetworkBrowserTargetUrl("http://alpha.pm/path", [target]), "https://published-alpha.pm:80/path");
  assert.equal(resolveNetworkBrowserTargetUrl("http://localhost:3004/", [target]), "http://localhost:3004/");
  assert.equal(
    resolveNetworkBrowserTargetUrl("http://localhost:80/", [target], "network-a"),
    "https://published-alpha.pm:80/",
  );
});

test("uses terminal localhost attribution only when attachment candidates are unambiguous", () => {
  assert.equal(selectUniqueTerminalNetworkId(["network-a", "network-a"]), "network-a");
  assert.equal(selectUniqueTerminalNetworkId(["network-a", "network-b"]), undefined);
  assert.equal(selectUniqueTerminalNetworkId([]), undefined);
});

test("prefers explicit terminal attribution and fails closed for ambiguous or missing PIDs", () => {
  const terminalB = { networkId: "network-b", rootPid: 200 };
  assert.equal(selectTerminalNetworkFallback(200, [terminalB], "network-a"), "network-b");
  assert.equal(
    selectTerminalNetworkFallback(200, [terminalB, { networkId: "network-c", processGroupId: 200 }], "network-a"),
    undefined,
  );
  assert.equal(selectTerminalNetworkFallback(undefined, [{ networkId: "network-b" }], "network-a"), "network-a");
  assert.equal(selectTerminalNetworkFallback(200, [], "network-a"), "network-a");
});

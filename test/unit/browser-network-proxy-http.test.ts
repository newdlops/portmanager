import assert from "node:assert/strict";
import * as http from "node:http";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { BrowserNetworkProxyManager, type ActiveBrowserNetworkProxyEndpoint } from "../../src/platform/ports/browser-network-proxy";
import { BrowserProxyResponseTransform, buildEndpointMetadata, rewriteBrowserProxyResponseTextForTest } from "../../src/platform/ports/browser-network-proxy-http";

const endpoint: ActiveBrowserNetworkProxyEndpoint = {
  id: "network-a:3004", networkId: "network-a", logicalPort: 3004,
  listenHost: "127.0.0.1", listenPorts: [38004], listenPort: 38004,
  publicHost: "alpha.pm", publicProtocol: "https", responseRewriteLoopbackHost: "127.96.1.2",
};

/** Execute actual byte streams so UTF-8 boundaries are tested as well as URL boundaries. */
async function rewrite(parts: readonly Buffer[]): Promise<string> {
  let text = "";
  await pipeline(Readable.from(parts), new BrowserProxyResponseTransform(buildEndpointMetadata(endpoint)),
    new Writable({ write(chunk, _encoding, callback) { text += chunk.toString("utf8"); callback(); } }));
  return text;
}

test("streaming rewrite preserves whole-body semantics at every byte boundary", async () => {
  const samples = [
    '한글🙂<a href="http://localhost:3004/path">링크</a>',
    'const a="ws://[::1]:3004/socket", b="//127.0.0.1:8000/api";',
    'https://127.96.1.2:3004/own https://127.96.1.3:3004/other',
    'xhttp://localhost:3004 _https://localhost/ ://localhost/ http://localhost.example/',
    'HTTP://LOCALHOST:1?query http://localhost:123456/invalid http://localhost:12345/path',
    'http://localhost//localhost:3004 http://localhosthttp://localhost/',
    '//localhost//localhost//localhost/ ://localhost //localhost',
    'http://localhost. http://localhost:abc http://localhost:12x http://localhost: http://localhost',
    'http://127.96.1.2:80?x ws://127.96.1.2:3004; //127.96.1.2#x',
    'plain 🙂 text with h w / http https ws wss at the end',
  ];
  for (const sample of samples) {
    const bytes = Buffer.from(sample);
    const expected = rewriteBrowserProxyResponseTextForTest(sample, endpoint);
    for (let split = 0; split <= bytes.length; split++) {
      assert.equal(await rewrite([bytes.subarray(0, split), bytes.subarray(split)]), expected, `${sample}; split=${split}`);
    }
    assert.equal(await rewrite([...bytes].map((byte) => Buffer.from([byte]))), expected, sample);
  }
});

test("response rewriting respects a slow downstream instead of consuming the whole body", async () => {
  let produced = 0;
  let entered!: () => void;
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const completion = pipeline(
    Readable.from((async function* () {
      for (let index = 0; index < 1024; index++) { produced++; yield Buffer.alloc(4096, "a"); }
    })(), { highWaterMark: 1 }),
    new BrowserProxyResponseTransform(buildEndpointMetadata(endpoint)),
    new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) {
      if (first) { first = false; entered(); void gate.then(() => callback()); }
      else callback();
    } }),
  );
  await firstWrite;
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(produced < 100, `consumed ${produced} chunks while the browser was blocked`);
  } finally { release(); }
  await completion;
});

test("SSE stays live and compressed bodies retain their exact bytes and length", async (context) => {
  const compressed = gzipSync('http://localhost:3004/keep-compressed');
  const upstream = http.createServer((request, response) => {
    if (request.url === "/compressed") {
      response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": compressed.length });
      response.end(compressed);
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: http://localhost:3004/live\n\n');
    }
  });
  const listen = (server: http.Server) => new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: upstreamPort }) });
  context.after(async () => {
    await proxy.dispose();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  assert.ok(await proxy.ensure({ ...endpoint, publicProtocol: "http", listenPorts: [proxyPort] }));
  await new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: proxyPort, path: "/compressed", agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        try {
          assert.deepEqual(Buffer.concat(chunks), compressed);
          assert.equal(response.headers["content-length"], String(compressed.length));
          assert.equal(response.headers["content-encoding"], "gzip");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.setTimeout(1000, () => request.destroy(new Error("compressed response stalled")));
  });
  await new Promise<void>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: proxyPort, path: "/events", agent: false }, (response) => {
      response.once("data", (chunk: Buffer) => {
        try {
          assert.equal(chunk.toString(), 'data: http://localhost:3004/live\n\n');
          response.destroy();
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.setTimeout(1000, () => request.destroy(new Error("SSE waited for upstream end")));
  });
});

test("HTTP delivers HTML before upstream end and cancels upstream when the browser closes", async (context) => {
  let upstreamClosed = false;
  let upstreamResponse: http.ServerResponse | undefined;
  const upstream = http.createServer((_request, response) => {
    upstreamResponse = response;
    response.once("close", () => { upstreamClosed = true; });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.write('<main>안녕하세요🙂</main><a href="http://local');
  });
  const listen = (server: http.Server) => new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer();
  const proxyPort = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const proxy = new BrowserNetworkProxyManager({ resolve: () => ({ host: "127.0.0.1", port: upstreamPort }) });
  context.after(async () => {
    upstreamResponse?.destroy();
    await proxy.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  assert.ok(await proxy.ensure({ ...endpoint, publicProtocol: "http", listenPorts: [proxyPort] }));
  let request: http.ClientRequest;
  await new Promise<void>((resolve, reject) => {
    request = http.get({ host: "127.0.0.1", port: proxyPort, agent: false }, (response) => {
      response.once("data", (chunk: Buffer) => {
        try {
          assert.match(chunk.toString(), /안녕하세요🙂/);
          assert.equal(upstreamResponse?.writableEnded, false);
          response.destroy();
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.setTimeout(1000, () => request.destroy(new Error("first HTML chunk waited for upstream end")));
  });
  const deadline = Date.now() + 1000;
  while (!upstreamClosed) {
    assert.ok(Date.now() < deadline, "browser cancellation left upstream open");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
});

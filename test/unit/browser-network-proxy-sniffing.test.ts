import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import test from "node:test";

import {
  BrowserNetworkProxyManager,
  type BrowserNetworkProxyEndpoint,
  type BrowserNetworkProxyTarget,
} from "../../src/platform/ports/browser-network-proxy";

/**
 * The browser proxy listener sniffs each connection: a TLS ClientHello is
 * terminated with the dev certificate and proxied as HTTP, while any other
 * first byte is forwarded as raw TCP. One listener therefore serves both an
 * HTTPS browser and a raw TCP client on the same port, with no port
 * classification — the fix for compose services being served plain (which the
 * browser rejects with ERR_SSL_PROTOCOL_ERROR).
 */

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function generateSelfSignedCredentials(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-proxy-tls-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  const credentials = { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
  fs.rmSync(dir, { recursive: true, force: true });
  return credentials;
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const HTTP_REQUEST = "GET / HTTP/1.1\r\nHost: sniff.test\r\nConnection: close\r\n\r\n";

function collect(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.once("end", () => resolve(data));
    socket.once("error", reject);
  });
}

test("one listener terminates TLS and proxies plaintext HTTP to an HTTP backend", async (t) => {
  if (!opensslAvailable()) {
    t.skip("openssl not available to mint a throwaway certificate");
    return;
  }

  const backend = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("hello-from-backend");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as net.AddressInfo).port;

  const credentials = generateSelfSignedCredentials();
  const target: BrowserNetworkProxyTarget = { host: "127.0.0.1", port: backendPort, protocol: "http" };
  const proxy = new BrowserNetworkProxyManager(
    { resolve: () => target },
    { tlsCredentials: { getCredentials: () => credentials } },
  );

  const listenPort = await reservePort();
  const endpoint: BrowserNetworkProxyEndpoint = {
    id: "net-sniff:3000",
    networkId: "net-sniff",
    logicalPort: 3000,
    listenHost: "127.0.0.1",
    publicProtocol: "https",
    listenPorts: [listenPort],
  };

  t.after(async () => {
    await proxy.dispose();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  const active = await proxy.ensure(endpoint);
  assert.ok(active !== undefined, "endpoint should open");

  // TLS client: the ClientHello must be terminated and proxied to the backend.
  const tlsSocket = tls.connect({ host: "127.0.0.1", port: listenPort, rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });
  tlsSocket.write(HTTP_REQUEST);
  const tlsResponse = await collect(tlsSocket);
  assert.match(tlsResponse, /hello-from-backend/, "TLS request must reach the backend through the proxy");
  assert.match(tlsResponse, /^HTTP\/1\.1 200/, "TLS path returns an HTTP response");

  // Plaintext HTTP client: the request line is sniffed and proxied as HTTP.
  const httpSocket = net.createConnection({ host: "127.0.0.1", port: listenPort });
  await new Promise<void>((resolve, reject) => {
    httpSocket.once("connect", resolve);
    httpSocket.once("error", reject);
  });
  httpSocket.write(HTTP_REQUEST);
  const httpResponse = await collect(httpSocket);
  assert.match(httpResponse, /hello-from-backend/, "plain HTTP request must be proxied to the backend");
});

test("the same listener forwards a non-HTTP raw connection to a raw backend", async (t) => {
  if (!opensslAvailable()) {
    t.skip("openssl not available to mint a throwaway certificate");
    return;
  }

  // A raw TCP echo backend stands in for a database wire protocol.
  const backend = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as net.AddressInfo).port;

  const credentials = generateSelfSignedCredentials();
  const target: BrowserNetworkProxyTarget = { host: "127.0.0.1", port: backendPort, protocol: "http" };
  const proxy = new BrowserNetworkProxyManager(
    { resolve: () => target },
    { tlsCredentials: { getCredentials: () => credentials } },
  );

  const listenPort = await reservePort();
  const endpoint: BrowserNetworkProxyEndpoint = {
    id: "net-sniff-raw:5432",
    networkId: "net-sniff-raw",
    logicalPort: 5432,
    listenHost: "127.0.0.1",
    publicProtocol: "https",
    listenPorts: [listenPort],
  };

  t.after(async () => {
    await proxy.dispose();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  const active = await proxy.ensure(endpoint);
  assert.ok(active !== undefined, "endpoint should open");

  // A non-TLS, non-HTTP first byte must be forwarded verbatim (raw TCP).
  const rawSocket = net.createConnection({ host: "127.0.0.1", port: listenPort });
  await new Promise<void>((resolve, reject) => {
    rawSocket.once("connect", resolve);
    rawSocket.once("error", reject);
  });
  const payload = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x10]);
  const echoed = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    rawSocket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= payload.length) {
        resolve(Buffer.concat(chunks));
      }
    });
    rawSocket.once("error", reject);
  });
  rawSocket.write(payload);
  assert.deepEqual((await echoed).subarray(0, payload.length), payload, "raw bytes must round-trip through the backend");
});

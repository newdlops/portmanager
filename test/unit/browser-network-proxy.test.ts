import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import test from "node:test";

import {
  BrowserNetworkProxyManager,
  browserNetworkProxyEndpointId,
  formatBrowserNetworkProxyUrl,
  type BrowserNetworkProxyEndpoint,
} from "../../src/platform/ports/browser-network-proxy";

test("rewrites browser alias HTTP requests as localhost upstream requests", async () => {
  const upstreamRequests: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push(request.headers);
    response.writeHead(302, {
      "access-control-allow-origin": "http://localhost:3004",
      location: "http://localhost:3004/login",
      "set-cookie": "sessionid=abc; Domain=localhost; Path=/; HttpOnly",
    });
    response.end("redirect");
  });
  await listen(upstream, 0, "127.0.0.1");

  const proxyPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager({
    resolve: () => ({
      host: "127.0.0.1",
      port: getServerPort(upstream),
    }),
  });
  const endpoint = createEndpoint({ publicHost: "alpha1", listenPorts: [proxyPort] });

  try {
    const activeEndpoint = await proxy.ensure(endpoint);

    assert.ok(activeEndpoint);

    const publicOrigin = `http://alpha1:${activeEndpoint.listenPort}`;
    const response = await requestHttp({
      host: "127.0.0.1",
      port: activeEndpoint.listenPort,
      path: "/dashboard",
      headers: {
        host: `alpha1:${activeEndpoint.listenPort}`,
        origin: publicOrigin,
        referer: `${publicOrigin}/start`,
      },
    });

    assert.equal(upstreamRequests[0]?.host, "localhost:3004");
    assert.equal(upstreamRequests[0]?.origin, "http://localhost:3004");
    assert.equal(upstreamRequests[0]?.referer, "http://localhost:3004/start");
    assert.equal(response.headers.location, `${publicOrigin}/login`);
    assert.equal(response.headers["access-control-allow-origin"], publicOrigin);
    assert.equal(response.headers["set-cookie"]?.[0], "sessionid=abc; Path=/; HttpOnly");
    assert.equal(formatBrowserNetworkProxyUrl(activeEndpoint), `${publicOrigin}/`);
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
  }
});

test("uses a fallback browser port when the logical port is already occupied", async () => {
  const occupied = http.createServer((_request, response) => {
    response.end("occupied");
  });
  await listen(occupied, 0, "127.0.0.1");

  const upstream = http.createServer((_request, response) => {
    response.end("target");
  });
  await listen(upstream, 0, "127.0.0.1");

  const fallbackPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager({
    resolve: () => ({
      host: "127.0.0.1",
      port: getServerPort(upstream),
    }),
  });

  try {
    const activeEndpoint = await proxy.ensure(
      createEndpoint({
        listenPorts: [getServerPort(occupied), fallbackPort],
      }),
    );

    assert.equal(activeEndpoint?.listenPort, fallbackPort);

    const response = await requestHttp({
      host: "127.0.0.1",
      port: fallbackPort,
      path: "/",
    });
    assert.equal(response.body, "target");
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
    await closeServer(occupied);
  }
});

test("rewrites WebSocket upgrade metadata before tunneling", async () => {
  let upgradeHost = "";
  let upgradeOrigin = "";
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket) => {
    upgradeHost = request.headers.host ?? "";
    upgradeOrigin = request.headers.origin ?? "";
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.end("upgraded");
  });
  await listen(upstream, 0, "127.0.0.1");

  const proxyPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager({
    resolve: () => ({
      host: "127.0.0.1",
      port: getServerPort(upstream),
    }),
  });
  try {
    const activeEndpoint = await proxy.ensure(createEndpoint({ listenPorts: [proxyPort] }));

    assert.ok(activeEndpoint);

    const publicOrigin = `http://127.0.0.1:${activeEndpoint.listenPort}`;
    const response = await sendUpgradeRequest(activeEndpoint.listenPort, [
      "GET /graphql HTTP/1.1",
      `Host: 127.0.0.1:${activeEndpoint.listenPort}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      `Origin: ${publicOrigin}`,
      "",
      "",
    ].join("\r\n"));

    assert.equal(upgradeHost, "localhost:3004");
    assert.equal(upgradeOrigin, "http://localhost:3004");
    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(response, /upgraded$/);
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
  }
});

function createEndpoint(overrides: Partial<BrowserNetworkProxyEndpoint> = {}): BrowserNetworkProxyEndpoint {
  return {
    id: browserNetworkProxyEndpointId("network-1", 3004),
    networkId: "network-1",
    logicalPort: 3004,
    listenHost: "127.0.0.1",
    listenPorts: [],
    ...overrides,
  };
}

function requestHttp(options: {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly headers?: http.OutgoingHttpHeaders;
}): Promise<{ readonly body: string; readonly headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("end", () => resolve({ body, headers: response.headers }));
    });
    request.once("error", reject);
    request.end();
  });
}

function sendUpgradeRequest(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(message);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function getServerPort(server: http.Server): number {
  const address = server.address();

  if (typeof address !== "object" || address === null) {
    throw new Error("Server did not expose an address.");
  }

  return address.port;
}

async function getAvailablePort(): Promise<number> {
  const server = http.createServer();
  await listen(server, 0, "127.0.0.1");
  const port = getServerPort(server);
  await closeServer(server);

  return port;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

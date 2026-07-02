import assert from "node:assert/strict";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
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
      "set-cookie": ["sessionid=abc; Domain=localhost; Path=/; HttpOnly", "theme=light; Path=/; SameSite=Lax"],
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
    assert.equal(response.headers["set-cookie"]?.[1], "theme=light; Path=/; SameSite=Lax");
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

test("formats HTTPS browser proxy endpoints when TLS is enabled", () => {
  assert.equal(
    formatBrowserNetworkProxyUrl({
      ...createEndpoint({ publicHost: "production1", publicProtocol: "https" }),
      listenPort: 3004,
    }),
    "https://production1:3004/",
  );
});

test("does not open HTTPS browser proxy endpoints without TLS credentials", async () => {
  const proxyPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager({
    resolve: () => ({
      host: "127.0.0.1",
      port: 3004,
    }),
  });

  try {
    const activeEndpoint = await proxy.ensure(
      createEndpoint({
        publicProtocol: "https",
        listenPorts: [proxyPort],
      }),
    );

    assert.equal(activeEndpoint, undefined);
  } finally {
    await proxy.dispose();
  }
});

test("terminates HTTPS browser proxy requests and returns upstream responses", async () => {
  const upstreamRequests: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push(request.headers);
    response.writeHead(200, {
      "access-control-allow-origin": "http://localhost:3004",
      location: "http://localhost:3004/secure",
    });
    response.end("secure-target");
  });
  await listen(upstream, 0, "127.0.0.1");

  const proxyPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager(
    {
      resolve: () => ({
        host: "127.0.0.1",
        port: getServerPort(upstream),
      }),
    },
    {
      tlsCredentials: {
        getCredentials: () => ({
          key: TEST_TLS_KEY,
          cert: TEST_TLS_CERTIFICATE,
        }),
      },
    },
  );

  try {
    const activeEndpoint = await proxy.ensure(
      createEndpoint({
        publicHost: "alpha1",
        publicProtocol: "https",
        listenPorts: [proxyPort],
      }),
    );

    assert.ok(activeEndpoint);

    const publicOrigin = `https://alpha1:${activeEndpoint.listenPort}`;
    const response = await requestHttps({
      host: "127.0.0.1",
      port: activeEndpoint.listenPort,
      path: "/dashboard",
      headers: {
        host: `alpha1:${activeEndpoint.listenPort}`,
        origin: publicOrigin,
      },
    });

    assert.equal(upstreamRequests[0]?.host, "localhost:3004");
    assert.equal(upstreamRequests[0]?.origin, "http://localhost:3004");
    assert.equal(response.body, "secure-target");
    assert.equal(response.headers.location, `${publicOrigin}/secure`);
    assert.equal(response.headers["access-control-allow-origin"], publicOrigin);
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
  }
});

test("reopens HTTPS browser proxy listeners when TLS credentials rotate", async () => {
  const upstream = http.createServer((_request, response) => {
    response.end("rotated-target");
  });
  await listen(upstream, 0, "127.0.0.1");

  const proxyPort = await getAvailablePort();
  let credentials = {
    key: TEST_TLS_KEY,
    cert: TEST_TLS_CERTIFICATE,
  };
  const proxy = new BrowserNetworkProxyManager(
    {
      resolve: () => ({
        host: "127.0.0.1",
        port: getServerPort(upstream),
      }),
    },
    {
      tlsCredentials: {
        getCredentials: () => credentials,
      },
    },
  );
  const endpoint = createEndpoint({
    publicHost: "alpha1",
    publicProtocol: "https",
    listenPorts: [proxyPort],
  });

  try {
    const activeEndpoint = await proxy.ensure(endpoint);

    assert.ok(activeEndpoint);

    const initialFingerprint = await readHttpsPeerCertificateFingerprint(activeEndpoint.listenPort);
    credentials = {
      key: ROTATED_TEST_TLS_KEY,
      cert: ROTATED_TEST_TLS_CERTIFICATE,
    };

    const reopenedEndpoint = await proxy.ensure(endpoint);

    assert.equal(reopenedEndpoint?.listenPort, activeEndpoint.listenPort);
    assert.notEqual(await readHttpsPeerCertificateFingerprint(activeEndpoint.listenPort), initialFingerprint);
    assert.equal(
      (
        await requestHttps({
          host: "127.0.0.1",
          port: activeEndpoint.listenPort,
          path: "/",
        })
      ).body,
      "rotated-target",
    );
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
  }
});

test("forwards browser proxy requests to HTTPS upstream targets", async () => {
  const upstreamRequests: http.IncomingHttpHeaders[] = [];
  const upstream = https.createServer(
    {
      key: TEST_TLS_KEY,
      cert: TEST_TLS_CERTIFICATE,
    },
    (request, response) => {
      upstreamRequests.push(request.headers);
      response.writeHead(200, {
        "access-control-allow-origin": "https://localhost:3004",
        location: "https://localhost:3004/secure",
      });
      response.end("secure-upstream");
    },
  );
  await listen(upstream, 0, "127.0.0.1");

  const proxyPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager(
    {
      resolve: () => ({
        host: "127.0.0.1",
        port: getServerPort(upstream),
        protocol: "https",
      }),
    },
    {
      tlsCredentials: {
        getCredentials: () => ({
          key: TEST_TLS_KEY,
          cert: TEST_TLS_CERTIFICATE,
        }),
      },
    },
  );

  try {
    const activeEndpoint = await proxy.ensure(
      createEndpoint({
        publicHost: "alpha1",
        publicProtocol: "https",
        listenPorts: [proxyPort],
      }),
    );

    assert.ok(activeEndpoint);

    const publicOrigin = `https://alpha1:${activeEndpoint.listenPort}`;
    const response = await requestHttps({
      host: "127.0.0.1",
      port: activeEndpoint.listenPort,
      path: "/dashboard",
      headers: {
        host: `alpha1:${activeEndpoint.listenPort}`,
        origin: publicOrigin,
      },
    });

    assert.equal(upstreamRequests[0]?.host, "localhost:3004");
    assert.equal(upstreamRequests[0]?.origin, "https://localhost:3004");
    assert.equal(response.body, "secure-upstream");
    assert.equal(response.headers.location, `${publicOrigin}/secure`);
    assert.equal(response.headers["access-control-allow-origin"], publicOrigin);
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
  }
});

test("clears bind retry backoff when an owner handoff frees the browser proxy port", async () => {
  const occupied = http.createServer((_request, response) => {
    response.end("occupied");
  });
  await listen(occupied, 0, "127.0.0.1");
  let occupiedClosed = false;

  const upstream = http.createServer((_request, response) => {
    response.end("target");
  });
  await listen(upstream, 0, "127.0.0.1");

  const proxyPort = getServerPort(occupied);
  const proxy = new BrowserNetworkProxyManager(
    {
      resolve: () => ({
        host: "127.0.0.1",
        port: getServerPort(upstream),
      }),
    },
    { retryDelayMs: 60_000 },
  );
  const endpoint = createEndpoint({ listenPorts: [proxyPort] });

  try {
    await proxy.sync([endpoint]);
    assert.equal(proxy.get("network-1", 3004), undefined);

    await closeServer(occupied);
    occupiedClosed = true;
    await proxy.sync([endpoint]);
    assert.equal(proxy.get("network-1", 3004), undefined);

    proxy.retryFailedEndpointsNow();
    await proxy.sync([endpoint]);
    assert.equal(proxy.get("network-1", 3004)?.listenPort, proxyPort);
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
    if (!occupiedClosed) {
      await closeServer(occupied);
    }
  }
});

test("reuses upstream HTTP connections for repeated browser proxy requests", async () => {
  let upstreamConnectionCount = 0;
  const upstream = http.createServer((request, response) => {
    response.end(`target:${request.url ?? "/"}`);
  });
  upstream.on("connection", () => {
    upstreamConnectionCount += 1;
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

    const first = await requestHttp({
      host: "127.0.0.1",
      port: activeEndpoint.listenPort,
      path: "/first",
      headers: { connection: "keep-alive" },
    });
    const second = await requestHttp({
      host: "127.0.0.1",
      port: activeEndpoint.listenPort,
      path: "/second",
      headers: { connection: "keep-alive" },
    });

    assert.equal(first.body, "target:/first");
    assert.equal(second.body, "target:/second");
    assert.equal(upstreamConnectionCount, 1);
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
  }
});

test("routes browser proxy requests to updated upstream targets with keep-alive enabled", async () => {
  const firstUpstream = http.createServer((_request, response) => {
    response.end("first-target");
  });
  const secondUpstream = http.createServer((_request, response) => {
    response.end("second-target");
  });
  await listen(firstUpstream, 0, "127.0.0.1");
  await listen(secondUpstream, 0, "127.0.0.1");

  let targetPort = getServerPort(firstUpstream);
  const proxyPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager({
    resolve: () => ({
      host: "127.0.0.1",
      port: targetPort,
    }),
  });

  try {
    const activeEndpoint = await proxy.ensure(createEndpoint({ listenPorts: [proxyPort] }));
    assert.ok(activeEndpoint);

    const first = await requestHttp({
      host: "127.0.0.1",
      port: activeEndpoint.listenPort,
      path: "/",
      headers: { connection: "keep-alive" },
    });
    targetPort = getServerPort(secondUpstream);
    const second = await requestHttp({
      host: "127.0.0.1",
      port: activeEndpoint.listenPort,
      path: "/",
      headers: { connection: "keep-alive" },
    });

    assert.equal(first.body, "first-target");
    assert.equal(second.body, "second-target");
  } finally {
    await proxy.dispose();
    await closeServer(firstUpstream);
    await closeServer(secondUpstream);
  }
});

test("refreshes active browser proxy metadata when the DNS alias changes", async () => {
  const upstreamRequests: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push(request.headers);
    response.writeHead(200, {
      location: "http://localhost:3004/dashboard",
    });
    response.end("target");
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
    await proxy.ensure(createEndpoint({ publicHost: "alpha1", listenPorts: [proxyPort] }));
    const activeEndpoint = await proxy.ensure(createEndpoint({ publicHost: "alpha2", listenPorts: [proxyPort] }));

    assert.ok(activeEndpoint);
    assert.equal(activeEndpoint?.publicHost, "alpha2");
    assert.equal(formatBrowserNetworkProxyUrl(activeEndpoint), `http://alpha2:${proxyPort}/`);

    const response = await requestHttp({
      host: "127.0.0.1",
      port: proxyPort,
      path: "/",
      headers: {
        host: `alpha2:${proxyPort}`,
        origin: `http://alpha2:${proxyPort}`,
      },
    });

    assert.equal(upstreamRequests.at(-1)?.origin, "http://localhost:3004");
    assert.equal(response.headers.location, `http://alpha2:${proxyPort}/dashboard`);
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
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

test("tunnels WebSocket upgrades to HTTPS upstream targets", async () => {
  let upgradeHost = "";
  let upgradeOrigin = "";
  const upstream = https.createServer({
    key: TEST_TLS_KEY,
    cert: TEST_TLS_CERTIFICATE,
  });
  upstream.on("upgrade", (request, socket) => {
    upgradeHost = request.headers.host ?? "";
    upgradeOrigin = request.headers.origin ?? "";
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.end("secure-upgraded");
  });
  await listen(upstream, 0, "127.0.0.1");

  const proxyPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager({
    resolve: () => ({
      host: "127.0.0.1",
      port: getServerPort(upstream),
      protocol: "https",
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
    assert.equal(upgradeOrigin, "https://localhost:3004");
    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(response, /secure-upgraded$/);
  } finally {
    await proxy.dispose();
    await closeServer(upstream);
  }
});

test("keeps in-flight browser proxy sockets across transient missing endpoint sync", async () => {
  let upstreamResponse: http.ServerResponse | undefined;
  let markUpstreamReceived!: () => void;
  const upstreamReceived = new Promise<void>((resolve) => {
    markUpstreamReceived = resolve;
  });
  const upstream = http.createServer((_request, response) => {
    upstreamResponse = response;
    markUpstreamReceived();
  });
  await listen(upstream, 0, "127.0.0.1");

  const proxyPort = await getAvailablePort();
  const proxy = new BrowserNetworkProxyManager(
    {
      resolve: () => ({
        host: "127.0.0.1",
        port: getServerPort(upstream),
      }),
    },
    { retireDelayMs: 1000 },
  );
  const endpoint = createEndpoint({ listenPorts: [proxyPort] });

  try {
    const activeEndpoint = await proxy.ensure(endpoint);
    assert.ok(activeEndpoint);

    const responsePromise = requestHttp({
      host: "127.0.0.1",
      port: activeEndpoint.listenPort,
      path: "/graphql",
    });
    await upstreamReceived;

    await proxy.sync([]);
    await proxy.sync([endpoint]);
    upstreamResponse?.end("still-open");

    assert.equal((await responsePromise).body, "still-open");
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

function requestHttps(options: {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly headers?: http.OutgoingHttpHeaders;
}): Promise<{ readonly body: string; readonly headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = https.request({ ...options, rejectUnauthorized: false }, (response) => {
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

function readHttpsPeerCertificateFingerprint(port: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: "127.0.0.1",
        port,
        rejectUnauthorized: false,
        servername: "localhost",
      },
      () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        resolve(typeof certificate.fingerprint256 === "string" ? certificate.fingerprint256 : undefined);
      },
    );
    socket.once("error", reject);
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

const TEST_TLS_KEY = [
  "-----BEGIN EC PRIVATE KEY-----",
  "MHcCAQEEIDZb4xEoHQfbkJepy/ZcuiGP2yZT2sJvIvrUXmGWZrswoAoGCCqGSM49",
  "AwEHoUQDQgAElxFcMvH6ntfaQEbFPllq5UbHlszHDkY9HytoA6QMvdRY5SDw0kRY",
  "2CA+HZlSVGvyKTSDI2KXlILCDRzp9r39sw==",
  "-----END EC PRIVATE KEY-----",
].join("\n");

const TEST_TLS_CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBPTCB46ADAgECAgkAwldsxvU6r/IwCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJ",
  "bG9jYWxob3N0MB4XDTI2MDcwMTExMDkwMVoXDTI2MDcwMjExMDkwMVowFDESMBAG",
  "A1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAElxFcMvH6",
  "ntfaQEbFPllq5UbHlszHDkY9HytoA6QMvdRY5SDw0kRY2CA+HZlSVGvyKTSDI2KX",
  "lILCDRzp9r39s6MeMBwwGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqG",
  "SM49BAMCA0kAMEYCIQDcaODSRujrhUdKGuUamG0d2/E5ZPqRQhGKFc2aoEN0BgIh",
  "AJ2jn5A6mS9hO3n71Qg38NpLWD9pG8kjc9ItMwZmb/8f",
  "-----END CERTIFICATE-----",
].join("\n");

const ROTATED_TEST_TLS_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIBeQIBADCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAAB",
  "AAAAAAAAAAAAAAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA",
  "///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMV",
  "AMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg",
  "9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8A",
  "AAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBBG0wawIBAQQgo2hB1z6OKSmH",
  "bU5wxdztTZiUXhqcSS65JVdAXdLeahChRANCAAQtnHTGdhp5to+lRUzNkT9CJVo6",
  "Go1aLPQwhOp0v+VFhc738CPmz+Ms34xqtkl1PpCupe5Px4t6EctXGaS7yGma",
  "-----END PRIVATE KEY-----",
].join("\n");

const ROTATED_TEST_TLS_CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "MIICQDCCAeegAwIBAgIJAPME19MV3WTYMAoGCCqGSM49BAMCMBwxGjAYBgNVBAMM",
  "EWxvY2FsaG9zdC1yb3RhdGVkMB4XDTI2MDcwMjAzMzczOFoXDTI2MDcwOTAzMzcz",
  "OFowHDEaMBgGA1UEAwwRbG9jYWxob3N0LXJvdGF0ZWQwggFLMIIBAwYHKoZIzj0C",
  "ATCB9wIBATAsBgcqhkjOPQEBAiEA/////wAAAAEAAAAAAAAAAAAAAAD/////////",
  "//////8wWwQg/////wAAAAEAAAAAAAAAAAAAAAD///////////////wEIFrGNdiq",
  "OpPns+u9VXaYhrxlHQawzFOw9jvOPD4n0mBLAxUAxJ02CIbnBJNqZnjhE50mt4Gf",
  "fpAEQQRrF9Hy4SxCR/i85uVjpEDydwN9gS3rM6D0oTlF2JjClk/jQuL+Gn+bjufr",
  "SnwPnhYrzjNXazFezsu2QGg3v1H1AiEA/////wAAAAD//////////7zm+q2nF56E",
  "87nKwvxjJVECAQEDQgAELZx0xnYaebaPpUVMzZE/QiVaOhqNWiz0MITqdL/lRYXO",
  "9/Aj5s/jLN+MarZJdT6QrqXuT8eLehHLVxmku8hpmqMeMBwwGgYDVR0RBBMwEYIJ",
  "bG9jYWxob3N0hwR/AAABMAoGCCqGSM49BAMCA0cAMEQCIFZDrL/9LB09cfynmus5",
  "mWcmUal/hI29gehxLOAWpkH4AiA4EVUP6ckuo0uovqe/6664DtRG2+p9IzNjCpyz",
  "l7Wh8g==",
  "-----END CERTIFICATE-----",
].join("\n");

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

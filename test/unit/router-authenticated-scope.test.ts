import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { AuthenticatedProcessScope } from "../../src/agent/protocol";
import type { LogicalPortRouterConnection } from "../../src/platform/ports/logical-port-router";

function loadService(): typeof import("../../src/extension/network-service") {
  const loader = require("node:module") as { _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown };
  const original = loader._load;
  loader._load = (request, parent, isMain) => request === "vscode" ? {} : original(request, parent, isMain);
  try { return require(path.resolve(__dirname, "../../src/extension/network-service.js")) as typeof import("../../src/extension/network-service"); }
  finally { loader._load = original; }
}

test("guarded router attribution rejects mutable hints, stale identity and failed scope lookups", async () => {
  const { PortManagerNetworkService } = loadService();
  const identity = { pid: 30, birth: 1791487047875746 };
  let currentIdentity: typeof identity | undefined = identity;
  let currentScope: AuthenticatedProcessScope | null = { ...identity, networkId: "network-a" };
  let scopeError: Error | undefined;
  const calls: string[] = [];
  const forbidden = () => { throw new Error("untrusted attribution fallback was used"); };
  const service = Object.assign(Object.create(PortManagerNetworkService.prototype), {
    processService: {
      getSnapshot: () => ({ daemon: { authenticatesProcessScopes: true } }),
      resolveProcessScope: async (requested: typeof identity) => {
        calls.push("scope"); assert.deepEqual(requested, identity);
        if (scopeError) throw scopeError;
        return currentScope;
      },
    },
    nativeProcessLookup: { readProcessIdentity: async (pid: number) => { calls.push("identity"); assert.equal(pid, identity.pid); return currentIdentity; } },
    tcpConnectionProcessResolver: { resolveClientProcess: async () => ({ pid: identity.pid, cwd: "/workspace" }) },
    routerVerdictCache: { read: forbidden, store: forbidden },
    processTracker: { queryNetwork: forbidden },
    processTableProvider: { list: forbidden },
    findClientNetworkForRouter: forbidden,
  }) as { resolveRouterClientVerdict(connection: LogicalPortRouterConnection): Promise<{ networkId?: string; processRows: unknown[]; clientCwd?: string }> };
  const connection: LogicalPortRouterConnection = { logicalPort: 3000, clientPid: identity.pid,
    clientStartTime: String(Math.floor(identity.birth / 1_000_000)), clientNetworkId: "network-b" };
  assert.deepEqual(await service.resolveRouterClientVerdict(connection), { networkId: "network-a", processRows: [] });
  assert.deepEqual(calls, ["identity", "scope"]);
  currentScope = null;
  assert.deepEqual(await service.resolveRouterClientVerdict(connection), { processRows: [], clientCwd: undefined },
    "a missing controller scope cannot be replaced by a forged native env hint");
  currentIdentity = undefined;
  await assert.rejects(service.resolveRouterClientVerdict(connection), /identity is unavailable/);
  currentIdentity = identity;
  currentScope = { ...identity, birth: identity.birth + 1, networkId: "network-b" };
  await assert.rejects(service.resolveRouterClientVerdict(connection), /does not match/);
  currentScope = { ...identity, networkId: "network-a" };
  scopeError = new Error("fixture controller disconnected");
  await assert.rejects(service.resolveRouterClientVerdict(connection), /controller disconnected/);
  scopeError = undefined;
  if (process.platform === "darwin") await assert.rejects(service.resolveRouterClientVerdict({ ...connection, clientStartTime: "1" }), /identity changed/);
  assert.deepEqual(await service.resolveRouterClientVerdict({ logicalPort: 3000, clientNetworkId: "network-b" }), { networkId: "network-a", processRows: [] },
    "the OS socket owner fallback must also resolve controller scope before using env");
});

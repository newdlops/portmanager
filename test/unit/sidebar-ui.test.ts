import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

test("sidebar root stays focused on networks, services, and diagnostics", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const rootStart = source.indexOf("if (element === undefined) {");
  const rootEnd = source.indexOf("if (element instanceof LogicalNetworkTreeItem)", rootStart);
  const rootBody = source.slice(rootStart, rootEnd);

  assert.equal(rootBody.includes('"Current Routing"'), true);
  assert.equal(rootBody.includes('"Logical Networks"'), true);
  assert.equal(rootBody.includes('"Discovered Services"'), true);
  assert.equal(rootBody.includes('"Diagnostics"'), true);
  assert.equal(rootBody.includes('"Terminal Windows"'), false);
  assert.equal(rootBody.includes('"Host Port Exposures"'), false);
  assert.equal(rootBody.includes('"Runtime Adapter"'), false);
});

test("sidebar shows current network and route destinations", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const networkServicePath = path.resolve(__dirname, "../../../src/extension/network-service.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const networkServiceSource = fs.readFileSync(networkServicePath, "utf8");

  assert.equal(source.includes('"Current Routing"'), true);
  assert.equal(source.includes("class NetworkRoutingGroupTreeItem"), true);
  assert.equal(source.includes("class NetworkRouteConnectionTreeItem"), true);
  assert.equal(source.includes("formatCurrentRoutingSummary(snapshot, agentSnapshot)"), true);
  assert.equal(source.includes("buildNetworkRouteConnectionRows(network.id, snapshot, agentSnapshot).length"), true);
  assert.equal(source.includes("Current VS Code Terminal Network"), true);
  assert.equal(networkServiceSource.includes("getAgentSnapshot(): AgentSnapshot"), true);
});

test("network rows show state first and keep actions grouped", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes("class NetworkActionGroupTreeItem"), true);
  assert.equal(source.includes('"Quick Actions"'), true);
  assert.equal(source.includes('"Advanced"'), true);
  assert.equal(source.includes('"Attach Active Terminal"'), true);
  assert.equal(source.includes('"Attach Terminal"'), true);
  assert.equal(source.includes('"Use Quick Actions"'), true);
});

test("terminal rows expose reveal commands for injected external windows", () => {
  const sourcePath = path.resolve(__dirname, "../../../src/ui/sidebar/port-manager-tree.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.equal(source.includes('command: "portManager.revealTerminalWindow"'), true);
  assert.equal(source.includes('title: "Reveal Terminal"'), true);
  assert.equal(source.includes("arguments: [window]"), true);
  assert.equal(source.includes("arguments: [attachment]"), true);
});

test("view title toolbar exposes only primary actions", () => {
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    contributes?: { menus?: { "view/title"?: Array<{ command: string }> } };
  };
  const viewTitleCommands = manifest.contributes?.menus?.["view/title"]?.map((item) => item.command) ?? [];

  assert.deepEqual(viewTitleCommands, [
    "portManager.createLogicalNetwork",
    "portManager.refresh",
    "portManager.openSettings",
  ]);
});

test("terminal context menu supports active attach and reveal", () => {
  const packagePath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
    contributes?: { menus?: { "view/item/context"?: Array<{ command: string; when?: string }> } };
    activationEvents?: string[];
  };
  const menuItems = manifest.contributes?.menus?.["view/item/context"] ?? [];
  const commands = menuItems.map((item) => item.command);

  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.attachActiveTerminalToNetwork"), true);
  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.revealTerminalWindow"), true);
  assert.equal(commands.includes("portManager.attachActiveTerminalToNetwork"), true);
  assert.equal(commands.includes("portManager.revealTerminalWindow"), true);
  assert.equal(
    menuItems.some((item) => item.command === "portManager.revealTerminalWindow" && item.when?.includes("terminalAttachment")),
    true,
  );
});

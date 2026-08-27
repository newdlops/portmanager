import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../", relativePath), "utf8");
}

test("worktree initialization is a visible, activation-backed primary action", () => {
  const manifest = JSON.parse(readSource("package.json")) as {
    readonly activationEvents?: readonly string[];
    readonly contributes?: {
      readonly commands?: ReadonlyArray<{ readonly command: string }>;
      readonly menus?: { readonly commandPalette?: ReadonlyArray<{ readonly command: string; readonly when?: string }> };
    };
  };
  const treeSource = readSource("src/ui/sidebar/port-manager-tree.ts");

  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.initializeWorktree"), true);
  assert.equal(
    manifest.contributes?.commands?.some((command) => command.command === "portManager.initializeWorktree"),
    true,
  );
  assert.equal(
    manifest.contributes?.menus?.commandPalette?.some(
      (entry) => entry.command === "portManager.initializeWorktree" && entry.when === "false",
    ),
    false,
  );

  const networksCaseStart = treeSource.indexOf('case "networks":');
  const networksCaseEnd = treeSource.indexOf('case "services":', networksCaseStart);
  const networksCase = treeSource.slice(networksCaseStart, networksCaseEnd);
  assert.equal(networksCase.includes('"Initialize This Worktree"'), true);
  assert.equal(networksCase.includes('"Create and use one default network"'), true);
  assert.equal(networksCase.includes("snapshot.vscodeWindowTerminalBinding === undefined"), true);
  assert.equal(networksCase.includes('new ActionTreeItem("Create Network"'), false);
});

test("one worktree action installs, attaches, repairs browser access, verifies, then opens a shell", () => {
  const source = readSource("src/extension/commands.ts");
  const start = source.indexOf("private async initializeWorktreeExclusive");
  const end = source.indexOf("/** Creates a logical network row", start);
  const body = source.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal(body.includes("vscode.window.withProgress("), true);
  assert.equal(body.includes("{ modal: true }"), true);
  assert.equal(body.includes("assertPackagedShellRuntimeReadable(context)"), true);
  assert.equal(body.includes("assertAutomaticShellIntegrationSupported()"), true);
  assert.equal(source.includes("getManagedShellProfilePlans(resolveCurrentUserShell(), os.homedir())"), true);
  assert.equal(source.includes("os.userInfo().shell?.trim()"), true);
  assert.equal(body.includes("this.installShellHook(context, { announce: false })"), true);
  assert.equal(source.includes("await verifyInstalledShellIntegration({"), true);
  assert.equal(body.includes("findReusableWorktreeNetwork("), true);
  assert.equal(body.includes("findCurrentWindowDefaultNetwork("), true);

  const partialStateIndex = body.indexOf("await context.workspaceState.update(");
  const attachIndex = body.indexOf("attachVscodeWindowTerminalsToNetwork(network.id)");
  const browserInstallIndex = body.indexOf("installBrowserDnsResolvers({");
  const verificationIndex = body.indexOf("verifyBrowserAccessReadiness()");
  const terminalIndex = body.indexOf("vscode.window.createTerminal({");
  assert.equal(partialStateIndex >= 0 && partialStateIndex < attachIndex, true);
  assert.equal(attachIndex < browserInstallIndex, true);
  assert.equal(browserInstallIndex < verificationIndex, true);
  assert.equal(verificationIndex < terminalIndex, true);
  assert.equal(body.includes("Repair Local DNS"), true);
});

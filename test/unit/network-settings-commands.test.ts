import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { ensureNetworkNamespaceScaffold, ensureNetworkDotenvSubstitute, networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

/** Keep production command orchestration intact, replacing only VS Code's UI boundary. */
test("settings commands select IDs and workspaces, open owned files, and preserve cancel/empty states", async context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-settings-command-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.resolve(__dirname, "../../../src/extension/commands.ts"), "utf8");
  const ast = ts.createSourceFile("commands.ts", source, ts.ScriptTarget.ES2022, true);
  const controller = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "PortManagerCommandController")!;
  const members = ["openNetworkSettings", "resolveNetworkArgument"].map(name => {
    const member = controller.members.find(node => node.name?.getText(ast) === name);
    assert.ok(member, `missing settings command behavior: ${name}`);
    return member.getText(ast);
  });
  const networks = [{ id: "first", name: "알파 개발", runtimeKind: "nativeHelper", status: "running" }, { id: "second", name: "알파 개발", runtimeKind: "nativeHelper", status: "running" }];
  const folders = [{ name: "same", uri: { scheme: "file", fsPath: root } }, { name: "same", uri: { scheme: "file", fsPath: path.join(root, "other") } }];
  fs.mkdirSync(folders[1].uri.fsPath);
  let workspaceFolders = folders;
  let cancel = false;
  const opened: { command: string; file: string }[] = [];
  const messages: string[] = [];
  const picks: { label: string; description?: string; detail?: string }[][] = [];
  const Runner = vm.runInNewContext(ts.transpileModule(`class Runner { ${members.join("\n")} }\nRunner`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    vscode: {
      Uri: { file: (file: string) => file },
      workspace: { get workspaceFolders() { return workspaceFolders; } },
      window: {
        showInformationMessage: async (text: string) => { messages.push(text); },
        showQuickPick: async (items: typeof picks[number]) => { picks.push(items); return cancel ? undefined : items[1]; },
      },
      commands: { executeCommand: async (command: string, file: string) => { opened.push({ command, file }); } },
    },
    getLogicalNetworkFromCommandArgument: (argument: unknown) => argument,
    ensureNetworkNamespaceScaffold, ensureNetworkDotenvSubstitute, networkNamespacePaths,
    ensureLocalGitExclude: () => {}, presentLegacySettingsNotices: async () => {},
  });
  const runner = Object.assign(new Runner(), { dependencies: { networkService: { getSnapshot: () => ({ networks }) } } });
  await runner.openNetworkSettings(undefined, "environment");
  assert.ok(picks[0].every(item => item.detail?.includes("first") || item.detail?.includes("second")), "duplicate network names must show their IDs");
  assert.ok(picks[1].every(item => item.description?.includes(root)), "duplicate workspace names must show their full paths");
  const paths = networkNamespacePaths(folders[1].uri.fsPath, "second");
  assert.deepEqual(opened, [{ command: "vscode.open", file: paths.envFilePath }]);
  await runner.openNetworkSettings(networks[1], "dotenv");
  const dotenv = path.join(paths.filesDirectory, ".env");
  assert.equal(opened[1].file, dotenv);
  assert.equal(fs.statSync(dotenv).mode & 0o777, 0o600);
  fs.writeFileSync(dotenv, "PRESERVE=value\n");
  await runner.openNetworkSettings(networks[1], "dotenv");
  assert.equal(fs.readFileSync(dotenv, "utf8"), "PRESERVE=value\n");
  await runner.openNetworkSettings(networks[1], "folder");
  assert.deepEqual(opened[3], { command: "revealInExplorer", file: paths.directory });
  cancel = true;
  await runner.openNetworkSettings(undefined, "environment");
  assert.equal(opened.length, 4);
  await runner.openNetworkSettings(networks[0], "environment");
  assert.equal(opened.length, 4, "workspace cancellation must not open a file");
  cancel = false;
  workspaceFolders = [];
  await runner.openNetworkSettings(networks[1], "environment");
  assert.match(messages.at(-1)!, /local workspace/i);
  assert.equal(opened.length, 4);
  assert.equal(fs.existsSync(path.join(root, ".portmanager")), false, "unselected workspace must not be scaffolded");
  networks.length = 0;
  await runner.openNetworkSettings(undefined, "environment");
  assert.equal(messages.at(-1), "No logical networks exist.");
});

test("all settings actions are contributed to the palette and network context menu", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"));
  const source = fs.readFileSync(path.resolve(__dirname, "../../../src/extension/commands.ts"), "utf8");
  for (const name of ["openNetworkEnvironmentFile", "openNetworkDotenvSubstitute", "revealNetworkFolder"]) {
    const command = `portManager.${name}`;
    assert.ok(manifest.activationEvents.includes(`onCommand:${command}`));
    assert.ok(manifest.contributes.commands.some((item: { command: string }) => item.command === command));
    assert.ok(manifest.contributes.menus["view/item/context"].some((item: { command: string; when: string }) => item.command === command && item.when.includes("viewItem == logicalNetwork")));
    assert.ok(source.includes(`this.registerCommand(context, "${command}"`));
  }
});

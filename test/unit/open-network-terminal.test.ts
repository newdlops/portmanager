import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../", relativePath), "utf8");
}

test("logical networks expose an activation-backed open-terminal action", () => {
  const manifest = JSON.parse(readSource("package.json")) as {
    readonly activationEvents?: readonly string[];
    readonly contributes?: {
      readonly commands?: ReadonlyArray<{ readonly command: string; readonly icon?: string }>;
      readonly menus?: {
        readonly "view/item/context"?: ReadonlyArray<{
          readonly command: string;
          readonly when?: string;
          readonly group?: string;
        }>;
      };
    };
  };
  const treeSource = readSource("src/ui/sidebar/port-manager-tree.ts");
  const command = "portManager.openNetworkTerminal";
  const menu = manifest.contributes?.menus?.["view/item/context"]?.find((item) => item.command === command);

  assert.equal(manifest.activationEvents?.includes(`onCommand:${command}`), true);
  assert.equal(
    manifest.contributes?.commands?.some((item) => item.command === command && item.icon === "$(terminal-new)"),
    true,
  );
  assert.equal(menu?.when?.includes("viewItem == logicalNetwork"), true);
  assert.equal(menu?.group, "inline@1");
  assert.equal(treeSource.includes('"Open Network Terminal"'), true);
  assert.equal(treeSource.includes('"Start a new terminal in this network"'), true);
  assert.equal(treeSource.includes('count: 6, singular: "action"'), true);
});

test("open-terminal prepares routing before creation and queues attachment before reveal", () => {
  const source = readSource("src/extension/commands.ts");
  const start = source.indexOf("private async openNetworkTerminal(argument: unknown)");
  const end = source.indexOf("/** Attaches a selected terminal window", start);
  const body = source.slice(start, end);
  const resolveIndex = body.indexOf("this.resolveNetworkArgument(");
  const scriptIndex = body.indexOf("createTerminalRoutingScript(network.id)");
  const createIndex = body.indexOf("vscode.window.createTerminal({");
  const sendIndex = body.indexOf("terminal.sendText(script, true)");
  const showIndex = body.indexOf("terminal.show()");

  assert.equal(start >= 0 && end > start, true);
  assert.equal(resolveIndex >= 0 && resolveIndex < scriptIndex, true);
  assert.equal(scriptIndex < createIndex, true);
  assert.equal(createIndex < sendIndex, true);
  assert.equal(sendIndex < showIndex, true);
  assert.equal(body.includes("attachVscodeWindowTerminalsToNetwork"), false);
  assert.equal(body.includes("terminal.dispose()"), true);
});

test("open-terminal sends the selected network script to a new workspace terminal", async () => {
  const events: string[] = [];
  const sent: Array<{ readonly text: string; readonly addNewLine?: boolean }> = [];
  const terminalOptions: Array<{ readonly name?: string; readonly cwd?: { readonly fsPath: string } }> = [];
  const workspaceUri = { fsPath: "/tmp/portmanager-worktree", scheme: "file" };
  const vscodeFixture = createVscodeFixture({
    createTerminal: (options) => {
      events.push("create");
      terminalOptions.push(options);
      return {
        sendText: (text: string, addNewLine?: boolean) => {
          events.push("send");
          sent.push({ text, addNewLine });
        },
        show: () => { events.push("show"); },
        dispose: () => { events.push("dispose"); },
      };
    },
    workspaceUri,
  });
  const { PortManagerCommandController } = loadCommands(vscodeFixture);
  const network = {
    id: "network-beta",
    name: "Beta Network",
    runtimeKind: "nativeHelper",
    status: "running",
    createdAt: "2026-08-27T00:00:00.000Z",
  } as const;
  const controller = new PortManagerCommandController({
    processService: {} as never,
    networkService: {
      getSnapshot: () => ({ networks: [network] }),
      createTerminalRoutingScript: async (networkId: string) => {
        assert.equal(networkId, network.id);
        events.push("script");
        return ". /tmp/attach-beta.sh";
      },
    } as never,
    treeProvider: {} as never,
  }) as unknown as { openNetworkTerminal(argument: unknown): Promise<void> };

  await controller.openNetworkTerminal(network);

  assert.deepEqual(events, ["script", "create", "send", "show"]);
  assert.deepEqual(terminalOptions, [{ name: "Port Manager: Beta Network", cwd: workspaceUri }]);
  assert.deepEqual(sent, [{ text: ". /tmp/attach-beta.sh", addNewLine: true }]);
});

function createVscodeFixture(input: {
  readonly createTerminal: (options: {
    readonly name?: string;
    readonly cwd?: { readonly fsPath: string };
  }) => unknown;
  readonly workspaceUri: { readonly fsPath: string; readonly scheme: string };
}): unknown {
  class TreeItem {
    constructor(readonly label: string, readonly collapsibleState: number) {}
  }
  class MarkdownString {
    value = "";
    isTrusted: boolean | undefined;
    appendMarkdown(value: string): void { this.value += value; }
  }

  const workspaceFolder = { name: "portmanager-worktree", uri: input.workspaceUri };
  return {
    window: {
      activeTextEditor: undefined,
      createTerminal: input.createTerminal,
    },
    workspace: {
      workspaceFolders: [workspaceFolder],
      getWorkspaceFolder: () => workspaceFolder,
    },
    TreeItem,
    MarkdownString,
    ThemeIcon: class ThemeIcon {},
    ThemeColor: class ThemeColor {},
    DataTransferItem: class DataTransferItem {
      constructor(readonly value: unknown) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class EventEmitter {
      readonly event = () => undefined;
      fire(): void {}
      dispose(): void {}
    },
  };
}

function loadCommands(vscodeFixture: unknown): typeof import("../../src/extension/commands") {
  const moduleLoader = require("node:module") as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) =>
    request === "vscode" ? vscodeFixture : originalLoad(request, parent, isMain);
  try {
    return require(path.resolve(__dirname, "../../src/extension/commands.js")) as typeof import("../../src/extension/commands");
  } finally {
    moduleLoader._load = originalLoad;
  }
}

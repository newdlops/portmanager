import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { LogicalNetwork } from "../../src/shared/types";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../", relativePath), "utf8");
}

test("isolated worktree is a visible activation-backed primary action", () => {
  const manifest = JSON.parse(readSource("package.json")) as {
    readonly activationEvents?: readonly string[];
    readonly contributes?: {
      readonly commands?: ReadonlyArray<{ readonly command: string }>;
      readonly menus?: {
        readonly "view/title"?: ReadonlyArray<{ readonly command: string }>;
        readonly commandPalette?: ReadonlyArray<{ readonly command: string; readonly when?: string }>;
      };
    };
  };
  const treeSource = readSource("src/ui/sidebar/port-manager-tree.ts");

  assert.equal(manifest.activationEvents?.includes("onCommand:portManager.createIsolatedWorktree"), true);
  assert.equal(
    manifest.contributes?.commands?.some((command) => command.command === "portManager.createIsolatedWorktree"),
    true,
  );
  assert.equal(
    manifest.contributes?.menus?.commandPalette?.some(
      (entry) => entry.command === "portManager.createIsolatedWorktree" && entry.when === "false",
    ),
    false,
  );
  assert.equal(treeSource.includes('"Create Isolated Worktree"'), true);
  assert.equal(treeSource.includes('"Worktree + network + Compose copy"'), true);
  const viewTitleCommands = manifest.contributes?.menus?.["view/title"]?.map((entry) => entry.command) ?? [];
  assert.equal(viewTitleCommands.includes("portManager.createIsolatedWorktree"), true);
  assert.equal(viewTitleCommands.includes("portManager.createLogicalNetwork"), false);
});

test("guided setup orders worktree, durable network state, compose copy, verification, and handoff", () => {
  const source = readSource("src/extension/isolated-worktree-setup.ts");
  const worktreeIndex = source.indexOf("this.gitWorktrees.createOrReuse({");
  const pendingIndex = source.indexOf("await upsertPendingSetup(this.dependencies.context, pending)");
  const networkIndex = source.indexOf("this.dependencies.networkService.createNetwork(networkName, runtimeKind)");
  const composeIndex = source.indexOf("await this.copyComposeSource(source, network.id, mapping)");
  const verifyIndex = source.indexOf("verifyBrowserAccessReadiness()");
  const handoffIndex = source.indexOf('"vscode.openFolder"');

  assert.equal(worktreeIndex >= 0, true);
  assert.equal(worktreeIndex < pendingIndex, true);
  assert.equal(pendingIndex < networkIndex, true);
  assert.equal(networkIndex < composeIndex, true);
  assert.equal(composeIndex < verifyIndex, true);
  assert.equal(verifyIndex < handoffIndex, true);
  assert.equal(source.includes("Uncommitted and untracked source changes are not copied"), true);
  assert.equal(source.includes("persistent data is copied as a point-in-time clone"), true);
  assert.equal(source.includes("seedComposeDotenvFiles(composeDiscovery.sources"), true);
  assert.equal(source.includes("attachVscodeWindowTerminalsToNetwork(network.id)"), true);
  assert.equal(source.includes("removePendingSetup(this.dependencies.context"), true);
});

test("Compose copy rebases config, cwd, and bind mounts into the target worktree", () => {
  const setupSource = readSource("src/extension/isolated-worktree-setup.ts");
  const serviceSource = readSource("src/extension/network-service.ts");
  const mutatorSource = readSource("src/platform/network/compose-publish-mutator.ts");

  assert.equal(setupSource.includes("remapWorkspacePath(composeFile, mapping)"), true);
  assert.equal(setupSource.includes("workspacePathMapping: mapping"), true);
  assert.equal(serviceSource.includes("workspacePathMapping: input.composeMutation.workspacePathMapping"), true);
  assert.equal(mutatorSource.includes("remapComposeBindMounts("), true);
  assert.equal(mutatorSource.includes("remapWorkspacePath(mount.source, mapping)"), true);
});

test("cross-window handoff retains pending state until the target terminal is attached", async (context) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-isolated-handoff-"));
  context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(tempRoot, "captain");
  const targetRoot = path.join(tempRoot, "captain-feature-isolated");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, ".env"), "TOKEN=local\n");

  const vscodeFixture = createVscodeFixture(sourceRoot);
  const { IsolatedWorktreeSetupController, WORKTREE_INITIALIZATION_STATE_KEY } =
    loadIsolatedWorktreeSetup(vscodeFixture.vscode);
  const globalState = new FakeMemento();
  const workspaceState = new FakeMemento();
  const networks: LogicalNetwork[] = [];
  const attachedNetworkIds: string[] = [];
  const networkService = {
    getSnapshot: () => ({
      networks,
      vscodeWindowTerminalBinding: undefined,
      composeAttachments: [],
      containerServiceCandidates: [],
    }),
    refreshContainerServices: async () => [],
    createNetwork: async (name: string) => {
      const network: LogicalNetwork = {
        id: "network-target",
        name,
        runtimeKind: "nativeHelper",
        status: "running",
        createdAt: new Date().toISOString(),
      };
      networks.push(network);
      return network;
    },
    installBrowserDnsResolvers: async () => undefined,
    verifyBrowserAccessReadiness: async () => ({ supported: false }),
    attachVscodeWindowTerminalsToNetwork: async (networkId: string) => {
      attachedNetworkIds.push(networkId);
      return { binding: { id: "vscode-window", networkId }, injectedTerminalCount: 0 };
    },
  };
  let refreshCount = 0;
  const controller = new IsolatedWorktreeSetupController({
    context: { globalState, workspaceState } as never,
    networkService: networkService as never,
    treeProvider: { refresh: () => { refreshCount += 1; } } as never,
    prepareRuntime: async () => "nativeHelper",
    gitWorktrees: {
      inspect: async () => ({
        repositoryRoot: sourceRoot,
        currentBranch: "main",
        head: "0123456789abcdef",
        dirty: true,
        worktrees: [{ path: sourceRoot, branch: "main" }],
      }),
      validateBranchName: async () => undefined,
      createOrReuse: async () => {
        fs.mkdirSync(targetRoot, { recursive: true });
        return {
          repositoryRoot: sourceRoot,
          targetDirectory: targetRoot,
          branchName: "feature/isolated",
          reused: false,
        };
      },
    },
  });

  await controller.create();
  assert.equal(fs.readFileSync(path.join(targetRoot, ".env"), "utf8"), "TOKEN=local\n");
  assert.equal(networks.length, 1);
  assert.equal(vscodeFixture.openedFolders[0], targetRoot);
  assert.equal(globalState.values.get("portManager.isolatedWorktreeSetups.v1") !== undefined, true);

  vscodeFixture.setWorkspaceFolder(targetRoot);
  await controller.resumePending();
  assert.deepEqual(attachedNetworkIds, ["network-target"]);
  assert.equal(vscodeFixture.createdTerminals.length, 1);
  assert.equal(refreshCount >= 2, true);
  assert.equal(
    (workspaceState.get<{ readonly networkId?: string }>(WORKTREE_INITIALIZATION_STATE_KEY))?.networkId,
    "network-target",
  );
  assert.deepEqual(
    globalState.get<{ readonly setups?: readonly unknown[] }>("portManager.isolatedWorktreeSetups.v1")?.setups,
    [],
  );
});

class FakeMemento {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createVscodeFixture(initialFolder: string): {
  readonly vscode: unknown;
  readonly openedFolders: string[];
  readonly createdTerminals: string[];
  setWorkspaceFolder(path: string): void;
} {
  const openedFolders: string[] = [];
  const createdTerminals: string[] = [];
  let workspaceFolder = toWorkspaceFolder(initialFolder);
  const vscode = {
    ProgressLocation: { Notification: 15 },
    Uri: { file: (candidate: string) => toUri(candidate) },
    workspace: {
      get workspaceFolders() { return [workspaceFolder]; },
      getWorkspaceFolder: () => workspaceFolder,
    },
    window: {
      activeTextEditor: undefined,
      showInputBox: async () => "feature/isolated",
      showWarningMessage: async () => "Create Isolated Worktree",
      showInformationMessage: async () => undefined,
      showOpenDialog: async () => undefined,
      withProgress: async (_options: unknown, task: (progress: { report(): void }) => Promise<unknown>) =>
        task({ report: () => undefined }),
      createTerminal: (options: { readonly cwd: { readonly fsPath: string } }) => {
        createdTerminals.push(options.cwd.fsPath);
        return { show: () => undefined };
      },
    },
    commands: {
      executeCommand: async (command: string, uri: { readonly fsPath?: string }) => {
        if (command === "vscode.openFolder" && uri.fsPath !== undefined) {
          openedFolders.push(uri.fsPath);
        }
      },
    },
  };

  return {
    vscode,
    openedFolders,
    createdTerminals,
    setWorkspaceFolder: (candidate: string) => { workspaceFolder = toWorkspaceFolder(candidate); },
  };
}

function toWorkspaceFolder(candidate: string): {
  readonly name: string;
  readonly uri: ReturnType<typeof toUri>;
} {
  return { name: path.basename(candidate), uri: toUri(candidate) };
}

function toUri(candidate: string): {
  readonly fsPath: string;
  readonly scheme: "file";
  toString(): string;
} {
  return {
    fsPath: candidate,
    scheme: "file",
    toString: () => `file://${candidate}`,
  };
}

function loadIsolatedWorktreeSetup(vscodeFixture: unknown): typeof import("../../src/extension/isolated-worktree-setup") {
  const moduleLoader = require("node:module") as {
    _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) =>
    request === "vscode" ? vscodeFixture : originalLoad(request, parent, isMain);
  try {
    return require(path.resolve(__dirname, "../../src/extension/isolated-worktree-setup.js")) as typeof import("../../src/extension/isolated-worktree-setup");
  } finally {
    moduleLoader._load = originalLoad;
  }
}

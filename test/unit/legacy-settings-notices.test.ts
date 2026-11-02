import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

test("attach notices name inactive and active paths, deduplicate repeats, and reappear after edits", async () => {
  const warnings: string[] = [];
  const opened: string[] = [];
  const commands: string[] = [];
  let choice: string | undefined = "Open Active Settings";
  const loader = require("node:module");
  const original = loader._load;
  loader._load = (request: string, parent: NodeModule, main: boolean) => request === "vscode" ? {
    Uri: { file: (file: string) => file },
    commands: { executeCommand: async (name: string, file: string) => { commands.push(name); opened.push(file); } },
    window: {
      showWarningMessage: async (message: string) => { warnings.push(message); return choice; },
      showErrorMessage: async () => {},
    },
  } : original(request, parent, main);
  let present: (name: string, notices: unknown[]) => Promise<void>;
  try {
    ({ presentLegacySettingsNotices: present } = require(path.resolve(__dirname, "../../src/extension/legacy-settings-notices.js")));
  } finally { loader._load = original; }
  const notice = { sourcePath: "/tmp/work/.portmanager/files/알파/.env", destinationPath: "/tmp/work/.portmanager/namespaces/알파/files/.env", signature: "first" };
  await present!("알파", [notice]);
  await present!("알파", [notice]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no longer read/);
  assert.ok(warnings[0].includes(notice.sourcePath));
  assert.ok(warnings[0].includes(notice.destinationPath));
  assert.deepEqual(opened, [notice.destinationPath]);
  choice = undefined;
  await present!("알파", [{ ...notice, signature: "edited" }]);
  assert.equal(warnings.length, 2, "new legacy edits must not be hidden by earlier dismissal");
  assert.equal(opened.length, 1, "dismissal must not open or modify a file");
  choice = "Open Active Settings";
  await present!("알파", [{ ...notice, sourcePath: "/tmp/work/.portmanager/files/알파", destinationPath: "/tmp/work/.portmanager/namespaces/알파/files", signature: "directory", isDirectory: true }]);
  assert.deepEqual(commands, ["vscode.open", "revealInExplorer"]);
});

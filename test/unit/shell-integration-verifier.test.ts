import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { verifyInstalledShellIntegration } from "../../src/platform/process/shell-integration-verifier";

test("installed shell integration proves scripts parse, pm exists, and profiles retain both managed lines", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-shell-verify-"));
  const hookScriptPath = path.join(directory, "hook.sh");
  const commandLibraryPath = path.join(directory, "commands.sh");
  const profilePath = path.join(directory, ".zshrc");
  const preludeLine = `. '${path.join(directory, "pre.sh")}'`;
  const postludeLine = `. '${path.join(directory, "post.sh")}'`;

  try {
    fs.writeFileSync(hookScriptPath, "pm() { :; }\n", { mode: 0o700 });
    fs.writeFileSync(commandLibraryPath, "pm() { printf '%s\\n' ready; }\n", { mode: 0o700 });
    fs.writeFileSync(profilePath, `${preludeLine}\n${postludeLine}\n`);

    await verifyInstalledShellIntegration({
      hookScriptPath,
      commandLibraryPath,
      profilePaths: [profilePath],
      requiredProfileLines: [preludeLine, postludeLine],
    });

    fs.writeFileSync(commandLibraryPath, "pm() {\n", { mode: 0o700 });
    await assert.rejects(
      verifyInstalledShellIntegration({
        hookScriptPath,
        commandLibraryPath,
        profilePaths: [profilePath],
        requiredProfileLines: [preludeLine, postludeLine],
      }),
      /cannot load pm/,
    );

    fs.writeFileSync(commandLibraryPath, "pm() { :; }\n", { mode: 0o700 });
    fs.writeFileSync(profilePath, `${preludeLine}\n`);
    await assert.rejects(
      verifyInstalledShellIntegration({
        hookScriptPath,
        commandLibraryPath,
        profilePaths: [profilePath],
        requiredProfileLines: [preludeLine, postludeLine],
      }),
      /did not retain its managed integration/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

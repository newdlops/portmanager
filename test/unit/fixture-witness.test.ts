import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as vm from "node:vm";
import { fixtureWitnessWriterSource } from "../integration/fixture-witness";

// Observe the real file after open/truncate and before the producer writes any
// bytes. This reproduces the parent polling the witness during publication.
for (const previous of [undefined, { previous: true }]) {
  test(`terminal witness never exposes partial JSON (${previous ? "replacement" : "first publication"})`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-witness-test-"));
    const witness = path.join(directory, "terminal.json");
    const result = { pid: process.pid, networkId: "fixture-a", value: "A:inside" };
    let observed = false;
    try {
      if (previous) fs.writeFileSync(witness, JSON.stringify(previous));
      const runtime = vm.createContext({ process, require: (name: string) => {
        assert.equal(name, "node:fs");
        return { ...fs, writeFileSync: (file: string, bytes: string) => {
          fs.closeSync(fs.openSync(file, "w", 0o600));
          observed = true;
          if (previous) assert.deepEqual(JSON.parse(fs.readFileSync(witness, "utf8")), previous);
          else assert.equal(fs.existsSync(witness), false, "the parent must not see an empty new witness");
          fs.writeFileSync(file, bytes, { mode: 0o600 });
        } };
      } });
      vm.runInContext(`${fixtureWitnessWriterSource()} publishWitness(${JSON.stringify(witness)}, ${JSON.stringify(result)});`, runtime);
      assert.equal(observed, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(witness, "utf8")), result);
      assert.deepEqual(fs.readdirSync(directory), ["terminal.json"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

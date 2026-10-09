/** Shared by the extension-host fixture and the programs it sends to real SDK terminals. */
export function publishFixtureWitness(witnessPath: string, value: unknown): void {
  const fs = require("node:fs") as typeof import("node:fs");
  // Use the shared-source suffix: a state-file suffix such as .tmp would be
  // redirected inside a guarded terminal and hidden from the host observer.
  const temporary = `${witnessPath}.${process.pid}.publishing.cjs`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, witnessPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Keep the generated terminal program on the same publication implementation as the observer fixture. */
export function fixtureWitnessWriterSource(): string {
  return `const publishWitness = ${publishFixtureWitness.toString()};`;
}

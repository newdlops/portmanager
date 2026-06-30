import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolves the extension package version without depending on the caller's cwd.
 * Compiled code runs from out/src/shared, while source-level tests may import
 * from src/shared, so both relative package roots are probed.
 */
export function readPortManagerPackageVersion(): string | undefined {
  for (const packagePath of getPackageJsonCandidates()) {
    const version = readPackageVersion(packagePath);
    if (version !== undefined) {
      return version;
    }
  }

  return undefined;
}

/** True when a daemon/CLI version is useful for package compatibility checks. */
export function isKnownPortManagerPackageVersion(version: string | undefined): version is string {
  return version !== undefined && version.trim().length > 0 && version !== "unknown";
}

function getPackageJsonCandidates(): readonly string[] {
  return [
    path.resolve(__dirname, "..", "..", "..", "package.json"),
    path.resolve(__dirname, "..", "..", "package.json"),
  ];
}

function readPackageVersion(packagePath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { readonly version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

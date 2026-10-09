import assert from "node:assert/strict";
import { promisify } from "node:util";

/**
 * Private storage cannot namespace global PF/lo0/Keychain state. Refuse those
 * mutations at the existing command adapter boundary in isolated local tests;
 * ordinary probes and installed native execution still run unchanged.
 */
export function isolatePrivilegedCommands() {
  const children = require("node:child_process") as typeof import("node:child_process");
  const original = children.execFile;
  const originalAsync = promisify(original);
  const blocked: string[] = [];
  function mutates(file: unknown, args: unknown): boolean {
    if (typeof file !== "string") return false;
    const executable = file.split("/").at(-1)!;
    const argv = Array.isArray(args) ? args.join(" ") : "";
    return executable === "sudo" || executable === "pfctl" ||
      executable === "ifconfig" && /(?:^|\s)-?alias(?:\s|$)/.test(argv) ||
      executable === "security" && /(?:add-trusted-cert|add-certificates|delete-certificate)/.test(argv) ||
      executable === "osascript" && /administrator privileges/i.test(argv) ||
      ["sh", "bash", "zsh"].includes(executable) && /(?:ifconfig\s+lo0\s+-?alias|sudo\s|pfctl\s|add-trusted-cert)/.test(argv);
  }
  function denied(file: string): NodeJS.ErrnoException {
    blocked.push(file.split("/").at(-1)!);
    return Object.assign(new Error("Global system mutation is excluded from isolated packaged validation."), { code: "EACCES" });
  }
  const wrapped = ((...args: unknown[]) => {
    assert.equal(mutates(args[0], args[1]), false, "Synchronous command boundary attempted a global mutation.");
    return Reflect.apply(original, children, args);
  }) as typeof children.execFile;
  Object.defineProperty(wrapped, promisify.custom, { value: async (...args: unknown[]) => {
    if (mutates(args[0], args[1])) throw denied(args[0] as string);
    return Reflect.apply(originalAsync, children, args);
  } });
  children.execFile = wrapped;
  return { blocked, restore() { children.execFile = original; } };
}

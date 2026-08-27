import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { buildNodeRuntimeEnvironment } from "./node-runtime";

export type SupportedNativeArchitecture = "arm64" | "x64";

/**
 * Proves that the OS loader can execute the packaged native agent.
 *
 * `--probe` without its required paths exits in the argument parser before any
 * socket or state mutation. A foreign architecture or too-new deployment
 * target fails in the loader and therefore produces a spawn error instead.
 */
export function canRunNativeAgentBinary(nativeAgentPath: string): boolean {
  if (process.platform === "win32") {
    return false;
  }

  try {
    fs.accessSync(nativeAgentPath, fs.constants.X_OK);
    if (!readNativeBinaryArchitectures(nativeAgentPath).includes(currentNativeArchitecture())) {
      return false;
    }
    return runNativeAgentParserProbe(nativeAgentPath);
  } catch {
    return false;
  }
}

/**
 * Loads the packaged hook into the packaged agent while routing is disabled.
 * This catches a dylib/so with the wrong CPU, deployment target, or loader
 * failure before onboarding edits shell profiles and claims success.
 */
export function canLoadNativeHookLibrary(nativeAgentPath: string, hookLibraryPath: string): boolean {
  if (process.platform === "win32") {
    return false;
  }

  try {
    fs.accessSync(nativeAgentPath, fs.constants.X_OK);
    fs.accessSync(hookLibraryPath, fs.constants.R_OK);
    const architecture = currentNativeArchitecture();
    if (
      !readNativeBinaryArchitectures(nativeAgentPath).includes(architecture) ||
      !readNativeBinaryArchitectures(hookLibraryPath).includes(architecture)
    ) {
      return false;
    }
    return runNativeAgentParserProbe(nativeAgentPath, hookLibraryPath);
  } catch {
    return false;
  }
}

/** Reads thin/fat Mach-O and ELF headers without relying on `file` at runtime. */
export function readNativeBinaryArchitectures(binaryPath: string): readonly SupportedNativeArchitecture[] {
  const header = fs.readFileSync(binaryPath).subarray(0, 4096);
  if (header.length < 20) {
    return [];
  }

  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    const littleEndian = header[5] === 1;
    const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
    return architectureForElfMachine(machine);
  }

  const thinMagic = header.readUInt32BE(0);
  if (thinMagic === 0xcffaedfe || thinMagic === 0xcefaedfe) {
    return architectureForMachCpu(header.readUInt32LE(4));
  }
  if (thinMagic === 0xfeedfacf || thinMagic === 0xfeedface) {
    return architectureForMachCpu(header.readUInt32BE(4));
  }

  const fat32BigEndian = thinMagic === 0xcafebabe;
  const fat64BigEndian = thinMagic === 0xcafebabf;
  const fat32LittleEndian = thinMagic === 0xbebafeca;
  const fat64LittleEndian = thinMagic === 0xbfbafeca;
  if (!fat32BigEndian && !fat64BigEndian && !fat32LittleEndian && !fat64LittleEndian) {
    return [];
  }

  const littleEndian = fat32LittleEndian || fat64LittleEndian;
  const fat64 = fat64BigEndian || fat64LittleEndian;
  const count = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4);
  const stride = fat64 ? 32 : 20;
  const architectures = new Set<SupportedNativeArchitecture>();
  for (let index = 0; index < count && 8 + index * stride + 4 <= header.length; index++) {
    const offset = 8 + index * stride;
    const cpuType = littleEndian ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
    for (const architecture of architectureForMachCpu(cpuType)) {
      architectures.add(architecture);
    }
  }
  return [...architectures];
}

function runNativeAgentParserProbe(nativeAgentPath: string, hookLibraryPath?: string): boolean {
  const environment = buildNodeRuntimeEnvironment(process.env);
  if (hookLibraryPath !== undefined) {
    environment[process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"] = hookLibraryPath;
  }
  const probe = spawnSync(nativeAgentPath, ["--probe"], {
    env: environment,
    encoding: "utf8",
    timeout: 1_000,
    maxBuffer: 256 * 1024,
  });
  const loaderError = /cannot be preloaded|wrong elf class|image not found|incompatible architecture|dyld:/i.test(
    probe.stderr ?? "",
  );
  // The real agent's incomplete --probe contract exits exactly 1 after its
  // parser. Requiring that value also rejects arbitrary executable files.
  return probe.error === undefined && probe.signal === null && probe.status === 1 && !loaderError;
}

function currentNativeArchitecture(): SupportedNativeArchitecture {
  if (process.arch === "arm64") {
    return "arm64";
  }
  if (process.arch === "x64") {
    return "x64";
  }
  throw new Error(`Unsupported Port Manager native architecture: ${process.arch}`);
}

function architectureForMachCpu(cpuType: number): readonly SupportedNativeArchitecture[] {
  if (cpuType === 0x0100000c) {
    return ["arm64"];
  }
  if (cpuType === 0x01000007) {
    return ["x64"];
  }
  return [];
}

function architectureForElfMachine(machine: number): readonly SupportedNativeArchitecture[] {
  if (machine === 183) {
    return ["arm64"];
  }
  if (machine === 62) {
    return ["x64"];
  }
  return [];
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePosixLsofListeningPorts,
  parseWindowsListeningPortsJson,
} from "../../src/platform/ports/node-listening-port-provider";

/**
 * Parser coverage for the listening-port provider.
 *
 * These tests avoid opening real sockets and instead lock down the low-level
 * command output formats that the single local agent will consume.
 */

const scanTimestamp = "2026-06-21T09:30:00.000Z";

test("parses POSIX lsof field output into listening TCP port rows", () => {
  const lsofOutput = [
    "p101",
    "cnode",
    "n*:3000",
    "nTCP 127.0.0.1:5173 (LISTEN)",
    "p202",
    "cpython3",
    "nTCP [::1]:8000 (LISTEN)",
  ].join("\n");

  const listeners = parsePosixLsofListeningPorts(lsofOutput, scanTimestamp);

  assert.deepEqual(listeners, [
    {
      id: "tcp:*:3000:101",
      protocol: "tcp",
      localAddress: "*",
      port: 3000,
      pid: 101,
      processName: "node",
      command: "node",
      source: "external",
      updatedAt: scanTimestamp,
    },
    {
      id: "tcp:127.0.0.1:5173:101",
      protocol: "tcp",
      localAddress: "127.0.0.1",
      port: 5173,
      pid: 101,
      processName: "node",
      command: "node",
      source: "external",
      updatedAt: scanTimestamp,
    },
    {
      id: "tcp:::1:8000:202",
      protocol: "tcp",
      localAddress: "::1",
      port: 8000,
      pid: 202,
      processName: "python3",
      command: "python3",
      source: "external",
      updatedAt: scanTimestamp,
    },
  ]);
});

test("parses Windows PowerShell JSON output into listening TCP port rows", () => {
  const windowsOutput = JSON.stringify([
    {
      protocol: "tcp",
      localAddress: "0.0.0.0",
      port: 3000,
      pid: 101,
      processName: "node",
      command: "C:\\Program Files\\nodejs\\node.exe",
    },
    {
      LocalAddress: "::1",
      LocalPort: "5173",
      OwningProcess: "202",
      ProcessName: "Code",
      Path: "C:\\Users\\newdlops\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    },
  ]);

  const listeners = parseWindowsListeningPortsJson(windowsOutput, scanTimestamp);

  assert.deepEqual(listeners, [
    {
      id: "tcp:0.0.0.0:3000:101",
      protocol: "tcp",
      localAddress: "0.0.0.0",
      port: 3000,
      pid: 101,
      processName: "node",
      command: "C:\\Program Files\\nodejs\\node.exe",
      source: "external",
      updatedAt: scanTimestamp,
    },
    {
      id: "tcp:::1:5173:202",
      protocol: "tcp",
      localAddress: "::1",
      port: 5173,
      pid: 202,
      processName: "Code",
      command: "C:\\Users\\newdlops\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
      source: "external",
      updatedAt: scanTimestamp,
    },
  ]);
});

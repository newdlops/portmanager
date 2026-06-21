import type { PortInjectionMode } from "../shared/types";

/**
 * Parser utilities for terminal listen failures.
 *
 * These helpers stay framework-neutral so the extension can monitor VS Code
 * terminal output while tests can validate the matching rules without loading
 * the VS Code API.
 */

export interface TerminalListenFailure {
  /** Host reported by the failing server when available. */
  readonly host?: string;
  /** TCP port that failed to bind. */
  readonly port: number;
  /** Short normalized reason used in prompts and diagnostics. */
  readonly reason: string;
  /** Sanitized terminal text that matched a listen failure pattern. */
  readonly rawText: string;
}

export interface ReroutableCommand {
  /** Command text to send to the managed process launcher. */
  readonly command: string;
  /** Injection mode that can provide the routed actual port. */
  readonly injectionMode: PortInjectionMode;
}

const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Detects common port-bind failures from terminal output.
 * Daphne's `Couldn't listen on host:port` message is handled explicitly, then
 * generic EADDRINUSE/Address-in-use forms are checked as a fallback.
 */
export function detectTerminalListenFailure(output: string): TerminalListenFailure | undefined {
  const sanitizedOutput = stripTerminalControlSequences(output);
  const daphneMatch = sanitizedOutput.match(
    /Couldn't listen on\s+([^:\s]+):(\d{1,5})[\s\S]{0,160}?(?:Address already in use|Errno\s*48)/i,
  );

  if (daphneMatch) {
    return buildListenFailure(daphneMatch[2], sanitizedOutput, "address already in use", daphneMatch[1]);
  }

  const hostPortMatch = sanitizedOutput.match(
    /(?:EADDRINUSE|Address already in use|Errno\s*48)[\s\S]{0,160}?((?:\d{1,3}\.){3}\d{1,3}|localhost|\*|0\.0\.0\.0):(\d{1,5})/i,
  );

  if (hostPortMatch) {
    return buildListenFailure(hostPortMatch[2], sanitizedOutput, "address already in use", hostPortMatch[1]);
  }

  const portOnlyMatch = sanitizedOutput.match(
    /(?:EADDRINUSE|Address already in use|Errno\s*48)[\s\S]{0,160}?(?:port\s*)?[:=]?\s*(\d{2,5})/i,
  );

  if (portOnlyMatch) {
    return buildListenFailure(portOnlyMatch[1], sanitizedOutput, "address already in use");
  }

  return undefined;
}

/**
 * Rewrites a failed terminal command into a Port Manager managed command.
 * If the requested port appears in the command, template mode preserves the
 * user's original flag style; otherwise argument mode appends `--port`.
 */
export function buildReroutableCommand(command: string, requestedPort: number): ReroutableCommand {
  const portText = String(requestedPort);
  const portPattern = new RegExp(`(?<!\\d)${escapeRegExp(portText)}(?!\\d)`, "g");
  const templatedCommand = command.replace(portPattern, "${port}");

  if (templatedCommand !== command || command.includes("${port}")) {
    return {
      command: templatedCommand,
      injectionMode: "template",
    };
  }

  return {
    command,
    injectionMode: "argument",
  };
}

/** Removes ANSI/control sequences from shell output before regex matching. */
function stripTerminalControlSequences(output: string): string {
  return output.replace(ANSI_ESCAPE_PATTERN, "");
}

/** Builds a validated listen failure result from a regex port capture. */
function buildListenFailure(
  portText: string | undefined,
  rawText: string,
  reason: string,
  host?: string,
): TerminalListenFailure | undefined {
  const port = Number.parseInt(portText ?? "", 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }

  return {
    host,
    port,
    reason,
    rawText: rawText.trim(),
  };
}

/** Escapes a string for literal use in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

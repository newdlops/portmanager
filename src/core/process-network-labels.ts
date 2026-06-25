import type { TerminalAttachment } from "../shared/types";

export type ProcessNetworkLabelSource = "direct-pid" | "ancestor-pid" | "process-group" | "terminal";

export interface ProcessNetworkLabelRow {
  /** OS process id used as the process-tree node key. */
  readonly pid: number;
  /** Parent process id used to walk from clients back toward attached roots. */
  readonly parentPid: number;
  /** POSIX process group id shared by terminal-launched process trees. */
  readonly processGroupId?: number;
  /** Controlling terminal id, normalized without /dev/ when available. */
  readonly terminalId?: string;
}

export interface ProcessNetworkLabelResolution {
  /** Logical network selected from the process-tree label registry. */
  readonly networkId: string;
  /** Label tier that selected the network. */
  readonly source: ProcessNetworkLabelSource;
}

/**
 * Resolves a client process to the logical network label attached to its tree.
 *
 * Terminal attachments are the label registry: root PID labels are strongest,
 * then ancestors, process groups, and terminal ids. Ambiguous matches at the
 * same tier intentionally return undefined so callers can use older fallback
 * signals without making a random network choice.
 */
export function resolveProcessTreeNetworkLabel(
  attachments: readonly TerminalAttachment[],
  processRows: readonly ProcessNetworkLabelRow[],
  pid: number,
): ProcessNetworkLabelResolution | undefined {
  const activeAttachments = attachments.filter((attachment) => attachment.status === "attached");
  const direct = uniqueLabelResolution(
    "direct-pid",
    activeAttachments.filter((attachment) => attachment.rootPid === pid),
  );
  if (direct !== undefined) {
    return direct;
  }

  const context = buildLabelProcessContext(processRows, pid);
  if (context === undefined) {
    return undefined;
  }

  const ancestorPids = new Set(context.ancestorRows.map((row) => row.pid));
  const ancestor = uniqueLabelResolution(
    "ancestor-pid",
    activeAttachments.filter((attachment) => ancestorPids.has(attachment.rootPid)),
  );
  if (ancestor !== undefined) {
    return ancestor;
  }

  const relatedRows = [context.row, ...context.ancestorRows];
  const processGroupIds = new Set(
    relatedRows
      .map((row) => row.processGroupId)
      .filter((processGroupId): processGroupId is number => processGroupId !== undefined),
  );
  const processGroup = uniqueLabelResolution(
    "process-group",
    activeAttachments.filter(
      (attachment) => attachment.processGroupId !== undefined && processGroupIds.has(attachment.processGroupId),
    ),
  );
  if (processGroup !== undefined) {
    return processGroup;
  }

  const terminalIds = new Set(
    relatedRows
      .map((row) => normalizeTerminalId(row.terminalId))
      .filter((terminalId): terminalId is string => terminalId !== undefined),
  );
  return uniqueLabelResolution(
    "terminal",
    activeAttachments.filter((attachment) => {
      const terminalId = normalizeAttachmentTerminalId(attachment);
      return terminalId !== undefined && terminalIds.has(terminalId);
    }),
  );
}

interface LabelProcessContext {
  readonly row: ProcessNetworkLabelRow;
  readonly ancestorRows: readonly ProcessNetworkLabelRow[];
}

function buildLabelProcessContext(
  rows: readonly ProcessNetworkLabelRow[],
  pid: number,
): LabelProcessContext | undefined {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const row = byPid.get(pid);
  const ancestorRows: ProcessNetworkLabelRow[] = [];
  const seen = new Set<number>([pid]);

  if (row === undefined) {
    return undefined;
  }

  let cursor = row;
  while (cursor.parentPid > 0 && !seen.has(cursor.parentPid)) {
    const parent = byPid.get(cursor.parentPid);
    if (parent === undefined) {
      break;
    }

    ancestorRows.push(parent);
    seen.add(parent.pid);
    cursor = parent;
  }

  return { row, ancestorRows };
}

function uniqueLabelResolution(
  source: ProcessNetworkLabelSource,
  attachments: readonly TerminalAttachment[],
): ProcessNetworkLabelResolution | undefined {
  const networkIds = new Set(attachments.map((attachment) => attachment.networkId));
  if (networkIds.size !== 1) {
    return undefined;
  }

  return {
    networkId: [...networkIds][0],
    source,
  };
}

function normalizeAttachmentTerminalId(attachment: TerminalAttachment): string | undefined {
  const terminalWindowId = attachment.terminalWindowId;
  if (terminalWindowId === undefined || !terminalWindowId.startsWith("tty:")) {
    return undefined;
  }

  return normalizeTerminalId(terminalWindowId.slice("tty:".length));
}

function normalizeTerminalId(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^\/dev\//, "");
  return normalized === undefined || normalized.length === 0 || normalized === "?" ? undefined : normalized;
}

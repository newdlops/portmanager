/**
 * Pure presentation helpers for the native sidebar's compact scan summaries.
 * Domain state and command behavior intentionally remain in the tree provider;
 * these helpers only turn snapshot facts into short, deterministic text.
 */

import type { AgentDaemonStatus, AgentSnapshot, NetworkSnapshot } from "../../shared/types";

export interface SidebarSummaryCount {
  readonly count: number;
  readonly singular: string;
  readonly plural?: string;
}

/** Problem totals behind the activity-bar badge; `count` is 0 when nothing needs attention. */
export interface SidebarIssueSummary {
  readonly count: number;
  /** One comma-separated line naming each problem kind, used as the badge tooltip. */
  readonly tooltip: string;
}

/** Formats the sidebar-wide `<state> · <count>` description grammar. */
export function formatSidebarSummary(state: string, counts: readonly SidebarSummaryCount[] = []): string {
  const details = formatSidebarCounts(counts);
  return details.length === 0 ? state : `${state} · ${details}`;
}

/**
 * Formats only the non-zero counts (`2 routes · 1 terminal`) for rows whose
 * label already names the state, so they do not need a filler word like
 * "Available". Returns an empty string when every count is zero.
 */
export function formatSidebarCounts(counts: readonly SidebarSummaryCount[]): string {
  return counts
    .filter((item) => item.count > 0)
    .map((item) => `${item.count} ${item.count === 1 ? item.singular : item.plural ?? `${item.singular}s`}`)
    .join(" · ");
}

/**
 * Counts failures that stay hidden while the sidebar is collapsed: error-state
 * networks, attachments, host mappings, and daemon routes, plus a daemon that
 * errored or runs a stale build. Transitional states (starting, disconnected
 * during activation) are ignored so the badge does not flicker on startup.
 */
export function summarizeSidebarIssues(
  snapshot: NetworkSnapshot,
  agentSnapshot: AgentSnapshot,
  daemon: AgentDaemonStatus,
): SidebarIssueSummary {
  const daemonIssues = [
    ...(daemon.restartRequired ? ["daemon restart required"] : []),
    ...(daemon.status === "error" ? ["daemon error"] : []),
  ];
  const countedIssues: SidebarSummaryCount[] = [
    { count: snapshot.networks.filter((network) => network.status === "error").length, singular: "network error" },
    { count: snapshot.attachments.filter((attachment) => attachment.status === "error").length, singular: "terminal error" },
    {
      count: snapshot.composeAttachments.filter((attachment) => attachment.status === "error").length,
      singular: "Compose error",
    },
    { count: snapshot.exposures.filter((exposure) => exposure.status === "error").length, singular: "host binding error" },
    {
      count: snapshot.hostAccessBindings.filter((binding) => binding.status === "error").length,
      singular: "host access error",
    },
    { count: agentSnapshot.routes.filter((route) => route.status === "error").length, singular: "route error" },
  ];
  const count = daemonIssues.length + countedIssues.reduce((total, issue) => total + issue.count, 0);
  const labels = [
    ...daemonIssues,
    ...countedIssues
      .filter((issue) => issue.count > 0)
      .map((issue) => formatSidebarCounts([issue])),
  ];

  return {
    count,
    tooltip: count === 0 ? "" : `Port Manager: ${labels.join(", ")}`,
  };
}

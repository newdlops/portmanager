/**
 * Pure presentation helpers for the native sidebar's compact scan summaries.
 * Domain state and command behavior intentionally remain in the tree provider.
 */

export interface SidebarSummaryCount {
  readonly count: number;
  readonly singular: string;
  readonly plural?: string;
}

/** Formats the sidebar-wide `<state> · <count>` description grammar. */
export function formatSidebarSummary(state: string, counts: readonly SidebarSummaryCount[] = []): string {
  const details = counts
    .filter((item) => item.count > 0)
    .map((item) => `${item.count} ${item.count === 1 ? item.singular : item.plural ?? `${item.singular}s`}`);
  return [state, ...details].join(" · ");
}

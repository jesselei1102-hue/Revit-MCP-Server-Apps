/** What the model sees from mcp_apps_get_schedule_data: counts only. The app loads the rows itself (detail "full"). */
export type ScheduleSummary = {
  detail: "summary";
  matchedCount: number;
  totalMatched: number;
  truncated: boolean;
  linkedMatchedCount: number;
  loadedLinkCount: number;
  unloadedLinkCount: number;
  byCategory: Record<string, number>;
  dashboard: { errorCount: number; warningCount?: number; detachableFamilyCount: number };
  message: string | null;
};

const TEXT_CATEGORY_LIMIT = 15;

export function summarizeSchedule(data: {
  rows: Record<string, string>[];
  matchedCount: number;
  totalMatched: number;
  truncated: boolean;
  linkedMatchedCount?: number;
  loadedLinkCount?: number;
  unloadedLinkCount?: number;
  dashboard: ScheduleSummary["dashboard"];
  message: string | null;
}): { structured: ScheduleSummary; text: string } {
  const counts = new Map<string, number>();
  let linked = 0;
  for (const row of data.rows) {
    const category = row.category || "(none)";
    counts.set(category, (counts.get(category) ?? 0) + 1);
    if (row.link && row.link !== "(host)") linked++;
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const structured: ScheduleSummary = {
    detail: "summary",
    matchedCount: data.matchedCount,
    totalMatched: data.totalMatched,
    truncated: data.truncated,
    linkedMatchedCount: data.linkedMatchedCount ?? linked,
    loadedLinkCount: data.loadedLinkCount ?? 0,
    unloadedLinkCount: data.unloadedLinkCount ?? 0,
    byCategory: Object.fromEntries(sorted),
    dashboard: data.dashboard,
    message: data.message,
  };

  const total = data.rows.length;
  const shown = sorted.slice(0, TEXT_CATEGORY_LIMIT).map(([name, n]) => `${name} ${n}`);
  if (sorted.length > TEXT_CATEGORY_LIMIT) shown.push(`+${sorted.length - TEXT_CATEGORY_LIMIT} more categories`);
  const warnings = data.dashboard.warningCount ?? data.dashboard.errorCount;
  const text = [
    `Opened the Revit Schedule app with ${total} elements (${total - linked} host, ${linked} linked).`,
    total ? `By category: ${shown.join(", ")}.` : "",
    `Model: ${warnings} warnings, ${data.dashboard.detachableFamilyCount} unused families.`,
    data.truncated ? `Only the first ${data.matchedCount} of ${data.totalMatched} matches were loaded.` : "",
    "The app holds the full table; its filters, ticked rows and pending edits are shared with you as model context.",
  ]
    .filter(Boolean)
    .join(" ");
  return { structured, text };
}

// Small text rules for the Schedule window (counts, percentages, headings), kept apart so they can be tested.

type ModelStats = { warningCount?: number; errorCount?: number; detachableFamilyCount?: number };
type Severities = { error: number; warning: number; info: number };

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** Rules passing as a plain percentage; a dash before anything has run. */
export function pctText(pct: number | null): string {
  return pct == null ? "—" : `${pct}%`;
}

/** The line at the top of Checks: model warnings and families that can be detached. */
export function modelLine(stats: ModelStats | null): string {
  if (!stats) return "Model · —";
  const count = (n: number | undefined, word: string, many?: string) =>
    n == null ? `— ${many ?? `${word}s`}` : plural(n, word, many);
  return `Model · ${count(stats.warningCount ?? stats.errorCount, "warning")} · ${count(stats.detachableFamilyCount, "detachable family", "detachable families")}`;
}

/** Heading of the fixes list, with the severity counts that used to have their own card. */
export function fixesHeading(bySeverity: Severities | null): string {
  if (!bySeverity || bySeverity.error + bySeverity.warning + bySeverity.info === 0) return "Fixes";
  const parts = [plural(bySeverity.error, "error"), plural(bySeverity.warning, "warning")];
  if (bySeverity.info) parts.push(`${bySeverity.info} info`);
  return `Fixes · ${parts.join(" · ")}`;
}

export function rulesOnLabel(rulesOn: number, lastRun: string | null): string {
  return `${plural(rulesOn, "rule")} on · ${lastRun ? `last run ${lastRun}` : "not run yet"}`;
}

/** The number on the Checks tab: failing rules in the last run, nothing when none fail. */
export function failingCount(summary: { rules?: { fail: number } } | null | undefined): string {
  // a running run's summary carries only { progress }
  return summary?.rules?.fail ? String(summary.rules.fail) : "";
}

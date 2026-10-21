import { collect, countLinked, planCollection, readProjectIdentity, type Send } from "./collector.js";
import { categoryLabel, evaluate, failsRule, inScope, resolveParam, type CollectedElement, type RuleResult } from "./engine.js";
import type { Rule } from "./ruleFormat.js";
import type { CheckStore, RunSummary } from "./store.js";

export function emptySummary(): RunSummary {
  return {
    rules: { pass: 0, fail: 0, na: 0 },
    bySeverity: { error: 0, warning: 0, info: 0 },
    byGroup: {},
    categories: {},
    parameters: [],
    elementsChecked: 0,
  };
}

/** Dashboard numbers: rule outcomes, issues per severity, per-category compliance and parameter fill rates. */
export function summarize(
  rules: Rule[],
  results: RuleResult[],
  elements: CollectedElement[],
  linked: Record<string, number>
): RunSummary {
  const summary = emptySummary();
  summary.elementsChecked = elements.length;
  const byId = new Map(results.map((r) => [r.ruleId, r]));

  for (const rule of rules) {
    const result = byId.get(rule.id);
    if (!result) continue;
    if (result.status === "pass") summary.rules.pass++;
    else if (result.status === "fail") summary.rules.fail++;
    else summary.rules.na++;
    summary.bySeverity[rule.severity] += result.failedCount;
    const group = (summary.byGroup[rule.group] ??= { rules: 0, failing: 0 });
    group.rules++;
    if (result.status === "fail") group.failing++;
  }

  // Compliance: share of elements in scope of at least one rule that fail none.
  const scoped = new Set<number>();
  const failing = new Set<number>();
  const fill = new Map<string, { filled: number; total: number; where: Set<string> }>();
  for (const rule of rules) {
    for (const el of elements) {
      if (!inScope(rule, el)) continue;
      scoped.add(el.id);
      if (failsRule(rule, el)) failing.add(el.id);
      for (const c of rule.require) {
        const entry = fill.get(c.param) ?? { filled: 0, total: 0, where: new Set<string>() };
        entry.total++;
        if (resolveParam(el, c.param).hasValue) entry.filled++;
        entry.where.add(categoryLabel(el.category));
        fill.set(c.param, entry);
      }
    }
  }

  const categories = new Set([...elements.map((e) => e.category), ...Object.keys(linked)]);
  for (const category of categories) {
    const hostEls = elements.filter((e) => e.category === category);
    const inScopeEls = hostEls.filter((e) => scoped.has(e.id));
    summary.categories[category] = {
      host: hostEls.length,
      linked: linked[category] ?? 0,
      compliantPct: inScopeEls.length
        ? Math.round((inScopeEls.filter((e) => !failing.has(e.id)).length / inScopeEls.length) * 100)
        : null,
    };
  }

  summary.parameters = [...fill]
    .map(([name, f]) => ({ name, where: [...f.where].sort(), fillPct: Math.round((f.filled / f.total) * 100) }))
    .sort((a, b) => a.fillPct - b.fillPct || a.name.localeCompare(b.name));
  return summary;
}

/**
 * Start a check run for the open Revit document. Resolves once the run row exists; `done` settles when the run
 * is stored as done or failed (it never rejects).
 */
export async function runChecks(
  deps: { store: CheckStore; send: Send },
  opts: { rulesetIds?: string[] }
): Promise<{ runId: number; done: Promise<void> }> {
  const { store, send } = deps;
  const identity = await readProjectIdentity(send);
  const projectId = store.findOrCreateProject(identity.name, identity.path);
  const runId = store.startRun(projectId);

  const done = (async () => {
    try {
      const rules = store.enabledRules(opts.rulesetIds);
      const plan = planCollection(rules);
      store.updateProgress(runId, { stage: "collecting", done: 0, total: plan.size });
      const { elements, unavailable } = await collect(send, plan, (d, t) =>
        store.updateProgress(runId, { stage: "collecting", done: d, total: t })
      );
      store.updateProgress(runId, { stage: "evaluating", done: 0, total: rules.length });
      const results = evaluate(rules, elements, unavailable);
      const linked = await countLinked(send, [...plan.keys()]);
      const summary = summarize(rules, results, elements, linked);
      const failedCats = Object.keys(unavailable);
      if (plan.size > 0 && failedCats.length === plan.size) {
        store.finishRun(runId, results, summary, "failed", `Every category failed to load: ${Object.values(unavailable)[0]}`);
      } else {
        store.finishRun(runId, results, summary, "done");
      }
    } catch (error) {
      store.finishRun(runId, [], emptySummary(), "failed", error instanceof Error ? error.message : String(error));
    }
  })();
  return { runId, done };
}

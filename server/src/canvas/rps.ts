/**
 * Result Presentation Standard (RPS-1) validator for Agent Canvas results ("revit-result/1").
 * The same rules run in the panel page (panel-view/canvas/rps.js); checking here first means the
 * agent gets the list of broken rules straight back instead of a blank panel.
 */

export type Violation = { rule: string; msg: string };

const STATUSES = ["fail", "attention", "pass", "info", "cat1", "cat2"];
const PROBLEM = ["fail", "attention", "cat1", "cat2"];
export const LAYOUTS = ["model-focus", "model-and-list", "tour", "report"] as const;
const API_TOKENS = /\b(OST_\w+|BuiltInParameter|BuiltInCategory|ElementId|FilteredElementCollector)\b/;
const BARE_ID = /\b\d{5,}\b/;

type AnyRecord = Record<string, any>;
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export function validatePresentation(s: AnyRecord, add: (rule: string, msg: string) => void): void {
  const p = s.presentation as AnyRecord | undefined;
  if (!p) return;
  if (!LAYOUTS.includes(p.layout)) add("G1", `Layout "${p.layout}" is not one of ${LAYOUTS.join(", ")}.`);
  if (p.show && !["failures-only", "in-context", "everything"].includes(p.show)) add("G2", `Show mode "${p.show}" is not allowed.`);
  if (p.levels && !["stacked", "exploded", "cut"].includes(p.levels)) add("G2", `Level mode "${p.levels}" is not allowed.`);
  const problems = arr(s.subjects).filter((x) => PROBLEM.includes(x?.status));
  if (p.show === "failures-only" && !problems.length) add("G3", "Only-failures needs at least one failing item; show everything when all pass.");
  if (p.layout === "tour" && (problems.length < 2 || problems.length > 8)) add("G4", "A walk-through needs 2 to 8 stops; use model focus or a list otherwise.");
  if (p.levels === "cut" && !(s.view && s.view.level)) add("G2", "A cut view must name its level in view.level.");
  if (arr(p.overlays).includes("measure")) {
    const m = (p.measure || {}) as AnyRecord;
    if (!m.value || !arr(s.subjects).every((x) => x?.values && typeof x.values[m.value] === "number")) add("G5", "A measure overlay needs every item to carry the measured value it names.");
  }
  if (!p.why) add("G6", "Say in one sentence why this layout fits the question; readers see it.");
}

export function validateSpec(s: AnyRecord): Violation[] {
  const v: Violation[] = [];
  const add = (rule: string, msg: string) => v.push({ rule, msg });
  if (!s || typeof s !== "object") return [{ rule: "Spec", msg: "The result must be an object." }];
  validatePresentation(s, add);
  if (s.spec !== "revit-result/1") add("Spec", "The result must declare spec revit-result/1.");
  if (!s.question || String(s.question).trim().length < 8) add("A3", "Show the question in the user's own words.");
  if (!s.outcome || String(s.outcome).length < 20 || String(s.outcome).length > 160) add("A1", "Open with a plain-language answer of 20 to 160 characters that states the count and scope.");
  if (s.outcome && (BARE_ID.test(s.outcome) || API_TOKENS.test(s.outcome))) add("A4", "The answer uses element ids or API names; use marks, room names and plain words.");
  if (!["pass", "attention", "fail", "info"].includes(s.verdict)) add("A2", "Give a verdict: pass, attention, fail or info.");
  if (!s.scope || !s.scope.model) add("A3", "Name the model and the scope that was checked.");
  const view = (s.view || {}) as AnyRecord;
  if (!["plan", "axon", "elevation"].includes(view.kind)) add("B3", "Choose a view that fits the question: plan, axon or elevation.");
  if (view.kind === "plan" && !view.level) add("B3", "A plan view must name its level.");
  if (!view.caption) add("B1", "Caption the drawing: say what the reader is looking at.");
  if (!Array.isArray(view.legend) || view.legend.length < 1) add("B1", "Explain every colour in the legend, in words.");
  if (Array.isArray(view.legend) && view.legend.length > 5) add("B6", `Use at most 5 legend entries; this result has ${view.legend.length}. Group the rest as Other.`);
  arr(view.legend).forEach((l) => {
    if (!STATUSES.includes(l?.status)) add("B6", `Legend colour "${l?.status}" is not from the status set.`);
    if (!l?.label || String(l.label).length < 3) add("B1", "Each legend entry needs a label that says what it means.");
  });
  // Empty callouts are fine (clash overview = boxes only). Pins draw only for the selected callout.
  if (arr(view.callouts).length > 5) add("B7", "Call out at most 5 key elements.");
  arr(s.subjects).forEach((x) => { if (!x?.label) add("B5", "Each element needs a human label, such as a door mark or room name."); });
  arr(s.figures).forEach((f) => { if (!f?.label) add("C2", "Each key figure needs a label."); });
  if (arr(s.figures).length > 4) add("C2", "Show at most 4 key figures.");
  if (arr(s.charts).length > 2) add("C3", "Use at most 2 charts.");
  arr(s.charts).forEach((c) => {
    if (!["bar", "stacked-bar", "progress", "line"].includes(c?.type)) add("C3", `Chart type "${c?.type}" is not allowed; use bar, stacked bar, progress or line.`);
    if (!c?.title) add("C3", "Title each chart with its takeaway, not its type.");
  });
  if (arr(s.columns).length > 6) add("C4", "Show at most 6 item columns.");
  arr(s.actions).forEach((a) => { if (a?.kind === "propose_change" && (!a.effect || typeof a.count !== "number")) add("D1", `"${a.label}" must say what it changes and how many elements it touches.`); });
  const p = (s.provenance || {}) as AnyRecord;
  if (!p.ran_at || !p.rule || !p.source) add("E1", "State when the check ran, the rule applied in plain words, and the data source.");
  if (!Array.isArray(s.limits) && !s.limits_none) add("E2", "List what was not checked, or state that nothing was left out.");
  const seen = new Set<string>();
  return v.filter((x) => { const k = x.rule + x.msg; if (seen.has(k)) return false; seen.add(k); return true; });
}

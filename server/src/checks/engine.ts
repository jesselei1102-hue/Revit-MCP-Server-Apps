import type { Condition, Rule } from "./ruleFormat.js";

/** A parameter as read from Revit; null = the parameter does not exist on that element/type. */
export type ParamValue = { defined: true; hasValue: boolean; value: string | null; onType: boolean } | null;

/** One host element with the parameters the enabled rules need. Keys: "i:<name>" instance, "t:<name>" type. */
export type CollectedElement = {
  id: number;
  category: string;
  isType: boolean;
  typeId: number | null;
  typeName: string;
  level: string;
  params: Record<string, ParamValue>;
};

export type RuleResult = {
  ruleId: string;
  status: "pass" | "fail" | "n/a";
  inScope: number;
  failedCount: number;
  failedIds: number[];
  byType: Record<string, number>;
  fix: string | null;
  note?: string;
};

/** Names that refer to the same parameter (IFC-SG uses both, depending on the Revit version). */
export const PARAM_ALIASES: Record<string, string[]> = {
  IfcExportAs: ["Export to IFC As"],
  "Export to IFC As": ["IfcExportAs"],
};

const MAX_FAILED_IDS = 500;
const TYPE_MAJORITY = 0.6;

export function paramNames(name: string): string[] {
  return [name, ...(PARAM_ALIASES[name] ?? [])];
}

/** Instance value first; if the instance has no value, the type's; defined = present on either. */
export function resolveParam(el: CollectedElement, name: string) {
  let defined = false;
  let emptyOnType = false;
  let fallback: { value: string | null; onType: boolean } | null = null;
  for (const n of paramNames(name)) {
    const inst = el.params[`i:${n}`];
    const type = el.params[`t:${n}`];
    if (inst) {
      defined = true;
      if (inst.hasValue) return { defined, hasValue: true, value: inst.value, onType: false };
      fallback ??= { value: inst.value, onType: false };
    }
    if (type) {
      defined = true;
      if (type.hasValue) return { defined, hasValue: true, value: type.value, onType: true };
      emptyOnType = true;
    }
  }
  return { defined, hasValue: false, value: fallback?.value ?? null, onType: !fallback && emptyOnType };
}

function asNumber(value: string | null): number {
  return value == null ? Number.NaN : Number.parseFloat(value);
}

export function evalCondition(el: CollectedElement, c: Condition): boolean {
  const p = resolveParam(el, c.param);
  const norm = (s: string) => (c.caseInsensitive ? s.toLowerCase() : s);
  const value = p.hasValue && p.value != null ? norm(p.value) : null;
  const target = c.value != null ? norm(c.value) : "";
  switch (c.op) {
    case "defined":
      return p.defined;
    case "notDefined":
      return !p.defined;
    case "hasValue":
      return p.hasValue;
    case "isEmpty":
      return !p.hasValue;
    case "equals":
      return value === target;
    case "notEquals":
      return value !== target;
    case "contains":
      return value != null && value.includes(target);
    case "matches":
      return value != null && new RegExp(c.value ?? "", c.caseInsensitive ? "i" : "").test(p.value ?? "");
    case "gt": {
      const n = asNumber(p.hasValue ? p.value : null);
      return Number.isFinite(n) && n > Number(c.value);
    }
    case "lt": {
      const n = asNumber(p.hasValue ? p.value : null);
      return Number.isFinite(n) && n < Number(c.value);
    }
  }
}

function inScope(rule: Rule, el: CollectedElement): boolean {
  if (!rule.scope.categories.includes(el.category)) return false;
  if (rule.scope.elementKind === "instance" && el.isType) return false;
  if (rule.scope.elementKind === "type" && !el.isType) return false;
  return rule.scope.where.every((c) => evalCondition(el, c));
}

/** "OST_StructuralFraming" → "Structural Framing". */
export function categoryLabel(category: string): string {
  return category.replace(/^OST_/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function dominantType(failed: CollectedElement[]): { name: string; count: number } {
  const counts = new Map<string, number>();
  for (const el of failed) counts.set(el.typeName, (counts.get(el.typeName) ?? 0) + 1);
  let best = { name: "", count: 0 };
  for (const [name, count] of counts) if (count > best.count) best = { name, count };
  return best;
}

export function buildFix(rule: Rule, failed: CollectedElement[], reason: "notDefined" | "empty"): string {
  const param = rule.require[0]?.param ?? "the parameter";
  const count = failed.length;
  const category = categoryLabel(failed[0]?.category ?? rule.scope.categories[0] ?? "");
  const top = dominantType(failed);
  if (rule.fix) {
    return rule.fix
      .replaceAll("{param}", param)
      .replaceAll("{count}", String(count))
      .replaceAll("{category}", category)
      .replaceAll("{type}", top.name);
  }
  if (reason === "notDefined") {
    return `${count} ${category} don't have the "${param}" parameter — add it as a shared parameter to the family or as a project parameter, then fill it in.`;
  }
  if (count > 1 && top.count / count >= TYPE_MAJORITY) {
    return `${count} ${category} miss ${param}; ${top.count} share type "${top.name}" — set it on the type. Fill the other ${count - top.count} in 01 Elements (filter ${category}).`;
  }
  return `Fill ${param} on ${count} ${category} in 01 Elements (filter ${category}).`;
}

export function evaluate(
  rules: Rule[],
  elements: CollectedElement[],
  unavailable: Record<string, string> = {}
): RuleResult[] {
  return rules.map((rule) => {
    const missing = rule.scope.categories.filter((c) => unavailable[c]);
    if (missing.length === rule.scope.categories.length) {
      return {
        ruleId: rule.id,
        status: "n/a",
        inScope: 0,
        failedCount: 0,
        failedIds: [],
        byType: {},
        fix: null,
        note: missing.map((c) => `${categoryLabel(c)}: ${unavailable[c]}`).join("; "),
      };
    }
    const scoped = elements.filter((el) => inScope(rule, el));
    const failed = scoped.filter((el) => !rule.require.every((c) => evalCondition(el, c)));
    const byType: Record<string, number> = {};
    for (const el of failed) byType[el.typeName] = (byType[el.typeName] ?? 0) + 1;
    const notDefined = failed.some((el) => rule.require.some((c) => !resolveParam(el, c.param).defined));
    const note = missing.length
      ? `Not checked: ${missing.map((c) => `${categoryLabel(c)} (${unavailable[c]})`).join(", ")}`
      : scoped.length === 0
        ? "No elements in scope"
        : undefined;
    return {
      ruleId: rule.id,
      status: scoped.length === 0 ? "n/a" : failed.length ? "fail" : "pass",
      inScope: scoped.length,
      failedCount: failed.length,
      failedIds: failed.slice(0, MAX_FAILED_IDS).map((el) => el.id),
      byType,
      fix: failed.length ? buildFix(rule, failed, notDefined ? "notDefined" : "empty") : null,
      ...(note ? { note } : {}),
    };
  });
}

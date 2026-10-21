import { paramNames, type CollectedElement } from "./engine.js";
import type { Rule } from "./ruleFormat.js";

/** Sends one command to the Revit add-in (production: withRevitConnection → client.sendCommand). */
export type Send = (command: string, params: unknown) => Promise<unknown>;

/** Category (OST_…) → parameter names the enabled rules read there, aliases included. */
export function planCollection(rules: Rule[]): Map<string, string[]> {
  const plan = new Map<string, Set<string>>();
  for (const rule of rules) {
    const names = [...rule.scope.where, ...rule.require].flatMap((c) => paramNames(c.param));
    for (const category of rule.scope.categories) {
      const set = plan.get(category) ?? new Set<string>();
      for (const n of names) set.add(n);
      plan.set(category, set);
    }
  }
  return new Map([...plan].map(([category, names]) => [category, [...names]]));
}

/** C# string literal: JSON escaping (\" \\ \n \uXXXX) is valid C#. */
const lit = (s: string) => JSON.stringify(s);

/**
 * Read-only snippet for send_code_to_revit: every host element of one category, with the instance ("i:") and
 * type ("t:") value of each requested parameter — null when the parameter does not exist.
 */
export function buildCollectScript(category: string, names: string[]): string {
  return `
var bic = (BuiltInCategory)Enum.Parse(typeof(BuiltInCategory), ${lit(category)});
var names = new string[] { ${names.map(lit).join(", ")} };
Func<Parameter, bool, object> read = (p, onType) =>
{
    if (p == null) return null;
    string v = p.StorageType == StorageType.String ? p.AsString() : p.AsValueString();
    bool has = p.HasValue && !string.IsNullOrEmpty(v);
    return new { defined = true, hasValue = has, value = has ? v : null, onType };
};
var list = new List<object>();
foreach (var el in new FilteredElementCollector(document).OfCategory(bic).WhereElementIsNotElementType())
{
    var typeId = el.GetTypeId();
    var typ = typeId != ElementId.InvalidElementId ? document.GetElement(typeId) : null;
    var lvl = el.LevelId != ElementId.InvalidElementId ? document.GetElement(el.LevelId) : null;
    var ps = new Dictionary<string, object>();
    foreach (var n in names)
    {
        ps["i:" + n] = read(el.LookupParameter(n), false);
        ps["t:" + n] = typ == null ? null : read(typ.LookupParameter(n), true);
    }
    // long.Parse(ToString()) instead of the ElementId "Value" property, which only exists from Revit 2024.
    list.Add(new { id = long.Parse(el.Id.ToString()), isType = false, typeId = typ == null ? (long?)null : long.Parse(typeId.ToString()), typeName = typ?.Name ?? "", level = lvl?.Name ?? "", @params = ps });
}
return list;
`.trim();
}

/** Unwrap send_code_to_revit's { success, result: "<json>", errorMessage }. */
function scriptResult(raw: unknown): unknown {
  const root = raw as { success?: boolean; result?: unknown; errorMessage?: string } | null;
  if (!root || root.success === false) throw new Error(root?.errorMessage || "Revit script failed");
  return typeof root.result === "string" ? JSON.parse(root.result) : root.result;
}

/** Revit did not answer (timeout, disconnect) — as opposed to a script that ran and failed. */
class TransportError extends Error {}

async function runScript(send: Send, code: string): Promise<unknown> {
  let raw: unknown;
  try {
    raw = await send("send_code_to_revit", { code, transactionMode: "none" });
  } catch (error) {
    throw new TransportError(error instanceof Error ? error.message : String(error));
  }
  return scriptResult(raw);
}

export async function readProjectIdentity(send: Send): Promise<{ name: string; path: string }> {
  const value = (await runScript(send, "return new { name = document.Title, path = document.PathName };")) as {
    name?: string;
    path?: string;
  } | null;
  // Never guess: a run filed under a made-up project would vanish from that model's dashboard.
  if (!value?.name) throw new Error("Couldn't read the open Revit document (is a model open and Revit idle?)");
  return { name: value.name, path: value.path ?? "" };
}

/** Linked-model element counts per category (statistics only). Failed categories are left out. */
export async function countLinked(send: Send, categories: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const category of categories) {
    try {
      const raw = (await send("query_model", {
        input: { searchScope: "AllViews", elementInclusionMode: "InstancesOnly", categories: [category], maxResults: 0, includeLinkedModels: true },
      })) as { results?: { elementRefs?: unknown[] }; elementRefs?: unknown[] } | null;
      const refs = (raw?.results?.elementRefs ?? raw?.elementRefs ?? []) as { linkInstanceId?: unknown }[];
      counts[category] = refs.filter((r) => r.linkInstanceId != null && r.linkInstanceId !== "").length;
    } catch {
      // statistics only — skip
    }
  }
  return counts;
}

export async function collect(
  send: Send,
  plan: Map<string, string[]>,
  onProgress?: (done: number, total: number) => void
): Promise<{ elements: CollectedElement[]; unavailable: Record<string, string>; aborted: boolean }> {
  const elements: CollectedElement[] = [];
  const unavailable: Record<string, string> = {};
  let done = 0;
  let stopped: string | null = null;
  for (const [category, names] of plan) {
    if (stopped) {
      // Revit stopped answering (e.g. a modal dialog): don't wait out a timeout per remaining category.
      unavailable[category] = stopped;
    } else {
      try {
        const rows = (await runScript(send, buildCollectScript(category, names))) as Omit<CollectedElement, "category">[];
        for (const row of rows ?? []) elements.push({ ...row, category });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        unavailable[category] = message;
        if (error instanceof TransportError) stopped = `Revit stopped answering: ${message}`;
      }
    }
    onProgress?.(++done, plan.size);
  }
  return { elements, unavailable, aborted: stopped != null };
}

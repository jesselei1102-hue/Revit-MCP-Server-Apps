import { XMLParser } from "fast-xml-parser";
import type { Condition, Rule } from "./ruleFormat.js";

export type ImportedRule = Rule & { supported: boolean; unsupportedReason?: string };

type Attrs = Record<string, string>;
type XmlNode = Attrs & { Heading?: XmlNode[]; Section?: XmlNode[]; Check?: XmlNode[]; Filter?: XmlNode[] };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  isArray: (name) => ["Heading", "Section", "Check", "Filter"].includes(name),
});

class Unsupported extends Error {}

/**
 * Convert one Model Checker <Check> into a per-element rule.
 * - FailNoElements: the filters describe compliant elements → Defined/HasValue filters become requirements.
 * - CountAndList / FailMatchingElements: the filters describe problem elements → HasNoValue / Defined=False are
 *   inverted into requirements.
 * Category / Is Element Type / Equal-style filters always narrow the scope.
 */
function convertCheck(check: XmlNode): Pick<Rule, "scope" | "require"> {
  const filters = check.Filter ?? [];
  const categories: string[] = [];
  const where: Condition[] = [];
  const positive: Condition[] = []; // requirement as written (compliant elements)
  const problem: Condition[] = []; // requirement after inverting a "problem" filter
  let elementKind: Rule["scope"]["elementKind"] = "any";

  for (const f of filters) {
    if ((f.Operator ?? "And") !== "And") throw new Unsupported(`uses the "${f.Operator}" operator`);
    const truthy = (f.Value ?? "").toLowerCase() === "true";
    const ci = (f.CaseInsensitive ?? "").toLowerCase() === "true";
    switch (f.Category) {
      case "Category":
        if (f.Condition !== "Included" || !truthy) throw new Unsupported(`category condition "${f.Condition}"`);
        categories.push(f.Property);
        break;
      case "TypeOrInstance":
        if (f.Property !== "Is Element Type" || f.Condition !== "Equal") {
          throw new Unsupported(`type/instance filter "${f.Property} ${f.Condition}"`);
        }
        elementKind = truthy ? "type" : "instance";
        break;
      case "Parameter": {
        const param = f.Property;
        const cond = (op: Condition["op"], value?: string): Condition =>
          value == null ? { param, op } : ci ? { param, op, value, caseInsensitive: true } : { param, op, value };
        switch (f.Condition) {
          case "Equal":
            where.push(cond("equals", f.Value));
            break;
          case "NotEqual":
            where.push(cond("notEquals", f.Value));
            break;
          case "Contains":
            where.push(cond("contains", f.Value));
            break;
          case "Defined":
            (truthy ? positive : problem).push(cond("defined"));
            break;
          case "HasValue":
            (truthy ? positive : problem).push(cond("hasValue"));
            break;
          case "HasNoValue":
            (truthy ? problem : positive).push(cond("hasValue"));
            break;
          default:
            throw new Unsupported(`parameter condition "${f.Condition}"`);
        }
        break;
      }
      default:
        throw new Unsupported(`filter category "${f.Category}"`);
    }
  }

  if (categories.length === 0) throw new Unsupported("no category filter");
  const result = check.ResultCondition;
  let require: Condition[];
  if (result === "FailNoElements") require = positive;
  else if (result === "CountAndList" || result === "FailMatchingElements") require = problem;
  else throw new Unsupported(`result condition "${result}"`);
  if (require.length === 0) throw new Unsupported(`no parameter requirement for "${result}"`);
  return { scope: { categories, elementKind, where }, require };
}

/** Parse an Autodesk Model Checker checkset (.xml) into rules; unsupported checks are kept, disabled. */
export function parseModelCheckerXml(
  xml: string,
  opts: { rulesetId: string; file?: string }
): { name: string; rules: ImportedRule[]; groups: string[] } {
  const doc = parser.parse(xml.replace(/^﻿/, "")) as Record<string, XmlNode>;
  const rootKey = Object.keys(doc).find((k) => !k.startsWith("?"));
  if (!rootKey) throw new Error("Not a Model Checker checkset: no root element");
  const root = doc[rootKey];
  const rules: ImportedRule[] = [];
  const groups: string[] = [];

  const visitSection = (section: XmlNode, path: string[]) => {
    const here = [...path, section.SectionName ?? "Untitled"];
    const group = here.join(" / ");
    if (section.Check?.length && !groups.includes(group)) groups.push(group);
    for (const check of section.Check ?? []) {
      const base = {
        id: check.ID,
        rulesetId: opts.rulesetId,
        group,
        name: check.CheckName || check.ID,
        description: check.Description || check.FailureMessage || undefined,
        severity: "warning" as const,
        source: opts.file ? { kind: "model-checker-xml" as const, file: opts.file } : { kind: "model-checker-xml" as const },
      };
      try {
        const converted = convertCheck(check);
        rules.push({ ...base, ...converted, enabled: check.IsChecked !== "False", supported: true });
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        rules.push({
          ...base,
          enabled: false,
          scope: { categories: [], elementKind: "any", where: [] },
          require: [],
          supported: false,
          unsupportedReason: `Not supported: ${error.message}`,
        });
      }
    }
    for (const child of section.Section ?? []) visitSection(child, here);
  };

  // Group paths include the heading: checksets such as IFC-SG repeat the same sections per Revit version.
  for (const heading of root.Heading ?? []) {
    const label = heading.HeadingText?.trim();
    for (const section of heading.Section ?? []) visitSection(section, label ? [label] : []);
  }
  for (const section of root.Section ?? []) visitSection(section, []);

  // The same check under a later heading (same section path below the heading + same name) is an alternate
  // copy, e.g. "Revit 2022 and Older" vs "Revit 2023 and 2024". Keep the first enabled; import copies disabled.
  if ((root.Heading ?? []).length > 1) {
    const firstSeen = new Map<string, string>();
    for (const rule of rules) {
      const [heading, ...rest] = rule.group.split(" / ");
      // Version copies rename the IFC class parameter ("IfcExportAs" ↔ "Export to IFC As"), even in names.
      const key = `${rest.join(" / ")}\u0000${rule.name}`.replaceAll("IfcExportAs", "Export to IFC As");
      const owner = firstSeen.get(key);
      if (owner == null) {
        firstSeen.set(key, heading);
      } else if (owner !== heading) {
        rule.enabled = false;
        rule.description = `Same check as in "${owner}" (alternate version). ${rule.description ?? ""}`.trim();
      }
    }
  }

  return { name: root.Name || rootKey, rules, groups };
}

import { describe, it, expect } from "vitest";
import { evalCondition, evaluate, resolveParam, type CollectedElement, type ParamValue } from "../../src/checks/engine";
import type { Condition, Rule } from "../../src/checks/ruleFormat";

const v = (value: string | null, onType = false): ParamValue => ({
  defined: true,
  hasValue: value != null && value !== "",
  value,
  onType,
});

let nextId = 1;
function el(params: Record<string, ParamValue>, over: Partial<CollectedElement> = {}): CollectedElement {
  return { id: nextId++, category: "OST_Doors", isType: false, typeId: 10, typeName: "D1", level: "L1", params, ...over };
}

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: "r",
    rulesetId: "s",
    group: "g",
    name: "Doors need Fire Rating",
    severity: "error",
    enabled: true,
    scope: { categories: ["OST_Doors"], elementKind: "instance", where: [] },
    require: [{ param: "Fire Rating", op: "hasValue" }],
    source: { kind: "manual" },
    ...over,
  };
}

const c = (op: Condition["op"], value?: string, extra: Partial<Condition> = {}): Condition => ({ param: "P", op, value, ...extra });

describe("resolveParam", () => {
  it("prefers an instance value, falls back to the type when the instance is empty", () => {
    expect(resolveParam(el({ "i:P": v("A"), "t:P": v("B", true) }), "P")).toMatchObject({ value: "A", onType: false });
    expect(resolveParam(el({ "i:P": v(""), "t:P": v("B", true) }), "P")).toMatchObject({ hasValue: true, value: "B", onType: true });
    expect(resolveParam(el({ "t:P": v(null, true) }), "P")).toMatchObject({ defined: true, hasValue: false });
    expect(resolveParam(el({ "i:P": null, "t:P": null }), "P")).toMatchObject({ defined: false, hasValue: false });
  });
  it("treats IfcExportAs and Export to IFC As as the same parameter", () => {
    expect(resolveParam(el({ "i:Export to IFC As": v("IfcDoor") }), "IfcExportAs").value).toBe("IfcDoor");
    expect(resolveParam(el({ "t:IfcExportAs": v("IfcWall", true) }), "Export to IFC As").value).toBe("IfcWall");
  });
});

describe("evalCondition", () => {
  const a = el({ "i:P": v("Fire 60") });
  const empty = el({ "i:P": v("") });
  const none = el({});
  const num = el({ "i:P": v("1200 mm") });
  it.each([
    ["defined", a, c("defined"), true],
    ["defined (missing)", none, c("defined"), false],
    ["notDefined", none, c("notDefined"), true],
    ["hasValue", a, c("hasValue"), true],
    ["hasValue (empty)", empty, c("hasValue"), false],
    ["isEmpty (empty)", empty, c("isEmpty"), true],
    ["isEmpty (missing)", none, c("isEmpty"), true],
    ["equals", a, c("equals", "Fire 60"), true],
    ["equals case", a, c("equals", "fire 60"), false],
    ["equals caseInsensitive", a, c("equals", "fire 60", { caseInsensitive: true }), true],
    ["notEquals", a, c("notEquals", "X"), true],
    ["contains", a, c("contains", "60"), true],
    ["matches", a, c("matches", "^Fire \\d+$"), true],
    ["matches (missing)", none, c("matches", ".*"), false],
    ["gt", num, c("gt", "1000"), true],
    ["lt", num, c("lt", "1000"), false],
    ["gt non-numeric", a, c("gt", "1"), false],
  ])("%s", (_label, element, cond, expected) => {
    expect(evalCondition(element, cond)).toBe(expected);
  });
});

describe("evaluate", () => {
  it("scopes by category, element kind and where-conditions", () => {
    const r = rule({ scope: { categories: ["OST_Doors"], elementKind: "instance", where: [{ param: "IfcExportAs", op: "equals", value: "IfcDoor" }] } });
    const inScope = el({ "i:Export to IFC As": v("IfcDoor"), "t:Fire Rating": v("60", true) });
    const wrongClass = el({ "i:Export to IFC As": v("IfcWall") });
    const wall = el({ "i:Export to IFC As": v("IfcDoor") }, { category: "OST_Walls" });
    const type = el({ "i:Export to IFC As": v("IfcDoor") }, { isType: true });
    const [res] = evaluate([r], [inScope, wrongClass, wall, type]);
    expect(res).toMatchObject({ status: "pass", inScope: 1, failedCount: 0 });
  });

  it("is n/a when nothing is in scope (e.g. the where-parameter does not exist)", () => {
    const r = rule({ scope: { categories: ["OST_Doors"], elementKind: "any", where: [{ param: "IfcExportAs", op: "equals", value: "IfcDoor" }] } });
    const [res] = evaluate([r], [el({}), el({})]);
    expect(res.status).toBe("n/a");
  });

  it("fails every in-scope element when the required parameter is missing from the model", () => {
    const [res] = evaluate([rule({ require: [{ param: "FireRating", op: "defined" }] })], [el({}), el({})]);
    expect(res).toMatchObject({ status: "fail", inScope: 2, failedCount: 2 });
    expect(res.fix).toMatch(/shared parameter/);
  });

  it("marks rules on unavailable categories n/a with the reason", () => {
    const [res] = evaluate([rule()], [], { OST_Doors: "Revit disconnected" });
    expect(res.status).toBe("n/a");
    expect(res.note).toMatch(/Revit disconnected/);
  });

  it("caps failedIds at 500 but counts every failure", () => {
    const many = Array.from({ length: 620 }, () => el({ "i:Fire Rating": v("") }));
    const [res] = evaluate([rule()], many);
    expect(res.failedCount).toBe(620);
    expect(res.failedIds).toHaveLength(500);
    expect(res.byType).toEqual({ D1: 620 });
  });

  it("suggests fixing on the type when most failures share one type", () => {
    const failures = [
      ...Array.from({ length: 7 }, () => el({ "i:Fire Rating": v("") }, { typeName: '36" x 84"' })),
      ...Array.from({ length: 3 }, () => el({ "i:Fire Rating": v("") }, { typeName: "Other" })),
    ];
    const [res] = evaluate([rule()], failures);
    expect(res.fix).toContain('36" x 84"');
    expect(res.fix).toContain("7");
  });

  it("suggests filling values in 01 Elements otherwise", () => {
    const failures = ["A", "B", "C"].map((t) => el({ "i:Fire Rating": v("") }, { typeName: t }));
    const [res] = evaluate([rule()], failures);
    expect(res.fix).toContain("01 Elements");
  });

  it("uses the rule's fix template when present", () => {
    const r = rule({ fix: "Set {param} on {count} {category} (mostly {type})" });
    const [res] = evaluate([r], [el({ "i:Fire Rating": v("") }), el({ "i:Fire Rating": v("") })]);
    expect(res.fix).toBe("Set Fire Rating on 2 Doors (mostly D1)");
  });
});

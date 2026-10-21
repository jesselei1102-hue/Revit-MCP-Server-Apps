import { describe, it, expect } from "vitest";
import { buildCollectScript, collect, countLinked, planCollection, readProjectIdentity, type Send } from "../../src/checks/collector";
import type { Rule } from "../../src/checks/ruleFormat";

const rule = (categories: string[], where: string[], require: string[]): Rule => ({
  id: Math.random().toString(36),
  rulesetId: "s",
  group: "g",
  name: "n",
  severity: "warning",
  enabled: true,
  scope: { categories, elementKind: "any", where: where.map((param) => ({ param, op: "equals", value: "x" })) },
  require: require.map((param) => ({ param, op: "hasValue" })),
  source: { kind: "manual" },
});

/** What send_code_to_revit returns: the snippet's return value serialized into `result`. */
const ok = (value: unknown) => ({ success: true, result: JSON.stringify(value), errorMessage: "" });

describe("planCollection", () => {
  it("merges parameters per category and adds aliases", () => {
    const plan = planCollection([
      rule(["OST_Doors"], ["IfcExportAs"], ["FireRating"]),
      rule(["OST_Doors", "OST_Walls"], [], ["Mark", "FireRating"]),
    ]);
    expect([...plan.keys()].sort()).toEqual(["OST_Doors", "OST_Walls"]);
    expect(plan.get("OST_Doors")!.sort()).toEqual(["Export to IFC As", "FireRating", "IfcExportAs", "Mark"]);
    expect(plan.get("OST_Walls")!.sort()).toEqual(["FireRating", "Mark"]);
  });
});

describe("buildCollectScript", () => {
  it("embeds names as escaped string literals", () => {
    const tricky = ['Say "hi"', "back\\slash", "防火等级"];
    const script = buildCollectScript("OST_Doors", tricky);
    for (const name of tricky) expect(script).toContain(JSON.stringify(name));
    expect(script).toContain(JSON.stringify("OST_Doors"));
    expect(script).not.toContain('"Say "hi""');
  });
  it("is read-only", () => {
    const script = buildCollectScript("OST_Doors", ["Mark"]);
    expect(script).not.toMatch(/Transaction|\.Delete\(|\.Set\(|\.Create/);
    expect(script).toMatch(/FilteredElementCollector/);
  });
});

describe("collect", () => {
  it("collects per category, records failures and reports progress", async () => {
    const calls: unknown[] = [];
    const send: Send = async (command, params) => {
      calls.push({ command, params });
      const code = (params as { code: string }).code;
      if (code.includes('"OST_Walls"')) throw new Error("Revit disconnected");
      return ok([{ id: 7, isType: false, typeId: 3, typeName: "D1", level: "L1", params: { "i:Mark": { defined: true, hasValue: true, value: "A", onType: false }, "t:Mark": null } }]);
    };
    const progress: [number, number][] = [];
    const plan = new Map([["OST_Doors", ["Mark"]], ["OST_Walls", ["Mark"]]]);
    const { elements, unavailable } = await collect(send, plan, (done, total) => progress.push([done, total]));
    expect(elements).toEqual([
      { id: 7, category: "OST_Doors", isType: false, typeId: 3, typeName: "D1", level: "L1", params: { "i:Mark": { defined: true, hasValue: true, value: "A", onType: false }, "t:Mark": null } },
    ]);
    expect(unavailable).toEqual({ OST_Walls: "Revit disconnected" });
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(calls.every((c) => (c as { params: { transactionMode: string } }).params.transactionMode === "none")).toBe(true);
  });

  it("treats an unsuccessful script result as an unavailable category", async () => {
    const send: Send = async () => ({ success: false, result: "", errorMessage: "CS0103: bad name" });
    const { unavailable } = await collect(send, new Map([["OST_Doors", ["Mark"]]]));
    expect(unavailable.OST_Doors).toMatch(/CS0103/);
  });
});

describe("project identity and linked counts", () => {
  it("reads the document title and path", async () => {
    const send: Send = async () => ok({ name: "Snowdon Towers", path: "C:/m.rvt" });
    expect(await readProjectIdentity(send)).toEqual({ name: "Snowdon Towers", path: "C:/m.rvt" });
  });
  it("counts linked references per category and tolerates failures", async () => {
    const send: Send = async (_c, params) => {
      const cat = (params as { input: { categories: string[] } }).input.categories[0];
      if (cat === "OST_Walls") throw new Error("boom");
      return { elementRefs: [{ elementId: 1, linkInstanceId: null }, { elementId: 2, linkInstanceId: 9 }, { elementId: 3, linkInstanceId: 9 }] };
    };
    expect(await countLinked(send, ["OST_Doors", "OST_Walls"])).toEqual({ OST_Doors: 2 });
  });
});

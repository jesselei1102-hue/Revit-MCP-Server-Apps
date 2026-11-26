import { describe, it, expect } from "vitest";
import { validateSpec } from "../../src/canvas/rps";

const valid = () => ({
  spec: "revit-result/1",
  question: "Check the clear height everywhere and show me only where it fails.",
  outcome: "Clear height is too low in 2 places, both on Level 2, under ducts.",
  verdict: "fail",
  scope: { model: "Harbour Lane Offices" },
  view: { kind: "axon", caption: "All levels, only failures", legend: [{ status: "fail", label: "Below the minimum clear height" }], callouts: ["cz-1", "cz-2"] },
  presentation: { layout: "model-focus", show: "failures-only", levels: "exploded", overlays: ["measure"], measure: { value: "clear", required: "required", unit: "m" }, why: "Whole-model screening with only a few failures." },
  subjects: [
    { id: "cz-1", label: "Corridor 2.10", status: "fail", values: { clear: 2.25, required: 2.4 }, geometry: { level: "L2", x0: 0, y0: 0, x1: 1, y1: 1, z0: 0, z1: 2.25 } },
    { id: "cz-2", label: "Kitchen 2.07", status: "fail", values: { clear: 2.32, required: 2.4 } },
  ],
  provenance: { ran_at: "25 Nov 2026, 10:20", rule: "Clear height at least 2.40 m.", source: "pyRevit run_query" },
  limits: [],
});

describe("RPS-1 validator (server side)", () => {
  it("accepts a well-formed whole-model clearance result", () => {
    expect(validateSpec(valid())).toEqual([]);
  });

  it("rejects ids and API names in the answer (A4)", () => {
    const s = { ...valid(), outcome: "Done: 812309 and 812312 flagged (OST_Doors) in the model." };
    expect(validateSpec(s).map((v) => v.rule)).toContain("A4");
  });

  it("enforces layout rules: failures-only needs a failure, walk-through needs 2–8 stops (G3, G4)", () => {
    const s = valid();
    s.subjects = s.subjects.map((x) => ({ ...x, status: "pass" }));
    s.presentation = { ...s.presentation, layout: "tour" };
    const rules = validateSpec(s).map((v) => v.rule);
    expect(rules).toContain("G3");
    expect(rules).toContain("G4");
  });

  it("requires the measured value on every item when the measure overlay is on (G5)", () => {
    const s = valid();
    delete (s.subjects[1] as any).values;
    expect(validateSpec(s).map((v) => v.rule)).toContain("G5");
  });

  it("requires a reason for the layout and a level for cut views (G6, G2)", () => {
    const s = valid();
    s.presentation = { layout: "model-and-list", show: "in-context", levels: "cut" } as any;
    const rules = validateSpec(s).map((v) => v.rule);
    expect(rules).toContain("G6");
    expect(rules).toContain("G2");
  });

  it("caps legend entries at five and rejects pie charts (B6, C3)", () => {
    const s: any = valid();
    s.view.legend = ["fail", "pass", "info", "cat1", "cat2", "attention"].map((st) => ({ status: st, label: "Some meaning" }));
    s.charts = [{ type: "pie", title: "Share", data: [{ label: "x", value: 1 }] }];
    const rules = validateSpec(s).map((v) => v.rule);
    expect(rules).toContain("B6");
    expect(rules).toContain("C3");
  });
});

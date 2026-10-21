import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createCheckStore, type RunSummary } from "../../src/checks/store";
import type { ImportedRule } from "../../src/checks/modelCheckerXml";
import type { RuleResult } from "../../src/checks/engine";
import type { Rule } from "../../src/checks/ruleFormat";

function imported(id: string, group: string, over: Partial<ImportedRule> = {}): ImportedRule {
  return {
    id,
    rulesetId: "ifc",
    group,
    name: `Check ${id}`,
    severity: "warning",
    enabled: true,
    scope: { categories: ["OST_Doors"], elementKind: "instance", where: [] },
    require: [{ param: "FireRating", op: "defined" }],
    source: { kind: "model-checker-xml" },
    supported: true,
    ...over,
  };
}

const summary = (pass: number, fail: number): RunSummary => ({
  rules: { pass, fail, na: 0 },
  bySeverity: { error: 0, warning: fail, info: 0 },
  byGroup: {},
  categories: {},
  parameters: [],
  elementsChecked: 10,
});

const result = (ruleId: string, failedIds: number[]): RuleResult => ({
  ruleId,
  status: failedIds.length ? "fail" : "pass",
  inScope: 5,
  failedCount: failedIds.length,
  failedIds,
  byType: failedIds.length ? { D1: failedIds.length } : {},
  fix: failedIds.length ? "Fix it" : null,
});

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, project_name TEXT NOT NULL, project_path TEXT,
    timestamp INTEGER NOT NULL, last_updated INTEGER NOT NULL)`);
});

describe("check store", () => {
  it("replaces a rule set imported again under the same name", () => {
    const store = createCheckStore(db);
    const set = { id: "ifc", name: "IFC-SG", sourceKind: "model-checker-xml" };
    store.importRuleset(set, [imported("a", "G1"), imported("b", "G2")]);
    const second = store.importRuleset(set, [imported("a", "G1"), imported("b", "G2"), imported("c", "G2", { supported: false, enabled: false, unsupportedReason: "Or" })]);
    expect(second).toEqual({ rules: 3, groups: 2, unsupported: 1 });
    const sets = store.listRulesets();
    expect(sets).toHaveLength(1);
    expect(sets[0].rules).toHaveLength(3);
    expect(sets[0].rules.find((r) => r.id === "c")).toMatchObject({ supported: false, unsupportedReason: "Or" });
  });

  it("enables and disables by group, rule set or ids, and only returns runnable rules", () => {
    const store = createCheckStore(db);
    store.importRuleset({ id: "ifc", name: "IFC-SG", sourceKind: "model-checker-xml" }, [
      imported("a", "G1"),
      imported("b", "G2"),
      imported("c", "G2", { supported: false, enabled: false }),
    ]);
    expect(store.enabledRules().map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(store.setEnabled({ group: "G2" }, false)).toBe(2);
    expect(store.enabledRules().map((r) => r.id)).toEqual(["a"]);
    store.setEnabled({ ids: ["c"] }, true);
    expect(store.enabledRules().map((r) => r.id)).toEqual(["a"]); // unsupported never runs
    store.setEnabled({ rulesetId: "ifc" }, false);
    expect(store.enabledRules()).toEqual([]);
  });

  it("creates My rules on first upsert and updates rules in place", () => {
    const store = createCheckStore(db);
    const mine: Rule = { ...imported("m1", "Doors"), rulesetId: "mine", source: { kind: "claude" } };
    expect(store.upsertRules([mine])).toBe(1);
    store.upsertRules([{ ...mine, name: "Renamed", severity: "error" }]);
    const set = store.listRulesets().find((s) => s.id === "mine")!;
    expect(set.name).toBe("My rules");
    expect(set.rules).toHaveLength(1);
    expect(set.rules[0]).toMatchObject({ name: "Renamed", severity: "error", supported: true });
  });

  it("finds or creates a project by name and path", () => {
    const store = createCheckStore(db);
    const a = store.findOrCreateProject("Snowdon", "C:/a.rvt");
    expect(store.findOrCreateProject("Snowdon", "C:/a.rvt")).toBe(a);
    expect(store.findOrCreateProject("Snowdon", "C:/b.rvt")).not.toBe(a);
  });

  it("keeps details for the last 10 runs, a trend for all, and round-trips failed ids", () => {
    const store = createCheckStore(db);
    const project = store.findOrCreateProject("P", "p.rvt");
    const runIds: number[] = [];
    for (let i = 0; i < 12; i++) {
      const runId = store.startRun(project);
      store.updateProgress(runId, { stage: "collecting", done: 1, total: 2 });
      store.finishRun(runId, [result("a", [i + 1, i + 2])], summary(i, 12 - i), "done");
      runIds.push(runId);
    }
    expect(store.getRun(runIds[0])!.results).toEqual([]);
    expect(store.getRun(runIds[1])!.results).toEqual([]);
    expect(store.getRun(runIds[2])!.results).toHaveLength(1);
    const latest = store.getRun(undefined, project)!;
    expect(latest.id).toBe(runIds[11]);
    expect(latest.status).toBe("done");
    expect(latest.results[0].failedIds).toEqual([12, 13]);
    expect(latest.summary!.rules).toEqual({ pass: 11, fail: 1, na: 0 });
    const trend = store.getTrend(project);
    expect(trend).toHaveLength(10);
    expect(trend[trend.length - 1].runId).toBe(runIds[11]);
    expect(trend[trend.length - 1].passedPct).toBe(92);
  });

  it("exposes progress while a run is in flight", () => {
    const store = createCheckStore(db);
    const runId = store.startRun(store.findOrCreateProject("P", "p.rvt"));
    store.updateProgress(runId, { stage: "collecting", done: 3, total: 40 });
    const run = store.getRun(runId)!;
    expect(run.status).toBe("running");
    expect(run.summary?.progress).toEqual({ stage: "collecting", done: 3, total: 40 });
  });
});

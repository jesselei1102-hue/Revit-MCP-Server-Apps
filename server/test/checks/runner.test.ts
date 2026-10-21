import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createCheckStore } from "../../src/checks/store";
import { runChecks } from "../../src/checks/runner";
import type { Send } from "../../src/checks/collector";
import type { Rule } from "../../src/checks/ruleFormat";

const ok = (value: unknown) => ({ success: true, result: JSON.stringify(value), errorMessage: "" });
const pv = (value: string | null) => ({ defined: true, hasValue: value != null && value !== "", value, onType: false });

function setup() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, project_name TEXT NOT NULL, project_path TEXT,
    timestamp INTEGER NOT NULL, last_updated INTEGER NOT NULL)`);
  const store = createCheckStore(db);
  const rules: Rule[] = [
    { id: "doors-fr", rulesetId: "mine", group: "Doors", name: "Doors need Fire Rating", severity: "error", enabled: true,
      scope: { categories: ["OST_Doors"], elementKind: "instance", where: [] }, require: [{ param: "Fire Rating", op: "hasValue" }], source: { kind: "claude" } },
    { id: "walls-mark", rulesetId: "mine", group: "Walls", name: "Walls need Mark", severity: "warning", enabled: true,
      scope: { categories: ["OST_Walls"], elementKind: "instance", where: [] }, require: [{ param: "Mark", op: "hasValue" }], source: { kind: "claude" } },
  ];
  store.upsertRules(rules);
  return { store };
}

function sendWith(opts: { failCategories?: string[] } = {}): Send {
  return async (command, params) => {
    if (command === "query_model") return { elementRefs: [{ elementId: 1, linkInstanceId: 5 }] };
    const code = (params as { code: string }).code;
    if (code.includes("document.Title")) return ok({ name: "Model", path: "C:/m.rvt" });
    for (const c of opts.failCategories ?? []) if (code.includes(`"${c}"`)) throw new Error(`${c} failed`);
    if (code.includes('"OST_Doors"')) {
      return ok([
        { id: 1, isType: false, typeId: 9, typeName: "D1", level: "L1", params: { "i:Fire Rating": pv("60"), "t:Fire Rating": null } },
        { id: 2, isType: false, typeId: 9, typeName: "D1", level: "L1", params: { "i:Fire Rating": pv(""), "t:Fire Rating": null } },
      ]);
    }
    return ok([{ id: 3, isType: false, typeId: 8, typeName: "W1", level: "L1", params: { "i:Mark": pv("W-1"), "t:Mark": null } }]);
  };
}

describe("runChecks", () => {
  it("runs, stores results and summarises the model", async () => {
    const { store } = setup();
    const { runId, done } = await runChecks({ store, send: sendWith() }, {});
    await done;
    const run = store.getRun(runId)!;
    expect(run.status).toBe("done");
    expect(run.results.find((r) => r.ruleId === "doors-fr")).toMatchObject({ status: "fail", failedCount: 1, failedIds: [2] });
    expect(run.results.find((r) => r.ruleId === "walls-mark")).toMatchObject({ status: "pass" });
    const s = run.summary!;
    expect(s.rules).toEqual({ pass: 1, fail: 1, na: 0 });
    expect(s.bySeverity).toEqual({ error: 1, warning: 0, info: 0 });
    expect(s.byGroup).toEqual({ Doors: { rules: 1, failing: 1 }, Walls: { rules: 1, failing: 0 } });
    expect(s.categories.OST_Doors).toEqual({ host: 2, linked: 1, compliantPct: 50 });
    expect(s.parameters).toContainEqual({ name: "Fire Rating", where: ["Doors"], fillPct: 50 });
    expect(s.elementsChecked).toBe(3);
  });

  it("finishes as done with n/a rules when one category fails", async () => {
    const { store } = setup();
    const { runId, done } = await runChecks({ store, send: sendWith({ failCategories: ["OST_Walls"] }) }, {});
    await done;
    const run = store.getRun(runId)!;
    expect(run.status).toBe("done");
    expect(run.results.find((r) => r.ruleId === "walls-mark")).toMatchObject({ status: "n/a" });
    expect(run.results.find((r) => r.ruleId === "walls-mark")!.note).toMatch(/OST_Walls failed/);
  });

  it("fails the run when every category fails", async () => {
    const { store } = setup();
    const { runId, done } = await runChecks({ store, send: sendWith({ failCategories: ["OST_Walls", "OST_Doors"] }) }, {});
    await done;
    const run = store.getRun(runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/failed/);
  });
});

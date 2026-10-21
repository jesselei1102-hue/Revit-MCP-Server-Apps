import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCheckStore } from "../../src/checks/store";
import { registerCheckTools } from "../../src/checks/tools";
import type { Send } from "../../src/checks/collector";

const ok = (value: unknown) => ({ success: true, result: JSON.stringify(value), errorMessage: "" });
const mini = readFileSync(new URL("./fixtures/mini-checkset.xml", import.meta.url), "utf8");

const send: Send = async (command, params) => {
  if (command === "query_model") return { elementRefs: [] };
  const code = (params as { code: string }).code;
  if (code.includes("document.Title")) return ok({ name: "Model", path: "C:/m.rvt" });
  return ok(
    Array.from({ length: 300 }, (_, i) => ({
      id: i + 1, isType: false, typeId: 1, typeName: `Type ${i % 7}`, level: "L1",
      params: { "i:Mark": { defined: true, hasValue: false, value: null, onType: false }, "t:Mark": null },
    }))
  );
};

let client: Client;
beforeEach(async () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, project_name TEXT NOT NULL, project_path TEXT,
    timestamp INTEGER NOT NULL, last_updated INTEGER NOT NULL)`);
  const server = new McpServer({ name: "test", version: "0" });
  await registerCheckTools(server, { store: createCheckStore(db), send });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<{ content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean }>;

const goodRule = {
  name: "Doors need Mark",
  group: "Doors",
  severity: "warning",
  scope: { categories: ["OST_Doors"], elementKind: "instance" },
  require: [{ param: "Mark", op: "hasValue" }],
};

describe("check tools", () => {
  it("registers six tools without UI metadata", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["checks_get_results", "checks_run", "rules_import_checkset", "rules_list", "rules_set_enabled", "rules_upsert"]
    );
    expect(tools.every((t) => !(t._meta as any)?.ui)).toBe(true);
  });

  it("rejects the whole batch when any rule is invalid", async () => {
    const res = await call("rules_upsert", { rules: [goodRule, { ...goodRule, require: [{ param: "Mark", op: "between" }] }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/rules\[1\]/);
    const list = await call("rules_list", {});
    expect(list.structuredContent.rulesets).toEqual([]);
  });

  it("defaults Claude-made rules into My rules", async () => {
    const res = await call("rules_upsert", { rules: [goodRule] });
    expect(res.isError).toBeFalsy();
    const list = await call("rules_list", {});
    expect(list.structuredContent.rulesets[0]).toMatchObject({ id: "mine", name: "My rules" });
  });

  it("needs exactly one of path or xml to import", async () => {
    expect((await call("rules_import_checkset", { path: "a.xml", xml: mini })).isError).toBe(true);
    expect((await call("rules_import_checkset", {})).isError).toBe(true);
    const res = await call("rules_import_checkset", { xml: mini });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ rules: 3, unsupported: 1 });
  });

  it("keeps rule sets with non-Latin names apart and toggles them independently", async () => {
    await call("rules_import_checkset", { xml: mini, name: "防火检查" });
    await call("rules_import_checkset", { xml: mini, name: "节能检查" });
    const full = (await call("rules_list", { detail: "full" })).structuredContent.rulesets;
    expect(full.map((s: any) => s.name).sort()).toEqual(["节能检查", "防火检查"]);
    expect(full.map((s: any) => s.id).sort()).toEqual([expect.stringMatching(/^节能检查-[0-9a-f]{6}$/), expect.stringMatching(/^防火检查-[0-9a-f]{6}$/)]);
    const [a, b] = full;
    const ruleA = a.rules.find((r: any) => r.supported && r.enabled);
    await call("rules_set_enabled", { ids: [ruleA.id], enabled: false });
    const after = (await call("rules_list", { detail: "full" })).structuredContent.rulesets;
    expect(after.find((s: any) => s.id === a.id).rules.find((r: any) => r.name === ruleA.name).enabled).toBe(false);
    expect(after.find((s: any) => s.id === b.id).rules.find((r: any) => r.name === ruleA.name).enabled).toBe(true);
  });

  it("survives a storage failure while a background run finishes", async () => {
    const db2 = new Database(":memory:");
    db2.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, project_name TEXT NOT NULL, project_path TEXT,
      timestamp INTEGER NOT NULL, last_updated INTEGER NOT NULL)`);
    const real = createCheckStore(db2);
    real.upsertRules([{ id: "r", rulesetId: "mine", group: "Doors", name: "n", severity: "warning", enabled: true,
      scope: { categories: ["OST_Doors"], elementKind: "any", where: [] }, require: [{ param: "Mark", op: "hasValue" }], source: { kind: "claude" } }]);
    const broken = { ...real, finishRun: () => { throw new Error("disk full"); } };
    const server = new McpServer({ name: "t", version: "0" });
    await registerCheckTools(server, { store: broken as any, send });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(x), c2.connect(y)]);
    const res = (await c2.callTool({ name: "checks_run", arguments: { wait: false } })) as any;
    expect(res.isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 50));
    const again = (await c2.callTool({ name: "checks_run", arguments: { wait: false } })) as any;
    expect(again.content[0].text).not.toMatch(/already in progress/);
  });

  it("needs a target to enable or disable", async () => {
    expect((await call("rules_set_enabled", { enabled: false })).isError).toBe(true);
  });

  it("keeps structured results small for the model unless the app asks for detail", async () => {
    await call("rules_import_checkset", { xml: mini });
    await call("rules_upsert", { rules: Array.from({ length: 60 }, (_, i) => ({ ...goodRule, name: `Doors need Mark ${i}` })) });
    const run = await call("checks_run", {});
    expect(run.structuredContent.results).toBeUndefined();
    expect(JSON.stringify(run.structuredContent).length).toBeLessThan(20000);

    const brief = await call("checks_get_results", {});
    expect(brief.structuredContent.results).toBeUndefined();
    expect(brief.structuredContent.fixes.length).toBeLessThanOrEqual(10);
    expect(brief.structuredContent.fixes[0].byType).toBeUndefined();
    expect(JSON.stringify(brief.structuredContent).length).toBeLessThan(20000);
    const full = await call("checks_get_results", { detail: "full" });
    expect(full.structuredContent.results.length).toBe(62); // 60 mine + 2 runnable mini checks

    const listBrief = await call("rules_list", {});
    const mine = listBrief.structuredContent.rulesets.find((s: any) => s.id === "mine");
    expect(mine).toMatchObject({ rules: 60, enabledRules: 60 });
    expect(mine.groups).toEqual([{ group: "Doors", rules: 60, enabled: 60 }]);
    const listFull = await call("rules_list", { detail: "full" });
    expect(listFull.structuredContent.rulesets.find((s: any) => s.id === "mine").rules).toHaveLength(60);
  });

  it("runs checks and keeps the model-facing summary short", async () => {
    await call("rules_upsert", { rules: Array.from({ length: 40 }, (_, i) => ({ ...goodRule, name: `Doors need Mark ${i} ${"x".repeat(80)}` })) });
    const run = await call("checks_run", {});
    expect(run.isError).toBeFalsy();
    const res = await call("checks_get_results", {});
    expect(res.structuredContent.run.status).toBe("done");
    expect(res.structuredContent.fixes.length).toBeGreaterThan(0);
    expect(res.content[0].text.length).toBeLessThanOrEqual(4000);
    expect(run.content[0].text.length).toBeLessThanOrEqual(4000);
  });
});

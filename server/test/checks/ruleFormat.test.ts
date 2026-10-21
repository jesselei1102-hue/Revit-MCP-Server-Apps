import { describe, it, expect } from "vitest";
import { validateRules } from "../../src/checks/ruleFormat";

const validRule = {
  id: "r1",
  rulesetId: "mine",
  group: "Doors",
  name: "Doors must have Fire Rating",
  severity: "error",
  enabled: true,
  scope: { categories: ["OST_Doors"], elementKind: "instance", where: [] },
  require: [{ param: "Fire Rating", op: "hasValue" }],
  source: { kind: "claude" },
};

describe("validateRules", () => {
  it("accepts a valid rule", () => {
    const { ok, errors } = validateRules([validRule]);
    expect(errors).toEqual([]);
    expect(ok).toHaveLength(1);
    expect(ok[0].name).toBe("Doors must have Fire Rating");
  });

  it.each([
    ["missing require", { ...validRule, require: undefined }],
    ["empty require", { ...validRule, require: [] }],
    ["unknown operator", { ...validRule, require: [{ param: "Mark", op: "between", value: "1" }] }],
    ["invalid regex", { ...validRule, require: [{ param: "Mark", op: "matches", value: "(" }] }],
    ["non-numeric gt", { ...validRule, require: [{ param: "Width", op: "gt", value: "abc" }] }],
    ["equals without value", { ...validRule, require: [{ param: "Mark", op: "equals" }] }],
    ["category without OST_", { ...validRule, scope: { ...validRule.scope, categories: ["Doors"] } }],
    ["empty categories", { ...validRule, scope: { ...validRule.scope, categories: [] } }],
    ["bad severity", { ...validRule, severity: "fatal" }],
  ])("rejects %s with its index", (_label, bad) => {
    const { ok, errors } = validateRules([validRule, bad]);
    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(1);
    expect(errors[0].message.length).toBeGreaterThan(0);
  });

  it("generates a UUID when id is missing", () => {
    const { id: _omit, ...noId } = validRule;
    const { ok } = validateRules([noId]);
    expect(ok[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("defaults enabled to true and where to []", () => {
    const { enabled: _e, ...rest } = validRule;
    const { ok } = validateRules([{ ...rest, scope: { categories: ["OST_Doors"], elementKind: "any" } }]);
    expect(ok[0].enabled).toBe(true);
    expect(ok[0].scope.where).toEqual([]);
  });
});

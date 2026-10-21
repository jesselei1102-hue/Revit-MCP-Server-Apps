import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseModelCheckerXml } from "../../src/checks/modelCheckerXml";

const mini = readFileSync(new URL("./fixtures/mini-checkset.xml", import.meta.url), "utf8");
const FULL = "C:/Users/Datech/Desktop/Cursor Projects/Model Checker Checkset/IFC-SG_ModelValidationChecks_v1.0.xml";

describe("parseModelCheckerXml", () => {
  const parsed = parseModelCheckerXml(mini, { rulesetId: "mini", file: "mini-checkset.xml" });

  it("reads the checkset name and keeps document order", () => {
    expect(parsed.name).toBe('Mini "IFC" checks');
    expect(parsed.rules.map((r) => r.id)).toEqual(["mini:c1", "mini:c3", "mini:c2"]);
  });

  it("maps FailNoElements + Defined to a per-element required parameter", () => {
    const r = parsed.rules.find((x) => x.id === "mini:c1")!;
    expect(r.supported).toBe(true);
    expect(r.enabled).toBe(true);
    expect(r.group).toBe("IFC-SG / Architecture (ARC) / Doors");
    expect(r.name).toBe("FireRating");
    expect(r.severity).toBe("warning");
    expect(r.scope).toEqual({
      categories: ["OST_Doors"],
      elementKind: "instance",
      where: [{ param: "IfcExportAs", op: "equals", value: "IfcDoor" }],
    });
    expect(r.require).toEqual([{ param: "FireRating", op: "defined" }]);
    expect(r.source).toEqual({ kind: "model-checker-xml", file: "mini-checkset.xml" });
    expect(r.rulesetId).toBe("mini");
  });

  it("maps CountAndList + HasNoValue to a hasValue requirement", () => {
    const r = parsed.rules.find((x) => x.id === "mini:c2")!;
    expect(r.supported).toBe(true);
    expect(r.group).toBe("IFC-SG / Architecture (ARC) / Export to IFC As");
    expect(r.scope).toEqual({ categories: ["OST_Doors"], elementKind: "any", where: [] });
    expect(r.require).toEqual([{ param: "Export to IFC As", op: "hasValue" }]);
  });

  it("imports unsupported shapes disabled, with a reason", () => {
    const r = parsed.rules.find((x) => x.id === "mini:c3")!;
    expect(r.supported).toBe(false);
    expect(r.enabled).toBe(false);
    expect(r.unsupportedReason).toMatch(/Or/);
  });

  it("lists groups that contain checks", () => {
    expect(parsed.groups).toEqual(["IFC-SG / Architecture (ARC) / Doors", "IFC-SG / Architecture (ARC) / Export to IFC As"]);
  });

  it.skipIf(!existsSync(FULL))("converts the full IFC-SG checkset", () => {
    const full = parseModelCheckerXml(readFileSync(FULL, "utf8"), { rulesetId: "ifc-sg" });
    expect(full.name).toBe("IFC-SG Schema Model Validation Checks");
    expect(full.rules).toHaveLength(586);
    expect(full.rules.filter((r) => !r.supported).map((r) => `${r.name}: ${r.unsupportedReason}`)).toEqual([]);
    expect(full.groups).toHaveLength(84);
    expect(full.rules.filter((r) => r.require[0]?.op === "hasValue")).toHaveLength(54);
    // The file carries the same 293 checks twice (Revit 2023+ vs 2022 and older); only the first copy is enabled.
    const enabled = full.rules.filter((r) => r.enabled);
    expect(enabled).toHaveLength(293);
    expect(enabled.every((r) => r.group.startsWith("Revit 2023 and 2024 / "))).toBe(true);
    const dup = full.rules.find((r) => !r.enabled && r.group.startsWith("Revit 2022 and Older / "))!;
    expect(dup.supported).toBe(true);
    expect(dup.description).toMatch(/Revit 2023 and 2024/);
  });
});

describe("duplicate checks across headings", () => {
  it("keeps the first heading enabled and imports later copies disabled", () => {
    const twice = mini.replace(
      "</MCSettings>",
      mini.slice(mini.indexOf("<Heading"), mini.lastIndexOf("</Heading>") + "</Heading>".length)
        .replace('HeadingText="IFC-SG"', 'HeadingText="Older"')
        .replace(/ID="c(\d)"/g, 'ID="old-c$1"') + "\n</MCSettings>"
    );
    const parsed = parseModelCheckerXml(twice, { rulesetId: "dup" });
    const old = parsed.rules.find((r) => r.id === "dup:old-c1")!;
    expect(old.group).toBe("Older / Architecture (ARC) / Doors");
    expect(old.supported).toBe(true);
    expect(old.enabled).toBe(false);
    expect(old.description).toMatch(/IFC-SG/);
    expect(parsed.rules.find((r) => r.id === "dup:c1")!.enabled).toBe(true);
  });
});

describe("type-level checks", () => {
  it("imports checks on element types as unsupported", () => {
    const typed = mini.replace('Property="Is Element Type" Condition="Equal" Value="False"', 'Property="Is Element Type" Condition="Equal" Value="True"');
    const r = parseModelCheckerXml(typed, { rulesetId: "t" }).rules.find((x) => x.id === "t:c1")!;
    expect(r.supported).toBe(false);
    expect(r.unsupportedReason).toMatch(/type/i);
  });
});

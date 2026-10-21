import { describe, it, expect } from "vitest";
import { summarizeSchedule } from "../src/scheduleSummary";

const row = (category: string, link = "(host)") => ({ elementId: "1", link, name: "", category, family: "", type: "", level: "L1" });

describe("summarizeSchedule", () => {
  const data = {
    columns: ["elementId", "link", "name", "category", "family", "type", "level"],
    rows: [
      ...Array.from({ length: 3 }, () => row("Walls")),
      row("Doors"),
      row("Walls", "Structure.rvt"),
    ],
    matchedCount: 5,
    totalMatched: 5,
    truncated: false,
    linkedMatchedCount: 1,
    loadedLinkCount: 1,
    unloadedLinkCount: 0,
    dashboard: { errorCount: 12, warningCount: 12, detachableFamilyCount: 3 },
    message: null,
  };

  it("counts elements per category, largest first, and drops the rows", () => {
    const { structured } = summarizeSchedule(data);
    expect(structured.detail).toBe("summary");
    expect(structured.byCategory).toEqual({ Walls: 4, Doors: 1 });
    expect(Object.keys(structured.byCategory)).toEqual(["Walls", "Doors"]);
    expect(structured).not.toHaveProperty("rows");
    expect(structured).toMatchObject({ matchedCount: 5, linkedMatchedCount: 1, dashboard: { warningCount: 12 } });
  });

  it("writes a short sentence for the model", () => {
    const { text } = summarizeSchedule(data);
    expect(text).toContain("5 elements (4 host, 1 linked)");
    expect(text).toContain("Walls 4, Doors 1");
    expect(text).toContain("12 warnings, 3 unused families");
  });

  it("stays small for a large model", () => {
    const big = { ...data, rows: Array.from({ length: 20000 }, (_, i) => row(`Category ${i % 40}`)), matchedCount: 20000, totalMatched: 20000 };
    const { structured, text } = summarizeSchedule(big);
    expect(JSON.stringify(structured).length).toBeLessThan(4000);
    expect(text.length).toBeLessThan(4000);
  });
});

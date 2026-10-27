import { describe, it, expect } from "vitest";
import { failingCount, fixesHeading, modelLine, pctText, plural, rulesOnLabel } from "../../mcp-app/src/format";

describe("plural", () => {
  it("adds s, or uses the given plural", () => {
    expect(plural(1, "rule")).toBe("1 rule");
    expect(plural(2, "rule")).toBe("2 rules");
    expect(plural(2, "family", "families")).toBe("2 families");
  });
});

describe("pctText", () => {
  it("has no zero padding and a dash when unknown", () => {
    expect(pctText(0)).toBe("0%");
    expect(pctText(100)).toBe("100%");
    expect(pctText(null)).toBe("—");
  });
});

describe("modelLine", () => {
  it("names warnings and detachable families", () => {
    expect(modelLine({ warningCount: 103, detachableFamilyCount: 40 })).toBe("Model · 103 warnings · 40 detachable families");
    expect(modelLine({ errorCount: 1, detachableFamilyCount: 1 })).toBe("Model · 1 warning · 1 detachable family");
  });
  it("uses a dash for what is not known", () => {
    expect(modelLine(null)).toBe("Model · —");
    expect(modelLine({ detachableFamilyCount: 40 })).toBe("Model · — warnings · 40 detachable families");
  });
});

describe("fixesHeading", () => {
  it("carries the severity counts; info only when there is some", () => {
    expect(fixesHeading({ error: 1, warning: 0, info: 0 })).toBe("Fixes · 1 error · 0 warnings");
    expect(fixesHeading({ error: 0, warning: 3, info: 2 })).toBe("Fixes · 0 errors · 3 warnings · 2 info");
  });
  it("is just Fixes when there is nothing to count", () => {
    expect(fixesHeading({ error: 0, warning: 0, info: 0 })).toBe("Fixes");
    expect(fixesHeading(null)).toBe("Fixes");
  });
});

describe("rulesOnLabel", () => {
  it("says how many rules are on and when they last ran", () => {
    expect(rulesOnLabel(1, "21:04")).toBe("1 rule on · last run 21:04");
    expect(rulesOnLabel(2, null)).toBe("2 rules on · not run yet");
  });
});

describe("failingCount", () => {
  it("is the failing rule count, empty when none", () => {
    expect(failingCount({ rules: { fail: 1 } })).toBe("1");
    expect(failingCount({ rules: { fail: 0 } })).toBe("");
    expect(failingCount(null)).toBe("");
  });
});

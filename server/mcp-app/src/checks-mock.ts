// SAMPLE DATA for the 03 Checks / 04 Dashboard mockup.
// Phase 2 replaces this module with the rules_* / checks_* tools (see the checks design spec).
// Element counts on the dashboard are real (from the loaded schedule); everything here is illustrative.

export type Severity = "error" | "warning" | "info";

export type MockRule = { id: string; name: string; severity: Severity; enabled: boolean; failing: number };
export type MockGroup = { name: string; rules: number; failing: number; enabled: boolean };
export type MockRuleset = {
  id: string;
  name: string;
  source: "xml" | "claude";
  rules: number;
  enabled: boolean;
  groups: MockGroup[];
  hiddenGroups: number;
  items: MockRule[];
};

export function createMockRulesets(): MockRuleset[] {
  return [
    {
      id: "ifc-sg",
      name: "IFC-SG Model Validation v1.0",
      source: "xml",
      rules: 586,
      enabled: true,
      groups: [
        { name: "Doors", rules: 14, failing: 3, enabled: true },
        { name: "Walls", rules: 18, failing: 2, enabled: true },
        { name: "Windows", rules: 11, failing: 0, enabled: true },
        { name: "Areas", rules: 33, failing: 5, enabled: true },
        { name: "Generic Models", rules: 6, failing: 1, enabled: true },
        { name: "Planting", rules: 6, failing: 0, enabled: false },
      ],
      hiddenGroups: 87,
      items: [],
    },
    {
      id: "mine",
      name: "My rules",
      source: "claude",
      rules: 4,
      enabled: true,
      groups: [],
      hiddenGroups: 0,
      items: [
        { id: "r1", name: "Doors must have Fire Rating", severity: "error", enabled: true, failing: 55 },
        { id: "r2", name: 'Wall types start with "BD_"', severity: "warning", enabled: true, failing: 0 },
        { id: "r3", name: "Every room needs a Department", severity: "warning", enabled: true, failing: 12 },
        { id: "r4", name: "Mark is unique per category", severity: "info", enabled: false, failing: 0 },
      ],
    },
  ];
}

export const MOCK_RESULTS = {
  lastRun: "14:42",
  passingPct: 72,
  deltaPct: 6,
  /** Rules passing (%) over the last runs, oldest first. */
  trend: [58, 60, 59, 64, 63, 67, 68, 72],
  errors: 41,
  warnings: 163,
  noIfcClass: 212,
  /** Share of in-scope elements passing all rules, by category. */
  compliance: {
    Walls: 91,
    Doors: 84,
    Windows: 96,
    Floors: 88,
    "Curtain Panels": 52,
    "Curtain Wall Mullions": 70,
    "Structural Framing": 93,
    "Generic Models": 61,
    Furniture: 99,
    Casework: 97,
    Columns: 90,
    "Lighting Fixtures": 74,
    Pipes: 81,
    Ducts: 79,
  } as Record<string, number>,
  parameters: [
    { name: "FireRating", where: "Doors, Walls", fill: 63 },
    { name: "IsExternal", where: "9 categories", fill: 78 },
    { name: "Export to IFC As", where: "all categories", fill: 96 },
    { name: "Department", where: "Rooms", fill: 82 },
    { name: "LoadBearing", where: "Walls, Columns", fill: 88 },
  ],
  fixes: [
    {
      severity: "error" as Severity,
      title: "55 doors miss FireRating",
      scope: "IFC-SG / Doors",
      detail: '49 share type 36" x 84" (180 MIN) — add the value on the type. The other 6: fill in 01 Elements (filter Doors).',
    },
    {
      severity: "warning" as Severity,
      title: "212 elements have no IFC class",
      scope: "Export to IFC As",
      detail: "Mostly Generic Models (140) and Specialty Equipment (51). Set Export to IFC As on their types.",
    },
    {
      severity: "warning" as Severity,
      title: "12 rooms have no Department",
      scope: "My rules",
      detail: "All on L2 and L3. Fill Department in 01 Elements (filter Rooms, level L2/L3).",
    },
    {
      severity: "info" as Severity,
      title: "IsExternal missing on 340 curtain panels",
      scope: "IFC-SG / Curtain Panels",
      detail: "The parameter isn't defined on the panel family — add the shared parameter to the family or as a project parameter.",
    },
  ],
};

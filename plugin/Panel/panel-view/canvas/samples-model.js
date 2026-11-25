/* Model-first additions to the shared samples (synthetic, labelled "Sample data"):
 * - ducts, pipes, beams and a stair bulkhead that lower clear height in places;
 * - a whole-model height-clearance result;
 * - a `presentation` block on every result: the layout and viewing mode the agent chose for
 *   that prompt (RPS-1 section G). The canvas renders whatever the agent chose.
 */
(function () {
  "use strict";
  const S = window.CANVAS_SAMPLES;
  const { BUILDING, SAMPLES } = S;
  const lv = id => BUILDING.levels.find(l => l.id === id);

  // Obstructions, in plan metres; z is height above that level's floor.
  const OBS = [
    { id: "duct-L1-1", level: "L1", kind: "duct", name: "Supply duct", x0: 6, y0: 11.3, x1: 16.6, y1: 12.7, z0: 2.48, z1: 2.98, revit_id: 913101 },
    { id: "beam-L1-1", level: "L1", kind: "beam", name: "Transfer beam", x0: 2, y0: 18, x1: 14, y1: 18.6, z0: 2.6, z1: 3.0, revit_id: 913102 },
    { id: "duct-L2-1", level: "L2", kind: "duct", name: "Supply duct", x0: 23.4, y0: 11.2, x1: 34.6, y1: 12.8, z0: 2.25, z1: 2.85, revit_id: 913201 },
    { id: "pipe-L2-1", level: "L2", kind: "pipe", name: "Drainage pipe rack", x0: 25, y0: 4, x1: 31, y1: 5, z0: 2.32, z1: 2.6, revit_id: 913202 },
    { id: "beam-L3-1", level: "L3", kind: "beam", name: "Downstand beam", x0: 32.2, y0: 6, x1: 39.8, y1: 6.6, z0: 2.3, z1: 3.0, revit_id: 913301 },
    { id: "duct-L3-1", level: "L3", kind: "duct", name: "Extract duct", x0: 6, y0: 11, x1: 16.6, y1: 13, z0: 2.35, z1: 2.9, revit_id: 913302 },
    { id: "bulk-L3-1", level: "L3", kind: "bulkhead", name: "Bulkhead over Stair 2", x0: 35.2, y0: 10.2, x1: 39.8, y1: 13.8, z0: 1.95, z1: 3.0, revit_id: 913303 },
  ];
  BUILDING.levels.forEach(l => { l.obstructions = OBS.filter(o => o.level === l.id); });
  OBS.forEach(o => S.ELEMENTS.set(o.id, { ...o, type: o.kind, label: `${o.name}` }));

  const zone = (n, o, room, place, required, extra = {}) => {
    const short = +(required - o.z0).toFixed(2);
    return {
      id: `cz-${n}`, revit_id: o.revit_id, label: `${place}, under the ${o.name.toLowerCase()}`, place, level: lv(o.level).name,
      status: "fail", reason: `${o.z0.toFixed(2)} m clear; needs ${required.toFixed(2)} m`,
      values: { clear: o.z0, required, short },
      geometry: { level: o.level, x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, z0: 0, z1: o.z0 },
      related: [o.id, room], ...extra,
    };
  };

  const clearance = {
    spec: "revit-result/1",
    title: "Height clearance, whole model",
    question: "Check the clear height everywhere and show me only where it fails.",
    outcome: "Clear height is too low in 5 places, all on Levels 2 and 3, under ducts, a pipe rack, a beam and a stair bulkhead.",
    verdict: "fail",
    scope: { model: "Harbour Lane Offices", levels: ["Level 1", "Level 2", "Level 3"], included: "Every room, corridor and stair", excluded: "Plant rooms and the roof" },
    figures: [
      { label: "Places below the minimum clear height", value: 5, status: "fail" },
      { label: "Lowest clear height (Stair 2, Level 3; needs 2.00 m)", value: 1.95, unit: "m", target: 2.0, status: "fail" },
      { label: "Rooms, corridors and stairs checked", value: 39, status: "info" },
    ],
    view: {
      kind: "axon", caption: "All levels, exploded, showing only where clear height fails",
      legend: [{ status: "fail", label: "Below the minimum clear height" }],
      callouts: ["cz-5", "cz-1", "cz-3", "cz-2", "cz-4"],
    },
    presentation: {
      layout: "model-focus", show: "failures-only", levels: "exploded", overlays: ["measure"],
      measure: { value: "clear", required: "required", unit: "m" },
      why: "Whole-model screening with only a few failures: show just the failures, with the building as an outline for orientation.",
    },
    subjects: [
      zone(1, OBS[2], "r-L2-10", "Corridor 2.10", 2.4),
      zone(2, OBS[3], "r-L2-07", "Kitchen 2.07", 2.4),
      zone(3, OBS[4], "r-L3-08", "Meeting 3.08", 2.4),
      zone(4, OBS[5], "r-L3-09", "Corridor 3.09", 2.4),
      zone(5, OBS[6], "r-L3-S2", "Stair 2, Level 3", 2.0, { reason: "1.95 m headroom; needs 2.00 m over a stair" }),
    ],
    columns: [{ key: "place", label: "Place" }, { key: "level", label: "Level" }, { key: "clear", label: "Clear", unit: "m" }, { key: "required", label: "Needs", unit: "m" }, { key: "short", label: "Short by", unit: "m" }],
    charts: [{ type: "bar", title: "Two of the five low spots are ducts over corridors", data: [{ label: "Ducts", value: 2 }, { label: "Pipe rack", value: 1 }, { label: "Downstand beam", value: 1 }, { label: "Stair bulkhead", value: 1 }] }],
    actions: [
      { kind: "assign", label: "Send the 5 places to the MEP and structural modellers" },
      { kind: "export", label: "Export the clearance list" },
    ],
    provenance: { ran_at: "25 Nov 2026, 10:20", model_synced: "25 Nov 2026, 10:02", rule: "Clear height from finished floor to the lowest element above must be at least 2.40 m in rooms and corridors, and 2.00 m headroom over stairs.", source: "pyRevit run_query, request req-c1e4a9b07d22", sample: true },
    limits: ["Ceilings are taken at their modelled height; ceiling voids were not checked", "Linked MEP models were included; linked furniture was not"],
  };
  SAMPLES.unshift(clearance);

  // The layout each existing result asks for, as the agent would choose it.
  const P = {
    "Fire doors without a closer, Level 2": { layout: "model-and-list", show: "in-context", levels: "cut", why: "One level, mixed results: the plan in context with the list beside it." },
    "Room areas against the brief": { layout: "model-and-list", show: "in-context", levels: "exploded", why: "Every room on every storey has a result: levels are spread apart so each room's colour can be read, with the list beside." },
    "Model health before the design review": { layout: "tour", show: "in-context", levels: "stacked", why: "Five issues to walk through before a review: one stop per issue." },
    "Stair widths": { layout: "model-focus", show: "everything", levels: "exploded", overlays: ["measure"], measure: { value: "width", required: "required", unit: "mm" }, why: "Everything passes: show the whole building, storeys spread apart, with each stair's measured width." },
  };
  SAMPLES.forEach(s => { if (!s.presentation && P[s.title]) s.presentation = P[s.title]; });
  const stairs = SAMPLES.find(s => s.title === "Stair widths");
  if (stairs) stairs.subjects.forEach(x => { x.values.required = 1100; });
})();

(function () {
"use strict";
/* Shared sample data for the Agent Canvas prototypes (extracted from index.html). */
/* ---------------- Synthetic building: Harbour Lane Offices (sample data) ---------------- */
const LEVELS = [
  { id: "L1", n: 1, name: "Level 1" },
  { id: "L2", n: 2, name: "Level 2" },
  { id: "L3", n: 3, name: "Level 3" },
];
const PLATE = { w: 40, d: 24 };
function roomsFor(lv) {
  const n = lv.n;
  const r = (key, name, x0, y0, x1, y1, kind) => ({ id: `r-${lv.id}-${key}`, level: lv.id, name, number: `${n}.${key}`, x0, y0, x1, y1, kind });
  return [
    r("01", n === 1 ? "Reception" : "Open office", 0, 14, 16, 24, "room"),
    r("02", "Meeting", 16, 14, 24, 24, "room"),
    r("03", "Open office", 24, 14, 40, 24, "room"),
    r("04", "Meeting", 0, 0, 8, 10, "room"),
    r("05", "Focus rooms", 8, 0, 16, 10, "room"),
    r("06", "WCs", 16, 0, 24, 10, "room"),
    r("07", "Kitchen", 24, 0, 32, 10, "room"),
    r("08", "Meeting", 32, 0, 40, 10, "room"),
    r("09", "Corridor", 5, 10, 17, 14, "circ"),
    r("10", "Corridor", 23, 10, 35, 14, "circ"),
    r("LC", "Lift lobby", 17, 10, 23, 14, "circ"),
    r("S1", "Stair 1", 0, 10, 5, 14, "stair"),
    r("S2", "Stair 2", 35, 10, 40, 14, "stair"),
  ];
}
function doorsFor(lv) {
  const n = lv.n;
  const d = (k, x, y, wall, place) => ({ id: `d-${lv.id}-${k}`, level: lv.id, mark: `D-${n}.${k}`, x, y, wall, place });
  return [
    d("01", 4, 14, "h", `Open office ${n}.01`), d("02", 12, 14, "h", `Open office ${n}.01`), d("03", 20, 14, "h", `Meeting ${n}.02`),
    d("04", 28, 14, "h", `Open office ${n}.03`), d("05", 36, 14, "h", `Open office ${n}.03`), d("06", 4, 10, "h", `Meeting ${n}.04`),
    d("07", 12, 10, "h", `Focus rooms ${n}.05`), d("08", 20, 10, "h", `WCs ${n}.06`), d("09", 28, 10, "h", `Kitchen ${n}.07`),
    d("10", 36, 10, "h", `Meeting ${n}.08`), d("11", 5, 12, "v", "Stair 1"), d("12", 35, 12, "v", "Stair 2"),
    d("13", 17, 12, "v", "Lift lobby, west"), d("14", 23, 12, "v", "Lift lobby, east"), d("15", 11, 12, "v", `Corridor ${n}.09`),
    d("16", 29, 12, "v", `Corridor ${n}.10`),
  ];
}
const BUILDING = { name: "Harbour Lane Offices", levels: LEVELS.map(lv => ({ ...lv, rooms: roomsFor(lv), doors: doorsFor(lv) })) };
const ELEMENTS = new Map();
BUILDING.levels.forEach(lv => { lv.rooms.forEach(r => ELEMENTS.set(r.id, { ...r, type: "room" })); lv.doors.forEach(d => ELEMENTS.set(d.id, { ...d, type: "door" })); });

/* ---------------- Sample Result Specs (what an agent would send) ---------------- */
const SAMPLES = [
  {
    spec: "revit-result/1",
    title: "Fire doors without a closer, Level 2",
    question: "Which fire doors on Level 2 have no closer?",
    outcome: "4 of 16 fire doors on Level 2 have no closer, and 3 of them protect escape routes.",
    verdict: "fail",
    scope: { model: "Harbour Lane Offices", levels: ["Level 2"], included: "Doors with a fire rating", excluded: "Linked models" },
    figures: [
      { label: "Fire doors without a closer", value: 4, of: 16, status: "fail" },
      { label: "On escape routes (stairs, lift lobby, compartment doors)", value: 3, of: 6, status: "fail" },
      { label: "60-minute doors affected", value: 2, of: 4, status: "fail" },
    ],
    view: {
      kind: "plan", level: "Level 2", caption: "Level 2 plan, fire doors by closer status",
      legend: [{ status: "fail", label: "No closer" }, { status: "pass", label: "Closer fitted" }],
      callouts: ["d-L2-12", "d-L2-13", "d-L2-16", "d-L2-09"],
    },
    subjects: [
      ["01", "pass", 30], ["02", "pass", 30], ["03", "pass", 30], ["04", "pass", 30], ["05", "pass", 30], ["06", "pass", 30],
      ["07", "pass", 30], ["08", "pass", 30], ["09", "fail", 30, "Kitchen door: no closer, and a hold-open hook is fitted"],
      ["10", "pass", 30], ["11", "pass", 60], ["12", "fail", 60, "Protected stair door: no closer"],
      ["13", "fail", 60, "Lift lobby door: no closer"], ["14", "pass", 60], ["15", "pass", 30],
      ["16", "fail", 30, "Compartment door across the corridor: no closer"],
    ].map(([k, status, mins, reason]) => {
      const e = ELEMENTS.get(`d-L2-${k}`);
      return { id: e.id, revit_id: 812300 + Number(k), label: `Door ${e.mark}`, place: e.place, level: "Level 2", status,
        reason: reason || "Closer fitted", values: { rating: `${mins} min` } };
    }),
    columns: [{ key: "label", label: "Door" }, { key: "rating", label: "Rating" }, { key: "status", label: "Closer" }],
    charts: [{
      type: "stacked-bar", title: "Three of the four sit on escape routes, where a closer matters most",
      data: [
        { label: "Stairs and lift lobby", parts: { fail: 2, pass: 2 } },
        { label: "Corridor compartment doors", parts: { fail: 1, pass: 1 } },
        { label: "Room doors", parts: { fail: 1, pass: 9 } },
      ],
    }],
    actions: [
      { kind: "propose_change", label: "Mark the 4 doors as needing a closer", effect: "Sets Closer to Required on these doors, so the door schedule and specification pick them up. Nothing is moved or resized.", count: 4 },
      { kind: "export", label: "Export the 4 doors as a list" },
      { kind: "assign", label: "Send to the modeller" },
    ],
    provenance: { ran_at: "25 Nov 2026, 09:00", model_synced: "25 Nov 2026, 08:41", rule: "Every door with a fire rating must have a closer, because closers keep fire compartments shut.", source: "pyRevit run_query, request req-3f2a91c07b1e", sample: true },
    limits: ["Doors inside model groups were not inspected", "Linked models were not checked"],
  },
  {
    spec: "revit-result/1",
    title: "Room areas against the brief",
    question: "Do the room areas meet the client brief?",
    outcome: "5 of 24 rooms are more than 5% below their briefed area, mostly meeting rooms on Levels 2 and 3.",
    verdict: "attention",
    scope: { model: "Harbour Lane Offices", levels: ["Level 1", "Level 2", "Level 3"], included: "Rooms with a briefed area", excluded: "Corridors, stairs and lift lobbies" },
    figures: [
      { label: "Rooms more than 5% below brief", value: 5, of: 24, status: "attention" },
      { label: "Net area delivered against brief", value: 98.6, unit: "%", target: 100, status: "attention" },
      { label: "Largest shortfall (Meeting 3.08)", value: -7.4, unit: "m²", status: "attention" },
    ],
    view: {
      kind: "axon", caption: "All levels from the south-east, rooms by area against brief",
      legend: [{ status: "attention", label: "More than 5% below brief" }, { status: "pass", label: "Within 5% of brief" }, { status: "info", label: "More than 5% above brief" }],
      callouts: ["r-L3-08", "r-L2-04", "r-L3-04", "r-L2-08", "r-L3-02"],
    },
    subjects: (() => {
      const plan = {
        "L1-01": [160, 158.6], "L1-02": [80, 79.2], "L1-03": [160, 161.0], "L1-04": [80, 78.8], "L1-05": [80, 80.4], "L1-06": [80, 82.0], "L1-07": [80, 79.6], "L1-08": [80, 79.0],
        "L2-01": [160, 159.1], "L2-02": [80, 77.9], "L2-03": [160, 158.0], "L2-04": [80, 74.9], "L2-05": [80, 77.6], "L2-06": [72, 79.8], "L2-07": [80, 79.1], "L2-08": [80, 75.1],
        "L3-01": [160, 160.2], "L3-02": [80, 74.6], "L3-03": [160, 159.4], "L3-04": [80, 75.4], "L3-05": [80, 78.4], "L3-06": [72, 80.1], "L3-07": [80, 78.9], "L3-08": [80, 72.6],
      };
      return Object.entries(plan).map(([k, [brief, actual]]) => {
        const e = ELEMENTS.get(`r-${k}`);
        const pct = (actual - brief) / brief * 100;
        const status = pct < -5 ? "attention" : pct > 5 ? "info" : "pass";
        return { id: e.id, revit_id: 700000 + Object.keys(plan).indexOf(k), label: `${e.name} ${e.number}`, level: LEVELS.find(l => l.id === e.level).name, status,
          reason: status === "attention" ? `${Math.abs(pct).toFixed(1)}% below brief` : status === "info" ? `${pct.toFixed(1)}% above brief` : "Within 5% of brief",
          values: { brief, actual, diff: Number(pct.toFixed(1)) } };
      });
    })(),
    columns: [{ key: "label", label: "Room" }, { key: "level", label: "Level" }, { key: "brief", label: "Brief", unit: "m²" }, { key: "actual", label: "Actual", unit: "m²" }, { key: "diff", label: "Diff", unit: "%" }],
    charts: [{
      type: "bar", unit: "%", title: "Meeting rooms fall furthest short of the brief",
      data: [{ label: "Meeting", value: -4.6 }, { label: "Focus rooms", value: -1.9 }, { label: "Kitchen", value: -1.2 }, { label: "Open office", value: -0.4 }, { label: "WCs", value: 7.3 }],
    }],
    actions: [
      { kind: "show_in_revit", label: "Show the 5 short rooms in Revit" },
      { kind: "export", label: "Export the area schedule" },
    ],
    provenance: { ran_at: "25 Nov 2026, 09:05", model_synced: "25 Nov 2026, 08:41", rule: "Each room's area is compared with its briefed area; more than 5% under or over is flagged.", source: "pyRevit run_query, request req-91bd04e2aa10", sample: true },
    limits: ["Briefed areas come from the Brief Area parameter, entered by hand", "Room areas use Revit's computed area at wall finish"],
  },
  {
    spec: "revit-result/1",
    title: "Model health before the design review",
    question: "Is the model ready for Friday's design review?",
    outcome: "Mostly ready: 2 rooms are not enclosed and 3 door marks are used twice; both need fixing before the review.",
    verdict: "attention",
    scope: { model: "Harbour Lane Offices", levels: ["Level 1", "Level 2", "Level 3"], included: "Rooms, doors and Revit warnings", excluded: "Linked models" },
    figures: [
      { label: "Rooms not enclosed", value: 2, status: "cat1" },
      { label: "Door marks used twice", value: 3, status: "cat2" },
      { label: "Revit warnings", value: 142, delta: 18, status: "attention" },
    ],
    view: {
      kind: "axon", caption: "All levels from the south-east, elements with issues",
      legend: [{ status: "cat1", label: "Room not enclosed" }, { status: "cat2", label: "Door mark used twice" }],
      callouts: ["r-L2-05", "r-L3-07", "d-L1-07", "d-L2-11", "d-L3-14"],
    },
    subjects: [
      { id: "r-L2-05", revit_id: 701112, label: "Focus rooms 2.05", level: "Level 2", status: "cat1", reason: "Boundary open where a partition stops short" },
      { id: "r-L3-07", revit_id: 701219, label: "Kitchen 3.07", level: "Level 3", status: "cat1", reason: "Room separation line missing at the servery" },
      { id: "d-L1-07", revit_id: 812107, label: "Door D-1.07", level: "Level 1", status: "cat2", reason: "Mark D-1.07 also used on a door in Stair 1" },
      { id: "d-L2-11", revit_id: 812211, label: "Door D-2.11", level: "Level 2", status: "cat2", reason: "Mark D-2.11 also used on Level 3" },
      { id: "d-L3-14", revit_id: 812314, label: "Door D-3.14", level: "Level 3", status: "cat2", reason: "Mark D-3.14 also used on Level 2" },
    ],
    columns: [{ key: "label", label: "Element" }, { key: "level", label: "Level" }, { key: "reason", label: "Issue" }],
    charts: [{
      type: "bar", title: "Most warnings are overlapping walls, which the review will not see",
      data: [{ label: "Walls overlap", value: 61 }, { label: "Room separation overlaps", value: 34 }, { label: "Duplicate instances", value: 22 }, { label: "Elements slightly off axis", value: 17 }, { label: "Other", value: 8 }],
    }],
    actions: [
      { kind: "assign", label: "Send the 5 issues to the modeller" },
      { kind: "export", label: "Export the warning list" },
    ],
    provenance: { ran_at: "24 Nov 2026, 17:30", model_synced: "25 Nov 2026, 08:41", rule: "Rooms must be enclosed, door marks unique, and warnings counted against last week's run.", source: "pyRevit run_query, request req-5c0e7d1b9f34", sample: true, stale: true },
    limits: ["Warnings are counted, not fixed or judged individually"],
  },
  {
    spec: "revit-result/1",
    title: "Stair widths",
    question: "Are all stairs at least 1,100 mm wide?",
    outcome: "All 6 stairs are at least 1,100 mm wide; the narrowest is 1,200 mm.",
    verdict: "pass",
    scope: { model: "Harbour Lane Offices", levels: ["Level 1", "Level 2", "Level 3"], included: "Stair runs" },
    figures: [
      { label: "Stairs meeting the minimum", value: 6, of: 6, status: "pass" },
      { label: "Narrowest clear width (Stair 2, Level 3)", value: 1200, unit: "mm", target: 1100, status: "pass" },
    ],
    view: {
      kind: "axon", caption: "All levels from the south-east, stairs by clear width",
      legend: [{ status: "pass", label: "At least 1,100 mm" }, { status: "fail", label: "Below 1,100 mm" }],
    },
    subjects: ["L1", "L2", "L3"].flatMap((lv, i) => ["S1", "S2"].map((s, j) => {
      const e = ELEMENTS.get(`r-${lv}-${s}`);
      const w = [[1350, 1350], [1350, 1250], [1300, 1200]][i][j];
      return { id: e.id, revit_id: 650000 + i * 10 + j, label: `${e.name}, ${LEVELS[i].name}`, level: LEVELS[i].name, status: "pass", reason: "Meets the minimum", values: { width: w } };
    })),
    columns: [{ key: "label", label: "Stair" }, { key: "width", label: "Clear width", unit: "mm" }, { key: "status", label: "Result" }],
    charts: [{
      type: "bar", unit: "mm", target: 1100, title: "Every flight clears the minimum by at least 100 mm",
      data: [{ label: "Stair 1, L1", value: 1350 }, { label: "Stair 2, L1", value: 1350 }, { label: "Stair 1, L2", value: 1350 }, { label: "Stair 2, L2", value: 1250 }, { label: "Stair 1, L3", value: 1300 }, { label: "Stair 2, L3", value: 1200 }],
    }],
    actions: [{ kind: "export", label: "Export the stair widths" }],
    provenance: { ran_at: "25 Nov 2026, 09:12", model_synced: "25 Nov 2026, 08:41", rule: "Clear stair width between handrails must be at least 1,100 mm.", source: "pyRevit run_query, request req-a07f3c55e812", sample: true },
    limits: [], limits_none: true,
  },
  {
    spec: "revit-result/1",
    title: "Example the standard rejects",
    question: "doors?",
    outcome: "Done. 812309, 812312 flagged (OST_Doors).",
    verdict: "red",
    scope: { model: "Harbour Lane Offices" },
    view: { kind: "plan", caption: "", legend: [{ status: "fail", label: "A" }, { status: "pass", label: "B" }, { status: "info", label: "C" }, { status: "cat1", label: "D" }, { status: "cat2", label: "E" }, { status: "attention", label: "F" }] },
    subjects: [{ id: "d-L2-09", label: "", status: "fail" }],
    charts: [{ type: "pie", title: "", data: [{ label: "x", value: 1 }] }],
    actions: [{ kind: "propose_change", label: "Fix it" }],
    provenance: { ran_at: "now", rule: "", source: "" },
  },
];


window.CANVAS_SAMPLES = { BUILDING: { ...BUILDING, plate: PLATE }, SAMPLES, ELEMENTS, LEVELS };

})();

// Builds a panel-mesh-v1 payload (feet, Z-up, like PanelMeshPayloadWriter) from the canvas sample building,
// so the real-mesh path of panel-view/index.html can be tested in a browser without Revit:
//   node tools/canvas/make-demo-mesh.mjs  ->  plugin/Panel/panel-view/tmp/demo-mesh.json
//   open panel-view/index.html?mesh=tmp/demo-mesh.json&r=0
import fs from "node:fs"; import vm from "node:vm"; import path from "node:path";
const dir = "plugin/Panel/panel-view/canvas";
const ctx = { window: {}, console }; vm.createContext(ctx);
for (const f of ["samples.js", "samples-model.js"]) vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx);
const { BUILDING, SAMPLES } = ctx.window.CANVAS_SAMPLES;
const FT = 0.3048, LH = 4.2, pos = [], idx = [], elements = [];
function addBox(id, name, category, levelId, x0, y0, z0, x1, y1, z1, glazed = false) {
  const v0 = pos.length / 3, i0 = idx.length;
  const X = [x0, x1].map(v => v / FT), Y = [y0, y1].map(v => v / FT), Z = [z0, z1].map(v => v / FT);
  for (const z of Z) for (const y of Y) for (const x of X) pos.push(x, y, z);
  const q = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  for (const [a, b, c, d] of q) idx.push(v0 + a, v0 + b, v0 + c, v0 + a, v0 + c, v0 + d);
  elements.push({ elementId: id, name, category, isGlazed: glazed, firstVertex: v0, vertexCount: 8, firstIndex: i0, indexCount: 36, cutIndexCount: 0, levelId });
}
const areas = SAMPLES.find(s => s.title === "Room areas against the brief");
const roomRevit = new Map(areas.subjects.map(s => [s.id, s.revit_id]));
let wid = 500000;
BUILDING.levels.forEach((lv, i) => {
  const e = i * LH;
  addBox(400000 + i, `${lv.name} slab`, "Floors", lv.id, 0, 0, e - 0.3, 40, 24, e);
  lv.rooms.forEach(r => {
    addBox(roomRevit.get(r.id) || 600000 + wid++, `${r.name} ${r.number}`, "Rooms", lv.id, r.x0 + 0.1, r.y0 + 0.1, e, r.x1 - 0.1, r.y1 - 0.1, e + 2.7, true);
    for (const [ax, ay, bx, by] of [[r.x0, r.y0, r.x1, r.y0], [r.x0, r.y0, r.x0, r.y1]]) addBox(wid++, "Basic Wall", "Walls", lv.id, Math.min(ax, bx) - 0.06, Math.min(ay, by) - 0.06, e, Math.max(ax, bx) + 0.06, Math.max(ay, by) + 0.06, e + 3);
  });
  addBox(wid++, "Basic Wall", "Walls", lv.id, 39.94, 0, e, 40.06, 24, e + 3); addBox(wid++, "Basic Wall", "Walls", lv.id, 0, 23.94, e, 40, 24.06, e + 3);
  lv.doors.forEach(d => { const k = Number(d.id.split("-").pop()); const id = 812000 + (i + 2) * 100 + k; const h = d.wall === "h"; addBox(id, `Door ${d.mark}`, "Doors", lv.id, d.x - (h ? 0.45 : 0.03), d.y - (h ? 0.03 : 0.45), e, d.x + (h ? 0.45 : 0.03), d.y + (h ? 0.03 : 0.45), e + 2.1); });
  (lv.obstructions || []).forEach(o => addBox(o.revit_id, o.name, o.kind === "duct" ? "Ducts" : o.kind === "pipe" ? "Pipes" : "Structural Framing", lv.id, o.x0, o.y0, e + o.z0, o.x1, o.y1, e + o.z1));
});
const b64 = (Ctor, arr) => Buffer.from(new Ctor(arr).buffer).toString("base64");
const payload = { format: "panel-mesh-v1", coordinateSystem: "revit-feet-zup", elementCount: elements.length, totalVertices: pos.length / 3, totalIndices: idx.length, truncated: false, skippedElements: 0, clientSectionClip: false, cutPlanes: [], sectionBoxCorners: [],
  elements, levels: BUILDING.levels.map((lv, i) => ({ id: lv.id, name: lv.name, elevation: i * LH / FT })), positionsB64: b64(Float32Array, pos), indicesB64: b64(Uint32Array, idx) };
fs.mkdirSync("plugin/Panel/panel-view/tmp", { recursive: true });
fs.writeFileSync("plugin/Panel/panel-view/tmp/demo-mesh.json", JSON.stringify(payload));
console.log(`wrote ${elements.length} elements, ${payload.totalVertices} vertices, ${payload.levels.length} levels`);

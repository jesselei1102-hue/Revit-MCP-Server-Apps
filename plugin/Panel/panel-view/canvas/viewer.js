/* Agent Canvas built-in model viewer (Three.js r128: global THREE + THREE.OrbitControls).
 *
 * Two model sources, one presentation engine:
 *   - loadMesh(payload): Revit's panel-mesh-v1 export (feet, Z-up, per-element ranges, optional levels)
 *   - loadSample(building): the synthetic "Harbour Lane Offices" used for the browser demo
 * A Result Spec (RPS-1, sections B and G) then decides what is shown:
 *   show:    "failures-only" (Failures) | "in-context" (Shell + fails) | "everything" (Full model)
 *   levels:  "stacked" | "exploded" | "cut" (at the spec's level, 1.25 m above its floor)
 *   overlays: "measure" draws floor-to-obstruction dimensions with the required height
 * Subjects take status inks; context is a warm clay model (after Pascal Editor's "Paper" theme)
 * or, in failures-only, an X-ray of the building so the place stays recognisable.
 *
 * Coordinates (metres): Revit/plan x -> x (east), plan y -> -z (north), height -> y.
 */
(function () {
  "use strict";
  const FT = 0.3048, LOW_WALL = 1.25, CUT_H = 1.25;
  const STATUSES = ["fail", "attention", "pass", "info", "cat1", "cat2"];
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function col(n, fb) { let c; try { c = new THREE.Color(cssVar(n) || fb); } catch (_) { c = new THREE.Color(fb); } return c.convertSRGBToLinear(); }
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmtM = (v, unit) => typeof v !== "number" ? "" : unit === "mm" ? `${Math.round(v).toLocaleString("en-GB")} mm` : `${v.toFixed(2)} ${unit || "m"}`;

  // Revit category name → Canvas filter / material role.
  // Keep handrails / top rails / balusters out of "Furniture" (Handrails does not contain "railing").
  function roleOf(category, isGlazed, hint) {
    const c = String(category || "").toLowerCase().trim();
    const h = String(hint || "").toLowerCase();
    if (!c && !h) return "other";
    if (/rooms?|spaces?|areas?|mass|mep space|hvac.?zone|房间|空间|面积|体量|分区/.test(c)) return "volume";
    if (/洞口|shaft opening|\bopenings?\b/.test(c)) return "opening";
    if (/curtain|幕墙/.test(c) || /\bmullions?\b/.test(c)) return "curtain";
    if (/^(windows?|窗|窗户)$/.test(c)) return "glass";
    if (/\bdoors?\b|^门$|门扇|门框/.test(c) && !/curtain/.test(c)) return "door";
    if (/floors?|slabs?|foundation|topography|toposolid|pads?|楼板|地板|基础|地形|垫层/.test(c)) return "slab";
    if (/roofs?|fascia|gutters?|soffits?|屋顶|屋面|封檐|天沟/.test(c)) return "roof";
    if (/ceilings?|天花板|吊顶/.test(c)) return "ceiling";
    // Stair parts often omit the word "stair": Runs / Landings / 梯段.
    if (/^(runs?|landings?|trisers?|treads?|risers?|stringers?)$/.test(c)) return "stair";
    if (/梯段|踢面|踏板|梯边梁|楼梯平台|楼梯支撑/.test(c)) return "stair";
    if (/\bstairs?\b|ramps?|multistory|楼梯|坡道/.test(c) && !/rail|扶手|栏杆|baluster|handrail|top rail|termination/.test(c)) return "stair";
    if (/railings?|handrails?|top rails?|balusters?|terminations?|栏杆|扶手|栏杆扶手|竖杆/.test(c)) return "railing";
    if (/^supports?$|^支撑$|railing support|handrail support|栏杆支架|扶手支架/.test(c)) return "railing";
    if (/elevator|escalator|\blifts?\b|电梯|自动扶梯|升降机/.test(c) || /elevator|escalator|\blift\b|电梯|自动扶梯/.test(h)) return "vertical";
    if (/plumbing fixtures?|plumbing equipment|sanitary|卫浴|洁具|卫生器具|管道设备/.test(c)) return "plumbing";
    if (/furniture|casework|家具|橱柜/.test(c)) return "furn";
    if (/specialty equipment|speciality equipment|medical equipment|food service|signage|专用设备|特殊设备|医疗设备|餐饮设备|标识/.test(c)) return "equip";
    if (/lighting fixtures?|lighting devices?|灯具/.test(c)) return isGlazed ? "glass" : "light";
    if (/electrical fixtures?|communication devices?|data devices?|fire alarm|nurse call|security devices?|telephone devices?|audio.?visual|电气装置|通信设备|数据设备|火警|保安|电话设备/.test(c)) return "mep";
    if (/duct|pipes?|pipe fitting|pipe accessory|cable tray|conduit|mechanical equipment|sprinkler|air terminal|electrical equipment|flex duct|flex pipe|duct accessory|duct fitting|电气设备|机械设备|管道|管件|风管|桥架|线管|喷淋|喷头|风口/.test(c)) return "mep";
    if (/structural|columns?|framing|beams?|braces?|truss|connections?|stiffeners?|结构柱|结构框架|结构梁|结构连接|\b梁\b|\b柱\b/.test(c)) return "struct";
    if (/\bwalls?\b|墙/.test(c) && !/curtain/.test(c)) return "wall";
    if (/hardscape|roads?|\bsite\b|parking|景观|道路|场地|停车/.test(c)) return "site";
    if (/generic model|常规模型|一般模型/.test(c)) {
      if (/stair|楼梯|ramp|坡道/.test(h)) return "stair";
      if (/elevator|escalator|电梯|扶梯/.test(h)) return "vertical";
      if (/toilet|wc|sink|vanity|洁具|马桶|洗脸/.test(h)) return "plumbing";
      return "generic";
    }
    if (/^parts?$|assembl(?:y|ies)|部件|组合/.test(c)) return "generic";
    // Last-chance name hints when the category is unfamiliar.
    if (/elevator|escalator|电梯|自动扶梯/.test(h)) return "vertical";
    if (/stair run|stair landing|梯段|楼梯/.test(h)) return "stair";
    return "other";
  }
  const LOW_ROLES = new Set(["wall", "glass", "curtain", "door", "struct", "furn", "generic", "stair", "railing", "plumbing", "equip", "light", "vertical", "site", "other"]);

  function createViewer(container) {
    const W = () => container.clientWidth, H = () => container.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    renderer.setSize(W(), H());
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.domElement.setAttribute("aria-hidden", "true");
    container.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    const persp = new THREE.PerspectiveCamera(32, W() / Math.max(1, H()), 0.3, 4000);
    const ortho = new THREE.OrthographicCamera(-30, 30, 20, -20, 0.1, 4000);
    let camera = persp;
    const controls = new THREE.OrbitControls(persp, renderer.domElement);
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.12, screenSpacePanning: true, maxPolarAngle: Math.PI * 0.495, minDistance: 2, maxDistance: 2000 });
    const orthoControls = new THREE.OrbitControls(ortho, renderer.domElement);
    Object.assign(orthoControls, { enableRotate: false, screenSpacePanning: true, enabled: false });
    orthoControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    scene.add(new THREE.HemisphereLight(0xfff5d9, 0xb3a98e, 0.75), new THREE.AmbientLight(0xfff9eb, 0.32));
    const fill = new THREE.DirectionalLight(0xdde5ff, 0.35); scene.add(fill);
    const sun = new THREE.DirectionalLight(0xfff1c8, 1.6); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0006; scene.add(sun, sun.target);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.18 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

    const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    const M = {};
    function makeMaterials() {
      const L = (c, extra = {}) => new THREE.MeshLambertMaterial(Object.assign({ color: c, clippingPlanes: [clipPlane], side: THREE.DoubleSide }, extra));
      M.slab = L(col("--model-slab", "#d3cab4"));
      M.floor = L(col("--model-floor", "#ddd4bf"));
      M.wall = L(col("--model-wall", "#efe9da"));
      M.curtain = L(col("--model-wall", "#e7e2d6"));
      M.furn = L(col("--model-wall", "#efe9da"));
      M.generic = L(col("--model-door", "#d8d4c9"));
      M.other = L(col("--model-door", "#d8d4c9"));
      M.plumbing = L(col("--model-wall", "#ebe4d6"));
      M.equip = L(col("--model-wall", "#e5dece"));
      M.light = L(col("--model-door", "#ddd6c8"));
      M.railing = L(col("--model-struct", "#b3ab9b"));
      M.vertical = L(col("--model-struct", "#a8a090"));
      M.site = L(col("--model-slab", "#cfc6b0"));
      M.stair = L(col("--model-slab", "#d3cab4"));
      M.roof = L(col("--model-roof", "#c4bba6"));
      M.ceiling = L(col("--model-wall", "#efe9da"));
      M.door = L(col("--model-door", "#d8d4c9"));
      M.glass = L(new THREE.Color("#9fd4f8").convertSRGBToLinear(), { transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      M.mep = L(col("--model-mep", "#93a3ae"));
      M.struct = L(col("--model-struct", "#b3ab9b"));
      M.volume = L(new THREE.Color("#5eb8e0").convertSRGBToLinear(), {
        transparent: true, opacity: 0.34, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        emissive: new THREE.Color("#2a6f8c").convertSRGBToLinear(), emissiveIntensity: 0.12,
      });
      M.edge = new THREE.LineBasicMaterial({ color: col("--model-edge", "#5f5a50"), transparent: true, opacity: 0.7, clippingPlanes: [clipPlane] });
      M.xray = new THREE.LineBasicMaterial({ color: col("--model-edge", "#5f5a50"), transparent: true, opacity: 0.32, depthWrite: false });
      M.xrayFaint = new THREE.LineBasicMaterial({ color: col("--model-edge", "#5f5a50"), transparent: true, opacity: 0.12, depthWrite: false });
      M.xrayFill = new THREE.MeshBasicMaterial({ color: col("--model-edge", "#5f5a50"), transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
      M.ghost = L(col("--model-wall", "#efe9da"), { transparent: true, opacity: 0.22, depthWrite: false });
      // Shell + fails: non-shell clutter (MEP / furniture / lights…) pressed down so failures read.
      M.contextDim = L(col("--model-wall", "#b8b0a2"), { transparent: true, opacity: 0.14, depthWrite: false });
      M.contextDimEdge = new THREE.LineBasicMaterial({ color: col("--model-edge", "#5f5a50"), transparent: true, opacity: 0.1, depthWrite: false });
      M.scale = new THREE.LineBasicMaterial({ color: col("--ink", "#1b1b1a"), depthTest: false, transparent: true });
      M.ring = new THREE.MeshBasicMaterial({ color: col("--ring", "#2563c9"), transparent: true, opacity: 0.95, depthTest: false });
      M.dim = new THREE.LineBasicMaterial({ color: col("--ink", "#1b1b1a"), depthTest: false, transparent: true });
      M.req = new THREE.LineDashedMaterial({ color: col("--ink", "#1b1b1a"), dashSize: 0.25, gapSize: 0.18, depthTest: false, transparent: true });
      STATUSES.forEach(st => {
        M["st-" + st] = L(col(`--${st}`, "#c23b22"), { emissive: col(`--${st}`, "#c23b22"), emissiveIntensity: 0.42 });
        M["fill-" + st] = L(col(`--${st}`, "#c23b22"), { transparent: true, opacity: 0.7, emissive: col(`--${st}`, "#c23b22"), emissiveIntensity: 0.28 });
        M["vol-" + st] = new THREE.MeshBasicMaterial({ color: col(`--${st}`, "#c23b22"), transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
        M["vedge-" + st] = new THREE.LineBasicMaterial({ color: col(`--${st}`, "#c23b22") });
        M["halo-" + st] = new THREE.MeshBasicMaterial({ color: col(`--${st}`, "#c23b22"), transparent: true, opacity: 0.28, depthWrite: false });
      });
      levels.forEach(Lv => { Lv.mats = {}; });
    }

    const root = new THREE.Group(); scene.add(root);
    const ringGroup = new THREE.Group(); scene.add(ringGroup);
    const scaleBar = new THREE.Group(); scene.add(scaleBar);
    let levels = [];                 // {id, name, index, elev, group, overlay, box, targetY, quiet, lowPlane, mats}
    let elements = new Map();        // element key -> meshes
    let elementInfo = new Map();     // element key -> {name, category, role, level}
    let pickables = [];
    let facades = [];
    let source = null;               // "mesh" | "sample"
    let bounds = new THREE.Box3(new THREE.Vector3(0, 0, -24), new THREE.Vector3(40, 12, 0));
    let hiddenRoles = new Set();
    let hiddenModels = new Set();
    function passesFacet(mesh) {
      if (!mesh) return true;
      if (hiddenRoles.has(mesh.userData.role || "furn")) return false;
      const id = mesh.userData.linkId ? String(mesh.userData.linkId) : "host";
      if (hiddenModels.has(id)) return false;
      return true;
    }
    function setFacetVisible(kind, id, visible) {
      const set = kind === "models" ? hiddenModels : hiddenRoles;
      const key = String(id);
      if (visible) set.delete(key); else set.add(key);
      paint();
    }
    function clearFacet() { hiddenRoles.clear(); hiddenModels.clear(); paint(); }
    let explodeGap = 14;
    let explodeScale = 1; // user-adjustable multiplier on explodeGap (Spread slider)
    const hiddenLinks = new Set();
    let showSpaces = true;
    const linkStyles = new Map();
    const linkMatCache = new Map();
    makeMaterials();
    { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)]), M.scale); l.renderOrder = 7; scaleBar.add(l);
      [0, 5, 10].forEach(x => { const t = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, -0.35), new THREE.Vector3(x, 0, 0.35)]), M.scale); t.renderOrder = 7; scaleBar.add(t); }); }

    function reg(key, mesh, meta) { Object.assign(mesh.userData, meta, { id: key }); if (!elements.has(key)) elements.set(key, []); elements.get(key).push(mesh); pickables.push(mesh); }
    function unreg(mesh) { const id = mesh.userData.id; const list = elements.get(id); if (list) { const i = list.indexOf(mesh); if (i >= 0) list.splice(i, 1); if (!list.length) elements.delete(id); } const j = pickables.indexOf(mesh); if (j >= 0) pickables.splice(j, 1); }
    function addEdges(mesh, parent) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), M.edge); e.position.copy(mesh.position); e.rotation.copy(mesh.rotation); e.userData.of = mesh; parent.add(e); return e; }
    function newLevel(id, name, index, elev) {
      const g = new THREE.Group(); g.userData = { level: id, index };
      const overlay = new THREE.Group(); overlay.userData.overlay = true; g.add(overlay); root.add(g);
      return { id, name, index, elev, group: g, overlay, box: new THREE.Box3(), targetY: 0, quiet: false, lowPlane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6), mats: {} };
    }
    function disposeModel() {
      root.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      while (root.children.length) root.remove(root.children[0]);
      levels = []; elements = new Map(); elementInfo = new Map(); pickables = []; facades = [];
    }
    function finishModel() {
      bounds = new THREE.Box3();
      levels.forEach(L => { if (!L.box.isEmpty()) bounds.union(L.box); });
      if (bounds.isEmpty()) bounds = new THREE.Box3(new THREE.Vector3(0, 0, -10), new THREE.Vector3(10, 3, 0));
      const elevs = levels.map(l => l.elev).sort((a, b) => a - b), gaps = [];
      for (let i = 1; i < elevs.length; i++) gaps.push(elevs[i] - elevs[i - 1]);
      const storey = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 4.2;
      explodeGap = Math.max(6, storey * 2.2);
      // sun and ground sized to the model
      const c = bounds.getCenter(new THREE.Vector3()), r = Math.max(20, bounds.getSize(new THREE.Vector3()).length());
      sun.position.copy(c).add(new THREE.Vector3(0.55, 0.85, 0.45).multiplyScalar(r * 1.6)); sun.target.position.copy(c);
      Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: r * 4 }); sun.shadow.camera.updateProjectionMatrix();
      fill.position.copy(c).add(new THREE.Vector3(-0.6, 0.5, -0.7).multiplyScalar(r));
      ground.scale.set(r * 8, r * 8, 1); ground.position.set(c.x, bounds.min.y - 0.02, c.z);
    }

    // ---------- Source 1: Revit mesh payload (panel-mesh-v1) ----------
    function b64ToArray(b64, Ctor) { const bin = atob(b64 || ""); const buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i); return new Ctor(buf.buffer); }
    function buildMeshElements(payload, intoLevels) {
      const pos = b64ToArray(payload.positionsB64, Float32Array), idx = b64ToArray(payload.indicesB64, Uint32Array);
      const edgesOk = (payload.totalIndices || idx.length) < 900000;
      const byId = new Map(intoLevels.map(l => [String(l.id), l]));
      const sorted = intoLevels.slice().sort((a, b) => a.elev - b.elev);
      const levelForY = y => { let pick = sorted[0]; for (const l of sorted) if (l.elev <= y + 0.3) pick = l; return pick; };
      const added = [];
      (payload.elements || []).forEach(el => {
        if (!el.vertexCount || !el.indexCount) return;
        const hint = [el.family, el.typeName, el.name].filter(Boolean).join(" ");
        if (!el.isLink && roleOf(el.category, el.isGlazed, hint) === "opening") return;
        const v0 = el.firstVertex, nv = el.vertexCount, i0 = el.firstIndex, ni = el.indexCount;
        const p = new Float32Array(nv * 3);
        let minY = Infinity;
        for (let k = 0; k < nv; k++) { const X = pos[(v0 + k) * 3], Y = pos[(v0 + k) * 3 + 1], Z = pos[(v0 + k) * 3 + 2]; p[k * 3] = X * FT; p[k * 3 + 1] = Z * FT; p[k * 3 + 2] = -Y * FT; if (Z * FT < minY) minY = Z * FT; }
        const ix = new Uint32Array(ni); for (let k = 0; k < ni; k++) ix[k] = idx[i0 + k] - v0;
        const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(p, 3)); geo.setIndex(new THREE.BufferAttribute(ix, 1)); geo.computeVertexNormals(); geo.computeBoundingBox();
        const cat = String(el.category || "");
        const linkId = el.linkInstanceId != null ? String(el.linkInstanceId) : null;
        const containerLink = !linkId && (!!el.isLink || /revit link|rvt link|链接/i.test(cat));
        const role = containerLink ? "link" : roleOf(el.category, el.isGlazed, hint);
        const L = (el.levelId != null && byId.get(String(el.levelId))) || levelForY(minY);
        const displayColor = el.displayColor || (role === "mep" ? el.cutColor : null) || null;
        // Rooms/Spaces carry isGlazed for legacy translucency — do not paint them as window glass.
        const glazed = role === "glass" || (role === "curtain" && !!el.isGlazed);
        const mesh = new THREE.Mesh(geo, role === "volume" ? M.volume : matFor(role, L, displayColor, glazed));
        mesh.castShadow = !glazed && role !== "volume";
        mesh.receiveShadow = true;
        mesh.userData.role = role; mesh.userData.levelRef = L; mesh.userData.displayColor = displayColor;
        mesh.userData.glazed = glazed;
        mesh.userData.linkId = linkId || (containerLink ? String(el.elementId) : null);
        L.group.add(mesh);
        if (edgesOk && (role === "wall" || role === "slab" || role === "roof" || role === "struct" || role === "stair" || role === "door")) addEdges(mesh, L.group);
        const key = el.meshKey || String(el.elementId);
        reg(key, mesh, { kind: role === "door" ? "door" : role, level: L.id, label: el.name || el.category || key });
        elementInfo.set(key, { name: el.name, category: el.category, role, level: L.id, displayColor, linkId: mesh.userData.linkId, elementId: el.elementId, family: el.family || "", typeName: el.typeName || "", modelName: el.modelName || "" });
        if (role !== "volume" && role !== "ceiling") L.box.union(geo.boundingBox);
        added.push(key);
      });
      return added;
    }
    function loadMesh(payload) {
      disposeModel(); source = "mesh";
      const lv = (payload.levels || []).map(l => ({ id: String(l.id), name: l.name || `Level ${l.id}`, elev: (l.elevation || 0) * FT })).sort((a, b) => a.elev - b.elev);
      if (!lv.length) lv.push({ id: "model", name: "Model", elev: 0 });
      levels = lv.map((l, i) => newLevel(l.id, l.name, i, l.elev));
      const keys = buildMeshElements(payload, levels);
      levels = levels.filter(L => L.group.children.length > 1 || L.box.isEmpty() === false);
      levels.forEach((L, i) => { L.index = i; if (L.box.isEmpty()) L.box.set(new THREE.Vector3(0, L.elev, 0), new THREE.Vector3(1, L.elev + 3, -1)); });
      finishModel();
      if (spec) setSpec(spec, true); else { pres.levels = "stacked"; pres.show = "everything"; placeLevels(true); paint(); home(true); }
      return { elements: keys.length, levels: levels.length };
    }
    function applyDelta(deletedIds, payload) {
      (deletedIds || []).forEach(id => { const key = String(id); (elements.get(key) || []).slice().forEach(m => { unreg(m); m.parent && m.parent.remove(m); m.geometry && m.geometry.dispose(); }); elementInfo.delete(key); });
      root.traverse(o => { if (o.isLineSegments && o.userData.of && !o.userData.of.parent) o.parent.remove(o); });
      const added = payload ? buildMeshElements(payload, levels) : [];
      if (spec) { buildOverlays(); paint(); } else paint();
      return { removed: (deletedIds || []).length, added: added.length };
    }

    // ---------- Source 2: synthetic sample building (browser demo) ----------
    function loadSample(building) {
      disposeModel(); source = "sample";
      const LH = 4.2, SL = 0.3, WH = 3.0, PT = 0.12, ET = 0.3, P = building.plate;
      const box = (w, h, d, mat, role) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.castShadow = true; m.receiveShadow = true; m.userData.role = role; return m; };
      building.levels.forEach((lv, i) => {
        const L = newLevel(lv.id, lv.name, i, i * LH); levels.push(L);
        const g = L.group, y0 = L.elev;
        L.box.set(new THREE.Vector3(0, y0 - SL, -P.d), new THREE.Vector3(P.w, y0 + WH, 0));
        const slab = box(P.w, SL, P.d, M.slab, "slab"); slab.position.set(P.w / 2, y0 - SL / 2, -P.d / 2); g.add(slab); addEdges(slab, g);
        for (let x = 8; x < P.w; x += 8) for (const y of [4, 20]) { const c = box(0.4, WH, 0.4, M.wall, "wall"); c.position.set(x, y0 + WH / 2, -y); c.userData.low = { y0, h: WH }; g.add(c); }
        [{ x0: 0, y0: 0, x1: P.w, y1: 0 }, { x0: P.w, y0: 0, x1: P.w, y1: P.d }, { x0: P.w, y0: P.d, x1: 0, y1: P.d }, { x0: 0, y0: P.d, x1: 0, y1: 0 }].forEach(sd => {
          const len = Math.hypot(sd.x1 - sd.x0, sd.y1 - sd.y0), mx = (sd.x0 + sd.x1) / 2, my = (sd.y0 + sd.y1) / 2, horiz = sd.y0 === sd.y1;
          const face = new THREE.Group(); face.userData.normal = horiz ? new THREE.Vector3(0, 0, sd.y0 === 0 ? 1 : -1) : new THREE.Vector3(sd.x0 === 0 ? -1 : 1, 0, 0);
          const mk = (h, yc, mat, role) => { const m = box(horiz ? len + ET : ET, h, horiz ? ET : len + ET, mat, role); m.position.set(mx, y0 + yc, -my); return m; };
          const sill = mk(0.9, 0.45, M.wall, "wall"), head = mk(0.5, WH - 0.25, M.wall, "wall"), glass = mk(WH - 1.4, 0.9 + (WH - 1.4) / 2, M.glass, "glass");
          glass.castShadow = false; face.add(sill, head, glass); addEdges(sill, face); addEdges(head, face);
          for (let t = 2; t < len; t += 2) { const mu = box(0.08, WH - 1.4, 0.08, M.wall, "wall"); mu.position.set(sd.x0 + (sd.x1 - sd.x0) * t / len, y0 + 0.9 + (WH - 1.4) / 2, -(sd.y0 + (sd.y1 - sd.y0) * t / len)); face.add(mu); }
          g.add(face); facades.push(face);
        });
        lv.rooms.forEach(r => {
          const fl = box(r.x1 - r.x0 - 0.14, 0.04, r.y1 - r.y0 - 0.14, M.floor, "floor"); fl.position.set((r.x0 + r.x1) / 2, y0 + 0.02, -(r.y0 + r.y1) / 2); fl.castShadow = false; g.add(fl);
          reg(r.id, fl, { kind: "room", level: lv.id, label: `${r.name} ${r.number}` });
          if (r.kind === "stair") { const n = 14, run = (r.x1 - r.x0 - 0.6) / n; for (let k = 0; k < n; k++) { const st = box(run, (k + 1) * (LH / n), r.y1 - r.y0 - 0.5, M.stair, "stair"); st.position.set(r.x0 < 1 ? r.x0 + 0.3 + run * (k + 0.5) : r.x1 - 0.3 - run * (k + 0.5), y0 + (k + 1) * (LH / n) / 2, -(r.y0 + r.y1) / 2); g.add(st); reg(r.id, st, { kind: "step", level: lv.id, label: r.name }); } }
        });
        const seen = new Set();
        const doorsOn = (ax, ay, bx, by) => lv.doors.filter(d => ax === bx ? Math.abs(d.x - ax) < 0.05 && d.y > Math.min(ay, by) && d.y < Math.max(ay, by) : Math.abs(d.y - ay) < 0.05 && d.x > Math.min(ax, bx) && d.x < Math.max(ax, bx));
        lv.rooms.forEach(r => [[r.x0, r.y0, r.x1, r.y0], [r.x1, r.y0, r.x1, r.y1], [r.x0, r.y1, r.x1, r.y1], [r.x0, r.y0, r.x0, r.y1]].forEach(([ax, ay, bx, by]) => {
          const outer = (ay === by && (ay === 0 || ay === P.d)) || (ax === bx && (ax === 0 || ax === P.w)); const key = [ax, ay, bx, by].join(",");
          if (outer || seen.has(key)) return; seen.add(key);
          const vert = ax === bx, a = vert ? ay : ax, b = vert ? by : bx, cuts = doorsOn(ax, ay, bx, by).map(d => vert ? d.y : d.x).sort((p, q) => p - q);
          let s = a;
          [...cuts, null].forEach(c => {
            const e = c === null ? b : c - 0.5;
            if (e - s > 0.05) { const len = e - s, mid = (s + e) / 2; const w = box(vert ? PT : len, WH, vert ? len : PT, M.wall, "wall"); w.position.set(vert ? ax : mid, y0 + WH / 2, -(vert ? mid : ay)); w.userData.low = { y0, h: WH }; g.add(w); addEdges(w, g); }
            if (c !== null) { const hd = box(vert ? PT : 1.0, 0.8, vert ? 1.0 : PT, M.wall, "wall"); hd.position.set(vert ? ax : c, y0 + WH - 0.4, -(vert ? c : ay)); hd.userData.head = true; g.add(hd); s = c + 0.5; }
          });
        }));
        lv.doors.forEach(d => {
          const dg = new THREE.Group(), leaf = box(0.9, 2.1, 0.05, M.door, "door"); leaf.position.set(0.45, 1.05, 0);
          const hinge = new THREE.Group(); hinge.add(leaf); hinge.rotation.y = -Math.PI / 6; hinge.position.set(-0.45, 0, 0); dg.add(hinge);
          if (d.wall === "v") dg.rotation.y = Math.PI / 2; dg.position.set(d.x, y0, -d.y); g.add(dg);
          reg(d.id, leaf, { kind: "door", level: lv.id, label: `Door ${d.mark}` });
        });
        (lv.obstructions || []).forEach(o => {
          const m = box(o.x1 - o.x0, o.z1 - o.z0, o.y1 - o.y0, o.kind === "beam" || o.kind === "bulkhead" ? M.struct : M.mep, o.kind === "beam" || o.kind === "bulkhead" ? "struct" : "mep");
          m.position.set((o.x0 + o.x1) / 2, y0 + (o.z0 + o.z1) / 2, -(o.y0 + o.y1) / 2); g.add(m); addEdges(m, g);
          reg(o.id, m, { kind: o.kind, level: lv.id, label: o.name });
        });
      });
      finishModel();
    }

    // ---------- Presentation state ----------
    let spec = null, subj = new Map(), relatedKeys = new Set(), subjOfEl = new Map(), elOfSubj = new Map();
    const pres = { show: "everything", levels: "stacked", cutLevel: null, walls: "cutaway", view: "3d", overlays: [] };
    let selected = null, insetTop = 0, insetBottom = 0;
    const listeners = { select: [], frame: [], pick: [] };
    const measures = [];
    function applyInsets() {
      const w = W(), h = Math.max(1, H()), shift = (insetTop - insetBottom) / 2, fullH = h + 2 * Math.abs(shift);
      persp.aspect = w / fullH;
      if (shift !== 0) persp.setViewOffset(w, fullH, 0, shift > 0 ? 0 : 2 * Math.abs(shift), w, h); else persp.clearViewOffset();
      persp.updateProjectionMatrix();
    }
    const fitScale = () => { const h = H(), fullH = h + Math.abs(insetTop - insetBottom); return fullH / Math.max(120, h - insetTop - insetBottom); };
    // Linked meshes use MeshKey "linkInstanceId:elementId"; specs usually send bare Revit ids.
    function resolveElementKey(raw) {
      if (raw == null || raw === "") return null;
      const id = String(raw);
      if (elements.has(id)) return id;
      for (const key of elements.keys()) {
        if (key.endsWith(":" + id) || key.endsWith("|" + id)) return key;
      }
      for (const [key, info] of elementInfo) {
        if (info && String(info.elementId) === id) return key;
      }
      return null;
    }
    const keyOf = id => {
      const s = String(id);
      if (elements.has(s)) return s;
      const mapped = elOfSubj.get(s);
      if (mapped && elements.has(mapped)) return mapped;
      return resolveElementKey(s) || s;
    };
    const meshesOf = id => elements.get(keyOf(id)) || [];
    // Specs may send a Revit level id or the level name (e.g. "SFL 8.75_2/F").
    const levelById = id => {
      if (id == null || id === "") return null;
      const key = String(id);
      return levels.find(l => l.id === key)
        || levels.find(l => l.name === key)
        || levels.find(l => String(l.name).toLowerCase() === key.toLowerCase())
        || null;
    };
    const levelOf = id => {
      const s = subj.get(id);
      if (s) {
        const raw = (s.geometry && s.geometry.level != null) ? s.geometry.level : (s.level || s.place || null);
        if (raw != null && raw !== "") {
          const L = levelById(raw);
          return L ? L.id : String(raw);
        }
      }
      const ms = meshesOf(id);
      return ms.length ? ms[0].userData.level : null;
    };
    const levelIndex = id => { const L = levelById(id); return L ? L.index : -1; };
    const offsetOf = L => (L.targetY !== undefined ? L.targetY : L.group.position.y);

    function matFromDisplayColor(hex, role) {
      if (!hex || typeof hex !== "string") return null;
      const key = "dc:" + hex.toLowerCase();
      if (M[key]) return M[key];
      try {
        const c = new THREE.Color(hex).convertSRGBToLinear();
        M[key] = new THREE.MeshLambertMaterial({ color: c, clippingPlanes: [clipPlane], side: THREE.DoubleSide });
        return M[key];
      } catch (_) { return null; }
    }
    function matFor(role, L, displayColor, glazed) {
      if (role === "glass" || glazed) {
        if (source !== "mesh" || !LOW_ROLES.has("glass") || !L) return M.glass;
        if (!L.mats.glass) { const m = M.glass.clone(); m.clippingPlanes = [clipPlane, L.lowPlane]; L.mats.glass = m; }
        return L.mats.glass;
      }
      const tinted = matFromDisplayColor(displayColor, role);
      if (tinted) {
        if (source !== "mesh" || !LOW_ROLES.has(role) || !L) return tinted;
        const k = "dc:" + String(displayColor).toLowerCase() + ":L" + L.id;
        if (!L.mats[k]) { const m = tinted.clone(); m.clippingPlanes = [clipPlane, L.lowPlane]; L.mats[k] = m; }
        return L.mats[k];
      }
      if (source !== "mesh" || !LOW_ROLES.has(role) || !L) return M[role] || M.wall;
      if (!L.mats[role]) { const m = (M[role] || M.wall).clone(); m.clippingPlanes = [clipPlane, L.lowPlane]; L.mats[role] = m; }
      return L.mats[role];
    }

    function buildOverlays() {
      levels.forEach(L => { [...L.overlay.children].forEach(c => { if (c.isMesh && c.userData.id) unreg(c); L.overlay.remove(c); if (c.geometry) c.geometry.dispose(); }); });
      measures.length = 0;
      if (!spec) return;
      const mcfg = (spec.presentation && spec.presentation.measure) || {};
      subj.forEach(s => {
        const L = levelById(levelOf(s.id)); if (!L) return;
        const y0 = L.elev;
        if (s.geometry) {
          const gm = s.geometry, w = gm.x1 - gm.x0, d = gm.y1 - gm.y0, h = gm.z1 - gm.z0;
          const vol = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M["vol-" + s.status]); vol.position.set(gm.x0 + w / 2, y0 + gm.z0 + h / 2, -(gm.y0 + d / 2)); vol.renderOrder = 4;
          const ve = new THREE.LineSegments(new THREE.EdgesGeometry(vol.geometry), M["vedge-" + s.status]); ve.position.copy(vol.position);
          const foot = new THREE.Mesh(new THREE.PlaneGeometry(w, d), M["halo-" + s.status]); foot.rotation.x = -Math.PI / 2; foot.position.set(gm.x0 + w / 2, y0 + 0.06, -(gm.y0 + d / 2));
          L.overlay.add(vol, ve, foot); reg(s.id, vol, { kind: "zone", level: L.id, label: s.label });
          if (pres.overlays.includes("measure") && s.values) {
            const val = s.values[mcfg.value || "clear"], req = s.values[mcfg.required || "required"];
            const cz = -(gm.y0 + d / 2), px = gm.x1 + 0.6;
            const seg = (a, b) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), M.dim); l.renderOrder = 6; return l; };
            L.overlay.add(seg(new THREE.Vector3(px, y0 + 0.05, cz), new THREE.Vector3(px, y0 + gm.z1, cz)), seg(new THREE.Vector3(px - 0.3, y0 + 0.05, cz), new THREE.Vector3(px + 0.3, y0 + 0.05, cz)), seg(new THREE.Vector3(px - 0.3, y0 + gm.z1, cz), new THREE.Vector3(px + 0.3, y0 + gm.z1, cz)));
            if (typeof req === "number") { const ry = y0 + req; const loop = [[gm.x0, gm.y0], [gm.x1, gm.y0], [gm.x1, gm.y1], [gm.x0, gm.y1], [gm.x0, gm.y0]].map(([x, y]) => new THREE.Vector3(x, ry, -y)); const rl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop), M.req); rl.computeLineDistances(); rl.renderOrder = 6; L.overlay.add(rl); }
            measures.push({ id: s.id, group: L.group, mid: new THREE.Vector3(px + 0.5, y0 + gm.z1 * 0.55, cz), text: fmtM(val, mcfg.unit), sub: typeof req === "number" ? `needs ${fmtM(req, mcfg.unit)}` : "" });
          }
        } else {
          const ms = meshesOf(s.id); if (!ms.length) return;
          const b = new THREE.Box3(); ms.forEach(m => { m.updateWorldMatrix(true, false); b.expandByObject(m); });
          const c = b.getCenter(new THREE.Vector3()); L.group.worldToLocal(c);
          if (pres.overlays.includes("measure") && s.values && typeof s.values[mcfg.value] === "number") {
            const req = s.values[mcfg.required];
            measures.push({ id: s.id, group: L.group, mid: new THREE.Vector3(c.x, y0 + 1.2, c.z), text: fmtM(s.values[mcfg.value], mcfg.unit), sub: typeof req === "number" ? `needs ${fmtM(req, mcfg.unit)}` : "" });
          }
          if (ms[0].userData.kind === "door") { const hl = new THREE.Mesh(new THREE.CircleGeometry(0.85, 40), M["halo-" + s.status]); hl.rotation.x = -Math.PI / 2; hl.position.set(c.x, y0 + 0.07, c.z); hl.renderOrder = 3; L.overlay.add(hl); }
        }
      });
    }

    function styleLinkMaterial(mesh, mat) {
      const id = mesh && mesh.userData && mesh.userData.linkId;
      if (!id || !mat) return mat;
      const st = linkStyles.get(String(id));
      if (!st) return mat;
      const color = st.color || "";
      const fade = typeof st.opacity === "number" ? st.opacity : 1;
      if (!color && fade >= 0.999) return mat;
      const baseOp = mat.transparent ? (typeof mat.opacity === "number" ? mat.opacity : 1) : 1;
      const op = Math.max(0.04, Math.min(1, baseOp * fade));
      const key = mat.uuid + "|" + color + "|" + op.toFixed(3);
      let styled = linkMatCache.get(key);
      if (!styled) {
        styled = mat.clone();
        if (color) {
          try {
            styled.color = new THREE.Color(color);
            if (styled.emissive) { styled.emissive = styled.color.clone(); styled.emissiveIntensity = 0.08; }
          } catch (_) { /* keep the base colour */ }
        }
        styled.transparent = op < 0.98;
        styled.opacity = op;
        styled.depthWrite = op > 0.85 && !mat.transparent;
        linkMatCache.set(key, styled);
      }
      return styled;
    }
    // Failures / Shell+fails / Full model — three distinct presentation jobs.
    const SHELL_ROLES = new Set(["wall", "curtain", "glass", "door", "slab", "roof", "ceiling", "stair", "railing", "struct", "opening", "site"]);
    const CLUTTER_ROLES = new Set(["mep", "plumbing", "light", "furn", "equip", "generic", "vertical", "other", "link"]);
    function paint() {
      const cutIdx = pres.levels === "cut" && pres.cutLevel ? levelIndex(pres.cutLevel) : -1;
      const cutL = cutIdx >= 0 ? levels[cutIdx] : null;
      const xray = pres.show === "failures-only";
      const context = pres.show === "in-context" && subj.size > 0;
      const everything = pres.show === "everything" || (!xray && !context);
      clipPlane.constant = cutL ? cutL.elev + offsetOf(cutL) + CUT_H : 1e6;
      const subjLevels = new Set([...subj.keys()].map(levelOf));
      levels.forEach(L => {
        const i = L.index, below = cutL && i < cutIdx, quiet = !subjLevels.has(L.id) && (xray || pres.levels === "exploded") && subj.size > 0;
        L.quiet = quiet;
        L.group.visible = !(cutL && i > cutIdx);
        L.lowPlane.constant = 1e6;
        L.group.traverse(o => {
          if (o.parent && o.parent.userData.overlay) return;
          if (o.userData.low) { o.scale.y = 1; o.position.y = o.userData.low.y0 + o.userData.low.h / 2; }
          if (o.userData.head) { o.visible = !xray; return; }
          if (o.isLineSegments) {
            if (o.userData.of && !passesFacet(o.userData.of)) { o.visible = false; return; }
            if (o.userData.of) { o.scale.copy(o.userData.of.scale); o.position.copy(o.userData.of.position); }
            const of = o.userData.of, ofKey = of && of.userData.id, ofRole = of && of.userData.role;
            const ofSubj = ofKey && (subj.has(ofKey) || subjOfEl.has(ofKey));
            if (xray) {
              if (ofSubj || (ofKey && relatedKeys.has(ofKey))) { o.visible = true; o.material = M.edge; return; }
              if (CLUTTER_ROLES.has(ofRole) || ofRole === "volume" || ofRole === "glass" || ofRole === "ceiling") { o.visible = false; return; }
              o.visible = true; o.material = quiet ? M.xrayFaint : M.xray; return;
            }
            if (context) {
              if (ofSubj) { o.visible = true; o.material = M.edge; return; }
              if (CLUTTER_ROLES.has(ofRole)) { o.visible = true; o.material = M.contextDimEdge; return; }
              o.visible = ofRole !== "ceiling" || !cutL;
              o.material = below || quiet ? M.xray : M.edge; return;
            }
            o.visible = ofRole !== "ceiling" || everything;
            o.material = below ? M.xray : M.edge; return;
          }
          if (!o.isMesh) return;
          if (!passesFacet(o)) { o.visible = false; return; }
          const key = o.userData.id, sid = key && (subj.has(key) ? key : subjOfEl.get(key)), s = sid && subj.get(sid), role = o.userData.role;
          const lid = o.userData.linkId;
          if (lid && hiddenLinks.has(String(lid))) { o.visible = false; return; }
          if (role === "link" && hiddenLinks.has(String(key))) { o.visible = false; return; }
          if (role === "volume" && (!showSpaces || hiddenRoles.has("volume"))) { o.visible = false; return; }
          if (!o.userData.low) o.scale.y = 1;
          // Always colour subject meshes by status.
          if (s) {
            o.visible = true;
            o.material = styleLinkMaterial(o, role === "volume" ? M["vol-" + s.status] : (o.userData.kind === "room" || o.userData.kind === "step") ? M["fill-" + s.status] : M["st-" + s.status]);
            if (o.userData.kind === "room" && source === "sample") o.scale.y = 3;
            return;
          }
          // Failures: shell as thin x-ray; hide non-result clutter so red pops.
          if (xray) {
            if (key && relatedKeys.has(key)) {
              o.visible = true;
              o.material = styleLinkMaterial(o, matFor(role, null, o.userData.displayColor, o.userData.glazed));
              return;
            }
            if (CLUTTER_ROLES.has(role) || role === "volume" || role === "glass" || role === "ceiling") { o.visible = false; return; }
            o.visible = SHELL_ROLES.has(role) || source === "mesh";
            o.material = styleLinkMaterial(o, M.xrayFill);
            return;
          }
          // Shell + fails: architecture readable; MEP / furniture / lights dimmed.
          if (context) {
            if (role === "volume") { o.visible = true; o.material = styleLinkMaterial(o, M.volume); return; }
            if (CLUTTER_ROLES.has(role)) {
              o.visible = true;
              o.material = styleLinkMaterial(o, M.contextDim);
              return;
            }
            if (role === "ceiling") { o.visible = !cutL; o.material = styleLinkMaterial(o, M.ceiling); return; }
            o.visible = true;
            o.material = styleLinkMaterial(o, below || quiet ? M.ghost : matFor(role, o.userData.levelRef || L, o.userData.displayColor, o.userData.glazed));
            return;
          }
          // Full model: every category at normal materials (subjects already painted above).
          if (role === "volume") { o.visible = true; o.material = styleLinkMaterial(o, M.volume); return; }
          if (role === "ceiling") { o.visible = !cutL; o.material = styleLinkMaterial(o, M.ceiling); return; }
          o.visible = true;
          o.material = styleLinkMaterial(o, below || quiet ? M.ghost : matFor(role, o.userData.levelRef || L, o.userData.displayColor, o.userData.glazed));
        });
      });
      scaleBar.children.forEach(c => c.material = M.scale);
      placeScaleBar();
      ground.visible = !xray;
    }

    function placeScaleBar() {
      const cutIdx = pres.levels === "cut" && pres.cutLevel ? levelIndex(pres.cutLevel) : -1;
      const L = levels.find(l => l.group.visible && (cutIdx < 0 || l.index === cutIdx)) || levels[0];
      if (!L) { scaleBar.visible = false; return; }
      scaleBar.visible = true;
      scaleBar.position.set(L.box.min.x, L.elev + offsetOf(L) + 0.02, L.box.max.z + 2.2);
    }
    function scaleAnchors() { if (!scaleBar.visible) return []; return [0, 5, 10].map(x => { const w = new THREE.Vector3(x, 0, 0); scaleBar.localToWorld(w); const s = toScreen(w); return s && { x: s.x, y: s.y, t: x === 10 ? "10 m" : String(x) }; }).filter(Boolean); }
    function placeLevels(instant) {
      const gap = explodeGap * Math.max(0.05, explodeScale);
      levels.forEach(L => { L.targetY = pres.levels === "exploded" ? L.index * gap : 0; if (instant || reduced()) L.group.position.y = L.targetY; });
    }

    function setSpec(s, instant = true) {
      spec = s; subj = new Map((s.subjects || []).map(x => [x.id, x]));
      subjOfEl = new Map(); elOfSubj = new Map(); relatedKeys = new Set();
      (s.subjects || []).forEach(x => {
        // Subjects with derived geometry (clash box, clear-height zone) keep their own id as the
        // mesh key. Mapping them onto a long host duct made pins sit on the duct centre.
        if (!x.geometry) {
          const candidates = [x.id, x.revit_id != null ? String(x.revit_id) : null].filter(Boolean);
          let k = null;
          for (const c of candidates) { k = resolveElementKey(c); if (k) break; }
          if (k) { subjOfEl.set(k, x.id); elOfSubj.set(x.id, k); if (String(x.id) !== k) elOfSubj.set(String(x.revit_id || x.id), k); }
        }
        (x.related || []).forEach(r => {
          const rk = resolveElementKey(r) || (elements.has(String(r)) ? String(r) : null);
          if (rk) relatedKeys.add(rk);
        });
      });
      const p = s.presentation || {};
      pres.show = p.show || "in-context";
      // Always open stacked — exploded is a user choice (Spread slider), not the default first view.
      let lvlMode = p.levels || (s.view && s.view.level ? "cut" : "stacked");
      if (lvlMode === "exploded") lvlMode = "stacked";
      pres.levels = lvlMode;
      const cutL = s.view && s.view.level ? levels.find(l => l.name === s.view.level || l.id === String(s.view.level)) : null;
      pres.cutLevel = cutL ? cutL.id : null;
      if (pres.levels === "cut" && !cutL) pres.levels = "stacked";
      pres.overlays = p.overlays || [];
      pres.walls = "cutaway"; pres.view = "3d"; camera = persp; controls.enabled = true; orthoControls.enabled = false;
      select(null, false);
      placeLevels(true); root.updateMatrixWorld(true);
      buildOverlays(); paint(); home(instant);
    }
    function clearSpec() { spec = null; subj = new Map(); subjOfEl = new Map(); elOfSubj = new Map(); relatedKeys = new Set(); buildOverlays(); pres.show = "everything"; pres.levels = "stacked"; paint(); home(true); }
    function setShow(v) { pres.show = v; paint(); home(); }
    function setLevels(mode, levelId, noHome) { pres.levels = mode; if (levelId !== undefined) pres.cutLevel = levelId; placeLevels(false); paint(); if (!noHome) home(); }
    function setExplodeScale(v, opts) {
      const n = Number(v);
      if (!Number.isFinite(n)) return explodeScale;
      explodeScale = Math.min(2, Math.max(0.2, n));
      if (pres.levels === "exploded") {
        placeLevels(!!(opts && opts.instant));
        paint();
        if (!(opts && opts.noHome)) home(false);
      }
      return explodeScale;
    }
    function getExplodeScale() { return explodeScale; }
    function focusOn(id) {
      const lvl = levelOf(id);
      // Always cut to the subject's storey when focusing a list/callout item — staying in
      // exploded/stacked made the camera move too subtle to notice ("viewer didn't refresh").
      if (lvl && !(pres.levels === "cut" && String(pres.cutLevel) === String(lvl))) setLevels("cut", lvl, true);
      root.updateMatrixWorld(true); flyTo(id); drawRing();
    }
    function setView(v) { pres.view = v; camera = v === "plan" ? ortho : persp; controls.enabled = v !== "plan"; orthoControls.enabled = v === "plan"; home(true); }

    // ---------- Camera ----------
    const tween = { t: 1 };
    function isShown(o) { let p = o; while (p) { if (!p.visible) return false; p = p.parent; } return true; }
    function bboxIds(ids) {
      const b = new THREE.Box3();
      ids.forEach(id => {
        const ms = meshesOf(id);
        // Prefer visible meshes; if none (e.g. volume still hidden), fall back so focus/fly still works.
        const use = ms.some(isShown) ? ms.filter(isShown) : ms;
        use.forEach(m => { m.updateWorldMatrix(true, false); b.expandByObject(m); });
      });
      return b;
    }
    function buildingBox() {
      const b = new THREE.Box3();
      const cutIdx = pres.levels === "cut" && pres.cutLevel ? levelIndex(pres.cutLevel) : -1;
      levels.forEach(L => {
        if (!L.group.visible || (cutIdx >= 0 && L.index !== cutIdx)) return;
        const lb = L.box.clone(); lb.min.y += offsetOf(L); lb.max.y = cutIdx >= 0 ? L.elev + offsetOf(L) + CUT_H + 0.05 : lb.max.y + offsetOf(L);
        b.union(lb);
      });
      return b.isEmpty() ? bounds.clone() : b;
    }
    function home(instant = false) {
      const bb = buildingBox(), target = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
      if (pres.view === "plan") {
        ortho.up.set(0, 0, -1); ortho.position.set(target.x, bb.max.y + 200, target.z + 0.001); ortho.lookAt(target.x, 0, target.z); orthoControls.target.set(target.x, 0, target.z);
        fitOrtho(size.x + 6, size.z + 6); orthoControls.update(); return;
      }
      const dir = new THREE.Vector3(0.6, 0.62, 0.5).normalize();
      const vfov = THREE.MathUtils.degToRad(persp.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * persp.aspect);
      const tmpCam = persp.clone(); tmpCam.position.copy(target).add(dir.clone().multiplyScalar(100)); tmpCam.lookAt(target); tmpCam.updateMatrixWorld();
      const inv = tmpCam.matrixWorldInverse, c = target.clone().applyMatrix4(inv); let hx = 0, hy = 0, hz = 0;
      [bb.min.x, bb.max.x].forEach(x => [bb.min.y, bb.max.y].forEach(y => [bb.min.z, bb.max.z].forEach(z => { const v = new THREE.Vector3(x, y, z).applyMatrix4(inv); hx = Math.max(hx, Math.abs(v.x - c.x)); hy = Math.max(hy, Math.abs(v.y - c.y)); hz = Math.max(hz, Math.abs(v.z - c.z)); })));
      const dist = Math.max(hx / Math.tan(hfov / 2), hy / Math.tan(vfov / 2)) * fitScale() + hz * 0.45;
      go({ pos: target.clone().add(dir.multiplyScalar(Math.max(dist, 5))), tgt: target.clone() }, instant);
    }
    function go(to, instant) {
      if (instant || reduced()) { persp.position.copy(to.pos); controls.target.copy(to.tgt); controls.update(); tween.t = 1; return; }
      tween.from = { pos: persp.position.clone(), tgt: controls.target.clone() }; tween.to = to; tween.t = 0;
    }
    function flyTo(id) {
      if (pres.view === "plan") return;
      const b = bboxIds([id]); if (b.isEmpty()) return;
      const c = b.getCenter(new THREE.Vector3()), r = Math.max(4, b.getSize(new THREE.Vector3()).length());
      const dir = new THREE.Vector3(0.55, 0.85, 0.6).normalize();
      go({ pos: c.clone().add(dir.multiplyScalar(r * 1.3 + 16)), tgt: c }, false);
    }
    function flyToIds(ids) {
      const b = new THREE.Box3(); ids.forEach(id => { const bb = bboxIds([String(id)]); if (!bb.isEmpty()) b.union(bb); });
      if (b.isEmpty()) return false;
      const c = b.getCenter(new THREE.Vector3()), r = Math.max(4, b.getSize(new THREE.Vector3()).length());
      go({ pos: c.clone().add(new THREE.Vector3(0.55, 0.85, 0.6).normalize().multiplyScalar(r * 1.3 + 16)), tgt: c }, false); return true;
    }
    function fitOrtho(w, d) { const a = W() / Math.max(1, H()); let hw = w / 2, hh = d / 2; if (hw / hh > a) hh = hw / a; else hw = hh * a; Object.assign(ortho, { left: -hw, right: hw, top: hh, bottom: -hh, zoom: 1 }); ortho.updateProjectionMatrix(); }

    function drawRing() {
      while (ringGroup.children.length) ringGroup.remove(ringGroup.children[0]);
      if (!selected) return;
      const b = bboxIds([selected]); if (b.isEmpty()) return;
      const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3()), r = Math.max(0.9, Math.min(4.5, Math.max(s.x, s.z) * 0.55));
      [[r, r + 0.14, 0.95], [r + 0.38, r + 0.44, 0.4]].forEach(([a, z, op]) => { const m = new THREE.Mesh(new THREE.RingGeometry(a, z, 64), M.ring.clone()); m.material.opacity = op; m.rotation.x = -Math.PI / 2; m.position.set(c.x, b.min.y + 0.08, c.z); m.renderOrder = 10; ringGroup.add(m); });
    }
    function select(id, fromPick) { selected = id || null; drawRing(); if (fromPick) listeners.select.forEach(f => f(selected)); }

    // ---------- Picking ----------
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    function hitAt(cx, cy) {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera);
      return ray.intersectObjects(pickables.filter(m => isShown(m) && m.material !== M.xrayFill && m.material !== M.ghost), false).filter(h => clipPlane.constant > 1e5 || clipPlane.distanceToPoint(h.point) >= 0);
    }
    function subjectFromHits(hits) {
      for (const h of hits) {
        const key = h.object.userData.id; if (!key) continue;
        if (subj.has(key)) return key;
        if (subjOfEl.has(key)) return subjOfEl.get(key);
        const info = elementInfo.get(key);
        if (info && info.elementId != null) {
          const eid = String(info.elementId);
          if (subj.has(eid)) return eid;
          if (subjOfEl.has(key)) return subjOfEl.get(key);
          const hit = [...subj.values()].find(s => String(s.revit_id) === eid || String(s.id) === eid);
          if (hit) return hit.id;
        }
        const owner = [...subj.values()].find(s => (s.related || []).map(String).includes(key) || (info && (s.related || []).map(String).includes(String(info.elementId))));
        if (owner) return owner.id;
      }
      return null;
    }
    let down = null, hoverCb = null;
    renderer.domElement.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener("pointerup", e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const hits = hitAt(e.clientX, e.clientY);
      const sid = subjectFromHits(hits);
      select(sid, true);
      const first = hits.find(h => h.object.userData.id && h.object.userData.kind !== "zone");
      listeners.pick.forEach(f => f(first ? first.object.userData.id : null, first ? elementInfo.get(first.object.userData.id) : null));
    });
    renderer.domElement.addEventListener("dblclick", e => { const sid = subjectFromHits(hitAt(e.clientX, e.clientY)); if (sid) flyTo(sid); });
    renderer.domElement.addEventListener("pointermove", e => { if (!hoverCb || e.buttons) return; const sid = subjectFromHits(hitAt(e.clientX, e.clientY)); renderer.domElement.style.cursor = sid ? "pointer" : ""; hoverCb(sid ? { id: sid, x: e.clientX, y: e.clientY } : null); });

    // ---------- Screen anchors ----------
    function toScreen(v) { const p = v.clone().project(camera); if (p.z > 1 || p.z < -1) return null; return { x: (p.x + 1) / 2 * W(), y: (1 - p.y) / 2 * H() }; }
    function occluded(v, own) {
      const origin = camera.isOrthographicCamera ? new THREE.Vector3(v.x, camera.position.y, v.z) : camera.position.clone();
      const dist = origin.distanceTo(v); ray.set(origin, v.clone().sub(origin).normalize());
      const hits = ray.intersectObjects(pickables.filter(m => isShown(m) && m.material !== M.glass && m.material !== M.ghost && m.material !== M.xrayFill && m.userData.kind !== "zone" && m.userData.role !== "volume"), false)
        .filter(h => h.distance < dist - 0.4 && (clipPlane.constant > 1e5 || clipPlane.distanceToPoint(h.point) >= 0));
      return hits.length > 0 && !own.includes(hits[0].object.userData.id);
    }
    function anchorOf(id) {
      const sb = subj.get(id);
      // Clash / clearance volumes: pin on the overlay box, not on a long host duct that only
      // shares revit_id with the subject (that put numbered pins metres away from the clash).
      let b = new THREE.Box3();
      if (sb && sb.geometry) {
        const zones = (elements.get(String(id)) || []).filter(m => m && m.userData && m.userData.kind === "zone");
        zones.forEach(m => { m.updateWorldMatrix(true, false); b.expandByObject(m); });
      }
      if (b.isEmpty()) b = bboxIds([id]);
      if (b.isEmpty()) return null;
      const v = b.getCenter(new THREE.Vector3()); v.y = Math.min(b.max.y, v.y + 0.6);
      if (clipPlane.constant < 1e5 && clipPlane.distanceToPoint(v) < 0) v.y = clipPlane.constant - 0.1;
      const s = toScreen(v); if (!s) return null;
      return Object.assign(s, { occluded: occluded(v, [id, keyOf(id), ...((sb && sb.related) || []).map(String)]) });
    }
    function measureAnchors() { return measures.filter(m => m.group.visible).map(m => { const w = m.mid.clone(); m.group.localToWorld(w); const s = toScreen(w); return s && { id: m.id, x: s.x, y: s.y, text: m.text, sub: m.sub }; }).filter(Boolean); }
    function levelAnchors() { return levels.filter(L => L.group.visible).map(L => { const w = new THREE.Vector3(L.box.min.x, L.elev, L.box.max.z); L.group.localToWorld(w); const s = toScreen(w); return s && { id: L.id, name: L.name, x: s.x, y: s.y, quiet: !!L.quiet }; }).filter(Boolean); }
    function compassAngle() { const c = bounds.getCenter(new THREE.Vector3()); c.y = bounds.min.y; const a = toScreen(c), b = toScreen(c.clone().add(new THREE.Vector3(0, 0, -10))); if (!a || !b) return 0; return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90; }

    // ---------- Loop ----------
    let raf = 0, running = true;
    const camDir = new THREE.Vector3();
    function frame() {
      raf = requestAnimationFrame(frame);
      if (!running) return;
      let moving = false;
      levels.forEach(L => { if (Math.abs(L.group.position.y - L.targetY) > 0.005) { L.group.position.y += (L.targetY - L.group.position.y) * 0.14; moving = true; } });
      if (moving) { const cutIdx = pres.levels === "cut" && pres.cutLevel ? levelIndex(pres.cutLevel) : -1; const low = pres.show === "in-context" && cutIdx < 0; levels.forEach(L => { L.lowPlane.constant = low ? L.elev + L.group.position.y + LOW_WALL : 1e6; }); placeScaleBar(); if (selected) drawRing(); }
      if (tween.t < 1 && tween.to) { tween.t = Math.min(1, tween.t + 1 / 42); const k = 1 - Math.pow(1 - tween.t, 4); persp.position.lerpVectors(tween.from.pos, tween.to.pos, k); controls.target.lerpVectors(tween.from.tgt, tween.to.tgt, k); }
      (camera === persp ? controls : orthoControls).update();
      camera.getWorldDirection(camDir);
      const xray = pres.show === "failures-only";
      facades.forEach(f => { f.children.forEach(c => { if (c.isMesh) c.visible = !xray; }); f.visible = xray || pres.walls === "up" || (pres.view !== "plan" && f.userData.normal.dot(camDir) > -0.15); });
      renderer.render(scene, camera);
      listeners.frame.forEach(fn => fn());
    }
    frame();
    const ro = new ResizeObserver(() => { renderer.setSize(W(), Math.max(1, H())); applyInsets(); if (pres.view === "plan") home(true); });
    ro.observe(container);

    return {
      loadMesh, applyDelta, loadSample, setSpec, clearSpec, setShow, setLevels, setExplodeScale, getExplodeScale, setView, home, select, flyTo, flyToIds, focusOn,
      linkList() {
        const by = new Map();
        elementInfo.forEach(info => {
          if (!info.linkId) return;
          if (!by.has(info.linkId)) by.set(info.linkId, { id: info.linkId, name: info.name || info.linkId });
        });
        return [...by.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      },
      isLinkHidden(id) { return hiddenLinks.has(String(id)); },
      clearFacet,
      facetActive() { return hiddenRoles.size > 0 || hiddenModels.size > 0; },
      facetOn(kind, id) {
        const set = kind === "models" ? hiddenModels : hiddenRoles;
        return !set.has(String(id));
      },
      setFacetVisible,
      facetSummary() {
        const roles = new Map();
        const models = new Map();
        elementInfo.forEach(info => {
          const role = info.role || "furn";
          const id = info.linkId ? String(info.linkId) : "host";
          const name = info.linkId ? (info.modelName || info.name || "Link") : "Host";
          const row = models.get(id) || { id, name, count: 0 };
          row.count += 1;
          if (!info.linkId) row.name = "Host";
          models.set(id, row);
          // Categories follow the Models checkboxes above — only count what is still shown.
          if (hiddenModels.has(id)) return;
          roles.set(role, (roles.get(role) || 0) + 1);
        });
        const roleOrder = ["wall", "curtain", "glass", "door", "slab", "roof", "ceiling", "stair", "railing", "vertical", "struct", "mep", "plumbing", "light", "furn", "equip", "site", "generic", "volume", "other", "link"];
        return {
          roles: [...roles.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => roleOrder.indexOf(a.id) - roleOrder.indexOf(b.id)),
          models: [...models.values()].sort((a, b) => (a.id === "host" ? -1 : b.id === "host" ? 1 : String(a.name).localeCompare(String(b.name)))),
        };
      },
      spaceCount() { let n = 0; elementInfo.forEach(info => { if (info.role === "volume") n++; }); return n; },
      spacesVisible() { return showSpaces && !hiddenRoles.has("volume"); },
      setSpacesVisible(on) {
        showSpaces = !!on;
        if (on) hiddenRoles.delete("volume");
        else hiddenRoles.add("volume");
        paint();
        return showSpaces && !hiddenRoles.has("volume");
      },
      getLinkStyle(id) { return linkStyles.get(String(id)) || { color: null, opacity: 1 }; },
      setLinkStyle(id, patch) {
        const key = String(id);
        const cur = linkStyles.get(key) || { color: null, opacity: 1 };
        const next = {
          color: patch && Object.prototype.hasOwnProperty.call(patch, "color") ? (patch.color || null) : cur.color,
          opacity: patch && typeof patch.opacity === "number" ? Math.max(0.05, Math.min(1, patch.opacity)) : cur.opacity,
        };
        if (!next.color && next.opacity >= 0.999) linkStyles.delete(key);
        else linkStyles.set(key, next);
        paint();
        return next;
      },
      setInsets(top, bottom = 0) { const t = Math.max(0, Math.round(top)), b = Math.max(0, Math.round(bottom)); if (t === insetTop && b === insetBottom) return; insetTop = t; insetBottom = b; applyInsets(); },
      anchorOf, measureAnchors, levelAnchors, scaleAnchors, compassAngle,
      capture(opts = {}) { const mime = opts.format === "jpeg" ? "image/jpeg" : "image/png"; renderer.render(scene, camera); return renderer.domElement.toDataURL(mime, opts.quality || 0.9); },
      get presentation() { return { ...pres }; }, get selected() { return selected; }, get hasModel() { return levels.length > 0; }, get source() { return source; },
      get levelList() { return levels.map(l => ({ id: l.id, name: l.name })); },
      info(id) { return elementInfo.get(String(id)); },
      setRendering(on) { running = !!on; },
      on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }, onHover(fn) { hoverCb = fn; },
      retheme() { linkMatCache.clear(); makeMaterials(); root.traverse(o => { if (o.isMesh && o.userData.role && !o.parent.userData.overlay) o.material = styleLinkMaterial(o, matFor(o.userData.role, o.userData.levelRef, o.userData.displayColor, o.userData.glazed)); }); if (spec) buildOverlays(); paint(); drawRing(); },
      dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); },
    };
  }
  window.AgentCanvas3D = { createViewer, roleOf };
})();

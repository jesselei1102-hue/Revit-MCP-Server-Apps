import { App, applyHostFonts } from "@modelcontextprotocol/ext-apps";

type TextContent = { type: string; text?: string };
type ToolResult = {
  content?: TextContent[];
  structuredContent?: ScheduleData | FamilyTypeInfo[];
  isError?: boolean;
};

type ScheduleData = {
  columns?: string[];
  rows?: Record<string, string>[];
  matchedCount?: number;
  totalMatched?: number;
  truncated?: boolean;
  message?: string | null;
  dashboard?: {
    errorCount?: number;
    warningCount?: number;
    detachableFamilyCount?: number;
  };
};

type FilterState = {
  link: string;
  level: string;
  category: string;
  family: string;
  type: string;
  search: string;
};

type ApplyMode = "select" | "isolate";

type FamilyTypeInfo = {
  FamilyTypeId?: number;
  familyTypeId?: number;
  FamilyName?: string;
  familyName?: string;
  TypeName?: string;
  typeName?: string;
  Category?: string;
  category?: string;
};

type PendingType = { typeId: number; family: string; type: string };
type PendingParam = { elementId: number; name: string; value: string };
type SelectedCell = { rowIndex: number; column: string };
type FillKind = "type" | "param";

const IDENTITY_COLUMNS = new Set([
  "elementId",
  "link",
  "linkInstanceId",
  "name",
  "category",
  "family",
  "type",
  "level",
]);
const CALCULATED_COLUMNS = new Set([
  "Area",
  "Volume",
  "Perimeter",
  "Surface Area",
  "Gross Volume",
  "Gross Area",
  "面积",
  "体积",
  "周长",
  "表面积",
  "length",
]);

let columns: string[] = [];
let allRows: Record<string, string>[] = [];
let lastArgs: Record<string, unknown> = {};
const checked = new Set<number>();
/** Pending type edits before Apply type changes. */
const pendingTypes = new Map<number, PendingType>();
/** Pending parameter edits before Apply parameters. Key = `${elementId}\\0${name}` */
const pendingParams = new Map<string, PendingParam>();
const typesByCategory = new Map<string, FamilyTypeInfo[]>();
const typesLoading = new Set<string>();
let selectedCell: SelectedCell | null = null;
/** Editable parameter columns the user chose to show in the table. */
const selectedParamColumns = new Set<string>();
let availableParamColumns: string[] = [];
let paramPickerSearch = "";
let paramPickerInitialized = false;

const DEFAULT_PARAM_PREFS = ["Mark", "Comments", "标记", "注释"];

const filters: FilterState = {
  link: "",
  level: "",
  category: "",
  family: "",
  type: "",
  search: "",
};

const table = document.getElementById("table-container")!;
const status = document.getElementById("status")!;
const filterLink = document.getElementById("filter-link") as HTMLSelectElement;
const filterLevel = document.getElementById("filter-level") as HTMLSelectElement;
const filterCategory = document.getElementById("filter-category") as HTMLSelectElement;
const filterFamily = document.getElementById("filter-family") as HTMLSelectElement;
const filterType = document.getElementById("filter-type") as HTMLSelectElement;
const filterSearch = document.getElementById("filter-search") as HTMLInputElement;
const paramPicker = document.getElementById("param-picker")!;
const paramPickerTrigger = document.getElementById("param-picker-trigger") as HTMLButtonElement;
const paramPickerLabel = document.getElementById("param-picker-label")!;
const paramPickerSearchInput = document.getElementById("param-picker-search") as HTMLInputElement;
const paramPickerList = document.getElementById("param-picker-list")!;
const paramPickerAll = document.getElementById("param-picker-all") as HTMLButtonElement;
const paramPickerNone = document.getElementById("param-picker-none") as HTMLButtonElement;
const btnConfirm = document.getElementById("btn-confirm") as HTMLButtonElement;
const btnApplyTypes = document.getElementById("btn-apply-types") as HTMLButtonElement;
const btnApplyParams = document.getElementById("btn-apply-params") as HTMLButtonElement;
const btnClearPending = document.getElementById("btn-clear-pending") as HTMLButtonElement;
const donutSvg = document.getElementById("donut-svg") as unknown as SVGSVGElement;
const donutLegend = document.getElementById("donut-legend")!;
const composition = document.getElementById("composition")!;
const kpiErrors = document.getElementById("kpi-errors")!;
const kpiErrorsSub = document.getElementById("kpi-errors-sub")!;
const kpiDetach = document.getElementById("kpi-detach")!;
const kpiDetachSub = document.getElementById("kpi-detach-sub")!;
let dashboardStats: ScheduleData["dashboard"] | undefined;

const CATEGORY_TO_OST: Record<string, string> = {
  Walls: "OST_Walls",
  Doors: "OST_Doors",
  Windows: "OST_Windows",
  Floors: "OST_Floors",
  Ceilings: "OST_Ceilings",
  Roofs: "OST_Roofs",
  Stairs: "OST_Stairs",
  Railings: "OST_Railings",
  Ramps: "OST_Ramps",
  Columns: "OST_Columns",
  "Structural Columns": "OST_StructuralColumns",
  "Structural Framing": "OST_StructuralFraming",
  "Structural Foundations": "OST_StructuralFoundation",
  Rooms: "OST_Rooms",
  Furniture: "OST_Furniture",
  Casework: "OST_Casework",
  "Specialty Equipment": "OST_SpecialtyEquipment",
  "Generic Models": "OST_GenericModel",
  "Mechanical Equipment": "OST_MechanicalEquipment",
  "Electrical Equipment": "OST_ElectricalEquipment",
  "Electrical Fixtures": "OST_ElectricalFixtures",
  "Lighting Fixtures": "OST_LightingFixtures",
  "Plumbing Fixtures": "OST_PlumbingFixtures",
  Pipes: "OST_PipeCurves",
  "Pipe Fittings": "OST_PipeFitting",
  "Pipe Accessories": "OST_PipeAccessory",
  Ducts: "OST_DuctCurves",
  "Duct Fittings": "OST_DuctFitting",
  "Duct Accessories": "OST_DuctAccessory",
  "Cable Trays": "OST_CableTray",
  "Cable Tray Fittings": "OST_CableTrayFitting",
  Conduits: "OST_Conduit",
  "Conduit Fittings": "OST_ConduitFitting",
  "Curtain Panels": "OST_CurtainWallPanels",
  "Curtain Wall Mullions": "OST_CurtainWallMullions",
  Parking: "OST_Parking",
  Planting: "OST_Planting",
  Site: "OST_Site",
  Topography: "OST_Topography",
  Mass: "OST_Mass",
};

const app = new App({ name: "MCP Apps · Revit Schedule", version: "1.8.0" });

type FillDrag = {
  kind: FillKind;
  column: string;
  startIndex: number;
  endIndex: number;
  pendingType?: PendingType;
  category?: string;
  paramName?: string;
  paramValue?: string;
};

let fillDrag: FillDrag | null = null;

function paramKey(elementId: number, name: string) {
  return `${elementId}\0${name}`;
}

function isParamColumn(column: string) {
  return !IDENTITY_COLUMNS.has(column) && !CALCULATED_COLUMNS.has(column);
}

function collectAvailableParamColumns(): string[] {
  return columns
    .filter((column) => isParamColumn(column))
    .sort((a, b) => a.localeCompare(b));
}

function syncParamSelectionWithAvailable() {
  availableParamColumns = collectAvailableParamColumns();
  for (const name of Array.from(selectedParamColumns)) {
    if (!availableParamColumns.includes(name)) selectedParamColumns.delete(name);
  }
  if (!paramPickerInitialized) {
    for (const pref of DEFAULT_PARAM_PREFS) {
      if (availableParamColumns.includes(pref)) selectedParamColumns.add(pref);
    }
    paramPickerInitialized = true;
  }
}

function updateParamPickerLabel() {
  const n = selectedParamColumns.size;
  const total = availableParamColumns.length;
  if (total === 0) {
    paramPickerLabel.textContent = "No editable parameters";
    return;
  }
  if (n === 0) {
    paramPickerLabel.textContent = "None selected";
    return;
  }
  if (n === total) {
    paramPickerLabel.textContent = `All parameters (${total})`;
    return;
  }
  if (n <= 2) {
    paramPickerLabel.textContent = Array.from(selectedParamColumns).join(", ");
    return;
  }
  paramPickerLabel.textContent = `${n} parameters selected`;
}

function visibleParamOptions(): string[] {
  const q = paramPickerSearch.trim().toLowerCase();
  if (!q) return availableParamColumns;
  return availableParamColumns.filter((name) => name.toLowerCase().includes(q));
}

function renderParamPickerList() {
  const opts = visibleParamOptions();
  if (opts.length === 0) {
    paramPickerList.innerHTML = `<li class="ms-empty">${
      availableParamColumns.length === 0 ? "No editable parameters loaded." : "No matches."
    }</li>`;
    updateParamPickerLabel();
    return;
  }
  paramPickerList.innerHTML = opts
    .map((name) => {
      const checked = selectedParamColumns.has(name) ? " checked" : "";
      return `<li data-param="${escapeHtml(name)}"><input type="checkbox"${checked} /><span title="${escapeHtml(
        name
      )}">${escapeHtml(name)}</span></li>`;
    })
    .join("");
  paramPickerList.querySelectorAll("li[data-param]").forEach((el) => {
    const li = el as HTMLElement;
    const name = li.dataset.param ?? "";
    const box = li.querySelector("input") as HTMLInputElement | null;
    const apply = (on: boolean) => {
      if (!name) return;
      if (on) selectedParamColumns.add(name);
      else selectedParamColumns.delete(name);
      if (box) box.checked = on;
      updateParamPickerLabel();
      render();
    };
    li.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      event.preventDefault();
      apply(!selectedParamColumns.has(name));
    });
    box?.addEventListener("change", () => apply(Boolean(box.checked)));
  });
  updateParamPickerLabel();
}

function setParamPickerOpen(open: boolean) {
  paramPicker.classList.toggle("open", open);
  paramPickerTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    renderParamPickerList();
    paramPickerSearchInput.focus();
  }
}

function refreshParamPicker() {
  syncParamSelectionWithAvailable();
  renderParamPickerList();
}

function scheduleArgs(extra?: Record<string, unknown>) {
  return {
    ...lastArgs,
    ...extra,
    parametersOutputType: "EditableInstanceParameters",
  };
}

function displayParamValue(row: Record<string, string>, column: string, elementId: number) {
  const pending = pendingParams.get(paramKey(elementId, column));
  if (pending) return pending.value;
  return row[column] ?? "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isHostRow(row: Record<string, string>): boolean {
  return !row.linkInstanceId;
}

function getApplyMode(): ApplyMode {
  const selected = document.querySelector('input[name="apply-mode"]:checked') as HTMLInputElement | null;
  return selected?.value === "isolate" ? "isolate" : "select";
}

function uniqueValues(key: string): string[] {
  const values = new Set<string>();
  for (const row of allRows) {
    if (key !== "link" && filters.link && (row.link ?? "") !== filters.link) continue;
    if (key !== "level" && filters.level && (row.level ?? "") !== filters.level) continue;
    if (key !== "category" && filters.category && (row.category ?? "") !== filters.category) continue;
    if (key !== "family" && filters.family && (row.family ?? "") !== filters.family) continue;
    if (key !== "type" && filters.type && (row.type ?? "") !== filters.type) continue;
    const value = (row[key] ?? "").trim();
    if (value) values.add(value);
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function fillSelect(select: HTMLSelectElement, values: string[], current: string) {
  select.innerHTML = `<option value="">All</option>`;
  for (const value of values) {
    select.innerHTML += `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
  }
  select.value = values.includes(current) ? current : "";
  return select.value;
}

function refreshFilterOptions() {
  filters.link = fillSelect(filterLink, uniqueValues("link"), filters.link);
  filters.level = fillSelect(filterLevel, uniqueValues("level"), filters.level);
  filters.category = fillSelect(filterCategory, uniqueValues("category"), filters.category);
  filters.family = fillSelect(filterFamily, uniqueValues("family"), filters.family);
  filters.type = fillSelect(filterType, uniqueValues("type"), filters.type);
}

function rowMatches(row: Record<string, string>): boolean {
  if (filters.link && (row.link ?? "") !== filters.link) return false;
  if (filters.level && (row.level ?? "") !== filters.level) return false;
  if (filters.category && (row.category ?? "") !== filters.category) return false;
  if (filters.family && (row.family ?? "") !== filters.family) return false;
  if (filters.type && (row.type ?? "") !== filters.type) return false;
  const search = filters.search.trim().toLowerCase();
  if (!search) return true;
  return Object.values(row).some((value) => value.toLowerCase().includes(search));
}

function filteredRows(): Record<string, string>[] {
  return allRows.filter(rowMatches);
}

function filteredIds(): number[] {
  return filteredRows()
    .map((row) => Number(row.elementId))
    .filter((id) => Number.isFinite(id));
}

function setBusy(busy: boolean, message?: string) {
  btnConfirm.disabled = busy || filteredRows().length === 0;
  btnApplyTypes.disabled = busy || pendingTypes.size === 0;
  btnApplyParams.disabled = busy || pendingParams.size === 0;
  btnClearPending.disabled = busy || (pendingTypes.size === 0 && pendingParams.size === 0);
  if (message) status.textContent = message;
}

function syncPendingButtons() {
  const typeN = pendingTypes.size;
  const paramN = pendingParams.size;
  btnApplyTypes.disabled = typeN === 0;
  btnApplyParams.disabled = paramN === 0;
  btnClearPending.disabled = typeN === 0 && paramN === 0;
  btnApplyTypes.textContent = typeN > 0 ? `Apply type changes (${typeN})` : "Apply type changes";
  btnApplyParams.textContent = paramN > 0 ? `Apply parameters (${paramN})` : "Apply parameters";
}

function ostForCategory(cat: string): string | undefined {
  const trimmed = cat.trim();
  if (!trimmed) return undefined;
  if (CATEGORY_TO_OST[trimmed]) return CATEGORY_TO_OST[trimmed];
  if (trimmed.startsWith("OST_")) return trimmed;
  return undefined;
}

function parseFamilyTypes(result: ToolResult): FamilyTypeInfo[] {
  if (Array.isArray(result.structuredContent)) {
    return result.structuredContent as FamilyTypeInfo[];
  }
  const text = textFromResult(result);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function typeLabel(t: FamilyTypeInfo): string {
  const family = t.FamilyName ?? t.familyName ?? "";
  const typeName = t.TypeName ?? t.typeName ?? "";
  return `${family} : ${typeName}`;
}

function typeIdOf(t: FamilyTypeInfo): number | null {
  const id = t.FamilyTypeId ?? t.familyTypeId;
  return id == null || !Number.isFinite(Number(id)) ? null : Number(id);
}

async function ensureTypesForCategory(category: string): Promise<FamilyTypeInfo[]> {
  const key = category.trim() || "(none)";
  const cached = typesByCategory.get(key);
  if (cached) return cached;
  if (typesLoading.has(key)) {
    while (typesLoading.has(key)) await new Promise((r) => setTimeout(r, 50));
    return typesByCategory.get(key) ?? [];
  }
  typesLoading.add(key);
  try {
    const ost = ostForCategory(category);
    const result = (await app.callServerTool({
      name: "get_available_family_types",
      arguments: {
        categoryList: ost ? [ost] : undefined,
        limit: 500,
      },
    })) as ToolResult;
    let types = parseFamilyTypes(result);
    if (category.trim()) {
      types = types.filter((t) => {
        const cat = (t.Category ?? t.category ?? "").trim();
        return !cat || cat === category.trim();
      });
    }
    types.sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));
    typesByCategory.set(key, types);
    return types;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    typesByCategory.set(key, []);
    return [];
  } finally {
    typesLoading.delete(key);
  }
}

const typeMenu = document.getElementById("type-menu")!;
let menuAnchor: HTMLElement | null = null;

function closeTypeMenu() {
  typeMenu.classList.remove("open");
  typeMenu.innerHTML = "";
  menuAnchor = null;
}

function placeTypeMenu(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, Math.max(rect.width, 200));
  const menuHeight = Math.min(typeMenu.scrollHeight || 220, 220);
  const spaceBelow = window.innerHeight - rect.bottom;
  const top =
    spaceBelow < menuHeight + 8 && rect.top > menuHeight + 8
      ? rect.top - menuHeight - 4
      : rect.bottom + 4;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  typeMenu.style.width = `${width}px`;
  typeMenu.style.left = `${left}px`;
  typeMenu.style.top = `${Math.max(8, top)}px`;
}

async function openTypeMenu(anchor: HTMLButtonElement, row: Record<string, string>, rowIndex: number) {
  const elementId = Number(row.elementId);
  const category = row.category ?? "";
  menuAnchor = anchor;
  typeMenu.classList.add("open");
  typeMenu.innerHTML = `<div class="menu-status">Loading types…</div>`;
  placeTypeMenu(anchor);

  const types = await ensureTypesForCategory(category);
  if (menuAnchor !== anchor) return;
  typeMenu.innerHTML = "";
  if (types.length === 0) {
    typeMenu.innerHTML = `<div class="menu-status">No types for this category</div>`;
    placeTypeMenu(anchor);
    return;
  }

  const currentType = pendingTypes.get(elementId)?.type || (row.type ?? "").trim();
  for (const item of types) {
    const tid = typeIdOf(item);
    if (tid == null) continue;
    const typeName = item.TypeName ?? item.typeName ?? "";
    const family = item.FamilyName ?? item.familyName ?? "";
    const choice = document.createElement("button");
    choice.type = "button";
    if (typeName === currentType) choice.classList.add("on");
    choice.innerHTML = `<span>${escapeHtml(typeName)}</span><small>${escapeHtml(family)}</small>`;
    choice.addEventListener("click", (event) => {
      event.stopPropagation();
      const pending = { typeId: tid, family, type: typeName };
      setPending(elementId, pending);
      anchor.textContent = typeName;
      const tr = anchor.closest("tr");
      tr?.classList.add("dirty");
      selectedCell = { rowIndex, column: "family" };
      const cell = anchor.parentElement as HTMLElement | null;
      const oldHandle = cell?.querySelector(".fill-handle") as HTMLElement | null;
      if (oldHandle && cell) {
        const handle = oldHandle.cloneNode(true) as HTMLElement;
        oldHandle.replaceWith(handle);
        handle.title = "Drag to fill type";
        wireFillHandle(handle, {
          kind: "type",
          column: "family",
          startIndex: rowIndex,
          pendingType: pending,
          category,
        });
      }
      paintSelection();
      status.textContent = `Pending ${typeName}. Drag the corner down, then Apply types.`;
      closeTypeMenu();
    });
    typeMenu.appendChild(choice);
  }
  placeTypeMenu(anchor);
}

document.addEventListener("click", (event) => {
  const target = event.target as Node | null;
  if (!typeMenu.classList.contains("open") || !target) return;
  if (typeMenu.contains(target) || (target instanceof Element && target.closest(".type-face"))) return;
  closeTypeMenu();
});
document.getElementById("table-container")!.addEventListener("scroll", () => closeTypeMenu());

function setPending(elementId: number, pending: PendingType) {
  pendingTypes.set(elementId, pending);
  syncPendingButtons();
}

function setPendingParam(elementId: number, name: string, value: string) {
  pendingParams.set(paramKey(elementId, name), { elementId, name, value });
  syncPendingButtons();
}

function clearFillHighlights() {
  table.querySelectorAll("td.fill-range").forEach((td) => td.classList.remove("fill-range"));
}

function cellSelector(rowIndex: number, column: string) {
  return `td[data-row-index="${rowIndex}"][data-column="${CSS.escape(column)}"]`;
}

function paintFillRange(start: number, end: number, column: string) {
  clearFillHighlights();
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  for (let i = lo; i <= hi; i++) {
    table.querySelector(cellSelector(i, column))?.classList.add("fill-range");
  }
}

function paintSelection() {
  table.querySelectorAll("td.cell-selected").forEach((td) => td.classList.remove("cell-selected"));
  if (!selectedCell || fillDrag) return;
  const td = table.querySelector(
    cellSelector(selectedCell.rowIndex, selectedCell.column)
  ) as HTMLElement | null;
  td?.classList.add("cell-selected");
}

function rowIndexFromEvent(event: MouseEvent): number | null {
  const td = (event.target as HTMLElement | null)?.closest?.("td[data-row-index]") as HTMLElement | null;
  if (!td) return null;
  const idx = Number(td.dataset.rowIndex);
  return Number.isFinite(idx) ? idx : null;
}

function applyTypeFillRange(start: number, end: number, pending: PendingType, category: string) {
  const rows = filteredRows();
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  let applied = 0;
  for (let i = lo; i <= hi; i++) {
    const row = rows[i];
    if (!row || !isHostRow(row)) continue;
    if ((row.category ?? "").trim() !== category) continue;
    const id = Number(row.elementId);
    if (!Number.isFinite(id)) continue;
    setPending(id, pending);
    applied++;
  }
  status.textContent = `Filled ${applied} row(s) with ${pending.family} : ${pending.type} (pending — click Apply types)`;
  render();
}

function applyParamFillRange(start: number, end: number, name: string, value: string) {
  const rows = filteredRows();
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  let applied = 0;
  for (let i = lo; i <= hi; i++) {
    const row = rows[i];
    if (!row || !isHostRow(row)) continue;
    if (!(name in row) && !pendingParams.has(paramKey(Number(row.elementId), name))) {
      // still allow fill onto host rows that may get the param column from union
    }
    const id = Number(row.elementId);
    if (!Number.isFinite(id)) continue;
    setPendingParam(id, name, value);
    applied++;
  }
  status.textContent = `Filled ${applied} cell(s) with ${name} = "${value}" (pending — click Apply parameters)`;
  render();
}

function wireFillHandle(handle: HTMLElement, drag: Omit<FillDrag, "endIndex">) {
  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    fillDrag = { ...drag, endIndex: drag.startIndex };
    document.body.classList.add("filling");
    paintFillRange(drag.startIndex, drag.startIndex, drag.column);
  });
}

function onFillMouseMove(event: MouseEvent) {
  if (!fillDrag) return;
  const idx = rowIndexFromEvent(event);
  if (idx == null) return;
  fillDrag.endIndex = idx;
  paintFillRange(fillDrag.startIndex, idx, fillDrag.column);
}

function onFillMouseUp() {
  if (!fillDrag) return;
  const drag = fillDrag;
  fillDrag = null;
  document.body.classList.remove("filling");
  clearFillHighlights();
  if (drag.startIndex === drag.endIndex) {
    paintSelection();
    return;
  }
  if (drag.kind === "type" && drag.pendingType && drag.category != null) {
    applyTypeFillRange(drag.startIndex, drag.endIndex, drag.pendingType, drag.category);
    return;
  }
  if (drag.kind === "param" && drag.paramName != null && drag.paramValue != null) {
    applyParamFillRange(drag.startIndex, drag.endIndex, drag.paramName, drag.paramValue);
    return;
  }
  paintSelection();
}

document.addEventListener("mousemove", onFillMouseMove);
document.addEventListener("mouseup", onFillMouseUp);

function parseSchedule(data: ScheduleData | undefined, fallbackText?: string) {
  if (!data) {
    if (
      fallbackText?.startsWith("mcp_apps_get_schedule_data failed") ||
      fallbackText?.startsWith("get_schedule_data failed")
    ) {
      status.textContent = fallbackText;
    }
    return;
  }
  columns = (data.columns ?? []).filter((c) => !CALCULATED_COLUMNS.has(c));
  allRows = (data.rows ?? []).map((row) => {
    const next = { ...row };
    for (const key of Object.keys(next)) {
      if (CALCULATED_COLUMNS.has(key)) delete next[key];
    }
    return next;
  });
  dashboardStats = data.dashboard;
  checked.clear();
  pendingTypes.clear();
  pendingParams.clear();
  selectedCell = null;
  paramPickerInitialized = false;
  selectedParamColumns.clear();
  syncPendingButtons();
  refreshFilterOptions();
  refreshParamPicker();
  render();
  updateKpis();
  const shown = filteredRows().length;
  const total = data.totalMatched ?? allRows.length;
  status.textContent = data.message
    ? data.message
    : `${shown} shown / ${allRows.length} loaded` +
      (total > allRows.length ? ` (${total} matched)` : "");
}

function updateKpis() {
  const errors = dashboardStats?.errorCount ?? dashboardStats?.warningCount;
  const detach = dashboardStats?.detachableFamilyCount;
  kpiErrors.textContent = errors == null ? "—" : String(errors);
  kpiErrorsSub.textContent = "Warnings";
  kpiDetach.textContent = detach == null ? "—" : String(detach);
  kpiDetachSub.textContent = "Detachable";
}

function categoryCounts(rows: Record<string, string>[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const name = (row.category ?? "").trim() || "(none)";
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function rowsForDonut(): Record<string, string>[] {
  return allRows.filter((row) => {
    if (filters.link && (row.link ?? "") !== filters.link) return false;
    if (filters.level && (row.level ?? "") !== filters.level) return false;
    if (filters.family && (row.family ?? "") !== filters.family) return false;
    if (filters.type && (row.type ?? "") !== filters.type) return false;
    const search = filters.search.trim().toLowerCase();
    if (!search) return true;
    return Object.values(row).some((v) => String(v).toLowerCase().includes(search));
  });
}

function applyCategoryFilter(name: string) {
  if (!name || name === "Other") return;
  if (filters.category === name) {
    filters.category = "";
    filterCategory.value = "";
  } else {
    filters.category = name;
    filterCategory.value = name;
  }
  refreshFilterOptions();
  render();
}

function renderDonut(_filteredRows: Record<string, string>[]) {
  const counts = categoryCounts(rowsForDonut());
  donutLegend.innerHTML = "";
  donutSvg.replaceChildren();
  if (counts.length <= 1) {
    composition.hidden = true;
    return;
  }
  composition.hidden = false;

  const top = counts.slice(0, 6);
  const rest = counts.slice(6);
  const restCount = rest.reduce((sum, item) => sum + item.count, 0);
  const display = restCount > 0 ? [...top, { name: "Other", count: restCount }] : top;

  const bar = document.createElement("li");
  bar.className = "comp-bar";
  for (const item of display) {
    const seg = document.createElement("button");
    seg.type = "button";
    seg.style.flexGrow = String(item.count);
    seg.title = `${item.name} ${item.count}`;
    if (item.name === "Other") seg.classList.add("other");
    if (filters.category === item.name) seg.classList.add("on");
    if (item.name !== "Other") {
      seg.addEventListener("click", () => applyCategoryFilter(item.name));
    }
    bar.appendChild(seg);
  }
  donutLegend.appendChild(bar);

  for (const item of display) {
    if (item.name === "Other") continue;
    const li = document.createElement("li");
    li.className = "legend-row" + (filters.category === item.name ? " on" : "");
    li.innerHTML =
      `<span>${escapeHtml(item.name)}</span><span class="legend-count">${item.count}</span>`;
    li.addEventListener("click", () => applyCategoryFilter(item.name));
    donutLegend.appendChild(li);
  }
}

function textFromResult(result: ToolResult | undefined) {
  return result?.content?.find((c) => c.type === "text")?.text;
}

function dataFromResult(result: ToolResult | undefined): ScheduleData | undefined {
  if (result?.structuredContent && !Array.isArray(result.structuredContent) && result.structuredContent.rows) {
    return result.structuredContent;
  }
  const text = textFromResult(result);
  if (
    !text ||
    text.startsWith("mcp_apps_get_schedule_data failed") ||
    text.startsWith("get_schedule_data failed")
  ) {
    if (text) status.textContent = text;
    return undefined;
  }
  try {
    return JSON.parse(text) as ScheduleData;
  } catch {
    status.textContent = "Failed to parse schedule data";
    return undefined;
  }
}

function operateSucceeded(text: string): { ok: boolean; detail: string } {
  try {
    const parsed = JSON.parse(text) as { Success?: boolean; Message?: string };
    return {
      ok: parsed.Success === true,
      detail: parsed.Message ?? text.slice(0, 240),
    };
  } catch {
    return {
      ok: /"Success"\s*:\s*true/.test(text),
      detail: text.slice(0, 240),
    };
  }
}

app.ontoolinput = (params) => {
  if (params?.arguments && typeof params.arguments === "object") {
    lastArgs = params.arguments as Record<string, unknown>;
  }
};

app.ontoolresult = (result) => {
  const typed = result as ToolResult;
  parseSchedule(dataFromResult(typed), textFromResult(typed));
  // Upgrade to editable instance params when the agent loaded computed KeyParameters / None.
  if (lastArgs.parametersOutputType !== "EditableInstanceParameters") {
    void (async () => {
      try {
        setBusy(true, "Loading editable instance parameters...");
        const refresh = (await app.callServerTool({
      name: "mcp_apps_get_schedule_data",
      arguments: scheduleArgs(),
    })) as ToolResult;
        lastArgs = scheduleArgs();
        parseSchedule(dataFromResult(refresh), textFromResult(refresh));
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        syncPendingButtons();
      }
    })();
  }
};

function render() {
  closeTypeMenu();
  const rows = filteredRows();
  btnConfirm.disabled = rows.length === 0;
  syncPendingButtons();

  if (allRows.length === 0) {
    table.innerHTML = "<p>No rows loaded.</p>";
    renderDonut([]);
    return;
  }
  if (rows.length === 0) {
    table.innerHTML = "<p>No rows match the current filters.</p>";
    status.textContent = `0 / ${allRows.length} loaded`;
    renderDonut([]);
    return;
  }

  const visible = columnsForTable(rows);
  const allFilteredChecked =
    rows.length > 0 && rows.every((row) => checked.has(Number(row.elementId)));

  let html = "<table><thead><tr>";
  html += `<th class="check-col"><input type="checkbox" id="check-all" title="Select / deselect all filtered" ${
    allFilteredChecked ? "checked" : ""
  } /></th>`;
  for (const column of visible) {
    const label = column === "family" ? "Type" : column;
    html += `<th>${escapeHtml(label)}</th>`;
  }
  html += "</tr></thead><tbody>";

  rows.forEach((row, rowIndex) => {
    const id = Number(row.elementId);
    const isChecked = checked.has(id);
    const dirty = pendingTypes.has(id);
    const rowClass = [isChecked ? "checked" : "", dirty ? "dirty" : ""].filter(Boolean).join(" ");
    html += `<tr data-id="${escapeHtml(row.elementId)}" data-row-index="${rowIndex}"${
      rowClass ? ` class="${rowClass}"` : ""
    }>`;
    html += `<td class="check-col"><input type="checkbox" data-id="${escapeHtml(row.elementId)}"${
      isChecked ? " checked" : ""
    } /></td>`;
    for (const column of visible) {
      if (column === "family") {
        const host = isHostRow(row);
        const pending = pendingTypes.get(id);
        const label = pending?.type || (row.type ?? "").trim() || (row.family ?? "");
        if (host) {
          html += `<td class="family-cell" data-column="family" data-row-index="${rowIndex}" data-element-id="${escapeHtml(
            row.elementId
          )}">`;
          html += `<button type="button" class="type-face" data-id="${escapeHtml(row.elementId)}" title="${escapeHtml(
            (row.family ?? "") + (row.type ? " · " + row.type : "")
          )}">${escapeHtml(label || "Select type")}</button>`;
          html += `<span class="fill-handle" title="Drag to fill type"></span>`;
          html += `</td>`;
        } else {
          html += `<td class="family-cell" data-column="family" data-row-index="${rowIndex}"><span class="readonly" title="Linked — read-only">${escapeHtml(
            label
          )}</span></td>`;
        }
      } else if (isParamColumn(column)) {
        const host = isHostRow(row);
        const value = displayParamValue(row, column, id);
        const dirtyParam = pendingParams.has(paramKey(id, column));
        const classes = ["param-cell", host ? "editable" : "", dirtyParam ? "param-dirty" : ""]
          .filter(Boolean)
          .join(" ");
        html += `<td class="${classes}" data-column="${escapeHtml(column)}" data-row-index="${rowIndex}" data-element-id="${escapeHtml(
          row.elementId
        )}">`;
        if (host) {
          html += `<span class="cell-value">${escapeHtml(value)}</span>`;
          html += `<span class="fill-handle" title="Drag to fill"></span>`;
        } else {
          html += `<span class="readonly" title="Linked — read-only">${escapeHtml(value)}</span>`;
        }
        html += `</td>`;
      } else {
        html += `<td data-column="${escapeHtml(column)}" data-row-index="${rowIndex}">${escapeHtml(
          row[column] ?? ""
        )}</td>`;
      }
    }
    html += "</tr>";
  });
  html += "</tbody></table>";
  table.innerHTML = html;

  const checkAll = document.getElementById("check-all") as HTMLInputElement | null;
  checkAll?.addEventListener("change", () => {
    if (checkAll.checked) {
      for (const row of filteredRows()) {
        const id = Number(row.elementId);
        if (Number.isFinite(id)) checked.add(id);
      }
    } else {
      for (const id of filteredIds()) checked.delete(id);
    }
    render();
  });

  table.querySelectorAll("tbody input[type=checkbox]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement;
      const id = Number(target.dataset.id);
      if (!Number.isFinite(id)) return;
      if (target.checked) checked.add(id);
      else checked.delete(id);
      render();
    });
  });

  table.querySelectorAll("button.type-face").forEach((el) => {
    const face = el as HTMLButtonElement;
    const elementId = Number(face.dataset.id);
    const row = rows.find((item) => Number(item.elementId) === elementId);
    if (!row) return;
    const rowIndex = rowIndexOf(rows, elementId);
    face.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedCell = { rowIndex, column: "family" };
      paintSelection();
      if (menuAnchor === face) {
        closeTypeMenu();
        return;
      }
      void openTypeMenu(face, row, rowIndex);
    });
    const handle = face.parentElement?.querySelector(".fill-handle") as HTMLElement | null;
    const pending = pendingTypes.get(elementId);
    if (handle && pending) {
      wireFillHandle(handle, {
        kind: "type",
        column: "family",
        startIndex: rowIndex,
        pendingType: pending,
        category: row.category ?? "",
      });
    } else if (handle) {
      handle.title = "Pick a type first, then drag to fill";
    }
  });

  table.querySelectorAll("td.param-cell.editable").forEach((el) => {
    const td = el as HTMLElement;
    const rowIndex = Number(td.dataset.rowIndex);
    const column = td.dataset.column ?? "";
    const elementId = Number(td.dataset.elementId);
    if (!Number.isFinite(rowIndex) || !column || !Number.isFinite(elementId)) return;

    td.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".fill-handle")) return;
      selectedCell = { rowIndex, column };
      paintSelection();
    });

    td.addEventListener("dblclick", (event) => {
      event.preventDefault();
      beginCellEdit(td, elementId, column, rowIndex);
    });

    const handle = td.querySelector(".fill-handle") as HTMLElement | null;
    if (handle) {
      wireFillHandle(handle, {
        kind: "param",
        column,
        startIndex: rowIndex,
        paramName: column,
        paramValue: displayParamValue(rows[rowIndex] ?? {}, column, elementId),
      });
    }
  });

  paintSelection();
  renderDonut(rows);
  const typeN = pendingTypes.size;
  const paramN = pendingParams.size;
  const bits = [`${rows.length} shown / ${allRows.length} loaded`];
  if (typeN) bits.push(`${typeN} type change(s) pending`);
  if (paramN) bits.push(`${paramN} parameter edit(s) pending`);
  status.textContent = bits.join(" · ");
}

function beginCellEdit(td: HTMLElement, elementId: number, column: string, rowIndex: number) {
  if (td.querySelector("input.cell-edit")) return;
  selectedCell = { rowIndex, column };
  paintSelection();
  const current = displayParamValue(
    filteredRows()[rowIndex] ?? {},
    column,
    elementId
  );
  const valueEl = td.querySelector(".cell-value");
  if (!valueEl) return;
  const input = document.createElement("input");
  input.className = "cell-edit";
  input.value = current;
  valueEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const next = input.value;
    if (next !== current) {
      setPendingParam(elementId, column, next);
      status.textContent = `Pending ${column} = "${next}". Drag corner to fill, then Apply parameters.`;
    }
    render();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      input.removeEventListener("blur", commit);
      render();
    }
  });
}

function rowIndexOf(rows: Record<string, string>[], elementId: number): number {
  return rows.findIndex((r) => Number(r.elementId) === elementId);
}

function syncFiltersFromDom() {
  filters.link = filterLink.value;
  filters.level = filterLevel.value;
  filters.category = filterCategory.value;
  filters.family = filterFamily.value;
  filters.type = filterType.value;
  filters.search = filterSearch.value;
  refreshFilterOptions();
  render();
}

for (const el of [filterLink, filterLevel, filterCategory, filterFamily, filterType]) {
  el.addEventListener("change", syncFiltersFromDom);
}
filterSearch.addEventListener("input", syncFiltersFromDom);

document.getElementById("btn-select-all")!.addEventListener("click", () => {
  for (const row of filteredRows()) {
    const id = Number(row.elementId);
    if (Number.isFinite(id)) checked.add(id);
  }
  render();
  status.textContent = `Selected all ${filteredIds().length} filtered row(s)`;
});

document.getElementById("btn-deselect-all")!.addEventListener("click", () => {
  for (const id of filteredIds()) checked.delete(id);
  render();
  status.textContent = "Deselected filtered rows";
});

document.getElementById("btn-clear-pending")!.addEventListener("click", () => {
  pendingTypes.clear();
  pendingParams.clear();
  syncPendingButtons();
  render();
  status.textContent = "Cleared pending edits";
});

document.getElementById("btn-apply-types")!.addEventListener("click", async () => {
  if (pendingTypes.size === 0) {
    status.textContent = "No pending type changes";
    return;
  }
  // Group by typeId for fewer Revit calls
  const byType = new Map<number, number[]>();
  for (const [elementId, pending] of pendingTypes) {
    const list = byType.get(pending.typeId) ?? [];
    list.push(elementId);
    byType.set(pending.typeId, list);
  }

  setBusy(true, `Applying ${pendingTypes.size} type change(s)...`);
  let okCount = 0;
  let failDetail = "";
  try {
    for (const [typeId, elementIds] of byType) {
      const result = (await app.callServerTool({
        name: "operate_element",
        arguments: {
          data: { elementIds, action: "ChangeType", typeId },
        },
      })) as ToolResult;
      const text = textFromResult(result) ?? "";
      const { ok, detail } = operateSucceeded(text);
      if (!ok) {
        failDetail = detail;
        break;
      }
      okCount += elementIds.length;
    }
    if (failDetail) {
      status.textContent = failDetail;
      return;
    }
    pendingTypes.clear();
    syncPendingButtons();
    status.textContent = `Changed type on ${okCount} element(s). Refreshing...`;
    const refresh = (await app.callServerTool({
      name: "mcp_apps_get_schedule_data",
      arguments: scheduleArgs(),
    })) as ToolResult;
    parseSchedule(dataFromResult(refresh), textFromResult(refresh));
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    btnConfirm.disabled = filteredRows().length === 0;
    syncPendingButtons();
  }
});

document.getElementById("btn-apply-params")!.addEventListener("click", async () => {
  if (pendingParams.size === 0) {
    status.textContent = "No pending parameter edits";
    return;
  }
  // Group by parameterName + value for fewer Revit calls
  const groups = new Map<string, { name: string; value: string; elementIds: number[] }>();
  for (const pending of pendingParams.values()) {
    const key = `${pending.name}\0${pending.value}`;
    const group = groups.get(key) ?? { name: pending.name, value: pending.value, elementIds: [] };
    group.elementIds.push(pending.elementId);
    groups.set(key, group);
  }

  setBusy(true, `Applying ${pendingParams.size} parameter edit(s)...`);
  let okCount = 0;
  let failDetail = "";
  try {
    for (const group of groups.values()) {
      const result = (await app.callServerTool({
        name: "operate_element",
        arguments: {
          data: {
            elementIds: group.elementIds,
            action: "SetParameter",
            parameterName: group.name,
            parameterValue: group.value,
          },
        },
      })) as ToolResult;
      const text = textFromResult(result) ?? "";
      const { ok, detail } = operateSucceeded(text);
      if (!ok) {
        failDetail = detail;
        break;
      }
      okCount += group.elementIds.length;
    }
    if (failDetail) {
      status.textContent = failDetail;
      return;
    }
    pendingParams.clear();
    syncPendingButtons();
    status.textContent = `Updated ${okCount} parameter value(s). Refreshing...`;
    const refresh = (await app.callServerTool({
      name: "mcp_apps_get_schedule_data",
      arguments: scheduleArgs(),
    })) as ToolResult;
    parseSchedule(dataFromResult(refresh), textFromResult(refresh));
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    btnConfirm.disabled = filteredRows().length === 0;
    syncPendingButtons();
  }
});

document.getElementById("btn-clear-filters")!.addEventListener("click", () => {
  filters.link = "";
  filters.level = "";
  filters.category = "";
  filters.family = "";
  filters.type = "";
  filters.search = "";
  filterLink.value = "";
  filterLevel.value = "";
  filterCategory.value = "";
  filterFamily.value = "";
  filterType.value = "";
  filterSearch.value = "";
  paramPickerSearch = "";
  paramPickerSearchInput.value = "";
  selectedParamColumns.clear();
  for (const pref of DEFAULT_PARAM_PREFS) {
    if (availableParamColumns.includes(pref)) selectedParamColumns.add(pref);
  }
  checked.clear();
  refreshFilterOptions();
  refreshParamPicker();
  render();
});

paramPickerTrigger.addEventListener("click", (event) => {
  event.stopPropagation();
  setParamPickerOpen(!paramPicker.classList.contains("open"));
});
paramPickerSearchInput.addEventListener("input", () => {
  paramPickerSearch = paramPickerSearchInput.value;
  renderParamPickerList();
});
paramPickerSearchInput.addEventListener("click", (event) => event.stopPropagation());
paramPickerAll.addEventListener("click", (event) => {
  event.stopPropagation();
  for (const name of visibleParamOptions()) selectedParamColumns.add(name);
  renderParamPickerList();
  render();
});
paramPickerNone.addEventListener("click", (event) => {
  event.stopPropagation();
  selectedParamColumns.clear();
  renderParamPickerList();
  render();
});
document.addEventListener("click", (event) => {
  const target = event.target as Node | null;
  if (!target || !paramPicker.classList.contains("open")) return;
  if (paramPicker.contains(target)) return;
  setParamPickerOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && paramPicker.classList.contains("open")) {
    setParamPickerOpen(false);
  }
});

document.getElementById("btn-refresh")!.addEventListener("click", async () => {
  setBusy(true, "Refreshing editable parameters...");
  try {
    const result = (await app.callServerTool({
      name: "mcp_apps_get_schedule_data",
      arguments: scheduleArgs(),
    })) as ToolResult;
    parseSchedule(dataFromResult(result), textFromResult(result));
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    btnConfirm.disabled = filteredRows().length === 0;
    syncPendingButtons();
  }
});

document.getElementById("btn-reset-view")!.addEventListener("click", async () => {
  setBusy(true, "Resetting isolate...");
  try {
    const ids = filteredIds().length
      ? filteredIds()
      : allRows.map((r) => Number(r.elementId)).filter(Number.isFinite);
    if (ids.length === 0) {
      status.textContent = "No elements to reset";
      return;
    }
    await app.callServerTool({
      name: "operate_element",
      arguments: { data: { elementIds: ids.slice(0, 1), action: "ResetIsolate" } },
    });
    status.textContent = "Isolate reset";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    btnConfirm.disabled = filteredRows().length === 0;
    syncPendingButtons();
  }
});

document.getElementById("btn-confirm")!.addEventListener("click", async () => {
  const ids =
    checked.size > 0
      ? Array.from(checked).filter((id) => filteredIds().includes(id))
      : filteredIds();

  if (ids.length === 0) {
    status.textContent = "No filtered elements to apply";
    return;
  }

  const mode = getApplyMode();
  setBusy(true, `Applying ${ids.length} elements (${mode})...`);
  try {
    if (mode === "isolate") {
      await app.callServerTool({
        name: "operate_element",
        arguments: { data: { elementIds: ids, action: "Isolate" } },
      });
    }
    await app.callServerTool({
      name: "select_elements",
      arguments: { elementIds: ids },
    });
    await app.callServerTool({
      name: "zoom_to_elements",
      arguments: { elementIds: ids },
    });
    status.textContent =
      mode === "isolate"
        ? `Isolated + selected + zoomed ${ids.length}`
        : `Selected + zoomed ${ids.length}`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    btnConfirm.disabled = filteredRows().length === 0;
    syncPendingButtons();
  }
});

function columnsForTable(rows: Record<string, string>[]): string[] {
  const skip = new Set(["elementId", "linkInstanceId", "name", "type", ...CALCULATED_COLUMNS]);
  let cols = columns.filter((column) => !skip.has(column) && !CALCULATED_COLUMNS.has(column));
  if (new Set(rows.map((row) => row.link ?? "")).size <= 1) {
    cols = cols.filter((column) => column !== "link");
  }
  if (new Set(rows.map((row) => row.category ?? "")).size <= 1) {
    cols = cols.filter((column) => column !== "category");
  }
  // Identity + type, then only user-selected editable parameter columns.
  const identityOrder = ["family", "level", "category", "link"];
  const paramCols = availableParamColumns.filter((c) => selectedParamColumns.has(c));
  const head = identityOrder.filter((c) => cols.includes(c) || c === "family");
  const uniqueHead = Array.from(new Set(head));
  if (!uniqueHead.includes("family")) uniqueHead.unshift("family");
  return [...uniqueHead, ...paramCols];
}

function applyHostContext() {
  const ctx = app.getHostContext?.();
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

app.onhostcontextchanged = () => applyHostContext();
app.connect().then(() => applyHostContext());

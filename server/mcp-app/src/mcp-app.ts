import { App, applyDocumentTheme, applyHostFonts } from "@modelcontextprotocol/ext-apps";
import { createChecksView } from "./checks-view";

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

type ShowMode = "select" | "isolate";
type Theme = "light" | "dark";
type TabName = "elements" | "changes" | "checks" | "dashboard";

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

const DEFAULT_PARAM_PREFS = ["Mark", "Comments", "标记", "注释"];
const CATEGORY_CHIP_LIMIT = 8;
const THEME_KEY = "revit-schedule-theme";

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

/**
 * Abstract 12×12 line glyphs: categories are told apart by shape, not colour (architecture, structure, MEP, site).
 * Copied from the Design Theme repo (template/app/theme/glyphs.ts) — keep the two in sync.
 */
const CATEGORY_GLYPHS: Record<string, string> = {
  // Architecture
  Walls: '<rect x="1" y="4" width="10" height="4"/>',
  Doors: '<path d="M2.5 11V1.5h7V11"/>',
  Windows: '<rect x="1.5" y="1.5" width="9" height="9"/><path d="M6 1.5v9M1.5 6h9"/>',
  Floors: '<path d="M1 7.5l5-3 5 3-5 3z"/>',
  Ceilings: '<path d="M1 3.5h10M3 3.5v3M9 3.5v3"/>',
  Roofs: '<path d="M1 9.5l5-6 5 6"/>',
  Stairs: '<path d="M1 10.5h3v-3h3v-3h3v-3"/>',
  Railings: '<path d="M1 3h10M2 3v8M6 3v8M10 3v8"/>',
  Ramps: '<path d="M1 10h10L1 4.5z"/>',
  Rooms: '<rect x="1.5" y="1.5" width="9" height="9" stroke-dasharray="2 1.6"/>',
  Furniture: '<path d="M2 5.5h8v3H2zM3 8.5v2.5M9 8.5v2.5"/>',
  Casework: '<rect x="1.5" y="2" width="9" height="8"/><path d="M6 2v8"/>',
  "Generic Models": '<path d="M6 1l5 3v4l-5 3-5-3V4z"/>',
  Mass: '<path d="M6 1l4.5 2.5v5L6 11 1.5 8.5v-5zM6 6v5M6 6l4.5-2.5M6 6L1.5 3.5"/>',
  "Curtain Panels": '<rect x="2.5" y="1" width="7" height="10"/><path d="M4.5 5.5l2.5-2.5M4.5 8.5l4-4"/>',
  "Curtain Wall Mullions": '<path d="M3 1.5h6M3 10.5h6M6 1.5v9"/>',
  "Specialty Equipment": '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="6" r="4.5" stroke-dasharray="1.6 1.3"/>',

  // Structure
  Columns: '<rect x="4" y="1" width="4" height="10"/>',
  "Structural Columns": '<rect x="4" y="1" width="4" height="10"/><path d="M4 6h4"/>',
  "Structural Framing": '<path d="M1 4h10M1 8h10M3 4v4M9 4v4"/>',
  "Structural Foundations": '<path d="M1 9h10M2.5 9V6h7v3"/>',

  // Plumbing — round sections and bends
  Pipes: '<circle cx="6" cy="6" r="4.5"/><circle cx="6" cy="6" r="1.8"/>',
  "Pipe Fittings": '<path d="M2 1.5V7a3.5 3.5 0 0 0 3.5 3.5h5"/>',
  "Pipe Accessories": '<path d="M1 3.5v5l10-5v5z"/>',
  "Plumbing Fixtures": '<path d="M1.5 5h9A4.5 4.5 0 0 1 1.5 5zM6 5V1.5"/>',

  // HVAC — rectangular sections and square bends
  Ducts: '<rect x="1.5" y="3" width="9" height="6"/><path d="M1.5 3l9 6M10.5 3l-9 6"/>',
  "Duct Fittings": '<path d="M1.5 1.5h4v5h5v4h-9z"/>',
  "Duct Accessories": '<rect x="1.5" y="3" width="9" height="6"/><path d="M4 9l4-6"/>',
  "Mechanical Equipment": '<rect x="1.5" y="1.5" width="9" height="9"/><circle cx="6" cy="6" r="2.5"/>',

  // Electrical — dashed runs, panels, outlets, lights
  "Lighting Fixtures": '<circle cx="6" cy="6" r="2.5"/><path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11"/>',
  "Electrical Fixtures": '<circle cx="6" cy="6" r="4.5"/><path d="M4.5 4.5v3M7.5 4.5v3"/>',
  "Electrical Equipment": '<rect x="2" y="1.5" width="8" height="9"/><path d="M6.5 3L4.5 6.5h3L5.5 9"/>',
  Conduits: '<path d="M1 4.5h10M1 7.5h10" stroke-dasharray="2 1.5"/>',
  "Conduit Fittings": '<path d="M2 1.5V7a3.5 3.5 0 0 0 3.5 3.5h5" stroke-dasharray="2 1.5"/>',
  "Cable Trays": '<path d="M1 4v4h10V4"/>',
  "Cable Tray Fittings": '<path d="M1.5 1.5v9h9M4.5 1.5v6h6"/>',

  // Site
  Planting: '<circle cx="6" cy="4.5" r="3.5"/><path d="M6 8v3.5"/>',
  Site: '<path d="M1 8.5c2.5-3 4.5 0 7-2.5 1-1 2-1 3-.5M1 4.5c2-2 3.5 0 5.5-1.5"/>',
  Topography: '<path d="M1 8.5c2.5-3 4.5 0 7-2.5 1-1 2-1 3-.5M1 4.5c2-2 3.5 0 5.5-1.5"/>',
  Parking: '<rect x="1.5" y="1.5" width="9" height="9"/><path d="M4.5 9V3.5h2a1.6 1.6 0 0 1 0 3.2h-2"/>',
};
const DEFAULT_GLYPH = '<circle cx="6" cy="6" r="4"/>';
const FILTER_GLYPHS: Record<Exclude<keyof FilterState, "search" | "category">, string> = {
  level: '<path d="M1 10.5h3v-3h3v-3h3v-3"/>',
  family: '<path d="M6 1l5 3v4l-5 3-5-3V4z"/>',
  type: '<path d="M6 1l5 5-5 5-5-5z"/>',
  link: '<path d="M5 7l2-2M4.2 5.4L3 6.6a2 2 0 0 0 2.8 2.8L7 8.2M7.8 6.6L9 5.4a2 2 0 0 0-2.8-2.8L5 3.8"/>',
};

const ICON_CHEVRON =
  '<svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const ICON_LOCK =
  '<svg class="i lock" viewBox="0 0 24 24" aria-label="Linked, read-only"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const ICON_X =
  '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

let columns: string[] = [];
let allRows: Record<string, string>[] = [];
/** Rows currently rendered in the table (filtered), in display order. */
let viewRows: Record<string, string>[] = [];
let lastArgs: Record<string, unknown> = {};
const checked = new Set<number>();
/** Last checkbox row clicked without Shift. Shift-click selects through to here. */
let checkAnchor: number | null = null;
/** Pending type edits before Apply. */
const pendingTypes = new Map<number, PendingType>();
/** Pending parameter edits before Apply. Key = `${elementId}\\0${name}` */
const pendingParams = new Map<string, PendingParam>();
const typesByCategory = new Map<string, FamilyTypeInfo[]>();
const typesLoading = new Set<string>();
let selectedCell: SelectedCell | null = null;
/** Editable parameter columns the user chose to show in the table. */
const selectedParamColumns = new Set<string>();
let availableParamColumns: string[] = [];
let paramPickerSearch = "";
let paramPickerInitialized = false;
let showAllCategories = false;
let activeTab: TabName = "elements";
/** 03 Checks + 04 Dashboard (checks-view.ts); assigned once the panels exist. */
let checks: ReturnType<typeof createChecksView> | undefined;
let busy = false;
let dashboardStats: ScheduleData["dashboard"] | undefined;
let hostTheme: Theme | undefined;
let themeOverride: Theme | null = readThemeOverride();

const filters: FilterState = {
  link: "",
  level: "",
  category: "",
  family: "",
  type: "",
  search: "",
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const table = $("table-container");
const status = $("status");
const chips = $("chips");
const filterLink = $<HTMLSelectElement>("filter-link");
const filterLevel = $<HTMLSelectElement>("filter-level");
const filterFamily = $<HTMLSelectElement>("filter-family");
const filterType = $<HTMLSelectElement>("filter-type");
const filterSearch = $<HTMLInputElement>("filter-search");
const filtersPop = $("filters-pop");
const filtersTrigger = $<HTMLButtonElement>("filters-trigger");
const filtersCount = $("filters-count");
const paramPicker = $("param-picker");
const paramPickerTrigger = $<HTMLButtonElement>("param-picker-trigger");
const paramPickerLabel = $("param-picker-label");
const paramPickerSearchInput = $<HTMLInputElement>("param-picker-search");
const paramPickerList = $("param-picker-list");
const kpiTotal = $("kpi-total");
const kpiErrors = $("kpi-errors");
const kpiDetach = $("kpi-detach");
const kpiPending = $("kpi-pending");
const kpiPendingWrap = $("kpi-pending-wrap");
const tabCountElements = $("tab-count-elements");
const tabCountChanges = $("tab-count-changes");
const changesList = $("changes-list");
const selCount = $("sel-count");
const btnShow = $<HTMLButtonElement>("btn-show");
const btnIsolate = $<HTMLButtonElement>("btn-isolate");
const btnSection = $<HTMLButtonElement>("btn-section");
const btnResetView = $<HTMLButtonElement>("btn-reset-view");
const btnRefresh = $<HTMLButtonElement>("btn-refresh");
const btnTheme = $<HTMLButtonElement>("btn-theme");
const themeIconSun = $("theme-icon-sun");
const themeIconMoon = $("theme-icon-moon");
const dockPending = $("dock-pending");
const dockSelect = $("dock-select");
const dockChecks = $("dock-checks");
const checksDockLabel = $("checks-dock-label");
const btnRunChecks = $<HTMLButtonElement>("btn-run-checks");
const tabCountChecks = $("tab-count-checks");
const checksView = $("checks-view");
const dashboardView = $("dashboard-view");
const pendingLabel = $("pending-label");
const btnDiscard = $<HTMLButtonElement>("btn-discard");
const btnApply = $<HTMLButtonElement>("btn-apply");
const typeMenu = $("type-menu");
const fillBadge = $("fill-badge");

const app = new App({ name: "MCP Apps · Revit Schedule", version: "2.0.0" });

let fillDrag: FillDrag | null = null;
let fillPointer = { x: 0, y: 0 };
let autoScrollFrame = 0;
let menuAnchor: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Theme: follow the host, with a sun/moon override remembered per viewer.
// ---------------------------------------------------------------------------

function readThemeOverride(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function writeThemeOverride(value: Theme | null) {
  try {
    if (value) localStorage.setItem(THEME_KEY, value);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // Sandboxed iframes may block storage; the override still lasts for this session.
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function baseTheme(): Theme {
  return hostTheme ?? systemTheme();
}

function currentTheme(): Theme {
  return themeOverride ?? baseTheme();
}

function applyTheme() {
  const theme = currentTheme();
  applyDocumentTheme(theme);
  themeIconSun.hidden = theme === "light";
  themeIconMoon.hidden = theme === "dark";
  const label = theme === "dark" ? "Switch to light" : "Switch to dark";
  btnTheme.title = themeOverride ? `${label} (host follows ${baseTheme()})` : label;
  btnTheme.setAttribute("aria-label", label);
}

btnTheme.addEventListener("click", () => {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  // Toggling back to the host's theme clears the override so we follow the host again.
  themeOverride = next === baseTheme() ? null : next;
  writeThemeOverride(themeOverride);
  applyTheme();
});
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme());
applyTheme();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paramKey(elementId: number, name: string) {
  return `${elementId}\0${name}`;
}

function isParamColumn(column: string) {
  return !IDENTITY_COLUMNS.has(column) && !CALCULATED_COLUMNS.has(column);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pad3(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value < 1000 ? String(value).padStart(3, "0") : String(value);
}

function glyph(markup: string) {
  return `<svg class="glyph" viewBox="0 0 12 12" aria-hidden="true">${markup}</svg>`;
}

function categoryGlyph(category: string) {
  return glyph(CATEGORY_GLYPHS[category.trim()] ?? DEFAULT_GLYPH);
}

function isHostRow(row: Record<string, string>): boolean {
  return !row.linkInstanceId;
}

function pendingCount() {
  return pendingTypes.size + pendingParams.size;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function displayParamValue(row: Record<string, string>, column: string, elementId: number) {
  const pending = pendingParams.get(paramKey(elementId, column));
  if (pending) return pending.value;
  return row[column] ?? "";
}

function scheduleArgs(extra?: Record<string, unknown>) {
  return {
    ...lastArgs,
    ...extra,
    parametersOutputType: "EditableInstanceParameters",
  };
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
    status.textContent = "Couldn't read the schedule data";
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

// ---------------------------------------------------------------------------
// Filters, category chips and the column picker
// ---------------------------------------------------------------------------

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
  select.innerHTML =
    `<option value="">All</option>` +
    values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  select.value = values.includes(current) ? current : "";
  return select.value;
}

function refreshFilterOptions() {
  filters.link = fillSelect(filterLink, uniqueValues("link"), filters.link);
  filters.level = fillSelect(filterLevel, uniqueValues("level"), filters.level);
  if (filters.category && !uniqueValues("category").includes(filters.category)) filters.category = "";
  filters.family = fillSelect(filterFamily, uniqueValues("family"), filters.family);
  filters.type = fillSelect(filterType, uniqueValues("type"), filters.type);
  const active = [filters.level, filters.family, filters.type, filters.link].filter(Boolean).length;
  filtersCount.textContent = active ? String(active) : "";
}

function rowMatches(row: Record<string, string>): boolean {
  if (filters.link && (row.link ?? "") !== filters.link) return false;
  if (filters.level && (row.level ?? "") !== filters.level) return false;
  if (filters.category && (row.category ?? "") !== filters.category) return false;
  if (filters.family && (row.family ?? "") !== filters.family) return false;
  if (filters.type && (row.type ?? "") !== filters.type) return false;
  const search = filters.search.trim().toLowerCase();
  if (!search) return true;
  return Object.values(row).some((value) => String(value).toLowerCase().includes(search));
}

function filteredRows(): Record<string, string>[] {
  return allRows.filter(rowMatches);
}

function filteredIds(): number[] {
  return viewRows.map((row) => Number(row.elementId)).filter((id) => Number.isFinite(id));
}

/** Rows matching every filter except category — the basis for category chip counts. */
function rowsForCategoryChips(): Record<string, string>[] {
  const category = filters.category;
  filters.category = "";
  const rows = filteredRows();
  filters.category = category;
  return rows;
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

function renderChips() {
  const counts = categoryCounts(rowsForCategoryChips());
  let html = "";
  if (counts.length > 1 || filters.category) {
    let shown = counts;
    let hidden = 0;
    if (!showAllCategories && counts.length > CATEGORY_CHIP_LIMIT) {
      shown = counts.slice(0, CATEGORY_CHIP_LIMIT);
      const current = counts.find((item) => item.name === filters.category);
      if (current && !shown.includes(current)) shown = [...shown, current];
      hidden = counts.length - shown.length;
    }
    for (const item of shown) {
      const on = filters.category === item.name;
      html += `<button type="button" class="chip${on ? " on" : ""}" data-category="${escapeHtml(item.name)}" aria-pressed="${on}">${categoryGlyph(
        item.name
      )}${escapeHtml(item.name)} <span class="count">${item.count}</span></button>`;
    }
    if (hidden > 0) {
      html += `<button type="button" class="chip ghost" data-more="1">+${hidden} more</button>`;
    } else if (showAllCategories && counts.length > CATEGORY_CHIP_LIMIT) {
      html += `<button type="button" class="chip ghost" data-more="1">fewer</button>`;
    }
  }
  const active = (Object.keys(FILTER_GLYPHS) as (keyof typeof FILTER_GLYPHS)[]).filter((key) => filters[key]);
  if (active.length) {
    if (html) html += `<span class="chip-sep" aria-hidden="true"></span>`;
    for (const key of active) {
      html += `<button type="button" class="chip on" data-clear="${key}" title="Clear ${key} filter">${glyph(
        FILTER_GLYPHS[key]
      )}${escapeHtml(filters[key])} ${ICON_X}</button>`;
    }
  }
  chips.innerHTML = html;
  chips.hidden = !html;
}

chips.addEventListener("click", (event) => {
  const chip = (event.target as HTMLElement).closest("button.chip") as HTMLButtonElement | null;
  if (!chip) return;
  if (chip.dataset.more) {
    showAllCategories = !showAllCategories;
    renderChips();
    return;
  }
  if (chip.dataset.category != null) {
    const name = chip.dataset.category;
    filters.category = filters.category === name ? "" : name;
  } else if (chip.dataset.clear) {
    const key = chip.dataset.clear as keyof typeof FILTER_GLYPHS;
    filters[key] = "";
  }
  refreshFilterOptions();
  render();
});

function collectAvailableParamColumns(): string[] {
  return columns.filter((column) => isParamColumn(column)).sort((a, b) => a.localeCompare(b));
}

function syncParamSelectionWithAvailable() {
  availableParamColumns = collectAvailableParamColumns();
  for (const name of Array.from(selectedParamColumns)) {
    if (!availableParamColumns.includes(name)) selectedParamColumns.delete(name);
  }
  if (!paramPickerInitialized && availableParamColumns.length) {
    for (const pref of DEFAULT_PARAM_PREFS) {
      if (availableParamColumns.includes(pref)) selectedParamColumns.add(pref);
    }
    paramPickerInitialized = true;
  }
}

function updateParamPickerLabel() {
  const n = selectedParamColumns.size;
  paramPickerLabel.textContent = n ? String(n) : "";
  paramPickerTrigger.title = n ? Array.from(selectedParamColumns).join(", ") : "Choose parameter columns";
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
      const on = selectedParamColumns.has(name) ? " checked" : "";
      return `<li data-param="${escapeHtml(name)}"><input type="checkbox"${on} /><span title="${escapeHtml(
        name
      )}">${escapeHtml(name)}</span></li>`;
    })
    .join("");
  updateParamPickerLabel();
}

paramPickerList.addEventListener("click", (event) => {
  const li = (event.target as HTMLElement).closest("li[data-param]") as HTMLElement | null;
  const name = li?.dataset.param;
  if (!li || !name) return;
  const box = li.querySelector("input") as HTMLInputElement | null;
  const on = (event.target as HTMLElement).tagName === "INPUT" ? Boolean(box?.checked) : !selectedParamColumns.has(name);
  if (on) selectedParamColumns.add(name);
  else selectedParamColumns.delete(name);
  if (box) box.checked = on;
  updateParamPickerLabel();
  render();
});

function refreshParamPicker() {
  syncParamSelectionWithAvailable();
  renderParamPickerList();
}

// ---------------------------------------------------------------------------
// Popovers (filters, columns)
// ---------------------------------------------------------------------------

const popovers: { wrap: HTMLElement; trigger: HTMLButtonElement; onOpen?: () => void }[] = [
  { wrap: filtersPop, trigger: filtersTrigger },
  {
    wrap: paramPicker,
    trigger: paramPickerTrigger,
    onOpen: () => {
      renderParamPickerList();
      paramPickerSearchInput.focus();
    },
  },
];

function setPopover(target: HTMLElement | null) {
  for (const pop of popovers) {
    const open = pop.wrap === target && !pop.wrap.classList.contains("open");
    pop.wrap.classList.toggle("open", open);
    pop.trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) pop.onOpen?.();
  }
}

for (const pop of popovers) {
  pop.trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    closeTypeMenu();
    setPopover(pop.wrap);
  });
}

document.addEventListener("click", (event) => {
  const target = event.target as Node | null;
  if (!target) return;
  if (!popovers.some((pop) => pop.wrap.contains(target))) {
    for (const pop of popovers) {
      pop.wrap.classList.remove("open");
      pop.trigger.setAttribute("aria-expanded", "false");
    }
  }
  if (typeMenu.classList.contains("open")) {
    if (typeMenu.contains(target) || (target instanceof Element && target.closest(".type-face"))) return;
    closeTypeMenu();
  }
});

paramPickerSearchInput.addEventListener("input", () => {
  paramPickerSearch = paramPickerSearchInput.value;
  renderParamPickerList();
});
$("param-picker-all").addEventListener("click", () => {
  for (const name of visibleParamOptions()) selectedParamColumns.add(name);
  renderParamPickerList();
  render();
});
$("param-picker-none").addEventListener("click", () => {
  selectedParamColumns.clear();
  renderParamPickerList();
  render();
});

function syncFiltersFromDom() {
  filters.link = filterLink.value;
  filters.level = filterLevel.value;
  filters.family = filterFamily.value;
  filters.type = filterType.value;
  filters.search = filterSearch.value;
  refreshFilterOptions();
  render();
}

for (const el of [filterLink, filterLevel, filterFamily, filterType]) {
  el.addEventListener("change", syncFiltersFromDom);
}
filterSearch.addEventListener("input", syncFiltersFromDom);

$("btn-clear-filters").addEventListener("click", () => {
  filters.link = "";
  filters.level = "";
  filters.category = "";
  filters.family = "";
  filters.type = "";
  filters.search = "";
  filterSearch.value = "";
  refreshFilterOptions();
  render();
});

// ---------------------------------------------------------------------------
// Family types + type menu
// ---------------------------------------------------------------------------

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

function closeTypeMenu() {
  typeMenu.classList.remove("open");
  typeMenu.innerHTML = "";
  menuAnchor = null;
}

function placeTypeMenu(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, Math.max(rect.width, 220));
  const menuHeight = Math.min(typeMenu.scrollHeight || 240, 240);
  const spaceBelow = window.innerHeight - rect.bottom;
  const top =
    spaceBelow < menuHeight + 8 && rect.top > menuHeight + 8 ? rect.top - menuHeight - 4 : rect.bottom + 4;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  typeMenu.style.width = `${width}px`;
  typeMenu.style.left = `${left}px`;
  typeMenu.style.top = `${Math.max(8, top)}px`;
}

/** Host rows that are checked, in view, and share the given category. */
function checkedHostIds(category?: string): number[] {
  return viewRows
    .filter((row) => {
      const id = Number(row.elementId);
      if (!checked.has(id) || !isHostRow(row)) return false;
      return category == null || (row.category ?? "").trim() === category.trim();
    })
    .map((row) => Number(row.elementId));
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

  const bulkIds = checkedHostIds(category);
  if (bulkIds.length > 1 || (bulkIds.length === 1 && bulkIds[0] !== elementId)) {
    typeMenu.insertAdjacentHTML(
      "beforeend",
      `<div class="menu-hint">ctrl+click → all ${bulkIds.length} selected ${escapeHtml(category.toLowerCase())}</div>`
    );
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
      const targets = event.ctrlKey || event.metaKey ? new Set([elementId, ...bulkIds]) : new Set([elementId]);
      for (const id of targets) pendingTypes.set(id, pending);
      selectedCell = { rowIndex, column: "family" };
      closeTypeMenu();
      render();
      status.textContent =
        targets.size > 1
          ? `${typeName} queued for ${targets.size} elements. Review in Changes, then Apply.`
          : `${typeName} queued. Drag the dot down to fill, then Apply.`;
    });
    typeMenu.appendChild(choice);
  }
  placeTypeMenu(anchor);
}

// ---------------------------------------------------------------------------
// Fill-drag: live preview, skip reasons, auto-scroll, Esc to cancel
// ---------------------------------------------------------------------------

function cellSelector(rowIndex: number, column: string) {
  return `td[data-row-index="${rowIndex}"][data-column="${CSS.escape(column)}"]`;
}

function fillValue(drag: FillDrag) {
  return drag.kind === "type" ? drag.pendingType?.type ?? "" : drag.paramValue ?? "";
}

function currentFillValue(row: Record<string, string>, drag: FillDrag) {
  const id = Number(row.elementId);
  if (drag.kind === "type") return pendingTypes.get(id)?.type || (row.type ?? "");
  return displayParamValue(row, drag.column, id);
}

function fillSkipReason(row: Record<string, string>, drag: FillDrag): string | null {
  if (!isHostRow(row)) return "skipped · linked";
  if (!Number.isFinite(Number(row.elementId))) return "skipped";
  if (drag.kind === "type" && (row.category ?? "").trim() !== (drag.category ?? "").trim()) {
    return "skipped · other category";
  }
  return null;
}

function clearFillHighlights() {
  table.querySelectorAll("td.fill-range, td.fill-skip, td.fill-source").forEach((el) => {
    const td = el as HTMLElement;
    td.classList.remove("fill-range", "fill-skip", "fill-source", "fill-start", "fill-end");
    delete td.dataset.fillValue;
    delete td.dataset.fillOld;
    delete td.dataset.fillSkip;
  });
}

function paintFillRange(drag: FillDrag): { fill: number; skip: number } {
  clearFillHighlights();
  const lo = Math.min(drag.startIndex, drag.endIndex);
  const hi = Math.max(drag.startIndex, drag.endIndex);
  const next = fillValue(drag);
  let fill = 0;
  let skip = 0;
  for (let i = lo; i <= hi; i++) {
    const td = table.querySelector(cellSelector(i, drag.column)) as HTMLElement | null;
    const row = viewRows[i];
    if (!td || !row) continue;
    if (i === drag.startIndex) {
      td.classList.add("fill-source");
      continue;
    }
    const reason = fillSkipReason(row, drag);
    if (reason) {
      td.classList.add("fill-skip");
      td.dataset.fillSkip = reason;
      skip++;
    } else {
      td.classList.add("fill-range");
      td.dataset.fillValue = next || "(empty)";
      const old = currentFillValue(row, drag);
      if (old && old !== next) td.dataset.fillOld = old;
      fill++;
    }
    if (i === lo) td.classList.add("fill-start");
    if (i === hi) td.classList.add("fill-end");
  }
  return { fill, skip };
}

function updateFillBadge(counts: { fill: number; skip: number }) {
  if (counts.fill + counts.skip === 0) {
    fillBadge.hidden = true;
    return;
  }
  fillBadge.textContent = `fill ${counts.fill}` + (counts.skip ? ` · skip ${counts.skip}` : "");
  fillBadge.hidden = false;
  const x = Math.min(fillPointer.x + 14, window.innerWidth - fillBadge.offsetWidth - 8);
  const y = Math.min(fillPointer.y + 16, window.innerHeight - 28);
  fillBadge.style.left = `${Math.max(8, x)}px`;
  fillBadge.style.top = `${Math.max(8, y)}px`;
}

/** The part of the table body the user can actually see: below the sticky header, above the dock and frame edge. */
function visibleTableBox() {
  const rect = table.getBoundingClientRect();
  const headHeight = table.querySelector("thead")?.getBoundingClientRect().height ?? 32;
  const dockTop = (document.querySelector(".dock") as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity;
  // client* excludes the scrollbars, which would otherwise swallow edge hit-tests.
  const left = rect.left + table.clientLeft;
  const top = rect.top + table.clientTop;
  return {
    left,
    right: left + table.clientWidth,
    top: Math.max(top, 0) + headHeight,
    bottom: Math.min(top + table.clientHeight, window.innerHeight, dockTop),
  };
}

/** Find the row under the pointer, clamped into the visible table so edge drags still resolve. */
function updateFillTarget() {
  if (!fillDrag) return;
  const box = visibleTableBox();
  const x = Math.min(Math.max(fillPointer.x, box.left + 4), box.right - 4);
  const y = Math.min(Math.max(fillPointer.y, box.top + 2), box.bottom - 2);
  // elementsFromPoint looks through overlays (dock, badge) to the row underneath.
  const hit = document.elementsFromPoint(x, y).find((el) => el.closest("tr[data-row-index]"));
  const tr = hit?.closest("tr[data-row-index]") as HTMLElement | undefined;
  const idx = tr ? Number(tr.dataset.rowIndex) : NaN;
  if (Number.isFinite(idx)) fillDrag.endIndex = idx;
  updateFillBadge(paintFillRange(fillDrag));
}

function autoScrollStep() {
  autoScrollFrame = 0;
  if (!fillDrag) return;
  const box = visibleTableBox();
  const edge = 40;
  let dy = 0;
  if (fillPointer.y < box.top + edge) dy = -(box.top + edge - fillPointer.y) / 3;
  else if (fillPointer.y > box.bottom - edge) dy = (fillPointer.y - (box.bottom - edge)) / 3;
  if (dy === 0) return;
  dy = Math.max(-40, Math.min(40, Math.round(dy) || Math.sign(dy)));
  const before = table.scrollTop;
  table.scrollTop += dy;
  if (table.scrollTop !== before) updateFillTarget();
  autoScrollFrame = requestAnimationFrame(autoScrollStep);
}

function startFill(drag: Omit<FillDrag, "endIndex">, event: MouseEvent) {
  fillDrag = { ...drag, endIndex: drag.startIndex };
  fillPointer = { x: event.clientX, y: event.clientY };
  document.body.classList.add("filling");
  closeTypeMenu();
  updateFillBadge(paintFillRange(fillDrag));
}

function endFill() {
  fillDrag = null;
  if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
  autoScrollFrame = 0;
  document.body.classList.remove("filling");
  fillBadge.hidden = true;
  clearFillHighlights();
}

function cancelFill() {
  if (!fillDrag) return;
  endFill();
  paintSelection();
  status.textContent = "Fill cancelled";
}

function applyFillRange(drag: FillDrag) {
  const lo = Math.min(drag.startIndex, drag.endIndex);
  const hi = Math.max(drag.startIndex, drag.endIndex);
  let applied = 0;
  let skipped = 0;
  for (let i = lo; i <= hi; i++) {
    const row = viewRows[i];
    if (!row || i === drag.startIndex) continue;
    if (fillSkipReason(row, drag)) {
      skipped++;
      continue;
    }
    const id = Number(row.elementId);
    if (drag.kind === "type" && drag.pendingType) pendingTypes.set(id, drag.pendingType);
    else if (drag.kind === "param" && drag.paramName != null) {
      pendingParams.set(paramKey(id, drag.paramName), { elementId: id, name: drag.paramName, value: drag.paramValue ?? "" });
    }
    applied++;
  }
  selectedCell = { rowIndex: drag.endIndex, column: drag.column };
  render();
  const what = drag.kind === "type" ? drag.pendingType?.type ?? "" : `${drag.paramName} = "${drag.paramValue ?? ""}"`;
  status.textContent =
    `Filled ${plural(applied, "row")} with ${what}` + (skipped ? ` · skipped ${skipped}` : "") + ". Apply when ready.";
}

document.addEventListener("mousemove", (event) => {
  if (!fillDrag) return;
  fillPointer = { x: event.clientX, y: event.clientY };
  updateFillTarget();
  if (!autoScrollFrame) autoScrollFrame = requestAnimationFrame(autoScrollStep);
});

document.addEventListener("mouseup", () => {
  if (!fillDrag) return;
  const drag = fillDrag;
  endFill();
  if (drag.startIndex === drag.endIndex) {
    paintSelection();
    return;
  }
  applyFillRange(drag);
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function paintSelection() {
  table.querySelectorAll("td.cell-selected").forEach((td) => td.classList.remove("cell-selected"));
  if (!selectedCell || fillDrag) return;
  table.querySelector(cellSelector(selectedCell.rowIndex, selectedCell.column))?.classList.add("cell-selected");
}

function columnsForTable(rows: Record<string, string>[]): string[] {
  const skip = new Set(["elementId", "linkInstanceId", "name", "type", ...CALCULATED_COLUMNS]);
  let cols = columns.filter((column) => !skip.has(column));
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
  return [...head, ...paramCols];
}

function render() {
  closeTypeMenu();
  const rows = filteredRows();
  viewRows = rows;
  renderChips();

  if (allRows.length === 0) {
    table.innerHTML = `<div class="empty"><b>No elements loaded</b><span>Ask Claude to load a schedule, or reload from Revit.</span></div>`;
    syncDock();
    return;
  }
  if (rows.length === 0) {
    table.innerHTML = `<div class="empty"><b>No matches</b><span>Try another search, or clear the filters.</span></div>`;
    status.textContent = `0 shown / ${allRows.length} loaded`;
    syncDock();
    return;
  }

  const visible = columnsForTable(rows);
  const allFilteredChecked = rows.every((row) => checked.has(Number(row.elementId)));
  const labels: Record<string, string> = { family: "type" };

  let html = "<table><thead><tr>";
  html += `<th class="check-col"><input type="checkbox" id="check-all" aria-label="Select all in view" title="Select all. Shift-click rows to select a range."${
    allFilteredChecked ? " checked" : ""
  } /></th>`;
  for (const column of visible) {
    html += `<th>${escapeHtml(labels[column] ?? column)}</th>`;
  }
  html += "</tr></thead><tbody>";

  rows.forEach((row, rowIndex) => {
    const id = Number(row.elementId);
    const host = isHostRow(row);
    const rowClass = [checked.has(id) ? "sel" : "", pendingTypes.has(id) ? "dirty" : ""].filter(Boolean).join(" ");
    html += `<tr data-row-index="${rowIndex}"${rowClass ? ` class="${rowClass}"` : ""}>`;
    html += `<td class="check-col"><input type="checkbox" data-id="${escapeHtml(row.elementId)}" aria-label="Select row" title="Shift-click to select a range"${
      checked.has(id) ? " checked" : ""
    } /></td>`;
    for (const column of visible) {
      const at = `data-column="${escapeHtml(column)}" data-row-index="${rowIndex}"`;
      if (column === "family") {
        const pending = pendingTypes.get(id);
        const label = pending?.type || (row.type ?? "").trim() || (row.family ?? "");
        const title = escapeHtml((row.family ?? "") + (row.type ? " · " + row.type : ""));
        if (host) {
          html += `<td class="family-cell" ${at}><button type="button" class="type-face" title="${title}"><span class="label${
            pending ? " hl" : ""
          }">${escapeHtml(label || "Select type")}</span>${ICON_CHEVRON}</button><span class="fill-handle${
            pending ? "" : " idle"
          }" title="Drag to fill this type"></span></td>`;
        } else {
          html += `<td class="family-cell readonly" ${at} title="${title}"><span class="cat-cell">${ICON_LOCK}${escapeHtml(
            label
          )}</span></td>`;
        }
      } else if (column === "level") {
        html += `<td class="level-cell" ${at}>${escapeHtml(row.level ?? "")}</td>`;
      } else if (column === "category") {
        html += `<td ${at}><span class="cat-cell">${categoryGlyph(row.category ?? "")}${escapeHtml(
          row.category ?? ""
        )}</span></td>`;
      } else if (isParamColumn(column)) {
        const value = displayParamValue(row, column, id);
        const dirty = pendingParams.has(paramKey(id, column));
        if (host) {
          const inner = dirty ? `<span class="hl">${escapeHtml(value) || "(empty)"}</span>` : escapeHtml(value);
          html += `<td class="param-cell editable" ${at} title="Double-click to edit"><span class="cell-value">${inner}</span><span class="fill-handle" title="Drag to fill"></span></td>`;
        } else {
          html += `<td class="param-cell readonly" ${at} title="Linked — read-only">${escapeHtml(value)}</td>`;
        }
      } else {
        html += `<td class="muted" ${at}>${escapeHtml(row[column] ?? "")}</td>`;
      }
    }
    html += "</tr>";
  });
  html += "</tbody></table>";
  table.innerHTML = html;

  paintSelection();
  status.textContent =
    `${rows.length} shown / ${allRows.length} loaded` +
    (lastTotalMatched > allRows.length ? ` · ${lastTotalMatched} matched` : "");
  syncDock();
}

function paintRowChecks(from: number, to: number) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) {
    const tr = table.querySelector(`tr[data-row-index="${i}"]`);
    const box = tr?.querySelector("input[data-id]") as HTMLInputElement | null;
    const id = Number(viewRows[i]?.elementId);
    if (!box || !Number.isFinite(id)) continue;
    box.checked = checked.has(id);
    tr?.classList.toggle("sel", box.checked);
  }
  const allBox = table.querySelector("#check-all") as HTMLInputElement | null;
  if (allBox) allBox.checked = viewRows.length > 0 && viewRows.every((row) => checked.has(Number(row.elementId)));
}

/** True while a Shift-click is settling, so the checkbox's own toggle does not move the anchor. */
let shiftSelecting = false;

table.addEventListener("click", (event) => {
  const input = (event.target as HTMLElement).closest("input[data-id]") as HTMLInputElement | null;
  if (!input || !event.shiftKey) return;
  const index = Number(input.closest("tr")?.dataset.rowIndex);
  const id = Number(input.dataset.id);
  if (!Number.isFinite(index) || !Number.isFinite(id)) return;
  const anchor = checkAnchor;
  shiftSelecting = true;
  // The browser toggles the clicked box after this listener. Apply the range
  // once that toggle has landed, or the clicked row ends up unchecked.
  setTimeout(() => {
    shiftSelecting = false;
    if (anchor == null) {
      checkAnchor = index;
      if (input.checked) checked.add(id);
      else checked.delete(id);
      input.closest("tr")?.classList.toggle("sel", input.checked);
      syncDock();
      return;
    }
    const lo = Math.min(anchor, index);
    const hi = Math.max(anchor, index);
    for (let i = lo; i <= hi; i++) {
      const rowId = Number(viewRows[i]?.elementId);
      if (Number.isFinite(rowId)) checked.add(rowId);
    }
    checked.add(id);
    paintRowChecks(lo, hi);
    input.checked = true;
    input.closest("tr")?.classList.add("sel");
    syncDock();
  }, 0);
});

table.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === "check-all") {
    for (const id of filteredIds()) {
      if (target.checked) checked.add(id);
      else checked.delete(id);
    }
    checkAnchor = null;
    render();
    return;
  }
  const id = Number(target.dataset.id);
  if (!Number.isFinite(id)) return;
  if (target.checked) checked.add(id);
  else checked.delete(id);
  if (!shiftSelecting) {
    const index = Number(target.closest("tr")?.dataset.rowIndex);
    if (Number.isFinite(index)) checkAnchor = index;
  }
  target.closest("tr")?.classList.toggle("sel", target.checked);
  syncDock();
});

function cellFromEvent(event: Event): { td: HTMLElement; row: Record<string, string>; rowIndex: number; column: string } | null {
  const td = (event.target as HTMLElement).closest("td[data-row-index]") as HTMLElement | null;
  if (!td) return null;
  const rowIndex = Number(td.dataset.rowIndex);
  const row = viewRows[rowIndex];
  const column = td.dataset.column ?? "";
  if (!row || !column) return null;
  return { td, row, rowIndex, column };
}

table.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !(event.target as HTMLElement).closest(".fill-handle")) return;
  const cell = cellFromEvent(event);
  if (!cell || !isHostRow(cell.row)) return;
  const id = Number(cell.row.elementId);
  event.preventDefault();
  event.stopPropagation();
  if (cell.column === "family") {
    const pending = pendingTypes.get(id);
    if (!pending) return;
    startFill(
      { kind: "type", column: "family", startIndex: cell.rowIndex, pendingType: pending, category: cell.row.category ?? "" },
      event
    );
  } else if (isParamColumn(cell.column)) {
    selectedCell = { rowIndex: cell.rowIndex, column: cell.column };
    startFill(
      {
        kind: "param",
        column: cell.column,
        startIndex: cell.rowIndex,
        paramName: cell.column,
        paramValue: displayParamValue(cell.row, cell.column, id),
      },
      event
    );
  }
});

table.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest(".fill-handle") || target.tagName === "INPUT") return;
  const cell = cellFromEvent(event);
  if (!cell) return;
  const face = target.closest("button.type-face") as HTMLButtonElement | null;
  if (face) {
    event.stopPropagation();
    selectedCell = { rowIndex: cell.rowIndex, column: "family" };
    paintSelection();
    if (menuAnchor === face) closeTypeMenu();
    else void openTypeMenu(face, cell.row, cell.rowIndex);
    return;
  }
  if (cell.td.classList.contains("editable")) {
    selectedCell = { rowIndex: cell.rowIndex, column: cell.column };
    paintSelection();
  }
});

table.addEventListener("dblclick", (event) => {
  const cell = cellFromEvent(event);
  if (!cell || !cell.td.classList.contains("editable")) return;
  event.preventDefault();
  beginCellEdit(cell.td, Number(cell.row.elementId), cell.column, cell.rowIndex);
});

table.addEventListener("scroll", () => closeTypeMenu());

function beginCellEdit(td: HTMLElement, elementId: number, column: string, rowIndex: number) {
  if (td.querySelector("input.cell-edit")) return;
  selectedCell = { rowIndex, column };
  paintSelection();
  const current = displayParamValue(viewRows[rowIndex] ?? {}, column, elementId);
  const valueEl = td.querySelector(".cell-value");
  if (!valueEl) return;
  const input = document.createElement("input");
  input.className = "cell-edit";
  input.value = current;
  valueEl.replaceWith(input);
  input.focus();
  input.select();
  let bulk = false;
  let done = false;

  const commit = () => {
    if (done) return;
    done = true;
    const next = input.value;
    if (bulk) {
      const targets = new Set([elementId, ...checkedHostIds()]);
      for (const id of targets) pendingParams.set(paramKey(id, column), { elementId: id, name: column, value: next });
      render();
      status.textContent = `${column} = "${next}" queued for ${plural(targets.size, "selected row")}. Apply when ready.`;
      return;
    }
    if (next !== current) pendingParams.set(paramKey(elementId, column), { elementId, name: column, value: next });
    render();
    if (next !== current) status.textContent = `${column} = "${next}" queued. Drag the dot to fill, then Apply.`;
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      bulk = event.ctrlKey || event.metaKey;
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      done = true;
      render();
    }
  });
}

// ---------------------------------------------------------------------------
// Stats, tabs, changes panel, dock
// ---------------------------------------------------------------------------

let lastTotalMatched = 0;

function updateStats() {
  kpiTotal.textContent = allRows.length ? pad3(allRows.length) : "—";
  kpiErrors.textContent = pad3(dashboardStats?.errorCount ?? dashboardStats?.warningCount);
  kpiDetach.textContent = pad3(dashboardStats?.detachableFamilyCount);
}

function syncDock() {
  const pending = pendingCount();
  kpiPending.textContent = pad3(pending);
  kpiPendingWrap.classList.toggle("idle", pending === 0);
  tabCountElements.textContent = allRows.length ? String(viewRows.length) : "";
  tabCountChanges.textContent = pending ? String(pending) : "";
  tabCountChanges.classList.toggle("hot", pending > 0);

  const ids = targetIds();
  const selectedInView = viewRows.filter((row) => checked.has(Number(row.elementId))).length;
  const scope = filters.category || filters.type || filters.family || "";
  selCount.textContent = selectedInView
    ? `${selectedInView} selected`
    : scope
      ? `${viewRows.length} ${scope}`
      : `${viewRows.length} in view`;
  btnShow.disabled = busy || (ids.length === 0 && viewRows.length === 0);
  btnIsolate.disabled = busy || (ids.length === 0 && viewRows.length === 0);
  btnSection.hidden = !sectionBoxActive && selectedInView === 0;
  btnSection.disabled = busy;
  btnSection.textContent = sectionBoxActive ? "Reset section box" : "Section box";
  btnSection.title = sectionBoxActive
    ? "Turn the section box off and zoom the view to fit"
    : "Section box around the checked elements";
  btnResetView.disabled = busy || allRows.length === 0;

  // 01/02 dock: selection + Apply. 03/04 dock: Run checks (one primary button per view).
  const checksTab = activeTab === "checks" || activeTab === "dashboard";
  const rulesOn = checks?.enabledCount() ?? null;
  dockSelect.hidden = checksTab;
  dockPending.hidden = checksTab || pending === 0;
  dockChecks.hidden = !checksTab;
  tabCountChecks.textContent = rulesOn == null ? "" : String(rulesOn);
  checksDockLabel.textContent = checks?.dockLabel() ?? "";
  btnRunChecks.disabled = Boolean(checks?.isRunning());
  pendingLabel.textContent = `${pending} unsaved`;
  btnApply.textContent = `Apply ${pending} →`;
  btnApply.disabled = busy;
  btnDiscard.disabled = busy;
  btnRefresh.classList.toggle("spin", busy);

  if (activeTab === "changes") renderChanges();
  scheduleModelContext();
}

function setBusy(next: boolean, message?: string) {
  busy = next;
  if (message) status.textContent = message;
  syncDock();
}

function setTab(tab: TabName) {
  activeTab = tab;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((el) => {
    const on = el.dataset.tab === tab;
    el.classList.toggle("on", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  });
  $("panel-elements").hidden = tab !== "elements";
  $("panel-changes").hidden = tab !== "changes";
  $("panel-checks").hidden = tab !== "checks";
  $("panel-dashboard").hidden = tab !== "dashboard";
  closeTypeMenu();
  if (tab === "changes") renderChanges();
  if (tab === "checks" || tab === "dashboard") void checks?.show(tab);
  syncDock();
}

// ---------------------------------------------------------------------------
// 03 Checks + 04 Dashboard — rendering and behaviour live in checks-view.ts (rules_* / checks_* tools).
// ---------------------------------------------------------------------------

const OST_TO_NAME = new Map(Object.entries(CATEGORY_TO_OST).map(([name, ost]) => [ost, name]));

checks = createChecksView({
  app,
  checksView,
  dashboardView,
  setStatus: (message) => {
    status.textContent = message;
  },
  escapeHtml,
  pad3,
  categoryGlyph,
  categoryName: (ost) => OST_TO_NAME.get(ost) ?? ost.replace(/^OST_/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
  onChange: () => syncDock(),
});

btnRunChecks.addEventListener("click", () => void checks?.run());

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((el) => {
  el.addEventListener("click", () => setTab((el.dataset.tab as TabName) ?? "elements"));
});

function renderChanges() {
  const typeGroups = new Map<number, { pending: PendingType; ids: number[] }>();
  for (const [id, pending] of pendingTypes) {
    const group = typeGroups.get(pending.typeId) ?? { pending, ids: [] };
    group.ids.push(id);
    typeGroups.set(pending.typeId, group);
  }
  const paramGroups = new Map<string, { name: string; value: string; ids: number[] }>();
  for (const pending of pendingParams.values()) {
    const key = `${pending.name}\0${pending.value}`;
    const group = paramGroups.get(key) ?? { name: pending.name, value: pending.value, ids: [] };
    group.ids.push(pending.elementId);
    paramGroups.set(key, group);
  }
  if (typeGroups.size === 0 && paramGroups.size === 0) {
    changesList.innerHTML = `<div class="empty"><b>No unsaved changes</b><span>Edit cells or drag to fill in Elements. Changes wait here until you apply them.</span></div>`;
    return;
  }
  let html = "";
  for (const [typeId, group] of typeGroups) {
    html += `<div class="change"><span class="kind">type</span><span class="what" title="${escapeHtml(
      group.pending.family
    )}">${escapeHtml(group.pending.family)} : <span class="hl">${escapeHtml(group.pending.type)}</span></span><span class="scope" title="${group.ids.join(
      ", "
    )}">${plural(group.ids.length, "element")}</span><button type="button" class="remove" data-remove-type="${typeId}" aria-label="Remove this change">${ICON_X}</button></div>`;
  }
  for (const [key, group] of paramGroups) {
    html += `<div class="change"><span class="kind">param</span><span class="what">${escapeHtml(
      group.name
    )} → <span class="hl">${escapeHtml(group.value) || "(empty)"}</span></span><span class="scope" title="${group.ids.join(
      ", "
    )}">${plural(group.ids.length, "element")}</span><button type="button" class="remove" data-remove-param="${escapeHtml(
      encodeURIComponent(key)
    )}" aria-label="Remove this change">${ICON_X}</button></div>`;
  }
  changesList.innerHTML = html;
}

changesList.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest("button.remove") as HTMLButtonElement | null;
  if (!btn) return;
  if (btn.dataset.removeType) {
    const typeId = Number(btn.dataset.removeType);
    for (const [id, pending] of Array.from(pendingTypes)) {
      if (pending.typeId === typeId) pendingTypes.delete(id);
    }
  } else if (btn.dataset.removeParam) {
    const key = decodeURIComponent(btn.dataset.removeParam);
    for (const [k, pending] of Array.from(pendingParams)) {
      if (`${pending.name}\0${pending.value}` === key) pendingParams.delete(k);
    }
  }
  render();
  status.textContent = "Change removed";
});

/** Checked rows in view, or every row in view when nothing is checked. */
function targetRows(): Record<string, string>[] {
  const picked = viewRows.filter((row) => checked.has(Number(row.elementId)));
  return picked.length ? picked : viewRows;
}

/**
 * Ids in the host document. Linked rows use the RevitLinkInstance id.
 * IsolateElementsTemporary cannot take element ids from inside a link.
 */
function hostTargets(rows: Record<string, string>[]): { ids: number[]; linkNames: string[]; hostCount: number } {
  const ids = new Set<number>();
  const linkNames = new Set<string>();
  let hostCount = 0;
  for (const row of rows) {
    if (isHostRow(row)) {
      const id = Number(row.elementId);
      if (!Number.isFinite(id)) continue;
      ids.add(id);
      hostCount++;
    } else {
      const id = Number(row.linkInstanceId);
      if (!Number.isFinite(id)) continue;
      ids.add(id);
      const name = (row.link ?? "").trim();
      if (name) linkNames.add(name);
    }
  }
  return { ids: [...ids], linkNames: [...linkNames], hostCount };
}

/** Category, type, level, family, or search is on. Link-only is not enough — that still means the whole link. */
function narrowedFilters(): boolean {
  return Boolean(
    filters.category || filters.level || filters.family || filters.type || filters.search.trim()
  );
}

function hostElementIds(rows: Record<string, string>[]): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (!isHostRow(row)) continue;
    const id = Number(row.elementId);
    if (Number.isFinite(id)) ids.add(id);
  }
  return [...ids];
}

function targetIds(): number[] {
  const rows = targetRows();
  if (rows.length === 0) return [];
  const checkedCount = viewRows.filter((row) => checked.has(Number(row.elementId))).length;
  if (narrowedFilters() || checkedCount > 0) {
    const hostIds = hostElementIds(rows);
    if (hostIds.length > 0 || narrowedFilters()) return hostIds;
  }
  return hostTargets(rows).ids;
}

function linkInstanceIds(rows: Record<string, string>[]): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (isHostRow(row)) continue;
    const id = Number(row.linkInstanceId);
    if (Number.isFinite(id)) ids.add(id);
  }
  return [...ids];
}

function toolError(text: string | undefined): string | null {
  if (!text) return null;
  if (text.startsWith("Operate elements failed")) return text;
  try {
    const parsed = JSON.parse(text) as {
      Success?: boolean;
      success?: boolean;
      Message?: string;
      message?: string;
    };
    if (parsed.Success === false || parsed.success === false) {
      return parsed.Message || parsed.message || text.slice(0, 240);
    }
    return null;
  } catch {
    if (/"Success"\s*:\s*false/.test(text) || /"success"\s*:\s*false/.test(text)) return text.slice(0, 240);
    return null;
  }
}

async function callHostTool(name: string, elementIds: number[], action?: string) {
  const result = (await app.callServerTool({
    name,
    arguments: action ? { data: { elementIds, action } } : { elementIds },
  })) as ToolResult;
  const error = toolError(textFromResult(result));
  if (error) throw new Error(error);
}

/**
 * The Revit socket parses each read as one JSON object, and one read is 8192 bytes.
 * A few hundred ids fit. A whole category such as Walls (~1200 ids) is split and rejected.
 */
const SOCKET_ID_LIMIT = 400;

/** Collect and show or isolate one category inside Revit, so the id list never crosses the socket. */
const RESET_SECTION_CODE = `
var uiDoc = new UIDocument(document);
View3D view3d = uiDoc.ActiveView as View3D;
if (view3d == null) {
    view3d = new FilteredElementCollector(document)
        .OfClass(typeof(View3D))
        .Cast<View3D>()
        .FirstOrDefault(v => !v.IsTemplate && !v.IsLocked && (v.Name.Contains("{3D}") || v.Name.Contains("Default 3D")));
}
if (view3d == null) throw new Exception("No 3D view to reset.");
if (uiDoc.ActiveView == null || uiDoc.ActiveView.Id != view3d.Id) uiDoc.ActiveView = view3d;
using (var t = new Transaction(document, "Reset section box")) {
    t.Start();
    view3d.IsSectionBoxActive = false;
    t.Commit();
}
var open = uiDoc.GetOpenUIViews().FirstOrDefault(v => v.ViewId == view3d.Id);
if (open != null) open.ZoomToFit();
return "reset";
`;

const CATEGORY_VIEW_CODE = `
var uiDoc = new UIDocument(document);
var view = uiDoc.ActiveView;
if (view == null) throw new Exception("No active view");
var bic = (BuiltInCategory)Enum.Parse(typeof(BuiltInCategory), (string)parameters[0]);
var mode = (string)parameters[1];
var ids = new FilteredElementCollector(document)
    .OfCategory(bic)
    .WhereElementIsNotElementType()
    .ToElementIds()
    .ToList();
if (ids.Count == 0) throw new Exception("No elements in that category");
if (mode == "isolate") {
    using (var t = new Transaction(document, "Isolate category")) {
        t.Start();
        if (view.IsInTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate))
            view.DisableTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate);
        view.IsolateElementsTemporary(ids);
        t.Commit();
    }
}
else {
    uiDoc.Selection.SetElementIds(ids);
}
try { uiDoc.ShowElements(ids); }
catch (Exception) { uiDoc.ShowElements(ids.Take(200).ToList()); }
return ids.Count;
`;

async function callSendCode(code: string, parameters: string[]): Promise<string> {
  const result = (await app.callServerTool({
    name: "send_code_to_revit",
    arguments: { code, parameters, transactionMode: "none" },
  })) as ToolResult;
  const text = textFromResult(result) ?? "";
  if (
    text.startsWith("Code execution failed") ||
    text.includes("代码编译错误") ||
    text.includes("执行失败") ||
    /"success"\s*:\s*false/i.test(text)
  ) {
    throw new Error(text.slice(0, 400));
  }
  return text;
}

async function showCategoryInRevit(mode: ShowMode, ost: string, category: string, skippedLinks: number) {
  setBusy(true, `${mode === "isolate" ? "Isolating" : "Selecting"} ${category}…`);
  try {
    await callSendCode(CATEGORY_VIEW_CODE, [ost, mode === "isolate" ? "isolate" : "select"]);
    const base = mode === "isolate" ? `Isolated ${category}` : `Selected and zoomed ${category}`;
    status.textContent = skippedLinks
      ? `${base}. ${plural(skippedLinks, "linked row")} skipped — Revit cannot show elements inside a link one by one.`
      : base;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
}

/** A hidden Revit link stays invisible under temporary isolate until the instance and its type are unhidden. */
async function unhideLinkedModels(linkIds: number[]) {
  if (linkIds.length === 0) return;
  const typeIds = new Set<number>();
  try {
    const result = (await app.callServerTool({
      name: "get_element_data",
      arguments: {
        elementIds: linkIds,
        outputOptions: {
          basicElementInfo: false,
          parametersOutputType: "SpecificParameters",
          specificParameterNames: ["Type Id"],
        },
      },
    })) as ToolResult;
    const text = textFromResult(result) ?? "";
    const re = /"Type Id"\s*:\s*"(\d+)"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const id = Number(match[1]);
      if (Number.isFinite(id)) typeIds.add(id);
    }
  } catch {
    // Isolate can still run if the type id lookup fails.
  }
  const ids = [...new Set([...linkIds, ...typeIds])];
  try {
    await callHostTool("operate_element", ids, "Unhide");
  } catch {
    // Already visible. UnhideElements rejects elements that are not hidden.
  }
}

function showStatus(mode: ShowMode, hostCount: number, linkNames: string[]): string {
  if (linkNames.length === 0) {
    return mode === "isolate"
      ? `Isolated, selected and zoomed ${hostCount}`
      : `Selected and zoomed ${hostCount}`;
  }
  const linkLabel = linkNames.length === 1 ? linkNames[0] : `${linkNames.length} linked models`;
  if (hostCount === 0) {
    return mode === "isolate"
      ? `Isolated ${linkLabel}. The whole link is shown; Revit cannot isolate single elements inside a link.`
      : `Selected and zoomed ${linkLabel}`;
  }
  return mode === "isolate"
    ? `Isolated ${hostCount} host elements and ${linkLabel}`
    : `Selected and zoomed ${hostCount} host elements and ${linkLabel}`;
}

async function hideLinkedModels(): Promise<number> {
  const linkIds = linkInstanceIds(allRows);
  if (linkIds.length === 0) return 0;
  await callHostTool("operate_element", linkIds, "TempHide");
  return linkIds.length;
}

function hostActionLabel(mode: ShowMode, count: number, skippedLinks: number): string {
  const what = filters.category ? `${count} ${filters.category}` : plural(count, "element");
  const base = mode === "isolate" ? `Isolated ${what}` : `Selected and zoomed ${what}`;
  if (!skippedLinks) return base;
  return `${base}. ${plural(skippedLinks, "linked row")} skipped — Revit cannot show elements inside a link one by one.`;
}

/** Select and zoom. Isolate first when asked. A zoom failure does not hide a finished isolate. */
async function frameElements(mode: ShowMode, ids: number[], done: string) {
  setBusy(true, `${mode === "isolate" ? "Isolating" : "Selecting"} ${plural(ids.length, "element")}…`);
  let isolated = false;
  try {
    if (mode === "isolate") {
      await callHostTool("operate_element", ids, "Isolate");
      isolated = true;
    }
    let followUp: string | null = null;
    try {
      await callHostTool("select_elements", ids);
    } catch (error) {
      followUp = error instanceof Error ? error.message : String(error);
      if (!isolated) throw error;
    }
    try {
      await callHostTool("zoom_to_elements", ids);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ids.length > 200) {
        try {
          await callHostTool("zoom_to_elements", ids.slice(0, 200));
        } catch {
          followUp = followUp ?? message;
        }
      } else if (!isolated) {
        throw error;
      } else {
        followUp = followUp ?? message;
      }
    }
    status.textContent = followUp && isolated ? `${done} (${followUp})` : done;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
}

async function showInRevit(mode: ShowMode) {
  const rows = targetRows();
  const checkedCount = viewRows.filter((row) => checked.has(Number(row.elementId))).length;
  const hostOnly = rows.length > 0 && rows.every(isHostRow);
  const narrowed = narrowedFilters();
  // The whole host set is thousands of ids. Isolating them times out while a schedule load is in
  // flight, so the view never changes. Hiding the link instances is the visible result.
  if (mode === "isolate" && hostOnly && checkedCount === 0 && !narrowed) {
    setBusy(true, "Hiding linked models…");
    try {
      const hidden = await hideLinkedModels();
      const zoomIds = rows.map((row) => Number(row.elementId)).filter(Number.isFinite).slice(0, 200);
      if (zoomIds.length) {
        try {
          await callHostTool("zoom_to_elements", zoomIds);
        } catch {
          // The links are already hidden if zoom cannot frame the host.
        }
      }
      status.textContent = hidden
        ? `Hid ${hidden} linked models. The host stays visible.`
        : "No linked models to hide";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setBusy(false);
    }
    return;
  }

  const hostIds = hostElementIds(rows);
  const skippedLinks = rows.filter((row) => !isHostRow(row)).length;
  // Category chip alone (Walls, Doors, …) with no row checks. Collecting those ids in
  // Revit avoids the 8192-byte socket read, which rejects a full wall list as invalid JSON.
  const categoryOst =
    checkedCount === 0 &&
    filters.category &&
    !filters.level &&
    !filters.family &&
    !filters.type &&
    !filters.search.trim()
      ? ostForCategory(filters.category)
      : undefined;
  if (categoryOst && hostIds.length > 0) {
    await showCategoryInRevit(mode, categoryOst, filters.category, skippedLinks);
    return;
  }
  // A category/type/level/family/search, or checked rows, means those host elements.
  // Linked rows in that set must not become an isolate of the whole link — that looks
  // like Walls did nothing, because the link brings the rest of the model back.
  if ((narrowed || checkedCount > 0) && hostIds.length > SOCKET_ID_LIMIT) {
    status.textContent = `That is ${hostIds.length} elements, which does not fit in one request. Narrow the filter or check fewer rows.`;
    return;
  }
  if ((narrowed || checkedCount > 0) && hostIds.length > 0) {
    await frameElements(mode, hostIds, hostActionLabel(mode, hostIds.length, skippedLinks));
    return;
  }
  if (narrowed && hostIds.length === 0) {
    status.textContent = skippedLinks
      ? "These rows are inside a linked model. Clear the category and Isolate the link — Revit cannot show or isolate elements inside a link one by one."
      : "Nothing in view to show";
    return;
  }

  const { ids, linkNames, hostCount } = hostTargets(rows);
  if (ids.length === 0) {
    status.textContent = "Nothing in view to show";
    return;
  }
  const busyLabel =
    linkNames.length > 0 && hostCount === 0
      ? `${mode === "isolate" ? "Isolating" : "Selecting"} linked model…`
      : `${mode === "isolate" ? "Isolating" : "Selecting"} ${plural(ids.length, "element")}…`;
  setBusy(true, busyLabel);
  try {
    if (mode === "isolate") {
      await unhideLinkedModels(linkInstanceIds(rows));
      await callHostTool("operate_element", ids, "Isolate");
    }
    await callHostTool("select_elements", ids);
    await callHostTool("zoom_to_elements", ids);
    status.textContent = showStatus(mode, hostCount, linkNames);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
}

btnShow.addEventListener("click", () => void showInRevit("select"));
btnIsolate.addEventListener("click", () => void showInRevit("isolate"));

let sectionBoxActive = false;

btnSection.addEventListener("click", async () => {
  if (sectionBoxActive) {
    setBusy(true, "Resetting section box…");
    try {
      await callSendCode(RESET_SECTION_CODE, []);
      sectionBoxActive = false;
      status.textContent = "Section box off. View zoomed to fit.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setBusy(false);
    }
    return;
  }
  const rows = viewRows.filter((row) => checked.has(Number(row.elementId)));
  const ids = hostElementIds(rows);
  const skipped = rows.length - ids.length;
  if (ids.length === 0) {
    status.textContent = skipped
      ? "Section box needs host elements. Revit cannot box elements inside a link one by one."
      : "Check a row first";
    return;
  }
  if (ids.length > SOCKET_ID_LIMIT) {
    status.textContent = `Section box fits ${SOCKET_ID_LIMIT} elements at a time. Check fewer rows.`;
    return;
  }
  setBusy(true, "Creating section box…");
  try {
    await callHostTool("operate_element", ids, "SelectionBox");
    sectionBoxActive = true;
    status.textContent = skipped
      ? `Section box around ${plural(ids.length, "element")}. ${plural(skipped, "linked row")} skipped.`
      : `Section box around ${plural(ids.length, "element")}`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
});

btnResetView.addEventListener("click", async () => {
  const ids = filteredIds().length
    ? filteredIds()
    : allRows.map((r) => Number(r.elementId)).filter(Number.isFinite);
  if (ids.length === 0) {
    status.textContent = "No elements to reset";
    return;
  }
  setBusy(true, "Resetting isolate…");
  try {
    await app.callServerTool({
      name: "operate_element",
      arguments: { data: { elementIds: ids.slice(0, 1), action: "ResetIsolate" } },
    });
    status.textContent = "Isolate reset";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
});

btnDiscard.addEventListener("click", () => {
  const n = pendingCount();
  pendingTypes.clear();
  pendingParams.clear();
  render();
  status.textContent = `Discarded ${plural(n, "change")}`;
});

/** Apply queued type changes, grouped by type id. Applied entries leave the queue as they succeed. */
async function applyTypeChanges(): Promise<{ count: number; fail?: string }> {
  const byType = new Map<number, number[]>();
  for (const [elementId, pending] of pendingTypes) {
    const list = byType.get(pending.typeId) ?? [];
    list.push(elementId);
    byType.set(pending.typeId, list);
  }
  let count = 0;
  for (const [typeId, elementIds] of byType) {
    const result = (await app.callServerTool({
      name: "operate_element",
      arguments: { data: { elementIds, action: "ChangeType", typeId } },
    })) as ToolResult;
    const { ok, detail } = operateSucceeded(textFromResult(result) ?? "");
    if (!ok) return { count, fail: detail };
    for (const id of elementIds) pendingTypes.delete(id);
    count += elementIds.length;
  }
  return { count };
}

/** Apply queued parameter edits, grouped by name + value. Applied entries leave the queue as they succeed. */
async function applyParamChanges(): Promise<{ count: number; fail?: string }> {
  const groups = new Map<string, { name: string; value: string; keys: string[]; elementIds: number[] }>();
  for (const [key, pending] of pendingParams) {
    const groupKey = `${pending.name}\0${pending.value}`;
    const group = groups.get(groupKey) ?? { name: pending.name, value: pending.value, keys: [], elementIds: [] };
    group.keys.push(key);
    group.elementIds.push(pending.elementId);
    groups.set(groupKey, group);
  }
  let count = 0;
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
    const { ok, detail } = operateSucceeded(textFromResult(result) ?? "");
    if (!ok) return { count, fail: detail };
    for (const key of group.keys) pendingParams.delete(key);
    count += group.elementIds.length;
  }
  return { count };
}

async function reloadSchedule(message: string, doneMessage?: string) {
  setBusy(true, message);
  try {
    const result = (await app.callServerTool({
      name: "mcp_apps_get_schedule_data",
      arguments: scheduleArgs(),
    })) as ToolResult;
    lastArgs = scheduleArgs();
    parseSchedule(dataFromResult(result), textFromResult(result));
    if (doneMessage) status.textContent = doneMessage;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
}

btnApply.addEventListener("click", async () => {
  const total = pendingCount();
  if (total === 0) return;
  setBusy(true, `Applying ${plural(total, "change")}…`);
  let types = { count: 0 } as { count: number; fail?: string };
  let params = { count: 0 } as { count: number; fail?: string };
  try {
    types = await applyTypeChanges();
    if (!types.fail) params = await applyParamChanges();
  } catch (error) {
    types.fail = error instanceof Error ? error.message : String(error);
  }
  const fail = types.fail ?? params.fail;
  if (fail) {
    // Keep what failed in the queue so the user can fix it and retry.
    setBusy(false);
    render();
    status.textContent = `Applied ${types.count + params.count}, then Revit refused one: ${fail}`;
    return;
  }
  const applied = plural(types.count + params.count, "change");
  await reloadSchedule(`Applied ${applied}. Refreshing…`, `Applied ${applied} to Revit`);
});

btnRefresh.addEventListener("click", () => {
  if (busy) return;
  void reloadSchedule("Reloading from Revit…");
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (fillDrag) {
    cancelFill();
    return;
  }
  closeTypeMenu();
  for (const pop of popovers) {
    pop.wrap.classList.remove("open");
    pop.trigger.setAttribute("aria-expanded", "false");
  }
});

// ---------------------------------------------------------------------------
// Loading data
// ---------------------------------------------------------------------------

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
  lastTotalMatched = data.totalMatched ?? allRows.length;
  // Keep selection for elements that are still loaded; edits are reset by a reload.
  const loadedIds = new Set(allRows.map((row) => Number(row.elementId)));
  for (const id of Array.from(checked)) if (!loadedIds.has(id)) checked.delete(id);
  pendingTypes.clear();
  pendingParams.clear();
  selectedCell = null;
  refreshFilterOptions();
  refreshParamPicker();
  updateStats();
  render();
  if (data.message) status.textContent = data.message;
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
    void reloadSchedule("Loading editable parameters…");
  }
};

// ---------------------------------------------------------------------------
// Model context: share table state (filters, checks, pending edits) with the host model
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_LIST_LIMIT = 100;
let modelContextTimer: ReturnType<typeof setTimeout> | undefined;
let lastModelContext = "";

/** Debounced: share the table state with the host model (filters, checks, pending edits). */
function scheduleModelContext() {
  if (modelContextTimer) clearTimeout(modelContextTimer);
  modelContextTimer = setTimeout(() => void publishModelContext(), 400);
}

function cappedList<T>(items: T[], format: (item: T) => string): string[] {
  const lines = items.slice(0, MODEL_CONTEXT_LIST_LIMIT).map((item) => `- ${format(item)}`);
  if (items.length > MODEL_CONTEXT_LIST_LIMIT) {
    lines.push(`- …and ${items.length - MODEL_CONTEXT_LIST_LIMIT} more`);
  }
  return lines;
}

function buildModelContext(): string {
  const activeFilters = Object.entries(filters).filter(([, value]) => value.trim());
  const paramCols = availableParamColumns.filter((c) => selectedParamColumns.has(c));
  const checkedIds = Array.from(checked);
  const lines = [
    "---",
    `loaded-rows: ${allRows.length}`,
    `shown-rows: ${viewRows.length}`,
    `checked-rows: ${checkedIds.length}`,
    `pending-type-changes: ${pendingTypes.size}`,
    `pending-parameter-edits: ${pendingParams.size}`,
    `active-tab: ${activeTab}`,
    "---",
    "",
    "The user is working in the Revit Schedule app (mcp_apps_get_schedule_data).",
    "Pending edits are NOT yet applied to the Revit model until the user clicks Apply.",
    "",
    `Filters: ${
      activeFilters.length ? activeFilters.map(([key, value]) => `${key}="${value}"`).join(", ") : "none"
    }`,
    `Visible parameter columns: ${paramCols.length ? paramCols.join(", ") : "none"}`,
    `Status: ${status.textContent ?? ""}`,
  ];
  const checkLines = checks?.contextLines() ?? [];
  if (checkLines.length) lines.push("", ...checkLines);
  if (checkedIds.length) {
    lines.push("", "Checked element IDs:", ...cappedList(checkedIds, (id) => String(id)));
  }
  if (pendingTypes.size) {
    lines.push(
      "",
      "Pending type changes:",
      ...cappedList(Array.from(pendingTypes), ([id, p]) => `${id} → ${p.family} : ${p.type} (typeId ${p.typeId})`)
    );
  }
  if (pendingParams.size) {
    lines.push(
      "",
      "Pending parameter edits:",
      ...cappedList(Array.from(pendingParams.values()), (p) => `${p.elementId}: ${p.name} = "${p.value}"`)
    );
  }
  return lines.join("\n");
}

async function publishModelContext() {
  if (!app.getHostCapabilities()?.updateModelContext) return;
  const text = buildModelContext();
  if (text === lastModelContext) return;
  lastModelContext = text;
  try {
    await app.updateModelContext({ content: [{ type: "text", text }] });
  } catch {
    lastModelContext = "";
  }
}

// ---------------------------------------------------------------------------
// Host connection
// ---------------------------------------------------------------------------

function applyHostContext() {
  const ctx = app.getHostContext?.();
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx?.theme === "light" || ctx?.theme === "dark") hostTheme = ctx.theme;
  applyTheme();
}

app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme === "light" || ctx?.theme === "dark") hostTheme = ctx.theme;
  applyHostContext();
};

render();
app.connect().then(() => applyHostContext());

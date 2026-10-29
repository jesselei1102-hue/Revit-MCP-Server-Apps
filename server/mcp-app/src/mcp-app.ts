import { App, applyDocumentTheme, applyHostFonts } from "@modelcontextprotocol/ext-apps";
import { createChecksView } from "./checks-view";
import { failingCount, plural } from "./format";

type TextContent = { type: string; text?: string };
type ToolResult = {
  content?: TextContent[];
  structuredContent?: ScheduleData | FamilyTypeInfo[];
  isError?: boolean;
};

type ScheduleData = {
  /** "summary" when the agent opened the app: counts only, the rows are loaded with detail "full". */
  detail?: "summary";
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
type TabName = "elements" | "checks";

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
const ICON_PENCIL =
  '<svg class="i edit-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>';
const ICON_CHEVRON_UP =
  '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
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
/** 03 Checks (checks-view.ts); assigned once the panel exists. */
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
/** The notice line above the dock: write it with say() / sayError(). */
const status = $("status");
/** Header line under the title: what is loaded and shown. */
const summary = $("summary");
const chips = $("chips");
const filterLink = $<HTMLSelectElement>("filter-link");
const filterLevel = $<HTMLSelectElement>("filter-level");
const filterFamily = $<HTMLSelectElement>("filter-family");
const filterType = $<HTMLSelectElement>("filter-type");
const filterSearch = $<HTMLInputElement>("filter-search");
const pickLink = $("pick-link");
const btnClearFilters = $<HTMLButtonElement>("btn-clear-filters");
const paramPicker = $("param-picker");
const paramPickerTrigger = $<HTMLButtonElement>("param-picker-trigger");
const paramPickerLabel = $("param-picker-label");
const paramPickerSearchInput = $<HTMLInputElement>("param-picker-search");
const paramPickerList = $("param-picker-list");
const tabCountElements = $("tab-count-elements");
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
const btnPending = $("btn-pending");
const pendingList = $("pending-list");
const dock = document.querySelector(".dock") as HTMLElement;
/** The unsaved list above the dock buttons (Elements only); it closes once nothing is pending. */
let pendingOpen = false;
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

type NoticeKind = "info" | "error";
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
/** A result or error is on the notice line, so the next-step hint waits. */
let noticeHeld = false;

/** Show a result or error above the dock. Results give way to the next-step hint after a while; errors stay. */
function say(message: string, kind: NoticeKind = "info") {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeHeld = Boolean(message);
  status.textContent = message;
  status.className = kind === "error" ? "notice-line error" : "notice-line";
  if (!message) showHint();
  else if (kind === "info") {
    noticeTimer = setTimeout(() => {
      noticeHeld = false;
      showHint();
    }, 8000);
  }
}

function sayError(error: unknown) {
  say(readableError(error), "error");
}

/** Error text for people: the SDK reports a malformed reply as a JSON list of schema issues. */
function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.trimStart().startsWith("[")) {
    try {
      const issues = JSON.parse(text) as { message?: string }[];
      if (Array.isArray(issues) && issues.length) {
        const detail = issues[0]?.message ? ` (${issues[0].message})` : "";
        return `Revit sent a reply the app couldn't read${detail}. Try again, or reload from Revit.`;
      }
    } catch {
      // Not JSON: show it as it is.
    }
  }
  return text;
}

/** What to do next, shown on the notice line when nothing has just happened. */
function nextStepHint(): string {
  if (activeTab !== "elements" || allRows.length === 0) return "";
  const pending = pendingCount();
  if (pending) {
    return `${plural(pending, "change")} not in Revit yet. Apply to write ${pending === 1 ? "it" : "them"} to the model, or Discard.`;
  }
  const checkedRows = checkedHostIds().length;
  if (checkedRows > 1) {
    return `Edits on a checked row apply to all ${checkedRows} checked rows. Show in Revit and Isolate also use them.`;
  }
  return "Click a type to change it, double-click a value to edit. Changes wait here until you apply them.";
}

function showHint() {
  if (noticeHeld || busy) return;
  status.textContent = nextStepHint();
  status.className = "notice-line hint";
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
    detail: "full",
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
    if (text) say(text, "error");
    return undefined;
  }
  try {
    return JSON.parse(text) as ScheduleData;
  } catch {
    say("Couldn't read the schedule data", "error");
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
  // Keep the "All levels" / "All families" … wording of the empty option from app.html.
  const all = select.options[0]?.textContent ?? "All";
  select.innerHTML =
    `<option value="">${escapeHtml(all)}</option>` +
    values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  select.value = values.includes(current) ? current : "";
  // A set filter fills its pill in, so the active filters read at a glance.
  select.parentElement?.classList.toggle("on", Boolean(select.value));
  select.title = select.value;
  return select.value;
}

function refreshFilterOptions() {
  const links = uniqueValues("link");
  filters.link = fillSelect(filterLink, links, filters.link);
  pickLink.hidden = links.length === 0;
  filters.level = fillSelect(filterLevel, uniqueValues("level"), filters.level);
  if (filters.category && !uniqueValues("category").includes(filters.category)) filters.category = "";
  filters.family = fillSelect(filterFamily, uniqueValues("family"), filters.family);
  filters.type = fillSelect(filterType, uniqueValues("type"), filters.type);
}

/** Lower-cased text of every cell, built once per loaded row, so a search keystroke is one includes() per row. */
const rowSearchText = new WeakMap<Record<string, string>, string>();

function searchTextOf(row: Record<string, string>): string {
  let text = rowSearchText.get(row);
  if (text == null) {
    text = Object.values(row).join("\n").toLowerCase();
    rowSearchText.set(row, text);
  }
  return text;
}

function rowMatches(row: Record<string, string>, search: string): boolean {
  if (filters.link && (row.link ?? "") !== filters.link) return false;
  if (filters.level && (row.level ?? "") !== filters.level) return false;
  if (filters.category && (row.category ?? "") !== filters.category) return false;
  if (filters.family && (row.family ?? "") !== filters.family) return false;
  if (filters.type && (row.type ?? "") !== filters.type) return false;
  return !search || searchTextOf(row).includes(search);
}

function filteredRows(): Record<string, string>[] {
  const search = filters.search.trim().toLowerCase();
  return allRows.filter((row) => rowMatches(row, search));
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
  if (chip.dataset.category == null) return;
  const name = chip.dataset.category;
  filters.category = filters.category === name ? "" : name;
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
// Popovers (columns)
// ---------------------------------------------------------------------------

const popovers: { wrap: HTMLElement; trigger: HTMLButtonElement; onOpen?: () => void }[] = [
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
// Search does not narrow the filter dropdowns, so a keystroke only re-filters the rows.
filterSearch.addEventListener("input", () => {
  filters.search = filterSearch.value;
  render();
});

btnClearFilters.addEventListener("click", () => {
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
    sayError(error);
    typesByCategory.set(key, []);
    return [];
  } finally {
    typesLoading.delete(key);
  }
}

function closeTypeMenu() {
  // The menu had the keyboard (opened with Enter): give it back to the grid.
  if (typeMenu.contains(document.activeElement)) table.querySelector("table")?.focus({ preventScroll: true });
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

async function openTypeMenu(anchor: HTMLButtonElement, row: Record<string, string>, rowIndex: number, fromKeyboard = false) {
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

  // One rule for every edit: on a checked row it changes all checked rows (of this category here);
  // on an unchecked row only that row, unless ctrl+click adds the checked ones.
  const bulkIds = checkedHostIds(category);
  const scopeIds = bulkIds.length > 1 && bulkIds.includes(elementId) ? bulkIds : null;
  const what = escapeHtml(category.toLowerCase() || "elements");
  if (scopeIds) {
    typeMenu.insertAdjacentHTML("beforeend", `<div class="menu-hint">Changes <b>all ${scopeIds.length} checked</b> ${what}</div>`);
  } else if (bulkIds.length > 0 && !bulkIds.includes(elementId)) {
    typeMenu.insertAdjacentHTML(
      "beforeend",
      `<div class="menu-hint">Changes this row only · ctrl+click to include the ${bulkIds.length} checked</div>`
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
      const targets = scopeIds
        ? new Set(scopeIds)
        : event.ctrlKey || event.metaKey
          ? new Set([elementId, ...bulkIds])
          : new Set([elementId]);
      for (const id of targets) pendingTypes.set(id, pending);
      selectedCell = { rowIndex, column: "family" };
      closeTypeMenu();
      render();
      say(
        targets.size > 1
          ? `${typeName} queued for ${targets.size} elements. Apply to Revit when ready.`
          : `${typeName} queued. Drag the dot down to fill, then Apply to Revit.`
      );
    });
    typeMenu.appendChild(choice);
  }
  placeTypeMenu(anchor);
  if (fromKeyboard) (typeMenu.querySelector<HTMLButtonElement>("button.on") ?? typeMenu.querySelector("button"))?.focus();
}

// Up and Down move through the type choices; Enter picks one, Esc closes the menu.
typeMenu.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const choices = Array.from(typeMenu.querySelectorAll<HTMLButtonElement>("button"));
  const at = choices.indexOf(document.activeElement as HTMLButtonElement);
  const next = choices[Math.max(0, Math.min(choices.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
  next?.focus();
});

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
    const row = viewRows[i];
    if (!row) continue;
    // Every row in the range counts; only the rendered window has cells to paint.
    const td =
      i >= windowStart && i < windowEnd ? (table.querySelector(cellSelector(i, drag.column)) as HTMLElement | null) : null;
    if (i === drag.startIndex) {
      td?.classList.add("fill-source");
      continue;
    }
    const reason = fillSkipReason(row, drag);
    if (reason) skip++;
    else fill++;
    if (!td) continue;
    if (reason) {
      td.classList.add("fill-skip");
      td.dataset.fillSkip = reason;
    } else {
      td.classList.add("fill-range");
      td.dataset.fillValue = next || "(empty)";
      const old = currentFillValue(row, drag);
      if (old && old !== next) td.dataset.fillOld = old;
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
  if (table.scrollTop !== before) {
    // The scroll event lands a frame later; render the rows under the pointer before hit-testing them.
    syncRowWindow();
    updateFillTarget();
  }
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
  say("Fill cancelled");
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
  say(`Filled ${plural(applied, "row")} with ${what}` + (skipped ? ` · skipped ${skipped}` : "") + ". Apply when ready.");
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
  table.querySelectorAll("td.cell-selected").forEach((td) => {
    td.classList.remove("cell-selected");
    td.removeAttribute("id");
    td.removeAttribute("aria-selected");
  });
  const grid = table.querySelector("table");
  grid?.removeAttribute("aria-activedescendant");
  if (!selectedCell || fillDrag) return;
  const td = table.querySelector(cellSelector(selectedCell.rowIndex, selectedCell.column));
  if (!td) return;
  // Screen readers follow the grid's active descendant, since focus stays on the <table>.
  td.classList.add("cell-selected");
  td.id = "grid-cell";
  td.setAttribute("aria-selected", "true");
  grid?.setAttribute("aria-activedescendant", "grid-cell");
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

// The table renders only the rows near the scroll position, padded by spacer rows to the full height.
// A whole model is thousands of rows; writing them all made each keystroke or click take most of a second.
const WINDOW_CHUNK = 40;
/** Matches `tbody tr[data-row-index]` in app.html; remeasured on render in case host fonts make rows taller. */
let rowHeight = 40;
let tableColumns: string[] = [];
let windowStart = 0;
let windowEnd = 0;
/** Set while a parameter cell is being edited; a window re-render commits it first rather than dropping it. */
let commitCellEdit: (() => void) | null = null;

/** Rows to render for the current scroll position, snapped to chunks so small scrolls reuse the same rows. */
function rowWindow(): [number, number] {
  const first = Math.floor(table.scrollTop / rowHeight);
  const start = Math.max(0, (Math.floor(first / WINDOW_CHUNK) - 1) * WINDOW_CHUNK);
  const end = Math.min(viewRows.length, start + Math.ceil((table.clientHeight || 460) / rowHeight) + WINDOW_CHUNK * 3);
  return [start, end];
}

function spacerRow(rows: number) {
  return rows > 0
    ? `<tr class="spacer" aria-hidden="true"><td colspan="${tableColumns.length + 1}" style="height:${rows * rowHeight}px"></td></tr>`
    : "";
}

function bodyHtml(start: number, end: number) {
  windowStart = start;
  windowEnd = end;
  let html = spacerRow(start);
  for (let rowIndex = start; rowIndex < end; rowIndex++) html += rowHtml(viewRows[rowIndex], rowIndex);
  return html + spacerRow(viewRows.length - end);
}

/** The focused checkbox or type button in a row, so a window re-render can put focus back. */
function focusedRowControl(): { rowIndex: number; column: string } | null {
  const el = document.activeElement as HTMLElement | null;
  const tr = el?.closest("tr[data-row-index]") as HTMLElement | null;
  if (!el || !tr || !table.contains(tr)) return null;
  return { rowIndex: Number(tr.dataset.rowIndex), column: (el.closest("td") as HTMLElement | null)?.dataset.column ?? "" };
}

function restoreRowFocus(focus: { rowIndex: number; column: string } | null) {
  if (!focus) return;
  const tr = table.querySelector(`tr[data-row-index="${focus.rowIndex}"]`);
  const target = focus.column
    ? tr?.querySelector(`td[data-column="${CSS.escape(focus.column)}"] button`)
    : tr?.querySelector("input[data-id]");
  (target as HTMLElement | null)?.focus({ preventScroll: true });
}

/** Re-render the row window when scrolling has moved past it. */
function syncRowWindow(force = false) {
  const tbody = table.querySelector("tbody");
  if (!tbody) return;
  const [start, end] = rowWindow();
  if (!force && start === windowStart && end === windowEnd) return;
  if (commitCellEdit) {
    commitCellEdit(); // keeps the edit, and renders the table again at the new position
    return;
  }
  const focus = focusedRowControl();
  tbody.innerHTML = bodyHtml(start, end);
  restoreRowFocus(focus);
  paintSelection();
  if (fillDrag) updateFillBadge(paintFillRange(fillDrag));
}

function render() {
  closeTypeMenu();
  // A re-render replaces the grid; keep the keyboard in it if it was there (an edit just committed, say).
  const keepFocus = table.contains(document.activeElement);
  const rows = filteredRows();
  viewRows = rows;
  renderChips();
  btnClearFilters.hidden = !Object.values(filters).some((value) => value.trim());

  if (allRows.length === 0) {
    table.innerHTML = `<div class="empty"><b>No elements loaded</b><span>Ask the agent to load a schedule, or reload from Revit.</span></div>`;
    syncDock();
    return;
  }
  if (rows.length === 0) {
    table.innerHTML = `<div class="empty"><b>No matches</b><span>Try another search, or clear the filters.</span></div>`;
    summary.textContent = `0 shown / ${allRows.length} loaded`;
    syncDock();
    return;
  }

  tableColumns = columnsForTable(rows);
  const allFilteredChecked = rows.every((row) => checked.has(Number(row.elementId)));
  // Capitalised like the Revit parameter names beside them.
  const labels: Record<string, string> = { family: "Type", level: "Level", category: "Category", link: "Link" };

  let html = `<table role="grid" tabindex="0" aria-rowcount="${rows.length + 1}" aria-label="Elements. Arrow keys move, Enter edits, Space checks a row."><thead><tr>`;
  html += `<th class="check-col"><input type="checkbox" id="check-all" aria-label="Select all in view" title="Select all. Shift-click rows to select a range."${
    allFilteredChecked ? " checked" : ""
  } /></th>`;
  // A pencil marks the columns you can change; linked rows stay read-only.
  const editable = rows.some(isHostRow);
  for (const column of tableColumns) {
    const mark = editable && (column === "family" || isParamColumn(column));
    html += `<th${mark ? ' title="Editable: click a type, or double-click a value"' : ""}>${escapeHtml(labels[column] ?? column)}${
      mark ? ICON_PENCIL : ""
    }</th>`;
  }
  const [start, end] = rowWindow();
  html += `</tr></thead><tbody>${bodyHtml(start, end)}</tbody></table>`;
  table.innerHTML = html;
  if (keepFocus) table.querySelector("table")?.focus({ preventScroll: true });

  // Fewer rows can clamp the scroll position, and host fonts can change the row height:
  // either moves the window, so settle it before painting.
  const measured = table.querySelector("tbody tr[data-row-index]")?.getBoundingClientRect().height;
  const heightChanged = measured != null && measured > 0 && Math.abs(measured - rowHeight) > 0.5;
  if (heightChanged) rowHeight = measured;
  syncRowWindow(heightChanged);

  paintSelection();
  summary.textContent =
    `${rows.length} shown / ${allRows.length} loaded` +
    (lastTotalMatched > allRows.length ? ` · ${lastTotalMatched} matched` : "");
  syncDock();
}

function rowHtml(row: Record<string, string>, rowIndex: number) {
  const id = Number(row.elementId);
  const host = isHostRow(row);
  const rowClass = [checked.has(id) ? "sel" : "", pendingTypes.has(id) ? "dirty" : ""].filter(Boolean).join(" ");
  // Inner controls are tabindex -1: the grid is one Tab stop, and the arrow keys reach every cell.
  let html = `<tr data-row-index="${rowIndex}" aria-rowindex="${rowIndex + 2}"${rowClass ? ` class="${rowClass}"` : ""}>`;
  html += `<td class="check-col" data-column="check" data-row-index="${rowIndex}"><input type="checkbox" tabindex="-1" data-id="${escapeHtml(row.elementId)}" aria-label="Check row" title="Shift-click to check a range"${
    checked.has(id) ? " checked" : ""
  } /></td>`;
  for (const column of tableColumns) {
    const at = `data-column="${escapeHtml(column)}" data-row-index="${rowIndex}"`;
    if (column === "family") {
      const pending = pendingTypes.get(id);
      const label = pending?.type || (row.type ?? "").trim() || (row.family ?? "");
      const title = escapeHtml((row.family ?? "") + (row.type ? " · " + row.type : ""));
      if (host) {
        html += `<td class="family-cell" ${at}><button type="button" class="type-face" tabindex="-1" title="${title}"><span class="label${
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
  return html + "</tr>";
}

function paintRowChecks(from: number, to: number) {
  // Rows outside the rendered window pick up their checks when they scroll in.
  const lo = Math.max(Math.min(from, to), windowStart);
  const hi = Math.min(Math.max(from, to), windowEnd - 1);
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
    const again = selectedCell?.rowIndex === cell.rowIndex && selectedCell.column === cell.column;
    selectedCell = { rowIndex: cell.rowIndex, column: cell.column };
    paintSelection();
    // A second click on the selected value edits it, as in a spreadsheet.
    if (again) beginCellEdit(cell.td, Number(cell.row.elementId), cell.column, cell.rowIndex);
  }
});

table.addEventListener("dblclick", (event) => {
  const cell = cellFromEvent(event);
  if (!cell || !cell.td.classList.contains("editable")) return;
  event.preventDefault();
  beginCellEdit(cell.td, Number(cell.row.elementId), cell.column, cell.rowIndex);
});

/** Editable columns, left to right: the type, then the parameter columns. */
function editableColumns(): string[] {
  return tableColumns.filter((column) => column === "family" || isParamColumn(column));
}

/** Columns the arrow keys move between: the row checkbox, then the editable columns. */
function gridColumns(): string[] {
  return ["check", ...editableColumns()];
}

/** The <table> is the grid's single Tab stop; the selected cell is its aria-activedescendant. */
function gridEl(): HTMLElement | null {
  return table.querySelector("table");
}

/** Scroll the table just enough to show a row below the sticky header, and render it. */
function scrollRowIntoView(rowIndex: number) {
  const head = table.querySelector("thead")?.getBoundingClientRect().height ?? 34;
  const top = rowIndex * rowHeight;
  if (top < table.scrollTop) table.scrollTop = top;
  else if (top + rowHeight + head > table.scrollTop + table.clientHeight) {
    table.scrollTop = top + rowHeight + head - table.clientHeight;
  }
  syncRowWindow();
}

/** Move the selected cell; `wrap` runs on to the next or previous row at the ends, as Tab does. */
function moveSelection(rowStep: number, colStep: number, cols = gridColumns(), wrap = false) {
  if (!selectedCell || !cols.length || viewRows.length === 0) return;
  let rowIndex = selectedCell.rowIndex + rowStep;
  let col = Math.max(0, cols.indexOf(selectedCell.column)) + colStep;
  if (wrap && col >= cols.length) {
    col = 0;
    rowIndex++;
  } else if (wrap && col < 0) {
    col = cols.length - 1;
    rowIndex--;
  }
  rowIndex = Math.max(0, Math.min(viewRows.length - 1, rowIndex));
  col = Math.max(0, Math.min(cols.length - 1, col));
  selectedCell = { rowIndex, column: cols[col] };
  closeTypeMenu();
  scrollRowIntoView(rowIndex);
  paintSelection();
}

// Tabbing into the grid picks a cell to start from: the first editable one in the top visible row.
table.addEventListener("focusin", (event) => {
  if (event.target !== gridEl() || viewRows.length === 0) return;
  if (!selectedCell || selectedCell.rowIndex >= viewRows.length) {
    const cols = gridColumns();
    const top = Math.min(viewRows.length - 1, Math.floor(table.scrollTop / rowHeight));
    selectedCell = { rowIndex: top, column: cols[1] ?? cols[0] };
  }
  paintSelection();
});

// Clicking a row checkbox or type button hands the keyboard back to the grid.
table.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const cell = cellFromEvent(event);
  if (!cell || !target.closest("input[data-id], button.type-face")) return;
  if (target.closest("input[data-id]")) selectedCell = { rowIndex: cell.rowIndex, column: "check" };
  gridEl()?.focus({ preventScroll: true });
  paintSelection();
});

// Keys on the focused grid: arrows move, Enter / F2 edits or opens the type menu, Space checks the row.
// Tab leaves the grid, as in any grid; inside a cell edit it moves to the next cell instead.
table.addEventListener("keydown", (event) => {
  const grid = gridEl();
  if (!grid || event.target !== grid || !selectedCell || fillDrag || event.altKey || event.ctrlKey || event.metaKey) return;
  const { rowIndex, column } = selectedCell;
  const moves: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };
  if (moves[event.key]) {
    event.preventDefault();
    moveSelection(...moves[event.key]);
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const cols = gridColumns();
    selectedCell = { rowIndex, column: event.key === "Home" ? cols[0] : cols[cols.length - 1] };
    paintSelection();
    return;
  }
  if (event.key !== "Enter" && event.key !== "F2" && event.key !== " ") return;
  event.preventDefault();
  scrollRowIntoView(rowIndex);
  const td = table.querySelector(cellSelector(rowIndex, column)) as HTMLElement | null;
  const row = viewRows[rowIndex];
  if (!td || !row) return;
  if (column === "check") {
    td.querySelector<HTMLInputElement>("input[data-id]")?.click();
    gridEl()?.focus({ preventScroll: true });
  } else if (event.key === " ") {
    return;
  } else if (td.classList.contains("editable")) {
    beginCellEdit(td, Number(row.elementId), column, rowIndex);
  } else {
    const face = td.querySelector<HTMLButtonElement>("button.type-face");
    if (face) void openTypeMenu(face, row, rowIndex, true);
  }
});

table.addEventListener(
  "scroll",
  () => {
    closeTypeMenu();
    syncRowWindow();
  },
  { passive: true }
);

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
  // Same rule as the type menu: editing a checked row edits every checked row, and the badge says so.
  const checkedIds = checkedHostIds();
  const scoped = checkedIds.length > 1 && checkedIds.includes(elementId);
  if (scoped) td.insertAdjacentHTML("beforeend", `<span class="edit-scope">all ${checkedIds.length} checked</span>`);
  input.focus();
  input.select();
  let bulk = false;
  let done = false;

  const commit = () => {
    if (done) return;
    done = true;
    commitCellEdit = null;
    const next = input.value;
    // ctrl+Enter copies the value to the checked rows even when it did not change.
    if (bulk || (scoped && next !== current)) {
      const targets = new Set([elementId, ...checkedIds]);
      for (const id of targets) pendingParams.set(paramKey(id, column), { elementId: id, name: column, value: next });
      render();
      say(`${column} = "${next}" queued for ${plural(targets.size, "checked row")}. Apply to Revit when ready.`);
      return;
    }
    if (next !== current) pendingParams.set(paramKey(elementId, column), { elementId, name: column, value: next });
    render();
    if (next !== current) say(`${column} = "${next}" queued. Drag the dot down to fill, then Apply to Revit.`);
  };
  commitCellEdit = commit;
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      bulk = event.ctrlKey || event.metaKey;
      commit();
    } else if (event.key === "Tab") {
      // As in a spreadsheet: keep the value and step to the next (or previous) editable cell.
      event.preventDefault();
      commit();
      moveSelection(0, event.shiftKey ? -1 : 1, editableColumns(), true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      done = true;
      commitCellEdit = null;
      render();
    }
  });
}

// ---------------------------------------------------------------------------
// Stats, tabs, changes panel, dock
// ---------------------------------------------------------------------------

let lastTotalMatched = 0;

function syncDock() {
  const pending = pendingCount();
  tabCountElements.textContent = allRows.length ? String(viewRows.length) : "";

  const ids = targetIds();
  const selectedInView = viewRows.filter((row) => checked.has(Number(row.elementId))).length;
  const scope = filters.category || filters.type || filters.family || "";
  // Names the set the Revit buttons act on: the checked rows, or else everything in view.
  selCount.textContent = selectedInView
    ? `${selectedInView} checked`
    : scope
      ? `All ${viewRows.length} ${scope}`
      : `All ${viewRows.length} in view`;
  btnShow.disabled = busy || (ids.length === 0 && viewRows.length === 0);
  btnIsolate.disabled = busy || (ids.length === 0 && viewRows.length === 0);
  btnSection.hidden = !sectionBoxActive && selectedInView === 0;
  btnSection.disabled = busy;
  btnSection.textContent = sectionBoxActive ? "Reset section box" : "Section box";
  btnSection.title = sectionBoxActive
    ? "Turn the section box off and zoom the view to fit"
    : "Section box around the checked elements";
  btnResetView.disabled = busy || allRows.length === 0;

  // Elements dock: Revit view actions + Apply. Checks dock: Run checks (one primary button per view).
  const checksTab = activeTab === "checks";
  dockSelect.hidden = checksTab;
  dockPending.hidden = checksTab || pending === 0;
  dockChecks.hidden = !checksTab;
  tabCountChecks.textContent = failingCount(checks?.summary() ?? null);
  checksDockLabel.textContent = checks?.dockLabel() ?? "";
  btnRunChecks.disabled = Boolean(checks?.isRunning());
  if (pending === 0) pendingOpen = false;
  const listShown = pendingOpen && activeTab === "elements";
  pendingList.hidden = !listShown;
  dock.classList.toggle("open", listShown);
  btnPending.innerHTML = `${plural(pending, "change")} to apply ${ICON_CHEVRON_UP}`;
  btnPending.setAttribute("aria-expanded", listShown ? "true" : "false");
  btnPending.title = pendingOpen ? "Hide the list of changes" : "Review the changes before applying them";
  btnApply.textContent = pending === 1 ? "Apply to Revit" : `Apply ${pending} to Revit`;
  btnApply.disabled = busy;
  btnDiscard.disabled = busy;
  btnRefresh.classList.toggle("spin", busy);

  if (listShown) renderChanges();
  showHint();
  scheduleModelContext();
}

/** The "…ing" message of the work in progress, cleared when it ends unless a result has replaced it. */
let busyNotice = "";

function setBusy(next: boolean, message?: string) {
  busy = next;
  if (next && message) {
    say(message);
    busyNotice = message;
  } else if (!next) {
    if (busyNotice && status.textContent === busyNotice) noticeHeld = false;
    busyNotice = "";
  }
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
  $("panel-checks").hidden = tab !== "checks";
  closeTypeMenu();
  if (tab === "checks") pendingOpen = false;
  if (tab === "checks") void checks?.show();
  syncDock();
}

// ---------------------------------------------------------------------------
// 03 Checks — rendering and behaviour live in checks-view.ts (rules_* / checks_* tools).
// ---------------------------------------------------------------------------

const OST_TO_NAME = new Map(Object.entries(CATEGORY_TO_OST).map(([name, ost]) => [ost, name]));

checks = createChecksView({
  app,
  checksView,
  modelStats: () => dashboardStats ?? null,
  setStatus: say,
  escapeHtml,
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
  let html = "";
  for (const [typeId, group] of typeGroups) {
    html += `<div class="change"><span class="kind">type</span><span class="what" title="${escapeHtml(
      group.pending.family
    )}">${escapeHtml(group.pending.family)} : <span class="hl">${escapeHtml(group.pending.type)}</span></span><span class="scope" title="${group.ids.join(
      ", "
    )}">${plural(group.ids.length, "element")}</span><button type="button" class="remove" data-remove-type="${typeId}" aria-label="Remove this change"${busy ? " disabled" : ""}>${ICON_X}</button></div>`;
  }
  for (const [key, group] of paramGroups) {
    html += `<div class="change"><span class="kind">param</span><span class="what">${escapeHtml(
      group.name
    )} → <span class="hl">${escapeHtml(group.value) || "(empty)"}</span></span><span class="scope" title="${group.ids.join(
      ", "
    )}">${plural(group.ids.length, "element")}</span><button type="button" class="remove" data-remove-param="${escapeHtml(
      encodeURIComponent(key)
    )}" aria-label="Remove this change"${busy ? " disabled" : ""}>${ICON_X}</button></div>`;
  }
  changesList.innerHTML = html;
}

btnPending.addEventListener("click", () => {
  pendingOpen = !pendingOpen;
  syncDock();
});

changesList.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest("button.remove") as HTMLButtonElement | null;
  if (!btn || busy) return; // an Apply in progress already took this change
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
  say("Change removed");
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
 * A few hundred ids fit in one call; larger sets go over in chunks of this size (actOnManyIds).
 */
const SOCKET_ID_LIMIT = 400;

/** Turn the section box off in the 3D view and zoom it to fit. */
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

/** Collect and show or isolate one category inside Revit, so the id list never crosses the socket. */
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

/**
 * Put one chunk of ids into the Revit selection: "replace" for the first chunk, "add" after it.
 * ElementId takes a long from Revit 2024 and an int before, and scripts compile without version
 * symbols, so the constructor is picked at run time.
 */
const SELECT_CHUNK_CODE = `
var uiDoc = new UIDocument(document);
var longCtor = typeof(ElementId).GetConstructor(new[] { typeof(long) });
var intCtor = typeof(ElementId).GetConstructor(new[] { typeof(int) });
ICollection<ElementId> ids = (string)parameters[1] == "add" ? uiDoc.Selection.GetElementIds() : new List<ElementId>();
foreach (var s in ((string)parameters[0]).Split(','))
    ids.Add(longCtor != null
        ? (ElementId)longCtor.Invoke(new object[] { long.Parse(s) })
        : (ElementId)intCtor.Invoke(new object[] { int.Parse(s) }));
uiDoc.Selection.SetElementIds(ids);
return ids.Count;
`;

/**
 * Act on the current Revit selection once SELECT_CHUNK_CODE has built it: isolate it, box it, or just
 * zoom to it. The box follows the add-in's own SelectionBox (3D view, 1 ft margin).
 */
const SELECTION_ACTION_CODE = `
var uiDoc = new UIDocument(document);
var ids = uiDoc.Selection.GetElementIds();
if (ids.Count == 0) throw new Exception("Nothing is selected in Revit");
var mode = (string)parameters[0];
if (mode == "box") {
    View3D view3d = uiDoc.ActiveView as View3D;
    if (view3d == null) {
        view3d = new FilteredElementCollector(document)
            .OfClass(typeof(View3D))
            .Cast<View3D>()
            .FirstOrDefault(v => !v.IsTemplate && !v.IsLocked && (v.Name.Contains("{3D}") || v.Name.Contains("Default 3D")));
        if (view3d == null) throw new Exception("No 3D view for a section box");
        uiDoc.ActiveView = view3d;
    }
    BoundingBoxXYZ box = null;
    foreach (var id in ids) {
        var b = document.GetElement(id)?.get_BoundingBox(null);
        if (b == null) continue;
        if (box == null) { box = new BoundingBoxXYZ { Min = b.Min, Max = b.Max }; continue; }
        box.Min = new XYZ(Math.Min(box.Min.X, b.Min.X), Math.Min(box.Min.Y, b.Min.Y), Math.Min(box.Min.Z, b.Min.Z));
        box.Max = new XYZ(Math.Max(box.Max.X, b.Max.X), Math.Max(box.Max.Y, b.Max.Y), Math.Max(box.Max.Z, b.Max.Z));
    }
    if (box == null) throw new Exception("The checked elements have no extent to box");
    var pad = new XYZ(1, 1, 1);
    box.Min = box.Min - pad;
    box.Max = box.Max + pad;
    using (var t = new Transaction(document, "Section box around checked elements")) {
        t.Start();
        view3d.IsSectionBoxActive = true;
        view3d.SetSectionBox(box);
        t.Commit();
    }
}
else if (mode == "isolate") {
    var view = uiDoc.ActiveView;
    using (var t = new Transaction(document, "Isolate checked elements")) {
        t.Start();
        if (view.IsInTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate))
            view.DisableTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate);
        view.IsolateElementsTemporary(ids);
        t.Commit();
    }
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
    say(
      skippedLinks
        ? `${base}. ${plural(skippedLinks, "linked row")} skipped — Revit cannot show elements inside a link one by one.`
        : base
    );
  } catch (error) {
    sayError(error);
  } finally {
    setBusy(false);
  }
}

/**
 * More ids than one socket read carries: build the Revit selection chunk by chunk, then isolate, box or
 * zoom it inside Revit. Throws on the first refused call.
 */
async function actOnManyIds(mode: ShowMode | "box", ids: number[], busyLabel: string) {
  for (let i = 0; i < ids.length; i += SOCKET_ID_LIMIT) {
    const sent = Math.min(i + SOCKET_ID_LIMIT, ids.length);
    setBusy(true, `${busyLabel}: ${sent} of ${ids.length} sent to Revit…`);
    await callSendCode(SELECT_CHUNK_CODE, [ids.slice(i, sent).join(","), i === 0 ? "replace" : "add"]);
  }
  await callSendCode(SELECTION_ACTION_CODE, [mode]);
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
    say(followUp && isolated ? `${done} (${followUp})` : done);
  } catch (error) {
    sayError(error);
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
      say(
        hidden
          ? `Hid ${hidden} linked models. The host stays visible.`
          : "No linked models to hide"
      );
    } catch (error) {
      sayError(error);
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
    try {
      await actOnManyIds(mode, hostIds, `${mode === "isolate" ? "Isolating" : "Selecting"} ${plural(hostIds.length, "element")}`);
      say(hostActionLabel(mode, hostIds.length, skippedLinks));
    } catch (error) {
      sayError(error);
    } finally {
      setBusy(false);
    }
    return;
  }
  if ((narrowed || checkedCount > 0) && hostIds.length > 0) {
    await frameElements(mode, hostIds, hostActionLabel(mode, hostIds.length, skippedLinks));
    return;
  }
  if (narrowed && hostIds.length === 0) {
    if (skippedLinks) {
      say(
        "These rows are inside a linked model. Clear the category and Isolate the link — Revit cannot show or isolate elements inside a link one by one.",
        "error"
      );
    } else say("Nothing in view to show");
    return;
  }

  const { ids, linkNames, hostCount } = hostTargets(rows);
  if (ids.length === 0) {
    say("Nothing in view to show");
    return;
  }
  const busyLabel =
    linkNames.length > 0 && hostCount === 0
      ? `${mode === "isolate" ? "Isolating" : "Selecting"} linked model…`
      : `${mode === "isolate" ? "Isolating" : "Selecting"} ${plural(ids.length, "element")}…`;
  setBusy(true, busyLabel);
  try {
    if (mode === "isolate") await unhideLinkedModels(linkInstanceIds(rows));
    if (ids.length > SOCKET_ID_LIMIT) {
      await actOnManyIds(mode, ids, busyLabel.replace(/…$/, ""));
    } else {
      if (mode === "isolate") await callHostTool("operate_element", ids, "Isolate");
      await callHostTool("select_elements", ids);
      await callHostTool("zoom_to_elements", ids);
    }
    say(showStatus(mode, hostCount, linkNames));
  } catch (error) {
    sayError(error);
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
      say("Section box off. View zoomed to fit.");
    } catch (error) {
      sayError(error);
    } finally {
      setBusy(false);
    }
    return;
  }
  const rows = viewRows.filter((row) => checked.has(Number(row.elementId)));
  const ids = hostElementIds(rows);
  const skipped = rows.length - ids.length;
  if (ids.length === 0) {
    say(
      skipped
        ? "Section box needs host elements. Revit cannot box elements inside a link one by one."
        : "Check a row first"
    );
    return;
  }
  setBusy(true, "Creating section box…");
  try {
    if (ids.length > SOCKET_ID_LIMIT) await actOnManyIds("box", ids, "Creating section box");
    else await callHostTool("operate_element", ids, "SelectionBox");
    sectionBoxActive = true;
    say(
      skipped
        ? `Section box around ${plural(ids.length, "element")}. ${plural(skipped, "linked row")} skipped.`
        : `Section box around ${plural(ids.length, "element")}`
    );
  } catch (error) {
    sayError(error);
  } finally {
    setBusy(false);
  }
});

btnResetView.addEventListener("click", async () => {
  const ids = filteredIds().length
    ? filteredIds()
    : allRows.map((r) => Number(r.elementId)).filter(Number.isFinite);
  if (ids.length === 0) {
    say("No elements to reset");
    return;
  }
  setBusy(true, "Resetting isolate…");
  try {
    await app.callServerTool({
      name: "operate_element",
      arguments: { data: { elementIds: ids.slice(0, 1), action: "ResetIsolate" } },
    });
    say("Isolate reset");
  } catch (error) {
    sayError(error);
  } finally {
    setBusy(false);
  }
});

btnDiscard.addEventListener("click", () => {
  const n = pendingCount();
  pendingTypes.clear();
  pendingParams.clear();
  render();
  say(`Discarded ${plural(n, "change")}`);
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
    if (doneMessage) say(doneMessage);
  } catch (error) {
    sayError(error);
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
    say(`Applied ${types.count + params.count}, then Revit refused one: ${fail}`, "error");
    return;
  }
  const applied = plural(types.count + params.count, "change");
  await reloadSchedule(`Applied ${applied}. Refreshing…`, `Applied ${applied} to Revit`);
});

btnRefresh.addEventListener("click", () => {
  if (activeTab === "checks") {
    void checks?.refresh();
    return;
  }
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
  if (pendingOpen) {
    pendingOpen = false;
    syncDock();
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
      say(fallbackText, "error");
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
  render();
  if (data.message) summary.textContent = data.message;
}

app.ontoolinput = (params) => {
  if (params?.arguments && typeof params.arguments === "object") {
    lastArgs = params.arguments as Record<string, unknown>;
  }
};

app.ontoolresult = (result) => {
  const typed = result as ToolResult;
  const structured = typed.structuredContent;
  if (structured && !Array.isArray(structured) && structured.detail === "summary") {
    void reloadSchedule("Loading elements…");
    return;
  }
  parseSchedule(dataFromResult(typed), textFromResult(typed));
  // Upgrade to editable instance params when the agent loaded computed KeyParameters / None. Left out,
  // the server already defaults to editable ones, so loading again would fetch the same rows twice.
  if ((lastArgs.parametersOutputType ?? "EditableInstanceParameters") !== "EditableInstanceParameters") {
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
    `changes-list: ${pendingOpen ? "open" : "closed"}`,
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

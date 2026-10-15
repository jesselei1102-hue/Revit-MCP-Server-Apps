import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withRevitConnection } from "./utils/ConnectionManager.js";

export const REVIT_REPORT_RESOURCE_URI = "ui://revit-report/app.html";

const BATCH_SIZE = 100;
const IDENTITY_KEYS = new Set([
  "elementId",
  "name",
  "category",
  "family",
  "type",
  "level",
  "link",
  "linkInstanceId",
]);

/** Meaningful model categories for “full” filter loads (excludes fill patterns, views, DWGs, etc.). */
const DEFAULT_MODEL_CATEGORIES = [
  "OST_Walls",
  "OST_Doors",
  "OST_Windows",
  "OST_Floors",
  "OST_Ceilings",
  "OST_Roofs",
  "OST_Stairs",
  "OST_Railings",
  "OST_Ramps",
  "OST_Columns",
  "OST_StructuralColumns",
  "OST_StructuralFraming",
  "OST_StructuralFoundation",
  "OST_Rooms",
  "OST_Furniture",
  "OST_Casework",
  "OST_SpecialtyEquipment",
  "OST_GenericModel",
  "OST_MechanicalEquipment",
  "OST_ElectricalEquipment",
  "OST_ElectricalFixtures",
  "OST_LightingFixtures",
  "OST_PlumbingFixtures",
  "OST_PipeCurves",
  "OST_PipeFitting",
  "OST_PipeAccessory",
  "OST_DuctCurves",
  "OST_DuctFitting",
  "OST_DuctAccessory",
  "OST_CableTray",
  "OST_CableTrayFitting",
  "OST_Conduit",
  "OST_ConduitFitting",
  "OST_CurtainWallPanels",
  "OST_CurtainWallMullions",
  "OST_Parking",
  "OST_Planting",
  "OST_Site",
  "OST_Topography",
  "OST_Mass",
];

type ElementRow = Record<string, string>;

type DashboardStats = {
  errorCount: number;
  detachableFamilyCount: number;
  warningCount?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type ElementRef = { elementId: number; linkInstanceId: number | null; linkName: string | null };

function collectRefs(queryResult: unknown): ElementRef[] {
  const root = asRecord(queryResult);
  const results = asRecord(root?.results) ?? root;
  const refs = results?.elementRefs;
  if (Array.isArray(refs) && refs.length > 0) {
    const out: ElementRef[] = [];
    for (const item of refs) {
      const r = asRecord(item);
      if (!r) continue;
      const elementId = Number(r.elementId);
      if (!Number.isFinite(elementId)) continue;
      const rawLink = r.linkInstanceId;
      const linkInstanceId =
        rawLink == null || rawLink === "" ? null : Number(rawLink);
      out.push({
        elementId,
        linkInstanceId: Number.isFinite(linkInstanceId as number) ? (linkInstanceId as number) : null,
        linkName: r.linkName == null ? null : String(r.linkName),
      });
    }
    return out;
  }

  const ids = results?.elementIds;
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id))
    .map((elementId) => ({ elementId, linkInstanceId: null, linkName: null }));
}

function collectIds(queryResult: unknown): number[] {
  return collectRefs(queryResult).map((r) => r.elementId);
}

function formatLevelLabel(name: string, elevationRaw: string | undefined): string {
  const trimmed = name.trim();
  const elev = elevationRaw?.trim();
  if (!trimmed) return elev ? `(${elev})` : "";
  if (!elev) return trimmed;
  // Metric projects often return bare numbers (mm). Imperial returns feet-inches strings.
  if (/^-?\d+(\.\d+)?$/.test(elev)) return `${trimmed} (${elev} mm)`;
  return `${trimmed} (${elev})`;
}

async function loadDashboardStats(): Promise<DashboardStats> {
  // Dedicated get_dashboard_stats command can replace this later.
  // Uses send_code only for Document.GetWarnings + unused Family scan (no existing tool).
  const code = `
var warnings = document.GetWarnings();
int warningCount = warnings != null ? warnings.Count : 0;
var usedFamilyIds = new HashSet<long>();
foreach (var fi in new FilteredElementCollector(document).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>())
{
    try { if (fi.Symbol?.Family != null) usedFamilyIds.Add(fi.Symbol.Family.Id.Value); } catch {}
}
int detachable = 0;
foreach (var f in new FilteredElementCollector(document).OfClass(typeof(Family)).Cast<Family>())
{
    try
    {
        if (f.IsInPlace) continue;
        if (usedFamilyIds.Contains(f.Id.Value)) continue;
        bool anyUsed = false;
        foreach (var sid in f.GetFamilySymbolIds())
        {
            if (new FilteredElementCollector(document).WherePasses(new FamilyInstanceFilter(document, sid)).GetElementCount() > 0)
            { anyUsed = true; break; }
        }
        if (!anyUsed) detachable++;
    }
    catch {}
}
return new { errorCount = warningCount, warningCount, detachableFamilyCount = detachable };
`.trim();

  try {
    const raw = await withRevitConnection((client) =>
      client.sendCommand("send_code_to_revit", {
        code,
        transactionMode: "none",
      })
    );
    const root = asRecord(raw);
    let payload: Record<string, unknown> | null = root;
    if (root?.result != null) {
      if (typeof root.result === "string") {
        try {
          payload = asRecord(JSON.parse(root.result));
        } catch {
          payload = null;
        }
      } else {
        payload = asRecord(root.result);
      }
    }
    if (!payload) return { errorCount: 0, detachableFamilyCount: 0 };
    return {
      errorCount: Number(payload.errorCount ?? payload.warningCount ?? 0) || 0,
      warningCount: Number(payload.warningCount ?? payload.errorCount ?? 0) || 0,
      detachableFamilyCount: Number(payload.detachableFamilyCount ?? 0) || 0,
    };
  } catch {
    return { errorCount: 0, detachableFamilyCount: 0 };
  }
}

async function loadLevelLabels(includeLinkedModels = false): Promise<Map<string, string>> {
  const query = await withRevitConnection((client) =>
    client.sendCommand("query_model", {
      input: {
        searchScope: "AllViews",
        elementInclusionMode: "InstancesOnly",
        categories: ["OST_Levels"],
        maxResults: 0,
        includeLinkedModels,
      },
    })
  );
  const refs = collectRefs(query);
  const labels = new Map<string, string>();
  if (refs.length === 0) return labels;

  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = refs.slice(i, i + BATCH_SIZE);
    const hasLinked = batch.some((r) => r.linkInstanceId != null);
    const payload = hasLinked
      ? {
          elementRefs: batch.map((r) => ({
            elementId: r.elementId,
            linkInstanceId: r.linkInstanceId ?? null,
          })),
        }
      : { elementIds: batch.map((r) => r.elementId) };
    const data = await withRevitConnection((client) =>
      client.sendCommand("get_element_data", {
        ...payload,
        outputOptions: {
          basicElementInfo: true,
          parametersOutputType: "SpecificParameters",
          specificParameterNames: ["Elevation", "Name"],
        },
      })
    );
    const record = asRecord(data);
    const elements = Array.isArray(record?.elements) ? record.elements : [];
    for (const item of elements) {
      const el = asRecord(item);
      if (!el || el.error) continue;
      const params = asRecord(el.parameters) ?? {};
      const name = String(params.Name ?? el.name ?? "").trim();
      const elevation = params.Elevation == null ? "" : String(params.Elevation).trim();
      if (!name) continue;
      labels.set(name, formatLevelLabel(name, elevation || undefined));
    }
  }
  return labels;
}

function flattenElements(
  elements: unknown[],
  levelLabels: Map<string, string>
): { columns: string[]; rows: ElementRow[] } {
  const columnSet = new Set<string>([
    "elementId",
    "link",
    "name",
    "category",
    "family",
    "type",
    "level",
  ]);
  const rows: ElementRow[] = [];

  for (const item of elements) {
    const el = asRecord(item);
    if (!el || el.error) continue;
    const rawLevel = String(el.level ?? "").trim();
    const linkName = el.linkName == null ? "" : String(el.linkName);
    const linkInstanceId = el.linkInstanceId == null ? "" : String(el.linkInstanceId);
    const row: ElementRow = {
      elementId: String(el.id ?? el.elementId ?? ""),
      link: linkName || "(host)",
      linkInstanceId,
      name: String(el.name ?? ""),
      category: String(el.category ?? ""),
      family: String(el.family ?? ""),
      type: String(el.type ?? ""),
      level: levelLabels.get(rawLevel) ?? (rawLevel || "(none)"),
    };
    const parameters = asRecord(el.parameters) ?? {};
    for (const [key, value] of Object.entries(parameters)) {
      if (IDENTITY_KEYS.has(key) || key.toLowerCase() === "level") continue;
      columnSet.add(key);
      row[key] = value == null ? "" : String(value);
    }
    rows.push(row);
  }

  return { columns: Array.from(columnSet), rows };
}

async function loadScheduleData(args: {
  categories?: string[];
  searchScope?: "CurrentView" | "AllViews" | "SpecificView";
  maxResults?: number;
  parametersOutputType?:
    | "None"
    | "KeyParameters"
    | "SpecificParameters"
    | "AllParameters"
    | "EditableInstanceParameters";
  specificParameterNames?: string[];
  includeLinkedModels?: boolean;
}) {
  // 0 / omitted = load every match (UI filters then run on the full set).
  const limit =
    args.maxResults != null && args.maxResults > 0 ? Math.floor(args.maxResults) : 0;

  const includeLinkedModels = args.includeLinkedModels !== false;
  const categories = args.categories?.length ? args.categories : DEFAULT_MODEL_CATEGORIES;
  const [levelLabels, query, dashboard] = await Promise.all([
    loadLevelLabels(includeLinkedModels),
    withRevitConnection((client) =>
      client.sendCommand("query_model", {
        input: {
          searchScope: args.searchScope ?? "AllViews",
          elementInclusionMode: "InstancesOnly",
          categories,
          maxResults: 0,
          includeLinkedModels,
        },
      })
    ),
    loadDashboardStats(),
  ]);

  const allRefs = collectRefs(query);
  const refs = limit > 0 ? allRefs.slice(0, limit) : allRefs;
  if (refs.length === 0) {
    return {
      columns: ["elementId", "link", "name", "category", "family", "type", "level"],
      rows: [] as ElementRow[],
      matchedCount: 0,
      totalMatched: 0,
      truncated: false,
      message: "No elements matched the query.",
      dashboard,
    };
  }

  // Schedule UI defaults to editable instance params (not Area/Volume computed keys).
  const parameterMode = args.parametersOutputType ?? "EditableInstanceParameters";
  const elements: unknown[] = [];
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = refs.slice(i, i + BATCH_SIZE);
    const hasLinked = batch.some((r) => r.linkInstanceId != null);
    // Prefer elementIds for host-only batches so older CommandSet builds (no elementRefs) still work.
    const payload = hasLinked
      ? {
          elementRefs: batch.map((r) => ({
            elementId: r.elementId,
            linkInstanceId: r.linkInstanceId ?? null,
          })),
        }
      : {
          elementIds: batch.map((r) => r.elementId),
        };
    const data = await withRevitConnection((client) =>
      client.sendCommand("get_element_data", {
        ...payload,
        outputOptions: {
          basicElementInfo: true,
          parametersOutputType: parameterMode,
          specificParameterNames: args.specificParameterNames,
        },
      })
    );
    const record = asRecord(data);
    const batchElements = record?.elements;
    if (Array.isArray(batchElements)) {
      elements.push(...batchElements);
    }
  }

  const table = flattenElements(elements, levelLabels);
  const truncated = allRefs.length > refs.length;
  const queryRoot = asRecord(query);
  const linkedMatched = Number(queryRoot?.linkedMatchedCount ?? 0);
  const loadedLinks = Number(queryRoot?.loadedLinkCount ?? 0);
  const unloadedLinks = Number(queryRoot?.unloadedLinkCount ?? 0);
  const baseMessage =
    typeof queryRoot?.message === "string" && queryRoot.message
      ? String(queryRoot.message)
      : null;
  return {
    ...table,
    matchedCount: refs.length,
    totalMatched: allRefs.length,
    truncated,
    linkedMatchedCount: linkedMatched,
    loadedLinkCount: loadedLinks,
    unloadedLinkCount: unloadedLinks,
    dashboard,
    message: truncated
      ? `Loaded ${refs.length} of ${allRefs.length} instances (maxResults ${limit}). ${baseMessage ?? ""}`.trim()
      : baseMessage,
  };
}

export async function registerMcpApp(server: McpServer) {
  registerAppTool(
    server,
    "mcp_apps_get_schedule_data",
    {
      title: "MCP Apps · Revit Schedule",
      description:
        "[MCP Apps] Loads host + loaded linked-model instances into a filterable editable report (default model categories, no row cap by default). Default parametersOutputType is EditableInstanceParameters (writable instance params; excludes Area/Volume). Linked rows are read-only for edits.",
      inputSchema: {
        categories: z
          .array(z.string())
          .optional()
          .describe(
            "Optional BuiltInCategory filter. Omit to load the default model-category set (not system junk)."
          ),
        searchScope: z
          .enum(["CurrentView", "AllViews", "SpecificView"])
          .optional()
          .describe("Query scope. Default AllViews."),
        maxResults: z
          .number()
          .optional()
          .describe("Optional row limit. Omit or 0 = load every match so UI filters see the full set."),
        parametersOutputType: z
          .enum([
            "None",
            "KeyParameters",
            "SpecificParameters",
            "AllParameters",
            "EditableInstanceParameters",
          ])
          .optional()
          .describe(
            "Default EditableInstanceParameters (writable instance params). Use None for identity-only (fastest)."
          ),
        specificParameterNames: z
          .array(z.string())
          .optional()
          .describe("Used when parametersOutputType is SpecificParameters."),
        includeLinkedModels: z
          .boolean()
          .optional()
          .describe("Include elements from loaded Revit links. Default true. Unloaded links are skipped."),
      },
      _meta: { ui: { resourceUri: REVIT_REPORT_RESOURCE_URI } },
    },
    async (args) => {
      try {
        const data = await loadScheduleData(args ?? {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          structuredContent: data,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `mcp_apps_get_schedule_data failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-app", "app.html");
  const probeLogPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "mcp-app-resource-reads.log"
  );

  registerAppResource(
    server,
    REVIT_REPORT_RESOURCE_URI,
    REVIT_REPORT_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await fs.readFile(htmlPath, "utf-8");
      try {
        await fs.appendFile(
          probeLogPath,
          `${new Date().toISOString()} resources/read ${REVIT_REPORT_RESOURCE_URI} bytes=${html.length}\n`
        );
      } catch {
        // ignore probe log failures
      }
      return {
        contents: [
          {
            uri: REVIT_REPORT_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    }
  );
}

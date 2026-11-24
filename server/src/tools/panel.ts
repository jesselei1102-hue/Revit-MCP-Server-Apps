import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

const panelAnalysisItemSchema = z.object({
  elementId: z.number().int().positive().describe("Revit element Id to color in the panel."),
  status: z.string().optional().describe("Optional status key, e.g. pass, fail, warn. Used when color is not provided."),
  color: z.string().optional().describe("Optional CSS/hex color, e.g. #e05a5a, rgb(224,90,90), red."),
  label: z.string().optional().describe("Optional legend label for this item or status group."),
  opacity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Mesh opacity 0–1 for this element (0 = invisible, 1 = opaque). Use with defaultOpacity to ghost context."),
});

export function registerPanelTools(server: McpServer) {
  server.tool(
    "panel_show_geometry",
    "Show lightweight Revit element mesh geometry in the Agent Canvas panel. Extracts geometry in-process and streams it to the panel as a local file. Returns counts only; mesh data is never returned.",
    {
      input: z.object({
        elementIds: z.array(z.number().int().positive()).optional().describe("Element Ids to show. If omitted and selectedOnly is true, uses the current selection. If omitted and selectedOnly is false, uses the current view's model categories."),
        selectedOnly: z.boolean().optional().describe("Use the current Revit selection instead of explicit elementIds."),
      }),
    },
    async (args) => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("panel_show_geometry", args.input));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `panel_show_geometry failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );

  server.tool(
    "panel_set_analysis",
    "Color and/or set opacity on elements already loaded in the Agent Canvas. Does not regenerate geometry. Use opacity + defaultOpacity to highlight focus elements while ghosting the rest.",
    {
      input: z.object({
        items: z.array(panelAnalysisItemSchema).min(1).describe("Analysis items to apply to the loaded panel geometry."),
        defaultOpacity: z
          .number()
          .min(0)
          .max(1)
          .nullable()
          .optional()
          .describe("Opacity 0–1 for meshes not listed in items (ghost context). Pass null to clear."),
      }),
    },
    async (args) => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("panel_set_analysis", args.input));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `panel_set_analysis failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );

  const panelVec3Schema = z.union([
    z.tuple([z.number(), z.number(), z.number()]),
    z.object({ x: z.number(), y: z.number(), z: z.number() }),
  ]).describe("XYZ in Revit internal feet, same space as panel_show_geometry meshes.");

  const panelPlaneSchema = z.object({
    origin: panelVec3Schema.describe("Any point on the plane."),
    normal: panelVec3Schema.describe("Plane normal (need not be unit length)."),
  });

  const panelAnnotationSchema = z.object({
    kind: z
      .enum(["distance", "point-point", "point-plane", "plane-plane", "angle", "marker"])
      .optional()
      .describe("Annotation type. Default distance when start+end are set."),
    // distance / point-point
    start: panelVec3Schema.optional().describe("Distance start point."),
    end: panelVec3Schema.optional().describe("Distance end point."),
    offset: panelVec3Schema.optional().describe("Optional offset for the dimension line (distance only)."),
    // point-plane
    point: panelVec3Schema.optional().describe("Point for point-plane or marker."),
    plane: panelPlaneSchema.optional().describe("Plane for point-plane."),
    planeOrigin: panelVec3Schema.optional().describe("Flattened plane origin for point-plane."),
    planeNormal: panelVec3Schema.optional().describe("Flattened plane normal for point-plane."),
    // plane-plane
    planeA: panelPlaneSchema.optional(),
    planeB: panelPlaneSchema.optional(),
    originA: panelVec3Schema.optional(),
    normalA: panelVec3Schema.optional(),
    originB: panelVec3Schema.optional(),
    normalB: panelVec3Schema.optional(),
    // angle (a–vertex–c, or points: [a, vertex, c])
    vertex: panelVec3Schema.optional(),
    a: panelVec3Schema.optional(),
    c: panelVec3Schema.optional(),
    points: z.array(panelVec3Schema).min(3).max(3).optional()
      .describe("Angle shortcut: [pointA, vertex, pointC]."),
    // common
    label: z
      .string()
      .optional()
      .describe("Optional check note prefix, e.g. 'corridor clear width'. Measured m/mm or degrees is always appended."),
    color: z.string().optional().describe("CSS/hex color for the label pill."),
    id: z.string().optional().describe("Optional id for agent bookkeeping."),
  });

  server.tool(
    "panel_set_annotations",
    "Draw 3D measure overlays in Agent Canvas Model as space-check references: point–point / point–plane / plane–plane distances (auto-labeled in m or mm) and angles (°). Optional label/note is a prefix; the measured value is always shown. Coordinates are Revit feet (same as panel meshes). Replaces the previous set. Pass items: [] to clear. Switches to Model.",
    {
      input: z.object({
        items: z
          .array(panelAnnotationSchema)
          .describe("Annotations to show. Empty array clears all panel annotations."),
      }),
    },
    async (args) => {
      try {
        const response = await withRevitConnection((client) =>
          client.sendCommand("panel_set_annotations", args.input)
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `panel_set_annotations failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  const reportStatSchema = z.object({
    label: z.string().describe("Stat label, e.g. Failures."),
    value: z.union([z.string(), z.number()]).describe("Stat value shown in the report header strip."),
  });

  const reportSectionSchema = z.object({
    heading: z.string().optional().describe("Section heading."),
    body: z.string().optional().describe("Plain-text section body (escaped; not HTML)."),
    columns: z.array(z.string()).optional().describe("Table column headers."),
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.null()])))
      .optional()
      .describe("Table rows aligned to columns."),
    html: z
      .string()
      .max(64 * 1024)
      .optional()
      .describe("Optional HTML fragment (≤64KB) rendered in a sandboxed iframe inside the section."),
  });

  server.tool(
    "panel_show_report",
    "Show a structured Ultraviolet report in the Agent Canvas Report pane (Schedule / GBP Audit / custom tables). Switches to the Report tab by default. Prefer sections+tables over raw HTML.",
    {
      input: z.object({
        title: z.string().min(1).describe("Report title."),
        subtitle: z.string().optional().describe("Short supporting line under the title."),
        kind: z
          .string()
          .optional()
          .describe("Report kind badge, e.g. schedule, gbp-audit, checklist, custom."),
        theme: z.enum(["light", "dark"]).optional().describe("Force report theme. Default keeps the user's last choice."),
        stats: z.array(reportStatSchema).optional().describe("Header metrics strip."),
        notice: z
          .object({
            text: z.string(),
            tone: z.enum(["info", "warn", "error"]).optional(),
          })
          .optional()
          .describe("Banner under the stats strip."),
        sections: z.array(reportSectionSchema).optional().describe("Ordered report sections (text and/or tables)."),
        columns: z.array(z.string()).optional().describe("Shortcut: single table columns when sections is omitted."),
        rows: z
          .array(z.array(z.union([z.string(), z.number(), z.null()])))
          .optional()
          .describe("Shortcut: single table rows when sections is omitted."),
        html: z
          .string()
          .max(64 * 1024)
          .optional()
          .describe("Shortcut: one HTML section (≤64KB) when sections is omitted."),
        switchView: z
          .boolean()
          .optional()
          .describe("Switch the Agent Canvas to the Report tab. Default true."),
      }),
    },
    async (args) => {
      try {
        const { switchView, ...report } = args.input;
        const response = await withRevitConnection((client) =>
          client.sendCommand("panel_show_report", {
            report,
            switchView: switchView !== false,
          })
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `panel_show_report failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "panel_set_view",
    "Switch Agent Canvas between Model (3D) and Dynamic Report. Schedule / GBP stay in Cursor MCP Apps — not in the panel.",
    {
      input: z.object({
        view: z
          .enum(["model", "report"])
          .describe("model = 3D canvas; report = static host for panel_show_report."),
      }),
    },
    async (args) => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("panel_set_view", args.input));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `panel_set_view failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "panel_fit",
    "Fit the Agent Canvas camera to the loaded model geometry.",
    {},
    async () => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("panel_fit", {}));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `panel_fit failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );

  server.tool(
    "panel_clear",
    "Clear the Agent Canvas panel content and delete temporary geometry files. target is 'model', 'report', 'annotations', or 'all' (default all).",
    {
      input: z.object({
        target: z
          .enum(["model", "report", "annotations", "all"])
          .optional()
          .describe("Which panel content to clear. Default all."),
      }).optional(),
    },
    async (args) => {
      try {
        const payload = args.input ?? {};
        const response = await withRevitConnection((client) => client.sendCommand("panel_clear", payload));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `panel_clear failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );

  server.tool(
    "panel_status",
    "Return the Agent Canvas panel status: readiness, loaded element/vertex counts, last pick, last error, and any pendingAgentInstruction queued by GBP Audit / Schedule Run (follow it via panel_get_agent_instruction).",
    {},
    publicReadAnnotations,
    async () => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("panel_status", {}));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `panel_status failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );

  server.tool(
    "panel_get_agent_instruction",
    "Claim the instruction that GBP Audit (or Schedule) queued from the Agent Canvas when the user clicked Run / Send to agent. Returns the full text to follow, then clears it by default. Call this when the user says they clicked Run in the panel, or when panel_status shows pendingAgentInstruction.",
    {
      input: z
        .object({
          clear: z
            .boolean()
            .optional()
            .describe("Clear the queued instruction after reading. Default true."),
        })
        .optional(),
    },
    publicReadAnnotations,
    async (args) => {
      try {
        const payload = args.input ?? {};
        const response = await withRevitConnection((client) =>
          client.sendCommand("panel_get_agent_instruction", payload)
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `panel_get_agent_instruction failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "panel_pick",
    "Return the last element picked in the Agent Canvas panel. Use after the user clicks a mesh in the panel; the plugin has already selected that element in Revit.",
    {},
    publicReadAnnotations,
    async () => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("panel_pick", {}));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `panel_pick failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );

  server.tool(
    "panel_capture",
    "Capture the current Agent Canvas WebGL view as an image for vision/rendering models. Returns MCP image content plus metadata (size, camera, optional file path). Does not include the HTML HUD overlay.",
    {
      input: z
        .object({
          format: z
            .enum(["png", "jpeg"])
            .optional()
            .describe("Image format. Default png. Use jpeg for smaller payloads to vision models."),
          quality: z
            .number()
            .min(0.1)
            .max(1)
            .optional()
            .describe("JPEG quality 0.1–1. Ignored for png. Default 0.9."),
          maxWidth: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Downscale so width ≤ this (keeps aspect). Default 1600."),
          maxHeight: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Downscale so height ≤ this (keeps aspect). Default 1600."),
          saveFile: z
            .boolean()
            .optional()
            .describe("Also write the image under panel-view/tmp. Default true."),
          source: z
            .enum(["live", "user"])
            .optional()
            .describe(
              "live (default): snapshot the canvas now. user: return the last image the user sent via the panel Send capture button."
            ),
        })
        .optional(),
    },
    publicReadAnnotations,
    async (args) => {
      try {
        const payload = args.input ?? {};
        const response = (await withRevitConnection((client) =>
          client.sendCommand("panel_capture", payload)
        )) as {
          ok?: boolean;
          error?: string;
          message?: string;
          mimeType?: string;
          dataBase64?: string;
          width?: number;
          height?: number;
          filePath?: string;
          fileName?: string;
          camera?: unknown;
          elementCount?: number;
          totalVertices?: number;
          byteLength?: number;
          requestId?: string;
        };

        if (!response?.ok || !response.dataBase64 || !response.mimeType) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(response ?? { ok: false, error: "empty_response" }, null, 2),
              },
            ],
          };
        }

        const { dataBase64, ...meta } = response;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...meta,
                  dataBase64Length: dataBase64.length,
                  note: "Image also returned as MCP image content for vision/rendering models.",
                },
                null,
                2
              ),
            },
            {
              type: "image" as const,
              data: dataBase64,
              mimeType: response.mimeType,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `panel_capture failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

const panelAnalysisItemSchema = z.object({
  elementId: z.number().int().positive().describe("Revit element Id to color in the panel."),
  status: z.string().optional().describe("Optional status key, e.g. pass, fail, warn. Used when color is not provided."),
  color: z.string().optional().describe("Optional CSS/hex color, e.g. #e05a5a, rgb(224,90,90), red."),
  label: z.string().optional().describe("Optional legend label for this item or status group."),
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
    "Color elements already loaded in the Agent Canvas panel according to analysis status/color. Does not regenerate geometry.",
    {
      input: z.object({
        items: z.array(panelAnalysisItemSchema).min(1).describe("Analysis items to apply to the loaded panel geometry."),
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
    "Clear the Agent Canvas panel content and delete temporary geometry files. target is 'model', 'report', or 'all' (default all).",
    {
      input: z.object({
        target: z.enum(["model", "report", "all"]).optional().describe("Which panel content to clear. Default all."),
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
    "Return the Agent Canvas panel status: readiness, loaded element/vertex counts, last pick, and last error.",
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

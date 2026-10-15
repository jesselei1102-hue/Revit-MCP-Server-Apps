import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

export function registerExportViewsTool(server: McpServer) {
  server.tool(
    "export_views",
    "Exports printable views to image files (PNG, JPG, BMP, TIFF), including floor plans, ceiling plans, elevations, sections, 3D views, and sheets. Exports printable views to separate PDF files. Exports schedule views to CSV. All files in one call use the same format.",
    {
      exportMode: z
        .enum(["ByViewList", "CurrentView", "VisibleRegion"])
        .optional()
        .describe("Default ByViewList. CurrentView exports the active view. VisibleRegion exports what is on screen."),
      viewIds: z.array(z.number()).optional().describe("View Ids to export. Required for ByViewList."),
      directoryPath: z.string().optional().describe("Folder to save files. Defaults to the user's Documents folder."),
      fileFormat: z
        .enum(["PNG", "JPG", "BMP", "TIFF", "CSV", "PDF"])
        .optional()
        .describe("Default PNG. CSV is for schedules only."),
    },
    publicReadAnnotations,
    async (args) => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("export_views", args));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `export_views failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
}

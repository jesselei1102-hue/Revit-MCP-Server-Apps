import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

export function registerOpenViewTool(server: McpServer) {
  server.tool(
    "open_view",
    "Opens a view (sets it as the active view). Template views and browser views cannot be opened.",
    {
      viewId: z.number().describe("Id of the view to open."),
    },
    publicReadAnnotations,
    async (args) => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("open_view", args));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `open_view failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
}

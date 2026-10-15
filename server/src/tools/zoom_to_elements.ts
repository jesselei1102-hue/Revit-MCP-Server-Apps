import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

export function registerZoomToElementsTool(server: McpServer) {
  server.tool(
    "zoom_to_elements",
    "Zoom in on or focus the current view on specific elements by their Ids.",
    {
      elementIds: z.array(z.number()).describe("Ids of the elements to show."),
    },
    publicReadAnnotations,
    async (args) => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("zoom_to_elements", args));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `zoom_to_elements failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
}

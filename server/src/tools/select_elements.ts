import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

export function registerSelectElementsTool(server: McpServer) {
  server.tool(
    "select_elements",
    "Selects elements by their Ids.",
    {
      elementIds: z.array(z.number()).describe("Ids of the elements to select."),
    },
    publicReadAnnotations,
    async (args) => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("select_elements", args));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `select_elements failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
}

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const transactionModeSchema = z
  .enum(["auto", "none"])
  .default("auto")
  .describe(
    "How the snippet should interact with Revit transactions. Use 'auto' to wrap the snippet in a transaction, or 'none' when the called code manages its own transactions."
  );

export function registerSendCodeToRevitTool(server: McpServer) {
  server.tool(
    "send_code_to_revit",
    "LAST RESORT. Do not use if a dedicated Revit tool can do the job. Prefer query_model, get_element_data, get_current_view_elements, get_selected_elements, ai_element_filter, operate_element, create_grid, create_level, create_room, create_point_based_element, create_line_based_element, create_surface_based_element, create_dimensions, open_view, zoom_to_elements, select_elements, export_views, color_elements, delete_element. Use only when those tools cannot express the API (complex geometry, custom transactions, unsupported filters). Code is inserted into a template Execute method with Document access.",
    {
      code: z
        .string()
        .describe(
          "C# snippet for cases no dedicated tool covers. Inserted into the template Execute method. Do not use this to list, select, color, delete, or create elements that existing tools already handle."
        ),
      parameters: z
        .array(z.string())
        .optional()
        .describe(
          "Optional execution parameters that will be passed to your code"
        ),
      transactionMode: transactionModeSchema,
    },
    {
      title: "Last-resort C# execution",
      destructiveHint: true,
      openWorldHint: false,
    },
    async (args, extra) => {
      const params = {
        code: args.code,
        parameters: args.parameters || [],
        transactionMode: args.transactionMode,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("send_code_to_revit", params);
        });

        return {
          content: [
            {
              type: "text",
              text: `Code execution successful!\nResult: ${JSON.stringify(
                response,
                null,
                2
              )}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Code execution failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}

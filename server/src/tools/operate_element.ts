import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

export function registerOperateElementTool(server: McpServer) {
  server.tool(
    "operate_element",
    "Preferred over send_code_to_revit for acting on known element Ids: select, hide, delete, setColor, highlight, isolate, resetOverride, changeType. Do not write C# for these operations.",
    {
      data: z
        .object({
          elementIds: z
            .array(
              z.number().describe("A valid Revit element ID to operate on")
            )
            .describe("Array of Revit element IDs to perform the specified action on"),
          action: z
            .string()
            .describe(
              "Valid values: Select, SelectionBox, SetColor, SetTransparency, Delete, Hide, TempHide, Isolate, Unhide, ResetIsolate, ResetOverride, ResetColor, Highlight, ChangeType, SetParameter. ChangeType requires typeId. SetParameter requires parameterName + parameterValue."
            ),
          transparencyValue: z
            .number()
            .default(50)
            .describe("Transparency value (0-100) for SetTransparency action."),
          colorValue: z
            .array(z.number())
            .default([255, 0, 0])
            .describe("RGB color values for SetColor action. Default is red [255,0,0]."),
          typeId: z
            .number()
            .optional()
            .describe(
              "Target type ElementId for ChangeType (FamilyTypeId from get_available_family_types)."
            ),
          parameterName: z
            .string()
            .optional()
            .describe("Instance parameter name for SetParameter."),
          parameterValue: z
            .string()
            .optional()
            .describe("Value to write for SetParameter (display string)."),
        })
        .describe("Parameters for operating on Revit elements with specific actions"),
    },
    async (args, extra) => {
      const params = args;

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("operate_element", params);
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Operate elements failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}

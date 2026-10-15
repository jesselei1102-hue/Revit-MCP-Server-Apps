import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

export function registerGetElementDataTool(server: McpServer) {
  server.tool(
    "get_element_data",
    "Gets comprehensive parameters information for elements. Supports host elements via elementIds, or host+linked via elementRefs [{elementId, linkInstanceId}]. If outputOptions is omitted, only basic name/category/family/type/level is returned.",
    {
      elementIds: z
        .array(z.number())
        .optional()
        .describe("Ids of host-document elements to read."),
      elementRefs: z
        .array(
          z.object({
            elementId: z.number(),
            linkInstanceId: z.number().nullable().optional(),
          })
        )
        .optional()
        .describe("Host or linked element refs. Prefer this when includeLinkedModels was used."),
      outputOptions: z
        .object({
          basicElementInfo: z
            .boolean()
            .optional()
            .describe("Include name, category, family, type, and level. Default true."),
          elementClass: z.boolean().optional().describe("Include the Revit API class name."),
          boundingBox: z.boolean().optional().describe("Include the element bounding box in feet."),
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
              "Parameter output mode. EditableInstanceParameters = writable instance params (excludes Area/Volume). Default None."
            ),
          specificParameterNames: z
            .array(z.string())
            .optional()
            .describe("Used when parametersOutputType is SpecificParameters."),
        })
        .optional(),
    },
    publicReadAnnotations,
    async (args) => {
      try {
        const response = await withRevitConnection((client) =>
          client.sendCommand("get_element_data", args)
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `get_element_data failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    }
  );
}

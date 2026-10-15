import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

export function registerQueryModelTool(server: McpServer) {
  server.tool(
    "query_model",
    "Gets element Ids by querying the model with multi-criteria filtering including spatial, parametric, and categorical filters. Returns results.elementIds plus results.analysis (counts by category, level, family). Use the Ids with get_element_data, select_elements, zoom_to_elements, or operate_element. Official filter names are familyNameFilters, elementNameFilters, levelNameFilters.",
    {
      input: z.object({
        searchScope: z
          .enum(["CurrentView", "AllViews", "SpecificView"])
          .optional()
          .describe("Scope of search: CurrentView, SpecificView, or AllViews. Default CurrentView."),
        viewId: z.number().optional().describe("Id of the view to search; only used when searchScope is SpecificView."),
        selectedOnly: z.boolean().optional().describe("Whether to search only through currently selected elements."),
        elementInclusionMode: z
          .enum(["InstancesOnly", "TypesOnly", "TypesAndInstances"])
          .optional()
          .describe("Which elements to include. Default InstancesOnly."),
        categories: z.array(z.string()).optional().describe("BuiltInCategory names such as OST_Doors, OST_Walls, OST_Windows."),
        familyNameFilters: z.array(z.string()).optional().describe("Partial, case-insensitive family name filters. Official Public MCP name."),
        elementNameFilters: z.array(z.string()).optional().describe("Partial, case-insensitive element name filters. Official Public MCP name."),
        levelNameFilters: z.array(z.string()).optional().describe("Partial, case-insensitive level name filters. Official Public MCP name."),
        familyNames: z.array(z.string()).optional().describe("Alias of familyNameFilters."),
        elementNames: z.array(z.string()).optional().describe("Alias of elementNameFilters."),
        levelNames: z.array(z.string()).optional().describe("Alias of levelNameFilters."),
        boundingBox: z
          .object({
            minXYZ: z.object({ x: z.number(), y: z.number(), z: z.number() }),
            maxXYZ: z.object({ x: z.number(), y: z.number(), z: z.number() }),
          })
          .optional()
          .describe("Spatial bounding box filter in feet."),
        boundingBoxFilteringMode: z
          .enum(["ElementsInside", "ElementsIntersecting"])
          .optional()
          .describe("How to apply boundingBox. Default ElementsIntersecting."),
        parameterFilters: z
          .array(
            z.object({
              parameterName: z.string().describe("Exact parameter name, BuiltInParameter name, or shared parameter Guid."),
              comparisonType: z.enum(["Equals", "Contains", "StartsWith", "EndsWith", "GreaterThan", "LessThan"]),
              value: z.string().describe("Value to compare against. Length parameters are in feet."),
            })
          )
          .optional(),
        maxResults: z.number().optional().describe("Maximum number of element Ids to return. 0 returns all matches."),
        includeLinkedModels: z
          .boolean()
          .optional()
          .describe(
            "When true, also search loaded RevitLinkInstance documents and return results.elementRefs with linkInstanceId/linkName. Unloaded links are skipped (counts in loadedLinkCount/unloadedLinkCount). Default false."
          ),
      }),
    },
    publicReadAnnotations,
    async (args) => {
      try {
        const response = await withRevitConnection((client) => client.sendCommand("query_model", args));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `query_model failed: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }
  );
}

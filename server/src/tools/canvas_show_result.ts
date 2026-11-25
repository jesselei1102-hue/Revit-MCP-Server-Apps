import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { validateSpec } from "../canvas/rps.js";

const DESCRIPTION = [
  "Show a result on the model-first Agent Canvas in Revit: the answer drawn in the building, with the layout you choose for the question.",
  "Send a Result Spec (spec: \"revit-result/1\"). It is checked against the Result Presentation Standard (RPS-1) first; if it breaks a rule nothing is shown and you get the rules to fix.",
  "Required: question (user's words), outcome (plain answer with count and scope, no element ids), verdict (pass|attention|fail|info), scope.model, view {kind: plan|axon|elevation, caption, legend [{status, label}], level when plan/cut, callouts ≤5 subject ids}, subjects [{id, revit_id, label (mark or room name), status, reason, place, level}], provenance {ran_at, rule in plain words, source}, limits[] (or limits_none: true).",
  "Statuses: fail, attention, pass, info, cat1, cat2. Optional: figures (≤4), charts (≤2: bar|stacked-bar|progress|line, title = takeaway), columns (≤6), actions (propose_change needs effect + count).",
  "Choose presentation {layout, show, levels, overlays, measure, why}:",
  "- whole-model screening with few failures (e.g. clear height everywhere): layout model-focus, show failures-only, levels exploded; add overlays [\"measure\"] with measure {value, required, unit} for measured checks;",
  "- one storey with mixed results: model-and-list, in-context, levels cut + view.level;",
  "- 2–8 issues to walk someone through: tour, in-context;",
  "- all pass: model-focus, everything; non-spatial or very long lists: report.",
  "Derived zones (e.g. a clearance volume) go in subjects[].geometry {level (Revit level id or name), x0,y0,x1,y1 in metres (Revit internal coordinates × 0.3048), z0,z1 metres above that level}; put the causing elements' Revit ids in related[].",
].join("\n");

export function registerCanvasShowResultTool(server: McpServer) {
  server.tool(
    "canvas_show_result",
    DESCRIPTION,
    {
      result: z
        .object({ spec: z.literal("revit-result/1") })
        .passthrough()
        .describe("The Result Spec (revit-result/1) to draw in the model."),
    },
    { title: "Show a result in the model", readOnlyHint: true, openWorldHint: false },
    async (args) => {
      const violations = validateSpec(args.result as Record<string, unknown>);
      if (violations.length) {
        const lines = violations.map((x) => `${x.rule}: ${x.msg}`).join("\n");
        return {
          isError: true,
          content: [{ type: "text" as const, text: `The result breaks the presentation standard, so it was not shown. Fix these and send it again:\n${lines}` }],
        };
      }
      try {
        const response = await withRevitConnection((client) => client.sendCommand("panel_show_result", { result: args.result }));
        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `canvas_show_result failed: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}

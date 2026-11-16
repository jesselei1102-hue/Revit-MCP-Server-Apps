import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const mm = "Millimeters.";
const dryRun = z
  .boolean()
  .optional()
  .describe("When true, validate the change and roll it back.");

const pointFields = (prefix: string, required: boolean) => {
  const number = required ? z.number() : z.number().optional();
  const axis = (name: string) =>
    number.describe(`${prefix} ${name} in millimeters${required ? "" : ". Omit to keep the current end"}.`);
  const key = (axisName: string) => `${prefix.toLowerCase()}${axisName}`;
  return {
    [key("X")]: axis("X"),
    [key("Y")]: axis("Y"),
    [key("Z")]: axis("Z"),
  };
};

const limit = z.number().optional().describe("Maximum rows to return. Default 200 for instances, 500 for types.");
const levelId = z.number().optional().describe("Level element id.");
const systemTypeId = z.number().optional().describe("System type element id.");
const typeId = z.number().optional().describe("Curve type element id.");

function registerMepTool(
  server: McpServer,
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny>
) {
  server.tool(name, description, schema, async (args) => {
    try {
      const response = await withRevitConnection((client) => client.sendCommand(name, args));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `${name} failed: ${message}` }],
      };
    }
  });
}

export function registerMepTools(server: McpServer) {
  registerMepTool(server, "get_pipe_types", "List pipe types loaded in the open Revit document.", { limit });
  registerMepTool(server, "get_duct_types", "List duct types. Each row includes shape: round, rectangular, or oval.", { limit });
  registerMepTool(server, "get_cable_tray_types", "List cable tray types loaded in the open Revit document.", { limit });
  registerMepTool(
    server,
    "get_pipe_system_types",
    "List piping system types. Use the returned id as systemTypeId when creating a pipe.",
    {
      systemClass: z.string().optional().describe("Optional classification filter, for example Sanitary or DomesticColdWater."),
      limit,
    }
  );
  registerMepTool(
    server,
    "get_duct_system_types",
    "List duct system types such as SupplyAir, ReturnAir, and ExhaustAir. Use the returned id as systemTypeId when creating a duct.",
    {
      systemClass: z.string().optional().describe("Optional classification filter."),
      limit,
    }
  );

  const curveQuery = {
    levelId,
    typeId,
    systemTypeId,
    diameterMm: z.number().optional().describe(`Filter round curves by diameter. ${mm}`),
    limit,
  };
  registerMepTool(server, "get_pipes", "List pipe instances. Coordinates and sizes are millimeters.", curveQuery);
  registerMepTool(server, "get_cable_trays", "List cable tray instances. Coordinates and sizes are millimeters.", {
    levelId,
    typeId,
    limit,
  });
  registerMepTool(server, "get_ducts", "List duct instances. Coordinates and sizes are millimeters.", {
    ...curveQuery,
    shape: z.string().optional().describe("round, rectangular, or oval."),
  });

  const createEnds = { ...pointFields("Start", true), ...pointFields("End", true) };
  registerMepTool(
    server,
    "create_pipe",
    "Create a straight pipe. Coordinates are millimeters. Call get_pipe_system_types and get_pipe_types first.",
    {
      ...createEnds,
      levelId: z.number().describe("Level element id."),
      systemTypeId: z.number().describe("Piping system type id from get_pipe_system_types."),
      pipeTypeId: z.number().optional().describe("Pipe type id. Defaults to the first loaded pipe type."),
      diameterMm: z.number().optional().describe(`Nominal diameter. ${mm}`),
      dryRun,
    }
  );
  registerMepTool(
    server,
    "create_duct",
    "Create a straight duct. Coordinates are millimeters. Round ducts take diameterMm; rectangular and oval ducts take widthMm and heightMm.",
    {
      ...createEnds,
      levelId: z.number().describe("Level element id."),
      systemTypeId: z.number().describe("Duct system type id from get_duct_system_types."),
      ductTypeId: z.number().optional().describe("Duct type id. Defaults to the first loaded duct type."),
      diameterMm: z.number().optional().describe(`Round duct diameter. ${mm}`),
      widthMm: z.number().optional().describe(`Rectangular or oval width. ${mm}`),
      heightMm: z.number().optional().describe(`Rectangular or oval height. ${mm}`),
      dryRun,
    }
  );
  registerMepTool(
    server,
    "create_cable_tray",
    "Create a straight cable tray. Coordinates are millimeters.",
    {
      ...createEnds,
      levelId: z.number().describe("Level element id."),
      typeId: z.number().optional().describe("Cable tray type id. Defaults to the first loaded type."),
      widthMm: z.number().optional().describe(`Tray width. ${mm}`),
      heightMm: z.number().optional().describe(`Tray height. ${mm}`),
      dryRun,
    }
  );

  const moveEnds = { ...pointFields("Start", false), ...pointFields("End", false) };
  registerMepTool(server, "modify_pipe", "Change a pipe's endpoints, type, or diameter. Omitted fields stay as they are.", {
    elementId: z.number().describe("Pipe element id."),
    ...moveEnds,
    pipeTypeId: z.number().optional().describe("New pipe type id."),
    diameterMm: z.number().optional().describe(`New diameter. ${mm}`),
    dryRun,
  });
  registerMepTool(server, "modify_duct", "Change a duct's endpoints, type, or size. Size fields must match the duct shape.", {
    elementId: z.number().describe("Duct element id."),
    ...moveEnds,
    ductTypeId: z.number().optional().describe("New duct type id."),
    diameterMm: z.number().optional().describe(`Round duct diameter. ${mm}`),
    widthMm: z.number().optional().describe(`Rectangular or oval width. ${mm}`),
    heightMm: z.number().optional().describe(`Rectangular or oval height. ${mm}`),
    dryRun,
  });
  registerMepTool(server, "modify_cable_tray", "Change a cable tray's endpoints, type, width, or height.", {
    elementId: z.number().describe("Cable tray element id."),
    ...moveEnds,
    typeId: z.number().optional().describe("New cable tray type id."),
    widthMm: z.number().optional().describe(`Tray width. ${mm}`),
    heightMm: z.number().optional().describe(`Tray height. ${mm}`),
    dryRun,
  });

  const pair = {
    elementId1: z.number().describe("First curve element id."),
    elementId2: z.number().describe("Second curve element id."),
    connectorIndex1: z.number().optional().describe("Connector index on the first curve. Omit to use the closest open pair."),
    connectorIndex2: z.number().optional().describe("Connector index on the second curve."),
    dryRun,
  };
  const tee = {
    mainElementId: z.number().describe("Main curve element id. Revit splits it at the intersection."),
    branchElementId: z.number().describe("Branch curve element id. The branch must be perpendicular to the main."),
    branchConnectorIndex: z.number().optional().describe("Connector index on the branch."),
    dryRun,
  };
  const takeoff = {
    branchElementId: z.number().describe("Branch curve element id."),
    mainElementId: z.number().describe("Main curve element id that the branch taps."),
    branchConnectorIndex: z.number().optional().describe("Connector index on the branch."),
    dryRun,
  };
  const cross = {
    mainElementId1: z.number().describe("First half of the already split main."),
    mainElementId2: z.number().describe("Second half of the already split main."),
    branchElementId1: z.number().describe("First branch element id."),
    branchElementId2: z.number().describe("Second branch element id."),
    dryRun,
  };

  registerMepTool(
    server,
    "create_mep_fitting",
    "Create an MEP fitting. type is elbow, transition, union, tee, or takeoff. class is pipe, duct, or cable_tray. A cross needs the dedicated cross command.",
    {
      type: z.enum(["elbow", "transition", "union", "tee", "takeoff", "cross"]),
      class: z.enum(["pipe", "duct", "cable_tray"]),
      elementId1: z.number().describe("First element. For a tee this is the main. For a takeoff this is the branch."),
      elementId2: z.number().describe("Second element. For a tee this is the branch. For a takeoff this is the main."),
      connectorIndex1: pair.connectorIndex1,
      connectorIndex2: pair.connectorIndex2,
      dryRun,
    }
  );

  registerMepTool(server, "create_pipe_elbow_fitting", "Create an elbow between two pipes. The connector angle must be 2°–95°.", pair);
  registerMepTool(server, "create_pipe_transition_fitting", "Join two collinear pipes of different diameter with a transition.", pair);
  registerMepTool(server, "create_pipe_union_fitting", "Join two collinear pipes of the same diameter with a union.", pair);
  registerMepTool(server, "create_pipe_tee_fitting", "Create a tee where a branch pipe meets a main pipe.", tee);
  registerMepTool(server, "create_pipe_cross_fitting", "Create a cross. Split the main pipe first, then pass both halves and both branches.", cross);
  registerMepTool(server, "create_pipe_takeoff_fitting", "Tap a branch pipe onto the body of a main pipe.", takeoff);
  registerMepTool(server, "create_duct_elbow_fitting", "Create an elbow between two ducts. The connector angle must be 2°–95°.", pair);
  registerMepTool(server, "create_duct_transition_fitting", "Join two collinear ducts of different size with a transition.", pair);
  registerMepTool(server, "create_duct_union_fitting", "Join two collinear ducts of the same size with a union.", pair);
  registerMepTool(server, "create_duct_tee_fitting", "Create a tee where a branch duct meets a main duct.", tee);
  registerMepTool(server, "create_duct_cross_fitting", "Create a cross. Split the main duct first, then pass both halves and both branches.", cross);
  registerMepTool(server, "create_duct_takeoff_fitting", "Tap a branch duct onto the body of a main duct.", takeoff);
  registerMepTool(server, "create_elbow_fitting", "Create an elbow between two cable trays. The connector angle must be 2°–95°.", pair);
  registerMepTool(server, "create_transition_fitting", "Join two collinear cable trays of different size with a transition.", pair);
  registerMepTool(server, "create_union_fitting", "Join two collinear cable trays of the same size with a union.", pair);
  registerMepTool(server, "create_tee_fitting", "Create a tee where a branch cable tray meets a main tray.", tee);
  registerMepTool(server, "create_cross_fitting", "Create a cross. Split the main cable tray first, then pass both halves and both branches.", cross);
}

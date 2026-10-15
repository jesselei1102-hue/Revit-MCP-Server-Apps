import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { publicReadAnnotations } from "./mcpAnnotations.js";

const execFileAsync = promisify(execFile);

export function registerGetRunningRevitInstancesTool(server: McpServer) {
  server.tool(
    "get_running_revit_instances",
    "Returns a list of all running Revit instances. Each record contains the Process ID of the instance and the name of the currently open document. The instance currently connected to this MCP server is marked connected=true.",
    {},
    publicReadAnnotations,
    async () => {
      let processes: Array<{ Id?: number; MainWindowTitle?: string }> = [];
      try {
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          "Get-Process Revit -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress",
        ]);
        const parsed = stdout?.trim() ? JSON.parse(stdout) : [];
        processes = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      } catch {
        processes = [];
      }

      let connected: {
        processId?: number;
        documentName?: string;
        documentPath?: string;
        revitVersion?: string;
      } | null = null;
      try {
        connected = await withRevitConnection((client) =>
          client.sendCommand("get_running_revit_instances", {})
        );
      } catch {
        connected = null;
      }

      const instances = processes.map((process) => {
        const processId = process.Id;
        const isConnected = connected?.processId === processId;
        return {
          processId,
          documentName: isConnected
            ? connected?.documentName || process.MainWindowTitle || ""
            : process.MainWindowTitle || "",
          documentPath: isConnected ? connected?.documentPath : undefined,
          revitVersion: isConnected ? connected?.revitVersion : undefined,
          connected: isConnected,
        };
      });

      if (
        connected?.processId &&
        !instances.some((instance) => instance.processId === connected.processId)
      ) {
        instances.push({
          processId: connected.processId,
          documentName: connected.documentName || "",
          documentPath: connected.documentPath,
          revitVersion: connected.revitVersion,
          connected: true,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ instances }, null, 2),
          },
        ],
      };
    }
  );
}

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckTools } from "./checks/tools.js";
import { registerMcpApp } from "./mcpApp.js";
import { registerTools } from "./tools/register.js";

const server = new McpServer(
  {
    name: "mcp-server-for-revit",
    version: "1.0.0",
  },
  {
    instructions:
      "Tool-first: call dedicated Revit tools before send_code_to_revit. Query with query_model/get_element_data/get_current_view_elements/get_selected_elements/ai_element_filter. Mutate with operate_element. Create with create_grid/create_level/create_room/create_*_based_element/create_dimensions. Views with open_view/zoom_to_elements/select_elements/export_views. send_code_to_revit is last resort only when no dedicated tool covers the API.",
  }
);

// 启动服务器
async function main() {
  // 注册工具
  await registerTools(server);
  await registerMcpApp(server);
  await registerCheckTools(server);

  // 连接到传输层
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Revit MCP Server start success");
}

main().catch((error) => {
  console.error("Error starting Revit MCP Server:", error);
  process.exit(1);
});

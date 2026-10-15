import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, "probe.log");
const RESOURCE_URI = "ui://probe/widget.html";

const record = (event, extra = {}) =>
  fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), event, ...extra }) + "\n");

const server = new McpServer({ name: "mcp-apps-probe", version: "1.0.0" });

registerAppTool(
  server,
  "probe_show_widget",
  {
    title: "Probe Show Widget",
    description: "Tiny MCP App probe. If no green box appears, Cursor did not mount the widget.",
    inputSchema: {
      nonce: z.string().optional().describe("Arbitrary value so repeated calls are not deduped."),
    },
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  },
  async ({ nonce }) => {
    record("tool_call", { nonce: nonce ?? null });
    return {
      content: [
        {
          type: "text",
          text: `probe ok (nonce=${nonce ?? "none"}). If no green box rendered, host skipped resources/read.`,
        },
      ],
      structuredContent: { nonce: nonce ?? null },
    };
  }
);

registerAppResource(
  server,
  "Probe Widget",
  RESOURCE_URI,
  { description: "Minimal MCP Apps mount test." },
  async () => {
    record("resource_read", { uri: RESOURCE_URI });
    return {
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
          text:
            `<!doctype html><html><body style="margin:0;font:14px system-ui">` +
            `<div style="padding:12px;border:2px solid #2ea043;border-radius:8px;background:#0d1117;color:#2ea043">` +
            `MCP App widget MOUNTED` +
            `</div></body></html>`,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
record("connected", { pid: process.pid });

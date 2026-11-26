import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

// A stand-in for the Revit plugin: loopback only, rejects requests without the session token.
const TOKEN = "test-session-token";
let server: net.Server;
let port: number;
const seen: any[] = [];

beforeAll(async () => {
  server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const req = JSON.parse(chunk.toString("utf8"));
      seen.push(req);
      const res =
        req.auth === TOKEN
          ? { jsonrpc: "2.0", id: req.id, result: { ok: true } }
          : { jsonrpc: "2.0", id: req.id, error: { code: -32001, message: "Unauthorized" } };
      socket.write(JSON.stringify(res));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function loadConnectionManager() {
  vi.resetModules();
  vi.stubEnv("REVIT_MCP_PORT", String(port));
  return import("../../src/utils/ConnectionManager");
}

describe("withRevitConnection authentication", () => {
  it("sends the session token to 127.0.0.1 and gets a result", async () => {
    vi.stubEnv("REVIT_MCP_TOKEN", TOKEN);
    const { withRevitConnection } = await loadConnectionManager();
    const result = await withRevitConnection((c) => c.sendCommand("say_hello", {}));
    expect(result).toEqual({ ok: true });
    expect(seen.at(-1).auth).toBe(TOKEN);
  });

  it("surfaces the plugin's Unauthorized error for a wrong token", async () => {
    vi.stubEnv("REVIT_MCP_TOKEN", "wrong");
    const { withRevitConnection } = await loadConnectionManager();
    await expect(withRevitConnection((c) => c.sendCommand("say_hello", {}))).rejects.toThrow(/Unauthorized/);
  });

  it("fails before connecting when no token is available, and releases the lock", async () => {
    vi.stubEnv("REVIT_MCP_TOKEN", "");
    vi.stubEnv("REVIT_MCP_TOKEN_FILE", "/nonexistent/revit-mcp-token");
    const { withRevitConnection } = await loadConnectionManager();
    const before = seen.length;
    await expect(withRevitConnection((c) => c.sendCommand("say_hello", {}))).rejects.toThrow(/token not found/);
    await expect(withRevitConnection((c) => c.sendCommand("say_hello", {}))).rejects.toThrow(/token not found/);
    expect(seen.length).toBe(before);
  });
});

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { REVIT_HOST, readRevitToken, tokenFilePath } from "../../src/utils/auth";
import { RevitClientConnection } from "../../src/utils/SocketClient";

describe("Revit session token", () => {
  it("connects to IPv4 loopback, matching the plugin's listener", () => {
    expect(REVIT_HOST).toBe("127.0.0.1");
  });

  it("reads the token from %LOCALAPPDATA%\\RevitMCP\\token-<port> on Windows", () => {
    const path = tokenFilePath(8080, { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32");
    expect(path).toBe(join("C:\\Users\\me\\AppData\\Local", "RevitMCP", "token-8080"));
  });

  it("lets REVIT_MCP_TOKEN_FILE override the path", () => {
    expect(tokenFilePath(8080, { REVIT_MCP_TOKEN_FILE: "/tmp/t" }, "win32")).toBe("/tmp/t");
  });

  it("prefers REVIT_MCP_TOKEN over the file", () => {
    const token = readRevitToken(8080, { REVIT_MCP_TOKEN: " abc " }, "win32", () => {
      throw new Error("file should not be read");
    });
    expect(token).toBe("abc");
  });

  it("trims the token read from the file", () => {
    expect(readRevitToken(8080, { LOCALAPPDATA: "C:\\x" }, "win32", () => "deadbeef\r\n")).toBe("deadbeef");
  });

  it("explains how to fix a missing token file", () => {
    expect(() =>
      readRevitToken(8080, { LOCALAPPDATA: "C:\\x" }, "win32", () => {
        throw new Error("ENOENT");
      })
    ).toThrow(/switch the MCP service on/);
  });

  it("rejects an empty token file", () => {
    expect(() => readRevitToken(8080, { LOCALAPPDATA: "C:\\x" }, "win32", () => "  \n")).toThrow(/empty/);
  });
});

describe("JSON-RPC request", () => {
  it("carries the session token as auth", () => {
    const client = new RevitClientConnection(REVIT_HOST, 1, "secret");
    expect(client.buildRequest("query_model", { a: 1 }, "7")).toEqual({
      jsonrpc: "2.0",
      method: "query_model",
      params: { a: 1 },
      id: "7",
      auth: "secret",
    });
    client.socket.destroy();
  });

  it("omits auth when no token is given", () => {
    const client = new RevitClientConnection(REVIT_HOST, 1);
    expect(client.buildRequest("x", {}, "1")).not.toHaveProperty("auth");
    client.socket.destroy();
  });
});

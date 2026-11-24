import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The Revit plugin only listens on IPv4 loopback. "localhost" may resolve to ::1 first. */
export const REVIT_HOST = "127.0.0.1";

type Env = Record<string, string | undefined>;

/**
 * Where the Revit plugin writes the per-session token:
 * %LOCALAPPDATA%\RevitMCP\token-<port> on Windows. REVIT_MCP_TOKEN_FILE overrides it.
 */
export function tokenFilePath(
  port: number,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.REVIT_MCP_TOKEN_FILE) return env.REVIT_MCP_TOKEN_FILE;
  const base =
    platform === "win32" && env.LOCALAPPDATA
      ? env.LOCALAPPDATA
      : join(homedir(), ".local", "share");
  return join(base, "RevitMCP", `token-${port}`);
}

/**
 * Read the token the Revit plugin issued when its MCP service started.
 * REVIT_MCP_TOKEN (if set) wins over the token file. Read on every connection,
 * because restarting the service in Revit issues a new token.
 */
export function readRevitToken(
  port: number,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8")
): string {
  const fromEnv = env.REVIT_MCP_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const path = tokenFilePath(port, env, platform);
  let token: string;
  try {
    token = readFile(path).trim();
  } catch {
    throw new Error(
      `Revit MCP session token not found at ${path}. Open Revit and switch the MCP service on (the plugin writes this file when the service starts).`
    );
  }
  if (!token) {
    throw new Error(`Revit MCP session token file is empty: ${path}`);
  }
  return token;
}

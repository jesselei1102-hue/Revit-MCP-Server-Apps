// Copy the Ultraviolet tokens from the theme repo into this app, or check that they still match.
//   npm run theme:sync -- "<path to the Design Theme repo>"
//   npm run theme:check -- "<path to the Design Theme repo>"
// The path can also come from the ULTRAVIOLET_THEME environment variable.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const check = process.argv.includes("--check");
const themeRepo = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.env.ULTRAVIOLET_THEME;
if (!themeRepo) {
  console.error("Pass the Design Theme repo path, or set ULTRAVIOLET_THEME.");
  process.exit(2);
}

const source = path.join(themeRepo, "template", "app", "theme", "tokens.css");
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp-app", "theme", "tokens.css");
if (!existsSync(source)) {
  console.error(`No tokens file at ${source}`);
  process.exit(2);
}

// Line endings differ between checkouts on Windows; compare and write with LF.
const theme = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
const app = existsSync(target) ? readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";

if (check) {
  if (theme === app) {
    console.log("Tokens match the Ultraviolet theme.");
  } else {
    console.error("Tokens differ from the Ultraviolet theme. Run npm run theme:sync, then rebuild.");
    process.exit(1);
  }
} else if (theme === app) {
  console.log("Tokens already match the Ultraviolet theme.");
} else {
  writeFileSync(target, theme);
  console.log(`Copied ${source}\n    -> ${target}\nRebuild the app (npm run build:app) to ship it.`);
}

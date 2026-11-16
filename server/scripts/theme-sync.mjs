// Copy the Ultraviolet tokens and bundled fonts from the theme repo into this app,
// or check that they still match.
//   npm run theme:sync -- "<path to the Design Theme repo>"
//   npm run theme:check -- "<path to the Design Theme repo>"
// The path can also come from the ULTRAVIOLET_THEME environment variable.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const check = process.argv.includes("--check");
const themeRepo = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.env.ULTRAVIOLET_THEME;
if (!themeRepo) {
  console.error("Pass the Design Theme repo path, or set ULTRAVIOLET_THEME.");
  process.exit(2);
}

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp-app", "theme");
const textFiles = ["tokens.css", "fonts.css"];
const binaryFiles = ["fonts/inter.woff2", "fonts/notosanssc.woff2"];

function readText(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

let drifted = false;
for (const rel of textFiles) {
  const source = path.join(themeRepo, "template", "app", "theme", rel);
  const target = path.join(here, rel);
  if (!existsSync(source)) {
    console.error(`No theme file at ${source}`);
    process.exit(2);
  }
  const theme = readText(source);
  const app = existsSync(target) ? readText(target) : "";
  if (theme === app) continue;
  drifted = true;
  if (check) {
    console.error(`${rel} differs from the Ultraviolet theme.`);
  } else {
    writeFileSync(target, theme);
    console.log(`Copied ${source}\n    -> ${target}`);
  }
}

for (const rel of binaryFiles) {
  const source = path.join(themeRepo, "template", "app", "theme", rel);
  const target = path.join(here, rel);
  if (!existsSync(source)) {
    console.error(`No theme file at ${source}`);
    process.exit(2);
  }
  const theme = readFileSync(source);
  const app = existsSync(target) ? readFileSync(target) : Buffer.alloc(0);
  if (theme.equals(app)) continue;
  drifted = true;
  if (check) {
    console.error(`${rel} differs from the Ultraviolet theme.`);
  } else {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, theme);
    console.log(`Copied ${source}\n    -> ${target}`);
  }
}

if (check && drifted) {
  console.error("Run npm run theme:sync, then rebuild.");
  process.exit(1);
}
if (!drifted) console.log("Theme files match the Ultraviolet theme.");
else console.log("Rebuild the app (npm run build:app) to ship it.");

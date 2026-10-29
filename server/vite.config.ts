import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * The MCP SDK pulls in Zod, and `zod/v4` re-exports every translation of its error messages
 * (about 140 kB, 40% of the app). The app only ever uses the English default that Zod installs
 * itself, so the locales index resolves to English alone.
 */
function zodEnglishOnly(): Plugin {
  const stub = "\0zod-locales-en";
  return {
    name: "zod-english-only",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../locales/index.js" && importer && /[\\/]zod[\\/]v4[\\/](core|classic)[\\/]/.test(importer)) {
        return stub;
      }
      return null;
    },
    load(id) {
      if (id !== stub) return null;
      const en = path.resolve("node_modules/zod/v4/locales/en.js").replaceAll("\\", "/");
      return `export { default as en } from ${JSON.stringify(en)};`;
    },
  };
}

export default defineConfig({
  root: "mcp-app",
  plugins: [zodEnglishOnly(), viteSingleFile()],
  build: {
    outDir: path.resolve("build/mcp-app"),
    emptyOutDir: true,
    cssMinify: true,
    minify: true,
    rollupOptions: {
      input: path.resolve("mcp-app/app.html"),
    },
  },
});

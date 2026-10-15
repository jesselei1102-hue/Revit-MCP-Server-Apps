import path from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  root: "mcp-app",
  plugins: [viteSingleFile()],
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

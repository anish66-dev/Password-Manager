import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      "@password-manager/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "src/content/index.ts"),
      name: "pm_content_script",
      formats: ["iife"],
      fileName: () => "content.js",
    },
  },
});

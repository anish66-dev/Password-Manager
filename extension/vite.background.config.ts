import { defineConfig } from "vite";
import path from "node:path";

/**
 * Localhost matching exists for testing against test-pages/ only. It is compiled in solely
 * by the dev-localhost build (vite --mode dev-localhost) and is off in the normal build.
 */
export default defineConfig(({ mode }) => ({
  define: {
    __ALLOW_LOCALHOST__: JSON.stringify(mode === "dev-localhost"),
  },
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
      entry: path.resolve(__dirname, "src/background/index.ts"),
      formats: ["es"],
      fileName: () => "background.js",
    },
  },
}));

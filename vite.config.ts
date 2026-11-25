import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    lib: {
      entry: {
        labkit: resolve(import.meta.dirname, "src/library.ts"),
        testing: resolve(import.meta.dirname, "src/testing.ts"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
      cssFileName: "labkit",
    },
  },
});

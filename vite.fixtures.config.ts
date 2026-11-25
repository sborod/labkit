import { resolve } from "node:path";
import { defineConfig } from "vite";

// SDK-owned browser fixtures only. HTML entries are compiled independently
// into .test-fixtures-dist and served by the local Playwright webServer.
export default defineConfig({
  base: "./",
  build: {
    outDir: ".test-fixtures-dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        "sdk-layout": resolve(import.meta.dirname, "tests/fixtures/browser/layout.html"),
        "sdk-controls": resolve(import.meta.dirname, "tests/fixtures/browser/controls.html"),
        "sdk-lifecycle": resolve(import.meta.dirname, "tests/fixtures/browser/lifecycle.html"),
        "sdk-pcm-offline": resolve(import.meta.dirname, "tests/fixtures/browser/pcm-offline.html"),
        "sdk-surface": resolve(import.meta.dirname, "tests/fixtures/browser/surface.html"),
      },
    },
  },
});

import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// SDK-owned browser suite: only local fixtures compiled from
// tests/fixtures/browser. Paths and the server stay inside this package.
export default defineConfig({
  testDir: resolve(import.meta.dirname, "tests/browser"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Keep the default run bounded; four browsers are enough for this suite.
  workers: 4,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4174/tests/fixtures/browser/",
    trace: "off",
  },
  webServer: {
    command:
      "npm run build:fixtures && vite preview --outDir .test-fixtures-dist --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174/tests/fixtures/browser/surface.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "browser",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

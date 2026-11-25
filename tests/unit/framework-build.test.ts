import { resolve } from "node:path";
import { expect, test } from "vitest";
import framework from "../../vite.config.ts";

test("framework has two public ESM library entries and named CSS", () => {
  expect(framework).toMatchObject({
    build: {
      outDir: "dist",
      target: "es2022",
      lib: {
        entry: {
          labkit: resolve(import.meta.dirname, "../../src/library.ts"),
          testing: resolve(import.meta.dirname, "../../src/testing.ts"),
        },
        formats: ["es"],
        cssFileName: "labkit",
      },
    },
  });

  const lib = framework.build?.lib;
  if (!lib) throw new Error("framework build.lib is not configured");
  expect(lib.fileName).toBeTypeOf("function");
  const fileName = lib.fileName as (format: string, entryName: string) => string;
  expect(fileName("es", "labkit")).toBe("labkit.js");
  expect(fileName("es", "testing")).toBe("testing.js");

  expect(framework).not.toHaveProperty("plugins");
  expect(framework).not.toHaveProperty("build.rollupOptions.input");
});

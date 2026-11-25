// Package-level checks for the SDK's own ESM exports. These tests use the
// package self-reference ("labkit") and direct dist imports inside this SDK,
// not an external consumer project, copied package or tarball installation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

test("package metadata is ESM-only and self-reference matches direct dist imports", async () => {
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.types, "./dist/types/index.d.ts");
  assert.equal(packageJson.main, "./dist/labkit.js");
  assert.equal(packageJson.module, "./dist/labkit.js");

  const rootExport = packageJson.exports["."];
  assert.deepEqual(rootExport, {
    types: "./dist/types/index.d.ts",
    import: "./dist/labkit.js",
  });
  assert.equal(rootExport.require, undefined);
  assert.equal(rootExport.default, undefined);

  const testingExport = packageJson.exports["./testing"];
  assert.deepEqual(testingExport, {
    types: "./dist/types/testing.d.ts",
    import: "./dist/testing.js",
  });
  assert.equal(testingExport.require, undefined);
  assert.equal(testingExport.default, undefined);

  for (const [subpath, target] of Object.entries(packageJson.exports)) {
    if (typeof target === "string") continue;
    assert.deepEqual(
      Object.keys(target).sort(),
      ["import", "types"],
      `${subpath} must expose only ESM import and type conditions`,
    );
  }

  const distRoot = await import(pathToFileURL(resolve(packageRoot, "dist/labkit.js")).href);
  const selfRoot = await import("labkit");
  const distTesting = await import(pathToFileURL(resolve(packageRoot, "dist/testing.js")).href);
  const selfTesting = await import("labkit/testing");

  const rootKeys = Object.keys(distRoot).sort();
  const testingKeys = Object.keys(distTesting).sort();
  assert.deepEqual(rootKeys, Object.keys(selfRoot).sort());
  assert.deepEqual(testingKeys, Object.keys(selfTesting).sort());

  for (const key of rootKeys) {
    assert.equal(selfRoot[key], distRoot[key], `labkit export ${key} differs`);
  }
  for (const key of testingKeys) {
    assert.equal(selfTesting[key], distTesting[key], `labkit/testing export ${key} differs`);
  }
});

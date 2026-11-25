// Stylesheet and emit-boundary checks. The stylesheet is a separately exported
// artifact and must not leak into the JS entry or into declaration files.
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

function moduleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

test("CSS export is separate, non-empty and free of declarations or JS imports", async () => {
  assert.equal(packageJson.exports["./labkit.css"], "./dist/labkit.css");
  assert.deepEqual(packageJson.sideEffects, ["**/*.css"]);

  const cssPath = resolve(packageRoot, "dist/labkit.css");
  const css = await readFile(cssPath, "utf8");
  assert.ok((await stat(cssPath)).size > 0, "dist/labkit.css must not be empty");
  assert.match(css, /\.labkit\b/, "stylesheet must contain the LabKit rules");

  const declarations = (await filesUnder(resolve(packageRoot, "dist/types"))).filter((path) =>
    path.endsWith(".d.ts"),
  );
  assert.ok(declarations.length > 0, "declaration tree must not be empty");
  for (const path of declarations) {
    const source = await readFile(path, "utf8");
    assert.ok(
      !source.includes(".css"),
      `${relative(packageRoot, path).split(sep).join("/")} imports CSS`,
    );
  }

  for (const entry of ["dist/labkit.js", "dist/testing.js"]) {
    const source = await readFile(resolve(packageRoot, entry), "utf8");
    assert.ok(!source.includes(".labkit-segmented"), `${entry} inlines CSS rules`);

    const forbidden = moduleSpecifiers(source).filter((specifier) => {
      if (specifier.endsWith(".css")) return true;
      if (/\.(?:[cm]?ts|tsx)$/.test(specifier)) return true;
      if (specifier.startsWith("node:")) return true;
      return (
        !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("data:")
      );
    });
    assert.deepEqual(forbidden, [], `${entry} must not import CSS, source TS or Node dependencies`);
  }
});

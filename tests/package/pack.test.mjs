// Packed-artifact whitelist check. Uses npm pack --dry-run in the current SDK
// only: it creates no tarball, installs nothing and inspects no external project.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

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

test("npm pack dry-run contains only the built dist whitelist", async () => {
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const raw = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const reports = JSON.parse(raw);
  assert.equal(reports.length, 1);
  const [report] = reports;
  assert.equal(report.name, packageJson.name);
  assert.equal(report.version, packageJson.version);

  const packed = report.files.map((file) => file.path).sort();
  const packedSet = new Set(packed);
  assert.ok(packed.every((path) => report.files.find((file) => file.path === path).size > 0));

  const allowed = (path) =>
    path === "package.json" ||
    path === "README.md" ||
    /^LICENSE(?:\.(?:md|txt))?$/.test(path) ||
    path.startsWith("dist/");
  assert.deepEqual(
    packed.filter((path) => !allowed(path)),
    [],
    "packed files must match dist/**, package.json, README.md and optional LICENSE",
  );

  const forbidden = /(^|\/)(src|tests|legacy|tmp|test-results|node_modules)\//;
  assert.deepEqual(
    packed.filter(
      (path) =>
        forbidden.test(path) ||
        path === "package-lock.json" ||
        path.endsWith(".tgz") ||
        (path.endsWith(".ts") && !path.endsWith(".d.ts")),
    ),
    [],
    "packed artifact must not include source, tests, legacy, locks or tarballs",
  );

  const distOnDisk = (await filesUnder(resolve(packageRoot, "dist")))
    .map((path) => relative(packageRoot, path).split(sep).join("/"))
    .sort();
  assert.deepEqual(
    packed.filter((path) => path.startsWith("dist/")),
    distOnDisk,
    "packed dist must match the complete built dist tree",
  );

  for (const required of [
    "dist/labkit.js",
    "dist/testing.js",
    "dist/labkit.css",
    "dist/types/index.d.ts",
    "dist/types/testing.d.ts",
  ]) {
    assert.ok(packedSet.has(required), `packed artifact is missing ${required}`);
  }
});

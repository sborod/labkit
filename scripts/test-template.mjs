import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: node scripts/test-template.mjs /path/to/labkit.tgz");
const sdk = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "labkit-template-"));
const root = join(temp, "lab");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const write = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n");
const run = (args) =>
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: root,
    stdio: "inherit",
  });
try {
  await cp(join(sdk, "templates/lab-template"), root, {
    recursive: true,
    filter: (path) => !["node_modules", "dist", ".git"].includes(path.split(/[\\/]/).at(-1)),
  });
  const pkgPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const pkg = await json(pkgPath);
  const lock = await json(lockPath);
  const pin = pkg.dependencies.labkit;
  assert.equal(lock.packages[""].dependencies.labkit, pin);
  const match =
    /^git\+https:\/\/github\.com\/sborod\/labkit\.git#(v\d+\.\d+\.\d+|[a-f0-9]{40})$/.exec(pin);
  assert.ok(match, "template must use a fixed public tag or commit");
  const sha = execFileSync("git", ["rev-parse", match[1] + "^{commit}"], {
    cwd: sdk,
    encoding: "utf8",
  }).trim();
  assert.equal(lock.packages["node_modules/labkit"].resolved, pin.split("#")[0] + "#" + sha);

  // Test the current candidate, without mutating the template.
  const sdkPkg = await json(join(sdk, "package.json"));
  const local = "file:" + resolve(archive);
  pkg.dependencies.labkit = local;
  lock.packages[""].dependencies.labkit = local;
  lock.packages["node_modules/labkit"] = {
    version: sdkPkg.version,
    resolved: local,
    engines: sdkPkg.engines,
  };
  await write(pkgPath, pkg);
  await write(lockPath, lock);
  run(["ci", "--no-audit", "--no-fund"]);
  run(["run", "verify"]);
  console.log("Lab template passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}

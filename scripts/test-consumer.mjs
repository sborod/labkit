import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const git = process.argv[2] === "--git";
const specifier = process.argv[git ? 3 : 2];
if (!specifier) {
  throw new Error("Usage: npm run test:consumer -- /path/to/labkit.tgz | --git git+file://...");
}
const sdk = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "labkit-consumer-"));
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
try {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "labkit-consumer",
      private: true,
      type: "module",
    }),
  );
  run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "install",
    ...(git ? [] : ["--ignore-scripts", "--offline"]),
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    git ? specifier : resolve(specifier),
  ]);
  await writeFile(
    join(root, "smoke.mjs"),
    `
    import assert from "node:assert/strict";
    import { createLab, CONTRACT_VERSION } from "labkit";
    import { FakeScheduler } from "labkit/testing";
    assert.equal(typeof createLab, "function");
    assert.equal(typeof CONTRACT_VERSION, "string");
    assert.equal(typeof FakeScheduler, "function");
    await assert.rejects(import("labkit/src/index.ts"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  `,
  );
  run(process.execPath, ["smoke.mjs"]);
  for (const file of ["types-consumer.mts", "tsconfig.bundler.json", "tsconfig.nodenext.json"]) {
    await copyFile(join(sdk, "tests/package", file), join(root, file));
  }
  for (const mode of ["bundler", "nodenext"]) {
    run(process.execPath, [
      join(sdk, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig." + mode + ".json",
    ]);
  }
  await writeFile(
    join(root, "index.html"),
    '<div id="app"></div><script type="module" src="/main.ts"></script>',
  );
  await writeFile(
    join(root, "main.ts"),
    `
    import { createLab, CONTRACT_VERSION } from "labkit";
    import "labkit/labkit.css";
    createLab({
      contractVersion: CONTRACT_VERSION, id: "consumer", title: "Consumer",
      model: { createState: () => ({ level: 0 }) },
      parameters: {}, layout: { controls: [], workspace: [] },
    }, document.querySelector("#app")!);
  `,
  );
  await build({ root, configFile: false, base: "./", build: { target: "es2022" } });
  const assets = await readdir(join(root, "dist/assets"));
  assert.ok(
    assets.some((file) => file.endsWith(".js")),
    "missing bundled JavaScript",
  );
  const css = assets.find((file) => file.endsWith(".css"));
  assert.ok(css, "missing bundled CSS");
  assert.match(await readFile(join(root, "dist/assets", css), "utf8"), /\.labkit\b/);
  console.log(git ? "Git consumer passed" : "Packed consumer passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

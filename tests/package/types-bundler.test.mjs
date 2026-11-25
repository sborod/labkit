// Static typecheck with bundler resolution against the SDK's package exports.
// The fixture is a self-reference inside this package, not an external consumer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const configPath = fileURLToPath(new URL("./tsconfig.bundler.json", import.meta.url));

test("static self-reference types pass with Bundler resolution", () => {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const options = config.compilerOptions;
  assert.equal(config.extends, undefined);
  assert.deepEqual(config.include, ["types-consumer.mts"]);
  assert.deepEqual(options.types, []);
  assert.equal(options.strict, true);
  assert.equal(options.skipLibCheck, false);
  assert.equal(options.noUncheckedSideEffectImports, true);
  assert.equal(options.noEmit, true);
  assert.equal(options.module, "ESNext");
  assert.equal(options.moduleResolution, "Bundler");
  assert.equal(options.paths, undefined);
  assert.equal(options.baseUrl, undefined);
  assert.notEqual(options.allowImportingTsExtensions, true);

  const result = spawnSync(
    process.execPath,
    [
      resolve(packageRoot, "node_modules/typescript/bin/tsc"),
      "--pretty",
      "false",
      "-p",
      configPath,
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `tsc (Bundler) failed:\n${result.stdout}${result.stderr}`);
});

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "**/.test-fixtures-dist/**",
    "**/release/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["**/*.{ts,mts,cts}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

import { defineConfig } from "vitest/config";

// SDK unit-тесты: только чистые модули SDK. Конфигурация не знает ни одной
// лаборатории; jsdom включается точечно через @vitest-environment в самих тестах.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/unit/setup.ts"],
    globals: false,
    maxWorkers: 4,
  },
});

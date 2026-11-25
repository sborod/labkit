import { expect, test, type Page } from "@playwright/test";

// Политика поверхности: растр масштабируется по DPR (с ограничением), логические
// координаты остаются CSS; вычислительная сетка не зависит от размера панели.
// resize/DPR обязаны перерисовать поверхность даже на паузе.

test.use({ deviceScaleFactor: 2, viewport: { width: 1000, height: 800 } });

async function paintedPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) return -1;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) count += 1;
    }
    return count;
  });
}

test("canvas масштабируется по DPR (devicePixelRatio = 2)", async ({ page }) => {
  await page.goto("surface.html");
  await expect(page.locator("canvas")).toHaveCount(1);
  const info = await page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return { dpr: window.devicePixelRatio, width: canvas.width, css: rect.width };
  });
  expect(info.dpr).toBe(2);
  expect(Math.abs(info.width - Math.round(info.css * 2))).toBeLessThanOrEqual(1);
});

test("resize обновляет растровое разрешение под новый CSS-размер", async ({ page }) => {
  await page.goto("surface.html");
  const before = await page.evaluate(
    () => (document.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect().width,
  );
  await page.setViewportSize({ width: 700, height: 800 });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return {
      css: rect.width,
      width: canvas.width,
      dpr: window.devicePixelRatio,
    };
  });
  expect(after.css).not.toBe(before);
  expect(Math.abs(after.width - Math.round(after.css * after.dpr))).toBeLessThanOrEqual(1);
});

test("resize на паузе перерисовывает поверхность (непустой растр)", async ({ page }) => {
  await page.goto("surface.html");
  await expect(page.locator("canvas")).toHaveCount(1);
  // Дать первичной отрисовке осесть (таймлайн не запущен).
  await page.waitForTimeout(100);
  expect(await paintedPixels(page)).toBeGreaterThan(0);

  // Регрессия: без инвалидации на resize растр остаётся пустым (bitmap обнулён).
  await page.setViewportSize({ width: 640, height: 760 });
  await page.waitForTimeout(150);
  expect(await paintedPixels(page)).toBeGreaterThan(0);
});

test("поверхность перерисовывается в контексте с другим DPR", async ({ browser }) => {
  // Runtime-смена DPR отслеживается через matchMedia (см. unit-тест surface);
  // здесь проверяем, что при другом DPR растр тоже непустой.
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { width: 900, height: 700 },
  });
  const page = await context.newPage();
  await page.goto("surface.html");
  await expect(page.locator("canvas")).toHaveCount(1);
  await page.waitForTimeout(100);
  expect(await paintedPixels(page)).toBeGreaterThan(0);
  await context.close();
});

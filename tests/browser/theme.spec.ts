import { expect, test, type Page } from "@playwright/test";

// Тема каркаса на прямом SDK-fixture: системная тёмная тема даёт тёмный каркас,
// клик переключает на светлую и сохраняет выбор, reload его восстанавливает.
// Canvas не темизируется и остаётся белым.

const FIXTURE = "lifecycle.html";

test("тема каркаса: система → сохранённый выбор → reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(FIXTURE);

  const html = page.locator("html");
  const toggle = page.locator(".labkit-theme-toggle");
  await expect(html).toHaveAttribute("data-labkit-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await expect(page.locator(".labkit")).toHaveCSS("color", "rgb(230, 232, 238)");
  await expect(page.locator("canvas.labkit-surface")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );

  await toggle.click();
  await expect(html).toHaveAttribute("data-labkit-theme", "light");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => localStorage.getItem("labkit.theme.v1"))).toBe("light");

  await page.reload();
  await expect(html).toHaveAttribute("data-labkit-theme", "light");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

const FIXTURE_BLUE = [55, 98, 216, 255] as const;

function readCenterPixel(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.labkit-surface");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("lifecycle surface is missing");
    return Array.from(
      ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
    );
  });
}

function clearSurface(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.labkit-surface");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("lifecycle surface is missing");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return Array.from(
      ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
    );
  });
}

test("тема: canvas view перерисовывается на паузе и сохраняет свою палитру", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(FIXTURE);
  await expect(page.locator("canvas.labkit-surface")).toBeVisible();
  // Дать исходным resize/DPR-инвалидациям поверхности завершиться до baseline.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  expect(await readCenterPixel(page)).toEqual([...FIXTURE_BLUE]);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __lifecycleFixture: { instance: { timeline: { isRunning: boolean } } };
          }
        ).__lifecycleFixture.instance.timeline.isRunning,
    ),
  ).toBe(false);

  // Стереть растр: возврат синего докажет реальный render, а не CSS/атрибут.
  expect((await clearSurface(page))[3]).toBe(0);

  await page.locator(".labkit-theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-labkit-theme", "dark");
  await expect.poll(() => readCenterPixel(page)).toEqual([...FIXTURE_BLUE]);

  // Внешняя attribute mutation без кнопки — тот же runtime-путь.
  expect((await clearSurface(page))[3]).toBe(0);
  await page.evaluate(() => {
    const html = document.documentElement;
    const current = html.getAttribute("data-labkit-theme");
    html.setAttribute("data-labkit-theme", current === "dark" ? "light" : "dark");
  });
  await expect.poll(() => readCenterPixel(page)).toEqual([...FIXTURE_BLUE]);
});

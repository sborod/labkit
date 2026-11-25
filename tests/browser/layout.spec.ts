import { expect, test, type Locator } from "@playwright/test";

const FIXTURE = "layout.html";

test("nested rows retain their own default column count", async ({ page }) => {
  await page.goto(FIXTURE);
  const innerRow = page.locator(".labkit-workspace .labkit-row .labkit-row");
  const outerRow = innerRow.locator("..");
  const columns = (el: Element) => getComputedStyle(el).gridTemplateColumns.split(" ").length;
  expect(await outerRow.evaluate(columns)).toBe(3);
  expect(await innerRow.evaluate(columns)).toBe(2);
});

test("disclosure is keyboard accessible, preserves DOM and repaints a paused canvas", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const scope = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Scope$/ }) });
  const canvas = scope.locator("canvas");
  await expect(canvas).toBeHidden();
  await canvas.evaluate((el) => {
    el.dataset.identity = "original";
  });
  const summary = scope.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        return c.width > 100 && c.getContext("2d")!.getImageData(20, 20, 1, 1).data[2] === 144;
      }),
    )
    .toBe(true);
  await summary.press("Space");
  await expect(canvas).toBeHidden();
  await summary.press("Enter");
  await expect(canvas).toHaveAttribute("data-identity", "original");
});

test("information window is nonmodal, navigates sections and restores focus", async ({ page }) => {
  await page.goto(FIXTURE);
  const trigger = page.getByRole("button", { name: "О лаборатории", exact: true });
  const info = page.locator(".labkit-information-window");
  await expect(info).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(info).toHaveAttribute("role", "dialog");
  await expect(info).toHaveAttribute("aria-modal", "false");
  await expect(info).toHaveAttribute("aria-label", "О лаборатории");
  expect(await trigger.getAttribute("aria-controls")).toBe(await info.getAttribute("id"));

  await trigger.click();
  await expect(info).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(info.getByRole("heading", { name: "О лаборатории" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Закрыть: О лаборатории" })).toBeFocused();

  // Немодальность — не только атрибут: фокус можно увести наружу без закрытия.
  const outside = page.locator(".labkit-workspace [role='slider']").first();
  await outside.focus();
  await expect(outside).toBeFocused();
  await expect(info).toBeVisible();

  const nav = info.locator(".labkit-information-nav");
  // className-обёртки вокруг прямых групп не меняют навигацию; вложенные и
  // неозаглавленные группы в неё не попадают.
  await expect(nav.getByRole("button")).toHaveText(["Настройки", "Прямая секция", "График"]);
  await expect(nav.getByRole("button", { name: "Вложенная группа", exact: true })).toHaveCount(0);
  const sectionFor = (name: string): Locator =>
    info.getByRole("heading", { name, exact: true }).locator("..");
  const geometry = (section: Locator): Promise<{ scrollTop: number; offset: number }> =>
    section.evaluate((el) => {
      const bodyEl = el.closest(".labkit-information-body") as HTMLElement;
      const bodyRect = bodyEl.getBoundingClientRect();
      return {
        scrollTop: bodyEl.scrollTop,
        offset: el.getBoundingClientRect().top - bodyRect.top - bodyEl.clientTop,
      };
    });
  const expectAligned = async (
    section: Locator,
    name: string,
  ): Promise<{ scrollTop: number; offset: number }> => {
    const result = await geometry(section);
    expect(
      Math.abs(result.offset),
      `${name} должны быть выровнены по верху body`,
    ).toBeLessThanOrEqual(2);
    expect(result.scrollTop).toBeGreaterThan(0);
    await expect(info.getByRole("heading", { name, exact: true })).toBeFocused();
    return result;
  };
  const clickNav = async (name: string): Promise<void> => {
    const before = await page.evaluate(() => window.scrollY);
    await nav.getByRole("button", { name, exact: true }).click();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  };

  await page.evaluate(() => window.scrollTo(0, 120));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // Вперёд к обёрнутой position:relative секции: scrollTop должен считаться
  // от body, а не от offsetParent обёртки.
  await clickNav("График");
  const forward = await expectAligned(sectionFor("График"), "График");

  // Назад: секция до неё, уже из ненулевого scroll.
  await clickNav("Настройки");
  const backward = await expectAligned(sectionFor("Настройки"), "Настройки");
  expect(backward.scrollTop).toBeLessThan(forward.scrollTop);

  // Прямая секция без className: формула эквивалентна прежнему offsetTop.
  await clickNav("Прямая секция");
  const direct = await expectAligned(sectionFor("Прямая секция"), "Прямая секция");
  expect(direct.scrollTop).toBeGreaterThan(backward.scrollTop);

  // Повторная навигация к обёрнутой секции из ненулевого scroll.
  await clickNav("График");
  await expectAligned(sectionFor("График"), "График");
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.getByRole("button", { name: "Закрыть: О лаборатории" }).click();
  await expect(info).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(info).toBeVisible();
  await info.locator('[data-param="p0"]').focus();
  await page.keyboard.press("Escape");
  await expect(info).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
});

test("information window keeps control DOM and scroll, repaints hidden canvas on open", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const trigger = page.getByRole("button", { name: "О лаборатории", exact: true });
  const info = page.locator(".labkit-information-window");
  const canvas = info.locator("canvas");
  await expect(canvas).toBeHidden();
  await expect.poll(() => canvas.evaluate((el) => (el as HTMLCanvasElement).width)).toBe(1);

  await trigger.click();
  await expect(info).toBeVisible();
  const painted = () =>
    canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return c.width > 100 && c.getContext("2d")!.getImageData(20, 20, 1, 1).data[2] === 144;
    });
  await expect.poll(painted).toBe(true);

  const control = info.locator('[data-param="p0"]');
  await control.evaluate((el) => {
    el.dataset.identity = "original";
  });
  const body = info.locator(".labkit-information-body");
  const scroll = await body.evaluate((el) => {
    el.scrollTop = 140;
    return el.scrollTop;
  });
  expect(scroll).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Закрыть: О лаборатории" }).click();
  await expect(info).toBeHidden();
  // Скрытый canvas не перерисовывается сам; очищаем пиксель, чтобы открытие
  // доказало именно повторную отрисовку, а не сохранённый кадр.
  await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
  });

  await trigger.click();
  await expect(info).toBeVisible();
  await expect(control).toHaveAttribute("data-identity", "original");
  expect(await body.evaluate((el) => el.scrollTop)).toBe(scroll);
  await expect.poll(painted).toBe(true);
});

for (const width of [1280, 390]) {
  test(`instrument layout and transport remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(FIXTURE);
    const cards = page.locator(".labkit-controls > .labkit-card");
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    if (width > 800) expect(first!.y).toBe(second!.y);
    else expect(second!.y).toBeGreaterThan(first!.y + first!.height);
    const parameterRow = page.locator(".labkit-controls .labkit-row");
    const columns = await parameterRow.evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
    expect(columns).toBeGreaterThan(2);
    await expect(page.locator(".labkit-control-accessory").first()).toBeHidden();
    await expect(page.getByRole("button", { name: "Unavailable" })).toBeDisabled();
    const toolbar = page.getByRole("region", { name: "Транспорт и управление" });
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect
      .poll(() => toolbar.evaluate((el) => Math.round(el.getBoundingClientRect().top)))
      .toBe(0);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    const buttons = await toolbar
      .locator("button")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    expect(new Set(buttons).size).toBe(1);
    const transportRow = await toolbar.locator(".labkit-row").boundingBox();
    const transportStatus = await toolbar.locator(".labkit-readout").boundingBox();
    if (width < 800)
      expect(transportStatus!.y).toBeGreaterThanOrEqual(transportRow!.y + transportRow!.height);
    else expect(transportStatus!.y).toBeLessThan(transportRow!.y + transportRow!.height);
    const target = page.locator('.labkit-workspace [role="slider"]').nth(3);
    await target.focus();
    const bounds = await target.boundingBox();
    const bar = await toolbar.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
    const colorBefore = await cards.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.getByRole("button", { name: "Тёмная тема" }).click();
    const colorAfter = await cards.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(colorAfter).not.toBe(colorBefore);
    const theme = await page.locator("html").getAttribute("data-labkit-theme");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-labkit-theme", theme!);
  });
}

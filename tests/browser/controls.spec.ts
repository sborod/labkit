import { expect, test } from "@playwright/test";

const FIXTURE = "controls.html";

test("pad and segmented keep their accessible names while showing displayLabel", async ({
  page,
}) => {
  await page.goto(FIXTURE);

  // Обычный checkbox сохраняет свой оптический scale; pad — отдельный native
  // checkbox, который не должен наследовать это масштабирование.
  const enabled = page.getByRole("checkbox", { name: "Разрешить действие", exact: true });
  expect(await enabled.evaluate((el) => getComputedStyle(el).transform)).toBe(
    "matrix(1.1, 0, 0, 1.1, 0, 0)",
  );
  await enabled.focus();
  await page.keyboard.press("Space");
  await expect(enabled).toBeChecked();
  expect(await page.evaluate(() => window.__controlsFixture.instance.state.enabled)).toBe(true);

  const pad = page.locator(".labkit-pad");
  const input = pad.locator('input[type="checkbox"]');

  // displayLabel — только видимая подпись; доступное имя остаётся label.
  await expect(pad.locator(".labkit-control-main > span")).toHaveText("S");
  await expect(input).toHaveAttribute("aria-label", "Соло");
  await expect(page.getByRole("checkbox", { name: "Соло", exact: true })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "S", exact: true })).toHaveCount(0);
  await expect(pad.locator("[data-param]")).toHaveCount(1);

  // Pad остаётся native checkbox: Space переключает, checked идёт из реестра.
  await input.focus();
  await page.keyboard.press("Space");
  await expect(input).toBeChecked();
  expect(await page.evaluate(() => window.__controlsFixture.instance.state.solo)).toBe(true);
  await page.evaluate(() => window.__controlsFixture.instance.params.set("solo", false, "api"));
  await expect(input).not.toBeChecked();
  await page.evaluate(() => window.__controlsFixture.instance.params.set("solo", true, "api"));
  await expect(input).toBeChecked();

  const segmented = page.locator(".labkit-segmented");
  const group = segmented.getByRole("group", { name: "Монитор", exact: true });
  await expect(segmented.locator(".labkit-field-label")).toHaveText("M");
  await expect(group).toBeVisible();
  const buttons = group.getByRole("button");
  await expect(buttons).toHaveCount(3);
  await expect(group.getByRole("button", { name: "L", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Клик меняет каноническое значение и aria-pressed всех кнопок.
  await group.getByRole("button", { name: "M", exact: true }).click();
  await expect(group.getByRole("button", { name: "M", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(group.getByRole("button", { name: "L", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(await page.evaluate(() => window.__controlsFixture.instance.state.monitor)).toBe("m");

  // Клавиатура на native button работает так же, как клик.
  const high = group.getByRole("button", { name: "H", exact: true });
  await high.focus();
  await page.keyboard.press("Enter");
  await expect(high).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.__controlsFixture.instance.state.monitor)).toBe("h");
  await group.getByRole("button", { name: "L", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(group.getByRole("button", { name: "L", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.evaluate(() => window.__controlsFixture.instance.state.monitor)).toBe("l");
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 1280]) {
    test(`pad keeps its declared 32px geometry and native focus/disabled behavior: ${theme} ${width}px`, async ({
      page,
    }) => {
      await page.addInitScript(
        (value: string) => localStorage.setItem("labkit.theme.v1", value),
        theme,
      );
      await page.setViewportSize({ width, height: 720 });
      await page.goto(FIXTURE);
      await expect(page.locator("html")).toHaveAttribute("data-labkit-theme", theme);

      const input = page.locator('.labkit-pad input[type="checkbox"]');
      const geometry = () =>
        input.evaluate((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            transform: style.transform,
            outlineStyle: style.outlineStyle,
            outlineWidth: Number.parseFloat(style.outlineWidth),
            backgroundColor: style.backgroundColor,
            declaredWidth: Number.parseFloat(style.width),
            declaredHeight: Number.parseFloat(style.height),
            width: rect.width,
            height: rect.height,
          };
        });

      const idle = await geometry();
      expect(idle.declaredWidth).toBe(32);
      expect(idle.declaredHeight).toBe(32);
      expect(idle.width).toBeCloseTo(idle.declaredWidth, 1);
      expect(idle.height).toBeCloseTo(idle.declaredHeight, 1);
      expect(
        idle.transform === "none" || idle.transform === "matrix(1, 0, 0, 1, 0, 0)",
        `pad must not inherit checkbox scale, got ${idle.transform}`,
      ).toBe(true);
      expect(idle.backgroundColor).toBe("rgba(0, 0, 0, 0)");

      // Активное состояние остаётся визуальным состоянием того же native input.
      await input.click();
      await expect(input).toBeChecked();
      expect(await page.evaluate(() => window.__controlsFixture.instance.state.solo)).toBe(true);
      const active = await geometry();
      expect(active.backgroundColor).not.toBe(idle.backgroundColor);
      expect(active.width).toBeCloseTo(active.declaredWidth, 1);

      // Keyboard Space переключает, а keyboard focus даёт focus-visible outline.
      await page.keyboard.press("Space");
      await expect(input).not.toBeChecked();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(input).toBeFocused();
      const focused = await geometry();
      expect(focused.outlineStyle).not.toBe("none");
      expect(focused.outlineWidth).toBeGreaterThan(0);

      // Disabled — штатное native-состояние, геометрия не меняется.
      const allow = page.getByRole("checkbox", { name: "Разрешить соло", exact: true });
      await allow.uncheck();
      await expect(input).toBeDisabled();
      const disabled = await geometry();
      expect(disabled.transform).toBe(idle.transform);
      expect(disabled.width).toBeCloseTo(disabled.declaredWidth, 1);
      await allow.check();
      await expect(input).toBeEnabled();
    });
  }
}

test("plain enum is a row layout item while standalone fields keep spacing", async ({ page }) => {
  await page.goto(FIXTURE);

  // Plain enum в ряду — такой же layout-item, как knob/pad: собственный
  // margin-top .labkit-field не должен сдвигать его вниз.
  const enumRow = page
    .locator(".labkit-controls .labkit-card")
    .filter({ hasText: "Поле в ряду" })
    .locator(".labkit-row");
  const enumField = enumRow
    .locator(".labkit-field")
    .filter({ has: page.locator('[data-param="phase"]') });
  await expect(enumField).toHaveCount(1);
  expect(await enumField.evaluate((el) => getComputedStyle(el).marginTop)).toBe("0px");
  const rowTop = (await enumRow.boundingBox())!.y;
  const enumTop = (await enumField.boundingBox())!.y;
  expect(Math.abs(enumTop - rowTop)).toBeLessThan(0.5);

  // Вне ряда вертикальный отступ поля сохраняется: mode находится прямо в
  // .labkit-controls и не подпадает под .labkit-card-body > :first-child.
  const standalone = page.locator('[data-param="mode"]').locator("..");
  expect(await standalone.evaluate((el) => getComputedStyle(el).marginTop)).toBe("12px");
});

test("pad and segmented follow available/visible and restore", async ({ page }) => {
  await page.goto(FIXTURE);
  const pad = page.locator(".labkit-pad");
  const segmented = page.locator(".labkit-segmented");
  const padInput = pad.locator("input");
  const allowPad = page.getByRole("checkbox", { name: "Разрешить соло", exact: true });
  const showPad = page.getByRole("checkbox", { name: "Показывать соло", exact: true });
  const allowSegmented = page.getByRole("checkbox", { name: "Разрешить монитор", exact: true });
  const showSegmented = page.getByRole("checkbox", { name: "Показывать монитор", exact: true });

  await expect(pad).toBeVisible();
  await expect(padInput).toBeEnabled();
  await expect(segmented).toBeVisible();
  await expect(segmented.locator("button").first()).toBeEnabled();

  await allowPad.uncheck();
  await expect(padInput).toBeDisabled();
  expect(await page.evaluate(() => window.__controlsFixture.instance.state.soloAllowed)).toBe(
    false,
  );
  await allowPad.check();
  await expect(padInput).toBeEnabled();

  await showPad.uncheck();
  await expect(pad).toBeHidden();
  await showPad.check();
  await expect(pad).toBeVisible();

  await allowSegmented.uncheck();
  await expect(segmented.locator("button").first()).toBeDisabled();
  await expect(segmented.locator("button").last()).toBeDisabled();
  await allowSegmented.check();
  await expect(segmented.locator("button").first()).toBeEnabled();

  await showSegmented.uncheck();
  await expect(segmented).toBeHidden();
  await showSegmented.check();
  await expect(segmented).toBeVisible();

  // После восстановления контролы снова работают штатно.
  await padInput.click();
  await expect(padInput).toBeChecked();
  await segmented.getByRole("button", { name: "H", exact: true }).click();
  expect(await page.evaluate(() => window.__controlsFixture.instance.state.monitor)).toBe("h");
});

test("className wrapper releases and restores its grid/flex cell when visibility changes", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const gridCell = page.locator(".classed-grid-cell");
  const flexCell = page.locator(".classed-flex-cell");
  const toggle = page.getByRole("checkbox", { name: "Показывать классовые", exact: true });
  const gridRow = gridCell.locator("..");
  const flexRow = flexCell.locator("..");

  const metrics = async () => ({
    gridDisplay: await gridRow.evaluate((el) => getComputedStyle(el).display),
    flexDisplay: await flexRow.evaluate((el) => getComputedStyle(el).display),
    gridRow: await gridRow.boundingBox(),
    flexRow: await flexRow.boundingBox(),
    gridCell: await gridCell.boundingBox(),
    flexCell: await flexCell.boundingBox(),
    gridSibling: await page.locator(".classed-grid-sibling").boundingBox(),
    flexSibling: await page.locator(".classed-flex-sibling").boundingBox(),
  });

  await expect(toggle).toBeChecked();
  await expect(gridCell.locator(".labkit-control")).toHaveCount(1);
  await expect(flexCell.locator(".labkit-control")).toHaveCount(1);
  const shown = await metrics();
  expect(shown.gridDisplay).toBe("grid");
  expect(shown.flexDisplay).toBe("flex");
  expect(shown.gridCell!.width).toBeGreaterThan(0);
  expect(shown.flexCell!.width).toBeGreaterThan(0);
  expect(shown.gridSibling!.x).toBeGreaterThan(shown.gridCell!.x + shown.gridCell!.width * 0.5);
  expect(shown.flexSibling!.x).toBeGreaterThan(shown.flexCell!.x + shown.flexCell!.width * 0.5);

  await gridCell.evaluate((el) => {
    (el as HTMLElement).dataset.identity = "kept";
  });
  await flexCell.evaluate((el) => {
    (el as HTMLElement).dataset.identity = "kept";
  });

  // UI-путь: registry event синхронно скрывает внешнюю обёртку.
  await toggle.uncheck();
  await expect(gridCell).toBeHidden();
  await expect(flexCell).toBeHidden();
  expect(await gridCell.evaluate((el) => getComputedStyle(el).display)).toBe("none");
  expect(await flexCell.evaluate((el) => getComputedStyle(el).display)).toBe("none");
  const hidden = await metrics();
  expect(hidden.gridCell).toBeNull();
  expect(hidden.flexCell).toBeNull();
  expect(Math.abs(hidden.gridSibling!.x - hidden.gridRow!.x)).toBeLessThan(1);
  expect(Math.abs(hidden.flexSibling!.x - hidden.flexRow!.x)).toBeLessThan(1);

  // Явная отрисовка без события registry возвращает ячейку.
  await page.evaluate(() => {
    const instance = window.__controlsFixture.instance;
    instance.state.classShown = true;
    instance.render();
  });
  await expect(gridCell).toBeVisible();
  await expect(flexCell).toBeVisible();
  const restored = await metrics();
  expect(restored.gridSibling!.x).toBeGreaterThan(
    restored.gridCell!.x + restored.gridCell!.width * 0.5,
  );
  expect(restored.flexSibling!.x).toBeGreaterThan(
    restored.flexCell!.x + restored.flexCell!.width * 0.5,
  );

  // API-путь и обратное возвращение не пересоздают контролы.
  await page.evaluate(() => {
    window.__controlsFixture.instance.params.set("classShown", false, "api");
  });
  await expect(gridCell).toBeHidden();
  await expect(flexCell).toBeHidden();
  await toggle.check();
  await expect(gridCell).toBeVisible();
  await expect(flexCell).toBeVisible();
  await expect(gridCell).toHaveAttribute("data-identity", "kept");
  await expect(flexCell).toHaveAttribute("data-identity", "kept");
  // Возврат ячейки не перетягивает фокус на восстановленный контрол.
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-param"))).not.toBe(
    "gridValue",
  );
});

for (const width of [320, 1280]) {
  test(`dense row geometry stays inside its card without overlaps at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(FIXTURE);
    const card = page.locator(".labkit-controls .labkit-card").filter({ hasText: "Плотный ряд" });
    const row = card.locator(".labkit-row");
    const metrics = await row.evaluate((el) => {
      const cardEl = el.closest(".labkit-card")!;
      const cardRect = cardEl.getBoundingClientRect();
      const rowRect = el.getBoundingClientRect();
      return {
        card: { left: cardRect.left, right: cardRect.right, width: cardRect.width },
        row: { left: rowRect.left, right: rowRect.right, width: rowRect.width },
        items: [...el.children].map((child) => {
          const rect = child.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
        }),
      };
    });

    expect(metrics.items).toHaveLength(3);
    // Ряд действительно плотный: три колонки, а не вертикальная стопка без
    // пересечений. Segmented — поле, но внутри ряда он такой же layout-item,
    // как knob/pad: корневые ячейки начинаются на одной top-координате, без
    // собственного margin-top .labkit-field.
    const columns = await row.evaluate(
      (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
    );
    expect(columns).toBe(3);
    const tops = metrics.items.map((item) => item.top);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(0.5);
    const segmented = row.locator(".labkit-segmented");
    await expect(segmented).toHaveCount(1);
    expect(await segmented.evaluate((el) => getComputedStyle(el).marginTop)).toBe("0px");
    for (const item of metrics.items) {
      expect(item.width).toBeGreaterThan(0);
      expect(item.height).toBeGreaterThan(0);
      expect(item.left).toBeGreaterThanOrEqual(metrics.card.left - 0.5);
      expect(item.right).toBeLessThanOrEqual(metrics.card.right + 0.5);
      expect(item.left).toBeGreaterThanOrEqual(metrics.row.left - 0.5);
      expect(item.right).toBeLessThanOrEqual(metrics.row.right + 0.5);
    }
    for (let a = 0; a < metrics.items.length; a += 1) {
      for (let b = a + 1; b < metrics.items.length; b += 1) {
        const first = metrics.items[a]!;
        const second = metrics.items[b]!;
        const horizontal = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const vertical = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
        expect(horizontal > 0.5 && vertical > 0.5, `controls ${a} and ${b} overlap`).toBe(false);
      }
    }
  });
}

test("registry → controls/action → render → readout stays coherent", async ({ page }) => {
  await page.goto(FIXTURE);
  const level = page.locator('[data-param="level"]');
  const enabled = page.locator('[data-param="enabled"]');
  const mode = page.locator('[data-param="mode"]');
  const ping = page.locator('[data-action="ping"]');
  const readout = page.locator(".labkit-readout");

  await expect(level).toHaveAttribute("aria-valuenow", "5");
  await expect(enabled).not.toBeChecked();
  await expect(mode).toHaveValue("a");
  await expect(ping).toBeDisabled();
  await expect(readout).toContainText("Ping: 0");

  // This mirrors the old scenario: API writes go through the registry and
  // render must synchronize number/boolean/enum controls and action availability.
  await page.evaluate(() => {
    const instance = window.__controlsFixture.instance;
    instance.params.set("enabled", true, "api");
    instance.params.set("level", 7, "api");
    instance.params.set("mode", "b", "api");
  });
  await expect(level).toHaveAttribute("aria-valuenow", "7");
  await expect(enabled).toBeChecked();
  await expect(mode).toHaveValue("b");
  await expect(ping).toBeEnabled();

  await ping.click();
  await expect(readout).toContainText("Ping: 1");
  await expect(readout).toContainText("level=7");
  await expect(readout).toContainText("enabled=true");
  await expect(readout).toContainText("mode=b");
});

test("knob pointer capture: no jump, relative direction, Shift and outside release", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const knob = page.getByRole("slider", { name: "Уровень" });
  const box = (await knob.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await expect(knob).toHaveAttribute("aria-orientation", "vertical");
  await page.mouse.down();
  await expect(knob).toHaveAttribute("aria-valuenow", "5");
  await expect(page.locator(".labkit-knob-scale")).toBeVisible();
  await page.mouse.move(x + 200, y);
  await expect(knob).toHaveAttribute("aria-valuenow", "5");
  await page.mouse.move(x + 48, y - 48);
  await expect(knob).toHaveAttribute("aria-valuenow", "7");
  await page.keyboard.down("Shift");
  await page.mouse.move(x + 48, y - 48);
  await expect(knob).toHaveAttribute("aria-valuenow", "7");
  await page.mouse.move(x + 96, y - 96);
  await expect(knob).toHaveAttribute("aria-valuenow", "7");
  await page.keyboard.up("Shift");
  await page.mouse.move(x + 48, y - 48);
  await expect(knob).toHaveAttribute("aria-valuenow", "5");
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await expect(page.locator(".labkit-knob-scale")).toHaveCount(0);
  const current = await knob.getAttribute("aria-valuenow");
  await page.mouse.move(x + 120, y);
  await expect(knob).toHaveAttribute("aria-valuenow", current!);
});

test("knob raw editing preserves draft and focus during external updates", async ({ page }) => {
  await page.goto(FIXTURE);
  const knob = page.getByRole("slider", { name: "Уровень" });
  const main = knob.locator("..");
  await main.locator(".labkit-knob-value").click();
  const editor = main.getByRole("textbox");
  await expect(editor).toHaveValue("5");
  await editor.fill("3");
  await page.evaluate(() => window.__controlsFixture.instance.params.set("level", 9, "midi"));
  await expect(knob).toHaveAttribute("aria-valuenow", "9");
  await expect(editor).toHaveValue("3");
  await expect(editor).toBeFocused();
  await editor.press("Enter");
  await expect(knob).toHaveAttribute("aria-valuenow", "3");
  await main.locator(".labkit-knob-value").click();
  await editor.fill("oops");
  await editor.press("Enter");
  await expect(knob).toHaveAttribute("aria-valuenow", "3");
  await main.locator(".labkit-knob-value").click();
  await editor.fill("8");
  await editor.press("Escape");
  await expect(knob).toHaveAttribute("aria-valuenow", "3");
  await main.locator("label").click();
  await expect(knob).toBeFocused();
  await knob.press("End");
  await expect(knob).toHaveAttribute("aria-valuenow", "10");
  await knob.press("ArrowLeft");
  await expect(knob).toHaveAttribute("aria-valuenow", "9");
  await knob.press("Home");
  await expect(knob).toHaveAttribute("aria-valuenow", "0");
});

test("touch drag shares relative behavior and scale stays inside viewport edges", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(FIXTURE);
  const knob = page.getByRole("slider", { name: "Уровень" });
  await knob.evaluate((el) => {
    Object.assign((el as HTMLElement).style, {
      position: "fixed",
      top: "0",
      right: "0",
      zIndex: "100",
    });
  });
  const box = (await knob.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await expect(knob).toHaveAttribute("aria-valuenow", "5");
  const popup = page.locator(".labkit-knob-scale");
  await expect(popup).toBeVisible();
  const scale = (await popup.boundingBox())!;
  expect(scale.x).toBeGreaterThanOrEqual(0);
  expect(scale.y).toBeGreaterThanOrEqual(0);
  expect(scale.x + scale.width).toBeLessThanOrEqual(320);
  expect(scale.y + scale.height).toBeLessThanOrEqual(640);
  // У правого края шкала переставляется влево, не перекрывая knob.
  expect(scale.x + scale.width).toBeLessThanOrEqual(box.x);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x - 48, y }],
  });
  await expect(knob).toHaveAttribute("aria-valuenow", "5");
  expect((await popup.boundingBox())!).toEqual(scale);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x, y: y + 48 }],
  });
  await expect(knob).toHaveAttribute("aria-valuenow", "3");
  expect((await popup.boundingBox())!).toEqual(scale);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(popup).toHaveCount(0);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect(popup).toHaveCount(0);
  await cdp.detach();
});

test("knob scale is tall and narrow with max on top, min at bottom and a moving marker", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const knob = page.getByRole("slider", { name: "Уровень" });
  expect(await knob.evaluate((el) => getComputedStyle(el).cursor)).toBe("ns-resize");
  const box = (await knob.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const popup = page.locator(".labkit-knob-scale");
  const track = popup.locator(".labkit-knob-scale-track");
  const thumb = popup.locator(".labkit-knob-scale-thumb");
  const high = popup.locator(".labkit-knob-scale-high");
  const low = popup.locator(".labkit-knob-scale-low");

  await knob.press("End");
  await expect(knob).toHaveAttribute("aria-valuenow", "10");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(high).toHaveText("10");
  await expect(low).toHaveText("0");
  const scale = (await popup.boundingBox())!;
  expect(scale.height).toBeGreaterThan(scale.width * 2);
  const highTrack = (await track.boundingBox())!;
  const highLabel = (await high.boundingBox())!;
  const lowLabel = (await low.boundingBox())!;
  // Max sits above the track, min below it — not both above the track.
  expect(highLabel.y + highLabel.height).toBeLessThanOrEqual(highTrack.y);
  expect(lowLabel.y).toBeGreaterThanOrEqual(highTrack.y + highTrack.height);
  expect(highLabel.y + highLabel.height / 2).toBeLessThan(highTrack.y + highTrack.height / 2);
  expect(lowLabel.y + lowLabel.height / 2).toBeGreaterThan(highTrack.y + highTrack.height / 2);
  const highThumb = (await thumb.boundingBox())!;
  expect(Math.abs(highThumb.y + highThumb.height / 2 - highTrack.y)).toBeLessThanOrEqual(2);
  await page.mouse.up();

  await knob.press("Home");
  await expect(knob).toHaveAttribute("aria-valuenow", "0");
  await page.mouse.move(x, y);
  await page.mouse.down();
  const lowTrack = (await track.boundingBox())!;
  const lowThumb = (await thumb.boundingBox())!;
  expect(
    Math.abs(lowThumb.y + lowThumb.height / 2 - (lowTrack.y + lowTrack.height)),
  ).toBeLessThanOrEqual(2);
  await page.mouse.up();
});

test("knob scale widens for long limit labels and stays inside a mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(FIXTURE);
  const knob = page.getByRole("slider", { name: "Уровень" });
  const box = (await knob.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;

  // Reopen after substituting realistic long limits so natural width is measured.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.locator(".labkit-knob-scale-high").evaluate((el) => {
    el.textContent = "101325";
  });
  await page.locator(".labkit-knob-scale-low").evaluate((el) => {
    el.textContent = "-10000";
  });
  await page.mouse.up();
  await page.mouse.move(x, y);
  await page.mouse.down();

  const popup = page.locator(".labkit-knob-scale");
  const high = popup.locator(".labkit-knob-scale-high");
  const low = popup.locator(".labkit-knob-scale-low");
  await expect(high).toHaveText("101325");
  await expect(low).toHaveText("-10000");
  const scale = (await popup.boundingBox())!;
  const highLabel = (await high.boundingBox())!;
  const lowLabel = (await low.boundingBox())!;
  expect(scale.width).toBeGreaterThan(48);
  expect(scale.x).toBeGreaterThanOrEqual(0);
  expect(scale.x + scale.width).toBeLessThanOrEqual(320);
  expect(scale.y).toBeGreaterThanOrEqual(0);
  expect(scale.y + scale.height).toBeLessThanOrEqual(640);
  expect(scale.height).toBeGreaterThan(scale.width * 2);
  for (const label of [highLabel, lowLabel]) {
    expect(label.x).toBeGreaterThanOrEqual(scale.x);
    expect(label.x + label.width).toBeLessThanOrEqual(scale.x + scale.width);
    expect(label.height).toBeLessThanOrEqual(16);
  }
  expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.mouse.up();
});

test("dispose during captured pointer gesture removes popup and handlers", async ({ page }) => {
  await page.goto(FIXTURE);
  const knob = page.getByRole("slider", { name: "Уровень" });
  const box = (await knob.boundingBox())!;
  await page.mouse.move(box.x + 26, box.y + 26);
  await page.mouse.down();
  await expect(page.locator(".labkit-knob-scale")).toBeVisible();
  await page.evaluate(async () => {
    await window.__controlsFixture.instance.dispose();
  });
  await expect(page.locator(".labkit-knob-scale")).toHaveCount(0);
  await page.mouse.move(300, 300);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__controlsFixture.instance.state.level)).toBe(5);
});

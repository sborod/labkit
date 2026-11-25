// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ParameterRegistry } from "../../src/core/registry.ts";
import { createControl } from "../../src/ui/controls.ts";
import type { ParameterSpec } from "../../src/core/params.ts";

interface Demo {
  level: number;
  flag: boolean;
  mode: string;
  allow: boolean;
}

function buildSpecs(): Record<string, ParameterSpec<Demo>> {
  return {
    level: {
      kind: "number",
      id: "level",
      label: "Уровень",
      min: 0,
      max: 10,
      step: 1,
      format: (value) => `level = ${value}`,
      available: (state) => state.allow,
      read: (state) => state.level,
      write: (state, value) => {
        state.level = value;
      },
    },
    flag: {
      kind: "boolean",
      id: "flag",
      label: "Флаг",
      read: (state) => state.flag,
      write: (state, value) => {
        state.flag = value;
      },
    },
    mode: {
      kind: "enum",
      id: "mode",
      label: "Режим",
      options: (state) =>
        state.allow
          ? [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ]
          : [{ value: "a", label: "A" }],
      read: (state) => state.mode,
      write: (state, value) => {
        state.mode = value;
      },
    },
    allow: {
      kind: "boolean",
      id: "allow",
      label: "Разрешить",
      read: (state) => state.allow,
      write: (state, value) => {
        state.allow = value;
      },
    },
  };
}

function build(): { state: Demo; registry: ParameterRegistry<Demo> } {
  const state: Demo = { level: 2, flag: false, mode: "a", allow: false };
  return { state, registry: new ParameterRegistry(state, buildSpecs()) };
}

describe("controls: типы параметров", () => {
  it("default enum uses a short display label without changing its accessible name", () => {
    const { registry } = build();
    const control = createControl(registry.spec("mode"), registry, "ui", {
      displayLabel: "Коротко",
    });
    expect(control.el.querySelector(".labkit-field-label")!.textContent).toBe("Коротко");
    expect(control.el.querySelector("select")!.getAttribute("aria-label")).toBe("Режим");
    control.dispose();
  });
  it("segmented enum stays canonical and stable; pad keeps native checkbox semantics", () => {
    const { state, registry } = build();
    registry.set("allow", true, "api");
    const segmented = createControl(registry.spec("mode"), registry, "ui", {
      presentation: "segmented",
    });
    const button = segmented.el.querySelectorAll("button")[1]!;
    button.click();
    expect(state.mode).toBe("b");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    state.mode = "a";
    segmented.update();
    expect(segmented.el.querySelectorAll("button")[1]).toBe(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    const pad = createControl(registry.spec("flag"), registry, "ui", {
      presentation: "pad",
      displayLabel: "1",
    });
    document.body.append(pad.el);
    const input = pad.el.querySelector("input")!;
    expect(input.type).toBe("checkbox");
    expect(input.getAttribute("aria-label")).toBe("Флаг");
    input.click();
    expect(state.flag).toBe(true);
    state.flag = false;
    pad.update();
    expect(input.checked).toBe(false);
    segmented.dispose();
    pad.dispose();
    pad.el.remove();
  });
  it("number: knob пишет через реестр и форматирует значение", () => {
    const { state, registry } = build();
    registry.set("allow", true, "api");
    const control = createControl(registry.spec("level"), registry);
    const input = control.el.querySelector('[role="slider"]') as HTMLButtonElement;
    expect(input.getAttribute("aria-valuenow")).toBe("2");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(state.level).toBe(7);
    expect(control.el.querySelector(".labkit-value")?.textContent).toBe("level = 7");
    control.dispose();
  });

  it("boolean: checkbox пишет через реестр", () => {
    const { state, registry } = build();
    const control = createControl(registry.spec("flag"), registry);
    const input = control.el.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(state.flag).toBe(true);
    control.dispose();
  });

  it("enum: select пишет и обновляет опции динамически", () => {
    const { state, registry } = build();
    registry.set("allow", true, "api");
    const control = createControl(registry.spec("mode"), registry);
    const select = control.el.querySelector("select") as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    select.value = "b";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(state.mode).toBe("b");
    // сужение опций не должно терять валидное текущее значение
    registry.set("allow", false, "api");
    expect(select.options).toHaveLength(1);
    control.dispose();
  });

  it("доступность синхронизируется по подписке на реестр", () => {
    const { registry } = build();
    const control = createControl(registry.spec("level"), registry);
    const input = control.el.querySelector('[role="slider"]') as HTMLButtonElement;
    expect(input.disabled).toBe(true);
    registry.set("allow", true, "api");
    expect(input.disabled).toBe(false);
    registry.set("allow", false, "api");
    expect(input.disabled).toBe(true);
    control.dispose();
  });

  it("отписка прекращает синхронизацию", () => {
    const { registry } = build();
    const control = createControl(registry.spec("level"), registry);
    const input = control.el.querySelector('[role="slider"]') as HTMLButtonElement;
    control.dispose();
    registry.set("allow", true, "api");
    expect(input.disabled).toBe(true);
  });
});

describe("controls: обёртка и слот inline-обучения MIDI", () => {
  it("number: labelled slider and editor are siblings; accessory is separate", () => {
    const { registry } = build();
    const control = createControl(registry.spec("level"), registry);
    const input = control.el.querySelector('[role="slider"]') as HTMLButtonElement;
    const main = input.closest(".labkit-control-main")!;
    expect(main).not.toBeNull();
    expect(main.classList.contains("labkit-control-main")).toBe(true);
    // Подпись непосредственно перед input (гарантия runtime.test.ts).
    expect(input.previousElementSibling?.className).toContain("labkit-field-label");
    expect(input.previousElementSibling?.textContent).toBe("Уровень");
    // Следом идёт форматированное значение.
    expect(input.nextElementSibling?.className).toContain("labkit-value");
    expect(main.querySelector("label")?.htmlFor).toBe(input.id);
    expect(input.querySelector("input,button")).toBeNull();

    const accessory = control.el.querySelector("[data-labkit-param-accessory]") as HTMLElement;
    expect(accessory).not.toBeNull();
    expect(accessory.dataset.labkitParamAccessory).toBe("level");
    expect(accessory.hidden).toBe(true);
    expect(main.contains(accessory)).toBe(false);
    expect(control.el.classList.contains("labkit-field")).toBe(true);
    expect(control.el.classList.contains("labkit-control")).toBe(true);
    control.dispose();
  });

  it("number: data-param только на slider, обёртка/disabled синхронизируются", () => {
    const { registry } = build();
    const control = createControl(registry.spec("level"), registry);
    expect(control.el.classList.contains("is-disabled")).toBe(true);
    expect(control.el.querySelectorAll("[data-param]")).toHaveLength(1);
    expect(control.el.querySelector("[data-param]")?.getAttribute("data-param")).toBe("level");
    registry.set("allow", true, "api");
    expect(control.el.classList.contains("is-disabled")).toBe(false);
    control.dispose();
  });

  it("number: visible=false скрывает внешнюю обёртку", () => {
    const state: Demo = { level: 2, flag: false, mode: "a", allow: true };
    const specs: Record<string, ParameterSpec<Demo>> = {
      level: {
        kind: "number",
        id: "level",
        label: "L",
        min: 0,
        max: 10,
        step: 1,
        visible: () => false,
        read: (s) => s.level,
        write: (s, v) => {
          s.level = v;
        },
      },
    };
    const registry = new ParameterRegistry(state, specs);
    const control = createControl(registry.spec("level"), registry);
    expect(control.el.hidden).toBe(true);
    control.dispose();
  });

  it("boolean: чекбокс в label, слот вне label на обёртке", () => {
    const { registry } = build();
    const control = createControl(registry.spec("flag"), registry);
    const input = control.el.querySelector("input") as HTMLInputElement;
    const main = input.closest("label")!;
    expect(main.classList.contains("labkit-control-main")).toBe(true);
    const accessory = control.el.querySelector("[data-labkit-param-accessory]") as HTMLElement;
    expect(accessory).not.toBeNull();
    expect(accessory.dataset.labkitParamAccessory).toBe("flag");
    expect(accessory.hidden).toBe(true);
    expect(main.contains(accessory)).toBe(false);
    expect(control.el.classList.contains("labkit-check")).toBe(true);
    expect(control.el.classList.contains("labkit-control")).toBe(true);
    control.dispose();
  });

  it("enum: слот MIDI не создаётся", () => {
    const { registry } = build();
    const control = createControl(registry.spec("mode"), registry);
    expect(control.el.querySelector("[data-labkit-param-accessory]")).toBeNull();
    expect(control.el.querySelector("[data-labkit-action-accessory]")).toBeNull();
    expect(control.el.classList.contains("labkit-control")).toBe(false);
    control.dispose();
  });
});

describe("controls: безопасная инициализация", () => {
  it("исключение в update при создании не оставляет подписку/слушателей", () => {
    const state: Demo = { level: 2, flag: false, mode: "a", allow: true };
    let formatCalls = 0;
    const specs: Record<string, ParameterSpec<Demo>> = {
      level: {
        kind: "number",
        id: "level",
        label: "Уровень",
        min: 0,
        max: 10,
        step: 1,
        format: () => {
          formatCalls += 1;
          throw new Error("format boom");
        },
        read: (s) => s.level,
        write: (s, v) => {
          s.level = v;
        },
      },
    };
    const registry = new ParameterRegistry(state, specs);
    expect(() => createControl(registry.spec("level"), registry)).toThrow(/format boom/);
    expect(formatCalls).toBe(1);
    // Подписка снята и слушатели удалены: последующий set не вызывает update.
    expect(() => registry.set("level", 5, "api")).not.toThrow();
    expect(formatCalls).toBe(1);
    expect(state.level).toBe(5);
  });
});

describe("controls: презентации pad и segmented", () => {
  interface PresentationDemo {
    enabled: boolean;
    mode: string;
    allow: boolean;
    show: boolean;
  }

  function presentationBuild(): {
    state: PresentationDemo;
    registry: ParameterRegistry<PresentationDemo>;
  } {
    const state: PresentationDemo = { enabled: false, mode: "l", allow: true, show: true };
    const specs: Record<string, ParameterSpec<PresentationDemo>> = {
      enabled: {
        kind: "boolean",
        id: "enabled",
        label: "Отверстие",
        available: (s) => s.allow,
        visible: (s) => s.show,
        read: (s) => s.enabled,
        write: (s, v) => {
          s.enabled = v;
        },
      },
      mode: {
        kind: "enum",
        id: "mode",
        label: "Монитор",
        options: [
          { value: "l", label: "L" },
          { value: "m", label: "M" },
          { value: "h", label: "H" },
        ],
        available: (s) => s.allow,
        visible: (s) => s.show,
        read: (s) => s.mode,
        write: (s, v) => {
          s.mode = v;
        },
      },
      allow: {
        kind: "boolean",
        id: "allow",
        label: "Разрешить",
        read: (s) => s.allow,
        write: (s, v) => {
          s.allow = v;
        },
      },
      show: {
        kind: "boolean",
        id: "show",
        label: "Показывать",
        read: (s) => s.show,
        write: (s, v) => {
          s.show = v;
        },
      },
    };
    return { state, registry: new ParameterRegistry(state, specs) };
  }

  it("pad: displayLabel не заменяет доступное имя, семантика остаётся native checkbox", () => {
    const { state, registry } = presentationBuild();
    const control = createControl(registry.spec("enabled"), registry, "ui", {
      presentation: "pad",
      displayLabel: "1",
    });
    document.body.append(control.el);

    const input = control.el.querySelector("input") as HTMLInputElement;
    expect(control.el.classList.contains("labkit-pad")).toBe(true);
    expect(input.type).toBe("checkbox");
    expect(input.getAttribute("aria-label")).toBe("Отверстие");
    expect(control.el.querySelector(".labkit-control-main > span")!.textContent).toBe("1");
    expect(control.el.querySelectorAll("[data-param]")).toHaveLength(1);
    expect(control.el.querySelector("[data-param]")).toBe(input);
    expect(input.checked).toBe(false);

    input.click();
    expect(state.enabled).toBe(true);
    expect(input.checked).toBe(true);
    state.enabled = false;
    control.update();
    expect(input.checked).toBe(false);

    control.dispose();
    control.el.remove();
  });

  it("segmented: role group с доступным именем, aria-pressed и каноническое значение", () => {
    const { state, registry } = presentationBuild();
    const control = createControl(registry.spec("mode"), registry, "ui", {
      presentation: "segmented",
      displayLabel: "M",
    });
    document.body.append(control.el);

    expect(control.el.classList.contains("labkit-segmented")).toBe(true);
    expect(control.el.querySelector(".labkit-field-label")!.textContent).toBe("M");
    const group = control.el.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("Монитор");
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((button) => button.dataset.value)).toEqual(["l", "m", "h"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
    ]);

    buttons[2]!.click();
    expect(state.mode).toBe("h");
    expect(buttons[2]!.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("false");

    state.mode = "m";
    control.update();
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[2]!.getAttribute("aria-pressed")).toBe("false");
    // DOM кнопок стабилен между обновлениями (именно identity, не deep-equal).
    const afterUpdate = [...group.querySelectorAll("button")];
    expect(afterUpdate).toHaveLength(buttons.length);
    afterUpdate.forEach((button, index) => expect(button).toBe(buttons[index]));

    control.dispose();
    control.el.remove();
  });

  it("available/visible обновляются динамически, dispose снимает подписку", () => {
    const { registry } = presentationBuild();
    const pad = createControl(registry.spec("enabled"), registry, "ui", { presentation: "pad" });
    const segmented = createControl(registry.spec("mode"), registry, "ui", {
      presentation: "segmented",
    });
    document.body.append(pad.el, segmented.el);
    const input = pad.el.querySelector("input") as HTMLInputElement;
    const buttons = [...segmented.el.querySelectorAll("button")];

    registry.set("allow", false, "api");
    expect(input.disabled).toBe(true);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    registry.set("allow", true, "api");
    expect(input.disabled).toBe(false);
    expect(buttons.every((button) => !button.disabled)).toBe(true);

    registry.set("show", false, "api");
    expect(pad.el.hidden).toBe(true);
    expect(segmented.el.hidden).toBe(true);
    registry.set("show", true, "api");
    expect(pad.el.hidden).toBe(false);
    expect(segmented.el.hidden).toBe(false);

    pad.dispose();
    segmented.dispose();
    registry.set("allow", false, "api");
    registry.set("show", false, "api");
    // После dispose подписка снята: DOM не реагирует на последующие изменения.
    expect(input.disabled).toBe(false);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    expect(pad.el.hidden).toBe(false);
    expect(segmented.el.hidden).toBe(false);

    pad.el.remove();
    segmented.el.remove();
  });
});

describe("controls: ошибки записи и обновления не оставляют stale DOM", () => {
  it("ошибка write: DOM возвращается к каноническому, onError(write)", () => {
    const state: Demo = { level: 0, flag: false, mode: "a", allow: true };
    const specs: Record<string, ParameterSpec<Demo>> = {
      level: {
        kind: "number",
        id: "level",
        label: "L",
        min: 0,
        max: 10,
        step: 1,
        read: (s) => s.level,
        write: () => {
          throw new Error("write boom");
        },
      },
    };
    const registry = new ParameterRegistry(state, specs);
    const errors: Array<{ op: string }> = [];
    const control = createControl(registry.spec("level"), registry, "ui", {
      onError: (_error, context) => errors.push(context),
    });
    const input = control.el.querySelector('[role="slider"]') as HTMLButtonElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(state.level).toBe(0);
    expect(input.getAttribute("aria-valuenow")).toBe("0");
    expect(errors).toContainEqual({ op: "write" });
    control.dispose();
  });

  it("форматтер падает при обновлении: onError(update), вход отражает модель", () => {
    const state: Demo = { level: 0, flag: false, mode: "a", allow: true };
    let formatCalls = 0;
    const specs: Record<string, ParameterSpec<Demo>> = {
      level: {
        kind: "number",
        id: "level",
        label: "L",
        min: 0,
        max: 10,
        step: 1,
        format: (value) => {
          formatCalls += 1;
          if (formatCalls > 1) {
            throw new Error("fmt boom");
          }
          return `level=${value}`;
        },
        read: (s) => s.level,
        write: (s, v) => {
          s.level = v;
        },
      },
    };
    const registry = new ParameterRegistry(state, specs);
    const errors: Array<{ op: string }> = [];
    const control = createControl(registry.spec("level"), registry, "ui", {
      onError: (_error, context) => errors.push(context),
    });
    const input = control.el.querySelector('[role="slider"]') as HTMLButtonElement;
    expect(input.getAttribute("aria-valuenow")).toBe("0");
    expect(() => registry.set("level", 5, "api")).not.toThrow();
    expect(state.level).toBe(5);
    expect(input.getAttribute("aria-valuenow")).toBe("5");
    expect(errors).toContainEqual({ op: "update" });
    control.dispose();
  });

  it("enum: ошибка записи восстанавливает select к каноническому значению", () => {
    const state: Demo = { level: 0, flag: false, mode: "a", allow: true };
    const specs: Record<string, ParameterSpec<Demo>> = {
      mode: {
        kind: "enum",
        id: "mode",
        label: "M",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        read: (s) => s.mode,
        write: () => {
          throw new Error("enum write boom");
        },
      },
    };
    const registry = new ParameterRegistry(state, specs);
    const errors: Array<{ op: string }> = [];
    const control = createControl(registry.spec("mode"), registry, "ui", {
      onError: (_error, context) => errors.push(context),
    });
    const select = control.el.querySelector("select") as HTMLSelectElement;
    select.value = "b";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(state.mode).toBe("a");
    expect(select.value).toBe("a");
    expect(errors).toContainEqual({ op: "write" });
    control.dispose();
  });
});

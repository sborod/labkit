// @vitest-environment jsdom
// Inline-обучение MIDI (src/midi/inline.ts): компактные кнопки в слотах возле
// каждого поддерживаемого параметра/действия. Здесь проверяем поведение самого
// binder'а на настоящем MidiAdapter и настоящих слотах; DOM-структуру слотов
// строит controls/createLab (см. controls.test.ts / midi-attach.test.ts).
import { describe, expect, it, vi } from "vitest";
import { ParameterRegistry } from "../../src/core/registry.ts";
import type { ParameterSpec } from "../../src/core/params.ts";
import { MidiAdapter, type MidiActionHost } from "../../src/midi/adapter.ts";
import { bindMidiLearn } from "../../src/midi/inline.ts";
import { MemoryMidiStorage } from "../../src/midi/store.ts";
import { FakeMidiEnvironment } from "../../src/midi/testing.ts";

interface TestState {
  on: boolean;
  level: number;
}

function registry(state: TestState = { on: false, level: 0 }): ParameterRegistry<TestState> {
  const specs: Record<string, ParameterSpec<TestState>> = {
    on: {
      kind: "boolean",
      id: "on",
      label: "On",
      read: (s) => s.on,
      write: (s, v) => {
        s.on = v;
      },
    },
    level: {
      kind: "number",
      id: "level",
      label: "Level",
      min: 0,
      max: 100,
      step: 1,
      read: (s) => s.level,
      write: (s, v) => {
        s.level = v;
      },
    },
  };
  return new ParameterRegistry<TestState>(state, specs);
}

class TestActions implements MidiActionHost {
  text = "Ping";
  idsList: string[] = ["ping"];
  readonly executed: string[] = [];
  has(id: string): boolean {
    return this.idsList.includes(id);
  }
  ids(): string[] {
    return [...this.idsList];
  }
  isAvailable(): boolean {
    return true;
  }
  label(id: string): string {
    return id === "ping" ? this.text : id;
  }
  async execute(id: string): Promise<void> {
    this.executed.push(id);
  }
}

/** Mirror numeric knob / checkbox semantics, with a separate MIDI slot. */
function appendParamSlot(root: HTMLElement, id: string): HTMLButtonElement;
function appendParamSlot(root: HTMLElement, id: string, type: "checkbox"): HTMLInputElement;
function appendParamSlot(
  root: HTMLElement,
  id: string,
  type?: "checkbox",
): HTMLInputElement | HTMLButtonElement {
  const wrapper = document.createElement("div");
  wrapper.className = "labkit-field labkit-control";
  const main = document.createElement(type === "checkbox" ? "label" : "div");
  main.className = "labkit-control-main";
  const input =
    type === "checkbox" ? document.createElement("input") : document.createElement("button");
  input.type = type ?? "button";
  if (!type) input.setAttribute("role", "slider");
  input.dataset.param = id;
  main.append(input);
  const accessory = document.createElement("span");
  accessory.className = "labkit-control-accessory";
  accessory.dataset.labkitParamAccessory = id;
  accessory.hidden = true;
  wrapper.append(main, accessory);
  root.append(wrapper);
  return input;
}

/** Слот действия: основная кнопка + accessory рядом. */
function appendActionSlot(root: HTMLElement, id: string): HTMLButtonElement {
  const wrapper = document.createElement("div");
  wrapper.className = "labkit-action labkit-control";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "labkit-btn";
  button.dataset.action = id;
  const accessory = document.createElement("span");
  accessory.className = "labkit-control-accessory";
  accessory.dataset.labkitActionAccessory = id;
  accessory.hidden = true;
  wrapper.append(button, accessory);
  root.append(wrapper);
  return button;
}

function setup() {
  const env = new FakeMidiEnvironment();
  const input = env.addInput("device");
  const params = registry();
  const actions = new TestActions();
  const adapter = new MidiAdapter({
    namespace: "inline",
    params,
    actions,
    environment: env,
    storage: new MemoryMidiStorage(),
    lifetime: { disposed: false },
  });
  const root = document.createElement("div");
  const onInput = appendParamSlot(root, "on", "checkbox");
  const levelInput = appendParamSlot(root, "level");
  const actionButton = appendActionSlot(root, "ping");
  const binder = bindMidiLearn({ root, adapter });
  return { adapter, binder, root, env, input, params, actions, onInput, levelInput, actionButton };
}

function learnButton(root: HTMLElement, target: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`[data-target="${target}"]`)!;
}

function accessories(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".labkit-control-accessory")];
}

describe("inline MIDI: показ по глобальному training", () => {
  it("training false скрывает слоты, true показывает", () => {
    const { adapter, binder, root } = setup();
    expect(accessories(root).every((slot) => slot.hidden)).toBe(true);
    adapter.setTraining(true);
    expect(accessories(root).every((slot) => !slot.hidden)).toBe(true);
    adapter.setTraining(false);
    expect(accessories(root).every((slot) => slot.hidden)).toBe(true);
    binder.dispose();
    adapter.dispose();
  });

  it("скрытие обёртки скрывает слот (training включён)", () => {
    const { adapter, binder, root } = setup();
    adapter.setTraining(true);
    const button = learnButton(root, "on");
    const wrapper = button.closest(".labkit-control") as HTMLElement;
    // Слот лежит внутри обёртки: скрытие обёртки скрывает и кнопку.
    expect(wrapper.contains(button)).toBe(true);
    expect(wrapper.hidden).toBe(false);
    wrapper.hidden = true;
    expect(wrapper.hidden).toBe(true);
    binder.dispose();
    adapter.dispose();
  });
});

describe("inline MIDI: обучение CC/Note и summary", () => {
  it("клик обучает цель, ожидание и назначение отражаются на кнопке", async () => {
    const { adapter, binder, root, input } = setup();
    await adapter.connect();
    adapter.setTraining(true);

    const on = learnButton(root, "on");
    expect(on.textContent).toBe("Обучить MIDI");
    on.click();
    expect(adapter.learningTarget).toBe("on");
    expect(on.textContent).toBe("Жду MIDI…");
    expect(on.getAttribute("aria-pressed")).toBe("true");

    input.emit([0xb0, 40, 127]);
    expect(on.textContent).toMatch(/CC 40/);
    expect(on.getAttribute("aria-pressed")).toBe("false");

    const ping = learnButton(root, "ping");
    ping.click();
    input.emit([0x90, 60, 127]);
    expect(ping.textContent).toMatch(/Note 60/);

    binder.dispose();
    adapter.dispose();
  });

  it("повторный клик по ожиданию отменяет, клик по назначению переобучает первое назначение", async () => {
    const { adapter, binder, root, input } = setup();
    await adapter.connect();
    adapter.setTraining(true);
    const on = learnButton(root, "on");
    on.click();
    expect(adapter.learningTarget).toBe("on");
    on.click();
    expect(adapter.learningTarget).toBeNull();
    expect(adapter.learnMessage).toContain("отмен");

    // Возобновляем обучение и назначаем первое назначение.
    on.click();
    input.emit([0xb0, 40, 127]);
    adapter.addMapping({ target: "on", source: "note", number: 70 });
    expect(on.textContent).toMatch(/CC 40 · ch 1 \+1/);
    // Переобучение меняет ИМЕННО первое назначение цели.
    on.click();
    input.emit([0xb0, 41, 64]);
    const first = adapter.mappings().find((m) => m.target === "on")!;
    expect(first.source).toBe("cc");
    expect(first.number).toBe(41);
    expect(first.channel).toBe(1);
    expect(on.textContent).toMatch(/CC 41 · ch 1 \+1/);

    binder.dispose();
    adapter.dispose();
  });

  it("обучающее сообщение поглощается и не меняет параметр/не запускает действие", async () => {
    const { adapter, binder, root, params, actions, input } = setup();
    await adapter.connect();
    adapter.setTraining(true);
    params.set("level", 50, "api");

    learnButton(root, "level").click();
    input.emit([0xb0, 21, 127]);
    expect(params.getNumber("level")).toBe(50);
    expect(adapter.mappings().some((m) => m.target === "level")).toBe(true);

    actions.executed.length = 0;
    learnButton(root, "ping").click();
    input.emit([0x90, 60, 127]);
    expect(actions.executed).toEqual([]);
    // Следующее (не обучающее) сообщение срабатывает как обычно.
    input.emit([0x90, 60, 127]);
    expect(actions.executed).toEqual(["ping"]);

    binder.dispose();
    adapter.dispose();
  });

  it("клик по кнопке обучения не переключает checkbox и не выполняет действие", () => {
    const { adapter, binder, root, actions, onInput } = setup();
    adapter.setTraining(true);
    expect(onInput.checked).toBe(false);
    learnButton(root, "on").click();
    expect(onInput.checked).toBe(false);
    expect(adapter.mappings()).toHaveLength(0);

    actions.executed.length = 0;
    learnButton(root, "ping").click();
    expect(actions.executed).toEqual([]);
    binder.dispose();
    adapter.dispose();
  });

  it("summary обновляется при add/update/remove, включая относительный Δ и +N", () => {
    const { adapter, binder, root } = setup();
    adapter.setTraining(true);
    const on = learnButton(root, "on");
    const level = learnButton(root, "level");
    expect(on.textContent).toBe("Обучить MIDI");

    const first = adapter.addMapping({ target: "on", source: "cc", number: 40 })!;
    expect(on.textContent).toBe("CC 40");
    adapter.updateMapping(first.id, { number: 41 });
    expect(on.textContent).toBe("CC 41");
    const second = adapter.addMapping({ target: "on", source: "note", number: 70 })!;
    expect(on.textContent).toBe("CC 41 +1");
    adapter.removeMapping(first.id);
    expect(on.textContent).toBe("Note 70");
    adapter.removeMapping(second.id);
    expect(on.textContent).toBe("Обучить MIDI");

    const relative = adapter.addMapping({
      target: "level",
      source: "cc",
      number: 20,
      mode: "delta",
    })!;
    expect(level.textContent).toBe("CC 20 · Δ");
    adapter.removeMapping(relative.id);

    binder.dispose();
    adapter.dispose();
  });

  it("строчное обучение не подсвечивает inline-кнопку", () => {
    const { adapter, binder, root } = setup();
    adapter.setTraining(true);
    const row = adapter.addMapping({ target: "on", source: "cc", number: 40 })!;
    adapter.startLearn("on", row.id);
    const on = learnButton(root, "on");
    expect(on.getAttribute("aria-pressed")).toBe("false");
    expect(on.textContent).not.toBe("Жду MIDI…");
    binder.dispose();
    adapter.dispose();
  });

  it("метка цели обновляется на refresh (динамический label)", () => {
    const { adapter, binder, root, actions } = setup();
    adapter.setTraining(true);
    const ping = learnButton(root, "ping");
    actions.text = "Boom";
    binder.refresh();
    expect(ping.getAttribute("aria-label")).toContain("Boom");
    binder.dispose();
    adapter.dispose();
  });
});

describe("inline MIDI: повторные слоты и стабильность", () => {
  it("повторные цели раскладываются по стабильным кнопкам без пересоздания", () => {
    const env = new FakeMidiEnvironment();
    const params = registry();
    const adapter = new MidiAdapter({
      namespace: "repeat",
      params,
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
    });
    const root = document.createElement("div");
    appendParamSlot(root, "on", "checkbox");
    appendParamSlot(root, "on", "checkbox");
    const binder = bindMidiLearn({ root, adapter });
    adapter.setTraining(true);

    const before = [...root.querySelectorAll<HTMLButtonElement>('[data-target="on"]')];
    expect(before).toHaveLength(2);
    adapter.addMapping({ target: "on", source: "cc", number: 5 });
    binder.refresh();
    const after = [...root.querySelectorAll<HTMLButtonElement>('[data-target="on"]')];
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[0]!.textContent).toBe("CC 5");
    expect(after[1]!.textContent).toBe("CC 5");

    binder.dispose();
    adapter.dispose();
  });
});

describe("inline MIDI: отсутствие слотов и dispose", () => {
  it("нет слотов — no-op, ничего не добавляется", () => {
    const env = new FakeMidiEnvironment();
    const adapter = new MidiAdapter({
      namespace: "no-slots",
      params: registry(),
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
    });
    const root = document.createElement("div");
    const binder = bindMidiLearn({ root, adapter });
    adapter.setTraining(true);
    binder.refresh();
    expect(root.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    binder.dispose();
    expect(() => binder.dispose()).not.toThrow();
    adapter.dispose();
  });

  it("dispose снимает подписку и слушатели, старый ref не обучает, идемпотентен", () => {
    const { adapter, binder, root } = setup();
    adapter.setTraining(true);
    const on = learnButton(root, "on");
    binder.dispose();
    expect(root.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    expect(accessories(root).every((slot) => slot.hidden)).toBe(true);

    // Старая ссылка не обучает после dispose.
    on.click();
    expect(adapter.learningTarget).toBeNull();
    // Подписка снята: изменение состояния больше не воскрешает кнопки.
    adapter.addMapping({ target: "on" });
    expect(root.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    expect(() => binder.dispose()).not.toThrow();

    adapter.dispose();
  });

  it("независимость экземпляров: dispose одного binder не мешает другому", async () => {
    const a = setup();
    const b = setup();
    await b.adapter.connect();
    b.adapter.setTraining(true);
    const bOn = learnButton(b.root, "on");
    bOn.click();
    expect(b.adapter.learningTarget).toBe("on");

    a.binder.dispose();
    expect(a.root.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    expect(b.root.contains(bOn)).toBe(true);
    expect(b.adapter.learningTarget).toBe("on");

    b.binder.dispose();
    a.adapter.dispose();
    b.adapter.dispose();
  });

  it("ошибка подписки при построении откатывает кнопки и не оставляет подписку", () => {
    const { adapter, root } = setupUnbound();
    const subscribe = vi.spyOn(adapter, "subscribe").mockImplementation(() => {
      throw new Error("subscribe boom");
    });
    expect(() => bindMidiLearn({ root, adapter })).toThrow(/subscribe boom/);
    subscribe.mockRestore();
    expect(root.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    expect(accessories(root).every((slot) => slot.hidden)).toBe(true);
    adapter.dispose();
  });
});

/** Слоты без вызова bindMidiLearn — для проверки rollback. */
function setupUnbound() {
  const env = new FakeMidiEnvironment();
  const adapter = new MidiAdapter({
    namespace: "rollback",
    params: registry(),
    actions: new TestActions(),
    environment: env,
    storage: new MemoryMidiStorage(),
    lifetime: { disposed: false },
  });
  const root = document.createElement("div");
  appendParamSlot(root, "on", "checkbox");
  appendActionSlot(root, "ping");
  return { adapter, root };
}

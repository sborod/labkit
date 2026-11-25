// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ParameterRegistry } from "../../src/core/registry.ts";
import type { ParameterSpec } from "../../src/core/params.ts";
import { MidiAdapter, type MidiActionHost } from "../../src/midi/adapter.ts";
import { createMidiPanel } from "../../src/midi/panel.ts";
import { mountMidiWindow } from "../../src/midi/window.ts";
import { FakeMidiEnvironment } from "../../src/midi/testing.ts";
import { MemoryMidiStorage } from "../../src/midi/store.ts";

// Настоящие клики по панели (M4/M10/M11): draft-создание, строчное обучение и
// обновление монитора на несматченных сообщениях.

interface TestState {
  on: boolean;
  level: number;
}
function registry(): ParameterRegistry<TestState> {
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
  return new ParameterRegistry<TestState>({ on: false, level: 0 }, specs);
}
class Actions implements MidiActionHost {
  has(): boolean {
    return false;
  }
  ids(): string[] {
    return [];
  }
  isAvailable(): boolean {
    return true;
  }
  label(id: string): string {
    return id;
  }
  async execute(): Promise<void> {}
}

function setup() {
  const env = new FakeMidiEnvironment();
  const input = env.addInput("device");
  const adapter = new MidiAdapter({
    namespace: "panel",
    params: registry(),
    actions: new Actions(),
    environment: env,
    storage: new MemoryMidiStorage(),
    lifetime: { disposed: false },
  });
  const panel = createMidiPanel({ adapter });
  return { adapter, panel, env, input };
}

function findButton(root: HTMLElement, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

function channelSelect(row: HTMLElement): HTMLSelectElement {
  const select = [...row.querySelectorAll("select")].find((candidate) =>
    [...candidate.options].some((option) => option.textContent === "Любой"),
  );
  if (!select) throw new Error("channel select not found");
  return select;
}

describe("MIDI panel (M4/M10/M11)", () => {
  it("первый пустой список входов явно показывает «Нет устройств»", () => {
    const { adapter, panel } = setup();
    const select = panel.el.querySelector<HTMLSelectElement>("select")!;
    expect(select.disabled).toBe(true);
    expect(select.options).toHaveLength(1);
    expect(select.selectedOptions[0]!.textContent).toBe("Нет устройств");
    panel.dispose();
    adapter.dispose();
  });

  it("blur показывает отложенное canonical без следующего notify, а change сохраняет пользовательский ввод", () => {
    const { adapter, panel } = setup();
    const mapping = adapter.addMapping({ target: "level", number: 20 })!;
    document.body.append(panel.el);
    panel.el.querySelector("details")!.open = true;
    const input = panel.el.querySelector<HTMLInputElement>('input[type="number"]')!;
    input.focus();
    adapter.updateMapping(mapping.id, { number: 42 });
    expect(input.value).toBe("20");
    input.blur();
    expect(input.value).toBe("42");
    input.focus();
    input.value = "73";
    input.dispatchEvent(new Event("change"));
    input.blur();
    expect(input.value).toBe("73");
    expect(adapter.mappings()[0]!.number).toBe(73);
    panel.dispose();
    adapter.dispose();
  });

  it("сохраняет DOM, draft, фокус и раскрытие при learn/update другой строки", async () => {
    const { adapter, panel, input } = setup();
    document.body.append(panel.el);
    await adapter.connect();
    const first = adapter.addMapping({ target: "level", number: 20 })!;
    const second = adapter.addMapping({ target: "on", number: 21 })!;
    const row = panel.el.querySelector<HTMLElement>(".labkit-midi-mapping")!;
    const details = row.querySelector("details")!;
    details.open = true;
    const draft = row.querySelector<HTMLInputElement>('input[type="number"]')!;
    draft.focus();
    draft.value = "73";
    adapter.startLearn("on", second.id);
    input.emit([0xb3, 55, 80]);
    adapter.updateMapping(first.id, { channel: 2, mode: "twos" });
    expect(panel.el.querySelector(".labkit-midi-mapping")).toBe(row);
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe("73");
    expect(details.open).toBe(true);
    expect(channelSelect(row).value).toBe("2");
    expect(row.textContent).toContain("CC 20 · канал 2");
    panel.dispose();
    adapter.dispose();
  });

  it("окно не подключает автоматически; статусы/ошибки, ожидание и cleanup доступны снаружи", async () => {
    const { adapter, panel, env } = setup();
    env.supported = false;
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="labkit-header-actions"></div><button class="instrument">Instrument</button>';
    document.body.append(root);
    const unmount = mountMidiWindow(root, adapter, panel);
    const toggle = root.querySelector<HTMLButtonElement>("[aria-expanded]")!;
    const surface = root.querySelector<HTMLElement>('[role="dialog"]')!;
    const training = root.querySelector<HTMLButtonElement>(".labkit-midi-toolbar [aria-pressed]")!;
    toggle.click();
    expect(env.requestCount).toBe(0);
    expect(surface.hidden).toBe(false);
    training.click();
    expect(adapter.training).toBe(true);
    await adapter.connect();
    expect(toggle.textContent).toBe("MIDI · не поддерживается");
    expect(toggle.title).toContain(adapter.status.message);
    expect(adapter.status.kind).toBe("unsupported");
    const instrument = root.querySelector<HTMLButtonElement>(".instrument")!;
    instrument.focus();
    instrument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(surface.hidden).toBe(true);
    expect(document.activeElement).toBe(instrument);
    expect(adapter.training).toBe(true);
    unmount();
    expect(root.querySelector(".labkit-midi-toolbar, .labkit-midi-window")).toBeNull();
    const current = adapter.training;
    training.click();
    expect(adapter.training).toBe(current);
    panel.dispose();
    adapter.dispose();
    root.remove();
  });

  it("канал выбирается в каждой строке; верхнего селектора канала нет", () => {
    const { adapter, panel } = setup();
    // Верхний селектор «Все каналы» удалён: канал — свойство назначения.
    expect(
      [...panel.el.querySelectorAll("option")].some(
        (option) => option.textContent === "Все каналы",
      ),
    ).toBe(false);

    const mapping = adapter.addMapping({ target: "level", source: "cc", number: 20 })!;
    const row = panel.el.querySelector<HTMLElement>(".labkit-midi-mapping")!;
    const select = channelSelect(row);
    expect(select.options.length).toBe(17);
    expect(select.value).toBe("0");

    select.value = "3";
    select.dispatchEvent(new Event("change"));
    expect(adapter.mappings().find((candidate) => candidate.id === mapping.id)!.channel).toBe(3);

    const refreshed = channelSelect(panel.el.querySelector<HTMLElement>(".labkit-midi-mapping")!);
    expect(refreshed.value).toBe("3");
    refreshed.value = "0";
    refreshed.dispatchEvent(new Event("change"));
    expect(adapter.mappings().find((candidate) => candidate.id === mapping.id)!.channel).toBe(0);

    panel.dispose();
    adapter.dispose();
  });

  it("M4: кнопка добавления создаёт валидное назначение", () => {
    const { adapter, panel } = setup();
    findButton(panel.el, "+ Добавить").click();
    expect(adapter.mappings().length).toBe(1);
    panel.dispose();
    adapter.dispose();
  });

  it("M10: строчное обучение меняет именно эту строку и обновляет кнопки", async () => {
    const { adapter, panel, input } = setup();
    await adapter.connect();
    const first = adapter.addMapping({ target: "on", source: "cc", number: 40 })!;
    const second = adapter.addMapping({ target: "on", source: "note", number: 41 })!;
    const rows = panel.el.querySelectorAll(".labkit-midi-mapping");
    expect(rows.length).toBe(2);
    findButton(rows[1] as HTMLElement, "Обучить").click();
    expect(adapter.learningMappingId).toBe(second.id);

    // Кнопка обучения второй строки отражает ожидание (панель перестроена).
    const refreshed = panel.el.querySelectorAll(".labkit-midi-mapping");
    const secondLearn = findButton(refreshed[1] as HTMLElement, "Жду MIDI");
    expect(secondLearn.getAttribute("aria-pressed")).toBe("true");

    input.emit([0xb0, 99, 64]);
    const mappingFirst = adapter.mappings().find((m) => m.id === first.id)!;
    const mappingSecond = adapter.mappings().find((m) => m.id === second.id)!;
    expect(mappingFirst.number).toBe(40);
    expect(mappingSecond.number).toBe(99);
    panel.dispose();
    adapter.dispose();
  });

  it("P-all: пункт «Все входы» включает прослушивание всех входов", async () => {
    const env = new FakeMidiEnvironment();
    env.addInput("one", "One");
    env.addInput("two", "Two");
    const adapter = new MidiAdapter({
      namespace: "panel-all",
      params: registry(),
      actions: new Actions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
    });
    const panel = createMidiPanel({ adapter });
    await adapter.connect();

    const select = panel.el.querySelector<HTMLSelectElement>("select")!;
    const all = [...select.options].find((option) => option.textContent === "Все входы");
    expect(all).toBeDefined();
    select.value = all!.value;
    select.dispatchEvent(new Event("change"));

    expect(adapter.allInputs).toBe(true);
    expect(adapter.listeningInputIds().sort()).toEqual(["one", "two"]);
    expect(select.value).toBe(all!.value);
    panel.dispose();
    adapter.dispose();
  });

  it("M11: монитор обновляется на несматченных валидных сообщениях", async () => {
    const { adapter, panel, input } = setup();
    await adapter.connect();
    const monitor = panel.el.querySelector(".labkit-midi-monitor")!;
    input.emit([0xb0, 88, 127]);
    expect(monitor.textContent).toContain("CC 88");
    expect(monitor.textContent).toContain("127");
    panel.dispose();
    adapter.dispose();
  });

  it("P3: метка цели в строке перерисовывается при refresh", () => {
    class LabelActions implements MidiActionHost {
      text = "Before";
      has(id: string): boolean {
        return id === "act";
      }
      ids(): string[] {
        return ["act"];
      }
      isAvailable(): boolean {
        return true;
      }
      label(): string {
        return this.text;
      }
      async execute(): Promise<void> {}
    }
    const env = new FakeMidiEnvironment();
    const actions = new LabelActions();
    const adapter = new MidiAdapter({
      namespace: "label-cache",
      params: registry(),
      actions,
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
    });
    adapter.addMapping({ target: "act" });
    const panel = createMidiPanel({ adapter });
    actions.text = "After";
    panel.refresh();
    const option = panel.el.querySelector('.labkit-midi-mapping option[value="act"]')!;
    expect(option.textContent).toBe("After");
    panel.dispose();
    adapter.dispose();
  });

  it("панель не дублирует inline и верхнюю кнопку глобального обучения", () => {
    const { adapter, panel } = setup();
    adapter.setTraining(true);
    expect(panel.el.querySelector(".labkit-midi-targets")).toBeNull();
    expect(panel.el.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    expect(
      [...panel.el.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Обучение MIDI"),
      ),
    ).toBe(false);
    const statuses = [...panel.el.querySelectorAll('[role="status"]')];
    expect(statuses.some((el) => el.classList.contains("labkit-midi-status"))).toBe(true);
    panel.dispose();
    adapter.dispose();
  });
});

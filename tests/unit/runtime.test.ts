// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParameterRegistry } from "../../src/core/registry.ts";
import { createLab, type LabErrorEvent, type LabInstance } from "../../src/runtime/createLab.ts";
import { CapabilityError, type CapabilityReport } from "../../src/runtime/capabilities.ts";
import type { LabDefinition } from "../../src/runtime/definition.ts";
import { LabDefinitionError } from "../../src/runtime/validation.ts";

interface Demo {
  n: number;
}

let bumpCount = 0;
let renderCount = 0;

function definition(): LabDefinition<Demo> {
  return {
    contractVersion: "0.1",
    id: "demo",
    title: "Demo",
    capabilities: { required: ["canvas"] },
    model: { createState: () => ({ n: 0 }) },
    parameters: {
      n: {
        kind: "number",
        id: "n",
        label: "N",
        min: 0,
        max: 10,
        step: 1,
        read: (state) => state.n,
        write: (state, value) => {
          state.n = value;
        },
      },
    },
    actions: {
      bump: {
        id: "bump",
        label: "Bump",
        run: (ctx) => {
          bumpCount += 1;
          ctx.params.set("n", ctx.state.n + 1, ctx.origin);
          ctx.requestRender();
        },
      },
    },
    readouts: { value: (state) => `n=${state.n}` },
    views: {
      plot: {
        render: () => {
          renderCount += 1;
        },
      },
    },
    hooks: { onChange: (ctx) => ctx.requestRender() },
    layout: {
      controls: [
        {
          kind: "group",
          children: [
            { kind: "control", param: "n" },
            { kind: "action", action: "bump" },
          ],
        },
      ],
      workspace: [
        {
          kind: "group",
          children: [
            { kind: "panel", view: "plot" },
            { kind: "readout", id: "value" },
          ],
        },
      ],
    },
  };
}

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

interface ResizeObserverTracker {
  constructed: number;
  disconnected: number;
  restore(): void;
}

function trackResizeObserver(): ResizeObserverTracker {
  const original = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  const tracker: ResizeObserverTracker = {
    constructed: 0,
    disconnected: 0,
    restore: () => {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    },
  };
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor() {
      tracker.constructed += 1;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      tracker.disconnected += 1;
    }
  };
  return tracker;
}

beforeEach(() => {
  bumpCount = 0;
  renderCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLab: экземпляры и жизненный цикл", () => {
  it("toolbar и закрытые группы готовы к setup; toggle не пересоздаёт контролы и owned listeners снимаются", async () => {
    const def = definition();
    def.layout.variant = "instrument";
    def.layout.toolbar = [{ kind: "action", action: "bump" }];
    def.layout.controls = [
      {
        kind: "group",
        title: "Advanced",
        collapsible: true,
        collapsed: true,
        children: [{ kind: "control", param: "n" }],
      },
    ];
    const setup = vi.fn((ctx) => {
      expect(ctx.root.querySelector('[data-labkit-action-accessory="bump"]')).not.toBeNull();
      expect(ctx.root.querySelector('[data-labkit-param-accessory="n"]')).not.toBeNull();
      return undefined;
    });
    def.hooks = { ...def.hooks, setup };
    const instance = createLab(def, host());
    const details = instance.root.querySelector("details")!;
    expect(details.open).toBe(false);
    const control = details.querySelector('[role="slider"]')!;
    instance.params.set("n", 7, "api");
    await Promise.resolve();
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(details.querySelector('[role="slider"]')).toBe(control);
    expect(control.getAttribute("aria-valuenow")).toBe("7");
    expect(setup).toHaveBeenCalledOnce();
    const button = instance.root.querySelector<HTMLButtonElement>(".labkit-toolbar button")!;
    button.click();
    await Promise.resolve();
    expect(instance.state.n).toBe(8);
    await instance.dispose();
    button.click();
    details.dispatchEvent(new Event("toggle"));
    expect(instance.state.n).toBe(8);
  });

  it("header, toolbar, окно и accessory-слоты готовы в setup; render и раскрытие не пересоздают DOM", async () => {
    const def = definition();
    def.layout.variant = "instrument";
    def.layout.header = [
      { kind: "action", action: "bump" },
      {
        kind: "window",
        title: "About",
        children: [
          {
            kind: "group",
            title: "Controls",
            children: [
              { kind: "control", param: "n" },
              { kind: "action", action: "bump" },
            ],
          },
          { kind: "group", title: "Plot", children: [{ kind: "panel", view: "plot", aspect: 2 }] },
        ],
      },
    ];
    def.layout.toolbar = [{ kind: "action", action: "bump" }];
    def.layout.controls = [
      {
        kind: "group",
        title: "Main",
        children: [
          { kind: "control", param: "n" },
          { kind: "action", action: "bump" },
        ],
      },
    ];

    let atSetup: {
      header: boolean;
      headerActionAccessory: boolean;
      toolbar: boolean;
      toolbarActionAccessory: boolean;
      window: boolean;
      trigger: boolean;
      navButtons: number;
      windowControl: boolean;
      windowControlAccessory: boolean;
    } | null = null;
    def.hooks = {
      ...def.hooks,
      setup: (ctx) => {
        atSetup = {
          header: Boolean(ctx.root.querySelector(".labkit-header")),
          headerActionAccessory: Boolean(
            ctx.root.querySelector('.labkit-header [data-labkit-action-accessory="bump"]'),
          ),
          toolbar: Boolean(ctx.root.querySelector('.labkit-toolbar[role="region"]')),
          toolbarActionAccessory: Boolean(
            ctx.root.querySelector('.labkit-toolbar [data-labkit-action-accessory="bump"]'),
          ),
          window: Boolean(ctx.root.querySelector('.labkit-information-window[role="dialog"]')),
          trigger: Boolean(ctx.root.querySelector(".labkit-header [aria-controls]")),
          navButtons: ctx.root.querySelectorAll(".labkit-information-nav button").length,
          windowControl: Boolean(
            ctx.root.querySelector('.labkit-information-body [data-param="n"]'),
          ),
          windowControlAccessory: Boolean(
            ctx.root.querySelector('.labkit-information-body [data-labkit-param-accessory="n"]'),
          ),
        };
        return undefined;
      },
    };

    const container = host();
    const instance = createLab(def, container);
    expect(atSetup).not.toBeNull();
    expect(atSetup!.header).toBe(true);
    expect(atSetup!.headerActionAccessory).toBe(true);
    expect(atSetup!.toolbar).toBe(true);
    expect(atSetup!.toolbarActionAccessory).toBe(true);
    expect(atSetup!.window).toBe(true);
    expect(atSetup!.trigger).toBe(true);
    expect(atSetup!.navButtons).toBe(2);
    expect(atSetup!.windowControl).toBe(true);
    expect(atSetup!.windowControlAccessory).toBe(true);

    const trigger = container.querySelector<HTMLButtonElement>(".labkit-header [aria-controls]")!;
    const info = container.querySelector<HTMLElement>(".labkit-information-window")!;
    const nav = info.querySelector(".labkit-information-nav")!;
    const windowControl = info.querySelector('[data-param="n"]')!;
    const headerAction = container.querySelector('.labkit-header [data-action="bump"]')!;
    const toolbarAction = container.querySelector('.labkit-toolbar [data-action="bump"]')!;

    expect(info.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    instance.render();
    trigger.click();
    expect(info.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    instance.render();
    trigger.click();
    expect(info.hidden).toBe(true);
    trigger.click();
    expect(info.hidden).toBe(false);

    expect(container.querySelector(".labkit-information-window")).toBe(info);
    expect(container.querySelector(".labkit-information-nav")).toBe(nav);
    expect(info.querySelector('[data-param="n"]')).toBe(windowControl);
    expect(container.querySelector('.labkit-header [data-action="bump"]')).toBe(headerAction);
    expect(container.querySelector('.labkit-toolbar [data-action="bump"]')).toBe(toolbarAction);

    await instance.dispose();
    expect(container.querySelector(".labkit-information-window")).toBeNull();
    expect(container.querySelector(".labkit-header [aria-controls]")).toBeNull();
  });

  it("монтирует root и canvas", async () => {
    const container = host();
    const instance = createLab(definition(), container);
    expect(container.querySelector(".labkit")).not.toBeNull();
    expect(container.querySelector("canvas")).not.toBeNull();
    await instance.dispose();
  });

  it("два независимых экземпляра не влияют друг на друга", async () => {
    const a = createLab(definition(), host());
    const b = createLab(definition(), host());
    a.params.set("n", 5, "api");
    expect(a.state.n).toBe(5);
    expect(b.state.n).toBe(0);
    await a.dispose();
    expect(b.state.n).toBe(0);
    await b.dispose();
  });

  it("dispose идемпотентный, awaitable и удаляет root", async () => {
    const container = host();
    const instance = createLab(definition(), container);
    const first = instance.dispose();
    const second = instance.dispose();
    expect(first).toBe(second);
    await first;
    expect(instance.disposed).toBe(true);
    expect(container.querySelector(".labkit")).toBeNull();
  });

  it("mount → dispose → remount без остатков", async () => {
    const container = host();
    const first = createLab(definition(), container);
    await first.dispose();
    const second = createLab(definition(), container);
    expect(container.querySelectorAll(".labkit")).toHaveLength(1);
    await second.dispose();
  });

  it("действие меняет состояние, readout обновляется после render", async () => {
    const container = host();
    const instance = createLab(definition(), container);
    await instance.actions.execute("bump", "ui");
    instance.render();
    expect(instance.state.n).toBe(1);
    expect(container.querySelector(".labkit-readout-text")?.textContent).toBe("n=1");
    await instance.dispose();
  });

  it("отсутствие обязательной возможности — явная ошибка", () => {
    const report: CapabilityReport = {
      canvas: { supported: false, reason: "нет canvas (тест)" },
      audioContext: { supported: false, reason: "тест" },
      audioWorklet: { supported: false, reason: "тест" },
      worker: { supported: false, reason: "тест" },
      midi: { supported: false, reason: "тест" },
    };
    expect(() => createLab(definition(), host(), { capabilities: report })).toThrow(
      CapabilityError,
    );
  });
});

describe("createLab: завершение после dispose", () => {
  it("отложенный render и hooks не выполняются после dispose", async () => {
    const container = host();
    const instance = createLab(definition(), container);
    await instance.dispose();
    const renders = renderCount;

    instance.render();
    instance.params.set("n", 9, "api");
    await Promise.resolve();
    await Promise.resolve();
    expect(renderCount).toBe(renders);
    expect(instance.state.n).toBe(9); // состояние модели не «защищено», но UI не трогаем
  });

  it("action-и обработчики не выполняются после dispose", async () => {
    const container = host();
    const instance = createLab(definition(), container);
    const button = container.querySelector<HTMLButtonElement>('[data-action="bump"]');
    const bumps = bumpCount;
    await instance.dispose();
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(instance.actions.execute("bump", "ui")).rejects.toThrow(/освобождён/);
    expect(bumpCount).toBe(bumps);
  });

  it("timeline после dispose терминален", async () => {
    const instance = createLab(definition(), host());
    await instance.dispose();
    expect(instance.timeline.isRunning).toBe(false);
    expect(() => instance.timeline.start()).toThrow(/освобождён/);
    expect(() => instance.timeline.toggle()).toThrow(/освобождён/);
    expect(() => instance.timeline.stop()).not.toThrow();
  });
});

describe("createLab: отсутствие утечек при ошибке", () => {
  it("ошибка отрисовки освобождает частично смонтированные ресурсы", () => {
    const tracker = trackResizeObserver();
    const container = host();
    const broken = definition();
    broken.views = {
      plot: {
        render: () => {
          throw new Error("render boom");
        },
      },
    };
    expect(() => createLab(broken, container)).toThrow(/render boom/);
    expect(container.querySelector(".labkit")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(tracker.constructed).toBeGreaterThan(0);
    expect(tracker.disconnected).toBe(tracker.constructed);
    tracker.restore();
  });

  it("невалидное описание отвергается до создания ресурсов", () => {
    const tracker = trackResizeObserver();
    const container = host();
    const invalid = { ...definition() } as Record<string, unknown>;
    delete invalid.contractVersion;
    expect(() => createLab(invalid as unknown as LabDefinition<Demo>, container)).toThrow(
      LabDefinitionError,
    );
    expect(container.childElementCount).toBe(0);
    expect(tracker.constructed).toBe(0);
    tracker.restore();
  });

  it("невалидные hooks отвергаются до создания ресурсов", () => {
    for (const hooks of [
      { onChange: 42 },
      { animation: { step: 42 } },
      { animation: {} },
      { animation: 42 },
    ]) {
      const tracker = trackResizeObserver();
      const container = host();
      const invalid = definition() as unknown as Record<string, unknown>;
      invalid.hooks = hooks;
      expect(() => createLab(invalid as unknown as LabDefinition<Demo>, container)).toThrow(
        LabDefinitionError,
      );
      expect(container.childElementCount).toBe(0);
      expect(tracker.constructed).toBe(0);
      tracker.restore();
    }
  });
});

class FakeFrames {
  #callbacks = new Map<number, (ts: number) => void>();
  #next = 1;

  schedule = (callback: (ts: number) => void): number => {
    const id = this.#next++;
    this.#callbacks.set(id, callback);
    return id;
  };

  cancel = (id: number): void => {
    this.#callbacks.delete(id);
  };

  get pending(): number {
    return this.#callbacks.size;
  }

  tick(ts: number): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) {
      callback(ts);
    }
  }
}

describe("createLab: видимый канал ошибок выполнения", () => {
  it("ошибка отрисовки на втором вызове видна и не бросает", async () => {
    const container = host();
    let shouldThrow = false;
    let calls = 0;
    const def = definition();
    def.views = {
      plot: {
        render: () => {
          calls += 1;
          if (shouldThrow) {
            throw new Error("render boom");
          }
        },
      },
    };
    const errors: LabErrorEvent[] = [];
    const instance = createLab(def, container, {
      onError: (event) => errors.push(event),
    });
    await Promise.resolve(); // сливаем монтажную инвалидацию поверхности
    const before = calls;
    shouldThrow = true;
    expect(() => instance.render()).not.toThrow();
    expect(calls).toBeGreaterThan(before);
    const banner = container.querySelector<HTMLElement>('[role="alert"]');
    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toContain("render");
    expect(errors.some((event) => event.phase === "render")).toBe(true);
    await instance.dispose();
  });

  it("ошибка действия при клике видна", async () => {
    const container = host();
    const def = definition();
    def.actions = {
      bump: {
        id: "bump",
        label: "Bump",
        run: () => {
          throw new Error("action boom");
        },
      },
    };
    const errors: LabErrorEvent[] = [];
    const instance = createLab(def, container, {
      onError: (event) => errors.push(event),
    });
    const button = container.querySelector<HTMLButtonElement>('[data-action="bump"]');
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.some((event) => event.phase === "action")).toBe(true);
    expect(container.querySelector<HTMLElement>('[role="alert"]')?.hidden).toBe(false);
    await instance.dispose();
  });

  it("ошибка onChange видна и не роняет registry.set", async () => {
    const container = host();
    const def = definition();
    def.hooks = {
      onChange: () => {
        throw new Error("hook boom");
      },
    };
    const errors: LabErrorEvent[] = [];
    const instance = createLab(def, container, {
      onError: (event) => errors.push(event),
    });
    expect(() => instance.params.set("n", 3, "api")).not.toThrow();
    expect(instance.state.n).toBe(3);
    expect(errors.some((event) => event.phase === "hook")).toBe(true);
    await instance.dispose();
  });

  it("ошибка animation.step останавливает таймлайн и не оставляет кадров", async () => {
    const frames = new FakeFrames();
    const container = host();
    const def = definition();
    def.hooks = {
      animation: {
        step: () => {
          throw new Error("anim boom");
        },
      },
    };
    const errors: LabErrorEvent[] = [];
    const instance = createLab(def, container, {
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      onError: (event) => errors.push(event),
    });
    instance.timeline.start();
    frames.tick(0);
    frames.tick(16);
    expect(instance.timeline.isRunning).toBe(false);
    expect(frames.pending).toBe(0);
    expect(errors.some((event) => event.phase === "animation")).toBe(true);
    expect(container.querySelector<HTMLElement>('[role="alert"]')?.hidden).toBe(false);
    await instance.dispose();
  });
});

describe("createLab: поздние ошибки и очистка монтирования", () => {
  it("поздняя ошибка действия после dispose не трогает UI/onError", async () => {
    const container = host();
    let rejectAction: (error: unknown) => void = () => {};
    const def = definition();
    def.actions = {
      bump: {
        id: "bump",
        label: "Bump",
        run: () =>
          new Promise<void>((_resolve, reject) => {
            rejectAction = reject;
          }),
      },
    };
    const errors: LabErrorEvent[] = [];
    const instance = createLab(def, container, { onError: (event) => errors.push(event) });
    const button = container.querySelector<HTMLButtonElement>('[data-action="bump"]');
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await instance.dispose();
    rejectAction(new Error("late action boom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.length).toBe(0);
    expect(container.querySelector(".labkit")).toBeNull();
  });

  it("hooks.animation без step отвергается до createState", () => {
    let created = false;
    const def = definition();
    def.model = {
      createState: () => {
        created = true;
        return { n: 0 };
      },
    };
    def.hooks = { animation: {} } as unknown as LabDefinition<Demo>["hooks"];
    expect(() => createLab(def, host())).toThrow(LabDefinitionError);
    expect(created).toBe(false);
  });

  it("ошибка монтирования + падение disconnect: слушатели сняты, очистка наблюдаема", async () => {
    const originalObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    const win = window as unknown as {
      removeEventListener: (...args: unknown[]) => void;
    };
    const originalRemove = win.removeEventListener;
    const removed: string[] = [];
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        throw new Error("disconnect boom");
      }
    };
    win.removeEventListener = (...args: unknown[]) => {
      removed.push(String(args[0]));
      originalRemove.apply(window, args);
    };

    const container = host();
    const broken = definition();
    broken.views = {
      plot: {
        render: () => {
          throw new Error("render boom");
        },
      },
    };
    const errors: LabErrorEvent[] = [];
    try {
      expect(() =>
        createLab(broken, container, { onError: (event) => errors.push(event) }),
      ).toThrow(/render boom/);
      // Все остальные освободители выполнены, несмотря на падение disconnect.
      expect(container.querySelector(".labkit")).toBeNull();
      expect(removed).toContain("resize");

      await Promise.resolve();
      await Promise.resolve();
      const cleanup = errors.find((event) => event.phase === "cleanup");
      expect(cleanup).toBeTruthy();
      const aggregate = cleanup?.error as AggregateError;
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect(aggregate.cause).toBeInstanceOf(Error);
      expect((aggregate.cause as Error).message).toContain("render boom");
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = originalObserver;
      win.removeEventListener = originalRemove;
    }
  });
});

describe("createLab: render обновляет контролы без registry.set", () => {
  interface Scene {
    points: Array<{ x: number; y: number; active: boolean }>;
    selection: number;
  }

  function sceneDefinition(): LabDefinition<Scene> {
    return {
      contractVersion: "0.1",
      id: "scene",
      title: "Scene",
      model: {
        createState: () => ({
          points: [
            { x: 1, y: 2, active: true },
            { x: 7, y: 8, active: false },
          ],
          selection: 0,
        }),
      },
      parameters: {
        // Значения — proxy: читаются из выбранной точки, а не хранятся в
        // отдельном зеркале. Смена selection меняет read() без записи.
        x: {
          kind: "number",
          id: "x",
          label: "X",
          min: 0,
          max: 10,
          step: 1,
          read: (s) => s.points[s.selection]!.x,
          write: (s, value) => {
            s.points[s.selection]!.x = value;
          },
        },
        y: {
          kind: "number",
          id: "y",
          label: "Y",
          min: 0,
          max: 10,
          step: 1,
          available: (s) => s.points[s.selection]!.active,
          read: (s) => s.points[s.selection]!.y,
          write: (s, value) => {
            s.points[s.selection]!.y = value;
          },
        },
      },
      actions: {
        next: {
          id: "next",
          label: "Next",
          run: (ctx) => {
            // НЕ пишет зеркальные params и не инициирует события реестра.
            ctx.state.selection = (ctx.state.selection + 1) % ctx.state.points.length;
            ctx.requestRender();
          },
        },
      },
      readouts: { selection: (s) => `#${s.selection}` },
      hooks: { onChange: () => events.push("change") },
      layout: {
        controls: [
          { kind: "control", param: "x" },
          { kind: "control", param: "y" },
          { kind: "action", action: "next" },
        ],
        workspace: [{ kind: "readout", id: "selection" }],
      },
    };
  }

  const events: string[] = [];

  beforeEach(() => {
    events.length = 0;
  });

  it("действие меняет selection: контролы синхронизируются на render без registry.set и событий", async () => {
    const container = host();
    const instance = createLab(sceneDefinition(), container);
    const setSpy = vi.spyOn(instance.params, "set");
    const x = container.querySelector<HTMLButtonElement>('[data-param="x"]')!;
    const y = container.querySelector<HTMLButtonElement>('[data-param="y"]')!;

    // Исходная выбранная точка №0.
    expect(x.getAttribute("aria-valuenow")).toBe("1");
    expect(x.previousElementSibling?.textContent).toBe("X"); // label сохранён
    expect(y.getAttribute("aria-valuenow")).toBe("2");
    expect(y.disabled).toBe(false);
    const button = container.querySelector<HTMLButtonElement>('[data-action="next"]')!;
    expect(button.textContent).toBe("Next");
    expect(button.disabled).toBe(false);

    await instance.actions.execute("next", "ui");
    instance.render(); // renderOnce должен сам синхронизировать контролы

    expect(instance.state.selection).toBe(1);
    expect(x.getAttribute("aria-valuenow")).toBe("7"); // stale без обновления контролов на render
    expect(y.getAttribute("aria-valuenow")).toBe("8");
    expect(y.disabled).toBe(true); // available пересчитан для новой точки
    expect(x.previousElementSibling?.textContent).toBe("X");
    expect(button.textContent).toBe("Next");
    expect(setSpy).not.toHaveBeenCalled(); // никакой зеркальной записи
    expect(events).toEqual([]); // никаких событий реестра
    expect(container.querySelector(".labkit-readout-text")?.textContent).toBe("#1");
    await instance.dispose();
  });

  it("user-ввод после смены источника пишет в новую выбранную точку", async () => {
    const container = host();
    const instance = createLab(sceneDefinition(), container);
    await instance.actions.execute("next", "ui");
    instance.render();
    const x = container.querySelector<HTMLButtonElement>('[data-param="x"]')!;
    // Выбрана точка №1 (x=7): контрол показывает именно её, запись идёт туда же.
    expect(x.getAttribute("aria-valuenow")).toBe("7");
    x.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    x.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(instance.state.points[0]!.x).toBe(1);
    expect(instance.state.points[1]!.x).toBe(9);
    await instance.dispose();
  });
});

describe("createLab: стабильный DOM-маркер вида", () => {
  it("hooks.setup видит маркеры обоих views до первой отрисовки; маркеры сохраняются при отрисовках", async () => {
    const container = host();
    let renders = 0;
    const readMarkers = (): string[] =>
      [...container.querySelectorAll<HTMLCanvasElement>("canvas[data-labkit-view]")].map(
        (canvas) => canvas.dataset.labkitView ?? "",
      );
    let markersAtSetup: string[] = [];
    let rendersAtSetup = -1;
    const def: LabDefinition<Demo> = {
      contractVersion: "0.1",
      id: "markers",
      title: "Markers",
      capabilities: { required: ["canvas"] },
      model: { createState: () => ({ n: 0 }) },
      parameters: {},
      views: {
        first: {
          render: () => {
            renders += 1;
          },
        },
        second: {
          render: () => {
            renders += 1;
          },
        },
      },
      hooks: {
        setup: () => {
          markersAtSetup = readMarkers();
          rendersAtSetup = renders;
          return undefined;
        },
      },
      layout: {
        controls: [],
        workspace: [
          { kind: "panel", view: "first" },
          { kind: "panel", view: "second" },
        ],
      },
    };

    const instance = createLab(def, container);
    // setup выполняется до first render: view-функции ещё не звались, а маркеры
    // обоих каналов уже стоят в DOM.
    expect(markersAtSetup).toEqual(["first", "second"]);
    expect(rendersAtSetup).toBe(0);
    expect(readMarkers()).toEqual(["first", "second"]);

    const rendersAfterMount = renders;
    instance.render();
    instance.render();
    expect(renders).toBeGreaterThan(rendersAfterMount);
    expect(readMarkers()).toEqual(["first", "second"]);
    await instance.dispose();
  });
});

describe("createLab: className контролов и навигация окна", () => {
  interface VisibilityDemo {
    value: number;
    show: boolean;
  }

  function visibilityDefinition(): LabDefinition<VisibilityDemo> {
    return {
      contractVersion: "0.1",
      id: "class-visibility",
      title: "Class visibility",
      model: { createState: () => ({ value: 3, show: false }) },
      parameters: {
        value: {
          kind: "number",
          id: "value",
          label: "Value",
          min: 0,
          max: 10,
          step: 1,
          visible: (state) => state.show,
          read: (state) => state.value,
          write: (state, value) => {
            state.value = value;
          },
        },
        show: {
          kind: "boolean",
          id: "show",
          label: "Show",
          read: (state) => state.show,
          write: (state, value) => {
            state.show = value;
          },
        },
      },
      actions: {
        reveal: {
          id: "reveal",
          label: "Reveal",
          run: (ctx) => {
            // Прямая запись модели без registry.set; UI обновится через requestRender.
            ctx.state.show = true;
            ctx.requestRender();
          },
        },
      },
      layout: {
        controls: [
          { kind: "control", param: "value", className: "class-visibility-cell" },
          { kind: "control", param: "show" },
        ],
        workspace: [],
      },
    };
  }

  function classedParts(instance: LabInstance<VisibilityDemo>): {
    cell: HTMLElement;
    control: HTMLElement;
    slider: HTMLElement;
  } {
    const cell = instance.root.querySelector<HTMLElement>(".class-visibility-cell");
    const control = cell?.querySelector<HTMLElement>(".labkit-control") ?? null;
    const slider = cell?.querySelector<HTMLElement>('[role="slider"]') ?? null;
    if (!cell || !control || !slider) throw new Error("classed control is not mounted");
    return { cell, control, slider };
  }

  it("className-обёртка скрыта уже в setup и синхронно следует visible любого origin", async () => {
    let atSetup: { wrapperHidden: boolean; controlHidden: boolean } | null = null;
    const def = visibilityDefinition();
    def.hooks = {
      setup: (ctx) => {
        const cell = ctx.root.querySelector<HTMLElement>(".class-visibility-cell");
        const control = cell?.querySelector<HTMLElement>(".labkit-control");
        atSetup = {
          wrapperHidden: cell?.hidden ?? false,
          controlHidden: control?.hidden ?? false,
        };
        return undefined;
      },
    };
    const instance = createLab(def, host());
    expect(atSetup).toEqual({ wrapperHidden: true, controlHidden: true });

    const { cell, control } = classedParts(instance);
    expect(cell.hidden).toBe(true);

    instance.params.set("show", true, "midi");
    expect(cell.hidden).toBe(false);
    expect(control.hidden).toBe(false);

    instance.params.set("show", false, "api");
    expect(cell.hidden).toBe(true);
    expect(control.hidden).toBe(true);

    await instance.dispose();
  });

  it("render()/requestRender без registry-события синхронизируют className-обёртку и не пересоздают DOM", async () => {
    const instance = createLab(visibilityDefinition(), host());
    const { cell, slider } = classedParts(instance);

    // ctx.requestRender из действия: модель изменена напрямую, события реестра нет.
    await instance.actions.execute("reveal", "ui");
    await Promise.resolve();
    await Promise.resolve();
    expect(cell.hidden).toBe(false);

    instance.params.set("show", false, "api");
    expect(cell.hidden).toBe(true);

    instance.state.show = true;
    instance.render();
    expect(cell.hidden).toBe(false);
    instance.params.set("value", 7, "api");
    expect(cell.hidden).toBe(false);

    expect(instance.root.querySelector(".class-visibility-cell")).toBe(cell);
    expect(cell.querySelector('[role="slider"]')).toBe(slider);
    expect(slider.getAttribute("aria-valuenow")).toBe("7");

    await instance.dispose();
    expect(cell.isConnected).toBe(false);
    expect(() => instance.params.set("show", false, "api")).not.toThrow();
    expect(cell.hidden).toBe(false); // после dispose UI не обновляется
  });

  it("failed mount отписывает все registry-подписки, включая className visibility", () => {
    let params: ParameterRegistry<VisibilityDemo> | null = null;
    let wrapper: HTMLElement | null = null;
    let control: HTMLElement | null = null;
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const originalSubscribe = ParameterRegistry.prototype.subscribe;
    vi.spyOn(ParameterRegistry.prototype, "subscribe").mockImplementation(function (
      this: ParameterRegistry<VisibilityDemo>,
      listener,
    ) {
      const unsubscribe = originalSubscribe.call(this, listener);
      const tracked = vi.fn(unsubscribe);
      unsubscribes.push(tracked);
      return tracked;
    });

    const def = visibilityDefinition();
    def.hooks = {
      setup: (ctx) => {
        params = ctx.params;
        wrapper = ctx.root.querySelector<HTMLElement>(".class-visibility-cell");
        control = wrapper?.querySelector<HTMLElement>(".labkit-control") ?? null;
        throw new Error("setup boom");
      },
    };

    const container = host();
    expect(() => createLab(def, container)).toThrow(/setup boom/);
    expect(container.querySelector(".labkit")).toBeNull();
    expect(wrapper).not.toBeNull();
    expect(control).not.toBeNull();
    expect(unsubscribes.length).toBeGreaterThan(0);
    expect(unsubscribes.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);

    const cell = wrapper!;
    const controlEl = control!;
    expect(cell.isConnected).toBe(false);
    expect(cell.hidden).toBe(true);
    expect(() => params!.set("show", true, "api")).not.toThrow();
    expect(cell.hidden).toBe(true);
    expect(controlEl.hidden).toBe(true);
  });

  function navigationDefinition(wrap: boolean): LabDefinition<Demo> {
    const def = definition();
    def.layout.controls = [];
    def.layout.workspace = [];
    const className = wrap ? "nav-section" : undefined;
    def.layout.header = [
      {
        kind: "window",
        title: "About",
        children: [
          {
            kind: "group",
            title: "Section A",
            className,
            children: [
              { kind: "note", text: "A" },
              { kind: "group", title: "Nested A", children: [{ kind: "note", text: "nested" }] },
              { kind: "group", children: [{ kind: "note", text: "untitled nested" }] },
            ],
          },
          { kind: "group", title: "Section B", className, children: [{ kind: "note", text: "B" }] },
          { kind: "group", children: [{ kind: "note", text: "untitled direct" }] },
          {
            kind: "window",
            title: "Inner",
            children: [
              {
                kind: "group",
                title: "Inner A",
                className,
                children: [{ kind: "note", text: "ia" }],
              },
              {
                kind: "group",
                title: "Inner B",
                className,
                children: [{ kind: "note", text: "ib" }],
              },
            ],
          },
        ],
      },
    ];
    return def;
  }

  function navigationWindow(
    children: LabDefinition<Demo>["layout"]["controls"],
  ): LabDefinition<Demo> {
    const def = definition();
    def.layout.controls = [];
    def.layout.workspace = [];
    def.layout.header = [{ kind: "window", title: "About", children }];
    return def;
  }

  function informationWindow(root: HTMLElement, title: string): HTMLElement {
    const el = root.querySelector<HTMLElement>(`.labkit-information-window[aria-label="${title}"]`);
    if (!el) throw new Error(`information window "${title}" is not mounted`);
    return el;
  }

  function navLabels(root: HTMLElement, title: string): string[] {
    return [
      ...informationWindow(root, title).querySelectorAll<HTMLButtonElement>(
        ".labkit-information-nav button",
      ),
    ].map((button) => button.textContent ?? "");
  }

  it("навигация окна идёт по прямым озаглавленным группам сквозь className, но не во вложенные группы/окна", async () => {
    const wrapped = createLab(navigationDefinition(true), host());
    const plain = createLab(navigationDefinition(false), host());

    expect(navLabels(wrapped.root, "About")).toEqual(["Section A", "Section B"]);
    expect(navLabels(plain.root, "About")).toEqual(["Section A", "Section B"]);
    expect(navLabels(wrapped.root, "Inner")).toEqual(["Inner A", "Inner B"]);
    expect(navLabels(plain.root, "Inner")).toEqual(["Inner A", "Inner B"]);

    const about = informationWindow(wrapped.root, "About");
    expect(about.querySelectorAll(".labkit-information-nav button")).toHaveLength(2);
    expect(about.textContent).toContain("untitled nested");

    await wrapped.dispose();
    await plain.dispose();
  });

  it("навигация имеет порог две eligible-группы; collapsible и нетитулованные не считаются", async () => {
    const one = createLab(
      navigationWindow([
        { kind: "group", title: "Only", children: [{ kind: "note", text: "one" }] },
        { kind: "group", children: [{ kind: "note", text: "untitled" }] },
      ]),
      host(),
    );
    expect(one.root.querySelector(".labkit-information-nav")).toBeNull();

    const collapsible = createLab(
      navigationWindow([
        { kind: "group", title: "Closed", collapsible: true, collapsed: true, children: [] },
        { kind: "group", title: "Open", children: [] },
      ]),
      host(),
    );
    expect(collapsible.root.querySelector(".labkit-information-nav")).toBeNull();

    const two = createLab(
      navigationWindow([
        { kind: "group", title: "A", children: [] },
        { kind: "group", title: "B", children: [] },
      ]),
      host(),
    );
    expect(navLabels(two.root, "About")).toEqual(["A", "B"]);

    await one.dispose();
    await collapsible.dispose();
    await two.dispose();
  });
});

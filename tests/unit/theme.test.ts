// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  applyTheme,
  initialTheme,
  saveTheme,
} from "../../src/ui/theme.ts";
import { createLab } from "../../src/runtime/createLab.ts";
import type { LabDefinition } from "../../src/runtime/definition.ts";

// Тема каркаса: начальный выбор (система/сохранённый) и минимальный runtime-путь
// через реальную кнопку. Stubs локальны для этого файла; глобальная среда не
// строится.

interface Demo {
  n: number;
}

function definition(): LabDefinition<Demo> {
  return {
    contractVersion: "0.1",
    id: "theme-demo",
    title: "Theme Demo",
    capabilities: { required: ["canvas"] },
    model: { createState: () => ({ n: 0 }) },
    parameters: {},
    views: { plot: { render: () => {} } },
    layout: { controls: [], workspace: [{ kind: "panel", view: "plot" }] },
  };
}

function stubMatchMedia(dark: boolean): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

let originalMatchMedia: unknown;

beforeEach(() => {
  originalMatchMedia = (window as unknown as { matchMedia?: unknown }).matchMedia;
  window.localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

afterEach(() => {
  (window as unknown as { matchMedia: unknown }).matchMedia = originalMatchMedia;
  window.localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
});

describe("тема каркаса: начальный выбор", () => {
  it("нет выбора и нет системной тёмной темы — светлая", () => {
    expect(initialTheme(document)).toBe("light");
    expect(document.documentElement.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
  });

  it("системная тёмная тема — тёмная", () => {
    stubMatchMedia(true);
    expect(initialTheme(document)).toBe("dark");
  });

  it("сохранённый явный выбор приоритетнее системной темы", () => {
    stubMatchMedia(true);
    saveTheme(document, "light");
    expect(initialTheme(document)).toBe("light");
  });

  it("applyTheme выставляет атрибут на <html>", () => {
    applyTheme(document, "dark");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });
});

describe("тема каркаса: кнопка в createLab", () => {
  it("переключает тему, пишет storage и снимает listener при dispose", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const instance = createLab(definition(), container);
    const toggle = container.querySelector<HTMLButtonElement>(".labkit-theme-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.type).toBe("button");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");

    toggle?.click();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    toggle?.click();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");

    await instance.dispose();
    container.remove();
    // Listener был в scope: после dispose клик ничего не меняет.
    toggle?.click();
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("сохранённый выбор применяется при монтировании", async () => {
    saveTheme(document, "dark");
    const container = document.createElement("div");
    document.body.append(container);
    const instance = createLab(definition(), container);
    const toggle = container.querySelector<HTMLButtonElement>(".labkit-theme-toggle");
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    await instance.dispose();
    container.remove();
  });
});

interface ThemeTrace {
  renders: number;
  changes: number;
  steps: number;
  actions: number;
}

function tracedDefinition(trace: ThemeTrace): LabDefinition<Demo> {
  return {
    contractVersion: "0.1",
    id: "theme-trace-demo",
    title: "Theme Trace Demo",
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
      ping: {
        id: "ping",
        label: "Ping",
        run: () => {
          trace.actions += 1;
        },
      },
    },
    views: {
      plot: {
        render: () => {
          trace.renders += 1;
        },
      },
    },
    hooks: {
      onChange: () => {
        trace.changes += 1;
      },
      animation: {
        step: () => {
          trace.steps += 1;
        },
      },
    },
    layout: {
      controls: [{ kind: "action", action: "ping" }],
      workspace: [{ kind: "panel", view: "plot" }],
    },
  };
}

function resetTrace(trace: ThemeTrace): void {
  trace.renders = 0;
  trace.changes = 0;
  trace.steps = 0;
  trace.actions = 0;
}

// Реальная очередь MutationObserver: даём доставиться microtask-колбэку и
// следующему за ним requestRender, не подменяя observer ручным вызовом.
async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface MutationObserverTracker {
  constructed: number;
  disconnected: number;
  restore(): void;
}

function trackMutationObservers(): MutationObserverTracker {
  const Native = (globalThis as unknown as { MutationObserver: typeof MutationObserver })
    .MutationObserver;
  const tracker: MutationObserverTracker = {
    constructed: 0,
    disconnected: 0,
    restore: () => {
      (globalThis as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver =
        Native;
    },
  };
  class TrackedMutationObserver extends Native {
    constructor(callback: MutationCallback) {
      super(callback);
      tracker.constructed += 1;
    }
    override disconnect(): void {
      tracker.disconnected += 1;
      super.disconnect();
    }
  }
  (globalThis as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver =
    TrackedMutationObserver;
  return tracker;
}

function themeHost(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

describe("тема каркаса: инвалидация canvas через runtime", () => {
  it("кнопка и внешняя attribute mutation перерисовывают при остановленном timeline без onChange/actions/animation", async () => {
    const trace: ThemeTrace = { renders: 0, changes: 0, steps: 0, actions: 0 };
    const container = themeHost();
    const instance = createLab(tracedDefinition(trace), container);
    try {
      const toggle = container.querySelector<HTMLButtonElement>(".labkit-theme-toggle");
      expect(toggle).not.toBeNull();
      expect(instance.timeline.isRunning).toBe(false);
      const stateBefore = { ...instance.state };
      const paramsBefore = instance.params.get("n");
      expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("light");

      // Стабилизировать исходные resize-инвалидации поверхности до baseline.
      await flushMutations();
      resetTrace(trace);
      toggle?.click();
      await flushMutations();
      expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
      expect(trace.renders).toBe(1);

      // Внешняя смена того же атрибута — такой же repaint, как кнопка.
      document.documentElement.setAttribute(THEME_ATTRIBUTE, "light");
      await flushMutations();
      expect(trace.renders).toBe(2);

      expect(trace.changes).toBe(0);
      expect(trace.steps).toBe(0);
      expect(trace.actions).toBe(0);
      expect(instance.state).toEqual(stateBefore);
      expect(instance.params.get("n")).toBe(paramsBefore);
      expect(instance.timeline.isRunning).toBe(false);
    } finally {
      await instance.dispose();
      container.remove();
    }
  });

  it("серия синхронных mutation коалесцируется в одну доставку/перерисовку", async () => {
    const trace: ThemeTrace = { renders: 0, changes: 0, steps: 0, actions: 0 };
    const container = themeHost();
    const instance = createLab(tracedDefinition(trace), container);
    try {
      await flushMutations();
      resetTrace(trace);
      applyTheme(document, "dark");
      applyTheme(document, "light");
      applyTheme(document, "dark");
      await flushMutations();
      expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
      expect(trace.renders).toBe(1);
      expect(trace.changes).toBe(0);
      expect(trace.steps).toBe(0);
      expect(trace.actions).toBe(0);
    } finally {
      await instance.dispose();
      container.remove();
    }
  });

  it("прочие атрибуты/class/style на <html> не перерисовывают", async () => {
    const trace: ThemeTrace = { renders: 0, changes: 0, steps: 0, actions: 0 };
    const container = themeHost();
    const instance = createLab(tracedDefinition(trace), container);
    try {
      await flushMutations();
      resetTrace(trace);
      document.documentElement.setAttribute("data-other", "1");
      document.documentElement.classList.add("theme-test-extra");
      document.documentElement.style.color = "red";
      document.documentElement.classList.remove("theme-test-extra");
      document.documentElement.removeAttribute("data-other");
      document.documentElement.style.removeProperty("color");
      await flushMutations();
      expect(trace.renders).toBe(0);
    } finally {
      await instance.dispose();
      container.remove();
    }
  });

  it("disconnect при dispose: pending mutation и mutation после dispose не рисуют", async () => {
    const tracker = trackMutationObservers();
    const trace: ThemeTrace = { renders: 0, changes: 0, steps: 0, actions: 0 };
    const container = themeHost();
    try {
      const instance = createLab(tracedDefinition(trace), container);
      await flushMutations();
      resetTrace(trace);

      // Мутация уже поставлена в реальную очередь observer, затем сразу dispose.
      document.documentElement.setAttribute(THEME_ATTRIBUTE, "dark");
      await instance.dispose();
      expect(tracker.constructed).toBeGreaterThanOrEqual(1);
      expect(tracker.disconnected).toBe(tracker.constructed);

      await flushMutations();
      expect(trace.renders).toBe(0);

      document.documentElement.setAttribute(THEME_ATTRIBUTE, "light");
      await flushMutations();
      expect(trace.renders).toBe(0);
    } finally {
      tracker.restore();
      container.remove();
    }
  });

  it("failed mount (setup): observer создан и disconnect реально вызван, поздняя mutation не рисует", async () => {
    const tracker = trackMutationObservers();
    const trace: ThemeTrace = { renders: 0, changes: 0, steps: 0, actions: 0 };
    const container = themeHost();
    try {
      const def = tracedDefinition(trace);
      def.hooks = {
        ...def.hooks,
        setup: () => {
          throw new Error("theme setup boom");
        },
      };
      expect(() => createLab(def, container)).toThrow(/theme setup boom/);
      expect(tracker.constructed).toBeGreaterThanOrEqual(1);
      expect(tracker.disconnected).toBe(tracker.constructed);
      expect(container.querySelector(".labkit")).toBeNull();

      document.documentElement.setAttribute(THEME_ATTRIBUTE, "dark");
      await flushMutations();
      expect(trace.renders).toBe(0);
    } finally {
      tracker.restore();
      container.remove();
    }
  });

  it("failed mount (первый view render): observer disconnect реален, UI не трогается повторно", async () => {
    const tracker = trackMutationObservers();
    const trace: ThemeTrace = { renders: 0, changes: 0, steps: 0, actions: 0 };
    const container = themeHost();
    try {
      const def = tracedDefinition(trace);
      def.views = {
        plot: {
          render: () => {
            trace.renders += 1;
            throw new Error("theme render boom");
          },
        },
      };
      expect(() => createLab(def, container)).toThrow(/theme render boom/);
      expect(tracker.constructed).toBeGreaterThanOrEqual(1);
      expect(tracker.disconnected).toBe(tracker.constructed);
      expect(container.querySelector(".labkit")).toBeNull();

      document.documentElement.setAttribute(THEME_ATTRIBUTE, "light");
      await flushMutations();
      expect(trace.renders).toBe(1); // только упавшая первая отрисовка
    } finally {
      tracker.restore();
      container.remove();
    }
  });
});

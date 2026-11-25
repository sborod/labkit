// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DisplaySurface } from "../../src/runtime/surface.ts";

// Регрессия: resize/DPR обязаны инвалидировать поверхность (запросить
// перерисовку), иначе после смены размера на паузе canvas остаётся пустым.

interface ObserverDouble {
  callback: () => void;
  disconnected: boolean;
}

let observers: ObserverDouble[] = [];
let mediaListeners: Array<() => void> = [];
let originalObserver: unknown;
let originalMatchMedia: unknown;
let dpr = 1;

beforeEach(() => {
  observers = [];
  mediaListeners = [];
  dpr = 1;
  originalObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(callback: () => void) {
      observers.push({ callback, disconnected: false });
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      const last = observers[observers.length - 1];
      if (last) last.disconnected = true;
    }
  };
  originalMatchMedia = window.matchMedia;
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => {
      mediaListeners.push(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      mediaListeners = mediaListeners.filter((entry) => entry !== listener);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    get: () => dpr,
  });
});

afterEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = originalObserver;
  (window as unknown as { matchMedia: unknown }).matchMedia = originalMatchMedia;
});

function rect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("DisplaySurface: инвалидация при resize/DPR", () => {
  it("resize меняет растр и инвалидирует только при реальном изменении", () => {
    const host = document.createElement("div");
    document.body.append(host);
    let invalidations = 0;
    const surface = new DisplaySurface(document, { onInvalidate: () => invalidations++ });

    surface.canvas.getBoundingClientRect = () => rect(100, 50);
    surface.attach(host);
    expect(surface.cssWidth).toBe(100);
    expect(surface.canvas.width).toBe(100);
    const afterAttach = invalidations;
    expect(afterAttach).toBeGreaterThan(0);

    // Повторный resize без изменений — без лишней инвалидации.
    surface.resize();
    expect(invalidations).toBe(afterAttach);

    // Изменение CSS-размера + observer → инвалидация и новый растр.
    surface.canvas.getBoundingClientRect = () => rect(200, 80);
    observers[observers.length - 1]?.callback();
    expect(surface.canvas.width).toBe(200);
    expect(invalidations).toBe(afterAttach + 1);

    surface.dispose();
    expect(observers[observers.length - 1]?.disconnected).toBe(true);
  });

  it("смена DPR без смены CSS-размера инвалидирует (matchMedia rearm)", () => {
    const host = document.createElement("div");
    document.body.append(host);
    let invalidations = 0;
    const surface = new DisplaySurface(document, { onInvalidate: () => invalidations++ });
    surface.canvas.getBoundingClientRect = () => rect(100, 50);
    surface.attach(host);
    expect(surface.canvas.width).toBe(100);
    const before = invalidations;
    expect(mediaListeners.length).toBeGreaterThan(0);

    dpr = 2;
    // Обработчик смены resolution-запроса.
    mediaListeners[0]?.();
    expect(surface.dpr).toBe(2);
    expect(surface.canvas.width).toBe(200);
    expect(invalidations).toBeGreaterThan(before);
    // Перевооружение: старый слушатель снят, добавлен новый.
    expect(mediaListeners.length).toBe(1);

    surface.dispose();
    expect(mediaListeners.length).toBe(0);
  });

  it("maxDpr ограничивает растровое разрешение", () => {
    const host = document.createElement("div");
    document.body.append(host);
    dpr = 3;
    const surface = new DisplaySurface(document, { maxDpr: 2 });
    surface.canvas.getBoundingClientRect = () => rect(100, 50);
    surface.attach(host);
    expect(surface.dpr).toBe(2);
    expect(surface.canvas.width).toBe(200);
    surface.dispose();
  });
});

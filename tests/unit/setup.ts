// Тестовые адаптеры для jsdom. Не являются production-путём:
//   * ResizeObserver отсутствует в jsdom, но требуется политике поверхности;
//   * jsdom не реализует 2D-контекст canvas.
// Оба адаптера делают возможным unit-тест жизненного цикла; реальный canvas
// проверяется в Playwright.

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const globalWithRo = globalThis as unknown as { ResizeObserver?: unknown };
if (typeof globalWithRo.ResizeObserver === "undefined") {
  globalWithRo.ResizeObserver = ResizeObserverStub;
}

const canvasProto = (globalThis as unknown as { HTMLCanvasElement?: { prototype: object } })
  .HTMLCanvasElement?.prototype as { getContext?: (id: string) => unknown } | undefined;

if (canvasProto) {
  canvasProto.getContext = function getContext(this: unknown): unknown {
    return {
      canvas: this,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      font: "",
      textAlign: "",
      textBaseline: "",
      imageSmoothingEnabled: true,
      setTransform() {},
      clearRect() {},
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      arc() {},
      rect() {},
      fillRect() {},
      strokeRect() {},
      fillText() {},
      setLineDash() {},
    };
  };
}

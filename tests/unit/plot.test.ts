import { describe, expect, it } from "vitest";
import { linearScale, sampleSeries } from "../../src/plot/scale.ts";

describe("linearScale", () => {
  it("отображает домен в диапазон и обратно", () => {
    const scale = linearScale([-12, 12], [65, 755]);
    expect(scale.map(-12)).toBeCloseTo(65, 9);
    expect(scale.map(12)).toBeCloseTo(755, 9);
    expect(scale.map(0)).toBeCloseTo((65 + 755) / 2, 9);
    expect(scale.invert(scale.map(3.5))).toBeCloseTo(3.5, 9);
  });

  it("поддерживает инвертированный диапазон (ось Y)", () => {
    const scale = linearScale([-1.25, 1.35], [500, 28]);
    expect(scale.map(-1.25)).toBeCloseTo(500, 9);
    expect(scale.map(1.35)).toBeCloseTo(28, 9);
  });

  it("вырожденный домен — явная ошибка", () => {
    expect(() => linearScale([1, 1], [0, 10])).toThrow(/вырожден/);
  });
});

describe("sampleSeries", () => {
  it("включает оба конца домена и нужное число точек", () => {
    const scale = linearScale([0, 1], [0, 100]);
    const points = sampleSeries(5, [0, 1], (x) => x, scale, scale);
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[4]).toEqual({ x: 100, y: 100 });
  });

  it("минимум 2 точки даже при count < 2", () => {
    const scale = linearScale([0, 1], [0, 1]);
    expect(sampleSeries(1, [0, 1], (x) => x, scale, scale)).toHaveLength(2);
  });
});

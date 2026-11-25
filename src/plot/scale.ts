// Линейная шкала отображения. Значения модели задаются в предметных координатах,
// пиксели — в логических (CSS) координатах поверхности.
export interface LinearScale {
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  map(value: number): number;
  invert(pixel: number): number;
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) {
    throw new Error("labkit: домен шкалы вырожден (d1 === d0)");
  }
  const k = (r1 - r0) / span;
  return {
    domain,
    range,
    map: (value: number) => r0 + (value - d0) * k,
    invert: (pixel: number) => d0 + (pixel - r0) / k,
  };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export function sampleSeries(
  count: number,
  domain: readonly [number, number],
  fn: (x: number) => number,
  xScale: LinearScale,
  yScale: LinearScale,
): Vec2[] {
  const points: Vec2[] = [];
  const [x0, x1] = domain;
  const safeCount = Math.max(2, count);
  for (let i = 0; i < safeCount; i++) {
    const x = x0 + ((x1 - x0) * i) / (safeCount - 1);
    points.push({ x: xScale.map(x), y: yScale.map(fn(x)) });
  }
  return points;
}

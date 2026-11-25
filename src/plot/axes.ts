import type { LinearScale, Rect, Vec2 } from "./scale.ts";

export interface PlotStyle {
  grid: string;
  axis: string;
  text: string;
  font: string;
}

export const defaultPlotStyle: PlotStyle = {
  grid: "#eceef3",
  axis: "#555555",
  text: "#333333",
  font: "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
};

export interface GridOptions {
  xTicks: readonly number[];
  yTicks: readonly number[];
  xScale: LinearScale;
  yScale: LinearScale;
  rect: Rect;
  style?: Partial<PlotStyle>;
}

/** Сетка (без осей) внутри прямоугольника построения. */
export function drawGrid(ctx: CanvasRenderingContext2D, options: GridOptions): void {
  const style = { ...defaultPlotStyle, ...options.style };
  const { rect, xScale, yScale } = options;
  ctx.save();
  ctx.strokeStyle = style.grid;
  ctx.lineWidth = 1;
  for (const x of options.xTicks) {
    const px = xScale.map(x);
    ctx.beginPath();
    ctx.moveTo(px, rect.top);
    ctx.lineTo(px, rect.top + rect.height);
    ctx.stroke();
  }
  for (const y of options.yTicks) {
    const py = yScale.map(y);
    ctx.beginPath();
    ctx.moveTo(rect.left, py);
    ctx.lineTo(rect.left + rect.width, py);
    ctx.stroke();
  }
  ctx.restore();
}

/** Нулевые оси. */
export function drawZeroAxes(
  ctx: CanvasRenderingContext2D,
  options: Omit<GridOptions, "xTicks" | "yTicks">,
): void {
  const style = { ...defaultPlotStyle, ...options.style };
  const { rect, xScale, yScale } = options;
  ctx.save();
  ctx.strokeStyle = style.axis;
  ctx.lineWidth = 1;
  const y0 = yScale.map(0);
  ctx.beginPath();
  ctx.moveTo(rect.left, y0);
  ctx.lineTo(rect.left + rect.width, y0);
  ctx.stroke();
  const x0 = xScale.map(0);
  ctx.beginPath();
  ctx.moveTo(x0, rect.top);
  ctx.lineTo(x0, rect.top + rect.height);
  ctx.stroke();
  ctx.restore();
}

export interface TickLabelsOptions {
  ticks: readonly number[];
  scale: LinearScale;
  y: number;
  style?: Partial<PlotStyle>;
  formatter?: (value: number) => string;
}

/** Подписи делений по оси X. */
export function drawXTickLabels(ctx: CanvasRenderingContext2D, options: TickLabelsOptions): void {
  const style = { ...defaultPlotStyle, ...options.style };
  const format = options.formatter ?? ((value: number) => String(value));
  ctx.save();
  ctx.fillStyle = style.text;
  ctx.font = style.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const tick of options.ticks) {
    ctx.fillText(format(tick), options.scale.map(tick), options.y);
  }
  ctx.restore();
}

export interface PolylineOptions {
  stroke: string;
  lineWidth: number;
  dash?: readonly number[];
}

/** Ломаная по уже спроецированным точкам. */
export function drawPolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly Vec2[],
  options: PolylineOptions,
): void {
  if (points.length === 0) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = options.stroke;
  ctx.lineWidth = options.lineWidth;
  if (options.dash) {
    ctx.setLineDash([...options.dash]);
  }
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.stroke();
  ctx.restore();
}

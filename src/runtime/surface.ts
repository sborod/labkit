// Политика поверхности отображения (дополнение 1, §3.4). Три шкалы раздельны:
//   * CSS-размер панели,
//   * растровое разрешение canvas (CSS * DPR, с ограничением),
//   * вычислительная сетка (задаётся моделью/views, не зависит от размера панели).
//
// Любое изменение CSS-размера или DPR инвалидирует поверхность: canvas bitmap
// обнуляется при смене width/height, поэтому рантайм обязан перерисовать кадр
// даже на паузе. Изменение DPR без изменения CSS-размера отслеживается через
// matchMedia + window resize (всё owned и disposed).

export interface SurfacePolicy {
  /** Верхний предел DPR, чтобы 4K-экраны не раздували растр. */
  maxDpr?: number;
}

export interface SurfaceOptions extends SurfacePolicy {
  /** Вызывается, когда CSS-размер или DPR реально изменились. */
  onInvalidate?: () => void;
}

export class DisplaySurface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly #policy: SurfacePolicy;
  readonly #onInvalidate: () => void;
  readonly #view: Window | null;
  #observer: ResizeObserver | null = null;
  #mediaQuery: MediaQueryList | null = null;
  #mediaHandler: (() => void) | null = null;
  #disposed = false;
  cssWidth = 1;
  cssHeight = 1;
  dpr = 1;

  constructor(doc: Document, options: SurfaceOptions = {}) {
    this.#policy = options;
    this.#onInvalidate = options.onInvalidate ?? (() => {});
    this.#view = doc.defaultView;
    this.canvas = doc.createElement("canvas");
    this.canvas.className = "labkit-surface";
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("labkit: не удалось получить 2D-контекст canvas");
    }
    this.ctx = ctx;
  }

  attach(container: HTMLElement): void {
    if (this.#disposed) {
      throw new Error("labkit: поверхность уже освобождена");
    }
    container.appendChild(this.canvas);
    this.#observer = new ResizeObserver(() => this.resize());
    this.#observer.observe(container);
    const view = this.#view;
    if (view) {
      view.addEventListener("resize", this.#onViewResize);
      this.#armDprWatcher(view);
    }
    this.resize();
  }

  resize(): void {
    if (this.#disposed) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const rawDpr = (this.#view && this.#view.devicePixelRatio) || 1;
    const dpr = Math.min(rawDpr, this.#policy.maxDpr ?? 2);
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    const changed =
      width !== this.canvas.width ||
      height !== this.canvas.height ||
      cssWidth !== this.cssWidth ||
      cssHeight !== this.cssHeight ||
      dpr !== this.dpr;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    if (this.canvas.width !== width) {
      this.canvas.width = width;
    }
    if (this.canvas.height !== height) {
      this.canvas.height = height;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (changed) {
      this.#onInvalidate();
    }
  }

  clear(): void {
    if (this.#disposed) {
      return;
    }
    this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    // Каждый шаг очистки выполняется независимо: падение одного не мешает
    // остальным; ошибки агрегируются и пробрасываются (Scope их соберёт).
    const errors: unknown[] = [];
    try {
      this.#observer?.disconnect();
    } catch (error) {
      errors.push(error);
    }
    this.#observer = null;

    const query = this.#mediaQuery;
    const handler = this.#mediaHandler;
    this.#mediaQuery = null;
    this.#mediaHandler = null;
    if (query && handler) {
      try {
        query.removeEventListener("change", handler);
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      this.#view?.removeEventListener("resize", this.#onViewResize);
    } catch (error) {
      errors.push(error);
    }

    try {
      this.canvas.remove();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "labkit: ошибки при освобождении поверхности");
    }
  }

  #onViewResize = (): void => {
    this.resize();
  };

  #armDprWatcher(view: Window): void {
    this.#teardownDprWatcher();
    if (typeof view.matchMedia !== "function") {
      return;
    }
    const dpr = view.devicePixelRatio || 1;
    const query = view.matchMedia(`(resolution: ${dpr}dppx)`);
    const handler = (): void => {
      // DPR изменился без изменения CSS-размера: перевооружаемся и перерисовываем.
      this.#armDprWatcher(view);
      this.resize();
    };
    this.#mediaQuery = query;
    this.#mediaHandler = handler;
    query.addEventListener("change", handler);
  }

  #teardownDprWatcher(): void {
    if (this.#mediaQuery && this.#mediaHandler) {
      this.#mediaQuery.removeEventListener("change", this.#mediaHandler);
    }
    this.#mediaQuery = null;
    this.#mediaHandler = null;
  }
}

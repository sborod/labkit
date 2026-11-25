import type { TimelineControl } from "../core/context.ts";

export type FrameScheduler = (callback: (timestamp: number) => void) => number;
export type FrameCanceller = (handle: number) => void;

const defaultSchedule: FrameScheduler = (callback) => requestAnimationFrame(callback);
const defaultCancel: FrameCanceller = (handle: number) => cancelAnimationFrame(handle);

/**
 * Таймлайн отображения. Один на экземпляр. Первый кадр после start() только
 * фиксирует начало отсчёта (dt = 0), поэтому возобновление после паузы не даёт
 * скачка. Планировщик инъектируется для unit-тестов.
 *
 * Каждый start()/stop()/dispose() увеличивает generation; колбэк несёт свою
 * generation и не перепланирует кадр, если она устарела. Это защищает от двух
 * одновременных RAF, когда onFrame делает stop()+start() или dispose().
 * dispose() терминален: start()/toggle() после него явно ошибаются.
 */
export class Timeline implements TimelineControl {
  #running = false;
  #disposed = false;
  #generation = 0;
  #handle: number | null = null;
  #last: number | null = null;
  readonly #onFrame: (dt: number) => void;
  readonly #schedule: FrameScheduler;
  readonly #cancel: FrameCanceller;

  constructor(
    onFrame: (dt: number) => void,
    schedule: FrameScheduler = defaultSchedule,
    cancel: FrameCanceller = defaultCancel,
  ) {
    this.#onFrame = onFrame;
    this.#schedule = schedule;
    this.#cancel = cancel;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  start(): void {
    if (this.#disposed) {
      throw new Error("labkit: таймлайн уже освобождён");
    }
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#last = null;
    this.#arm();
  }

  stop(): void {
    if (this.#disposed) {
      this.#running = false;
      this.#handle = null;
      this.#last = null;
      return;
    }
    if (!this.#running) {
      return;
    }
    this.#running = false;
    this.#generation += 1;
    if (this.#handle !== null) {
      this.#cancel(this.#handle);
      this.#handle = null;
    }
    this.#last = null;
  }

  toggle(): void {
    if (this.#disposed) {
      throw new Error("labkit: таймлайн уже освобождён");
    }
    if (this.#running) {
      this.stop();
    } else {
      this.start();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#running = false;
    this.#generation += 1;
    if (this.#handle !== null) {
      this.#cancel(this.#handle);
      this.#handle = null;
    }
    this.#last = null;
  }

  #arm(): void {
    const generation = ++this.#generation;
    this.#handle = this.#schedule((timestamp) => this.#tick(generation, timestamp));
  }

  #tick(generation: number, timestamp: number): void {
    // Устаревший кадр (был stop/start/dispose) — не перепланируем.
    if (generation !== this.#generation) {
      return;
    }
    if (!this.#running || this.#disposed) {
      return;
    }
    // Этот колбэк «израсходовал» свой handle.
    this.#handle = null;
    if (this.#last === null) {
      this.#last = timestamp;
    } else {
      const dt = (timestamp - this.#last) / 1000;
      this.#last = timestamp;
      if (dt > 0) {
        this.#onFrame(dt);
      }
    }
    // onFrame мог остановить/перезапустить/освободить таймлайн.
    if (!this.#running || this.#disposed || generation !== this.#generation) {
      return;
    }
    this.#arm();
  }
}

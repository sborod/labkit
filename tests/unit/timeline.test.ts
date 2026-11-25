import { describe, expect, it } from "vitest";
import { Timeline } from "../../src/runtime/timeline.ts";

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

  /** Выполнить все запланированные кадры с заданной меткой времени. */
  tick(ts: number): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) {
      callback(ts);
    }
  }
}

describe("Timeline: пауза без скачка", () => {
  it("первый кадр задаёт отсчёт и не порождает dt", () => {
    const frames = new FakeFrames();
    const dt: number[] = [];
    const timeline = new Timeline((value) => dt.push(value), frames.schedule, frames.cancel);
    timeline.start();
    frames.tick(1000);
    expect(dt).toEqual([]);
    frames.tick(1016);
    expect(dt).toEqual([0.016]);
  });

  it("start → stop → start не даёт скачка времени", () => {
    const frames = new FakeFrames();
    const dt: number[] = [];
    const timeline = new Timeline((value) => dt.push(value), frames.schedule, frames.cancel);
    timeline.start();
    frames.tick(0);
    frames.tick(100); // dt = 0.1
    timeline.stop();
    timeline.start(); // сбрасывает отсчёт
    frames.tick(60_000); // большой разрыв не должен дать dt
    frames.tick(60_016);
    expect(dt).toEqual([0.1, 0.016]);
  });

  it("stop отменяет запланированный кадр", () => {
    const frames = new FakeFrames();
    const dt: number[] = [];
    const timeline = new Timeline((value) => dt.push(value), frames.schedule, frames.cancel);
    timeline.start();
    timeline.stop();
    frames.tick(500);
    expect(dt).toEqual([]);
    expect(timeline.isRunning).toBe(false);
  });

  it("повторный start идемпотентен", () => {
    const frames = new FakeFrames();
    const timeline = new Timeline(() => {}, frames.schedule, frames.cancel);
    timeline.start();
    timeline.start();
    frames.tick(0);
    frames.tick(16);
    expect(timeline.isRunning).toBe(true);
    timeline.stop();
  });

  it("toggle переключает состояние", () => {
    const frames = new FakeFrames();
    const timeline = new Timeline(() => {}, frames.schedule, frames.cancel);
    timeline.toggle();
    expect(timeline.isRunning).toBe(true);
    timeline.toggle();
    expect(timeline.isRunning).toBe(false);
  });
});

describe("Timeline: generation (один кадр, а не два)", () => {
  it("stop()+start() внутри onFrame оставляет ровно один запланированный кадр", () => {
    const frames = new FakeFrames();
    let calls = 0;
    const timeline = new Timeline(
      () => {
        calls += 1;
        if (calls === 1) {
          timeline.stop();
          timeline.start();
        }
      },
      frames.schedule,
      frames.cancel,
    );
    timeline.start();
    expect(frames.pending).toBe(1);
    frames.tick(1000); // фиксация отсчёта
    frames.tick(1016); // onFrame: stop()+start()
    expect(calls).toBe(1);
    expect(frames.pending).toBe(1);
    // Следующий кадр даёт dt от нового start, без удвоения.
    frames.tick(1200);
    expect(calls).toBe(1); // новый start снова фиксирует отсчёт
    frames.tick(1216);
    expect(calls).toBe(2);
    expect(frames.pending).toBe(1);
  });

  it("stop() внутри onFrame не оставляет кадров", () => {
    const frames = new FakeFrames();
    let calls = 0;
    const timeline = new Timeline(
      () => {
        calls += 1;
        timeline.stop();
      },
      frames.schedule,
      frames.cancel,
    );
    timeline.start();
    frames.tick(0);
    frames.tick(16);
    expect(calls).toBe(1);
    expect(frames.pending).toBe(0);
    expect(timeline.isRunning).toBe(false);
  });

  it("dispose() внутри onFrame не оставляет кадров", () => {
    const frames = new FakeFrames();
    let calls = 0;
    const timeline = new Timeline(
      () => {
        calls += 1;
        timeline.dispose();
      },
      frames.schedule,
      frames.cancel,
    );
    timeline.start();
    frames.tick(0);
    frames.tick(16);
    expect(calls).toBe(1);
    expect(frames.pending).toBe(0);
    expect(timeline.disposed).toBe(true);
  });
});

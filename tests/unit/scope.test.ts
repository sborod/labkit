import { describe, expect, it, vi } from "vitest";
import { Scope } from "../../src/runtime/scope.ts";

describe("Scope: идемпотентный и awaitable dispose", () => {
  it("выполняет освободители в обратном порядке", async () => {
    const order: number[] = [];
    const scope = new Scope();
    scope.add(() => {
      order.push(1);
    });
    scope.add(() => {
      order.push(2);
    });
    scope.add(() => {
      order.push(3);
    });
    await scope.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it("повторный dispose возвращает тот же промис и не повторяет работу", async () => {
    const dispose = vi.fn();
    const scope = new Scope();
    scope.add(dispose);
    const first = scope.dispose();
    const second = scope.dispose();
    expect(first).toBe(second);
    await first;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scope.disposed).toBe(true);
  });

  it("поддерживает асинхронные освободители и ждёт их", async () => {
    let resolved = false;
    const scope = new Scope();
    scope.add(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve();
          }, 1);
        }),
    );
    await scope.dispose();
    expect(resolved).toBe(true);
  });

  it("ошибка одного освободителя: остальные всё равно выполняются, dispose отклоняется", async () => {
    const order: string[] = [];
    const boom = new Error("boom");
    const scope = new Scope();
    scope.add(() => {
      order.push("a");
    });
    scope.add(() => {
      throw boom;
    });
    scope.add(() => {
      order.push("b");
    });
    const disposal = scope.dispose();
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    // обратный порядок: b, throw, a — все attempted
    expect(order).toEqual(["b", "a"]);
    await disposal.catch((error: unknown) => {
      expect((error as AggregateError).errors).toContain(boom);
    });
  });

  it("async-ошибка не мешает остальным и агрегируется", async () => {
    const order: string[] = [];
    const scope = new Scope();
    scope.add(() => {
      order.push("first");
    });
    scope.add(async () => {
      order.push("second");
      throw new Error("async boom");
    });
    scope.add(() => {
      order.push("third");
    });
    await expect(scope.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("несколько ошибок собираются в AggregateError", async () => {
    const scope = new Scope();
    const a = new Error("a");
    const b = new Error("b");
    scope.add(() => {
      throw a;
    });
    scope.add(() => {
      throw b;
    });
    await scope.dispose().catch((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([b, a]);
    });
  });

  it("отклонённый dispose идемпотентен (failed-промис)", async () => {
    const scope = new Scope();
    scope.add(() => {
      throw new Error("x");
    });
    const first = scope.dispose();
    const second = scope.dispose();
    expect(first).toBe(second);
    await expect(first).rejects.toBeInstanceOf(AggregateError);
    await expect(second).rejects.toBeInstanceOf(AggregateError);
  });

  it("add после dispose — явная ошибка (нет untracked late resource)", async () => {
    const scope = new Scope();
    await scope.dispose();
    expect(() => scope.add(() => {})).toThrow(/после dispose/);
  });

  it("listen после dispose — ошибка и слушатель не вешается", async () => {
    const scope = new Scope();
    await scope.dispose();
    let added = 0;
    const target = {
      addEventListener: () => {
        added += 1;
      },
      removeEventListener: () => {},
    } as unknown as EventTarget;
    expect(() => scope.listen(target, "x", () => {})).toThrow(/после dispose/);
    expect(added).toBe(0);
  });

  it("reentrant dispose из освободителя возвращает тот же промис, ошибка не теряется", async () => {
    const scope = new Scope();
    let captured: Promise<void> | null = null;
    scope.add(() => {
      // Синхронный освободитель наблюдает промис (не await-ит себя).
      captured = scope.dispose();
    });
    scope.add(() => {
      throw new Error("late boom");
    });
    const disposal = scope.dispose();
    expect(captured).toBe(disposal);
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    await disposal.catch((error: unknown) => {
      expect(
        (error as AggregateError).errors.some(
          (entry) => entry instanceof Error && /late boom/.test(entry.message),
        ),
      ).toBe(true);
    });
  });

  it("барьер не завершается раньше async-освободителя, добавленного до dispose", async () => {
    const scope = new Scope();
    let done = false;
    scope.add(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            done = true;
            resolve();
          }, 5);
        }),
    );
    const disposal = scope.dispose();
    expect(done).toBe(false);
    await disposal;
    expect(done).toBe(true);
  });
});

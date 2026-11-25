import { describe, expect, it, vi } from "vitest";
import { ParameterRegistry } from "../../src/core/registry.ts";
import type { ParameterSpec } from "../../src/core/params.ts";

interface Demo {
  level: number;
  flag: boolean;
  mode: string;
  allow: boolean;
}

function buildSpecs(): Record<string, ParameterSpec<Demo>> {
  return {
    level: {
      kind: "number",
      id: "level",
      label: "Уровень",
      min: 0,
      max: 10,
      step: 1,
      available: (state) => state.allow,
      read: (state) => state.level,
      write: (state, value) => {
        state.level = value;
      },
    },
    flag: {
      kind: "boolean",
      id: "flag",
      label: "Флаг",
      read: (state) => state.flag,
      write: (state, value) => {
        state.flag = value;
      },
    },
    mode: {
      kind: "enum",
      id: "mode",
      label: "Режим",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      read: (state) => state.mode,
      write: (state, value) => {
        state.mode = value;
      },
    },
    allow: {
      kind: "boolean",
      id: "allow",
      label: "Разрешить",
      read: (state) => state.allow,
      write: (state, value) => {
        state.allow = value;
      },
    },
  };
}

function build(state?: Partial<Demo>): { state: Demo; registry: ParameterRegistry<Demo> } {
  const initial: Demo = { level: 1, flag: false, mode: "a", allow: false, ...state };
  return { state: initial, registry: new ParameterRegistry(initial, buildSpecs()) };
}

describe("ParameterRegistry: доступ", () => {
  it("читает и пишет через привязку к состоянию", () => {
    const { state, registry } = build({ allow: true });
    registry.set("level", 4, "api");
    expect(state.level).toBe(4);
    expect(registry.getNumber("level")).toBe(4);
  });

  it("ограничивает число диапазоном", () => {
    const { registry } = build({ allow: true });
    registry.set("level", 999, "api");
    expect(registry.getNumber("level")).toBe(10);
    registry.set("level", -5, "api");
    expect(registry.getNumber("level")).toBe(0);
  });

  it("неизвестный параметр — явная ошибка", () => {
    const { registry } = build();
    expect(() => registry.get("nope")).toThrow(/неизвестный параметр/);
  });
});

describe("ParameterRegistry: строгие типы (без неявного приведения)", () => {
  it("number отвергает null, строки, объекты и NaN", () => {
    const { registry } = build({ allow: true });
    for (const bad of [null, "5", {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => registry.set("level", bad, "api")).toThrow(/конечное число/);
    }
    expect(registry.getNumber("level")).toBe(1);
  });

  it("boolean отвергает строки и числа (Boolean('false') не проходит)", () => {
    const { registry } = build();
    for (const bad of ["false", "true", 0, 1, null]) {
      expect(() => registry.set("flag", bad, "api")).toThrow(/boolean/);
    }
    registry.set("flag", true, "api");
    expect(registry.getBoolean("flag")).toBe(true);
  });

  it("enum отвергает не-строки и значения вне options", () => {
    const { registry } = build();
    for (const bad of [1, null, {}, "c"]) {
      expect(() => registry.set("mode", bad, "api")).toThrow();
    }
    registry.set("mode", "b", "api");
    expect(registry.getEnum("mode")).toBe("b");
  });
});

describe("ParameterRegistry: защита доступности на общем пути", () => {
  it("недоступный параметр нельзя изменить ни одним origin", () => {
    const { registry } = build({ allow: false });
    for (const origin of ["ui", "midi", "preset", "api", "timeline"] as const) {
      expect(() => registry.set("level", 5, origin)).toThrow(/недоступен/);
    }
    registry.set("allow", true, "api");
    registry.set("level", 5, "api");
    expect(registry.getNumber("level")).toBe(5);
  });
});

describe("ParameterRegistry: сравнение фактического значения после setter", () => {
  function normalizing(transform: (value: number) => number): {
    state: Demo;
    registry: ParameterRegistry<Demo>;
  } {
    const state: Demo = { level: 2, flag: false, mode: "a", allow: true };
    const specs = buildSpecs();
    specs.level = {
      ...(specs.level as ParameterSpec<Demo>),
      kind: "number",
      min: 0,
      max: 10,
      step: 1,
      read: (s: Demo) => s.level,
      write: (s: Demo, value: number) => {
        s.level = transform(value);
      },
    } as ParameterSpec<Demo>;
    return { state, registry: new ParameterRegistry(state, specs) };
  }

  it("нормализующий setter: изменение, не меняющее факт, не порождает событие", () => {
    const { registry } = normalizing((value) => Math.floor(value));
    const global = vi.fn();
    registry.subscribe(global);
    registry.set("level", 2.9, "api"); // floor → 2, как и было
    expect(global).not.toHaveBeenCalled();
    registry.set("level", 3.2, "api"); // floor → 3, факт изменился
    expect(global).toHaveBeenCalledTimes(1);
    expect(registry.getNumber("level")).toBe(3);
  });

  it("setter, игнорирующий ввод, не порождает событие", () => {
    const { registry } = normalizing(() => 2);
    const global = vi.fn();
    registry.subscribe(global);
    registry.set("level", 9, "api");
    expect(global).not.toHaveBeenCalled();
  });
});

describe("ParameterRegistry: batch-подписки", () => {
  it("одиночный set доставляет один BatchChange и ParamChange", () => {
    const { registry } = build();
    const perParam = vi.fn();
    const global = vi.fn();
    registry.subscribeParam("flag", perParam);
    registry.subscribe(global);
    registry.set("flag", true, "ui");
    expect(perParam).toHaveBeenCalledTimes(1);
    expect(perParam.mock.calls[0]?.[0]).toMatchObject({ id: "flag", origin: "ui" });
    expect(global).toHaveBeenCalledTimes(1);
    expect(global.mock.calls[0]?.[0]).toMatchObject({ ids: ["flag"], origin: "ui" });
  });

  it("transaction даёт ОДИН BatchChange на commit, per-param — по одному id", () => {
    const { registry, state } = build({ allow: true });
    const global = vi.fn();
    const perLevel = vi.fn();
    const perMode = vi.fn();
    registry.subscribe(global);
    registry.subscribeParam("level", perLevel);
    registry.subscribeParam("mode", perMode);
    registry.transaction("preset", () => {
      registry.set("level", 3, "preset");
      registry.set("level", 5, "preset");
      registry.set("mode", "b", "preset");
    });
    expect(global).toHaveBeenCalledTimes(1);
    expect(global.mock.calls[0]?.[0]).toMatchObject({
      ids: ["level", "mode"],
      origin: "preset",
    });
    expect(perLevel).toHaveBeenCalledTimes(1);
    expect(perMode).toHaveBeenCalledTimes(1);
    expect(state.level).toBe(5);
    expect(state.mode).toBe("b");
  });

  it("транзакция без изменений не порождает событий", () => {
    const { registry } = build({ allow: true });
    const global = vi.fn();
    registry.subscribe(global);
    registry.transaction("api", () => {
      registry.set("level", 1, "api");
    });
    expect(global).not.toHaveBeenCalled();
  });

  it("исключение в transaction: применённое доставляется, ошибка пробрасывается", () => {
    const { registry, state } = build({ allow: true });
    const global = vi.fn();
    registry.subscribe(global);
    expect(() =>
      registry.transaction("preset", () => {
        registry.set("level", 4, "preset");
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    // batching, не rollback: факт применён и доставлен одним batch.
    expect(state.level).toBe(4);
    expect(global).toHaveBeenCalledTimes(1);
    expect(global.mock.calls[0]?.[0]).toMatchObject({ ids: ["level"], origin: "preset" });
  });

  it("вложенные транзакции дают один внешний commit", () => {
    const { registry } = build({ allow: true });
    const global = vi.fn();
    registry.subscribe(global);
    registry.transaction("preset", () => {
      registry.set("level", 2, "preset");
      registry.transaction("preset", () => {
        registry.set("mode", "b", "preset");
      });
    });
    expect(global).toHaveBeenCalledTimes(1);
    expect(global.mock.calls[0]?.[0]).toMatchObject({ ids: ["level", "mode"] });
  });

  it("отписка прекращает уведомления", () => {
    const { registry } = build();
    const global = vi.fn();
    const unsubscribe = registry.subscribe(global);
    unsubscribe();
    registry.set("flag", true, "api");
    expect(global).not.toHaveBeenCalled();
  });
});

describe("ParameterRegistry: динамические свойства", () => {
  it("доступность и видимость зависят от состояния", () => {
    const { registry } = build();
    expect(registry.isAvailable("level")).toBe(false);
    registry.set("allow", true, "api");
    expect(registry.isAvailable("level")).toBe(true);
  });

  it("форматирование number/enum", () => {
    const state: Demo = { level: 3, flag: false, mode: "a", allow: true };
    const specs: Record<string, ParameterSpec<Demo>> = {
      level: {
        kind: "number",
        id: "level",
        label: "Уровень",
        min: 0,
        max: 10,
        step: "any",
        format: (value: number) => `level = ${value.toFixed(1)}`,
        read: (s) => s.level,
        write: (s, v) => {
          s.level = v;
        },
      },
      mode: {
        kind: "enum",
        id: "mode",
        label: "Режим",
        options: [{ value: "a", label: "A" }],
        read: (s) => s.mode,
        write: (s, v) => {
          s.mode = v;
        },
      },
    };
    const registry = new ParameterRegistry(state, specs);
    expect(registry.format("level")).toBe("level = 3.0");
    expect(registry.format("mode")).toBe("A");
  });
});

describe("ParameterRegistry: ошибки подписчиков не отменяют доставку", () => {
  it("бросающий perParam-слушатель не мешает batch и остальным; состояние обновлено", () => {
    const { registry, state } = build({ allow: true });
    const secondPer = vi.fn();
    const batch = vi.fn();
    registry.subscribeParam("level", () => {
      throw new Error("perParam boom");
    });
    registry.subscribeParam("level", secondPer);
    registry.subscribe(batch);
    expect(() => registry.set("level", 4, "api")).toThrow(AggregateError);
    expect(state.level).toBe(4);
    expect(secondPer).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toMatchObject({ ids: ["level"], origin: "api" });
  });

  it("бросающий batch-слушатель не мешает остальным и сообщается", () => {
    const { registry, state } = build({ allow: true });
    const secondBatch = vi.fn();
    registry.subscribe(() => {
      throw new Error("batch boom");
    });
    registry.subscribe(secondBatch);
    expect(() => registry.set("level", 3, "api")).toThrow(AggregateError);
    expect(state.level).toBe(3);
    expect(secondBatch).toHaveBeenCalledTimes(1);
  });

  it("transaction: ошибка callback и ошибка подписчика сохраняются обе", () => {
    const { registry, state } = build({ allow: true });
    const callbackError = new Error("callback boom");
    const listenerError = new Error("listener boom");
    registry.subscribe(() => {
      throw listenerError;
    });
    let thrown: unknown;
    try {
      registry.transaction("preset", () => {
        registry.set("level", 5, "preset");
        throw callbackError;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    const flat = aggregate.errors.flatMap((entry) =>
      entry instanceof AggregateError ? entry.errors : [entry],
    );
    expect(flat).toContain(callbackError);
    expect(flat).toContain(listenerError);
    expect(aggregate.cause).toBe(callbackError);
    expect(state.level).toBe(5);
  });
});

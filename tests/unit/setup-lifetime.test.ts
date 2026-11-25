// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createLab } from "../../src/runtime/createLab.ts";
import type { Lifetime } from "../../src/runtime/lifetime.ts";
import type { LabDefinition } from "../../src/runtime/definition.ts";

interface Demo {
  n: number;
}

function definition(): LabDefinition<Demo> {
  return {
    contractVersion: "0.1",
    id: "setup-demo",
    title: "Setup demo",
    capabilities: { required: ["canvas"] },
    model: { createState: () => ({ n: 0 }) },
    parameters: {
      n: {
        kind: "number",
        id: "n",
        label: "N",
        min: 0,
        max: 10,
        step: 1,
        read: (s) => s.n,
        write: (s, v) => {
          s.n = v;
        },
      },
    },
    views: { plot: { render: () => {} } },
    layout: {
      controls: [{ kind: "control", param: "n" }],
      workspace: [{ kind: "panel", view: "plot" }],
    },
  };
}

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

describe("hooks.setup и Lifetime", () => {
  it("setup синхронный, до первой отрисовки, с живым disposed", async () => {
    const calls: string[] = [];
    let captured: Lifetime | null = null;
    const def = definition();
    def.views = { plot: { render: () => calls.push("render") } };
    def.hooks = {
      setup: (_ctx, lifetime) => {
        calls.push("setup");
        captured = lifetime;
        expect(lifetime.disposed).toBe(false);
        lifetime.add(() => {
          calls.push("dispose");
        });
      },
    };

    const instance = createLab(def, host());
    // setup выполнен ДО первой отрисовки.
    expect(calls.slice(0, 2)).toEqual(["setup", "render"]);
    expect(captured).not.toBeNull();
    expect(captured!.disposed).toBe(false);

    await instance.dispose();
    expect(captured!.disposed).toBe(true);
    expect(calls).toContain("dispose");
  });

  it("lifetime.add делегирует в Scope: после dispose — явная ошибка", async () => {
    let captured: Lifetime | null = null;
    const def = definition();
    def.hooks = {
      setup: (_ctx, lifetime) => {
        captured = lifetime;
      },
    };
    const instance = createLab(def, host());
    await instance.dispose();
    expect(captured!.disposed).toBe(true);
    expect(() => captured!.add(() => {})).toThrow(/после dispose/);
  });

  it("ошибка setup очищает созданное и не монтирует root", () => {
    const container = host();
    const def = definition();
    def.hooks = {
      setup: () => {
        throw new Error("setup boom");
      },
    };
    expect(() => createLab(def, container)).toThrow(/setup boom/);
    expect(container.querySelector(".labkit")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });
});

describe("hooks.setup: строго синхронный контракт (P2)", () => {
  function withSetup(setup: unknown): LabDefinition<Demo> {
    const def = definition();
    def.hooks = { setup } as unknown as LabDefinition<Demo>["hooks"];
    return def;
  }

  it("async setup (resolve) отклоняет монтирование без ресурсов", () => {
    const container = host();
    const def = withSetup(async () => {});
    expect(() => createLab(def, container)).toThrow(/синхронным/);
    expect(container.querySelector(".labkit")).toBeNull();
  });

  it("async setup (reject) не даёт unhandled rejection и отклоняет монтирование", async () => {
    const container = host();
    const def = withSetup(async () => {
      throw new Error("async setup boom");
    });
    expect(() => createLab(def, container)).toThrow(/синхронным/);
    expect(container.querySelector(".labkit")).toBeNull();
    // Дренаж микротасок: отклонение thenable должно быть погашено.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("non-native thenable отклоняется", () => {
    const container = host();
    const def = withSetup(() => ({ then: () => {} }));
    expect(() => createLab(def, container)).toThrow(/синхронным/);
    expect(container.querySelector(".labkit")).toBeNull();
  });

  it("ошибка setup: зарегистрированный освободитель выполняется, исходная ошибка сохраняется", async () => {
    const container = host();
    let disposed = false;
    const def = withSetup((_ctx: unknown, lifetime: Lifetime) => {
      lifetime.add(() => {
        disposed = true;
      });
      throw new Error("setup boom");
    });
    expect(() => createLab(def, container)).toThrow(/setup boom/);
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toBe(true);
    expect(container.querySelector(".labkit")).toBeNull();
  });

  it("ошибка setup + ошибка первой отрисовки: откат наблюдаем, исходная ошибка первична", async () => {
    const container = host();
    let disposed = false;
    const def = definition();
    def.hooks = {
      setup: (_ctx, lifetime) => {
        lifetime.add(() => {
          disposed = true;
        });
        return undefined;
      },
    };
    def.views = {
      plot: {
        render: () => {
          throw new Error("render boom");
        },
      },
    };
    expect(() => createLab(def, container)).toThrow(/render boom/);
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toBe(true);
    expect(container.querySelector(".labkit")).toBeNull();
  });
});

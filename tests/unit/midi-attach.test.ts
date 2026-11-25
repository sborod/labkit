// @vitest-environment jsdom
// Владение MIDI-пультом через attachMidi: раздельные освободители адаптера и
// панели, регистрируемые сразу после создания. Проверяем пользовательские
// сценарии жизненного цикла на настоящих createLab/Scope/Lifetime и
// FakeMidiEnvironment/MemoryMidiStorage; никаких production factory seams.
import { describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../src/core/context.ts";
import { ActionRegistry } from "../../src/core/actions.ts";
import type { ParameterSpec } from "../../src/core/params.ts";
import { ParameterRegistry } from "../../src/core/registry.ts";
import { createLab } from "../../src/runtime/createLab.ts";
import type { LabDefinition } from "../../src/runtime/definition.ts";
import type { Lifetime } from "../../src/runtime/lifetime.ts";
import { Scope } from "../../src/runtime/scope.ts";
import { MidiAdapter } from "../../src/midi/adapter.ts";
import { attachMidi, type AttachedMidi } from "../../src/midi/attach.ts";
import { MemoryMidiStorage } from "../../src/midi/store.ts";
import { FakeMidiEnvironment } from "../../src/midi/testing.ts";
import type { MidiEnvironment } from "../../src/midi/types.ts";
import type { MidiStorage } from "../../src/midi/store.ts";

interface TestState {
  level: number;
  on: boolean;
  mode: string;
}

const specs: Record<string, ParameterSpec<TestState>> = {
  level: {
    kind: "number",
    id: "level",
    label: "Level",
    min: 0,
    max: 100,
    step: 1,
    read: (state) => state.level,
    write: (state, value) => {
      state.level = value;
    },
  },
  on: {
    kind: "boolean",
    id: "on",
    label: "On",
    read: (state) => state.on,
    write: (state, value) => {
      state.on = value;
    },
  },
  mode: {
    kind: "enum",
    id: "mode",
    label: "Mode",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    read: (state) => state.mode,
    write: (state, value) => {
      state.mode = value;
    },
  },
};

/** Минимальный контекст с НАСТОЯЩИМИ реестрами; DOM-корень задаёт вызывающий. */
function manualContext(root: HTMLElement): RuntimeContext<TestState> {
  const state: TestState = { level: 0, on: false, mode: "a" };
  const params = new ParameterRegistry<TestState>(state, specs);
  const actions = new ActionRegistry<TestState>(() => ctx, {});
  const ctx: RuntimeContext<TestState> = {
    state,
    params,
    actions,
    timeline: { start() {}, stop() {}, toggle() {}, isRunning: false },
    root,
    requestRender() {},
    log() {},
  };
  return ctx;
}

/** Определение, монтирующее MIDI через attachMidi в hooks.setup. */
function definition(
  environment: MidiEnvironment,
  storage: MidiStorage,
  namespace: string,
  capture?: (attached: AttachedMidi) => void,
): LabDefinition<TestState> {
  return {
    contractVersion: "0.1",
    id: "midi-attach-demo",
    title: "MIDI attach demo",
    capabilities: { required: [], optional: ["midi"] },
    model: { createState: () => ({ level: 0, on: false, mode: "a" }) },
    parameters: specs,
    layout: {
      controls: [{ kind: "control", param: "level" }],
      workspace: [],
    },
    hooks: {
      setup: (ctx, lifetime) => {
        const attached = attachMidi(ctx, lifetime, { namespace, environment, storage });
        capture?.(attached);
      },
    },
  };
}

/** Полное определение: number/boolean/action в workspace и enum (без MIDI-слота). */
function fullDefinition(
  environment: MidiEnvironment,
  storage: MidiStorage,
  namespace: string,
  capture?: (attached: AttachedMidi) => void,
): LabDefinition<TestState> {
  return {
    contractVersion: "0.1",
    id: "midi-attach-full",
    title: "MIDI attach full",
    capabilities: { required: [], optional: ["midi"] },
    model: { createState: () => ({ level: 0, on: false, mode: "a" }) },
    parameters: specs,
    actions: { ping: { id: "ping", label: "Ping", run: () => {} } },
    layout: {
      controls: [{ kind: "control", param: "level" }],
      workspace: [
        { kind: "control", param: "on" },
        { kind: "action", action: "ping" },
        { kind: "control", param: "mode" },
      ],
    },
    hooks: {
      setup: (ctx, lifetime) => {
        const attached = attachMidi(ctx, lifetime, { namespace, environment, storage });
        capture?.(attached);
      },
    },
  };
}

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

function realLifetime(scope: Scope, errors: unknown[]): Lifetime {
  return {
    get disposed(): boolean {
      return scope.disposed;
    },
    add: (disposer) => scope.add(disposer),
    reportError: (_phase, error) => {
      errors.push(error);
    },
  };
}

describe("attachMidi: владение ресурсами", () => {
  it("(a) панель встаёт в .labkit-controls; dispose освобождает адаптер и панель", async () => {
    const env = new FakeMidiEnvironment();
    let attached!: AttachedMidi;
    const mount = host();
    const instance = createLab(
      definition(env, new MemoryMidiStorage(), "attach-normal", (a) => {
        attached = a;
      }),
      mount,
    );

    expect(mount.querySelector(".labkit-midi-window[hidden] .labkit-midi")).not.toBeNull();
    expect(attached.midi.disposed).toBe(false);

    await instance.dispose();
    expect(attached.midi.disposed).toBe(true);
    expect(attached.midiPanel.el.isConnected).toBe(false);
  });

  it("(a) без .labkit-controls панель вешается на корень, inline-слот тоже работает", async () => {
    const env = new FakeMidiEnvironment();
    const scope = new Scope();
    const root = document.createElement("div");
    // Слот inline-обучения вручную (layout-пути createLab здесь нет).
    const accessory = document.createElement("span");
    accessory.className = "labkit-control-accessory";
    accessory.dataset.labkitParamAccessory = "level";
    accessory.hidden = true;
    root.append(accessory);
    document.body.append(root);

    const attached = attachMidi(manualContext(root), realLifetime(scope, []), {
      namespace: "attach-fallback",
      environment: env,
      storage: new MemoryMidiStorage(),
    });

    expect(root.querySelector(".labkit-midi")).not.toBeNull();
    attached.midi.setTraining(true);
    expect(accessory.hidden).toBe(false);
    expect(accessory.querySelector(".labkit-midi-learn")).not.toBeNull();

    await scope.dispose();
    expect(attached.midi.disposed).toBe(true);
    expect(attached.midiPanel.el.isConnected).toBe(false);
    expect(root.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    expect(accessory.hidden).toBe(true);
  });

  it("(b) падение panel.dispose не мешает освободить адаптер (LIFO Scope)", async () => {
    const env = new FakeMidiEnvironment();
    const input = env.addInput("device");
    let attached!: AttachedMidi;
    const instance = createLab(
      definition(env, new MemoryMidiStorage(), "attach-panel-throw", (a) => {
        attached = a;
      }),
      host(),
    );

    await attached.midi.connect();
    expect(input.listenerCount).toBeGreaterThan(0);
    expect(env.access!.listenerCount).toBeGreaterThan(0);

    attached.midiPanel.dispose = () => {
      throw new Error("panel dispose boom");
    };

    await expect(instance.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(attached.midi.disposed).toBe(true);
    expect(input.listenerCount).toBe(0);
    expect(env.access!.listenerCount).toBe(0);
  });

  it("(c) ошибка createMidiPanel: адаптер всё равно освобождается", async () => {
    const env = new FakeMidiEnvironment();
    const scope = new Scope();
    const fakeDoc = {
      createElement(): never {
        throw new Error("panel boom");
      },
    } as unknown as Document;
    const root = { ownerDocument: fakeDoc } as unknown as HTMLElement;
    const disposeSpy = vi.spyOn(MidiAdapter.prototype, "dispose");

    expect(() =>
      attachMidi(manualContext(root), realLifetime(scope, []), {
        namespace: "attach-panel-fail",
        environment: env,
        storage: new MemoryMidiStorage(),
      }),
    ).toThrow(/panel boom/);

    await scope.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect((disposeSpy.mock.instances[0] as unknown as MidiAdapter).disposed).toBe(true);
    disposeSpy.mockRestore();
  });

  it("(d) ошибка append: оба освободителя зарегистрированы и отрабатывают", async () => {
    const env = new FakeMidiEnvironment();
    const scope = new Scope();
    let panelEl: HTMLElement | null = null;
    const controls = {
      append(): never {
        throw new Error("append boom");
      },
    } as unknown as HTMLElement;
    const root = document.createElement("div");
    const create = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = create(tag);
      if (tag === "fieldset") panelEl = el;
      return el;
    });
    vi.spyOn(root, "querySelector").mockReturnValue(controls);
    const disposeSpy = vi.spyOn(MidiAdapter.prototype, "dispose");

    expect(() =>
      attachMidi(manualContext(root), realLifetime(scope, []), {
        namespace: "attach-append-fail",
        environment: env,
        storage: new MemoryMidiStorage(),
      }),
    ).toThrow(/append boom/);

    createSpy.mockRestore();
    expect(panelEl).not.toBeNull();
    let panelRemoved = false;
    const el = panelEl as unknown as HTMLElement;
    const originalRemove = el.remove.bind(el);
    el.remove = () => {
      panelRemoved = true;
      originalRemove();
    };

    await scope.dispose();
    expect(panelRemoved).toBe(true);
    expect((disposeSpy.mock.instances[0] as unknown as MidiAdapter).disposed).toBe(true);
    disposeSpy.mockRestore();
  });

  it("(e) unsupported/insecure: панель видна, connect даёт статус без запроса доступа", async () => {
    const unsupportedHost = host();
    const unsupportedEnv = new FakeMidiEnvironment();
    unsupportedEnv.supported = false;
    let unsupported!: AttachedMidi;
    const unsupportedInstance = createLab(
      definition(unsupportedEnv, new MemoryMidiStorage(), "attach-unsupported", (a) => {
        unsupported = a;
      }),
      unsupportedHost,
    );
    const unsupportedPanel = unsupportedHost.querySelector(
      ".labkit-midi-window[hidden] .labkit-midi",
    );
    expect(unsupportedPanel).not.toBeNull();
    expect(unsupportedPanel!.isConnected).toBe(true);
    expect(unsupported.midi.status.kind).toBe("idle");
    await unsupported.midi.connect();
    expect(unsupported.midi.status.kind).toBe("unsupported");
    expect(unsupportedEnv.requestCount).toBe(0);
    await unsupportedInstance.dispose();

    const insecureHost = host();
    const insecureEnv = new FakeMidiEnvironment();
    insecureEnv.secure = false;
    let insecure!: AttachedMidi;
    const insecureInstance = createLab(
      definition(insecureEnv, new MemoryMidiStorage(), "attach-insecure", (a) => {
        insecure = a;
      }),
      insecureHost,
    );
    expect(insecureHost.querySelector(".labkit-midi-window[hidden] .labkit-midi")).not.toBeNull();
    expect(insecure.midi.status.kind).toBe("idle");
    await insecure.midi.connect();
    expect(insecure.midi.status.kind).toBe("insecure");
    expect(insecureEnv.requestCount).toBe(0);
    await insecureInstance.dispose();
  });

  it("(f) inline: number/boolean/action получают кнопку, enum — нет; в т.ч. в workspace", async () => {
    const env = new FakeMidiEnvironment();
    env.addInput("dev1", "Controller");
    const mount = host();
    let attached!: AttachedMidi;
    const instance = createLab(
      fullDefinition(env, new MemoryMidiStorage(), "attach-inline", (a) => {
        attached = a;
      }),
      mount,
    );

    const levelSlot = mount.querySelector<HTMLElement>('[data-labkit-param-accessory="level"]')!;
    const onSlot = mount.querySelector<HTMLElement>('[data-labkit-param-accessory="on"]')!;
    const actionSlot = mount.querySelector<HTMLElement>('[data-labkit-action-accessory="ping"]')!;
    expect(levelSlot).not.toBeNull();
    expect(onSlot).not.toBeNull();
    expect(actionSlot).not.toBeNull();
    // enum НЕ адресуется MIDI, поэтому слот не создаётся.
    expect(mount.querySelector('[data-labkit-param-accessory="mode"]')).toBeNull();
    // boolean в workspace — слот там же.
    expect(onSlot.closest(".labkit-workspace")).not.toBeNull();

    expect(levelSlot.hidden).toBe(true);
    expect(onSlot.hidden).toBe(true);
    expect(actionSlot.hidden).toBe(true);

    attached.midi.setTraining(true);
    expect(levelSlot.hidden).toBe(false);
    expect(onSlot.hidden).toBe(false);
    expect(actionSlot.hidden).toBe(false);
    const learn = levelSlot.querySelector<HTMLButtonElement>(".labkit-midi-learn")!;
    expect(learn.dataset.target).toBe("level");
    // Клик по inline-кнопке ставит адаптер в inline-обучение по цели.
    await attached.midi.connect();
    learn.click();
    expect(attached.midi.learningTarget).toBe("level");
    expect(attached.midi.learningMappingId).toBeNull();

    await instance.dispose();
    expect(attached.midi.disposed).toBe(true);
    expect(mount.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    expect(levelSlot.hidden).toBe(true);
  });

  it("(g) падение при создании binder откатывает кнопки, адаптер/панель освобождаются", async () => {
    const env = new FakeMidiEnvironment();
    const scope = new Scope();
    const root = document.createElement("div");
    const accessory = document.createElement("span");
    accessory.className = "labkit-control-accessory";
    accessory.dataset.labkitParamAccessory = "level";
    accessory.hidden = true;
    root.append(accessory);
    document.body.append(root);

    // Панель подписывается первой; binder — вторым вызовом subscribe. Имитируем
    // падение binder'а и проверяем, что откат не оставляет ни кнопок, ни
    // подписки, а ранее зарегистрированные освободители всё равно отрабатывают.
    const originalSubscribe = MidiAdapter.prototype.subscribe;
    let calls = 0;
    const subscribeSpy = vi.spyOn(MidiAdapter.prototype, "subscribe").mockImplementation(function (
      this: MidiAdapter,
      listener: () => void,
    ) {
      calls += 1;
      if (calls === 2) throw new Error("binder subscribe boom");
      return originalSubscribe.call(this, listener);
    });
    const disposeSpy = vi.spyOn(MidiAdapter.prototype, "dispose");

    expect(() =>
      attachMidi(manualContext(root), realLifetime(scope, []), {
        namespace: "attach-binder-fail",
        environment: env,
        storage: new MemoryMidiStorage(),
      }),
    ).toThrow(/binder subscribe boom/);

    expect(root.querySelectorAll(".labkit-midi-learn")).toHaveLength(0);
    expect(accessory.hidden).toBe(true);

    await scope.dispose();
    expect(root.querySelector(".labkit-midi")).toBeNull();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect((disposeSpy.mock.instances[0] as unknown as MidiAdapter).disposed).toBe(true);

    subscribeSpy.mockRestore();
    disposeSpy.mockRestore();
  });
});

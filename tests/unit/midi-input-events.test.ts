// Opt-in поток музыкальных MIDI-событий внутри единственного MidiAdapter.
// Проверяем реальный адаптер на FakeMidiEnvironment: registry-first доставку,
// снимки/флаги, learn, reset'ы выбора/disconnect/dispose, изоляцию подписчиков
// и регрессию инвалидации старого сообщения после внешних колбэков.
import { describe, expect, it } from "vitest";
import { ParameterRegistry } from "../../src/core/registry.ts";
import type { ParameterSpec } from "../../src/core/params.ts";
import { MidiAdapter, type MidiActionHost } from "../../src/midi/adapter.ts";
import { FakeMidiEnvironment } from "../../src/midi/testing.ts";
import { MemoryMidiStorage, midiStorageKey } from "../../src/midi/store.ts";
import type { MidiInputEvent, MidiMessage } from "../../src/midi/types.ts";

interface TestState {
  level: number;
  on: boolean;
  enabled: boolean;
  locked: number;
}

function makeRegistry(): ParameterRegistry<TestState> {
  const specs: Record<string, ParameterSpec<TestState>> = {
    level: {
      kind: "number",
      id: "level",
      label: "Level",
      min: 0,
      max: 10,
      step: 0.5,
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
    enabled: {
      kind: "boolean",
      id: "enabled",
      label: "Enabled",
      read: (state) => state.enabled,
      write: (state, value) => {
        state.enabled = value;
      },
    },
    locked: {
      kind: "number",
      id: "locked",
      label: "Locked",
      min: 0,
      max: 1,
      step: 0.1,
      available: (state) => state.enabled,
      read: (state) => state.locked,
      write: (state, value) => {
        state.locked = value;
      },
    },
  };
  return new ParameterRegistry<TestState>({ level: 0, on: false, enabled: true, locked: 0 }, specs);
}

class TestActions implements MidiActionHost {
  has(id: string): boolean {
    return id === "pulse";
  }
  ids(): string[] {
    return ["pulse"];
  }
  isAvailable(): boolean {
    return true;
  }
  label(): string {
    return "Pulse";
  }
  async execute(): Promise<void> {}
}

interface HarnessOptions {
  namespace?: string;
  onMonitor?(message: MidiMessage | null): void;
  onError?(error: unknown): void;
  onChange?(): void;
}

function makeHarness(options: HarnessOptions = {}) {
  const registry = makeRegistry();
  const actions = new TestActions();
  const env = new FakeMidiEnvironment();
  const storage = new MemoryMidiStorage();
  const adapter = new MidiAdapter({
    namespace: options.namespace ?? "input-events",
    params: registry,
    actions,
    environment: env,
    storage,
    lifetime: { disposed: false },
    onMonitor: options.onMonitor,
    onError: options.onError,
    onChange: options.onChange,
  });
  return { adapter, registry, actions, env, storage };
}

type MessageEvent = Extract<MidiInputEvent, { type: "message" }>;
type ResetEvent = Extract<MidiInputEvent, { type: "input-reset" }>;

function messageEvents(events: readonly MidiInputEvent[]): MessageEvent[] {
  return events.filter((event): event is MessageEvent => event.type === "message");
}

function resetEvents(events: readonly MidiInputEvent[]): ResetEvent[] {
  return events.filter((event): event is ResetEvent => event.type === "input-reset");
}

/**
 * Простой музыкальный ledger локального инструмента: держит ноты по inputId и
 * освобождает их только по scoped-reset. Так тесты видят потерю reset'а, даже
 * если адаптер/registry уже освобождены.
 */
function trackLedger(adapter: MidiAdapter) {
  const held = new Map<string, Set<number>>();
  const resets: ResetEvent[] = [];
  const unsubscribe = adapter.subscribeInput((event) => {
    if (event.type === "input-reset") {
      held.delete(event.inputId);
      resets.push(event);
      return;
    }
    if (event.message.source !== "note") return;
    let notes = held.get(event.inputId);
    if (!notes) {
      notes = new Set<number>();
      held.set(event.inputId, notes);
    }
    if (event.message.on) notes.add(event.message.number);
    else notes.delete(event.message.number);
    if (notes.size === 0) held.delete(event.inputId);
  });
  return { held, resets, unsubscribe };
}

describe("MidiAdapter.subscribeInput: сообщения", () => {
  it("доставляет CC и Note (On/Off/velocity=0) независимым readonly-снимком", async () => {
    const { adapter, env } = makeHarness();
    const input = env.addInput("dev1", "Keys");
    await adapter.connect();
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    const mutableData = [0xb2, 20, 100]; // CC на канале 3
    input.emit(mutableData);
    mutableData[2] = 0; // event.data не должен быть связан со снимком
    input.emit([0x90, 60, 100]); // Note On
    input.emit([0x91, 60, 0]); // Note On velocity=0 → on:false
    input.emit([0x80, 60, 64]); // Note Off

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({
      type: "message",
      inputId: "dev1",
      message: { channel: 3, source: "cc", number: 20, value: 100, on: false },
      consumedByLearn: false,
      matchedMapping: false,
    });
    expect(messageEvents(events).map((event) => event.message)).toEqual([
      { channel: 3, source: "cc", number: 20, value: 100, on: false },
      { channel: 1, source: "note", number: 60, value: 100, on: true },
      { channel: 2, source: "note", number: 60, value: 0, on: false },
      { channel: 1, source: "note", number: 60, value: 64, on: false },
    ]);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(messageEvents(events)[0]!.message)).toBe(true);
    adapter.dispose();
  });

  it("снимок не мутируется onMonitor/другим подписчиком", async () => {
    const { adapter, env } = makeHarness({
      onMonitor: (message) => {
        // Внешний колбэк не должен влиять на снимок, который получат подписчики.
        if (message) message.value = 1;
      },
    });
    const input = env.addInput("dev1");
    await adapter.connect();
    const received: number[] = [];
    adapter.subscribeInput((event) => {
      if (event.type !== "message") return;
      try {
        (event.message as { value: number }).value = 0;
      } catch {
        // Frozen-снимок: мутация ожидаемо отвергается.
      }
    });
    adapter.subscribeInput((event) => {
      if (event.type === "message") received.push(event.message.value);
    });

    input.emit([0xb0, 20, 100]);
    expect(received).toEqual([100]);
    expect(adapter.lastMessage?.value).toBe(1); // onMonitor получил свой объект
    adapter.dispose();
  });

  it("learn: флаги сняты до мутации, dispatch поглощён, сообщение доставлено", async () => {
    const { adapter, registry, env } = makeHarness();
    const input = env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 20, channel: 0 });
    adapter.startLearn("on");
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    input.emit([0xb0, 20, 127]);

    // Существующая строка CC20/ch0 совпадает → matchedMapping=true; обычный
    // dispatch поглощён обучением, параметр не изменился.
    expect(registry.getNumber("level")).toBe(0);
    expect(adapter.mappings().some((row) => row.target === "on" && row.number === 20)).toBe(true);
    expect(events).toEqual([
      {
        type: "message",
        inputId: "dev1",
        message: { channel: 1, source: "cc", number: 20, value: 127, on: false },
        consumedByLearn: true,
        matchedMapping: true,
      },
    ]);
    adapter.dispose();
  });

  it("learn: matchedMapping отражает строки ДО обучения, а не созданную строку", async () => {
    const { adapter, env } = makeHarness();
    const input = env.addInput("dev1");
    await adapter.connect();
    // Совпадает source/number, но не канал: до обучения строки для ch1 нет.
    adapter.addMapping({ target: "level", source: "cc", number: 20, channel: 5 });
    adapter.startLearn("on");
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    input.emit([0xb0, 20, 64]);

    const [event] = messageEvents(events);
    expect(event?.consumedByLearn).toBe(true);
    expect(event?.matchedMapping).toBe(false); // не true из-за только что созданной on/ch1
    expect(adapter.mappings().some((row) => row.target === "on" && row.channel === 1)).toBe(true);
    adapter.dispose();
  });

  it("learn: Note Off не обучает и доставляется с consumedByLearn=false", async () => {
    const { adapter, env } = makeHarness();
    const input = env.addInput("dev1");
    await adapter.connect();
    adapter.startLearn("on");
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    input.emit([0x80, 40, 0]);

    expect(adapter.mappings()).toHaveLength(0);
    expect(adapter.learningTarget).toBe("on");
    expect(messageEvents(events)[0]).toMatchObject({
      consumedByLearn: false,
      matchedMapping: false,
      message: { channel: 1, source: "note", number: 40, value: 0, on: false },
    });
    adapter.dispose();
  });

  it("matchedMapping=true для недоступной цели; SDK не фильтрует сообщение", async () => {
    const { adapter, registry, env } = makeHarness();
    const input = env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "locked", source: "cc", number: 70 });
    registry.set("enabled", false, "api");
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    input.emit([0xb0, 70, 127]);

    expect(registry.getNumber("locked")).toBe(0);
    expect(adapter.detail).toContain("неактивен");
    expect(messageEvents(events)[0]).toMatchObject({
      consumedByLearn: false,
      matchedMapping: true,
      message: { source: "cc", number: 70, value: 127 },
    });
    adapter.dispose();
  });

  it("registry dispatch выполняется до музыкального подписчика; UI notify — после", async () => {
    const order: string[] = [];
    const { adapter, registry, env } = makeHarness({
      onMonitor: (message) => {
        if (message) order.push("monitor");
      },
      onChange: () => order.push("change"),
    });
    const input = env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 20 });
    adapter.subscribeInput((event) => {
      if (event.type === "message") order.push(`subscriber:${registry.getNumber("level")}`);
    });
    order.length = 0;

    input.emit([0xb0, 20, 127]);

    expect(order).toEqual(["monitor", "subscriber:10", "change"]);
    adapter.dispose();
  });
});

describe("MidiAdapter.subscribeInput: подписчики", () => {
  it("ошибка одного подписчика сообщается onError и не глушит остальных", async () => {
    const errors: unknown[] = [];
    const { adapter, env } = makeHarness({ onError: (error) => errors.push(error) });
    const input = env.addInput("dev1");
    await adapter.connect();
    const received: MidiMessage[] = [];
    adapter.subscribeInput(() => {
      throw new Error("subscriber boom");
    });
    adapter.subscribeInput((event) => {
      if (event.type === "message") received.push(event.message);
    });

    input.emit([0xb0, 20, 64]);

    expect(errors).toHaveLength(1);
    expect(received).toHaveLength(1);
    adapter.dispose();
  });

  it("unsubscribe идемпотентен; отписанный во время обхода не получает событие", async () => {
    const { adapter, env } = makeHarness();
    const input = env.addInput("dev1");
    await adapter.connect();
    const first: MidiInputEvent[] = [];
    const second: MidiInputEvent[] = [];
    const unsubscribeFirst = adapter.subscribeInput((event) => first.push(event));
    const unsubscribeSecond = adapter.subscribeInput((event) => second.push(event));

    unsubscribeFirst();
    unsubscribeFirst();
    input.emit([0xb0, 20, 1]);
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);

    // Ставим «отписывающего» первым, чтобы он успел снять следующего.
    unsubscribeSecond();
    unsubscribeSecond();
    second.length = 0;
    let unsubscribeLate = (): void => {};
    adapter.subscribeInput(() => unsubscribeLate());
    unsubscribeLate = adapter.subscribeInput((event) => second.push(event));
    input.emit([0xb0, 20, 2]);
    expect(second).toHaveLength(0);
    adapter.dispose();
  });

  it("смена входа во время доставки не пропускает старое сообщение следующим", async () => {
    const { adapter, env } = makeHarness();
    const first = env.addInput("one");
    env.addInput("two");
    await adapter.connect();
    adapter.selectAllInputs();
    const secondEvents: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => {
      if (event.type === "message" && event.inputId === "one") adapter.selectInput("two");
    });
    adapter.subscribeInput((event) => secondEvents.push(event));

    first.emit([0xb0, 20, 127]);

    expect(messageEvents(secondEvents)).toHaveLength(0);
    expect(resetEvents(secondEvents)).toEqual([
      { type: "input-reset", inputId: "one", reason: "selection" },
    ]);
    adapter.dispose();
  });
});

describe("MidiAdapter.subscribeInput: reset выбора/disconnect", () => {
  it("disconnect одного входа сбрасывает только его; второй продолжает работать", async () => {
    const { adapter, env } = makeHarness();
    const first = env.addInput("dev1");
    const second = env.addInput("dev2");
    await adapter.connect();
    adapter.selectAllInputs();
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    env.disconnectInput("dev1");
    env.fireStateChange();

    expect(resetEvents(events)).toEqual([
      { type: "input-reset", inputId: "dev1", reason: "disconnect" },
    ]);
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(1);

    events.length = 0;
    second.emit([0xb0, 20, 127]);
    expect(messageEvents(events)[0]).toMatchObject({ inputId: "dev2" });
    adapter.dispose();
  });

  it("selectInput/selectAllInputs: scoped reset только для снятых входов, без лишних", async () => {
    const { adapter, env } = makeHarness();
    env.addInput("dev1");
    env.addInput("dev2");
    await adapter.connect();
    adapter.selectAllInputs();
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    adapter.selectInput("dev2");
    expect(resetEvents(events)).toEqual([
      { type: "input-reset", inputId: "dev1", reason: "selection" },
    ]);

    // Повторный выбор того же входа не меняет membership → reset не нужен.
    events.length = 0;
    adapter.selectInput("dev2");
    expect(events).toEqual([]);

    // Добавление ранее снятого входа (selectAllInputs) — не reset.
    adapter.selectAllInputs();
    expect(events).toEqual([]);

    adapter.selectInput("dev1");
    expect(resetEvents(events)).toEqual([
      { type: "input-reset", inputId: "dev2", reason: "selection" },
    ]);
    adapter.dispose();
  });

  it("onMonitor, сменивший вход, инвалидирует старое сообщение", async () => {
    const env = new FakeMidiEnvironment();
    const first = env.addInput("one");
    env.addInput("two");
    let armed = false;
    const adapter: MidiAdapter = new MidiAdapter({
      namespace: "monitor-selection",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      onMonitor: (message) => {
        if (message && armed) adapter.selectInput("two");
      },
    });
    await adapter.connect();
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));
    armed = true;

    first.emit([0xb0, 20, 127]);

    expect(messageEvents(events)).toHaveLength(0);
    expect(resetEvents(events)).toEqual([
      { type: "input-reset", inputId: "one", reason: "selection" },
    ]);
    adapter.dispose();
  });

  it("dispose из onMonitor отменяет сообщение; терминальный reset доходит", async () => {
    const env = new FakeMidiEnvironment();
    const input = env.addInput("dev1");
    const adapter: MidiAdapter = new MidiAdapter({
      namespace: "monitor-dispose",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      onMonitor: (message) => {
        if (message) adapter.dispose();
      },
    });
    await adapter.connect();
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    input.emit([0xb0, 20, 127]);

    expect(messageEvents(events)).toHaveLength(0);
    expect(resetEvents(events)).toEqual([
      { type: "input-reset", inputId: "dev1", reason: "dispose" },
    ]);
    expect(input.listenerCount).toBe(0);
  });

  it("dispose из подписчика отменяет доставку остальным, terminal reset доходит", async () => {
    const { adapter, env } = makeHarness();
    const input = env.addInput("dev1");
    await adapter.connect();
    const secondEvents: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => {
      if (event.type === "message") adapter.dispose();
    });
    adapter.subscribeInput((event) => secondEvents.push(event));

    input.emit([0xb0, 20, 127]);

    expect(messageEvents(secondEvents)).toHaveLength(0);
    expect(resetEvents(secondEvents)).toEqual([
      { type: "input-reset", inputId: "dev1", reason: "dispose" },
    ]);
  });

  it("dispose: терминальный reset ранее активным входам, затем никаких сообщений", async () => {
    const { adapter, env } = makeHarness();
    const first = env.addInput("dev1");
    const second = env.addInput("dev2");
    await adapter.connect();
    adapter.selectAllInputs();
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    adapter.dispose();

    expect(resetEvents(events)).toEqual([
      { type: "input-reset", inputId: "dev1", reason: "dispose" },
      { type: "input-reset", inputId: "dev2", reason: "dispose" },
    ]);
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(0);
    const afterDispose = events.length;

    adapter.dispose(); // идемпотентно: повторных reset нет
    first.emit([0xb0, 20, 127]);
    second.emit([0xb0, 20, 127]);
    adapter.subscribeInput((event) => events.push(event));
    expect(events).toHaveLength(afterDispose);
    expect(messageEvents(events)).toHaveLength(0);
  });
});

describe("MidiAdapter: pending reset не теряется во внешних callback'ах", () => {
  it("disconnect + dispose из registry-колбэка освобождает музыкальный ledger снятого входа", async () => {
    const { adapter, registry, env } = makeHarness({ namespace: "pending-disconnect-dispose" });
    const input = env.addInput("one");
    await adapter.connect();
    adapter.addMapping({ target: "on", source: "note", number: 40 });
    const ledger = trackLedger(adapter);

    input.emit([0x90, 60, 100]); // неназначенная музыкальная нота
    input.emit([0x90, 40, 100]); // назначенная нота держит boolean
    expect(ledger.held.get("one")).toEqual(new Set([40, 60]));
    expect(registry.getBoolean("on")).toBe(true);

    registry.subscribeParam("on", () => {
      if (!registry.getBoolean("on")) adapter.dispose();
    });
    env.disconnectInput("one");
    env.fireStateChange();

    expect(adapter.disposed).toBe(true);
    expect(ledger.resets).toEqual([{ type: "input-reset", inputId: "one", reason: "disconnect" }]);
    expect(ledger.held.has("one")).toBe(false);
    expect(input.listenerCount).toBe(0);
  });

  it("disconnect + selectInput из registry-колбэка не теряет reset и не убивает owner", async () => {
    const { adapter, registry, env } = makeHarness({ namespace: "pending-disconnect-selection" });
    const first = env.addInput("one");
    const second = env.addInput("two");
    await adapter.connect();
    adapter.addMapping({ target: "on", source: "note", number: 40 });
    const ledger = trackLedger(adapter);

    first.emit([0x90, 60, 100]);
    first.emit([0x90, 40, 100]);
    registry.subscribeParam("on", () => {
      if (!registry.getBoolean("on")) adapter.selectInput("two");
    });

    env.disconnectInput("one");
    env.fireStateChange();

    expect(adapter.disposed).toBe(false);
    expect(adapter.listeningInputIds()).toEqual(["two"]);
    expect(ledger.resets).toEqual([{ type: "input-reset", inputId: "one", reason: "disconnect" }]);
    expect(ledger.held.has("one")).toBe(false);
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(1);
    adapter.dispose();
  });

  it("selection → dispose из onMonitor(null) доставляет reset снятого входа", async () => {
    const env = new FakeMidiEnvironment();
    const first = env.addInput("one");
    env.addInput("two");
    let armed = false;
    const adapter: MidiAdapter = new MidiAdapter({
      namespace: "pending-monitor-dispose",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      onMonitor: (message) => {
        if (message === null && armed) adapter.dispose();
      },
    });
    await adapter.connect();
    const ledger = trackLedger(adapter);
    first.emit([0x90, 60, 100]);
    expect(ledger.held.has("one")).toBe(true);

    armed = true;
    adapter.selectInput("two");

    expect(adapter.disposed).toBe(true);
    expect(ledger.resets).toEqual([
      { type: "input-reset", inputId: "one", reason: "selection" },
      { type: "input-reset", inputId: "two", reason: "dispose" },
    ]);
    expect(ledger.held.has("one")).toBe(false);
  });

  it("dispose из scoped-reset listener'а не скрывает release от следующего подписчика", async () => {
    const { adapter, env } = makeHarness({ namespace: "pending-reset-dispose" });
    const first = env.addInput("one");
    env.addInput("two");
    await adapter.connect();
    adapter.subscribeInput((event) => {
      if (event.type === "input-reset") adapter.dispose();
    });
    const ledger = trackLedger(adapter);
    first.emit([0x90, 60, 100]);

    adapter.selectInput("two");

    expect(adapter.disposed).toBe(true);
    expect(ledger.resets).toEqual([
      { type: "input-reset", inputId: "one", reason: "selection" },
      { type: "input-reset", inputId: "two", reason: "dispose" },
    ]);
    expect(ledger.held.has("one")).toBe(false);
  });
});

describe("MidiAdapter: reset прошлого периода после повторной активации inputId", () => {
  it("повторный selectInput('one') не отменяет обязательный reset уже снятого one", async () => {
    const { adapter, registry, env } = makeHarness({ namespace: "pending-readd" });
    const one = env.addInput("one");
    env.addInput("two");
    await adapter.connect();
    const ledger = trackLedger(adapter);
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    // 1. Неназначенный On60 создаёт музыкальное удержание прошлого периода.
    one.emit([0x90, 60, 100]);
    expect(ledger.held.get("one")).toEqual(new Set([60]));

    // 2. Note60 → boolean a; 3. Note40 → boolean b (b удерживается).
    adapter.addMapping({ target: "on", source: "note", number: 60 });
    registry.set("on", true, "api");
    adapter.addMapping({ target: "enabled", source: "note", number: 40 });
    registry.set("enabled", false, "api");
    one.emit([0x90, 40, 100]);
    expect(registry.getBoolean("enabled")).toBe(true);

    // 4/5. Release b выбирает one назад до доставки pending-reset'а one.
    const unsubscribeA = registry.subscribeParam("on", () => {
      if (!registry.getBoolean("on")) adapter.selectInput("two");
    });
    const unsubscribeB = registry.subscribeParam("enabled", () => {
      if (!registry.getBoolean("enabled")) adapter.selectInput("one");
    });

    // 6. Off60: a=false → select two → release b=false → select one.
    const beforeOff = events.length;
    one.emit([0x80, 60, 0]);

    expect(adapter.disposed).toBe(false);
    expect(adapter.listeningInputIds()).toEqual(["one"]);
    expect(resetEvents(events.slice(beforeOff))).toEqual([
      { type: "input-reset", inputId: "one", reason: "selection" },
    ]);
    expect(messageEvents(events.slice(beforeOff))).toHaveLength(0);
    expect(ledger.resets).toEqual([{ type: "input-reset", inputId: "one", reason: "selection" }]);
    expect(ledger.held.has("one")).toBe(false);

    // Возвращённый one начинает НОВЫЙ период: On/Off доставляются нормально.
    unsubscribeA();
    unsubscribeB();
    const afterReset = events.length;
    one.emit([0x90, 60, 100]);
    expect(ledger.held.get("one")).toEqual(new Set([60]));
    one.emit([0x80, 60, 0]);
    expect(ledger.held.has("one")).toBe(false);
    expect(resetEvents(events.slice(afterReset))).toHaveLength(0);
    expect(messageEvents(events.slice(afterReset)).map((event) => event.message.on)).toEqual([
      true,
      false,
    ]);
    adapter.dispose();
  });
});

describe("MidiAdapter: stale learn после release-callback (P2)", () => {
  it("смена входа при release отменяет learn и не перезаписывает mapping/storage", async () => {
    const { adapter, registry, env, storage } = makeHarness({ namespace: "learn-revision" });
    const first = env.addInput("one");
    env.addInput("two");
    await adapter.connect();
    adapter.addMapping({ target: "on", source: "note", number: 40 });
    first.emit([0x90, 40, 100]);
    expect(registry.getBoolean("on")).toBe(true);
    const savedBefore = storage.getItem(midiStorageKey("learn-revision"));
    expect(savedBefore).not.toBeNull();

    registry.subscribeParam("on", () => {
      if (!registry.getBoolean("on")) adapter.selectInput("two");
    });
    adapter.startLearn("on");
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    first.emit([0xb0, 20, 64]);

    expect(adapter.listeningInputIds()).toEqual(["two"]);
    expect(adapter.learningTarget).toBeNull();
    expect(adapter.mappings()[0]).toMatchObject({
      source: "note",
      number: 40,
      channel: 0,
    });
    expect(messageEvents(events)).toHaveLength(0);
    expect(storage.getItem(midiStorageKey("learn-revision"))).toBe(savedBefore);
    const saved = JSON.parse(savedBefore!) as {
      mappings: Array<{ source: string; number: number }>;
    };
    expect(saved.mappings[0]).toMatchObject({ source: "note", number: 40 });
    adapter.dispose();
  });
});

describe("MidiAdapter: регрессия инвалидации dispatch", () => {
  it("смена входа из registry-колбэка прекращает обработку следующих строк", async () => {
    const { adapter, registry, env } = makeHarness();
    const input = env.addInput("dev1");
    env.addInput("dev2");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 20 });
    adapter.addMapping({ target: "locked", source: "cc", number: 20 });
    registry.subscribeParam("level", () => adapter.selectInput("dev2"));
    const events: MidiInputEvent[] = [];
    adapter.subscribeInput((event) => events.push(event));

    input.emit([0xb0, 20, 127]);

    expect(registry.getNumber("level")).toBe(10);
    // Без revision-guard'а вторая строка записала бы locked=1 уже после смены входа.
    expect(registry.getNumber("locked")).toBe(0);
    expect(messageEvents(events)).toHaveLength(0);
    adapter.dispose();
  });
});

import { describe, expect, it } from "vitest";
import { ParameterRegistry } from "../../src/core/registry.ts";
import type { ParameterSpec } from "../../src/core/params.ts";
import { MidiAdapter, type MidiActionHost } from "../../src/midi/adapter.ts";
import { midiNoteVelocity } from "../../src/midi/action-input.ts";
import { FakeMidiEnvironment } from "../../src/midi/testing.ts";
import type { MidiActionInput } from "../../src/midi/types.ts";
import { MemoryMidiStorage, loadMidiState, midiStorageKey } from "../../src/midi/store.ts";
import { realMidiEnvironment } from "../../src/midi/environment.ts";

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
      read: (s) => s.level,
      write: (s, v) => {
        s.level = v;
      },
    },
    on: {
      kind: "boolean",
      id: "on",
      label: "On",
      read: (s) => s.on,
      write: (s, v) => {
        s.on = v;
      },
    },
    enabled: {
      kind: "boolean",
      id: "enabled",
      label: "Enabled",
      read: (s) => s.enabled,
      write: (s, v) => {
        s.enabled = v;
      },
    },
    locked: {
      kind: "number",
      id: "locked",
      label: "Locked",
      min: 0,
      max: 1,
      step: 0.1,
      available: (s) => s.enabled,
      read: (s) => s.locked,
      write: (s, v) => {
        s.locked = v;
      },
    },
  };
  return new ParameterRegistry<TestState>({ level: 0, on: false, enabled: true, locked: 0 }, specs);
}

class TestActions implements MidiActionHost {
  executed: string[] = [];
  inputs: Array<{ id: string; input?: MidiActionInput }> = [];
  available = true;
  has(id: string): boolean {
    return id === "pulse" || id === "blocked";
  }
  ids(): string[] {
    return ["pulse", "blocked"];
  }
  isAvailable(): boolean {
    return this.available;
  }
  label(id: string): string {
    return id === "pulse" ? "Pulse" : "Blocked";
  }
  async execute(
    id: string,
    _origin: Parameters<MidiActionHost["execute"]>[1],
    input?: MidiActionInput,
  ): Promise<void> {
    this.executed.push(id);
    this.inputs.push({ id, input });
  }
}

function makeHarness(namespace = "test", storage = new MemoryMidiStorage()) {
  const registry = makeRegistry();
  const actions = new TestActions();
  const env = new FakeMidiEnvironment();
  const lifetime = { disposed: false };
  const adapter = new MidiAdapter({
    namespace,
    params: registry,
    actions,
    environment: env,
    storage,
    lifetime,
  });
  return { adapter, registry, actions, env, storage, lifetime };
}

describe("MidiAdapter: подключение и устройства", () => {
  it("подключается, выбирает первый вход, hotplug и reconnect", async () => {
    const { adapter, env } = makeHarness();
    await adapter.connect();
    expect(adapter.status.kind).toBe("no-inputs");
    env.addInput("dev1", "Controller");
    env.fireStateChange();
    expect(adapter.status.kind).toBe("connected");
    expect(adapter.inputId).toBe("dev1");
    // Отключение единственного входа: не подменяем «желаемый» вход молча;
    // список пуст (как эталон), но wanted сохранён для reconnect.
    env.disconnectInput("dev1");
    env.fireStateChange();
    expect(adapter.inputId).toBe("");
    expect(adapter.devices().length).toBe(0);
    // Переподключение того же входа: возвращаемся к нему.
    const input = env.access!.inputs.get("dev1")!;
    input.state = "connected";
    env.fireStateChange();
    expect(adapter.inputId).toBe("dev1");
    expect(adapter.status.kind).toBe("connected");
  });

  it("при отключении выбранного входа не подменяет его другим (wanted сохранён)", async () => {
    const { adapter, env } = makeHarness();
    env.addInput("dev1");
    env.addInput("dev2");
    await adapter.connect();
    adapter.selectInput("dev1");
    expect(adapter.inputId).toBe("dev1");
    env.disconnectInput("dev1");
    env.fireStateChange();
    expect(adapter.inputId).toBe("");
    expect(adapter.status.kind).toBe("input-disconnected");
    expect(adapter.devices().map((d) => d.id)).toEqual(["dev2"]);
    // Восстановление dev1 возвращает именно его, не dev2.
    env.access!.inputs.get("dev1")!.state = "connected";
    env.fireStateChange();
    expect(adapter.inputId).toBe("dev1");
  });

  it("режим «все входы»: два устройства одновременно управляют общей целью", async () => {
    const { adapter, registry, env } = makeHarness("all-inputs");
    const first = env.addInput("dev1", "Keys");
    const second = env.addInput("dev2", "Pads");
    await adapter.connect();
    adapter.selectAllInputs();
    expect(adapter.allInputs).toBe(true);
    expect(adapter.listeningInputIds().sort()).toEqual(["dev1", "dev2"]);
    expect(adapter.status.message).toContain("2");
    expect(first.listenerCount).toBe(1);
    expect(second.listenerCount).toBe(1);

    adapter.addMapping({ target: "level", source: "cc", number: 20 });
    first.emit([0xb0, 20, 64]);
    expect(registry.getNumber("level")).toBeGreaterThan(0);
    second.emit([0xb0, 20, 127]);
    expect(registry.getNumber("level")).toBe(10);

    adapter.dispose();
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(0);
  });

  it("режим «все входы»: hotplug и отключение одного не ломают другой", async () => {
    const { adapter, registry, env } = makeHarness("all-hotplug");
    const first = env.addInput("dev1");
    await adapter.connect();
    adapter.selectAllInputs();
    adapter.addMapping({ target: "level", number: 20 });

    const second = env.addInput("dev2");
    env.fireStateChange();
    expect(second.listenerCount).toBe(1);
    expect(adapter.listeningInputIds().sort()).toEqual(["dev1", "dev2"]);

    env.disconnectInput("dev1");
    env.fireStateChange();
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(1);
    expect(adapter.listeningInputIds()).toEqual(["dev2"]);
    second.emit([0xb0, 20, 127]);
    expect(registry.getNumber("level")).toBe(10);
    adapter.dispose();
  });

  it("режим «все входы»: Note Off одного устройства не отпускает ноту другого", async () => {
    const { adapter, registry, env } = makeHarness("all-holds");
    const first = env.addInput("dev1");
    const second = env.addInput("dev2");
    await adapter.connect();
    adapter.selectAllInputs();
    adapter.addMapping({ target: "on", source: "note", number: 40 });

    first.emit([0x90, 40, 100]);
    expect(registry.getBoolean("on")).toBe(true);
    second.emit([0x80, 40, 0]);
    expect(registry.getBoolean("on")).toBe(true);
    first.emit([0x80, 40, 0]);
    expect(registry.getBoolean("on")).toBe(false);
    adapter.dispose();
  });

  it("режим «все входы»: обучение ловит любое устройство, выбор одного отключает остальные", async () => {
    const { adapter, env } = makeHarness("all-learn");
    const first = env.addInput("dev1");
    const second = env.addInput("dev2");
    await adapter.connect();
    adapter.selectAllInputs();
    adapter.startLearn("level");
    second.emit([0xb0, 72, 100]);
    expect(adapter.mappings()[0]).toMatchObject({ target: "level", source: "cc", number: 72 });

    adapter.selectInput("dev1");
    expect(adapter.allInputs).toBe(false);
    expect(adapter.listeningInputIds()).toEqual(["dev1"]);
    expect(first.listenerCount).toBe(1);
    expect(second.listenerCount).toBe(0);
    adapter.dispose();
  });

  it("inputMode: 'all' включает все входы сразу после connect", async () => {
    const registry = makeRegistry();
    const env = new FakeMidiEnvironment();
    env.addInput("dev1");
    env.addInput("dev2");
    const adapter = new MidiAdapter({
      namespace: "all-option",
      params: registry,
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      inputMode: "all",
    });
    await adapter.connect();
    expect(adapter.allInputs).toBe(true);
    expect(adapter.listeningInputIds().sort()).toEqual(["dev1", "dev2"]);
    adapter.dispose();
  });

  it("unsupported/insecure статусы без запроса доступа", async () => {
    const { adapter, env } = makeHarness();
    env.supported = false;
    await adapter.connect();
    expect(adapter.status.kind).toBe("unsupported");
    expect(env.requestCount).toBe(0);
    env.supported = true;
    env.secure = false;
    await adapter.connect();
    expect(adapter.status.kind).toBe("insecure");
    expect(env.requestCount).toBe(0);
  });
});

describe("MidiAdapter: learn и CRUD/persist", () => {
  it("learn создаёт назначение из CC и сохраняет в версионированный ключ", async () => {
    const { adapter, env, storage } = makeHarness();
    env.addInput("dev1");
    await adapter.connect();
    adapter.startLearn("level");
    env.access!.inputs.get("dev1")!.emit([0xb0, 20, 64]);
    expect(adapter.mappings().length).toBe(1);
    expect(adapter.mappings()[0]).toMatchObject({ target: "level", source: "cc", number: 20 });
    expect(adapter.learningTarget).toBeNull();
    const raw = storage.getItem(midiStorageKey("test"));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ version: 2 });
  });

  it("learn записывает фактический канал и сохраняет его в v2", async () => {
    const { adapter, env, storage } = makeHarness("learn-channel");
    env.addInput("dev1");
    await adapter.connect();
    const input = env.access!.inputs.get("dev1")!;
    adapter.startLearn("level");
    input.emit([0xb4, 20, 64]); // статус 0xB4 → канал 5
    expect(adapter.mappings()[0]).toMatchObject({ target: "level", number: 20, channel: 5 });

    // Повторное обучение переносит строку на новый фактический канал.
    adapter.startLearn("level");
    input.emit([0xb6, 25, 64]); // статус 0xB6 → канал 7
    expect(adapter.mappings()[0]).toMatchObject({ target: "level", number: 25, channel: 7 });

    const saved = JSON.parse(storage.getItem(midiStorageKey("learn-channel"))!);
    expect(saved).toMatchObject({ version: 2 });
    expect(saved.mappings[0]).toMatchObject({ number: 25, channel: 7 });

    const restored = new MidiAdapter({
      namespace: "learn-channel",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
    });
    expect(restored.mappings()[0]).toMatchObject({ number: 25, channel: 7 });
    restored.dispose();
    adapter.dispose();
  });

  it("NoteOff не обучает, NoteOn — да; CC 0 обучает", async () => {
    const { adapter, env } = makeHarness();
    env.addInput("dev1");
    await adapter.connect();
    const input = env.access!.inputs.get("dev1")!;
    adapter.startLearn("on");
    input.emit([0x80, 40, 0]);
    expect(adapter.mappings().length).toBe(0);
    expect(adapter.learningTarget).toBe("on");
    input.emit([0x90, 40, 100]);
    expect(adapter.mappings()[0]).toMatchObject({ target: "on", source: "note", number: 40 });

    adapter.startLearn("level");
    input.emit([0xb0, 0, 0]);
    expect(adapter.mappings().some((m) => m.target === "level" && m.number === 0)).toBe(true);
  });

  it("повторный learn обновляет первое назначение цели, не создавая второе", async () => {
    const { adapter, env } = makeHarness();
    env.addInput("dev1");
    await adapter.connect();
    const input = env.access!.inputs.get("dev1")!;
    adapter.startLearn("level");
    input.emit([0xb0, 20, 64]);
    adapter.startLearn("level");
    input.emit([0xb0, 25, 64]);
    const rows = adapter.mappings().filter((m) => m.target === "level");
    expect(rows.length).toBe(1);
    expect(rows[0]!.number).toBe(25);
  });

  it("CRUD: add/update/remove и восстановление из хранилища", async () => {
    const { adapter, storage } = makeHarness();
    const mapping = adapter.addMapping({
      target: "level",
      source: "cc",
      number: 7,
      mode: "delta",
      sensitivity: 3,
      invert: true,
    });
    expect(mapping).not.toBeNull();
    adapter.updateMapping(mapping!.id, { number: 9, mode: "wrap" });
    expect(adapter.mappings()[0]).toMatchObject({ number: 9, mode: "wrap" });
    const restored = new MidiAdapter({
      namespace: "test",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
    });
    expect(restored.mappings()[0]).toMatchObject({
      target: "level",
      number: 9,
      mode: "wrap",
      sensitivity: 3,
      invert: true,
    });
    adapter.removeMapping(mapping!.id);
    expect(adapter.mappings().length).toBe(0);
  });
});

describe("MidiAdapter: summary назначения", () => {
  it("targetSummary показывает канал, Δ и +N в разумном порядке", () => {
    const { adapter } = makeHarness("summary");
    adapter.addMapping({ target: "level", source: "cc", number: 20, channel: 3, mode: "delta" });
    expect(adapter.targetSummary("level")).toBe("CC 20 · ch 3 · Δ");
    adapter.addMapping({ target: "level", source: "cc", number: 21, channel: 0 });
    expect(adapter.targetSummary("level")).toBe("CC 20 · ch 3 · Δ +1");
    adapter.dispose();
  });
});

describe("MidiAdapter: диспетчеризация", () => {
  it("absolute CC пишет квантованное значение в реестр", async () => {
    const { adapter, registry, env } = makeHarness("abs");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 20, mode: "absolute" });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0xb0, 20, 127]);
    expect(registry.getNumber("level")).toBe(10);
    input.emit([0xb0, 20, 64]);
    expect(registry.getNumber("level")).toBe(5);
  });

  it("delta: первое сообщение якорит, затем шаг; wrap сворачивает границу", async () => {
    const { adapter, registry, env } = makeHarness("rel");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 21, mode: "delta" });
    const input = env.access!.inputs.get("dev1")!;
    registry.set("level", 5, "api");
    input.emit([0xb0, 21, 10]);
    expect(registry.getNumber("level")).toBe(5); // anchor, без изменения
    input.emit([0xb0, 21, 11]);
    expect(registry.getNumber("level")).toBe(5.5);
    adapter.addMapping({ target: "level", source: "cc", number: 22, mode: "wrap" });
    input.emit([0xb0, 22, 127]);
    input.emit([0xb0, 22, 0]);
    expect(registry.getNumber("level")).toBe(6);
  });

  it("twos/offset/sign бесстатусны", async () => {
    const { adapter, registry, env } = makeHarness("modes");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 23, mode: "twos" });
    adapter.addMapping({ target: "level", source: "cc", number: 24, mode: "sign" });
    const input = env.access!.inputs.get("dev1")!;
    registry.set("level", 5, "api");
    input.emit([0xb0, 23, 1]);
    expect(registry.getNumber("level")).toBe(5.5);
    input.emit([0xb0, 23, 127]);
    expect(registry.getNumber("level")).toBe(5);
    input.emit([0xb0, 24, 65]);
    expect(registry.getNumber("level")).toBe(4.5);
  });

  it("boolean cc пишет напрямую, note агрегирует удержание по каналам", async () => {
    const { adapter, registry, env } = makeHarness("bool");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "on", source: "cc", number: 30 });
    adapter.addMapping({ target: "on", source: "note", number: 40 });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0xb0, 30, 100]);
    expect(registry.getBoolean("on")).toBe(true);
    input.emit([0xb0, 30, 10]);
    expect(registry.getBoolean("on")).toBe(false);
    input.emit([0x90, 40, 100]);
    input.emit([0x90, 40, 120]); // повтор той же ноты не сбрасывает удержание
    input.emit([0x91, 40, 100]);
    expect(registry.getBoolean("on")).toBe(true);
    input.emit([0x80, 40, 64]); // Note Off с ненулевой release velocity
    expect(registry.getBoolean("on")).toBe(true); // ещё удержан на канале 2
    input.emit([0x81, 40, 77]);
    expect(registry.getBoolean("on")).toBe(false);
  });

  it("CC пишет тумблер напрямую, следующий Note пересчитывает удержание", async () => {
    const { adapter, registry, env } = makeHarness("overlap");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "on", source: "cc", number: 30 });
    adapter.addMapping({ target: "on", source: "note", number: 40 });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0x90, 40, 100]);
    expect(registry.getBoolean("on")).toBe(true);
    input.emit([0xb0, 30, 0]);
    expect(registry.getBoolean("on")).toBe(false); // direct CC, note всё ещё удержан
    input.emit([0x90, 40, 100]);
    expect(registry.getBoolean("on")).toBe(true); // пересчёт удержания
  });

  it("CC-действие — edge-триггер; удержание не повторяет, disabled пропускается", async () => {
    const { adapter, actions, env } = makeHarness("action");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "pulse", source: "cc", number: 50 });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0xb0, 50, 100]);
    input.emit([0xb0, 50, 127]);
    input.emit([0xb0, 50, 64]);
    expect(actions.executed).toEqual(["pulse"]);
    input.emit([0xb0, 50, 63]); // ниже порога: готовность к следующему нажатию
    input.emit([0xb0, 50, 100]);
    expect(actions.executed).toEqual(["pulse", "pulse"]);
    actions.available = false;
    input.emit([0xb0, 50, 0]);
    input.emit([0xb0, 50, 100]);
    expect(actions.executed).toEqual(["pulse", "pulse"]);
    expect(adapter.detail).toContain("неактивно");
  });

  it("Note On действия запускает каждый удар, включая повтор без Note Off", async () => {
    const { adapter, actions, env } = makeHarness("note-action-repeat");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "pulse", source: "note", number: 40 });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0x90, 40, 32]);
    input.emit([0x90, 40, 100]); // тот же Note On до Note Off
    input.emit([0x90, 40, 127]);
    expect(actions.executed).toEqual(["pulse", "pulse", "pulse"]);
    const velocities = actions.inputs.map((entry) => midiNoteVelocity(entry.input));
    expect(velocities[0]).toBeCloseTo(32 / 127, 10);
    expect(velocities[1]).toBeCloseTo(100 / 127, 10);
    expect(velocities[2]).toBe(1);
  });

  it("Note Off с release velocity и Note On velocity 0 не запускают действие", async () => {
    const { adapter, actions, env } = makeHarness("note-action-off");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "pulse", source: "note", number: 40 });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0x90, 40, 100]);
    input.emit([0x80, 40, 64]); // release velocity > 0
    input.emit([0x90, 40, 0]); // Note On velocity 0 декодируется как Off
    expect(actions.executed).toEqual(["pulse"]);
    input.emit([0x90, 40, 80]); // следующий валидный удар работает
    expect(actions.executed).toEqual(["pulse", "pulse"]);
    expect(actions.inputs.map((entry) => entry.input?.message.value)).toEqual([100, 80]);
  });

  it("доступность действия проверяется на каждом повторном Note On", async () => {
    const { adapter, actions, env } = makeHarness("note-action-available");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "pulse", source: "note", number: 40 });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0x90, 40, 100]);
    actions.available = false;
    input.emit([0x90, 40, 110]);
    expect(actions.executed).toEqual(["pulse"]);
    expect(adapter.detail).toContain("неактивно");
    actions.available = true;
    input.emit([0x90, 40, 120]);
    expect(actions.executed).toEqual(["pulse", "pulse"]);
    expect(actions.inputs.map((entry) => entry.input?.message.value)).toEqual([100, 120]);
  });

  it("дубли строк действия дают один execute на сообщение, включая повторы Note On", async () => {
    const { adapter, actions, env } = makeHarness("note-action-duplicate");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "pulse", source: "note", number: 40 });
    adapter.addMapping({ target: "pulse", source: "note", number: 40 });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0x90, 40, 100]);
    input.emit([0x90, 40, 110]);
    expect(actions.executed).toEqual(["pulse", "pulse"]);
    expect(actions.inputs.map((entry) => entry.input?.message.value)).toEqual([100, 110]);
  });

  it("повторный Note On независим по каналам и устройствам", async () => {
    const { adapter, actions, env } = makeHarness("note-action-inputs");
    const first = env.addInput("dev1");
    const second = env.addInput("dev2");
    await adapter.connect();
    adapter.selectAllInputs();
    adapter.addMapping({ target: "pulse", source: "note", number: 40, channel: 1 });
    first.emit([0x90, 40, 100]);
    first.emit([0x90, 40, 101]); // повтор на том же устройстве/канале
    second.emit([0x90, 40, 102]); // другое устройство, тот же канал
    first.emit([0x91, 40, 103]); // другой канал не адресует строку
    second.emit([0x91, 40, 104]);
    expect(actions.executed).toEqual(["pulse", "pulse", "pulse"]);
    expect(actions.inputs.map((entry) => entry.input?.message.value)).toEqual([100, 101, 102]);
    expect(actions.inputs.map((entry) => entry.input?.inputId)).toEqual(["dev1", "dev1", "dev2"]);
  });

  it("канал принадлежит назначению: ch 1 игнорирует ch 2, 0 принимает любой", async () => {
    const { adapter, registry, env } = makeHarness("chan");
    env.addInput("dev1");
    await adapter.connect();
    const row = adapter.addMapping({
      target: "level",
      source: "cc",
      number: 60,
      channel: 1,
      mode: "absolute",
    })!;
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0xb1, 60, 127]);
    expect(registry.getNumber("level")).toBe(0);
    input.emit([0xb0, 60, 127]);
    expect(registry.getNumber("level")).toBe(10);

    registry.set("level", 0, "api");
    adapter.updateMapping(row.id, { channel: 0 });
    input.emit([0xb5, 60, 127]);
    expect(registry.getNumber("level")).toBe(10);
  });

  it("одинаковый CC на разных каналах управляет разными параметрами", async () => {
    const { adapter, registry, env } = makeHarness("same-cc-channels");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 60, channel: 1 });
    adapter.addMapping({ target: "locked", source: "cc", number: 60, channel: 2 });
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0xb0, 60, 127]);
    expect(registry.getNumber("level")).toBe(10);
    expect(registry.getNumber("locked")).toBe(0);
    input.emit([0xb1, 60, 64]);
    expect(registry.getNumber("level")).toBe(10);
    expect(registry.getNumber("locked")).toBe(0.5);
  });

  it("недоступный параметр не изменяется и отмечается", async () => {
    const { adapter, registry, env } = makeHarness("disabled");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "locked", source: "cc", number: 70, mode: "absolute" });
    registry.set("enabled", false, "api");
    const input = env.access!.inputs.get("dev1")!;
    input.emit([0xb0, 70, 127]);
    expect(registry.getNumber("locked")).toBe(0);
    expect(adapter.detail).toContain("неактивен");
  });
});

describe("MidiAdapter: независимость и dispose", () => {
  it("два адаптера на одном входе — независимые listeners", async () => {
    const shared = new FakeMidiEnvironment();
    shared.addInput("dev1");
    const a = new MidiAdapter({
      namespace: "a",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: shared,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
    });
    const b = new MidiAdapter({
      namespace: "b",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: shared,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
    });
    await a.connect();
    await b.connect();
    const input = shared.access!.inputs.get("dev1")!;
    expect(input.listenerCount).toBe(2);
    a.dispose();
    expect(input.listenerCount).toBe(1);
    b.dispose();
    expect(input.listenerCount).toBe(0);
  });

  it("dispose идемпотентен, после dispose сообщения не применяются", async () => {
    const { adapter, registry, env } = makeHarness("dispose");
    env.addInput("dev1");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 20, mode: "absolute" });
    const input = env.access!.inputs.get("dev1")!;
    adapter.dispose();
    adapter.dispose();
    expect(input.listenerCount).toBe(0);
    input.emit([0xb0, 20, 127]);
    expect(registry.getNumber("level")).toBe(0);
  });
});

// --- Постоянные регрессии по независимому repro (M1–M12, P1/P2) -------------

describe("MidiAdapter: W-hold release (M1)", () => {
  for (const operation of ["remove", "update", "relearn", "dispose"] as const) {
    it(`снятие удержания при ${operation} не залипает`, async () => {
      const { adapter, registry, env } = makeHarness(`hold-${operation}`);
      const input = env.addInput("device");
      await adapter.connect();
      const row = adapter.addMapping({ target: "on", source: "note", number: 40 })!;
      input.emit([0x90, 40, 100]);
      expect(registry.getBoolean("on")).toBe(true);
      if (operation === "remove") adapter.removeMapping(row.id);
      if (operation === "update") adapter.updateMapping(row.id, { number: 41 });
      if (operation === "relearn") {
        adapter.startLearn("on");
        input.emit([0x90, 41, 100]);
      }
      if (operation === "dispose") adapter.dispose();
      input.emit([0x80, 40, 0]);
      expect(registry.getBoolean("on")).toBe(false);
      adapter.dispose();
    });
  }

  it("смена канала снимает удержание строки до мутации", async () => {
    const { adapter, registry, env } = makeHarness("hold-channel");
    const input = env.addInput("device");
    await adapter.connect();
    const row = adapter.addMapping({ target: "on", source: "note", number: 40, channel: 1 })!;
    input.emit([0x90, 40, 100]);
    expect(registry.getBoolean("on")).toBe(true);

    adapter.updateMapping(row.id, { channel: 2 });
    expect(registry.getBoolean("on")).toBe(false);

    // Note Off со старого канала больше не адресует строку.
    input.emit([0x80, 40, 0]);
    expect(registry.getBoolean("on")).toBe(false);
    adapter.dispose();
  });
});

describe("MidiAdapter: shared access (M2)", () => {
  it("dispose одного адаптера не отключает hotplug другого", async () => {
    const env = new FakeMidiEnvironment();
    const a = new MidiAdapter({
      namespace: "a",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
    });
    const b = new MidiAdapter({
      namespace: "b",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
    });
    env.addInput("dev1");
    await a.connect();
    await b.connect();
    expect(env.access!.listenerCount).toBe(2);
    a.dispose();
    expect(env.access!.listenerCount).toBe(1);
    env.addInput("dev2");
    env.fireStateChange();
    expect(
      b
        .devices()
        .map((d) => d.id)
        .sort(),
    ).toEqual(["dev1", "dev2"]);
    b.dispose();
  });
});

describe("MidiAdapter: id/aggregation after reload (M3)", () => {
  it("восстановленные id уникальны; освобождение 40 не сбрасывает удержание 41", async () => {
    const storage = new MemoryMidiStorage();
    const first = new MidiAdapter({
      namespace: "reload",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
    });
    first.addMapping({ target: "on", source: "note", number: 40 });
    first.dispose();

    const env = new FakeMidiEnvironment();
    const input = env.addInput("device");
    const registry = makeRegistry();
    const restored = new MidiAdapter({
      namespace: "reload",
      params: registry,
      actions: new TestActions(),
      environment: env,
      storage,
      lifetime: { disposed: false },
    });
    expect(restored.mappings().map((m) => m.id)).toEqual(["m1"]);
    restored.addMapping({ target: "on", source: "note", number: 41 });
    expect(new Set(restored.mappings().map((m) => m.id)).size).toBe(2);
    await restored.connect();
    input.emit([0x90, 40, 100]);
    input.emit([0x90, 41, 100]);
    input.emit([0x80, 40, 0]);
    expect(registry.getBoolean("on")).toBe(true);
    input.emit([0x80, 41, 0]);
    expect(registry.getBoolean("on")).toBe(false);
    restored.dispose();
  });

  it("неизвестная цель отбрасывается с предупреждением", () => {
    const storage = new MemoryMidiStorage();
    storage.setItem(
      midiStorageKey("ghost"),
      JSON.stringify({
        version: 2,
        mappings: [
          {
            id: "x",
            target: "ghost",
            source: "cc",
            number: 1,
            channel: 0,
            mode: "absolute",
            sensitivity: 1,
            invert: false,
          },
        ],
      }),
    );
    const errors: unknown[] = [];
    const adapter = new MidiAdapter({
      namespace: "ghost",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
      onError: (e) => errors.push(e),
    });
    expect(adapter.mappings()).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    adapter.dispose();
  });
});

describe("MidiAdapter: draft creation (M4)", () => {
  it("addMapping без цели берёт первую доступную", () => {
    const { adapter } = makeHarness("draft");
    const mapping = adapter.addMapping();
    expect(mapping).not.toBeNull();
    expect(adapter.mappings().length).toBe(1);
    adapter.dispose();
  });
});

describe("MidiAdapter: real access wrapper (M5)", () => {
  it("видит новый порт (live) и независимые listeners", async () => {
    // Нативный access — EventTarget-подобный с addEventListener/removeEventListener.
    const nativeListeners = new Set<() => void>();
    const underlying = {
      inputs: new Map<string, unknown>(),
      outputs: new Map<string, unknown>(),
      addEventListener(type: string, fn: () => void) {
        if (type === "statechange") nativeListeners.add(fn);
      },
      removeEventListener(type: string, fn: () => void) {
        if (type === "statechange") nativeListeners.delete(fn);
      },
      emit() {
        for (const listener of [...nativeListeners]) listener();
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { requestMIDIAccess: async () => underlying },
    });
    try {
      const wrapper = await realMidiEnvironment.requestAccess();
      let notified = 0;
      const unsubscribe = wrapper.addStateChangeListener(() => notified++);
      underlying.inputs.set("hotplug", {
        id: "hotplug",
        name: "Hot",
        state: "connected",
        addEventListener() {},
        removeEventListener() {},
      });
      underlying.emit();
      expect(wrapper.inputs.size).toBe(1);
      const output = { id: "out", name: "Output", state: "connected", send() {} };
      underlying.outputs.set(output.id, output);
      expect(wrapper.outputs?.get("out")).toBe(output);
      underlying.outputs.delete(output.id);
      expect(wrapper.outputs?.size).toBe(0);
      expect(notified).toBe(1);
      unsubscribe();
      underlying.emit();
      expect(notified).toBe(1);
    } finally {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});

describe("MIDI store: строгая версия (M6)", () => {
  it("несовместимая версия не читается; legacy rows игнорируются", () => {
    const storage = new MemoryMidiStorage();
    storage.setItem(
      midiStorageKey("wrong"),
      JSON.stringify({
        version: 999,
        channel: 2,
        mappings: [
          {
            id: "m1",
            target: "on",
            source: "note",
            number: 40,
            channel: 0,
            mode: "absolute",
            sensitivity: 1,
            invert: false,
          },
        ],
      }),
    );
    const loaded = loadMidiState(storage, "wrong", () => "new");
    expect(loaded.mappings).toEqual([]);
    expect(loaded.issues.length).toBeGreaterThan(0);

    storage.setItem(
      midiStorageKey("legacy", 1),
      JSON.stringify({
        channel: 1,
        rows: [{ target: "on", source: "note", number: 40 }],
      }),
    );
    const legacy = loadMidiState(storage, "legacy", () => "new");
    expect(legacy.mappings).toEqual([]);
  });
});

describe("MIDI store: миграция v1 → v2", () => {
  function legacyRow(id: string, target: string, number: number) {
    return { id, target, source: "cc", number, mode: "absolute", sensitivity: 1, invert: false };
  }

  function writeV1(
    storage: MemoryMidiStorage,
    namespace: string,
    channel: unknown,
    mappings: unknown[],
  ): void {
    storage.setItem(
      midiStorageKey(namespace, 1),
      JSON.stringify({ version: 1, channel, mappings }),
    );
  }

  it("глобальный канал 3 копируется во все строки, v2 записывается, v1 остаётся", () => {
    const storage = new MemoryMidiStorage();
    writeV1(storage, "migrate", 3, [legacyRow("m1", "level", 20), legacyRow("m2", "on", 40)]);

    const loaded = loadMidiState(storage, "migrate", () => "new");
    expect(loaded.issues).toEqual([]);
    expect(loaded.mappings.map((mapping) => mapping.channel)).toEqual([3, 3]);

    const raw = storage.getItem(midiStorageKey("migrate"));
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!) as {
      version: number;
      channel?: number;
      mappings: Array<{ channel: number }>;
    };
    expect(saved.version).toBe(2);
    expect(saved.channel).toBeUndefined();
    expect(saved.mappings.map((mapping) => mapping.channel)).toEqual([3, 3]);
    // Legacy-ключ не удаляется: removeItem в интерфейсе нет.
    expect(storage.getItem(midiStorageKey("migrate", 1))).not.toBeNull();
  });

  it("адаптер восстанавливает v1 с глобальным каналом 3 и пишет v2", () => {
    const storage = new MemoryMidiStorage();
    writeV1(storage, "migrate-adapter-ok", 3, [
      legacyRow("m1", "level", 20),
      legacyRow("m2", "on", 40),
    ]);
    const adapter = new MidiAdapter({
      namespace: "migrate-adapter-ok",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
    });
    expect(adapter.mappings().map((mapping) => mapping.channel)).toEqual([3, 3]);

    const saved = JSON.parse(storage.getItem(midiStorageKey("migrate-adapter-ok"))!);
    expect(saved.version).toBe(2);
    expect(saved.channel).toBeUndefined();
    expect(saved.mappings.map((mapping: { channel: number }) => mapping.channel)).toEqual([3, 3]);
    adapter.dispose();
  });

  it("глобальный канал 0 остаётся 0; невалидный канал даёт 0 и issue", () => {
    const storage = new MemoryMidiStorage();
    writeV1(storage, "migrate-zero", 0, [legacyRow("m1", "level", 20)]);
    const zero = loadMidiState(storage, "migrate-zero", () => "new");
    expect(zero.mappings[0]!.channel).toBe(0);
    expect(zero.issues).toEqual([]);

    writeV1(storage, "migrate-invalid", 17, [legacyRow("m1", "level", 20)]);
    const invalid = loadMidiState(storage, "migrate-invalid", () => "new");
    expect(invalid.mappings[0]!.channel).toBe(0);
    expect(invalid.issues.length).toBeGreaterThan(0);
  });

  it("существующий v2 (даже с неизвестной версией) не откатывается к v1", () => {
    const storage = new MemoryMidiStorage();
    writeV1(storage, "no-fallback", 3, [legacyRow("v1-row", "level", 20)]);
    storage.setItem(
      midiStorageKey("no-fallback"),
      JSON.stringify({
        version: 999,
        mappings: [
          {
            id: "v2-row",
            target: "level",
            source: "cc",
            number: 21,
            channel: 4,
            mode: "absolute",
            sensitivity: 1,
            invert: false,
          },
        ],
      }),
    );

    const loaded = loadMidiState(storage, "no-fallback", () => "new");
    expect(loaded.mappings).toEqual([]);
    expect(loaded.issues.length).toBeGreaterThan(0);
  });

  it("v2 строка требует валидный channel 0..16, иначе отбрасывается", () => {
    const storage = new MemoryMidiStorage();
    storage.setItem(
      midiStorageKey("v2-channel"),
      JSON.stringify({
        version: 2,
        mappings: [
          {
            id: "ok",
            target: "level",
            source: "cc",
            number: 20,
            channel: 16,
            mode: "absolute",
            sensitivity: 1,
            invert: false,
          },
          {
            id: "missing",
            target: "on",
            source: "cc",
            number: 30,
            mode: "absolute",
            sensitivity: 1,
            invert: false,
          },
          {
            id: "out-of-range",
            target: "on",
            source: "cc",
            number: 31,
            channel: 17,
            mode: "absolute",
            sensitivity: 1,
            invert: false,
          },
        ],
      }),
    );

    const loaded = loadMidiState(storage, "v2-channel", () => "new");
    expect(loaded.mappings.map((mapping) => mapping.id)).toEqual(["ok"]);
    expect(loaded.mappings[0]!.channel).toBe(16);
    expect(loaded.issues.length).toBe(2);
  });

  it("сбой записи миграции не теряет строки в памяти и старый v1", () => {
    const base = new MemoryMidiStorage();
    writeV1(base, "migrate-fail", 3, [legacyRow("m1", "level", 20)]);
    const v2Key = midiStorageKey("migrate-fail");
    const storage = {
      getItem: (key: string) => base.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === v2Key) throw new Error("quota");
        base.setItem(key, value);
      },
    };

    const loaded = loadMidiState(storage, "migrate-fail", () => "new");
    expect(loaded.mappings.map((mapping) => mapping.channel)).toEqual([3]);
    expect(loaded.issues.some((issue) => issue.includes("миграцию"))).toBe(true);
    expect(base.getItem(v2Key)).toBeNull();
    expect(base.getItem(midiStorageKey("migrate-fail", 1))).not.toBeNull();
  });

  it("адаптер сообщает о сбое записи миграции, но применяет строки в памяти", () => {
    const base = new MemoryMidiStorage();
    writeV1(base, "migrate-adapter", 3, [legacyRow("m1", "level", 20)]);
    const v2Key = midiStorageKey("migrate-adapter");
    const storage = {
      getItem: (key: string) => base.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === v2Key) throw new Error("quota");
        base.setItem(key, value);
      },
    };
    const errors: unknown[] = [];
    const adapter = new MidiAdapter({
      namespace: "migrate-adapter",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
      onError: (error) => errors.push(error),
    });

    expect(adapter.mappings()[0]).toMatchObject({ target: "level", number: 20, channel: 3 });
    expect(errors.length).toBeGreaterThan(0);
    expect(adapter.persistenceWarning).not.toBeNull();
    adapter.dispose();
  });
});

describe("MidiAdapter: storage failures (M7/M8)", () => {
  it("сбой хранилища даёт ошибку и warning, адаптер остаётся рабочим", () => {
    const broken = {
      getItem: () => {
        throw new Error("read denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const errors: unknown[] = [];
    const adapter = new MidiAdapter({
      namespace: "broken",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage: broken,
      lifetime: { disposed: false },
      onError: (e) => errors.push(e),
    });
    const mapping = adapter.addMapping({ target: "on" });
    expect(mapping).not.toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(adapter.persistenceWarning).not.toBeNull();
    adapter.dispose();
  });

  it("бросающий getter localStorage не мешает конструкции", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage access denied");
      },
    });
    try {
      expect(
        () =>
          new MidiAdapter({
            namespace: "nostore",
            params: makeRegistry(),
            actions: new TestActions(),
            environment: new FakeMidiEnvironment(),
            lifetime: { disposed: false },
          }),
      ).not.toThrow();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("MidiAdapter: relative disabled policy (M9) и дубли строк", () => {
  it("disabled relative не даёт скачка при повторном включении", async () => {
    const { adapter, registry, env } = makeHarness("relative-disabled");
    const input = env.addInput("device");
    await adapter.connect();
    // `locked` доступен только при enabled=true (та же семантика, что в repro).
    adapter.addMapping({ target: "locked", source: "cc", number: 20, mode: "delta" });
    registry.set("locked", 0.5, "api");
    input.emit([0xb0, 20, 10]);
    registry.set("enabled", false, "api");
    input.emit([0xb0, 20, 90]);
    registry.set("enabled", true, "api");
    input.emit([0xb0, 20, 91]);
    // История обновлена даже при disabled → +1 шаг (0.1), а не скачок к max.
    expect(registry.getNumber("locked")).toBeCloseTo(0.6, 10);
    adapter.dispose();
  });

  it("две относительные строки на одну цель применяются последовательно", async () => {
    const { adapter, registry, env } = makeHarness("duplicate-rows");
    const input = env.addInput("device");
    await adapter.connect();
    adapter.addMapping({ target: "level", source: "cc", number: 20, mode: "delta" });
    adapter.addMapping({ target: "level", source: "cc", number: 21, mode: "delta" });
    registry.set("level", 5, "api");
    input.emit([0xb0, 20, 10]);
    input.emit([0xb0, 21, 10]);
    input.emit([0xb0, 20, 11]);
    input.emit([0xb0, 21, 12]);
    expect(registry.getNumber("level")).toBe(6.5);
    adapter.dispose();
  });
});

describe("MidiAdapter: onMonitor disposal (M12)", () => {
  it("освобождение из onMonitor останавливает dispatch", async () => {
    const env = new FakeMidiEnvironment();
    const input = env.addInput("device");
    const registry = makeRegistry();
    const adapter: MidiAdapter = new MidiAdapter({
      namespace: "callback",
      params: registry,
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      onMonitor: (message) => {
        if (message) adapter.dispose();
      },
    });
    await adapter.connect();
    adapter.addMapping({ target: "level", number: 20 });
    input.emit([0xb0, 20, 127]);
    expect(adapter.disposed).toBe(true);
    expect(registry.getNumber("level")).toBe(0);
  });
});

// --- Второй проход независимого ревью (R4–R8, P3). --------------------------

// Нативный MIDI access/порт с семантикой EventTarget: `addEventListener` +
// атрибут `onstatechange`. Обёртка не должна затирать onstatechange и не должна
// разделять подписку между экземплярами.
class NativeInputLike {
  state = "connected";
  readonly listeners = new Set<(event: { data: ArrayLike<number> }) => void>();
  constructor(
    readonly id: string,
    readonly name: string | null = id,
  ) {}
  addEventListener(type: string, listener: (event: { data: ArrayLike<number> }) => void): void {
    if (type === "midimessage") this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: (event: { data: ArrayLike<number> }) => void): void {
    if (type === "midimessage") this.listeners.delete(listener);
  }
  emit(data: number[]): void {
    for (const listener of [...this.listeners]) listener({ data });
  }
}
class NativeAccessLike {
  readonly inputs = new Map<string, NativeInputLike>();
  readonly stateListeners = new Set<() => void>();
  #attribute: (() => void) | null = null;
  addEventListener(type: string, fn: () => void): void {
    if (type === "statechange") this.stateListeners.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    if (type === "statechange") this.stateListeners.delete(fn);
  }
  get onstatechange(): (() => void) | null {
    return this.#attribute;
  }
  set onstatechange(fn: (() => void) | null) {
    if (this.#attribute) this.removeEventListener("statechange", this.#attribute);
    this.#attribute = fn;
    if (fn) this.addEventListener("statechange", fn);
  }
  emit(): void {
    for (const listener of [...this.stateListeners]) listener();
  }
}

async function withNative<T>(fn: (access: NativeAccessLike) => Promise<T> | T): Promise<T> {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const access = new NativeAccessLike();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { requestMIDIAccess: async () => access },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { isSecureContext: true },
  });
  try {
    return await fn(access);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
}

function realHarness(namespace: string) {
  const registry = makeRegistry();
  const actions = new TestActions();
  const adapter = new MidiAdapter({
    namespace,
    params: registry,
    actions,
    environment: realMidiEnvironment,
    storage: new MemoryMidiStorage(),
    lifetime: { disposed: false },
  });
  return { adapter, registry, actions };
}

describe("MidiAdapter: нативная изоляция access (R4)", () => {
  it("M-native-shared-access-isolation: две обёртки видят hotplug, dispose A не убирает B", async () => {
    await withNative(async (access) => {
      const first = realHarness("native-first");
      const second = realHarness("native-second");
      await first.adapter.connect();
      await second.adapter.connect();
      const input = new NativeInputLike("hotplug");
      access.inputs.set(input.id, input);
      access.emit();
      expect(first.adapter.inputId).toBe("hotplug");
      expect(second.adapter.inputId).toBe("hotplug");
      second.adapter.dispose();
      expect(access.stateListeners.size).toBe(1);
      first.adapter.dispose();
      expect(access.stateListeners.size).toBe(0);
    });
  });

  it("M-native-existing-handler-preserved: установленный onstatechange не затирается", async () => {
    await withNative(async (access) => {
      let existing = 0;
      const prior = (): void => {
        existing += 1;
      };
      access.onstatechange = prior;
      const wrapper = await realMidiEnvironment.requestAccess();
      let mine = 0;
      const unsubscribe = wrapper.addStateChangeListener(() => {
        mine += 1;
      });
      access.emit();
      expect(existing).toBe(1);
      expect(mine).toBe(1);
      unsubscribe();
      expect(access.onstatechange).toBe(prior);
    });
  });
});

describe("MidiAdapter: enum-цель не адресуема (R5)", () => {
  it("M-restored-enum-target-rejected: enum-строка отбрасывается с предупреждением, не бросает", async () => {
    const registry = new ParameterRegistry<{ choice: string }>({ choice: "a" }, {
      choice: {
        kind: "enum",
        id: "choice",
        label: "Choice",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        read: (state) => state.choice,
        write: (state, value) => {
          state.choice = value;
        },
      },
    } as Record<string, ParameterSpec<{ choice: string }>>);
    const errors: unknown[] = [];
    const storage = new MemoryMidiStorage();
    storage.setItem(
      midiStorageKey("enum"),
      JSON.stringify({
        version: 2,
        mappings: [
          {
            id: "m1",
            target: "choice",
            source: "cc",
            number: 7,
            channel: 0,
            mode: "delta",
            sensitivity: 1,
            invert: false,
          },
        ],
      }),
    );
    const adapter = new MidiAdapter({
      namespace: "enum",
      params: registry,
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
      onError: (error) => errors.push(error),
    });
    expect(adapter.mappings().length).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    adapter.dispose();
  });
});

describe("MidiAdapter: liveness после внешних колбэков (R6)", () => {
  it("M-input-switch-registry-dispose: подписчик реестра при смене входа не оставляет listener", async () => {
    const { adapter, registry, env } = makeHarness("switch-dispose");
    const first = env.addInput("one");
    const second = env.addInput("two");
    await adapter.connect();
    adapter.addMapping({ target: "on", source: "note", number: 40 });
    first.emit([0x90, 40, 100]);
    registry.subscribeParam("on", () => {
      if (!registry.getBoolean("on")) adapter.dispose();
    });
    adapter.selectInput("two");
    expect(adapter.disposed).toBe(true);
    expect(second.listenerCount).toBe(0);
    expect(first.listenerCount).toBe(0);
  });

  it("M-status-callback-dispose-before-request: dispose из onStatus('connecting') не запрашивает access", async () => {
    const env = new FakeMidiEnvironment();
    const adapter: MidiAdapter = new MidiAdapter({
      namespace: "status-dispose",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      onStatus: (status) => {
        if (status.kind === "connecting") adapter.dispose();
      },
    });
    await adapter.connect();
    expect(env.requestCount).toBe(0);
    expect(adapter.disposed).toBe(true);
  });

  it("M-notify-dispose-stops-subscribers: подписчики не вызываются после dispose из onChange", () => {
    let armed = false;
    let callbacks = 0;
    const adapter: MidiAdapter = new MidiAdapter({
      namespace: "notify-dispose",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      onChange: () => {
        if (armed) adapter.dispose();
      },
    });
    adapter.subscribe(() => {
      callbacks += 1;
    });
    armed = true;
    adapter.setTraining(true);
    expect(callbacks).toBe(0);
  });
});

describe("MidiAdapter: recompute удержания при CRUD (R7)", () => {
  it("M-held-CRUD-after-direct-CC-override: remove Note40 при удержанном Note41 пишет true", async () => {
    const { adapter, registry, env } = makeHarness("cc-override");
    const input = env.addInput("device");
    await adapter.connect();
    const note40 = adapter.addMapping({ target: "on", source: "note", number: 40 })!;
    adapter.addMapping({ target: "on", source: "note", number: 41 });
    adapter.addMapping({ target: "on", source: "cc", number: 30 });
    input.emit([0x90, 40, 100]);
    input.emit([0x90, 41, 100]);
    input.emit([0xb0, 30, 0]);
    expect(registry.getBoolean("on")).toBe(false);
    adapter.removeMapping(note40.id);
    expect(registry.getBoolean("on")).toBe(true);
    input.emit([0x80, 41, 0]);
    expect(registry.getBoolean("on")).toBe(false);
    adapter.dispose();
  });
});

describe("MidiAdapter: персистентность без auto-memory (R8)", () => {
  it("M-no-automatic-memory-storage-fallback: недоступный localStorage не подменяется Memory", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const get = MemoryMidiStorage.prototype.getItem;
    const set = MemoryMidiStorage.prototype.setItem;
    let reads = 0;
    let writes = 0;
    MemoryMidiStorage.prototype.getItem = function (key: string) {
      reads += 1;
      return get.call(this, key);
    };
    MemoryMidiStorage.prototype.setItem = function (key: string, value: string) {
      writes += 1;
      return set.call(this, key, value);
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("getter denied");
      },
    });
    try {
      const adapter = new MidiAdapter({
        namespace: "no-fake-fallback",
        params: makeRegistry(),
        actions: new TestActions(),
        environment: new FakeMidiEnvironment(),
        lifetime: { disposed: false },
      });
      adapter.addMapping({ target: "on" });
      expect(adapter.persistenceWarning).toBeTruthy();
      adapter.dispose();
      expect(reads + writes).toBe(0);
    } finally {
      MemoryMidiStorage.prototype.getItem = get;
      MemoryMidiStorage.prototype.setItem = set;
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("P3: persistenceWarning снимается после успешной записи", () => {
    let fail = true;
    const storage = {
      getItem: () => null,
      setItem: () => {
        if (fail) throw new Error("quota");
      },
    };
    const adapter = new MidiAdapter({
      namespace: "warn-clear",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
    });
    const row = adapter.addMapping({ target: "on" })!;
    expect(adapter.persistenceWarning).toBeTruthy();
    fail = false;
    adapter.updateMapping(row.id, { number: 1 });
    expect(adapter.persistenceWarning).toBeNull();
    adapter.dispose();
  });
});

describe("MidiAdapter: строчное обучение по исчезнувшей строке (P3)", () => {
  it("M-missing-row-learn-must-not-create: невалидный mappingId не создаёт строку", async () => {
    const { adapter, env } = makeHarness("missing-row");
    const input = env.addInput("device");
    await adapter.connect();
    adapter.startLearn("on", "removed-row");
    input.emit([0xb0, 17, 99]);
    expect(adapter.mappings().length).toBe(0);
    adapter.dispose();
  });
});

// --- Второй раунд edge-ревью (R9/R10): ревизия выбора и stop после callback --

describe("MidiAdapter: stop продолжения после registry-release (R9)", () => {
  it("M-crud-release-dispose-no-persistence-callback: update/remove не пишут после dispose", async () => {
    for (const op of ["update", "remove"]) {
      let writes = 0;
      const storage = {
        getItem: () => null,
        setItem: () => {
          writes += 1;
        },
      };
      const registry = makeRegistry();
      const env = new FakeMidiEnvironment();
      const adapter = new MidiAdapter({
        namespace: `release-${op}`,
        params: registry,
        actions: new TestActions(),
        environment: env,
        storage,
        lifetime: { disposed: false },
      });
      const input = env.addInput("d");
      await adapter.connect();
      const row = adapter.addMapping({ target: "on", source: "note", number: 40 })!;
      input.emit([0x90, 40, 100]);
      registry.subscribeParam("on", () => {
        if (!registry.getBoolean("on")) adapter.dispose();
      });
      const before = writes;
      if (op === "update") adapter.updateMapping(row.id, { number: 41 });
      else adapter.removeMapping(row.id);
      expect(adapter.disposed).toBe(true);
      expect(input.listenerCount).toBe(0);
      expect(writes).toBe(before);
    }
  });

  it("M-replacement-persistence-not-clobbered: старое продолжение не затирает replacement", async () => {
    const storage = new MemoryMidiStorage();
    const namespace = "replacement-unit";
    const registry = makeRegistry();
    const env = new FakeMidiEnvironment();
    const adapter = new MidiAdapter({
      namespace,
      params: registry,
      actions: new TestActions(),
      environment: env,
      storage,
      lifetime: { disposed: false },
    });
    const input = env.addInput("d");
    await adapter.connect();
    const row = adapter.addMapping({ target: "on", source: "note", number: 40 })!;
    input.emit([0x90, 40, 100]);
    let replacement!: MidiAdapter;
    let newRowId = "";
    registry.subscribeParam("on", () => {
      if (!registry.getBoolean("on") && !replacement) {
        adapter.dispose();
        replacement = new MidiAdapter({
          namespace,
          params: makeRegistry(),
          actions: new TestActions(),
          environment: new FakeMidiEnvironment(),
          storage,
          lifetime: { disposed: false },
        });
        newRowId = replacement.addMapping({ target: "level", number: 99 })!.id;
      }
    });
    adapter.updateMapping(row.id, { number: 41 });
    const persisted = JSON.parse(storage.getItem(midiStorageKey(namespace))!) as {
      mappings: Array<{ id: string }>;
    };
    expect(persisted.mappings.some((mapping) => mapping.id === newRowId)).toBe(true);
    replacement.dispose();
  });
});

describe("MidiAdapter: ревизия выбора входа/канала (R10)", () => {
  it("M-monitor-input-change-does-not-dispatch-old-input: смена входа отменяет старое сообщение", async () => {
    const env = new FakeMidiEnvironment();
    const oldInput = env.addInput("old");
    env.addInput("new");
    const registry = makeRegistry();
    let armed = false;
    const adapter: MidiAdapter = new MidiAdapter({
      namespace: "monitor-input",
      params: registry,
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      onMonitor: (message) => {
        if (message && armed) adapter.selectInput("new");
      },
    });
    await adapter.connect();
    adapter.addMapping({ target: "level", number: 20 });
    armed = true;
    oldInput.emit([0xb0, 20, 127]);
    expect(registry.getNumber("level")).toBe(0);
    adapter.dispose();
  });

  it("M-old-input-message-does-not-learn-new-input: старое сообщение не обучает новый вход", async () => {
    const env = new FakeMidiEnvironment();
    const oldInput = env.addInput("old");
    env.addInput("new");
    const registry = makeRegistry();
    let armed = false;
    const adapter: MidiAdapter = new MidiAdapter({
      namespace: "monitor-learn",
      params: registry,
      actions: new TestActions(),
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      onMonitor: (message) => {
        if (message && armed) {
          armed = false;
          adapter.selectInput("new");
          adapter.startLearn("level");
        }
      },
    });
    await adapter.connect();
    armed = true;
    oldInput.emit([0xb0, 72, 127]);
    expect(adapter.mappings().length).toBe(0);
    expect(adapter.learningTarget).toBe("level");
    adapter.dispose();
  });
});

// --- defaultModes: координатная политика лаборатории (delta для sourceX/Y/Z) ----

describe("MidiAdapter: defaultModes для новых назначений", () => {
  function harnessWithDefaults(namespace = "defaults") {
    const registry = makeRegistry();
    const actions = new TestActions();
    const env = new FakeMidiEnvironment();
    const adapter = new MidiAdapter({
      namespace,
      params: registry,
      actions,
      environment: env,
      storage: new MemoryMidiStorage(),
      lifetime: { disposed: false },
      // reference: midiCoordinates = {sourceX, sourceY, sourceZ} → delta.
      defaultModes: { level: "delta" },
    });
    return { adapter, registry, actions, env };
  }

  it("addMapping без mode: number-цель получает delta, boolean/action — absolute", () => {
    const { adapter } = harnessWithDefaults();
    const coordinate = adapter.addMapping({ target: "level", source: "cc", number: 20 })!;
    expect(coordinate.mode).toBe("delta");
    const bool = adapter.addMapping({ target: "on", source: "cc", number: 30 })!;
    expect(bool.mode).toBe("absolute"); // относительный для boolean не имеет смысла
    const action = adapter.addMapping({ target: "pulse", source: "cc", number: 50 })!;
    expect(action.mode).toBe("absolute");
    adapter.dispose();
  });

  it("явный mode не перезаписывается defaultModes", () => {
    const { adapter } = harnessWithDefaults();
    const row = adapter.addMapping({
      target: "level",
      source: "cc",
      number: 21,
      mode: "absolute",
    })!;
    expect(row.mode).toBe("absolute");
    const wrap = adapter.addMapping({ target: "level", source: "cc", number: 22, mode: "wrap" })!;
    expect(wrap.mode).toBe("wrap");
    adapter.dispose();
  });

  it("inline learn нового назначения применяет delta; режим существующей строки сохраняется", async () => {
    const { adapter, env } = harnessWithDefaults();
    const input = env.addInput("dev");
    await adapter.connect();
    adapter.startLearn("level");
    input.emit([0xb0, 20, 64]);
    expect(adapter.mappings()[0]).toMatchObject({ target: "level", number: 20, mode: "delta" });

    // Повторное обучение обновляет источник/номер, но НЕ перезаписывает mode.
    adapter.updateMapping(adapter.mappings()[0]!.id, { mode: "absolute" });
    adapter.startLearn("level");
    input.emit([0xb0, 25, 64]);
    expect(adapter.mappings()[0]).toMatchObject({ number: 25, mode: "absolute" });
    adapter.dispose();
  });

  it("boolean learn остаётся absolute даже при относительном default", async () => {
    const { adapter, env } = harnessWithDefaults("bool-default");
    const input = env.addInput("dev");
    await adapter.connect();
    adapter.startLearn("on");
    input.emit([0xb0, 30, 64]);
    expect(adapter.mappings()[0]).toMatchObject({ target: "on", mode: "absolute" });
    adapter.dispose();
  });

  it("сохранённый mode не перезаписывается defaultModes при восстановлении", () => {
    const storage = new MemoryMidiStorage();
    storage.setItem(
      midiStorageKey("stored-default"),
      JSON.stringify({
        version: 2,
        mappings: [
          {
            id: "m1",
            target: "level",
            source: "cc",
            number: 7,
            channel: 0,
            mode: "absolute",
            sensitivity: 1,
            invert: false,
          },
        ],
      }),
    );
    const adapter = new MidiAdapter({
      namespace: "stored-default",
      params: makeRegistry(),
      actions: new TestActions(),
      environment: new FakeMidiEnvironment(),
      storage,
      lifetime: { disposed: false },
      defaultModes: { level: "delta" },
    });
    expect(adapter.mappings()[0]).toMatchObject({ mode: "absolute" });
    adapter.dispose();
  });

  it("без опции defaultModes поведение прежнее: absolute", () => {
    const { adapter } = makeHarness("no-defaults");
    const row = adapter.addMapping({ target: "level", source: "cc", number: 20 })!;
    expect(row.mode).toBe("absolute");
    adapter.dispose();
  });
});

// Payload действия из MIDI: исходный frozen-снимок не зависит от мутабельного
// монитора, а helper строго сужает только заявленный MidiActionInput.
import { describe, expect, it } from "vitest";
import { ActionRegistry } from "../../src/core/actions.ts";
import type { ActionSpec } from "../../src/core/actions.ts";
import type { RuntimeContext } from "../../src/core/context.ts";
import { ParameterRegistry } from "../../src/core/registry.ts";
import { MidiAdapter } from "../../src/midi/adapter.ts";
import { midiNoteVelocity } from "../../src/midi/action-input.ts";
import { MemoryMidiStorage } from "../../src/midi/store.ts";
import { FakeMidiEnvironment } from "../../src/midi/testing.ts";
import type { MidiActionInput, MidiInputEvent, MidiMessage } from "../../src/midi/types.ts";

interface TestState {
  hits: number;
}

function makeActions(handler?: (input: MidiActionInput) => void) {
  const state: TestState = { hits: 0 };
  const params = new ParameterRegistry<TestState>(state, {});
  const seen: MidiActionInput[] = [];
  const run: ActionSpec<TestState>["run"] = (ctx) => {
    const input = ctx.input as MidiActionInput;
    seen.push(input);
    state.hits += 1;
    handler?.(input);
  };
  const ctx = {
    state,
    params,
    actions: undefined as unknown as ActionRegistry<TestState>,
    timeline: { start() {}, stop() {}, toggle() {}, isRunning: false },
    root: {} as HTMLElement,
    requestRender() {},
    log() {},
  } as unknown as RuntimeContext<TestState>;
  const actions = new ActionRegistry<TestState>(() => ctx, {
    pulse: { id: "pulse", label: "Pulse", run },
  });
  (ctx as { actions: ActionRegistry<TestState> }).actions = actions;
  return { actions, seen };
}

interface HarnessOptions {
  onMonitor?(message: MidiMessage | null): void;
  onError?(error: unknown): void;
  handler?(input: MidiActionInput): void;
}

function makeHarness(options: HarnessOptions = {}) {
  const env = new FakeMidiEnvironment();
  const input = env.addInput("dev1", "Keys");
  const { actions, seen } = makeActions(options.handler);
  const adapter = new MidiAdapter({
    namespace: "action-input",
    params: new ParameterRegistry<TestState>({ hits: 0 }, {}),
    actions,
    environment: env,
    storage: new MemoryMidiStorage(),
    lifetime: { disposed: false },
    onMonitor: options.onMonitor,
    onError: options.onError,
  });
  return { adapter, input, seen };
}

describe("MidiAdapter → действие: payload invocation", () => {
  it("использует исходный снимок, даже если onMonitor изменил message/lastMessage", async () => {
    const { adapter, input, seen } = makeHarness({
      onMonitor: (message) => {
        if (!message) return;
        message.value = 1;
        message.number = 99;
        message.channel = 16;
        message.source = "cc";
        message.on = false;
      },
    });
    await adapter.connect();
    adapter.addMapping({ target: "pulse", source: "note", number: 60, channel: 2 });

    input.emit([0x91, 60, 100]);

    expect(seen).toHaveLength(1);
    const payload = seen[0]!;
    expect(payload).toMatchObject({
      kind: "midi",
      inputId: "dev1",
      message: { channel: 2, source: "note", number: 60, value: 100, on: true },
    });
    expect(midiNoteVelocity(payload)).toBeCloseTo(100 / 127);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.message)).toBe(true);
    // Мониторинговый объект остаётся мутабельным и отражает действия onMonitor.
    expect(adapter.lastMessage).toMatchObject({
      channel: 16,
      source: "cc",
      number: 99,
      value: 1,
      on: false,
    });
    adapter.dispose();
  });

  it("неудачная мутация snapshot в handler/subscriber не портит следующие вызовы", async () => {
    const errors: unknown[] = [];
    const { adapter, input, seen } = makeHarness({
      onError: (error) => errors.push(error),
      handler: (payload) => {
        try {
          (payload.message as { value: number }).value = 1;
        } catch {
          // frozen snapshot
        }
        try {
          (payload as { inputId: string }).inputId = "evil";
        } catch {
          // frozen payload
        }
      },
    });
    await adapter.connect();
    adapter.addMapping({ target: "pulse", source: "note", number: 60 });
    const received: number[] = [];
    adapter.subscribeInput((event: MidiInputEvent) => {
      if (event.type !== "message") return;
      received.push(event.message.value);
      try {
        (event.message as { value: number }).value = 0;
      } catch {
        // frozen snapshot
      }
    });

    input.emit([0x90, 60, 100]);
    input.emit([0x80, 60, 64]); // Note Off с ненулевой release velocity
    input.emit([0x90, 60, 64]);

    expect(seen.map((payload) => payload.message.value)).toEqual([100, 64]);
    expect(seen.map((payload) => payload.inputId)).toEqual(["dev1", "dev1"]);
    expect(received).toEqual([100, 64, 64]);
    expect(errors).toEqual([]);
    adapter.dispose();
  });
});

describe("midiNoteVelocity", () => {
  const noteOn = { channel: 1, source: "note", number: 60, value: 100, on: true };

  it("нормализует Note On и возвращает undefined для CC/Note Off/не-MIDI", () => {
    expect(midiNoteVelocity({ kind: "midi", inputId: "dev1", message: noteOn })).toBeCloseTo(
      100 / 127,
    );
    expect(
      midiNoteVelocity({
        kind: "midi",
        inputId: "dev1",
        message: { ...noteOn, value: 1 },
      }),
    ).toBeCloseTo(1 / 127);
    expect(
      midiNoteVelocity({
        kind: "midi",
        inputId: "dev1",
        message: { ...noteOn, value: 127 },
      }),
    ).toBe(1);
    expect(
      midiNoteVelocity({
        kind: "midi",
        inputId: "dev1",
        message: { channel: 1, source: "cc", number: 20, value: 127, on: false },
      }),
    ).toBeUndefined();
    expect(
      midiNoteVelocity({
        kind: "midi",
        inputId: "dev1",
        message: { ...noteOn, value: 64, on: false },
      }),
    ).toBeUndefined();
    expect(midiNoteVelocity(undefined)).toBeUndefined();
    expect(midiNoteVelocity(null)).toBeUndefined();
    expect(midiNoteVelocity({})).toBeUndefined();
    expect(midiNoteVelocity("midi")).toBeUndefined();
    expect(midiNoteVelocity({ kind: "other", inputId: "dev1", message: noteOn })).toBeUndefined();
  });

  it("повреждённый заявленный MidiActionInput — явная ошибка labkit", () => {
    const claimed = (message: Record<string, unknown>): Record<string, unknown> => ({
      kind: "midi",
      inputId: "dev1",
      message,
    });
    const malformed: Array<[string, unknown]> = [
      ["inputId не строка", { kind: "midi", inputId: 1, message: noteOn }],
      ["message не объект", { kind: "midi", inputId: "dev1", message: null }],
      ["неизвестный source", claimed({ ...noteOn, source: "pitch" })],
      ["channel вне диапазона", claimed({ ...noteOn, channel: 0 })],
      ["number вне диапазона", claimed({ ...noteOn, number: 128 })],
      ["value вне диапазона", claimed({ ...noteOn, value: -1 })],
      ["on не boolean", claimed({ ...noteOn, on: 1 })],
      ["CC с on=true", claimed({ ...noteOn, source: "cc", on: true })],
      ["Note On с value=0", claimed({ ...noteOn, value: 0 })],
    ];
    for (const [reason, value] of malformed) {
      expect(() => midiNoteVelocity(value), reason).toThrow(/labkit:.*MIDI action input/);
    }
  });
});

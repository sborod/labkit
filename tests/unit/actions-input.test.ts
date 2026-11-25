// Core action invocation input: непрозрачный payload на один вызов, без
// сохранения между вызовами и без клонирования/заморозки в core.
import { describe, expect, it } from "vitest";
import { ActionRegistry } from "../../src/core/actions.ts";
import type { ActionSpec } from "../../src/core/actions.ts";
import type { RuntimeContext } from "../../src/core/context.ts";
import { ParameterRegistry } from "../../src/core/registry.ts";
import type { MidiActionInput } from "../../src/midi/types.ts";

interface State {
  note: string;
}

function makeRegistry(run: ActionSpec<State>["run"]) {
  const state: State = { note: "idle" };
  const params = new ParameterRegistry<State>(state, {});
  const ctx = {
    state,
    params,
    actions: undefined as unknown as ActionRegistry<State>,
    timeline: { start() {}, stop() {}, toggle() {}, isRunning: false },
    root: {} as HTMLElement,
    requestRender() {},
    log() {},
  } as unknown as RuntimeContext<State>;
  const actions = new ActionRegistry<State>(() => ctx, {
    act: { id: "act", label: "Act", run },
  });
  (ctx as { actions: ActionRegistry<State> }).actions = actions;
  return actions;
}

function midiInput(inputId: string, value: number): MidiActionInput {
  return Object.freeze({
    kind: "midi",
    inputId,
    message: Object.freeze({
      channel: 1,
      source: "note",
      number: 60,
      value,
      on: true,
    }),
  });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("ActionRegistry.execute: input invocation", () => {
  it("сохраняет старую форму execute(id, origin) и не переносит input на следующий вызов", async () => {
    const seen: Array<{ origin: string; input: unknown }> = [];
    const actions = makeRegistry((ctx) => {
      seen.push({ origin: ctx.origin, input: ctx.input });
    });
    const payload = midiInput("dev1", 100);

    await actions.execute("act", "ui");
    await actions.execute("act", "midi", payload);
    await actions.execute("act", "preset");

    expect(seen.map((entry) => entry.origin)).toEqual(["ui", "midi", "preset"]);
    expect(seen[0]?.input).toBeUndefined();
    // Core передаёт payload как есть: без клонирования и без своей заморозки.
    expect(seen[1]?.input).toBe(payload);
    expect(seen[2]?.input).toBeUndefined();
  });

  it("перекрывающиеся async-вызовы сохраняют context/input/origin после await", async () => {
    const inputA = midiInput("a", 100);
    const inputB = midiInput("b", 64);
    const observed: Array<{ context: unknown; input: unknown; origin: string }> = [];
    let sequence = 0;
    const gates = [deferred(), deferred()];
    const actions = makeRegistry(async (ctx) => {
      // Номер invocation фиксируем до await; payload/origin читаем только ПОСЛЕ
      // него, чтобы общий перезаписываемый context не мог пройти проверку.
      const order = sequence++;
      await gates[order]!.promise;
      observed[order] = { context: ctx, input: ctx.input, origin: ctx.origin };
    });

    const first = actions.execute("act", "midi", inputA);
    const second = actions.execute("act", "api", inputB);
    // Второй вызов завершается раньше первого: реалистичное перекрытие.
    gates[1]!.release();
    await second;
    expect(observed[1]?.origin).toBe("api");
    expect(observed[1]?.input).toBe(inputB);

    gates[0]!.release();
    await first;

    expect(observed[0]?.origin).toBe("midi");
    expect(observed[0]?.input).toBe(inputA);
    expect((observed[0]?.input as MidiActionInput).message.value).toBe(100);
    expect((observed[1]?.input as MidiActionInput).message.value).toBe(64);
    expect(observed[0]?.context).not.toBe(observed[1]?.context);
  });
});

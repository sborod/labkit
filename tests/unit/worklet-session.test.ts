import { describe, expect, it } from "vitest";
import { WorkletSession, type WorkletStatus } from "../../src/audio/worklet.ts";
import { FakeWorkletEnvironment } from "../../src/audio/worklet-testing.ts";

// Жизненный цикл общей worklet-сессии на управляемой fake-среде: transactional
// graph, resume до await, failpoints (resume/module/node/connect/processorerror),
// retry, dispose во время pending start, идемпотентность и rejection-семантика.

const MODULE = "/tests/fixtures/worklet-module.js";
const PROCESSOR = "labkit-test-processor";

function makeSession(env: FakeWorkletEnvironment, lifetime = { disposed: false }) {
  const statuses: WorkletStatus[] = [];
  const telemetry: Record<string, number>[] = [];
  const errors: unknown[] = [];
  const session = new WorkletSession({
    env,
    lifetime,
    moduleUrl: MODULE,
    processorName: PROCESSOR,
    onStatus: (status) => statuses.push(status),
    onTelemetry: (value) => telemetry.push({ ...(value as Record<string, number>) }),
    onError: (error) => errors.push(error),
  });
  return { session, statuses, telemetry, errors, lifetime };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("WorkletSession: запуск и граф", () => {
  it("публикует граф после готовности; node→analyser→gain→destination; config+params", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, statuses } = makeSession(env);
    session.setParams({ mass: 2 });
    await session.start();
    const ctx = env.contexts[0]!;
    const node = env.nodes[0]!;
    const analyser = ctx.analysers[0]!;
    const gain = ctx.gains[0]!;
    expect(ctx.modules).toEqual([MODULE]);
    expect(node.connected).toEqual([analyser]);
    expect(analyser.connected).toEqual([gain]);
    expect(gain.connected).toEqual([ctx.destination]);
    expect(statuses).toEqual(["starting", "running"]);
    expect(session.running).toBe(true);
    expect(node.posted[0]).toEqual({ type: "config", telemetryHz: 30 });
    expect(node.posted[1]).toEqual({ type: "params", p: { mass: 2 } });
  });

  it("контекст и resume создаются синхронно ДО первого await", async () => {
    const env = new FakeWorkletEnvironment();
    env.manualResume = true;
    const { session } = makeSession(env);
    const pending = session.start();
    expect(env.contexts.length).toBe(1);
    expect(env.pendingResumes).toBe(1);
    env.resolveNextResume();
    await pending;
    expect(session.running).toBe(true);
  });

  it("processorerror виден через onError и меняет статус", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, errors, statuses } = makeSession(env);
    await session.start();
    env.nodes[0]!.emitProcessorError();
    expect(statuses).toContain("error");
    expect(errors.length).toBe(1);
  });

  it("телеметрия принимается; исключение подписчика изолируется", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, telemetry, errors } = makeSession(env);
    await session.start();
    env.nodes[0]!.emitMessage({ type: "state", x1: 0.3, x2: -0.2, base: 50 });
    expect(telemetry[0]).toEqual({ x1: 0.3, x2: -0.2, base: 50 });
    expect(session.telemetry).toEqual({ x1: 0.3, x2: -0.2, base: 50 });
    // сообщение об ошибке от процессора
    env.nodes[0]!.emitMessage({ type: "error", message: "boom" });
    expect(errors.length).toBe(1);
  });
});

describe("WorkletSession: transactional и failpoints", () => {
  it("сбой addModule: граф не публикуется, контекст закрыт, retry успешен", async () => {
    const env = new FakeWorkletEnvironment();
    env.failAddModule = true;
    const { session, statuses } = makeSession(env);
    await expect(session.start()).rejects.toThrow();
    expect(session.running).toBe(false);
    expect(session.hasContext).toBe(false);
    expect(statuses).toContain("error");
    expect(env.contexts[0]!.closeCount).toBe(1);

    env.failAddModule = false;
    await session.start();
    expect(session.running).toBe(true);
    expect(env.contexts.length).toBe(2);
  });

  it("сбой создания узла: откат, контекст закрыт", async () => {
    const env = new FakeWorkletEnvironment();
    env.failCreateNode = true;
    const { session } = makeSession(env);
    await expect(session.start()).rejects.toThrow();
    expect(session.running).toBe(false);
    expect(env.contexts[0]!.closeCount).toBe(1);
  });

  it("сбой connect узла: созданный node откатывается, контекст закрыт", async () => {
    const env = new FakeWorkletEnvironment();
    env.failNodeConnect = true;
    const { session } = makeSession(env);
    await expect(session.start()).rejects.toThrow();
    expect(session.running).toBe(false);
    expect(env.nodes[0]!.disconnected).toBe(true);
    expect(env.contexts[0]!.closeCount).toBe(1);
  });

  it("сбой connect gain: analyser и node откатываются", async () => {
    const env = new FakeWorkletEnvironment();
    env.failGainConnect = true;
    const { session } = makeSession(env);
    await expect(session.start()).rejects.toThrow();
    expect(session.running).toBe(false);
    expect(env.nodes[0]!.disconnected).toBe(true);
    expect(env.contexts[0]!.analysers[0]!.disconnected).toBe(true);
  });

  it("сбой resume: контекст закрыт, retry разрешён", async () => {
    const env = new FakeWorkletEnvironment();
    env.manualResume = true;
    const { session, statuses } = makeSession(env);
    const pending = session.start();
    env.rejectNextResume(new Error("resume boom"));
    await expect(pending).rejects.toThrow("resume boom");
    expect(statuses).toContain("error");
    expect(env.contexts[0]!.closeCount).toBe(1);
    env.manualResume = false;
    await session.start();
    expect(session.running).toBe(true);
  });
});

describe("WorkletSession: dispose", () => {
  it("dispose во время pending start закрывает контекст и не публикует граф", async () => {
    const env = new FakeWorkletEnvironment();
    env.manualResume = true;
    const { session } = makeSession(env);
    const pending = session.start();
    expect(env.contexts.length).toBe(1);
    const disposal = session.dispose();
    env.resolveNextResume();
    await pending;
    await disposal;
    expect(session.running).toBe(false);
    expect(env.contexts[0]!.closeCount).toBe(1);
    expect(env.closedContexts.length).toBe(1);
  });

  it("идемпотентный и reentrant: один cached Promise", async () => {
    const env = new FakeWorkletEnvironment();
    const { session } = makeSession(env);
    await session.start();
    const first = session.dispose();
    const second = session.dispose();
    expect(first).toBe(second);
    await first;
    expect(env.nodes[0]!.disconnected).toBe(true);
    expect(env.contexts[0]!.closeCount).toBe(1);
  });

  it("отклоняется при сбое close, тот же промис; ноды всё равно отсоединены", async () => {
    const env = new FakeWorkletEnvironment();
    const { session } = makeSession(env);
    await session.start();
    env.failClose = true;
    const first = session.dispose();
    const second = session.dispose();
    expect(first).toBe(second);
    await expect(first).rejects.toBeInstanceOf(AggregateError);
    expect(env.nodes[0]!.disconnected).toBe(true);
    expect(env.contexts[0]!.closeCount).toBe(1);
  });

  it("events после dispose не обновляют телеметрию/ошибки", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, telemetry, errors } = makeSession(env);
    await session.start();
    const node = env.nodes[0]!;
    await session.dispose();
    node.emitMessage({ type: "state", x1: 1 });
    node.emitProcessorError();
    expect(telemetry).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("WorkletSession: сообщения и gain", () => {
  it("forwards custom events only from the owned graph and reports callback errors", async () => {
    const env = new FakeWorkletEnvironment();
    const events: unknown[] = [];
    const errors: unknown[] = [];
    const failure = new Error("event callback");
    const session = new WorkletSession({
      env,
      lifetime: { disposed: false },
      moduleUrl: MODULE,
      processorName: PROCESSOR,
      onEvent: (event) => {
        events.push(event);
        if (event === "fail") throw failure;
      },
      onError: (error) => errors.push(error),
    });
    await session.start();
    const old = env.nodes[0]!;
    const oldHandler = old.port.onmessage!;
    old.emitMessage({ type: "state", x: 1 });
    old.emitMessage("fail");
    expect(errors).toEqual([failure]);
    old.emitProcessorError();
    await session.start();
    oldHandler({ data: "stale" });
    const current = env.nodes[1]!;
    const handler = current.port.onmessage!;
    current.emitMessage({ type: "custom" });
    await session.dispose();
    handler({ data: "disposed" });
    expect(events).toEqual(["fail", { type: "custom" }]);
  });
  it("params/reset/command до старта — no-op, после старта — postMessage", async () => {
    const env = new FakeWorkletEnvironment();
    const { session } = makeSession(env);
    session.setParams({ a: 1 });
    session.resetDsp();
    session.sendCommand("x", { y: 1 });
    expect(env.nodes.length).toBe(0);
    await session.start();
    const node = env.nodes[0]!;
    expect(node.posted.some((m) => (m as { type?: string }).type === "params")).toBe(true);
    session.resetDsp();
    session.sendCommand("x", { y: 1 });
    expect(node.posted.some((m) => (m as { type?: string }).type === "reset")).toBe(true);
    expect(node.posted.some((m) => (m as { type?: string }).type === "command")).toBe(true);
  });

  it("mute/master — ramp gain; DSP не останавливается", async () => {
    const env = new FakeWorkletEnvironment();
    const { session } = makeSession(env);
    session.setMaster(0.2);
    session.setMuted(true);
    await session.start();
    session.setMuted(false);
    session.setMaster(0.15);
    const gain = env.contexts[0]!.lastGain!;
    expect(gain.ramps.some((r) => r.target === 0)).toBe(true);
    expect(gain.ramps.some((r) => r.target === 0.2)).toBe(true);
    expect(session.running).toBe(true);
  });
});

describe("WorkletSession: callback reentrancy", () => {
  it("dispose из onStatus('running') не зависает и закрывает контекст", async () => {
    const env = new FakeWorkletEnvironment();
    let disposal: Promise<void> | null = null;
    const session = new WorkletSession({
      env,
      lifetime: { disposed: false },
      moduleUrl: MODULE,
      processorName: PROCESSOR,
      onStatus: (status) => {
        if (status === "running") {
          // Reentrant: освобождение прямо из колбэка смены статуса.
          disposal = session.dispose();
        }
      },
    });
    await session.start();
    expect(disposal).not.toBeNull();
    await disposal;
    expect(session.running).toBe(false);
    expect(env.contexts[0]!.closeCount).toBe(1);
  });

  it("dispose из onTelemetry не ломает обработку и освобождает сессию", async () => {
    const env = new FakeWorkletEnvironment();
    let disposal: Promise<void> | null = null;
    const session = new WorkletSession({
      env,
      lifetime: { disposed: false },
      moduleUrl: MODULE,
      processorName: PROCESSOR,
      onTelemetry: () => {
        disposal = session.dispose();
      },
    });
    await session.start();
    env.nodes[0]!.emitMessage({ type: "state", x1: 1 });
    expect(disposal).not.toBeNull();
    await disposal;
    expect(session.running).toBe(false);
    expect(env.closedContexts.length).toBe(1);
  });

  it("ошибка в onStatus не отменяет публикацию и не бросает наружу", async () => {
    const env = new FakeWorkletEnvironment();
    const session = new WorkletSession({
      env,
      lifetime: { disposed: false },
      moduleUrl: MODULE,
      processorName: PROCESSOR,
      onStatus: () => {
        throw new Error("status callback boom");
      },
    });
    await session.start();
    expect(session.running).toBe(true);
    await session.dispose();
  });
});

describe("WorkletSession: параллельный старт и поздние продолжения", () => {
  it("параллельные start во время pending resume используют один контекст", async () => {
    const env = new FakeWorkletEnvironment();
    env.manualResume = true;
    const { session } = makeSession(env);
    const first = session.start();
    const second = session.start();
    expect(env.contexts.length).toBe(1);
    env.resolveNextResume();
    await Promise.all([first, second]);
    expect(session.running).toBe(true);
    expect(env.contexts.length).toBe(1);
    expect(env.nodes.length).toBe(1);
  });

  it("dispose во время pending addModule: позднее завершение не создаёт узел", async () => {
    const env = new FakeWorkletEnvironment();
    let releaseModule!: () => void;
    env.beforeModuleReady = () => new Promise<void>((resolve) => (releaseModule = resolve));
    const { session } = makeSession(env);
    const start = session.start();
    await flush();
    const disposal = session.dispose();
    releaseModule();
    await Promise.all([start, disposal]);
    expect(env.nodes.length).toBe(0);
    expect(session.running).toBe(false);
    expect(env.contexts[0]!.closed).toBe(true);
  });

  it("позднее отклонение resume после dispose не воскрешает граф/статус", async () => {
    const env = new FakeWorkletEnvironment();
    env.manualResume = true;
    const { session, statuses } = makeSession(env);
    const start = session.start();
    const disposal = session.dispose();
    env.rejectNextResume(new Error("late resume"));
    await Promise.all([start, disposal]);
    expect(session.running).toBe(false);
    expect(session.status).not.toBe("running");
    expect(statuses).not.toContain("running");
  });

  it("позднее отклонение addModule после dispose не публикует граф", async () => {
    const env = new FakeWorkletEnvironment();
    let failModule!: (error: unknown) => void;
    env.beforeModuleReady = () => new Promise<void>((_resolve, reject) => (failModule = reject));
    const { session, statuses } = makeSession(env);
    const start = session.start();
    await flush();
    const disposal = session.dispose();
    failModule(new Error("late module"));
    await Promise.all([start, disposal]);
    expect(session.running).toBe(false);
    expect(statuses).not.toContain("running");
  });
});

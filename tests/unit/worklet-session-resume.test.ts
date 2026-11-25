import { describe, expect, it } from "vitest";
import {
  WorkletSession,
  type WorkletAudioContext,
  type WorkletStatus,
} from "../../src/audio/worklet.ts";
import { FakeWorkletEnvironment } from "../../src/audio/worklet-testing.ts";

// Контракт явного resume существующего контекста: сессия остаётся владельцем
// контекста/графа, нативный resume вызывается синхронно, новых ресурсов и
// addModule нет, каждый явный жест делает собственную native-попытку, а поздние
// исходы после dispose/processorerror/отката не оставляют stale side effects.

const MODULE = "/tests/fixtures/worklet-resume-module.js";
const PROCESSOR = "labkit-resume-processor";

function makeSession(env: FakeWorkletEnvironment, lifetime = { disposed: false }) {
  const statuses: WorkletStatus[] = [];
  const errors: unknown[] = [];
  const session = new WorkletSession({
    env,
    lifetime,
    moduleUrl: MODULE,
    processorName: PROCESSOR,
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
  });
  return { session, statuses, errors, lifetime };
}

/** Fake, который, как браузер, переводит контекст в running после resume. */
class StatefulEnv extends FakeWorkletEnvironment {
  override resumeContext(ctx: WorkletAudioContext): Promise<void> {
    return super.resumeContext(ctx).then(() => {
      (ctx as unknown as { state: string }).state = "running";
    });
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

interface Observed {
  state: "pending" | "fulfilled" | "rejected";
  error: unknown;
}
function observe(promise: Promise<void>): Observed {
  const observed: Observed = { state: "pending", error: null };
  promise.then(
    () => {
      observed.state = "fulfilled";
    },
    (error) => {
      observed.state = "rejected";
      observed.error = error;
    },
  );
  return observed;
}

describe("WorkletSession: contextState без выдачи AudioContext", () => {
  it("none до старта, pending-контекст во время start, running после, none после dispose", async () => {
    const env = new StatefulEnv();
    env.manualResume = true;
    const { session } = makeSession(env);
    expect(session.contextState).toBe("none");

    const start = session.start();
    const ctx = env.contexts[0]!;
    ctx.state = "suspended";
    expect(session.contextState).toBe("suspended");
    env.resolveNextResume();
    await start;
    expect(session.contextState).toBe("running");

    await session.dispose();
    expect(session.contextState).toBe("none");
    // Сессия не отдаёт контекст: публичный результат — только состояние.
    expect("context" in session).toBe(false);
  });

  it("после processorerror контекста больше нет", async () => {
    const env = new FakeWorkletEnvironment();
    const { session } = makeSession(env);
    await session.start();
    expect(session.contextState).toBe("running");
    env.nodes[0]!.emitProcessorError();
    expect(session.contextState).toBe("none");
    await session.dispose();
  });
});

describe("WorkletSession: resume существующего контекста", () => {
  it("возобновляет suspended контекст синхронно и сохраняет граф/params", async () => {
    const env = new StatefulEnv();
    const { session, statuses } = makeSession(env);
    session.setParams({ mass: 2 });
    await session.start();

    const ctx = env.contexts[0]!;
    const node = env.nodes[0]!;
    const analyser = session.analyser;
    const gain = ctx.lastGain!;
    const posted = node.posted.length;
    const statusesBefore = [...statuses];
    session.setMaster(0.35);
    const rampsBefore = gain.ramps.length;

    ctx.state = "suspended";
    env.manualResume = true;
    const pending = session.resumeContext();
    // Нативный resume уже вызван в том же синхронном стеке (до первого await).
    expect(env.pendingResumes).toBe(1);
    env.resolveNextResume();
    await expect(pending).resolves.toBe(true);

    expect(ctx.state).toBe("running");
    expect(session.contextState).toBe("running");
    expect(session.running).toBe(true);
    expect(session.status).toBe("running");
    expect(session.startedCount).toBe(1);
    expect(session.analyser).toBe(analyser);
    expect(session.master).toBe(0.35);
    expect(session.sampleRate).toBe(44100);
    expect(env.contexts).toHaveLength(1);
    expect(env.nodes).toHaveLength(1);
    expect(ctx.modules).toEqual([MODULE]);
    expect(ctx.analysers).toHaveLength(1);
    expect(ctx.gains).toHaveLength(1);
    expect(node.posted.length).toBe(posted);
    expect(gain.ramps.length).toBe(rampsBefore);
    expect(statuses).toEqual(statusesBefore);

    // Существующая семантика start() не изменилась: живой граф — no-op.
    await expect(session.start()).resolves.toBeUndefined();
    expect(env.contexts).toHaveLength(1);

    session.setMaster(0.5);
    expect(gain.ramps[gain.ramps.length - 1]!.target).toBe(0.5);
    await session.dispose();
    expect(ctx.closeCount).toBe(1);
  });

  it("во время start явный жест делает новую native-попытку, не переиспользует resume старта", async () => {
    const env = new StatefulEnv();
    env.manualResume = true;
    const { session } = makeSession(env);
    const start = session.start();
    expect(env.pendingResumes).toBe(1);
    const ctx = env.contexts[0]!;
    ctx.state = "suspended";

    const pending = session.resumeContext();
    // Новый жест обязан вызвать native resume здесь и сейчас: pending start
    // resume мог быть создан без user activation и сам по себе не разблокирует.
    expect(env.pendingResumes).toBe(2);
    env.resolveNextResume();
    env.resolveNextResume();
    const [, current] = await Promise.all([start, pending]);
    expect(current).toBe(true);
    expect(session.running).toBe(true);
    expect(session.contextState).toBe("running");
    expect(env.contexts).toHaveLength(1);
    await session.dispose();
  });

  it("каждый явный вызов — отдельная native-попытка; ни один жест не теряется", async () => {
    const env = new StatefulEnv();
    const { session } = makeSession(env);
    await session.start();
    const ctx = env.contexts[0]!;
    ctx.state = "suspended";
    env.manualResume = true;

    const first = session.resumeContext();
    const second = session.resumeContext();
    expect(second).not.toBe(first);
    expect(env.pendingResumes).toBe(2);
    env.resolveNextResume();
    await expect(first).resolves.toBe(true);
    env.resolveNextResume();
    await expect(second).resolves.toBe(true);
    expect(session.contextState).toBe("running");
    expect(env.contexts).toHaveLength(1);
    expect(ctx.modules).toEqual([MODULE]);
    await session.dispose();
  });

  it("ошибка актуального native resume отклоняет вызов и разрешает повторную попытку", async () => {
    const env = new StatefulEnv();
    const { session, statuses, errors } = makeSession(env);
    await session.start();
    const ctx = env.contexts[0]!;
    ctx.state = "suspended";
    env.manualResume = true;
    const statusesBefore = [...statuses];

    const failed = session.resumeContext();
    env.rejectNextResume(new Error("native resume failed"));
    await expect(failed).rejects.toThrow("native resume failed");
    // Ошибка принадлежит жесту: сессия и её музыкальный статус не меняются.
    expect(session.running).toBe(true);
    expect(session.status).toBe("running");
    expect(statuses).toEqual(statusesBefore);
    expect(errors).toEqual([]);
    expect(env.contexts[0]!.closeCount).toBe(0);

    ctx.state = "suspended";
    const retry = session.resumeContext();
    expect(env.pendingResumes).toBe(1);
    env.resolveNextResume();
    await retry;
    expect(session.contextState).toBe("running");
    expect(env.contexts).toHaveLength(1);
    await session.dispose();
  });

  it("до старта и после processorerror отклоняет вызов, не создавая контекст", async () => {
    const env = new FakeWorkletEnvironment();
    const { session } = makeSession(env);
    await expect(session.resumeContext()).rejects.toThrow("аудиоконтекст ещё не создан");
    expect(env.contexts).toHaveLength(0);

    await session.start();
    env.nodes[0]!.emitProcessorError();
    expect(session.contextState).toBe("none");
    await expect(session.resumeContext()).rejects.toThrow("аудиоконтекст ещё не создан");
    expect(env.contexts).toHaveLength(1);

    await session.dispose();
    await expect(session.resumeContext()).rejects.toThrow("освобождена");
  });
});

describe("WorkletSession: поздние исходы resume", () => {
  it("dispose не ждёт зависший native resume, close один раз, поздний успех без эффектов", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, statuses } = makeSession(env);
    await session.start();
    const ctx = env.contexts[0]!;
    ctx.state = "suspended";
    env.manualResume = true;
    const pending = session.resumeContext();
    expect(env.pendingResumes).toBe(1);
    const statusesBefore = [...statuses];

    const disposal = observe(session.dispose());
    await flush();
    expect(disposal.state).toBe("fulfilled");
    expect(ctx.closeCount).toBe(1);

    env.resolveNextResume();
    // target снят: успех не доказывает, что resume ещё кому-то принадлежит.
    await expect(pending).resolves.toBe(false);
    expect(session.running).toBe(false);
    expect(session.contextState).toBe("none");
    expect(env.contexts).toHaveLength(1);
    expect(env.nodes).toHaveLength(1);
    expect(ctx.closeCount).toBe(1);
    expect(statuses).toEqual(statusesBefore);
  });

  it("позднее отклонение после dispose поглощается", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, errors } = makeSession(env);
    await session.start();
    const ctx = env.contexts[0]!;
    ctx.state = "suspended";
    env.manualResume = true;
    const pending = session.resumeContext();

    await session.dispose();
    env.rejectNextResume(new Error("late native resume failure"));
    await expect(pending).resolves.toBe(false);
    expect(errors).toEqual([]);
    expect(ctx.closeCount).toBe(1);
  });

  it("откат addModule снимает target: поздний resume reject поглощён, исходный start остаётся rejected", async () => {
    const env = new FakeWorkletEnvironment();
    let failModule!: (error: unknown) => void;
    env.beforeModuleReady = () => new Promise<void>((_resolve, reject) => (failModule = reject));
    const { session, errors } = makeSession(env);
    const start = session.start();
    await flush(); // начальный resume завершён, addModule ещё pending
    const ctx = env.contexts[0]!;
    env.manualResume = true;
    const resumeAttempt = session.resumeContext();
    expect(env.pendingResumes).toBe(1);

    failModule(new Error("module boom"));
    await expect(start).rejects.toThrow("module boom");
    expect(session.running).toBe(false);
    expect(session.contextState).toBe("none");
    expect(ctx.closeCount).toBe(1);

    env.rejectNextResume(new Error("late resume after rollback"));
    // Поколение не менялось, но target больше не принадлежит сессии.
    await expect(resumeAttempt).resolves.toBe(false);
    expect(session.running).toBe(false);
    expect(env.contexts).toHaveLength(1);
    expect(ctx.closeCount).toBe(1);
    expect(errors).toEqual([]);
  });

  it("processorerror и новый граф пока resume pending: stale-исход не воскрешает старый контекст", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, errors } = makeSession(env);
    await session.start();
    const firstCtx = env.contexts[0]!;
    firstCtx.state = "suspended";
    env.manualResume = true;
    const pending = session.resumeContext();
    expect(env.pendingResumes).toBe(1);

    env.nodes[0]!.emitProcessorError();
    expect(session.running).toBe(false);
    expect(firstCtx.closeCount).toBe(1);
    const errorsAfterFault = errors.length;

    env.manualResume = false;
    await session.start();
    expect(session.running).toBe(true);
    expect(env.contexts).toHaveLength(2);
    expect(env.nodes).toHaveLength(2);
    const secondCtx = env.contexts[1]!;
    const secondNode = env.nodes[1]!;

    env.rejectNextResume(new Error("late resume from retired graph"));
    await expect(pending).resolves.toBe(false);

    expect(session.running).toBe(true);
    expect(session.status).toBe("running");
    expect(session.contextState).toBe("running");
    expect(session.analyser).toBe(secondCtx.analysers[0]);
    expect(session.startedCount).toBe(2);
    expect(env.contexts).toHaveLength(2);
    expect(env.nodes).toHaveLength(2);
    expect(env.contexts[0]!.closeCount).toBe(1);
    expect(env.nodes[0]!.disconnected).toBe(true);
    expect(secondNode.disconnected).toBe(false);
    expect(errors.length).toBe(errorsAfterFault);

    await session.dispose();
    expect(secondCtx.closeCount).toBe(1);
    expect(env.contexts[0]!.closeCount).toBe(1);
  });
});

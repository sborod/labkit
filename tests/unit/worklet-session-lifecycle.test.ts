import { describe, expect, it, vi } from "vitest";
import { WorkletSession, type WorkletStatus } from "../../src/audio/worklet.ts";
import { FakeWorkletEnvironment } from "../../src/audio/worklet-testing.ts";

// Постоянные регрессии жизненного цикла worklet-сессии: транзакционный откат и
// повторный обычный старт (W1), ретайр графа по processorerror (W2), очистка
// при сбое close (W3) и во время медленного старта (W8), а также освобождение
// только текущего графа/start без ожидания старых отставленных close.

const MODULE = "/ordinary-esm.js";
// Generic name: WorkletSession is lab-agnostic, so lifecycle tests must not
// couple to a specific lab's processor.
const PROCESSOR = "test-processor";

function makeSession(env: FakeWorkletEnvironment, extra: Record<string, unknown> = {}) {
  const statuses: WorkletStatus[] = [];
  const errors: unknown[] = [];
  const session = new WorkletSession({
    env,
    lifetime: { disposed: false },
    moduleUrl: MODULE,
    processorName: PROCESSOR,
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    ...extra,
  });
  return { session, statuses, errors };
}

describe("WorkletSession: W1 transactional startup (failGainRamp)", () => {
  it("сбой gain-ramp откатывает граф; retry создаёт свежий контекст", async () => {
    const env = new FakeWorkletEnvironment();
    env.failGainRamp = true;
    const { session } = makeSession(env);
    await expect(session.start()).rejects.toBeTruthy();
    expect(session.running).toBe(false);
    expect(env.contexts[0]!.closeCount).toBe(1);
    expect(env.contexts[0]!.closed).toBe(true);
    expect(env.nodes[0]!.disconnected).toBe(true);

    env.failGainRamp = false;
    await session.start();
    expect(session.running).toBe(true);
    expect(session.status).toBe("running");
    expect(env.contexts.length).toBe(2);
    await session.dispose();
  });
});

describe("WorkletSession: W2 processorerror ретайрит граф и допускает свежий старт", () => {
  it("мёртвый граф не остаётся running; retry создаёт новый процессор; stale-события игнорируются", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, errors } = makeSession(env);
    await session.start();
    const first = env.nodes[0]!;
    first.emitProcessorError();
    expect(session.running).toBe(false);
    expect(session.status).toBe("error");
    expect(first.disconnected).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);

    await session.start();
    expect(session.running).toBe(true);
    expect(env.contexts.length).toBe(2);
    expect(env.nodes.length).toBe(2);
    // События старого (отцепленного) графа игнорируются.
    first.emitProcessorError();
    expect(session.running).toBe(true);
    await session.dispose();
  });
});

describe("WorkletSession: W3 cleanup failure не превращается в успех", () => {
  it("pending start + dispose + failClose: start fulfilled, dispose rejected, close один раз", async () => {
    const env = new FakeWorkletEnvironment();
    env.manualResume = true;
    env.failClose = true;
    const { session } = makeSession(env);
    const start = session.start();
    const disposal = session.dispose();
    env.resolveNextResume();
    const results = await Promise.allSettled([start, disposal]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    expect(env.contexts[0]!.closeCount).toBe(1);
    expect(env.contexts[0]!.closed).toBe(false);
  });
});

describe("WorkletSession: W8 partial param-patch мержится", () => {
  it("очередь патчей до старта сохраняет все поля", async () => {
    const env = new FakeWorkletEnvironment();
    const { session } = makeSession(env);
    session.setParams({ mass: 2 });
    session.setParams({ rough: 0.6 });
    await session.start();
    const posts = env.nodes[0]!.posted.filter(
      (message) => (message as { type?: string }).type === "params",
    ) as Array<{ p: Record<string, unknown> }>;
    expect(posts[posts.length - 1]!.p).toEqual({ mass: 2, rough: 0.6 });
    await session.dispose();
  });

  it("патчи во время медленного старта не теряются", async () => {
    const env = new FakeWorkletEnvironment();
    env.manualResume = true;
    const { session } = makeSession(env);
    const start = session.start();
    session.setParams({ detune: 4 });
    env.resolveNextResume();
    await start;
    const posts = env.nodes[0]!.posted.filter(
      (message) => (message as { type?: string }).type === "params",
    ) as Array<{ p: Record<string, unknown> }>;
    expect(posts.some((post) => post.p.detune === 4)).toBe(true);
    await session.dispose();
  });
});

describe("WorkletSession: processorerror с async cleanup failure наблюдаем", () => {
  it("сбой close после ретайра уходит в onError", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, errors } = makeSession(env);
    await session.start();
    env.failClose = true;
    env.nodes[0]!.emitProcessorError();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.some((error) => String(error).includes("close"))).toBe(true);
    await session.dispose().catch(() => {});
  });
});

// --- Отставленный processorerror-контекст не является барьером dispose. ---

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

describe("WorkletSession: dispose не ждёт старый отставленный close", () => {
  it("W-retired-context-disposal: dispose без активных ресурсов завершается; поздний сбой close сообщается один раз", async () => {
    const env = new FakeWorkletEnvironment();
    const close = deferred();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = new WorkletSession({
        env,
        lifetime: { disposed: false },
        moduleUrl: MODULE,
        processorName: PROCESSOR,
        onError: () => {},
      });
      await session.start();
      env.closeContext = (ctx) => {
        (ctx as unknown as { closeCount: number }).closeCount += 1;
        return close.promise;
      };
      env.nodes[0]!.emitProcessorError();

      const disposal = observe(session.dispose());
      await flush();
      // Активного графа/start нет: старый pending close не удерживает dispose.
      expect(disposal.state).toBe("fulfilled");

      close.reject(new Error("retired close rejected"));
      await flush();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[1])).toContain("retired close rejected");
      expect(env.contexts[0]!.closeCount).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("dispose ждёт close только текущего графа, а не старого pending close", async () => {
    const env = new FakeWorkletEnvironment();
    const oldClose = deferred();
    const session = new WorkletSession({
      env,
      lifetime: { disposed: false },
      moduleUrl: MODULE,
      processorName: PROCESSOR,
      onError: () => {},
    });
    await session.start();
    const firstCtx = env.contexts[0]!;
    const originalClose = env.closeContext.bind(env);
    env.closeContext = (ctx) => {
      if (ctx === firstCtx) {
        (ctx as unknown as { closeCount: number }).closeCount += 1;
        return oldClose.promise;
      }
      return originalClose(ctx);
    };
    env.nodes[0]!.emitProcessorError(); // старый close остаётся pending

    await session.start(); // свежий активный граф
    const disposal = observe(session.dispose());
    await flush();
    expect(disposal.state).toBe("fulfilled");
    expect(env.contexts[1]!.closeCount).toBe(1);
    expect(env.contexts[0]!.closeCount).toBe(1);
  });

  it("завершённое отклонение старого close сообщается один раз и не отравляет позднейший dispose", async () => {
    const env = new FakeWorkletEnvironment();
    const oldClose = deferred();
    const errors: unknown[] = [];
    const session = new WorkletSession({
      env,
      lifetime: { disposed: false },
      moduleUrl: MODULE,
      processorName: PROCESSOR,
      onError: (error) => errors.push(error),
    });
    await session.start();
    const firstCtx = env.contexts[0]!;
    const originalClose = env.closeContext.bind(env);
    env.closeContext = (ctx) => (ctx === firstCtx ? oldClose.promise : originalClose(ctx));
    env.nodes[0]!.emitProcessorError();
    oldClose.reject(new Error("old close boom"));
    await flush();
    expect(errors.filter((error) => String(error).includes("old close boom")).length).toBe(1);
    const reported = errors.length;

    await session.start(); // свежий граф после завершённого старого сбоя
    const disposal = observe(session.dispose());
    await flush();
    expect(disposal.state).toBe("fulfilled");
    expect(errors.length).toBe(reported);
  });
});

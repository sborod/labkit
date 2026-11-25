import { describe, expect, it, vi } from "vitest";
import {
  WorkletSession,
  type WorkletErrorInfo,
  type WorkletSessionOptions,
} from "../../src/audio/worklet.ts";
import { FakeWorkletEnvironment } from "../../src/audio/worklet-testing.ts";

// Провенанс ошибок: `onError(error, { current })` должен позволять хосту
// отличить сбой текущего поколения от позднего cleanup отставленного графа.
// Один и тот же callback с одним параметром остаётся совместимым.

const MODULE = "/ordinary-esm.js";
const PROCESSOR = "test-processor";

interface Seen {
  error: unknown;
  info: WorkletErrorInfo;
}

function makeSession(env: FakeWorkletEnvironment, extra: Partial<WorkletSessionOptions> = {}) {
  const seen: Seen[] = [];
  const session = new WorkletSession({
    env,
    lifetime: { disposed: false },
    moduleUrl: MODULE,
    processorName: PROCESSOR,
    onError: (error, info) => seen.push({ error, info }),
    ...extra,
  });
  return { session, seen };
}

function deferred(): { promise: Promise<void>; reject: (error: unknown) => void } {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function withDeferredClose(
  env: FakeWorkletEnvironment,
  target: unknown,
): { promise: Promise<void>; reject: (error: unknown) => void } {
  const close = deferred();
  const originalClose = env.closeContext.bind(env);
  env.closeContext = (ctx) => {
    if (ctx === target) {
      (ctx as unknown as { closeCount: number }).closeCount += 1;
      return close.promise;
    }
    return originalClose(ctx);
  };
  return close;
}

describe("WorkletSession: provenance ошибок (WorkletErrorInfo.current)", () => {
  it("поздний close старого графа после retry доставляется один раз с current:false", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, seen } = makeSession(env);
    await session.start();
    const oldClose = withDeferredClose(env, env.contexts[0]);

    env.nodes[0]!.emitProcessorError();
    await session.start(); // свежий граф — новое поколение
    expect(session.running).toBe(true);

    oldClose.reject(new Error("late old close"));
    await flush();

    const matches = seen.filter((entry) => String(entry.error).includes("late old close"));
    expect(matches.length).toBe(1);
    expect(matches[0]!.info.current).toBe(false);
    await session.dispose();
  });

  it("close старого графа без retry остаётся current:true для своего epoch", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, seen } = makeSession(env);
    await session.start();
    const oldClose = withDeferredClose(env, env.contexts[0]);

    env.nodes[0]!.emitProcessorError();
    oldClose.reject(new Error("same-epoch close"));
    await flush();

    const matches = seen.filter((entry) => String(entry.error).includes("same-epoch close"));
    expect(matches.length).toBe(1);
    expect(matches[0]!.info.current).toBe(true);
    await session.dispose();
  });

  it("собственная ошибка нового процессора current:true", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, seen } = makeSession(env);
    await session.start();
    env.nodes[0]!.emitProcessorError();
    await session.start();
    env.nodes[1]!.emitProcessorError();

    const processorErrors = seen.filter((entry) =>
      String(entry.error).includes("fake processor error"),
    );
    expect(processorErrors.length).toBe(2);
    expect(processorErrors[0]!.info.current).toBe(true);
    expect(processorErrors[1]!.info.current).toBe(true);
    await session.dispose();
  });

  it("реентерабельный retry из onStatus не приписывает старый fault новому start", async () => {
    const env = new FakeWorkletEnvironment();
    const errors: Seen[] = [];
    let retry: Promise<void> | null = null;
    let retried = false;
    const session: WorkletSession = new WorkletSession({
      env,
      lifetime: { disposed: false },
      moduleUrl: MODULE,
      processorName: PROCESSOR,
      onStatus: (status) => {
        if (status === "error" && !retried) {
          retried = true;
          retry = session.start();
        }
      },
      onError: (error, info) => errors.push({ error, info }),
    });

    await session.start();
    env.nodes[0]!.emitProcessorError();
    expect(retried).toBe(true);
    await retry;
    expect(session.running).toBe(true);
    expect(env.nodes.length).toBe(2);

    const processorErrors = errors.filter((entry) =>
      String(entry.error).includes("fake processor error"),
    );
    expect(processorErrors.length).toBe(1);
    expect(processorErrors[0]!.info.current).toBe(false);
    await session.dispose();
  });

  it("ошибка telemetry-колбэка текущего графа current:true", async () => {
    const env = new FakeWorkletEnvironment();
    const { session, seen } = makeSession(env, {
      onTelemetry: () => {
        throw new Error("telemetry boom");
      },
    });
    await session.start();
    env.nodes[0]!.emitMessage({ type: "state", rms: 0.5 });

    const match = seen.find((entry) => String(entry.error).includes("telemetry boom"));
    expect(match).toBeDefined();
    expect(match!.info.current).toBe(true);
    await session.dispose();
  });

  it("ошибка onStatus во время state:error current:true", async () => {
    const env = new FakeWorkletEnvironment();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { session, seen } = makeSession(env, {
        onStatus: (status) => {
          if (status === "error") throw new Error("status boom");
        },
      });
      await session.start();
      env.nodes[0]!.emitProcessorError();

      const match = seen.find((entry) => String(entry.error).includes("status boom"));
      expect(match).toBeDefined();
      expect(match!.info.current).toBe(true);
      await session.dispose();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("ошибка onStatus после реентерабельного retry current:false", async () => {
    const env = new FakeWorkletEnvironment();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const errors: Seen[] = [];
      let retry: Promise<void> | null = null;
      let retried = false;
      const session: WorkletSession = new WorkletSession({
        env,
        lifetime: { disposed: false },
        moduleUrl: MODULE,
        processorName: PROCESSOR,
        onStatus: (status) => {
          if (status === "error" && !retried) {
            retried = true;
            retry = session.start();
            throw new Error("status retry boom");
          }
        },
        onError: (error, info) => errors.push({ error, info }),
      });

      await session.start();
      env.nodes[0]!.emitProcessorError();
      expect(retried).toBe(true);
      await retry;

      const match = errors.find((entry) => String(entry.error).includes("status retry boom"));
      expect(match).toBeDefined();
      expect(match!.info.current).toBe(false);
      const main = errors.find((entry) => String(entry.error).includes("fake processor error"));
      expect(main!.info.current).toBe(false);
      await session.dispose();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("ошибка telemetry-колбэка после реентерабельного retry current:false", async () => {
    const env = new FakeWorkletEnvironment();
    const errors: Seen[] = [];
    let retry: Promise<void> | null = null;
    const session: WorkletSession = new WorkletSession({
      env,
      lifetime: { disposed: false },
      moduleUrl: MODULE,
      processorName: PROCESSOR,
      onTelemetry: () => {
        env.nodes[0]!.emitProcessorError();
        retry = session.start();
        throw new Error("telemetry retry boom");
      },
      onError: (error, info) => errors.push({ error, info }),
    });

    await session.start();
    env.nodes[0]!.emitMessage({ type: "state", rms: 0.5 });
    expect(retry).not.toBeNull();
    await retry;

    const match = errors.find((entry) => String(entry.error).includes("telemetry retry boom"));
    expect(match).toBeDefined();
    expect(match!.info.current).toBe(false);
    await session.dispose();
  });
});

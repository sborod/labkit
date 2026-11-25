import { describe, expect, it } from "vitest";
import { PcmPlayer, type PcmStatus } from "../../src/audio/pcm.ts";
import { FakeAudioEnvironment, FakeScheduler } from "../../src/audio/testing.ts";

// Fake-clock unit-тесты политики PCM: громкость, замена буфера с сохранением
// anchor, гонки resume/stop/dispose, естественное окончание, сбои. Реальные
// узлы и маршрутизация проверяются OfflineAudioContext в browser-тестах.

interface Harness {
  env: FakeAudioEnvironment;
  scheduler: FakeScheduler;
  player: PcmPlayer;
  errors: unknown[];
  statuses: PcmStatus[];
}

function harness(onDeferredError?: (error: unknown) => void): Harness {
  const env = new FakeAudioEnvironment();
  const scheduler = new FakeScheduler();
  const errors: unknown[] = [];
  const statuses: PcmStatus[] = [];
  const player = new PcmPlayer({
    env,
    lifetime: { disposed: false },
    scheduler,
    onStatus: (s) => statuses.push(s),
    onDeferredError: (e) => {
      errors.push(e);
      onDeferredError?.(e);
    },
  });
  return { env, scheduler, player, errors, statuses };
}

const LONG = 44100 * 3;

interface MutableSource {
  key(): string;
  render(sampleRate: number): Float32Array;
}

function source(options: {
  keyRef: { current: string };
  length?: number;
  render?: (sampleRate: number) => Float32Array;
  onRender?: () => void;
}): MutableSource {
  const length = options.length ?? LONG;
  return {
    key: () => options.keyRef.current,
    render: (sampleRate) => {
      options.onRender?.();
      return options.render ? options.render(sampleRate) : new Float32Array(length);
    },
  };
}

describe("PcmPlayer: громкость", () => {
  it("volume меняет только gain, не рендерит и не перезапускает", async () => {
    const { env, player } = harness();
    let renders = 0;
    const keyRef = { current: "a" };
    const src = source({ keyRef, onRender: () => renders++ });
    await player.strike(src);
    expect(renders).toBe(1);
    expect(player.startedCount).toBe(1);
    const gain = env.contexts[0]?.gains[0];
    expect(gain?.gain.value).toBe(0);

    player.setVolume(0.42);
    expect(gain?.gain.value).toBe(0.42);
    expect(renders).toBe(1);
    expect(player.startedCount).toBe(1);
    expect(player.playing).toBe(true);
    await player.dispose();
  });
});

describe("PcmPlayer: замена буфера и anchor", () => {
  it("несколько замен сохраняют anchor первоначального удара", async () => {
    const { env, scheduler, player } = harness();
    const ctx = () => env.contexts[0]!;
    const keyRef = { current: "a" };
    await player.strike(source({ keyRef }));
    const anchor = player.anchorTime;
    expect(anchor).toBe(0);

    ctx().advance(0.5);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    expect(player.anchorTime).toBe(anchor);
    expect(player.startedCount).toBe(2);

    ctx().advance(0.3);
    keyRef.current = "c";
    player.update();
    scheduler.runAll();
    expect(player.anchorTime).toBe(anchor);
    expect(player.startedCount).toBe(3);
    expect(player.currentKey).toBe("c");
    await player.dispose();
  });

  it("elapsed вычисляется ПОСЛЕ готовности PCM, прямо перед стартом", async () => {
    const { env, scheduler, player } = harness();
    const keyRef = { current: "a" };
    let advanceDuringRender = false;
    const src = source({
      keyRef,
      onRender: () => {
        if (advanceDuringRender) env.contexts[0]?.advance(0.25);
      },
    });
    await player.strike(src);
    env.contexts[0]?.advance(1);
    advanceDuringRender = true;
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    // render сдвинул часы на 0.25 → elapsed = 1.25 (посчитан после render).
    expect(env.contexts[0]?.lastSource?.startOffset).toBeCloseTo(1.25, 10);
    await player.dispose();
  });

  it("coalesce: несколько изменений физики → один rebuild", async () => {
    const { env, scheduler, player } = harness();
    const keyRef = { current: "a" };
    await player.strike(source({ keyRef }));
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update();
    player.update();
    keyRef.current = "c";
    player.update();
    expect(scheduler.pending).toBe(1);
    scheduler.runAll();
    expect(player.startedCount).toBe(2);
    expect(player.currentKey).toBe("c");
    await player.dispose();
  });

  it("при остановленном звуке изменения физики не оживляют звук", async () => {
    const { scheduler, player } = harness();
    const keyRef = { current: "a" };
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    expect(player.startedCount).toBe(0);
    expect(player.hasContext).toBe(false);
    await player.dispose();
  });
});

describe("PcmPlayer: гонки resume/stop/dispose", () => {
  it("stop при pending resume инвалидирует старт", async () => {
    const { env, player } = harness();
    env.autoResume = false;
    const keyRef = { current: "a" };
    const pending = player.strike(source({ keyRef }));
    expect(player.status).toBe("loading");
    player.stop();
    env.resolveNextResume();
    await pending;
    expect(player.startedCount).toBe(0);
    expect(player.status).toBe("stopped");
    await player.dispose();
  });

  it("dispose при pending resume инвалидирует старт", async () => {
    const { env, player } = harness();
    env.autoResume = false;
    const pending = player.strike(source({ keyRef: { current: "a" } }));
    const disposal = player.dispose();
    env.resolveNextResume();
    await pending;
    await disposal;
    expect(player.startedCount).toBe(0);
  });

  it("повторные удары latest-wins при resume не по порядку", async () => {
    const { env, player } = harness();
    env.autoResume = false;
    const keyRef = { current: "a" };
    const first = player.strike(source({ keyRef }));
    keyRef.current = "b";
    const second = player.strike(source({ keyRef }));
    expect(env.resumes).toHaveLength(2);
    // Разрешаем ВТОРОЙ resume первым.
    env.resumes[1]?.resolve();
    await second;
    await Promise.resolve();
    // Первый resume ещё висит; разрешаем и его — поколение устарело.
    env.resumes[0]?.resolve();
    await first;
    expect(player.startedCount).toBe(1);
    expect(player.currentKey).toBe("b");
    await player.dispose();
  });

  it("геометрия/громкость во время pending resume применяются при старте", async () => {
    const { env, player } = harness();
    env.autoResume = false;
    const keyRef = { current: "a" };
    const pending = player.strike(source({ keyRef }));
    keyRef.current = "b";
    player.setVolume(0.4);
    env.resolveNextResume();
    await pending;
    expect(player.currentKey).toBe("b");
    expect(env.contexts[0]?.gains[0]?.gain.value).toBe(0.4);
    await player.dispose();
  });

  it("старый rebuild не применяется после нового удара", async () => {
    const { env, scheduler, player } = harness();
    const keyRef = { current: "a" };
    await player.strike(source({ keyRef }));
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update(); // запланирован rebuild
    await player.strike(source({ keyRef })); // новый удар отменяет pending
    scheduler.runAll();
    expect(player.startedCount).toBe(2);
    await player.dispose();
  });

  it("устаревший onended не гасит новую source", async () => {
    const { env, scheduler, player, statuses } = harness();
    const keyRef = { current: "a" };
    await player.strike(source({ keyRef }));
    const firstNode = env.contexts[0]?.sources[0];
    const staleEnded = firstNode?.onended;
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    staleEnded?.();
    expect(player.playing).toBe(true);
    expect(statuses.at(-1)).toBe("playing");
    await player.dispose();
  });
});

describe("PcmPlayer: естественное окончание", () => {
  it("rebuild при elapsed >= duration не стартует и завершает звук", async () => {
    const { env, scheduler, player } = harness();
    const keyRef = { current: "a" };
    await player.strike(source({ keyRef, length: 4410 })); // 0.1 с
    env.contexts[0]?.advance(0.1);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    expect(player.startedCount).toBe(1);
    expect(player.playing).toBe(false);
    expect(player.status).toBe("ended");
    await player.dispose();
  });

  it("onended завершает и будущие изменения не оживляют звук", async () => {
    const { env, scheduler, player } = harness();
    const keyRef = { current: "a" };
    await player.strike(source({ keyRef }));
    env.contexts[0]?.advance(0.5);
    env.contexts[0]?.lastSource?.emitEnded();
    expect(player.playing).toBe(false);
    expect(player.status).toBe("ended");

    env.contexts[0]?.advance(0.2);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    expect(player.startedCount).toBe(1);
    await player.dispose();
  });

  it("stop при простое безопасен и идемпотентен, dispose идемпотентен", async () => {
    const { player } = harness();
    expect(() => player.stop()).not.toThrow();
    expect(() => player.stop()).not.toThrow();
    const first = player.dispose();
    const second = player.dispose();
    expect(first).toBe(second);
    await first;
  });
});

describe("PcmPlayer: сбои не скрываются", () => {
  const keyRef = { current: "a" };

  it("ошибка создания контекста отклоняет strike без вечного loading", async () => {
    const { env, player } = harness();
    env.failCreateContext = true;
    await expect(player.strike(source({ keyRef }))).rejects.toThrow(/createContext boom/);
    expect(player.status).toBe("error");
    expect(player.startedCount).toBe(0);
    await player.dispose();
  });

  it("ошибка resume отклоняет strike", async () => {
    const { env, player } = harness();
    env.autoResume = false;
    const pending = player.strike(source({ keyRef }));
    env.rejectNextResume(new Error("resume boom"));
    await expect(pending).rejects.toThrow("resume boom");
    expect(player.startedCount).toBe(0);
    expect(player.status).toBe("error");
    await player.dispose();
  });

  it("ошибка createBuffer отклоняет strike", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failCreateBuffer = true;
    };
    await expect(player.strike(source({ keyRef }))).rejects.toThrow(/createBuffer/);
    expect(player.status).toBe("error");
    await player.dispose();
  });

  it("ошибка createBufferSource отклоняет strike", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failCreateSource = true;
    };
    await expect(player.strike(source({ keyRef }))).rejects.toThrow(/createBufferSource/);
    await player.dispose();
  });

  it("ошибка start отклоняет strike", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failStart = true;
    };
    await expect(player.strike(source({ keyRef }))).rejects.toThrow(/start failure/);
    await player.dispose();
  });

  it("ошибка первой отрисовки PCM отклоняет strike", async () => {
    const { player } = harness();
    await expect(
      player.strike(
        source({
          keyRef,
          render: () => {
            throw new Error("render boom");
          },
        }),
      ),
    ).rejects.toThrow("render boom");
    expect(player.status).toBe("error");
    await player.dispose();
  });

  it("ошибка отложенного rebuild уходит в onDeferredError", async () => {
    const { env, scheduler, player, errors } = harness();
    let renders = 0;
    await player.strike(
      source({
        keyRef,
        render: () => {
          renders++;
          if (renders > 1) throw new Error("rebuild boom");
          return new Float32Array(LONG);
        },
      }),
    );
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    expect(errors.some((e) => e instanceof Error && /rebuild boom/.test(e.message))).toBe(true);
    expect(player.status).toBe("error");
    await player.dispose();
  });

  it("ошибка close отклоняет dispose (успех не имитируется)", async () => {
    const { env, player } = harness();
    env.failClose = true;
    await player.strike(source({ keyRef }));
    await expect(player.dispose()).rejects.toBeInstanceOf(AggregateError);
    await expect(player.dispose()).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("PcmPlayer: два экземпляра независимы", () => {
  it("не влияют друг на друга; контексты раздельные", async () => {
    const a = harness();
    const b = harness();
    const keyA = { current: "a" };
    const keyB = { current: "x" };
    await a.player.strike(source({ keyRef: keyA }));
    await b.player.strike(source({ keyRef: keyB }));
    expect(a.env.contexts).toHaveLength(1);
    expect(b.env.contexts).toHaveLength(1);
    expect(a.env.contexts[0]).not.toBe(b.env.contexts[0]);

    a.player.stop();
    expect(a.player.playing).toBe(false);
    expect(b.player.playing).toBe(true);
    await a.player.dispose();
    await b.player.dispose();
  });
});

describe("PcmPlayer: буфер содержит отрисованный PCM", () => {
  it("copyToChannel получает те же отсчёты", async () => {
    const { env, player } = harness();
    const samples = new Float32Array([0.5, -0.25, 0.125]);
    await player.strike({
      key: () => "k",
      render: () => samples,
    });
    const data = env.contexts[0]?.buffers[0]?.getChannelData();
    expect(data ? Array.from(data) : []).toEqual([0.5, -0.25, 0.125]);
    await player.dispose();
  });
});

describe("PcmPlayer: exception-safe cleanup (P1)", () => {
  const keyRef = { current: "a" };

  it("dispose не бросает синхронно, публикует один промис, агрегирует ошибки и всё равно закрывает контекст", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failSourceDisconnect = true;
    };
    await player.strike(source({ keyRef }));
    const first = player.dispose();
    const second = player.dispose();
    expect(first).toBe(second); // один cached Promise
    // Состояние инвалидировано сразу, до любых бросающих операций.
    expect(player.playing).toBe(false);
    expect(player.hasContext).toBe(false);
    await expect(first).rejects.toBeInstanceOf(AggregateError);
    // close всё равно был предпринят.
    expect(env.closeCount).toBe(1);
    expect(env.contexts[0]?.gains[0]?.disconnected).toBe(true);
  });

  it("reentrant dispose из closeContext получает тот же Promise", async () => {
    const { env, player } = harness();
    await player.strike(source({ keyRef }));
    let reentrant: Promise<void> | null = null;
    env.onClose = () => {
      reentrant = player.dispose();
    };
    const first = player.dispose();
    await first;
    expect(reentrant).toBe(first);
  });

  it("failed stop очищает состояние; последующая геометрия не стартует source", async () => {
    const { env, scheduler, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failSourceDisconnect = true;
    };
    await player.strike(source({ keyRef }));
    expect(player.startedCount).toBe(1);
    expect(() => player.stop()).toThrow(AggregateError);
    expect(player.playing).toBe(false);
    expect(player.status).toBe("stopped");
    // geometry change после failed stop не оживляет звук
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    expect(player.startedCount).toBe(1);
    await player.dispose();
  });

  it("genuine source.stop failure сохраняется; InvalidStateError (уже остановлен) игнорируется", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failSourceStop = true;
    };
    await player.strike(source({ keyRef }));
    let caught: unknown;
    try {
      player.stop();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.some(
        (e) => e instanceof Error && /stop failure/.test(e.message),
      ),
    ).toBe(true);
    await player.dispose();

    // Narrow: уже завершённый источник → InvalidStateError не считается сбоем.
    const ok = harness();
    await ok.player.strike(source({ keyRef }));
    const node = ok.env.contexts[0]?.sources[0];
    if (node) node.stopped = true; // имитируем «уже завершён»
    expect(() => ok.player.stop()).not.toThrow();
    expect(node?.disconnected).toBe(true);
    await ok.player.dispose();
  });
});

describe("PcmPlayer: exception-safe создание узлов (P2)", () => {
  const keyRef = { current: "a" };

  it("сбой gain.value в конструкторе графа откатывает gain", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failGainValue = true;
    };
    await expect(player.strike(source({ keyRef }))).rejects.toThrow(/value set failure/);
    expect(env.contexts[0]?.gains[0]?.disconnected).toBe(true);
    expect(player.status).toBe("error");
    await player.dispose();
  });

  it("сбой gain.connect в конструкторе графа откатывает gain", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failGainConnect = true;
    };
    await expect(player.strike(source({ keyRef }))).rejects.toThrow(/connect failure/);
    expect(env.contexts[0]?.gains[0]?.disconnected).toBe(true);
    await player.dispose();
  });

  it("сбой buffer setter откатывает source (disconnect)", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failBufferSet = true;
    };
    await expect(player.strike(source({ keyRef }))).rejects.toThrow(/buffer set failure/);
    const node = env.contexts[0]?.sources[0];
    expect(node?.disconnected).toBe(true);
    await player.dispose();
  });

  it("сбой start откатывает source: disconnect + onended очищен; dispose успешен", async () => {
    const { env, player } = harness();
    env.configureContext = (ctx) => {
      ctx.failStart = true;
    };
    await expect(player.strike(source({ keyRef }))).rejects.toThrow(/start failure/);
    const node = env.contexts[0]?.sources[0];
    expect(node?.disconnected).toBe(true);
    expect(node?.onended).toBeNull();
    await expect(player.dispose()).resolves.toBeUndefined();
  });
});

describe("PcmPlayer: deferred error reentrancy (P2)", () => {
  it("recovery-удар из onDeferredError не смывается завершением провалившейся сессии", async () => {
    const env = new FakeAudioEnvironment();
    const scheduler = new FakeScheduler();
    const errors: unknown[] = [];
    const keyRef = { current: "a" };
    let recovered = false;
    const player: PcmPlayer = new PcmPlayer({
      env,
      lifetime: { disposed: false },
      scheduler,
      onDeferredError: (error) => {
        errors.push(error);
        if (!recovered) {
          recovered = true;
          void player.strike(source({ keyRef: { current: "recovery" } }));
        }
      },
    });

    let renders = 0;
    await player.strike(
      source({
        keyRef,
        render: () => {
          renders++;
          if (renders > 1) throw new Error("rebuild boom");
          return new Float32Array(LONG);
        },
      }),
    );
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    // Recovery-удар из callback стартует асинхронно — даём микротаскам пройти.
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.some((e) => e instanceof Error && /rebuild boom/.test(e.message))).toBe(true);
    expect(player.playing).toBe(true);
    expect(player.status).toBe("playing");
    expect(player.startedCount).toBe(2);
    await player.dispose();
  });

  it("genuine cleanup failure замены: onDeferredError.stop → нет replacement/active source", async () => {
    const env = new FakeAudioEnvironment();
    const scheduler = new FakeScheduler();
    const deferred: unknown[] = [];
    let stopped = false;
    const player: PcmPlayer = new PcmPlayer({
      env,
      lifetime: { disposed: false },
      scheduler,
      onDeferredError: (error) => {
        deferred.push(error);
        stopped = true;
        player.stop();
      },
    });
    env.configureContext = (ctx) => {
      ctx.failSourceDisconnect = true;
    };
    const keyRef = { current: "a" };
    await player.strike(source({ keyRef }));
    const started = player.startedCount;
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();

    expect(stopped).toBe(true);
    expect(deferred).toHaveLength(1);
    expect(player.playing).toBe(false);
    expect(player.activeSource).toBeNull();
    // Замена НЕ стартовала после настоящего сбоя очистки.
    expect(player.startedCount).toBe(started);
    await player.dispose();
  });

  it("recovery-удар из callback настоящего cleanup failure не смывается завершением старой сессии", async () => {
    const env = new FakeAudioEnvironment();
    const scheduler = new FakeScheduler();
    const deferred: unknown[] = [];
    const keyRef = { current: "a" };
    const recoveryKey = { current: "r" };
    let recovered = false;
    const player: PcmPlayer = new PcmPlayer({
      env,
      lifetime: { disposed: false },
      scheduler,
      onDeferredError: (error) => {
        deferred.push(error);
        if (!recovered) {
          recovered = true;
          // Одноразовый сбой очистки: recovery должен суметь стартовать/заменяться.
          if (env.contexts[0]) env.contexts[0].failSourceDisconnect = false;
          void player.strike(source({ keyRef: recoveryKey }));
        }
      },
    });
    env.configureContext = (ctx) => {
      ctx.failSourceDisconnect = true;
    };
    let renders = 0;
    await player.strike(
      source({
        keyRef,
        render: () => {
          renders++;
          if (renders > 1) throw new Error("rebuild boom");
          return new Float32Array(LONG);
        },
      }),
    );
    expect(player.playing).toBe(true);

    // Провал rebuild: render бросает, очистка старого источника падает disconnect'ом.
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update();
    scheduler.runAll();
    // recovery стартует асинхронно из callback
    await Promise.resolve();
    await Promise.resolve();
    expect(recovered).toBe(true);
    expect(player.playing).toBe(true);
    expect(player.status).toBe("playing");
    expect(deferred).toHaveLength(1);

    const anchorRecovery = player.anchorTime;
    const startedRecovery = player.startedCount;
    // Реальный rebuild recovery-источника работает и не теряется.
    env.contexts[0]?.advance(1.0);
    recoveryKey.current = "r2";
    player.update();
    expect(scheduler.pending).toBe(1);
    scheduler.runAll();
    expect(player.startedCount).toBe(startedRecovery + 1);
    expect(player.currentKey).toBe("r2");
    expect(player.anchorTime).toBe(anchorRecovery);
    expect(player.activeSource).not.toBeNull();
    expect(player.playing).toBe(true);
    await player.dispose();
  });

  it("recovery-удар из callback cleanup failure при естественном окончании не смывается", async () => {
    const env = new FakeAudioEnvironment();
    const scheduler = new FakeScheduler();
    const deferred: unknown[] = [];
    let recovered = false;
    const player: PcmPlayer = new PcmPlayer({
      env,
      lifetime: { disposed: false },
      scheduler,
      onDeferredError: (error) => {
        deferred.push(error);
        if (!recovered) {
          recovered = true;
          if (env.contexts[0]) env.contexts[0].failSourceDisconnect = false;
          void player.strike(source({ keyRef: { current: "n" } }));
        }
      },
    });
    env.configureContext = (ctx) => {
      ctx.failSourceDisconnect = true;
    };
    await player.strike(source({ keyRef: { current: "a" } }));
    env.contexts[0]?.advance(0.5);
    env.contexts[0]?.lastSource?.emitEnded();

    await Promise.resolve();
    await Promise.resolve();
    expect(recovered).toBe(true);
    expect(deferred).toHaveLength(1);
    expect(player.playing).toBe(true);
    expect(player.status).toBe("playing");
    await player.dispose();
  });

  it("бросающий onDeferredError не ломает очистку и не воскрешает состояние", async () => {
    const env = new FakeAudioEnvironment();
    const scheduler = new FakeScheduler();
    const keyRef = { current: "a" };
    const player = new PcmPlayer({
      env,
      lifetime: { disposed: false },
      scheduler,
      onDeferredError: () => {
        throw new Error("callback boom");
      },
    });
    let renders = 0;
    await player.strike(
      source({
        keyRef,
        render: () => {
          renders++;
          if (renders > 1) throw new Error("rebuild boom");
          return new Float32Array(LONG);
        },
      }),
    );
    env.contexts[0]?.advance(0.5);
    keyRef.current = "b";
    player.update();
    expect(() => scheduler.runAll()).not.toThrow();
    expect(player.playing).toBe(false);
    expect(player.status).toBe("error");
    await player.dispose();
  });
});

// Общий PCM-плеер (этап 2). Модель исполнения — precomputed PCM →
// AudioBufferSource, как в эталоне Room Mode. Это обычная production-модель,
// а не fallback: PCM, PeriodicWave и realtime-DSP — разные модели (ADR 001/002).
//
// Ключевые инварианты (эталонная модель Room Mode + ревью этапа 2):
//   * собственный AudioContext создаётся ЛЕНИВО при первом ударе; конструктор и
//     resume вызываются до первого await (autoplay policy реального клика);
//   * gain отдельный: громкость меняется немедленно и не пересчитывает PCM и не
//     перезапускает удар;
//   * новый удар — новый anchor; замена буфера сохраняет anchor ПЕРВОНАЧАЛЬНОГО
//     удара (сохранённая семантика эталона: `rebuild()` не пишет `startTime`);
//   * изменения физики коалесцируются в один latest rebuild; при остановленном
//     звуке изменения физики ничего не делают (только preview — на стороне лабы);
//   * elapsed = currentTime − anchor вычисляется ПОСЛЕ готовности PCM, прямо
//     перед стартом; elapsed >= duration → не стартуем (естественное окончание);
//     никакого clamp duration − .01;
//   * stop/dispose/новый удар немедленно инвалидируют pending resume/rebuild;
//   * onended привязан к конкретной current source; старое окончание не гасит
//     новую source; естественное окончание очищает активное состояние, и
//     последующие изменения не оживляют звук;
//   * ошибки очистки не скрываются и не глотаются: очистка exception-safe,
//     отдельные шаги независимы, ошибки агрегируются; dispose идемпотентен,
//     никогда не бросает синхронно и отклоняется при реальном сбое.
//
// Порядок уведомлений (важно для external callbacks):
//   * PcmGraph НЕ владеет host-callback'ами: он завершает переход ресурса и
//     возвращает/бросает собранные ошибки. Граф не уведомляет хост посреди
//     незавершённой мутации (то же поведение в офлайне).
//   * PcmPlayer сначала полностью завершает логическое состояние (teardown +
//     status), затем доставляет ошибки хосту (onDeferredError). После внешнего
//     callback прежняя операция не продолжается и старое состояние не
//     записывается: каждая точка продолжения проверяет generation + lifetime.
//   * При genuine cleanup failure удар/замена завершаются явной ошибкой, а не
//     продолжают играть.

export type PcmStatus = "idle" | "loading" | "playing" | "stopped" | "ended" | "error";

/**
 * Минимальная поверхность аудиоконтекста, нужная PCM-плееру. `AudioContext` и
 * `OfflineAudioContext` структурно ей удовлетворяют (offline используется как
 * инструмент численной проверки графа, а не как production-путь).
 */
export interface PcmAudioContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  createGain(): GainNode;
  readonly destination: AudioDestinationNode;
}

/** Источник PCM, предоставляемый лабораторией. volume в ключ НЕ входит. */
export interface PcmSource {
  /** Ключ, определяющий необходимость перестройки буфера (без громкости). */
  key(): string;
  /** Отрисовать mono PCM на данной частоте дискретизации. */
  render(sampleRate: number): Float32Array;
}

/** Среда аудио: где и как создаётся/закрывается собственный контекст. */
export interface PcmEnvironment {
  createContext(): PcmAudioContext;
  /** Возобновление контекста (вызывается синхронно, await — после). */
  resumeContext?(ctx: PcmAudioContext): Promise<void>;
  /** Закрытие собственного контекста при dispose. Ошибка НЕ скрывается. */
  closeContext?(ctx: PcmAudioContext): Promise<void>;
}

export interface PcmScheduler {
  schedule(handler: () => void): number;
  cancel(handle: number): void;
}

const defaultScheduler: PcmScheduler = {
  schedule: (handler) => requestAnimationFrame(() => handler()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Узкая намеренная классификация: `stop()` у незапущенного/уже завершённого
 * источника бросает только `InvalidStateError` — это штатная ситуация. Любая
 * другая ошибка stop() — настоящий сбой и сохраняется.
 */
function isInvalidStateError(error: unknown): boolean {
  return (
    typeof DOMException === "function" &&
    error instanceof DOMException &&
    error.name === "InvalidStateError"
  );
}

function flattenAggregate(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}

/** Ошибка с сохранением исходной причины и независимых ошибок отката. */
function throwWithRollback(
  original: unknown,
  rollback: readonly unknown[],
  message: string,
): never {
  if (rollback.length === 0) {
    throw original;
  }
  throw new AggregateError([original, ...rollback], message, { cause: original });
}

/** Создать AudioBuffer из mono PCM. Общая точка для плеера и офлайн-тестов. */
export function createPcmBuffer(ctx: PcmAudioContext, samples: Float32Array): AudioBuffer {
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}

/**
 * Граф source → gain → destination. Единственная реализация, общая для
 * production-плеера и офлайн-проверки графа (не копия в тесте).
 *
 * Граф не владеет host-callback'ами: он завершает ресурсный переход и
 * возвращает/бросает собранные ошибки. Создание узлов exception-safe: при сбое
 * создания/соединения/старта все уже созданные узлы откатываются; ошибки отката
 * сохраняются вместе с исходной. Genuine cleanup failure при замене НЕ
 * продолжается новым источником — операция завершается ошибкой.
 */
export class PcmGraph {
  readonly #ctx: PcmAudioContext;
  readonly #gain: GainNode;
  #source: AudioBufferSourceNode | null = null;
  #disposed = false;

  constructor(ctx: PcmAudioContext, destination?: AudioDestinationNode) {
    this.#ctx = ctx;
    const gain = ctx.createGain();
    try {
      gain.gain.value = 0;
      gain.connect(destination ?? ctx.destination);
    } catch (error) {
      const rollback: unknown[] = [];
      try {
        gain.disconnect();
      } catch (rollbackError) {
        rollback.push(rollbackError);
      }
      throwWithRollback(error, rollback, "labkit: не удалось создать PCM-граф");
    }
    this.#gain = gain;
  }

  get gain(): GainNode {
    return this.#gain;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  currentSource(): AudioBufferSourceNode | null {
    return this.#source;
  }

  setVolume(value: number): void {
    this.#gain.gain.value = value;
  }

  /**
   * Заменить текущую source новой, стартуя с offset. Сначала завершается
   * предыдущий ресурс: если его очистка дала настоящие ошибки, замена НЕ
   * продолжается (без host-notification посреди перехода) — ошибки бросаются.
   * Сбой создания нового источника — полный откат + throw.
   */
  play(buffer: AudioBuffer, offset: number, onEnded: () => void): AudioBufferSourceNode {
    if (this.#disposed) {
      throw new Error("labkit: PCM-граф освобождён");
    }
    const priorErrors = this.#detachCurrentSource();
    if (priorErrors.length > 0) {
      throw new AggregateError(priorErrors, "labkit: не удалось очистить предыдущий PCM-источник");
    }

    let source: AudioBufferSourceNode | null = null;
    try {
      source = this.#ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.#gain);
      source.onended = onEnded;
      source.start(0, Math.max(0, offset));
    } catch (error) {
      const rollback: unknown[] = [];
      if (source) {
        try {
          source.onended = null;
        } catch (rollbackError) {
          rollback.push(rollbackError);
        }
        try {
          source.disconnect();
        } catch (rollbackError) {
          rollback.push(rollbackError);
        }
        // start() провалился → источник не запущен, stop() не требуется.
      }
      throwWithRollback(error, rollback, "labkit: не удалось запустить PCM-источник");
    }
    this.#source = source;
    return source;
  }

  /** Best-effort stop текущего источника; настоящие ошибки агрегируются. */
  stop(): void {
    const errors = this.#detachCurrentSource();
    if (errors.length > 0) {
      throw new AggregateError(errors, "labkit: ошибка остановки PCM-источника");
    }
  }

  /**
   * Освободить граф: логическое состояние — сразу, затем независимые попытки
   * остановить source и отключить gain. Ошибки агрегируются и пробрасываются.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors = this.#detachCurrentSource();
    try {
      this.#gain.disconnect();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "labkit: ошибки при освобождении PCM-графа");
    }
  }

  #detachCurrentSource(): unknown[] {
    const source = this.#source;
    this.#source = null;
    if (!source) return [];
    const errors: unknown[] = [];
    try {
      source.onended = null;
    } catch (error) {
      errors.push(error);
    }
    try {
      source.stop();
    } catch (error) {
      if (!isInvalidStateError(error)) {
        errors.push(error);
      }
    }
    try {
      source.disconnect();
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }
}

export interface PcmPlayerOptions {
  env: PcmEnvironment;
  /** Живая проверка состояния владельца (Scope экземпляра). */
  lifetime: { readonly disposed: boolean };
  scheduler?: PcmScheduler;
  onStatus?(status: PcmStatus): void;
  /** Канал ошибок для ОТЛОЖЕННЫХ операций (rebuild/окончание). */
  onDeferredError?(error: unknown): void;
}

/**
 * Плеер с политикой замены буфера. Один активный source; собственный контекст
 * на экземпляр; anchor сохраняется при заменах.
 */
export class PcmPlayer {
  readonly #env: PcmEnvironment;
  readonly #lifetime: { readonly disposed: boolean };
  readonly #scheduler: PcmScheduler;
  readonly #onStatus: (status: PcmStatus) => void;
  readonly #onDeferredError: (error: unknown) => void;

  #status: PcmStatus = "idle";
  #ctx: PcmAudioContext | null = null;
  #graph: PcmGraph | null = null;
  #source: PcmSource | null = null;
  #anchor: number | null = null;
  #key: string | null = null;
  #volume = 0;
  #generation = 0;
  #pendingHandle: number | null = null;
  #playing = false;
  #disposed = false;
  #disposal: Promise<void> | null = null;
  #startedCount = 0;

  constructor(options: PcmPlayerOptions) {
    this.#env = options.env;
    this.#lifetime = options.lifetime;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#onStatus = options.onStatus ?? (() => {});
    this.#onDeferredError = options.onDeferredError ?? (() => {});
  }

  get status(): PcmStatus {
    return this.#status;
  }

  get playing(): boolean {
    return this.#playing;
  }

  get volume(): number {
    return this.#volume;
  }

  get currentKey(): string | null {
    return this.#key;
  }

  /** Anchor первоначального удара (наблюдение; при замене не сдвигается). */
  get anchorTime(): number | null {
    return this.#anchor;
  }

  /** Текущая подключённая source (наблюдение; null после замены/окончания). */
  get activeSource(): AudioBufferSourceNode | null {
    return this.#graph?.currentSource() ?? null;
  }

  /** Число фактически стартовавших source — тестовое/стендовое наблюдение. */
  get startedCount(): number {
    return this.#startedCount;
  }

  /** Контекст создан? (наблюдение; сам контекст не публикуется). */
  get hasContext(): boolean {
    return this.#ctx !== null;
  }

  #closed(): boolean {
    return this.#disposed || this.#lifetime.disposed;
  }

  /** Устарела ли операция (закрыт владелец или сменилось поколение). */
  #stale(generation: number): boolean {
    return this.#closed() || generation !== this.#generation;
  }

  /** Громкость: немедленно меняет gain, без пересчёта PCM и рестарта. */
  setVolume(value: number): void {
    this.#volume = value;
    this.#graph?.setVolume(value);
  }

  /**
   * Новый удар. Сначала полностью завершается предыдущее ресурсное состояние
   * (без host-notification); genuine cleanup failure завершает удар явной
   * ошибкой. Затем создаётся контекст, resume — до первого await. После любого
   * внешнего callback операция проверяет generation + lifetime, прежде чем
   * продолжить.
   */
  async strike(source: PcmSource): Promise<void> {
    if (this.#closed()) {
      throw new Error("labkit: PCM-плеер освобождён");
    }
    const generation = ++this.#generation;
    const cleanupErrors = this.#teardownActive();
    if (cleanupErrors.length > 0) {
      // Не продолжаем удар после настоящего сбоя очистки.
      this.#setStatus("error");
      throw new AggregateError(
        cleanupErrors,
        "labkit: не удалось очистить предыдущий PCM-источник",
      );
    }
    this.#source = source;
    this.#setStatus("loading");
    if (this.#stale(generation)) {
      return;
    }

    try {
      // ВАЖНО: создание контекста и resume — синхронно, до первого await
      // (autoplay policy реального жеста).
      const ctx = this.#ensureContext();
      const resume = this.#env.resumeContext ? this.#env.resumeContext(ctx) : Promise.resolve();
      await resume;
      if (this.#stale(generation)) {
        return;
      }
      this.#startSource(source, ctx, 0, generation);
    } catch (error) {
      // Устаревшая (заменённая новым ударом) или освобождённая цепочка не должна
      // проникать в текущий UI (banner/services.onError).
      if (this.#stale(generation)) {
        return;
      }
      const errors = [error, ...this.#failActive()];
      throw errors.length === 1 ? error : new AggregateError(errors, "labkit: ошибка удара PCM");
    }
  }

  /** Изменение физики: только при активном звуке и только latest rebuild. */
  update(): void {
    if (this.#closed() || !this.#playing || !this.#source || !this.#ctx) {
      return;
    }
    if (this.#source.key() === this.#key) {
      return;
    }
    if (this.#pendingHandle !== null) {
      return;
    }
    const generation = this.#generation;
    try {
      this.#pendingHandle = this.#scheduler.schedule(() => {
        this.#pendingHandle = null;
        if (this.#stale(generation) || !this.#playing) {
          return; // устаревшая задача (stop/dispose/новый удар/natural end)
        }
        this.#rebuild(generation);
      });
    } catch (error) {
      this.#pendingHandle = null;
      this.#notifyDeferred(error);
    }
  }

  /**
   * Остановка: логическое состояние инвалидируется ДО очистки; независимые шаги
   * очистки выполняются всегда. Настоящие ошибки агрегируются и пробрасываются
   * (не глотаются), но состояние уже не живёт. Host-callback здесь не
   * вызывается — ошибку доставляет вызывающий после завершения перехода.
   */
  stop(): void {
    if (this.#disposed) {
      return;
    }
    this.#generation++;
    const errors = this.#teardownActive();
    this.#setStatus("stopped");
    if (errors.length > 0) {
      throw new AggregateError(errors, "labkit: ошибки при остановке PCM-плеера");
    }
  }

  /**
   * Идемпотентный и awaitable dispose. Промис публикуется ДО любых внешних
   * вызовов (reentrant/repeated получают тот же промис), никогда не бросает
   * синхронно; все шаги очистки выполняются независимо, а ошибки отклоняют
   * промис после того, как закрытие контекста всё равно было предпринято.
   */
  dispose(): Promise<void> {
    if (this.#disposal) {
      return this.#disposal;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const gate = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Подавляем unhandled-шум; отклонение доступно вызывающему.
    gate.catch(() => {});
    this.#disposal = gate;

    // Синхронная инвалидация логического состояния ДО внешних вызовов.
    this.#disposed = true;
    this.#generation++;
    const errors = this.#teardownActive();
    const graph = this.#graph;
    this.#graph = null;
    const ctx = this.#ctx;
    this.#ctx = null;

    const finish = (): void => {
      if (errors.length > 0) {
        reject(new AggregateError(errors, "labkit: ошибки при освобождении PCM-плеера"));
      } else {
        resolve();
      }
    };

    if (graph) {
      try {
        graph.dispose();
      } catch (error) {
        errors.push(...flattenAggregate(error));
      }
    }
    if (ctx && this.#env.closeContext) {
      let closePromise: Promise<void>;
      try {
        closePromise = this.#env.closeContext(ctx);
      } catch (error) {
        errors.push(error);
        finish();
        return gate;
      }
      closePromise.then(finish, (error) => {
        errors.push(...flattenAggregate(error));
        finish();
      });
      return gate;
    }
    finish();
    return gate;
  }

  #ensureContext(): PcmAudioContext {
    if (!this.#ctx) {
      this.#ctx = this.#env.createContext();
    }
    return this.#ctx;
  }

  #ensureGraph(ctx: PcmAudioContext): PcmGraph {
    if (!this.#graph) {
      this.#graph = new PcmGraph(ctx);
    }
    return this.#graph;
  }

  /** Отрисовка + старт. elapsed вычисляется после render, перед start. */
  #startSource(source: PcmSource, ctx: PcmAudioContext, elapsed: number, generation: number): void {
    const samples = source.render(ctx.sampleRate);
    const buffer = createPcmBuffer(ctx, samples);
    const duration = buffer.duration;
    if (!(duration > 0)) {
      throw new Error("labkit: PCM-буфер пуст");
    }
    const graph = this.#ensureGraph(ctx);
    graph.setVolume(this.#volume);
    if (this.#stale(generation)) {
      return;
    }
    // Anchor фиксируется ровно перед стартом (для первого удара elapsed = 0).
    if (elapsed <= 0) {
      this.#anchor = ctx.currentTime;
      elapsed = 0;
    }
    this.#key = source.key();
    const node = graph.play(buffer, elapsed, () => this.#handleEnded(node));
    void node;
    this.#playing = true;
    this.#startedCount++;
    // setStatus — единственный host-callback здесь; он идёт последним, после
    // завершения всех записей состояния.
    this.#setStatus("playing");
  }

  #rebuild(generation: number): void {
    const ctx = this.#ctx;
    const source = this.#source;
    const graph = this.#graph;
    if (!ctx || !source || !graph || this.#anchor === null) {
      return;
    }
    try {
      const key = source.key();
      if (key === this.#key) {
        return;
      }
      const samples = source.render(ctx.sampleRate);
      const buffer = createPcmBuffer(ctx, samples);
      const duration = buffer.duration;
      const elapsed = Math.max(0, ctx.currentTime - this.#anchor);
      if (!(duration > 0) || elapsed >= duration) {
        // Естественное окончание уже достигнуто (даже если onended не доставлен).
        this.#notifyDeferredFrom(
          this.#finishNatural(),
          "labkit: ошибка очистки источника при окончании",
        );
        return;
      }
      if (this.#stale(generation) || !this.#playing) {
        return;
      }
      this.#key = key;
      const node = graph.play(buffer, elapsed, () => this.#handleEnded(node));
      void node;
      this.#startedCount++;
    } catch (error) {
      // Сначала полностью завершаем УЖЕ ПРОВАЛИВШУЮСЯ сессию (сбор ошибок
      // очистки), затем единожды уведомляем хост: callback может запустить
      // recovery-удар, и после него никаких старых записей не делается.
      const cleanupErrors = this.#failActive();
      this.#notifyDeferredFrom([error, ...cleanupErrors], "labkit: ошибка rebuild PCM");
    }
  }

  #handleEnded(node: AudioBufferSourceNode): void {
    if (this.#closed()) {
      return;
    }
    // Старое окончание не должно гасить новую source.
    if (this.#graph?.currentSource() !== node || !this.#playing) {
      return;
    }
    this.#notifyDeferredFrom(
      this.#finishNatural(),
      "labkit: ошибка очистки источника при окончании",
    );
  }

  /**
   * Полный teardown активного состояния без host-notification: отмена pending,
   * независимая остановка источника, инвалидация логического состояния.
   * Возвращает собранные ошибки очистки.
   */
  #teardownActive(): unknown[] {
    const errors = this.#cancelPending();
    errors.push(...this.#stopActiveSource());
    this.#invalidateActive();
    return errors;
  }

  /** Естественное окончание: состояние завершается, затем статус. */
  #finishNatural(): unknown[] {
    this.#generation++;
    const errors = this.#teardownActive();
    this.#setStatus("ended");
    return errors;
  }

  /** Провал активной операции: состояние завершается, затем статус error. */
  #failActive(): unknown[] {
    this.#generation++;
    const errors = this.#teardownActive();
    this.#setStatus("error");
    return errors;
  }

  #invalidateActive(): void {
    this.#playing = false;
    this.#anchor = null;
    this.#key = null;
    this.#source = null;
  }

  /** Best-effort stop текущего графа; ошибки возвращаются, не бросаются. */
  #stopActiveSource(): unknown[] {
    const graph = this.#graph;
    if (!graph) return [];
    try {
      graph.stop();
      return [];
    } catch (error) {
      return flattenAggregate(error);
    }
  }

  #cancelPending(): unknown[] {
    if (this.#pendingHandle === null) {
      return [];
    }
    const handle = this.#pendingHandle;
    this.#pendingHandle = null;
    try {
      this.#scheduler.cancel(handle);
      return [];
    } catch (error) {
      return [error];
    }
  }

  /** Доставить собранные ошибки после завершённого перехода (одним сообщением). */
  #notifyDeferredFrom(errors: readonly unknown[], message: string): void {
    if (errors.length === 0) return;
    const error = errors.length === 1 ? errors[0] : new AggregateError([...errors], message);
    this.#notifyDeferred(error);
  }

  #notifyDeferred(error: unknown): void {
    try {
      this.#onDeferredError(error);
    } catch (callbackError) {
      // Callback хост-кода не должен ломать очистку/состояние плеера.
      console.error("[labkit] ошибка обработчика onDeferredError PCM", callbackError);
    }
  }

  #setStatus(status: PcmStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#onStatus(status);
  }
}

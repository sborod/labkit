// Общая AudioWorklet-сессия LabKit (этап 3). Единственный production-backend
// realtime-DSP — AudioWorklet (ADR 002). Никакого ScriptProcessor, webkit,
// строковой генерации модулей или fallback.
//
// Модель владения ресурсами:
//   * `start()` активно транзакционен: контекст/узлы создаются как «pending» и
//     сразу записываются во владение сессии; граф публикуется ТОЛЬКО после
//     gain/config/params и готовности всех узлов;
//   * `dispose()` освобождает ТОЛЬКО текущий граф и незавершённый start:
//     синхронно снимает их со владения, отсоединяет и запускает `close` один
//     раз на ресурс (локальный флаг `closeStarted`), ожидая лишь эти вызовы.
//     Ранее отставленные контексты (`processorerror`, откат старта) не
//     собираются, и их будущий `close` не является барьером освобождения;
//   * после `await resume`/`addModule` проверяется актуальность поколения и
//     освобождение сессии: поздние продолжения не публикуют граф/статус и не
//     создают граф после освобождения;
//   * `resumeContext()` возобновляет ТОЛЬКО контекст текущего графа (или
//     незавершённого start), не создавая граф/узлы/module и не меняя
//     музыкальный `status`; нативный `resume` вызывается синхронно до первого
//     await, и КАЖДЫЙ явный вызов делает новую native-попытку (новый жест может
//     нести user activation, потерять её нельзя коалесцированием); поздние
//     исходы после dispose/снятия конкретного target-а не всплывают как ошибки;
//   * отсоединение идемпотентно на уровне каждого ресурса: повторная очистка
//     после dispose не вызывает `disconnect()` дважды;
//   * `#setStatus` не публикует устаревший статус после dispose;
//   * partial param-patch мержится, а не перетирается.
//
// Нативные асинхронные границы (`resume`, `addModule`, `close`) — обычные
// промисы; `dispose()` ждёт только `close` текущего графа/start, но не
// незавершённые `resume`/`addModule`: их поздние продолжения проверяют
// актуальность сессии.
// Синхронные нативные вызовы (фабрики контекста/узлов, `connect`, сеттеры
// обработчиков, `postMessage`) не вызывают пользовательский dispose.
//
// Этот модуль не знает ни одного параметра конкретной лаборатории.

export type WorkletStatus = "idle" | "starting" | "running" | "error" | "stopped";

/**
 * Состояние принадлежащего сессии контекста. `"none"` — контекста ещё нет
 * (до `start`, после `dispose`, отката старта или `processorerror`);
 * `"unknown"` — состояние, которого нет в известном наборе браузера.
 */
export type WorkletContextState =
  | "none"
  | "suspended"
  | "running"
  | "closed"
  | "interrupted"
  | "unknown";

/** Сообщение о телеметрии, полученное от процессора (без типа). */
export type WorkletTelemetry = Readonly<Record<string, number>>;

/**
 * Провенанс ошибки на момент доставки в `onError`. `current: true` — ошибка
 * принадлежит текущему поколению сессии; `false` — позднее продолжение или
 * cleanup уже отставленного поколения (например, `close` старого графа после
 * успешного retry). Хост может не приписывать такую ошибку новому epoch.
 */
export interface WorkletErrorInfo {
  readonly current: boolean;
}

export interface WorkletPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface WorkletNodeLike {
  readonly port: WorkletPort;
  onprocessorerror: ((event: unknown) => void) | null;
  connect(destination: unknown): unknown;
  disconnect(): void;
}

export interface WorkletAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  readonly frequencyBinCount: number;
  connect(destination: unknown): unknown;
  disconnect(): void;
  getFloatFrequencyData(array: Float32Array): void;
  /**
   * Необязательно: узкие fake-среды могут не поддерживать time-domain.
   * Views обязаны проверять наличие метода и показывать явную подсказку.
   */
  getFloatTimeDomainData?(array: Float32Array): void;
}

export interface WorkletGainParam {
  value: number;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
}

export interface WorkletGain {
  readonly gain: WorkletGainParam;
  connect(destination: unknown): unknown;
  disconnect(): void;
}

export interface WorkletAudioContext {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly state: string;
  readonly audioWorklet: { addModule(url: string): Promise<void> };
  createAnalyser(): WorkletAnalyser;
  createGain(): WorkletGain;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkletNodeOptions {
  numberOfOutputs: number;
  outputChannelCount: number[];
}

/** Среда аудио — узкий seam для тестов; в проде — `realWorkletEnvironment`. */
export interface WorkletEnvironment {
  createContext(): WorkletAudioContext;
  createNode(
    ctx: WorkletAudioContext,
    processorName: string,
    options: WorkletNodeOptions,
  ): WorkletNodeLike;
  resumeContext(ctx: WorkletAudioContext): Promise<void>;
  closeContext(ctx: WorkletAudioContext): Promise<void>;
}

export interface WorkletSessionOptions {
  env: WorkletEnvironment;
  /** Живая проверка владельца (Scope экземпляра). */
  lifetime: { readonly disposed: boolean };
  /** URL скомпилированного ESM-модуля процессора (не data: и не строка кода). */
  moduleUrl: string;
  processorName: string;
  outputChannels?: number;
  analyserFftSize?: number;
  /** Целевая частота телеметрии; процессор шлёт состояние раз в этот интервал. */
  telemetryHz?: number;
  onStatus?(status: WorkletStatus): void;
  /** Телеметрия приходит вне sample-loop и НЕ влияет на DSP. */
  onTelemetry?(telemetry: WorkletTelemetry): void;
  /** Сообщения кроме state/error; проверка схемы остаётся у лаборатории. */
  onEvent?(payload: unknown): void;
  /** Ошибки процессора/сообщения об ошибке от него/ошибки очистки. */
  onError?(error: unknown, info: WorkletErrorInfo): void;
}

/**
 * Набор принадлежащих сессии аудио-ресурсов. Флаги `*Detached` делают
 * отсоединение идемпотентным per-resource: `disconnect()` вызывается один раз,
 * даже если очистка выполняется повторно (dispose и последующий abort).
 * Флаг `closeStarted` выставляется ДО внешнего `closeContext`, поэтому повторный
 * `close` того же ресурса не вызывает среду и не воспроизводит старый исход.
 */
interface OwnedResources {
  readonly ctx: WorkletAudioContext;
  node: WorkletNodeLike | null;
  analyser: WorkletAnalyser | null;
  gain: WorkletGain | null;
  nodeDetached: boolean;
  analyserDetached: boolean;
  gainDetached: boolean;
  closeStarted: boolean;
}

type Graph = OwnedResources;
type PendingResources = OwnedResources;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flatten(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}

function emptyResources(ctx: WorkletAudioContext): OwnedResources {
  return {
    ctx,
    node: null,
    analyser: null,
    gain: null,
    nodeDetached: false,
    analyserDetached: false,
    gainDetached: false,
    closeStarted: false,
  };
}

/**
 * Экземплярная realtime-сессия. Одна на владельца; создаётся синхронно, аудио
 * запускается отдельным явным `start()` (обычно из действия по жесту).
 */
export class WorkletSession {
  readonly #env: WorkletEnvironment;
  readonly #lifetime: { readonly disposed: boolean };
  readonly #moduleUrl: string;
  readonly #processorName: string;
  readonly #outputChannels: number;
  readonly #analyserFftSize: number;
  readonly #telemetryHz: number;
  readonly #onStatus: (status: WorkletStatus) => void;
  readonly #onTelemetry: (telemetry: WorkletTelemetry) => void;
  readonly #onEvent: (payload: unknown) => void;
  readonly #onError: (error: unknown, info: WorkletErrorInfo) => void;

  #status: WorkletStatus = "idle";
  #graph: Graph | null = null;
  #pending: PendingResources | null = null;
  #master = 0;
  #muted = false;
  #params: object | null = null;
  #telemetry: WorkletTelemetry = {};
  #generation = 0;
  #startedCount = 0;
  #startTask: Promise<void> | null = null;
  #disposed = false;
  #disposal: Promise<void> | null = null;

  constructor(options: WorkletSessionOptions) {
    this.#env = options.env;
    this.#lifetime = options.lifetime;
    this.#moduleUrl = options.moduleUrl;
    this.#processorName = options.processorName;
    this.#outputChannels = options.outputChannels ?? 2;
    this.#analyserFftSize = options.analyserFftSize ?? 4096;
    this.#telemetryHz = options.telemetryHz ?? 30;
    this.#onStatus = options.onStatus ?? (() => {});
    this.#onTelemetry = options.onTelemetry ?? (() => {});
    this.#onEvent = options.onEvent ?? (() => {});
    this.#onError = options.onError ?? (() => {});
  }

  get status(): WorkletStatus {
    return this.#status;
  }

  get hasContext(): boolean {
    return this.#graph !== null;
  }

  get running(): boolean {
    return this.#graph !== null;
  }

  get startedCount(): number {
    return this.#startedCount;
  }

  get muted(): boolean {
    return this.#muted;
  }

  get master(): number {
    return this.#master;
  }

  get analyser(): WorkletAnalyser | null {
    return this.#graph?.analyser ?? null;
  }

  /** Частота дискретизации активного контекста (0, пока не запущен). */
  get sampleRate(): number {
    return this.#graph?.ctx.sampleRate ?? 0;
  }

  /**
   * Состояние принадлежащего сессии контекста. Сам AudioContext наружу не
   * выдаётся. Пока `start()` не опубликовал граф, читается контекст
   * незавершённого start (он уже создан и может быть suspended); после
   * `dispose`/отката/`processorerror` — `"none"`.
   */
  get contextState(): WorkletContextState {
    const ctx = this.#graph?.ctx ?? this.#pending?.ctx ?? null;
    if (!ctx) return "none";
    switch (ctx.state) {
      case "suspended":
      case "running":
      case "closed":
      case "interrupted":
        return ctx.state;
      default:
        return "unknown";
    }
  }

  get telemetry(): WorkletTelemetry {
    return this.#telemetry;
  }

  #closed(): boolean {
    return this.#disposed || this.#lifetime.disposed;
  }

  #stale(generation: number): boolean {
    return this.#closed() || generation !== this.#generation;
  }

  /** Снять terminal-идентичность запуска (промис больше не возвращается из start). */
  #retireStartTask(gate: Deferred<void>): void {
    if (this.#startTask === gate.promise) this.#startTask = null;
  }

  /**
   * Запустить аудио. Транзакционно: контекст создаётся синхронно до первого
   * await и сразу регистрируется как pending; граф публикуется только после
   * полной конфигурации. Промис запуска кэшируется, поэтому параллельный
   * start() возвращает ту же попытку.
   */
  start(): Promise<void> {
    if (this.#closed()) {
      return Promise.reject(new Error("labkit: worklet-сессия освобождена"));
    }
    if (this.#graph) {
      return Promise.resolve();
    }
    if (this.#startTask) {
      return this.#startTask;
    }
    const generation = ++this.#generation;
    const gate = deferred<void>();
    gate.promise.catch(() => {});
    this.#startTask = gate.promise;
    const clear = (): void => {
      if (this.#startTask === gate.promise) this.#startTask = null;
    };
    gate.promise.then(clear, clear);

    // Синхронная фаза жеста: контекст создаётся до первого await и сразу
    // остаётся во владении сессии (в pending), чтобы dispose его закрыл.
    let pending: PendingResources;
    try {
      pending = emptyResources(this.#env.createContext());
    } catch (error) {
      this.#retireStartTask(gate);
      this.#setStatus("error");
      gate.reject(error);
      return gate.promise;
    }
    this.#pending = pending;

    const resume = this.#safeResume(pending.ctx);
    this.#setStatus("starting");
    void this.#runStart(generation, pending, resume, gate);
    return gate.promise;
  }

  /**
   * Возобновить ТОЛЬКО принадлежащий сессии контекст (опубликованный граф или
   * контекст незавершённого start). Не создаёт граф/узлы, не вызывает
   * `addModule` и не меняет музыкальный `status`. Нативный `resume` вызывается
   * синхронно до первого await, поэтому метод пригоден для пользовательского
   * жеста.
   *
   * Каждый явный вызов делает собственную native-попытку: именно новый жест
   * может нести user activation, а переиспользование более раннего pending
   * `resume` (включая resume самого start) оставляет браузерный контекст
   * заблокированным. Повторный native `resume` безопасен и не создаёт граф.
   *
   * Промис разрешается `true`, если при завершении native resume конкретный
   * target (граф или pending-контекст старта) всё ещё принадлежал сессии, и
   * `false`, если он был снят (`dispose`, `processorerror`, откат/замена
   * старта). `false` — не доказательство успеха: поздний native resume мог
   * разрешиться уже после освобождения. До `start`/после `dispose` и после
   * снятия графа возобновлять нечего — промис отклоняется. Ошибка нативного
   * resume возвращается вызывающему, пока target актуален; после его снятия
   * поздний исход поглощается.
   */
  resumeContext(): Promise<boolean> {
    if (this.#closed()) {
      return Promise.reject(new Error("labkit: worklet-сессия освобождена"));
    }
    const target: OwnedResources | null = this.#graph ?? this.#pending;
    if (!target) {
      return Promise.reject(new Error("labkit: аудиоконтекст ещё не создан"));
    }
    // Никакого coalescing/переиспользования pending start resume: каждый
    // явный жест обязан вызвать native resume синхронно здесь и сейчас.
    return this.#guardResume(this.#safeResume(target.ctx), this.#generation, target);
  }

  async #runStart(
    generation: number,
    pending: PendingResources,
    resume: Promise<void>,
    gate: Deferred<void>,
  ): Promise<void> {
    const abort = async (): Promise<void> => {
      await this.#abortStart(pending, gate, generation);
    };
    try {
      await resume;
      if (this.#stale(generation)) return void (await abort());
      await pending.ctx.audioWorklet.addModule(this.#moduleUrl);
      if (this.#stale(generation)) return void (await abort());

      // Контекст/узлы создаются как pending сразу после фабрик; при сбое
      // транзакции созданное отсоединяется и контекст закрывается в catch.
      const node = this.#env.createNode(pending.ctx, this.#processorName, {
        numberOfOutputs: 1,
        outputChannelCount: [this.#outputChannels],
      });
      pending.node = node;
      const analyser = pending.ctx.createAnalyser();
      pending.analyser = analyser;
      const gain = pending.ctx.createGain();
      pending.gain = gain;

      // node → analyser → gain → destination. Анализатор — ДО master gain.
      analyser.fftSize = this.#analyserFftSize;
      analyser.smoothingTimeConstant = 0.78;
      gain.gain.value = this.#muted ? 0 : this.#master;
      node.connect(analyser);
      analyser.connect(gain);
      gain.connect(pending.ctx.destination);
      // Начальный gain через ramp (семантика эталона). Сбой — часть транзакции.
      this.#applyGainTo(gain, pending.ctx, 0.025);
      node.onprocessorerror = (event) => this.#handleProcessorError(node, event);
      node.port.onmessage = (event) => this.#handleMessage(node, event);
      this.#postTo(node, { type: "config", telemetryHz: this.#telemetryHz });
      if (this.#params) this.#postTo(node, { type: "params", p: this.#params });

      if (this.#stale(generation)) return void (await abort());

      // Публикация — единственная точка, после которой сессия считается живой.
      this.#graph = pending;
      if (this.#pending === pending) this.#pending = null;
      this.#startedCount++;
      this.#retireStartTask(gate);
      this.#setStatus("running");
      gate.resolve();
    } catch (error) {
      // Ошибка на любом шаге: реально отсоединяем созданное и закрываем контекст.
      // `#pending` снимается ДО await close, поэтому позднейший dispose не ждёт
      // уже освобождаемый start повторно.
      const cleanup = this.#detachResources(pending);
      if (this.#pending === pending) this.#pending = null;
      try {
        await this.#closeContextOnce(pending);
      } catch (cleanupError) {
        cleanup.push(...flatten(cleanupError));
      }
      if (this.#stale(generation)) {
        this.#retireStartTask(gate);
        this.#reportLate(
          new AggregateError([error, ...cleanup], "labkit: отменённый запуск worklet", {
            cause: error,
          }),
          generation,
        );
        gate.resolve();
        return;
      }
      this.#retireStartTask(gate);
      this.#setStatus("error");
      gate.reject(
        cleanup.length > 0
          ? new AggregateError([error, ...cleanup], "labkit: ошибка запуска worklet и очистки", {
              cause: error,
            })
          : error,
      );
    }
  }

  /** Отмена незавершённого запуска: отцепить ресурсы, закрыть контекст, resolve. */
  async #abortStart(
    pending: PendingResources,
    gate: Deferred<void>,
    generation: number,
  ): Promise<void> {
    const errors = this.#detachResources(pending);
    if (this.#pending === pending) this.#pending = null;
    try {
      await this.#closeContextOnce(pending);
    } catch (error) {
      errors.push(...flatten(error));
    }
    this.#retireStartTask(gate);
    if (errors.length > 0) {
      this.#reportLate(
        new AggregateError(errors, "labkit: ошибки очистки отменённого запуска worklet"),
        generation,
      );
    }
    gate.resolve();
  }

  /** Полный динамический снапшот параметров; partial-патчи мержатся. */
  setParams(params: object): void {
    this.#params = Object.assign({}, this.#params ?? {}, params);
    this.#post({ type: "params", p: this.#params });
  }

  /** Эталонная команда reset (частичный сброс делает сам процессор). */
  resetDsp(): void {
    this.#post({ type: "reset" });
  }

  /** Произвольная команда процессору (расширяемая точка, без DOM-мостов). */
  sendCommand(name: string, payload?: unknown): void {
    this.#post({ type: "command", name, payload });
  }

  setMaster(value: number): void {
    this.#master = value;
    const graph = this.#graph;
    if (graph) this.#applyGainTo(graph.gain!, graph.ctx, 0.025);
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    const graph = this.#graph;
    if (graph) this.#applyGainTo(graph.gain!, graph.ctx, 0.02);
  }

  /**
   * Освобождение. Публикует один cached Promise до внешних вызовов; синхронно
   * снимает со владения ТЕКУЩИЙ граф и незавершённый start, отсоединяет их и
   * запускает `close` один раз на ресурс. Ждёт ТОЛЬКО эти инициированные вызовы
   * (не ждёт ни `resume`/`addModule`, ни `close` ранее отставленных контекстов).
   * При реальном локальном сбое очистки промис отклоняется (успех не имитируется).
   */
  dispose(): Promise<void> {
    if (this.#disposal) {
      return this.#disposal;
    }
    const gate = deferred<void>();
    gate.promise.catch(() => {});
    this.#disposal = gate.promise;

    this.#disposed = true;
    this.#generation++;
    const graph = this.#graph;
    this.#graph = null;
    const pending = this.#pending;
    this.#pending = null;

    const errors: unknown[] = [];
    const closes: Promise<void>[] = [];
    if (graph) {
      errors.push(...this.#detachResources(graph));
      closes.push(this.#closeContextOnce(graph));
    }
    if (pending) {
      errors.push(...this.#detachResources(pending));
      closes.push(this.#closeContextOnce(pending));
    }

    // Ждём исходы ТОЛЬКО инициированных здесь close. Поздние продолжения
    // resume/addModule и старые отставленные close барьером не являются.
    Promise.allSettled(closes).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") errors.push(...flatten(result.reason));
      }
      if (errors.length > 0) {
        gate.reject(new AggregateError(errors, "labkit: ошибки при освобождении worklet-сессии"));
      } else {
        gate.resolve();
      }
    });
    return gate.promise;
  }

  // --- internal ------------------------------------------------------------

  #safeResume(ctx: WorkletAudioContext): Promise<void> {
    try {
      return Promise.resolve(this.#env.resumeContext(ctx));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Актуален ли конкретный target явного resume. Проверяется не только
   * поколение, но и владение ресурсами: откат старта снимает `#pending` без
   * смены поколения, поэтому поздний исход не должен воскресать как ошибка.
   */
  #resumeTargetCurrent(target: OwnedResources, generation: number): boolean {
    return !this.#stale(generation) && (this.#graph === target || this.#pending === target);
  }

  /**
   * Обёртка явного resume: пока target принадлежит сессии, ошибка принадлежит
   * вызвавшему жест; после dispose/processorerror/отката/замены старта поздний
   * исход относится к отменённому жесту и поглощается (сессия уже сообщила
   * причину). Успех тоже сообщает, был ли target ещё актуален в момент
   * завершения.
   */
  #guardResume(raw: Promise<void>, generation: number, target: OwnedResources): Promise<boolean> {
    const attempt = raw.then(
      () => this.#resumeTargetCurrent(target, generation),
      (error) => {
        if (!this.#resumeTargetCurrent(target, generation)) return false;
        throw error;
      },
    );
    // Не оставляем unhandled rejection, если вызывающий не подписался.
    attempt.catch(() => {});
    return attempt;
  }

  /**
   * Запустить `close` ресурса ровно один раз. Флаг `closeStarted` выставляется
   * ДО внешнего `closeContext`, поэтому повторный вызов не трогает среду и не
   * воспроизводит старый исход (возвращает уже разрешённый промис).
   */
  #closeContextOnce(resources: OwnedResources): Promise<void> {
    if (resources.closeStarted) return Promise.resolve();
    resources.closeStarted = true;
    try {
      return Promise.resolve(this.#env.closeContext(resources.ctx));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Независимая отцепка ресурсов. Снятие обработчиков и `disconnect()` каждого
   * ресурса идемпотентны: `disconnect()` вызывается один раз, даже если очистка
   * выполнена повторно (dispose, затем abort позднего продолжения).
   */
  #detachResources(resources: OwnedResources): unknown[] {
    const errors: unknown[] = [];
    const { node, analyser, gain } = resources;
    if (node) {
      try {
        node.onprocessorerror = null;
      } catch (error) {
        errors.push(error);
      }
      try {
        node.port.onmessage = null;
      } catch (error) {
        errors.push(error);
      }
      if (!resources.nodeDetached) {
        resources.nodeDetached = true;
        try {
          node.disconnect();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (analyser && !resources.analyserDetached) {
      resources.analyserDetached = true;
      try {
        analyser.disconnect();
      } catch (error) {
        errors.push(error);
      }
    }
    if (gain && !resources.gainDetached) {
      resources.gainDetached = true;
      try {
        gain.disconnect();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  #applyGainTo(gain: WorkletGain, ctx: WorkletAudioContext, timeConstant: number): void {
    gain.gain.setTargetAtTime(this.#muted ? 0 : this.#master, ctx.currentTime, timeConstant);
  }

  #post(message: unknown): void {
    const node = this.#graph?.node;
    if (node) this.#postTo(node, message);
  }

  #postTo(node: WorkletNodeLike, message: unknown): void {
    node.port.postMessage(message);
  }

  #handleMessage(node: WorkletNodeLike, event: { data: unknown }): void {
    if (this.#closed()) return;
    if (this.#graph?.node !== node) return; // stale-событие отставленного графа
    const data = event.data;
    const message = (data && typeof data === "object" ? data : {}) as {
      type?: unknown;
      message?: unknown;
    } & Record<string, unknown>;
    if (message.type === "state") {
      const telemetry: Record<string, number> = {};
      for (const [key, value] of Object.entries(message)) {
        if (key !== "type" && typeof value === "number") telemetry[key] = value;
      }
      this.#telemetry = telemetry;
      // Поколение фиксируется ДО host-колбэка: если он реентерабельно сменит
      // его (processorerror/start) и затем бросит, ошибка остаётся ошибкой
      // своего epoch, а не нового.
      const generation = this.#generation;
      try {
        this.#onTelemetry(telemetry);
      } catch (error) {
        this.#reportError(error, generation);
      }
    } else if (message.type === "error") {
      this.#reportError(new Error(String(message.message ?? "worklet error")), this.#generation);
    } else {
      const generation = this.#generation;
      try {
        this.#onEvent(data);
      } catch (error) {
        this.#reportError(error, generation);
      }
    }
  }

  /**
   * `processorerror` ретайрит мёртвый граф ДО колбэков: сессия больше не
   * «running», свежий `start()` создаёт новый процессор, а события старого
   * графа игнорируются (handlers отцеплены). `close` отставленного контекста
   * запускается здесь же (один раз), и его сбой сообщается через `#reportError`
   * в момент возникновения; будущий dispose его НЕ ждёт.
   */
  #handleProcessorError(node: WorkletNodeLike, event: unknown): void {
    if (this.#closed()) return;
    const graph = this.#graph;
    if (!graph || graph.node !== node) return;
    this.#graph = null;
    // Поколение сбоя: фиксируется здесь и переживает реентерабельный
    // onStatus/start. Поздние cleanup этого графа остаются в этом epoch.
    const epoch = ++this.#generation;
    const cleanup = this.#detachResources(graph);
    const close = this.#closeContextOnce(graph);
    close.catch((error) => this.#reportError(error, epoch));
    this.#setStatus("error");
    this.#reportError(
      event instanceof Error ? event : new Error(`labkit: processorerror: ${String(event)}`),
      epoch,
    );
    if (cleanup.length > 0) {
      this.#reportError(
        new AggregateError(cleanup, "labkit: ошибки очистки упавшего графа worklet"),
        epoch,
      );
    }
  }

  #reportLate(error: unknown, generation: number): void {
    if (!this.#disposed) {
      this.#reportError(error, generation);
    } else {
      console.error("[labkit] отложенная ошибка очистки worklet после dispose", error);
    }
  }

  #reportError(error: unknown, generation: number): void {
    if (this.#disposed) {
      console.error("[labkit] ошибка worklet после dispose", error);
      return;
    }
    const info: WorkletErrorInfo = {
      current: !this.#closed() && generation === this.#generation,
    };
    try {
      this.#onError(error, info);
    } catch (callbackError) {
      console.error("[labkit] ошибка обработчика onError worklet", callbackError);
    }
  }

  /**
   * Обновить внутренний статус и опубликовать его хосту. После dispose
   * устаревшие продолжения НЕ публикуют статус (внутреннее терминальное
   * состояние сохраняется для интроспекции).
   */
  #setStatus(status: WorkletStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    if (this.#closed()) return;
    // Как и для телеметрии: ошибка самого колбэка принадлежит поколению,
    // в котором он был вызван, даже если он успел реентерабельно запустить
    // новый start и только затем бросил.
    const generation = this.#generation;
    try {
      this.#onStatus(status);
    } catch (callbackError) {
      // Ошибка host-колбэка не должна ломать публикацию графа/освобождение.
      console.error("[labkit] ошибка обработчика onStatus worklet", callbackError);
      this.#reportError(callbackError, generation);
    }
  }
}

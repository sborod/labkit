// Узкие тестовые адаптеры worklet-сессии. НЕ production-путь: реальный
// AudioContext не создаётся, часы и сеть модуля управляются вручную, инъектируются
// сбои (resume/module/node/connect/processorerror/close). Production-страница эти
// модули не импортирует и не выбирает автоматически.
import type {
  WorkletAnalyser,
  WorkletAudioContext,
  WorkletEnvironment,
  WorkletGain,
  WorkletGainParam,
  WorkletNodeLike,
  WorkletNodeOptions,
  WorkletPort,
} from "./worklet.ts";

export class FakeWorkletNode implements WorkletNodeLike {
  #onprocessorerror: ((event: unknown) => void) | null = null;
  readonly port: WorkletPort;
  readonly connected: unknown[] = [];
  disconnected = false;
  /** Сообщения main → processor (наблюдение). */
  readonly posted: unknown[] = [];

  constructor(private readonly env: FakeWorkletEnvironment) {
    this.port = {
      postMessage: (message: unknown) => {
        this.posted.push(message);
      },
      onmessage: null,
    };
  }

  get onprocessorerror(): ((event: unknown) => void) | null {
    return this.#onprocessorerror;
  }

  set onprocessorerror(value: ((event: unknown) => void) | null) {
    this.#onprocessorerror = value;
  }

  connect(destination: unknown): unknown {
    if (this.env.failNodeConnect) {
      throw new Error("fake node: connect failure (тест)");
    }
    this.connected.push(destination);
    return destination;
  }

  disconnect(): void {
    if (this.env.failNodeDisconnect) {
      throw new Error("fake node: disconnect failure (тест)");
    }
    this.disconnected = true;
  }

  /** Симулировать телеметрию/сообщение процессора. */
  emitMessage(data: unknown): void {
    this.port.onmessage?.({ data });
  }

  /** Симулировать `onprocessorerror`. */
  emitProcessorError(): void {
    this.#onprocessorerror?.(new Error("fake processor error"));
  }
}

export class FakeWorkletAnalyser implements WorkletAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  frequencyBinCount = 1024;
  readonly connected: unknown[] = [];
  disconnected = false;

  constructor(private readonly env: FakeWorkletEnvironment) {}

  connect(destination: unknown): unknown {
    if (this.env.failAnalyserConnect) {
      throw new Error("fake analyser: connect failure (тест)");
    }
    this.connected.push(destination);
    return destination;
  }

  disconnect(): void {
    if (this.env.failAnalyserDisconnect) {
      throw new Error("fake analyser: disconnect failure (тест)");
    }
    this.disconnected = true;
  }

  getFloatFrequencyData(array: Float32Array): void {
    for (let i = 0; i < array.length; i++) {
      array[i] = -140;
    }
  }

  /**
   * Детерминированный time-domain сигнал для тестов отрисовки: синус с
   * периодом 64 сэмпла и амплитудой 0.5 FS. От sampleRate не зависит —
   * fake-анализатор не моделирует физику, только форму сигнала.
   */
  getFloatTimeDomainData(array: Float32Array): void {
    for (let i = 0; i < array.length; i++) {
      array[i] = 0.5 * Math.sin((2 * Math.PI * i) / 64);
    }
  }
}

export class FakeWorkletGain implements WorkletGain {
  readonly gain: WorkletGainParam;
  readonly connected: unknown[] = [];
  disconnected = false;
  /** История setTargetAtTime (target, startTime, timeConstant). */
  readonly ramps: Array<{ target: number; startTime: number; timeConstant: number }> = [];

  constructor(
    private readonly env: FakeWorkletEnvironment,
    initial = 0,
  ) {
    let value = initial;
    const ramps = this.ramps;
    this.gain = {
      get value(): number {
        return value;
      },
      set value(next: number) {
        if (env.failGainValue) {
          throw new Error("fake gain: value set failure (тест)");
        }
        value = next;
      },
      setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
        if (env.failGainRamp) {
          throw new Error("fake gain: setTargetAtTime failure (тест)");
        }
        ramps.push({ target, startTime, timeConstant });
        value = target;
      },
    };
  }

  connect(destination: unknown): unknown {
    if (this.env.failGainConnect) {
      throw new Error("fake gain: connect failure (тест)");
    }
    this.connected.push(destination);
    return destination;
  }

  disconnect(): void {
    if (this.env.failGainDisconnect) {
      throw new Error("fake gain: disconnect failure (тест)");
    }
    this.disconnected = true;
  }
}

export class FakeWorkletContext implements WorkletAudioContext {
  sampleRate: number;
  currentTime = 0;
  state = "running";
  readonly destination = { fake: "destination" };
  readonly modules: string[] = [];
  readonly failedModules: string[] = [];
  readonly analysers: FakeWorkletAnalyser[] = [];
  readonly gains: FakeWorkletGain[] = [];
  closed = false;
  closeCount = 0;

  readonly audioWorklet: { addModule(url: string): Promise<void> };

  constructor(
    private readonly env: FakeWorkletEnvironment,
    sampleRate: number,
  ) {
    this.sampleRate = sampleRate;
    this.audioWorklet = {
      addModule: async (url: string): Promise<void> => {
        if (env.failAddModule || env.failedModuleUrls.includes(url)) {
          this.failedModules.push(url);
          throw new Error(`fake worklet: addModule failure for ${url} (тест)`);
        }
        await env.beforeModuleReady?.();
        this.modules.push(url);
      },
    };
  }

  createAnalyser(): WorkletAnalyser {
    if (this.env.failCreateAnalyser) {
      throw new Error("fake context: createAnalyser failure (тест)");
    }
    const analyser = new FakeWorkletAnalyser(this.env);
    this.analysers.push(analyser);
    return analyser;
  }

  createGain(): WorkletGain {
    if (this.env.failCreateGain) {
      throw new Error("fake context: createGain failure (тест)");
    }
    const gain = new FakeWorkletGain(this.env);
    this.gains.push(gain);
    return gain;
  }

  resume(): Promise<void> {
    return this.env.manualResume
      ? new Promise<void>((resolve, reject) => {
          this.env.resumes.push({ resolve, reject });
        })
      : Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    this.env.closedContexts.push(this);
    if (this.env.failClose) {
      return Promise.reject(new Error("fake context: close failure (тест)"));
    }
    this.closed = true;
    return Promise.resolve();
  }

  advance(dt: number): void {
    this.currentTime += dt;
  }

  get lastGain(): FakeWorkletGain | undefined {
    return this.gains[this.gains.length - 1];
  }
}

export class FakeWorkletEnvironment implements WorkletEnvironment {
  readonly contexts: FakeWorkletContext[] = [];
  readonly nodes: FakeWorkletNode[] = [];
  readonly closedContexts: FakeWorkletContext[] = [];
  readonly resumes: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  readonly failedModuleUrls: string[] = [];
  sampleRate = 44100;
  manualResume = false;
  failCreateContext = false;
  failCreateNode = false;
  failAddModule = false;
  failNodeConnect = false;
  failNodeDisconnect = false;
  failAnalyserConnect = false;
  failAnalyserDisconnect = false;
  failCreateAnalyser = false;
  failCreateGain = false;
  failGainValue = false;
  failGainRamp = false;
  failGainConnect = false;
  failGainDisconnect = false;
  failClose = false;
  /** Асинхронный hook внутри addModule (для гонок). */
  beforeModuleReady?: () => Promise<void>;

  createContext(): WorkletAudioContext {
    if (this.failCreateContext) {
      throw new Error("fake env: createContext failure (тест)");
    }
    const ctx = new FakeWorkletContext(this, this.sampleRate);
    this.contexts.push(ctx);
    return ctx;
  }

  createNode(
    _ctx: WorkletAudioContext,
    _processorName: string,
    _options: WorkletNodeOptions,
  ): WorkletNodeLike {
    if (this.failCreateNode) {
      throw new Error("fake env: createNode failure (тест)");
    }
    const node = new FakeWorkletNode(this);
    this.nodes.push(node);
    return node;
  }

  resumeContext(ctx: WorkletAudioContext): Promise<void> {
    return (ctx as FakeWorkletContext).resume();
  }

  closeContext(ctx: WorkletAudioContext): Promise<void> {
    return (ctx as FakeWorkletContext).close();
  }

  get pendingResumes(): number {
    return this.resumes.length;
  }

  resolveNextResume(): void {
    this.resumes.shift()?.resolve();
  }

  rejectNextResume(error: unknown): void {
    this.resumes.shift()?.reject(error);
  }

  get lastNode(): FakeWorkletNode | undefined {
    return this.nodes[this.nodes.length - 1];
  }

  get lastContext(): FakeWorkletContext | undefined {
    return this.contexts[this.contexts.length - 1];
  }
}

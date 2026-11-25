// Узкие тестовые адаптеры аудио. НЕ production-путь: реальный контекст не
// создаётся, секвенсор/часы управляются вручную. Используются unit-тестами
// плеера и тестовой замены PCM, чтобы сценарий мог
// отработать без живого output и без пользовательского жеста.
import type { PcmAudioContext, PcmEnvironment, PcmScheduler } from "./pcm.ts";

export class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  readonly #data: Float32Array;

  constructor(length: number, sampleRate: number, channels = 1) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.numberOfChannels = channels;
    this.duration = sampleRate > 0 ? length / sampleRate : 0;
    this.#data = new Float32Array(length * channels);
  }

  copyToChannel(source: Float32Array, channelNumber = 0): void {
    // Присваиваем как Float32 (как реальный copyToChannel).
    const start = channelNumber * this.length;
    for (let i = 0; i < this.length && i < source.length; i++) {
      this.#data[start + i] = source[i] as number;
    }
  }

  getChannelData(channel = 0): Float32Array {
    return this.#data.subarray(channel * this.length, (channel + 1) * this.length);
  }
}

export class FakeBufferSource {
  #buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly ctx: FakePcmContext;
  started = false;
  stopped = false;
  disconnected = false;
  connectCalls = 0;
  startWhen = 0;
  startOffset = 0;

  constructor(ctx: FakePcmContext) {
    this.ctx = ctx;
  }

  get buffer(): FakeAudioBuffer | null {
    return this.#buffer;
  }

  set buffer(next: FakeAudioBuffer | null) {
    if (this.ctx.failBufferSet) {
      throw new Error("fake source: buffer set failure (тест)");
    }
    this.#buffer = next;
  }

  connect(): void {
    this.connectCalls += 1;
  }

  disconnect(): void {
    if (this.ctx.failSourceDisconnect) {
      throw new Error("fake source: disconnect failure (тест)");
    }
    this.disconnected = true;
  }

  start(when = 0, offset = 0): void {
    if (this.ctx.failStart) throw new Error("fake source: start failure (тест)");
    if (this.started) throw new Error("fake source: уже запущен");
    this.started = true;
    this.startWhen = when;
    this.startOffset = offset;
  }

  stop(): void {
    if (this.ctx.failSourceStop) {
      throw new Error("fake source: stop failure (тест)");
    }
    if (this.stopped) {
      // Повторный stop — штатная InvalidStateError реального API.
      throw new DOMException("already stopped", "InvalidStateError");
    }
    if (!this.started) {
      throw new DOMException("not started", "InvalidStateError");
    }
    this.stopped = true;
  }

  /** Тестовое событие естественного окончания. */
  emitEnded(): void {
    this.onended?.();
  }
}

export class FakeGain {
  #value = 0;
  readonly #ctx: FakePcmContext;
  connected = false;
  disconnected = false;

  constructor(ctx: FakePcmContext) {
    this.#ctx = ctx;
  }

  get gain(): { value: number } {
    const read = () => this.#value;
    const write = (next: number): void => {
      if (this.#ctx.failGainValue) {
        throw new Error("fake gain: value set failure (тест)");
      }
      this.#value = next;
    };
    return {
      get value(): number {
        return read();
      },
      set value(next: number) {
        write(next);
      },
    };
  }

  connect(): void {
    if (this.#ctx.failGainConnect) {
      throw new Error("fake gain: connect failure (тест)");
    }
    this.connected = true;
  }

  disconnect(): void {
    if (this.#ctx.failGainDisconnect) {
      throw new Error("fake gain: disconnect failure (тест)");
    }
    this.disconnected = true;
  }
}

export class FakePcmContext implements PcmAudioContext {
  currentTime = 0;
  readonly sampleRate: number;
  readonly destination = {} as AudioDestinationNode;
  readonly buffers: FakeAudioBuffer[] = [];
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeGain[] = [];
  /** Инъекция сбоев (тесты ошибок). */
  failCreateBuffer = false;
  failCreateSource = false;
  failStart = false;
  failSourceStop = false;
  failSourceDisconnect = false;
  failBufferSet = false;
  failGainConnect = false;
  failGainValue = false;
  failGainDisconnect = false;

  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    if (this.failCreateBuffer) throw new Error("fake context: createBuffer failure (тест)");
    const buffer = new FakeAudioBuffer(length, sampleRate);
    this.buffers.push(buffer);
    return buffer as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    if (this.failCreateSource) throw new Error("fake context: createBufferSource failure (тест)");
    const source = new FakeBufferSource(this);
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain(): GainNode {
    const gain = new FakeGain(this);
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  /** Продвинуть управляемые часы контекста. */
  advance(dt: number): void {
    this.currentTime += dt;
  }

  get lastSource(): FakeBufferSource | undefined {
    return this.sources[this.sources.length - 1];
  }
}

export class FakeAudioEnvironment implements PcmEnvironment {
  readonly contexts: FakePcmContext[] = [];
  sampleRate = 44100;
  /** true — resume разрешается сразу; false — вручную (очередь). */
  autoResume = true;
  /** true — closeContext отклоняется (проверка dispose). */
  failClose = false;
  /** true — создание контекста бросает (проверка ошибки конструирования). */
  failCreateContext = false;
  /** Публичная очередь resume: позволяет разрешать в произвольном порядке. */
  readonly resumes: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  /** Настроить свежесозданный контекст (инъекция сбоев). */
  configureContext?: (ctx: FakePcmContext) => void;
  /** Вызывается внутри closeContext (reentrancy-проверки). */
  onClose?: (ctx: FakePcmContext) => void;
  closeCount = 0;

  createContext(): PcmAudioContext {
    if (this.failCreateContext) {
      throw new Error("createContext boom (тест)");
    }
    const ctx = new FakePcmContext(this.sampleRate);
    this.configureContext?.(ctx);
    this.contexts.push(ctx);
    return ctx;
  }

  resumeContext(): Promise<void> {
    if (this.autoResume) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.resumes.push({ resolve, reject });
    });
  }

  closeContext(ctx: PcmAudioContext): Promise<void> {
    this.closeCount += 1;
    this.onClose?.(ctx as FakePcmContext);
    if (this.failClose) {
      return Promise.reject(new Error("close boom (тест)"));
    }
    return Promise.resolve();
  }

  get pendingResumes(): number {
    return this.resumes.length;
  }

  resolveNextResume(): void {
    const next = this.resumes.shift();
    next?.resolve();
  }

  rejectNextResume(error: unknown): void {
    const next = this.resumes.shift();
    next?.reject(error);
  }
}

export class FakeScheduler implements PcmScheduler {
  #queue = new Map<number, () => void>();
  #next = 1;

  schedule(handler: () => void): number {
    const id = this.#next++;
    this.#queue.set(id, handler);
    return id;
  }

  cancel(handle: number): void {
    this.#queue.delete(handle);
  }

  get pending(): number {
    return this.#queue.size;
  }

  runAll(): void {
    const handlers = [...this.#queue.values()];
    this.#queue.clear();
    for (const handler of handlers) {
      handler();
    }
  }
}

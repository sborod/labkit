// Тестовые адаптеры MIDI. НЕ production-путь: реальный MIDIAccess не
// запрашивается. Позволяют вручную управлять устройствами, hotplug и сообщениями.
import type { MidiAccessLike, MidiEnvironment, MidiInputLike, MidiOutputLike } from "./types.ts";

type Listener = (event: { data: ArrayLike<number> }) => void;

export class FakeMidiInput implements MidiInputLike {
  state = "connected";
  readonly #listeners = new Set<Listener>();

  constructor(
    readonly id: string,
    readonly name: string | null,
  ) {}

  addEventListener(_type: "midimessage", listener: Listener): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "midimessage", listener: Listener): void {
    this.#listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Симулировать сообщение всем независимым слушателям. */
  emit(data: ArrayLike<number>): void {
    for (const listener of [...this.#listeners]) {
      listener({ data });
    }
  }
}

export class FakeMidiOutput implements MidiOutputLike {
  state = "connected";
  readonly messages: number[][] = [];
  failSend: unknown = null;

  constructor(
    readonly id: string,
    readonly name: string | null,
  ) {}

  send(data: number[] | Uint8Array): void {
    if (this.failSend) throw this.failSend;
    this.messages.push(Array.from(data));
  }
}

export class FakeMidiAccess implements MidiAccessLike {
  readonly inputs = new Map<string, FakeMidiInput>();
  readonly outputs = new Map<string, FakeMidiOutput>();
  readonly #listeners = new Set<() => void>();

  addStateChangeListener(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  fireStateChange(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

interface DeferredAccess {
  resolve(access: MidiAccessLike): void;
  reject(error: unknown): void;
}

export class FakeMidiEnvironment implements MidiEnvironment {
  supported = true;
  secure = true;
  access: FakeMidiAccess | null = null;
  requestCount = 0;
  failAccess: unknown = null;
  /** true — requestAccess висит, пока тест не разрешит вручную. */
  manualAccess = false;
  readonly pending: DeferredAccess[] = [];

  isSupported(): boolean {
    return this.supported;
  }

  isSecureContext(): boolean {
    return this.secure;
  }

  requestAccess(): Promise<MidiAccessLike> {
    this.requestCount += 1;
    if (this.failAccess) {
      return Promise.reject(this.failAccess);
    }
    if (this.manualAccess) {
      return new Promise<MidiAccessLike>((resolve, reject) => {
        this.pending.push({ resolve, reject });
      });
    }
    if (!this.access) this.access = new FakeMidiAccess();
    return Promise.resolve(this.access);
  }

  ensureAccess(): FakeMidiAccess {
    if (!this.access) this.access = new FakeMidiAccess();
    return this.access;
  }

  resolveAccess(access: FakeMidiAccess = this.ensureAccess()): void {
    this.access = access;
    this.pending.shift()?.resolve(access);
  }

  rejectAccess(error: unknown): void {
    this.pending.shift()?.reject(error);
  }

  addInput(id: string, name: string | null = id): FakeMidiInput {
    const input = new FakeMidiInput(id, name);
    this.ensureAccess().inputs.set(id, input);
    return input;
  }

  removeInput(id: string): void {
    this.access?.inputs.delete(id);
  }

  disconnectInput(id: string): void {
    const input = this.access?.inputs.get(id);
    if (input) input.state = "disconnected";
  }

  addOutput(id: string, name: string | null = id): FakeMidiOutput {
    const output = new FakeMidiOutput(id, name);
    this.ensureAccess().outputs.set(id, output);
    return output;
  }

  removeOutput(id: string): void {
    this.access?.outputs.delete(id);
  }

  disconnectOutput(id: string): void {
    const output = this.access?.outputs.get(id);
    if (output) output.state = "disconnected";
  }

  fireStateChange(): void {
    this.access?.fireStateChange();
  }
}

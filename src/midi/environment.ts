// Live port enumeration and independent, lazy state-change subscriptions.
// Native add/removeEventListener preserves other consumers' handlers.
import type { MidiAccessLike, MidiEnvironment, MidiInputLike, MidiOutputLike } from "./types.ts";

class RealMidiAccess implements MidiAccessLike {
  readonly #listeners = new Set<() => void>();
  #nativeHandler: (() => void) | null = null;

  constructor(private readonly access: MIDIAccess) {}

  get inputs(): Map<string, MidiInputLike> {
    const map = new Map<string, MidiInputLike>();
    for (const input of this.access.inputs.values()) {
      // Preserve native port identity across reads.
      map.set(input.id, input as unknown as MidiInputLike);
    }
    return map;
  }

  get outputs(): Map<string, MidiOutputLike> {
    const map = new Map<string, MidiOutputLike>();
    for (const output of this.access.outputs.values()) map.set(output.id, output);
    return map;
  }

  addStateChangeListener(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      const handler = (): void => {
        for (const current of [...this.#listeners]) current();
      };
      this.#nativeHandler = handler;
      this.access.addEventListener("statechange", handler);
    }
    return () => {
      if (!this.#listeners.delete(listener)) return;
      if (this.#listeners.size === 0 && this.#nativeHandler) {
        this.access.removeEventListener("statechange", this.#nativeHandler);
        this.#nativeHandler = null;
      }
    };
  }
}

export const realMidiEnvironment: MidiEnvironment = {
  isSupported(): boolean {
    return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
  },
  isSecureContext(): boolean {
    if (typeof window === "undefined") return false;
    return window.isSecureContext !== false;
  },
  async requestAccess(): Promise<MidiAccessLike> {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    return new RealMidiAccess(access);
  },
};

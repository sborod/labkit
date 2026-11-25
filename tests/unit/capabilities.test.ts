import { describe, expect, it } from "vitest";
import {
  CapabilityError,
  checkCapabilities,
  detectCapabilities,
  type CapabilityEnvironment,
} from "../../src/runtime/capabilities.ts";

function env(overrides: Partial<CapabilityEnvironment> = {}): CapabilityEnvironment {
  return {
    isSecureContext: true,
    hasDocument: true,
    hasCanvas2d: true,
    hasAudioContext: true,
    hasAudioWorkletNode: true,
    hasWorker: true,
    hasRequestMidiAccess: true,
    ...overrides,
  };
}

describe("detectCapabilities", () => {
  it("поддерживает всё в современной среде", () => {
    const report = detectCapabilities(env());
    expect(report.canvas.supported).toBe(true);
    expect(report.audioContext.supported).toBe(true);
    expect(report.audioWorklet.supported).toBe(true);
    expect(report.worker.supported).toBe(true);
    expect(report.midi.supported).toBe(true);
  });

  it("audioContext — независимая возможность без требования secure context", () => {
    // Нет AudioContext → audioContext недоступен; но отсутствие secure context
    // само по себе НЕ отключает audioContext (в отличие от audioWorklet/midi).
    const noContext = detectCapabilities(env({ hasAudioContext: false }));
    expect(noContext.audioContext.supported).toBe(false);
    expect(noContext.audioContext.reason).toMatch(/AudioContext/);
    expect(noContext.audioWorklet.supported).toBe(false);

    const insecure = detectCapabilities(env({ isSecureContext: false }));
    expect(insecure.audioContext.supported).toBe(true);
    expect(insecure.audioWorklet.supported).toBe(false);
    expect(insecure.midi.supported).toBe(false);
  });

  it("AudioWorklet требует secure context — отдельная причина", () => {
    const report = detectCapabilities(env({ isSecureContext: false }));
    expect(report.audioWorklet.supported).toBe(false);
    expect(report.audioWorklet.reason).toMatch(/secure context/);
    expect(report.worker.supported).toBe(true);
    expect(report.midi.supported).toBe(false);
    expect(report.midi.reason).toMatch(/secure context/);
  });

  it("отсутствие возможности сообщается отдельно (по возможностям)", () => {
    const report = detectCapabilities(env({ hasRequestMidiAccess: false }));
    expect(report.midi.supported).toBe(false);
    expect(report.canvas.supported).toBe(true);
    expect(report.worker.supported).toBe(true);
  });
});

describe("checkCapabilities", () => {
  it("разделяет обязательные и опциональные", () => {
    const report = detectCapabilities(env({ hasRequestMidiAccess: false }));
    const statuses = checkCapabilities(report, ["canvas"], ["midi"]);
    expect(statuses).toHaveLength(2);
    const canvas = statuses.find((s) => s.id === "canvas");
    const midi = statuses.find((s) => s.id === "midi");
    expect(canvas).toMatchObject({ supported: true, required: true });
    expect(midi).toMatchObject({ supported: false, required: false });
  });

  it("дубликаты возможностей не повторяются", () => {
    const report = detectCapabilities(env());
    const statuses = checkCapabilities(report, ["canvas", "canvas"], []);
    expect(statuses).toHaveLength(1);
  });

  it("CapabilityError несёт список отсутствующих и статусы", () => {
    const report = detectCapabilities(env({ hasCanvas2d: false }));
    const statuses = checkCapabilities(report, ["canvas"], []);
    const missing = statuses.filter((s) => s.required && !s.supported).map((s) => s.id);
    const error = new CapabilityError(missing, statuses);
    expect(error.missing).toEqual(["canvas"]);
    expect(error.message).toMatch(/canvas/);
  });
});

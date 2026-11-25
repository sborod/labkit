import { describe, expect, it } from "vitest";
import {
  absoluteScale,
  decodeMidiMessage,
  isRelative,
  quantize,
  relativeDelta,
  switchFromValue,
} from "../../src/midi/decode.ts";

describe("MIDI: декодирование", () => {
  it("принимает CC/Note On/Note Off на канале", () => {
    expect(decodeMidiMessage([0xb0, 20, 100])).toEqual({
      channel: 1,
      source: "cc",
      number: 20,
      value: 100,
      on: false,
    });
    expect(decodeMidiMessage([0x90, 60, 80])).toEqual({
      channel: 1,
      source: "note",
      number: 60,
      value: 80,
      on: true,
    });
    expect(decodeMidiMessage([0x81, 60, 0])).toEqual({
      channel: 2,
      source: "note",
      number: 60,
      value: 0,
      on: false,
    });
    // Note On с velocity 0 трактуется как Note Off.
    expect(decodeMidiMessage([0x90, 60, 0])?.on).toBe(false);
  });

  it("отбрасывает битые сообщения", () => {
    expect(decodeMidiMessage(null)).toBeNull();
    expect(decodeMidiMessage([0xb0, 20])).toBeNull();
    expect(decodeMidiMessage([0xb0, 20, 100, 5])).toBeNull();
    expect(decodeMidiMessage([0x70, 20, 100])).toBeNull();
    expect(decodeMidiMessage([0xb0, 200, 100])).toBeNull();
    expect(decodeMidiMessage([0xb0, 20, 200])).toBeNull();
    expect(decodeMidiMessage([0xb0, 20.5, 100])).toBeNull();
  });
});

describe("MIDI: относительные режимы", () => {
  it("isRelative — только cc и не absolute", () => {
    expect(isRelative("absolute", "cc")).toBe(false);
    expect(isRelative("delta", "cc")).toBe(true);
    expect(isRelative("delta", "note")).toBe(false);
  });

  it("delta/wrap: первое сообщение только якорит", () => {
    expect(relativeDelta("delta", 10, null)).toBeNull();
    expect(relativeDelta("delta", 11, 10)).toBe(1);
    expect(relativeDelta("delta", 9, 10)).toBe(-1);
    // wrap сворачивает переход через границу.
    expect(relativeDelta("wrap", 0, 127)).toBe(1);
    expect(relativeDelta("wrap", 127, 0)).toBe(-1);
    expect(relativeDelta("wrap", 64, 60)).toBe(4);
  });

  it("twos/offset/sign — бесстатусные", () => {
    expect(relativeDelta("twos", 1, 0)).toBe(1);
    expect(relativeDelta("twos", 127, 0)).toBe(-1);
    expect(relativeDelta("offset", 65, 0)).toBe(1);
    expect(relativeDelta("offset", 63, 0)).toBe(-1);
    expect(relativeDelta("sign", 1, 0)).toBe(1);
    expect(relativeDelta("sign", 65, 0)).toBe(-1);
  });
});

describe("MIDI: масштаб и квантование", () => {
  it("absolute масштабирует 0..127 в [min,max]", () => {
    expect(absoluteScale(0, 0.45, 4)).toBeCloseTo(0.45, 10);
    expect(absoluteScale(127, 0.45, 4)).toBeCloseTo(4, 10);
  });

  it("quantize анкерен на min и клампится", () => {
    // min 0, step 0.5: 5.04 → 5.0
    expect(quantize(absoluteScale(64, 0, 10), 0, 10, 0.5)).toBe(5.0);
    // анкер 0.45, step 0.01: 0.472 → 0.47
    expect(quantize(0.472, 0.45, 4, 0.01)).toBeCloseTo(0.47, 10);
    expect(quantize(999, 0, 1, 0.01)).toBe(1);
    expect(quantize(-5, 0, 1, 0.01)).toBe(0);
    expect(quantize(0.33, 0, 1, "any")).toBe(0.33);
  });

  it("switchFromValue: порог 64", () => {
    expect(switchFromValue(63)).toBe(false);
    expect(switchFromValue(64)).toBe(true);
  });
});

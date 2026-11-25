// Чистое декодирование MIDI и относительные режимы. Без DOM и без состояния.
import type { MidiMessage, MidiMode, MidiSource } from "./types.ts";

/**
 * Разобрать 3-байтное сообщение. Принимаются CC (0xB0), Note On (0x90) и
 * Note Off (0x80). Всё остальное (в т.ч. служебные статусы, sysex, битые длины)
 * отбрасывается. Валидация строгая, как в существующем корпусе.
 */
export function decodeMidiMessage(data: ArrayLike<number> | null | undefined): MidiMessage | null {
  if (!data || data.length !== 3) return null;
  const status = data[0] as number;
  const number = data[1] as number;
  const value = data[2] as number;
  if (
    !Number.isInteger(status) ||
    !Number.isInteger(number) ||
    !Number.isInteger(value) ||
    status < 128 ||
    status > 239 ||
    number < 0 ||
    number > 127 ||
    value < 0 ||
    value > 127
  ) {
    return null;
  }
  const kind = status & 0xf0;
  if (kind !== 0xb0 && kind !== 0x90 && kind !== 0x80) return null;
  const source: MidiSource = kind === 0xb0 ? "cc" : "note";
  const on = kind === 0x90 && value > 0;
  return { channel: (status & 0x0f) + 1, source, number, value, on };
}

/** Относительный режим применим только к числовому параметру и источнику CC. */
export function isRelative(mode: MidiMode, source: MidiSource): boolean {
  return source === "cc" && mode !== "absolute";
}

/**
 * Приращение для относительного режима.
 * Для `delta`/`wrap` `previous === null` означает первое сообщение: возвращается
 * `null` (позиция запоминается, параметр не меняется). Остальные режимы
 * бесстатусны.
 */
export function relativeDelta(
  mode: MidiMode,
  value: number,
  previous: number | null,
): number | null {
  if (mode === "delta" || mode === "wrap") {
    if (previous === null) return null;
    let delta = value - previous;
    if (mode === "wrap") {
      if (delta > 64) delta -= 128;
      else if (delta < -64) delta += 128;
    }
    return delta;
  }
  if (mode === "twos") return value < 64 ? value : value - 128;
  if (mode === "offset") return value - 64;
  if (mode === "sign") return value < 64 ? value : -(value - 64);
  return 0;
}

/**
 * Абсолютное масштабирование значения 0..127 в [min, max] — как в эталоне
 * (линейно, БЕЗ квантования по шагу; квантование делает `quantize`).
 */
export function absoluteScale(value: number, min: number, max: number): number {
  return min + ((max - min) * value) / 127;
}

/**
 * Квантование по сетке шага, АНКЕР — минимум: `min + round((x−min)/step)·step`,
 * затем clamp. Реестр сам НЕ квантует (только clamp), поэтому квантование
 * обязательно на стороне адаптера. `step` может быть `"any"` — тогда без сетки.
 */
export function quantize(value: number, min: number, max: number, step: number | "any"): number {
  const clamped = Math.max(min, Math.min(max, value));
  if (step === "any" || !(step > 0)) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  return Math.max(min, Math.min(max, snapped));
}

/** Значение тумблера из CC по порогу 64 (как в эталоне). */
export function switchFromValue(value: number): boolean {
  return value >= 64;
}

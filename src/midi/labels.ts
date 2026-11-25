import type { MidiMode } from "./types.ts";

/** Порядок и подписи режимов CC — из эталонной MIDI-панели корпуса. */
export const MIDI_MODE_ORDER: readonly MidiMode[] = [
  "absolute",
  "delta",
  "wrap",
  "twos",
  "offset",
  "sign",
];

export const MIDI_MODE_LABELS: Record<MidiMode, string> = {
  absolute: "Значение (абсолютно)",
  delta: "Относительно: из абсолютных 0–127",
  wrap: "Относительно: 0–127 по кругу",
  twos: "Относительно: +1 = 1, −1 = 127",
  offset: "Относительно: +1 = 65, −1 = 63",
  sign: "Относительно: +1 = 1, −1 = 65",
};

// Сужение непрозрачного `ActionContext.input` до MIDI-действия. Это не schema
// DSL и не копия decoder'а: проверяются только поля контракта MidiActionInput,
// а корректный producer (MidiAdapter) уже отдаёт frozen-снимок.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function malformed(reason: string): never {
  throw new Error(`labkit: некорректный MIDI action input: ${reason}`);
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/**
 * Нормализованная velocity Note On из payload действия: `0..1`.
 * `undefined` — это не MIDI-действие, CC или Note Off (включая Note On с
 * velocity 0). Если `kind: "midi"` заявлен, но поля повреждены, helper не
 * подменяет ошибку `undefined`, а бросает явную ошибку с префиксом `labkit:`.
 */
export function midiNoteVelocity(input: unknown): number | undefined {
  if (!isRecord(input) || input.kind !== "midi") return undefined;
  if (typeof input.inputId !== "string") malformed("inputId должен быть строкой");
  if (!isRecord(input.message)) malformed("message должен быть объектом");
  const message = input.message;
  if (message.source !== "cc" && message.source !== "note") {
    malformed('message.source должен быть "cc" или "note"');
  }
  if (!integerInRange(message.channel, 1, 16)) {
    malformed("message.channel должен быть целым 1..16");
  }
  if (!integerInRange(message.number, 0, 127)) {
    malformed("message.number должен быть целым 0..127");
  }
  if (!integerInRange(message.value, 0, 127)) {
    malformed("message.value должен быть целым 0..127");
  }
  if (typeof message.on !== "boolean") malformed("message.on должен быть boolean");
  if (message.source === "cc") {
    if (message.on) malformed("для CC message.on должен быть false");
    return undefined;
  }
  if (!message.on) return undefined; // Note Off; release velocity допустима ненулевой.
  if (message.value === 0) malformed("Note On требует message.value > 0");
  return message.value / 127;
}

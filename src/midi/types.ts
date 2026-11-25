// Типы MIDI-адаптера LabKit. Назначения (`MidiMapping`) адресуют ТОЛЬКО реестр
// параметров/действий по id, а не DOM (ADR 001); синтетических DOM-событий нет.
// Opt-in поток музыкальных событий для локального инструмента идёт отдельно
// (`subscribeInput`) в том же адаптере и также не трогает DOM.

export type MidiSource = "cc" | "note";

/**
 * Режимы значения CC (семантика из существующего корпуса, Sombrero/эталонные
 * MIDI-доработки):
 *   * `absolute` — значение 0..127 линейно масштабируется в [min, max];
 *   * `delta`    — приращение `value − previous` по каналу; первое сообщение
 *                  только запоминает позицию (без изменения параметра);
 *   * `wrap`     — как `delta`, но скачок через границу 0/127 сворачивается
 *                  (±128);
 *   * `twos`     — знаковое дополнение: 0..63 → 0..63, 64..127 → −64..−1;
 *   * `offset`   — `value − 64`;
 *   * `sign`     — 0..63 → 0..63, 64..127 → −(value−64).
 * Все относительные режимы применяются только к числовым параметрам и только
 * для источника `cc`.
 */
export type MidiMode = "absolute" | "delta" | "wrap" | "twos" | "offset" | "sign";

export interface MidiMapping {
  /** Стабильный id строки (для CRUD/UI). */
  id: string;
  /** id параметра или действия реестра. */
  target: string;
  source: MidiSource;
  /** Номер CC или Note (0..127). */
  number: number;
  /**
   * Канал сообщения: 0 — любой, 1..16 — конкретный. Канал принадлежит
   * назначению, поэтому одинаковые CC/Note на разных каналах независимы.
   */
  channel: number;
  mode: MidiMode;
  /** Множитель шага для относительных режимов (1..100). */
  sensitivity: number;
  invert: boolean;
}

export interface MidiMessage {
  channel: number; // 1..16
  source: MidiSource;
  number: number;
  /** CC value или velocity. */
  value: number;
  /** Note On с velocity > 0. Для CC — false. */
  on: boolean;
}

/**
 * Payload действия, вызванного реальным MIDI-сообщением. Верхний объект и
 * `message` — независимый immutable snapshot исходного сообщения; изменения
 * мониторингового `onMonitor`/`lastMessage` на него не влияют.
 */
export type MidiActionInput = Readonly<{
  kind: "midi";
  inputId: string;
  message: Readonly<MidiMessage>;
}>;

/**
 * Событие opt-in потока входных MIDI-сообщений (`MidiAdapter.subscribeInput`).
 *
 * Назначения по-прежнему адресуют реестр; этот поток нужен локальному
 * инструменту лаборатории и не создаёт DOM-событий. `message` — независимый
 * readonly-снимок декодированного сообщения (не ссылка на mapping/event.data),
 * поэтому его нельзя изменить из `onMonitor` или другого подписчика.
 *
 *   * `consumedByLearn` — сообщение поглощено обучением (CC или Note On);
 *   * `matchedMapping` — существует строка назначения с теми же
 *     source/number/channel, даже если её цель сейчас недоступна.
 *
 * SDK НЕ фильтрует сообщения по этим флагам: локальный инструмент сам решает,
 * подавлять ли Note On, но обязан всегда принимать Note Off и CC-отпускание.
 *
 * `input-reset` — вход снят из активного набора: `disconnect` — hotplug/
 * отключение устройства, `selection` — явная смена выбора, `dispose` —
 * терминальный сброс при освобождении адаптера. Reset скоупится одним входом:
 * отключение одного устройства не сбрасывает остальные.
 */
export type MidiInputEvent =
  | {
      type: "message";
      inputId: string;
      message: Readonly<MidiMessage>;
      consumedByLearn: boolean;
      matchedMapping: boolean;
    }
  | {
      type: "input-reset";
      inputId: string;
      reason: "disconnect" | "selection" | "dispose";
    };

export type MidiStatusKind =
  | "unsupported"
  | "insecure"
  | "idle"
  | "connecting"
  | "connected"
  | "no-inputs"
  | "input-disconnected"
  | "denied"
  | "error";

export interface MidiStatus {
  kind: MidiStatusKind;
  message: string;
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
}

/** Узкая поверхность MIDI-входа (структурно `MIDIInput`). */
export interface MidiInputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: string;
  addEventListener(
    type: "midimessage",
    listener: (event: { data: ArrayLike<number> }) => void,
  ): void;
  removeEventListener(
    type: "midimessage",
    listener: (event: { data: ArrayLike<number> }) => void,
  ): void;
}

/** Узкая поверхность MIDI-выхода, совместимая с нативным MIDIOutput. */
export interface MidiOutputLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: string;
  send(data: number[] | Uint8Array): void;
}

/** Узкая поверхность MIDIAccess. Порты перечисляются живьём (hotplug). */
export interface MidiAccessLike {
  readonly inputs: Map<string, MidiInputLike>;
  readonly outputs?: Map<string, MidiOutputLike>;
  /**
   * Подписка на изменения состояния. Возвращает функцию отписки. Слушатели
   * независимы: dispose одного адаптера не должен отключать другой.
   */
  addStateChangeListener(listener: () => void): () => void;
}

/** Среда MIDI — seam для тестов; в проде `realMidiEnvironment`. */
export interface MidiEnvironment {
  isSupported(): boolean;
  isSecureContext(): boolean;
  requestAccess(): Promise<MidiAccessLike>;
}

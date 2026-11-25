// Персистентность MIDI-назначений в версионированном namespace. Ключ отдельный
// от состояния лаборатории.
//
// ПОЛИТИКА (ADR 010):
//   * строгая версия схемы: несовпадение `version` → состояние НЕ читается и не
//     «угадывается»; причина сообщается вызывающему как issue;
//   * каждая строка валидируется независимо; невалидная отбрасывается с issue;
//   * id уникален: отсутствующий/дублирующийся id заменяется на новый через
//     `idFactory` (иначе восстановленные и новые строки делили бы runtime-hold);
//   * ошибки доступа к хранилищу (get/set) НЕ проглатываются в store —
//     вызывающий адаптер решает, как сообщить (warning/status/error).
//
// СХЕМА V2: канал принадлежит назначению. Глобального `channel` больше нет.
// При отсутствии v2 читается legacy-ключ v1: глобальный канал копируется в
// каждую строку, после чего мигрированное состояние сразу пишется в v2. Ключ
// v1 не удаляется (в интерфейсе хранилища нет removeItem). Сбой записи
// миграции — исключение из политики проброса: он сообщается как issue, чтобы
// уже прочитанные строки не потерялись; v1 при этом остаётся нетронутым.
import type { MidiMapping, MidiMode, MidiSource } from "./types.ts";

export interface MidiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Версия схемы хранения. Несовпадение → состояние не читается. */
export const MIDI_STORAGE_VERSION = 2;

/** Legacy-версия схемы: глобальный `channel` на всё состояние. */
const LEGACY_STORAGE_VERSION = 1;

export function midiStorageKey(namespace: string, version: number = MIDI_STORAGE_VERSION): string {
  return `labkit.midi.${namespace}.v${version}`;
}

export interface StoredMidiState {
  mappings: MidiMapping[];
  /** Диагностика: несовпадение версии, отброшенные строки и т.п. */
  issues: string[];
}

const MODES: readonly MidiMode[] = ["absolute", "delta", "wrap", "twos", "offset", "sign"];
const SOURCES: readonly MidiSource[] = ["cc", "note"];

/** Память процесса: используется, когда localStorage недоступен (например, jsdom). */
export class MemoryMidiStorage implements MidiStorage {
  readonly #map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChannel(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 16;
}

/**
 * Прочитать состояние. Пропускает ошибки `storage.getItem` наружу (адаптер
 * сообщает). Возвращает валидные строки с уникальными id и список issues.
 *
 * Сначала читается текущий ключ v2; legacy v1 читается ТОЛЬКО если v2
 * отсутствует. Существующий (в т.ч. повреждённый) v2 никогда не откатывается
 * к v1 — иначе старые строки «воскресали» бы после неудачной записи.
 */
export function loadMidiState(
  storage: MidiStorage,
  namespace: string,
  idFactory: () => string,
): StoredMidiState {
  const issues: string[] = [];
  const text = storage.getItem(midiStorageKey(namespace));
  if (text !== null) return readCurrentState(text, idFactory, issues);
  return readLegacyState(storage, namespace, idFactory, issues);
}

function readCurrentState(
  text: string,
  idFactory: () => string,
  issues: string[],
): StoredMidiState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    issues.push("хранилище MIDI: некорректный JSON — состояние не прочитано");
    return { mappings: [], issues };
  }
  if (!isRecord(raw)) {
    issues.push("хранилище MIDI: ожидался объект — состояние не прочитано");
    return { mappings: [], issues };
  }
  if (raw.version !== MIDI_STORAGE_VERSION) {
    issues.push(
      `хранилище MIDI: версия ${String(raw.version)} не поддерживается (ожидается ${MIDI_STORAGE_VERSION})`,
    );
    return { mappings: [], issues };
  }

  const rows = Array.isArray(raw.mappings) ? raw.mappings : [];
  if (raw.mappings !== undefined && !Array.isArray(raw.mappings)) {
    issues.push("хранилище MIDI: mappings не массив — строки не прочитаны");
  }
  return { mappings: collectMappings(rows, idFactory, issues, null), issues };
}

/**
 * Прочитать legacy v1 и мигрировать в v2. Канал строки берётся из глобального
 * `channel` (0..16, невалидный → 0). Если запись миграции не удалась, строки
 * всё равно возвращаются в память, а ошибка попадает в issues: старый ключ v1
 * при этом не тронут и будет прочитан в следующий раз.
 */
function readLegacyState(
  storage: MidiStorage,
  namespace: string,
  idFactory: () => string,
  issues: string[],
): StoredMidiState {
  const text = storage.getItem(midiStorageKey(namespace, LEGACY_STORAGE_VERSION));
  if (text === null) return { mappings: [], issues };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    issues.push("хранилище MIDI: некорректный JSON — состояние не прочитано");
    return { mappings: [], issues };
  }
  if (!isRecord(raw)) {
    issues.push("хранилище MIDI: ожидался объект — состояние не прочитано");
    return { mappings: [], issues };
  }
  if (raw.version !== LEGACY_STORAGE_VERSION) {
    issues.push(
      `хранилище MIDI: версия ${String(raw.version)} не поддерживается (ожидается ${LEGACY_STORAGE_VERSION})`,
    );
    return { mappings: [], issues };
  }

  let channel = 0;
  if (raw.channel !== undefined) {
    if (isChannel(raw.channel)) {
      channel = raw.channel;
    } else {
      issues.push("хранилище MIDI: некорректный channel — используется 0");
    }
  }

  const rows = Array.isArray(raw.mappings) ? raw.mappings : [];
  if (raw.mappings !== undefined && !Array.isArray(raw.mappings)) {
    issues.push("хранилище MIDI: mappings не массив — строки не прочитаны");
  }
  const mappings = collectMappings(rows, idFactory, issues, channel);

  try {
    saveMidiState(storage, namespace, { mappings });
  } catch (error) {
    issues.push(
      `хранилище MIDI: не удалось сохранить миграцию v1 → v2 — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { mappings, issues };
}

function collectMappings(
  rows: readonly unknown[],
  idFactory: () => string,
  issues: string[],
  legacyChannel: number | null,
): MidiMapping[] {
  const mappings: MidiMapping[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const mapping = validateMapping(row, idFactory, seen, legacyChannel);
    if (mapping) {
      mappings.push(mapping);
    } else {
      issues.push(`хранилище MIDI: строка ${index} отброшена (невалидна)`);
    }
  });
  return mappings;
}

/**
 * `legacyChannel === null` — схема v2: строка обязана содержать валидный
 * `channel` 0..16. Иначе — legacy v1: глобальный канал копируется в строку.
 */
function validateMapping(
  row: unknown,
  idFactory: () => string,
  seen: Set<string>,
  legacyChannel: number | null,
): MidiMapping | null {
  if (!isRecord(row)) return null;
  if (typeof row.target !== "string" || row.target.length === 0) return null;
  if (typeof row.source !== "string" || !SOURCES.includes(row.source as MidiSource)) return null;
  if (!Number.isInteger(row.number) || (row.number as number) < 0 || (row.number as number) > 127) {
    return null;
  }
  if (legacyChannel === null) {
    if (!isChannel(row.channel)) return null;
  }
  if (typeof row.mode !== "string" || !MODES.includes(row.mode as MidiMode)) return null;
  let id = typeof row.id === "string" && row.id.length > 0 ? row.id : idFactory();
  if (seen.has(id)) id = idFactory();
  seen.add(id);
  const sensitivity =
    Number.isInteger(row.sensitivity) &&
    (row.sensitivity as number) >= 1 &&
    (row.sensitivity as number) <= 100
      ? (row.sensitivity as number)
      : 1;
  return {
    id,
    target: row.target,
    source: row.source as MidiSource,
    number: row.number as number,
    channel: legacyChannel === null ? (row.channel as number) : legacyChannel,
    mode: row.mode as MidiMode,
    sensitivity,
    invert: row.invert === true,
  };
}

/** Сохранить состояние. Ошибки `storage.setItem` пропускаются наружу. */
export function saveMidiState(
  storage: MidiStorage,
  namespace: string,
  state: { mappings: readonly MidiMapping[] },
): void {
  storage.setItem(
    midiStorageKey(namespace),
    JSON.stringify({ version: MIDI_STORAGE_VERSION, mappings: state.mappings }),
  );
}

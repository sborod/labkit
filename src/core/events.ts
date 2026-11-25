import type { Origin } from "./origin.ts";

/** Изменение одного параметра — для per-param подписок. */
export interface ParamChange {
  id: string;
  origin: Origin;
}

/**
 * Пакет изменений с одним commit. Эффекты и глобальная UI-подписка получают
 * один BatchChange на set()/transaction(), а не по одному событию на id.
 */
export interface BatchChange {
  ids: readonly string[];
  origin: Origin;
}

export type ParamChangeListener = (change: ParamChange) => void;
export type BatchChangeListener = (change: BatchChange) => void;

export function sameValue(a: number | boolean | string, b: number | boolean | string): boolean {
  return a === b;
}

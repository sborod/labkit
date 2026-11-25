// Instance resource ownership and error reporting for synchronous setup hooks.
import type { Disposer } from "./scope.ts";

export type LabErrorPhase =
  | "render"
  | "hook"
  | "animation"
  | "action"
  | "control"
  | "cleanup"
  | "setup";

export interface LabErrorEvent {
  lab: string;
  phase: LabErrorPhase;
  error: unknown;
}

export interface Lifetime {
  /** Живая проверка: true после начала dispose экземпляра. */
  readonly disposed: boolean;
  /** Добавить освободитель. После dispose — явная ошибка (см. Scope.add). */
  add(disposer: Disposer): void;
  /** Существующий видимый канал ошибок выполнения экземпляра. */
  reportError(phase: LabErrorPhase, error: unknown): void;
}

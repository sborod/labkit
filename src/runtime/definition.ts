import type { ActionSpec } from "../core/actions.ts";
import type { ParameterSpec } from "../core/params.ts";
import type { RuntimeContext } from "../core/context.ts";
import type { BatchChange } from "../core/events.ts";
import type { LabLayout } from "../ui/layout.ts";
import type { CapabilityId } from "./capabilities.ts";
import type { Lifetime } from "./lifetime.ts";

/** Версия контракта лаборатории. Валидируется при загрузке; старый формат не угадывается. */
export const CONTRACT_VERSION = "0.1" as const;
export type ContractVersion = typeof CONTRACT_VERSION;

export interface ViewContext<S> {
  readonly state: S;
  readonly ctx: CanvasRenderingContext2D;
  /** Логические (CSS) размеры поверхности; вычислительная сетка задаётся view. */
  readonly width: number;
  readonly height: number;
}

export interface ViewSpec<S> {
  render(view: ViewContext<S>): void;
}

/** Явные реакции лаборатории. Ничего не пересчитывается «по умолчанию». */
export interface RuntimeHooks<S> {
  /**
   * Синхронная первичная инициализация per-instance ресурсов (сессия аудио и
   * т.п.) до первой отрисовки. Ошибка здесь — ошибка монтажа: частично
   * созданное освобождается. Возвращаемый тип — строго `undefined`, поэтому
   * `async`-функция несовместима на уровне типов; рантайм дополнительно
   * отклоняет thenable.
   */
  setup?(ctx: RuntimeContext<S>, lifetime: Lifetime): undefined;
  /**
   * Эволюция модели во времени. Шаг может напрямую менять собственное
   * состояние/координаты/массивы; после успешного step рантайм сам запрашивает
   * перерисовку.
   */
  animation?: { step(ctx: RuntimeContext<S>, dt: number): void };
  /**
   * Реакция на commit реестра (управляемый ввод) — один BatchChange на пакет.
   * Прямые изменения модели не вызывают onChange.
   */
  onChange?(ctx: RuntimeContext<S>, change: BatchChange): void;
}

export interface LabCapabilities {
  required?: readonly CapabilityId[];
  optional?: readonly CapabilityId[];
}

/**
 * LabDefinition — декларативное описание, общее для тестов и production
 * страницы. createLab() создаёт отдельное состояние для каждого экземпляра.
 */
export interface LabDefinition<S> {
  contractVersion: ContractVersion;
  id: string;
  title: string;
  subtitle?: string;
  parameters: Record<string, ParameterSpec<S>>;
  actions?: Record<string, ActionSpec<S>>;
  layout: LabLayout;
  readouts?: Record<string, (state: S) => string>;
  views?: Record<string, ViewSpec<S>>;
  model: { createState(): S };
  hooks?: RuntimeHooks<S>;
  capabilities?: LabCapabilities;
}

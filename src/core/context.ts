import type { ActionRegistry } from "./actions.ts";
import type { Origin } from "./origin.ts";
import type { ParameterRegistry } from "./registry.ts";

/** Управление единственным таймлайном экземпляра. */
export interface TimelineControl {
  start(): void;
  stop(): void;
  toggle(): void;
  readonly isRunning: boolean;
}

/**
 * Контекст выполнения, который рантайм передаёт в модель лаборатории
 * (анимация, действия, реакции): доступ к каноническому состоянию, реестрам
 * параметров/действий, таймлайну и запросу перерисовки. Состояние меняет сама
 * модель — напрямую или управляемым вводом через `params`.
 *
 * `actions` и `root` добавлены на этапе 3: `hooks.setup` должен иметь доступ к
 * реестру действий (MIDI адресует параметры И действия) и к уже встроенному DOM
 * (лаборатория вешает в controls-колонку собственный MIDI-пульт). Оба поля —
 * часть экземпляра, не общий singleton.
 */
export interface RuntimeContext<S> {
  readonly state: S;
  readonly params: ParameterRegistry<S>;
  readonly actions: ActionRegistry<S>;
  readonly timeline: TimelineControl;
  /** Корень экземпляра, уже встроенный в контейнер к моменту hooks.setup. */
  readonly root: HTMLElement;
  /** Запросить перерисовку (коалесцируется в один проход на кадр). */
  requestRender(): void;
  log(message: string): void;
}

/**
 * Контекст действия: как RuntimeContext, но с origin и необязательным
 * непрозрачным payload текущего вызова. `input` принадлежит только этому
 * invocation: core не сохраняет его между вызовами.
 */
export interface ActionContext<S> extends RuntimeContext<S> {
  readonly origin: Origin;
  readonly input?: unknown;
}

import type { Origin } from "./origin.ts";
import type { ActionContext, RuntimeContext, TimelineControl } from "./context.ts";

/**
 * Действие — команда без собственного сохраняемого значения. Отделено от
 * параметров: у действия нет диапазона/значения, у параметра нет команды.
 */
export interface ActionSpec<S> {
  id: string;
  label: string | ((state: S, timeline: TimelineControl) => string);
  description?: string;
  available?: (state: S) => boolean;
  run: (ctx: ActionContext<S>) => void | Promise<void>;
}

export class ActionRegistry<S> {
  readonly #actions: ReadonlyMap<string, ActionSpec<S>>;
  readonly #context: () => RuntimeContext<S>;
  readonly #isDisposed: (() => boolean) | undefined;

  constructor(
    context: () => RuntimeContext<S>,
    actions: Record<string, ActionSpec<S>>,
    isDisposed?: () => boolean,
  ) {
    this.#context = context;
    this.#actions = new Map(Object.entries(actions));
    this.#isDisposed = isDisposed;
  }

  has(id: string): boolean {
    return this.#actions.has(id);
  }

  ids(): string[] {
    return [...this.#actions.keys()];
  }

  spec(id: string): ActionSpec<S> {
    const spec = this.#actions.get(id);
    if (!spec) {
      throw new Error(`labkit: неизвестное действие "${id}"`);
    }
    return spec;
  }

  isAvailable(id: string): boolean {
    const spec = this.spec(id);
    return spec.available ? spec.available(this.#context().state) : true;
  }

  label(id: string): string {
    const spec = this.spec(id);
    const ctx = this.#context();
    return typeof spec.label === "function" ? spec.label(ctx.state, ctx.timeline) : spec.label;
  }

  /**
   * Выполнение действия. Недоступное действие — явная ошибка, а не тихий пропуск
   * (защита disabled-контролов со стороны MIDI и других источников).
   *
   * `input` — непрозрачный payload конкретного вызова (например, MIDI-событие).
   * Core его не клонирует, не замораживает и не сохраняет: каждый вызов получает
   * новый контекст, поэтому перекрывающиеся async-вызовы не делят данные, а
   * следующий вызов без `input` не видит предыдущий.
   */
  async execute(id: string, origin: Origin, input?: unknown): Promise<void> {
    if (this.#isDisposed?.()) {
      throw new Error(`labkit: экземпляр освобождён, действие "${id}" не выполняется`);
    }
    const spec = this.spec(id);
    const ctx = this.#context();
    if (spec.available && !spec.available(ctx.state)) {
      throw new Error(`labkit: действие "${id}" недоступно`);
    }
    await spec.run({ ...ctx, origin, input });
  }
}

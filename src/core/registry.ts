import type { Origin } from "./origin.ts";
import {
  sameValue,
  type BatchChange,
  type BatchChangeListener,
  type ParamChange,
  type ParamChangeListener,
} from "./events.ts";
import {
  defaultNumberFormat,
  type EnumOption,
  type ParameterSpec,
  type ParamKind,
} from "./params.ts";

function readValue<S>(spec: ParameterSpec<S>, state: S): number | boolean | string {
  switch (spec.kind) {
    case "number":
      return spec.read(state);
    case "boolean":
      return spec.read(state);
    case "enum":
      return spec.read(state);
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object") return Object.prototype.toString.call(value);
  return String(value);
}

/**
 * Реестр параметров: управляемый путь ввода (ui/preset/api/midi/timeline) к
 * каноническому состоянию. Значения живут в состоянии модели; реестр даёт
 * типизированный доступ к ним, но не является вторым хранилищем и не
 * единственной точкой доступа — модель может читать/писать свои поля напрямую.
 * Никакой строковой кодогенерации и никаких DOM-мостов.
 *
 * Политика:
 *   * типы строгие (никаких Number(null)/Boolean("false"));
 *   * доступность (available) проверяется на общем пути set() для ЛЮБОГО origin
 *     (ui/midi/preset/api/timeline) — скрытого bypass нет;
 *   * сравнивается фактическое значение после setter (а не намерение);
 *   * transaction даёт один BatchChange, изменения не откатываются (batching).
 */
export class ParameterRegistry<S> {
  readonly #state: S;
  readonly #specs: ReadonlyMap<string, ParameterSpec<S>>;
  readonly #batchListeners = new Set<BatchChangeListener>();
  readonly #paramListeners = new Map<string, Set<ParamChangeListener>>();
  #txDepth = 0;
  #txOrigin: Origin = "api";
  #pendingIds: string[] = [];

  constructor(state: S, specs: Record<string, ParameterSpec<S>>) {
    this.#state = state;
    this.#specs = new Map(Object.entries(specs));
  }

  get state(): S {
    return this.#state;
  }

  has(id: string): boolean {
    return this.#specs.has(id);
  }

  ids(): string[] {
    return [...this.#specs.keys()];
  }

  spec(id: string): ParameterSpec<S> {
    const spec = this.#specs.get(id);
    if (!spec) {
      throw new Error(`labkit: неизвестный параметр "${id}"`);
    }
    return spec;
  }

  kind(id: string): ParamKind {
    return this.spec(id).kind;
  }

  get(id: string): number | boolean | string {
    return readValue(this.spec(id), this.#state);
  }

  getNumber(id: string): number {
    const spec = this.spec(id);
    if (spec.kind !== "number") {
      throw new Error(`labkit: параметр "${id}" не является числом`);
    }
    return spec.read(this.#state);
  }

  getBoolean(id: string): boolean {
    const spec = this.spec(id);
    if (spec.kind !== "boolean") {
      throw new Error(`labkit: параметр "${id}" не является boolean`);
    }
    return spec.read(this.#state);
  }

  getEnum(id: string): string {
    const spec = this.spec(id);
    if (spec.kind !== "enum") {
      throw new Error(`labkit: параметр "${id}" не является enum`);
    }
    return spec.read(this.#state);
  }

  isAvailable(id: string): boolean {
    const spec = this.spec(id);
    return spec.available ? spec.available(this.#state) : true;
  }

  isVisible(id: string): boolean {
    const spec = this.spec(id);
    return spec.visible ? spec.visible(this.#state) : true;
  }

  options(id: string): readonly EnumOption[] {
    const spec = this.spec(id);
    if (spec.kind !== "enum") {
      throw new Error(`labkit: параметр "${id}" не является enum`);
    }
    return typeof spec.options === "function" ? spec.options(this.#state) : spec.options;
  }

  /** Отформатированное значение для отображения. */
  format(id: string): string {
    const spec = this.spec(id);
    switch (spec.kind) {
      case "number":
        return (spec.format ?? defaultNumberFormat)(spec.read(this.#state));
      case "boolean":
        return spec.read(this.#state) ? "вкл" : "выкл";
      case "enum": {
        const value = spec.read(this.#state);
        const option = this.options(id).find((o) => o.value === value);
        return option ? option.label : value;
      }
    }
  }

  /**
   * Запись значения. Число ограничивается диапазоном; enum валидируется списком;
   * типы строгие. Недоступный параметр — явная ошибка. Событие не порождается,
   * если фактическое сохранённое значение не изменилось.
   */
  set(id: string, value: unknown, origin: Origin = "api"): void {
    const spec = this.spec(id);
    if (spec.available && !spec.available(this.#state)) {
      throw new Error(`labkit: параметр "${id}" недоступен`);
    }
    const previous = readValue(spec, this.#state);
    switch (spec.kind) {
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(
            `labkit: параметр "${id}" ожидает конечное число, получено ${describeValue(value)}`,
          );
        }
        spec.write(this.#state, Math.min(spec.max, Math.max(spec.min, value)));
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          throw new Error(
            `labkit: параметр "${id}" ожидает boolean, получено ${describeValue(value)}`,
          );
        }
        spec.write(this.#state, value);
        break;
      }
      case "enum": {
        if (typeof value !== "string") {
          throw new Error(
            `labkit: параметр "${id}" ожидает строку enum, получено ${describeValue(value)}`,
          );
        }
        const options = this.options(id);
        if (!options.some((o) => o.value === value)) {
          throw new Error(
            `labkit: параметр "${id}" ожидает одно из [${options
              .map((o) => o.value)
              .join(", ")}], получено "${value}"`,
          );
        }
        spec.write(this.#state, value);
        break;
      }
    }
    const actual = readValue(spec, this.#state);
    if (sameValue(previous, actual)) {
      return;
    }
    if (this.#txDepth > 0) {
      this.#addPending(id);
      return;
    }
    this.#deliver([id], origin);
  }

  /**
   * Пакетная запись: один BatchChange и по одному ParamChange на id после
   * завершения. Это batching, а не rollback: если callback бросил, уже
   * применённые изменения доставляются (flush в finally), затем ошибка
   * пробрасывается дальше. Иначе UI/модель разошлись бы.
   */
  transaction(origin: Origin, fn: () => void): void {
    if (this.#txDepth === 0) {
      this.#txOrigin = origin;
      this.#pendingIds = [];
    }
    this.#txDepth++;
    let failed = false;
    let failure: unknown;
    let flushFailed = false;
    let flushFailure: unknown;
    try {
      fn();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.#txDepth--;
      if (this.#txDepth === 0) {
        const ids = this.#pendingIds;
        this.#pendingIds = [];
        if (ids.length > 0) {
          try {
            this.#deliver(ids, this.#txOrigin);
          } catch (error) {
            flushFailed = true;
            flushFailure = error;
          }
        }
      }
    }
    if (failed && flushFailed) {
      // Preserve the callback failure as the cause and first error in AggregateError.
      const errors: unknown[] = [failure];
      if (flushFailure instanceof AggregateError) {
        errors.push(...flushFailure.errors);
      } else {
        errors.push(flushFailure);
      }
      throw new AggregateError(errors, "labkit: ошибка транзакции и ошибки подписчиков", {
        cause: failure,
      });
    }
    if (failed) {
      throw failure;
    }
    if (flushFailed) {
      throw flushFailure;
    }
  }

  subscribe(listener: BatchChangeListener): () => void {
    this.#batchListeners.add(listener);
    return () => {
      this.#batchListeners.delete(listener);
    };
  }

  subscribeParam(id: string, listener: ParamChangeListener): () => void {
    let set = this.#paramListeners.get(id);
    if (!set) {
      set = new Set();
      this.#paramListeners.set(id, set);
    }
    const target = set;
    target.add(listener);
    return () => {
      target.delete(listener);
      if (target.size === 0) {
        this.#paramListeners.delete(id);
      }
    };
  }

  #addPending(id: string): void {
    if (!this.#pendingIds.includes(id)) {
      this.#pendingIds.push(id);
    }
  }

  #deliver(ids: readonly string[], origin: Origin): void {
    // Доставляем всем снимкам слушателей, собирая ошибки; сообщаем после того,
    // как все уведомлены, чтобы один бросивший подписчик не отменял остальных.
    const errors: unknown[] = [];
    for (const id of ids) {
      const listeners = this.#paramListeners.get(id);
      if (!listeners) continue;
      const change: ParamChange = { id, origin };
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    const batch: BatchChange = { ids: [...ids], origin };
    for (const listener of [...this.#batchListeners]) {
      try {
        listener(batch);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `labkit: ошибки подписчиков при доставке изменений (${errors.length})`,
      );
    }
  }
}

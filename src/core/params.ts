// Parameter specs bind to canonical model state; the registry stores no second value.

export type ParamKind = "number" | "boolean" | "enum";

export interface EnumOption {
  value: string;
  label: string;
}

export interface BaseParamSpec<S> {
  /** Стабильный id; используется UI, MIDI и пресетами как единственный адрес. */
  id: string;
  label: string;
  group?: string;
  description?: string;
  /** Динамическая доступность (например, зависит от другого параметра). */
  available?: (state: S) => boolean;
  /** Динамическая видимость; не влияет на доступность. */
  visible?: (state: S) => boolean;
  /**
   * UI-only стабильная примитивная идентичность текущего адресата read/write
   * (например, индекс выбранной точки). Смена ключа отменяет незавершённые
   * числовой draft и drag, не перенося их на нового адресата. Реестр, MIDI и
   * API этот ключ не используют.
   */
  bindingKey?: (state: S) => string | number;
}

export interface NumberParamSpec<S> extends BaseParamSpec<S> {
  kind: "number";
  min: number;
  max: number;
  /** Положительный шаг или "any" (без квантования ручного ввода). */
  step: number | "any";
  unit?: string;
  /** Форматирование для отображения (включая символ, например `v = 1.20`). */
  format?: (value: number) => string;
  read: (state: S) => number;
  write: (state: S, value: number) => void;
}

export interface BooleanParamSpec<S> extends BaseParamSpec<S> {
  kind: "boolean";
  read: (state: S) => boolean;
  write: (state: S, value: boolean) => void;
}

export interface EnumParamSpec<S> extends BaseParamSpec<S> {
  kind: "enum";
  options: readonly EnumOption[] | ((state: S) => readonly EnumOption[]);
  read: (state: S) => string;
  write: (state: S, value: string) => void;
}

export type ParameterSpec<S> = NumberParamSpec<S> | BooleanParamSpec<S> | EnumParamSpec<S>;

export function defaultNumberFormat(value: number): string {
  return value.toFixed(2);
}

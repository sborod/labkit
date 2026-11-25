import type {
  BooleanParamSpec,
  EnumParamSpec,
  NumberParamSpec,
  ParameterSpec,
} from "../core/params.ts";
import type { ParameterRegistry } from "../core/registry.ts";
import type { Origin } from "../core/origin.ts";
import { createKnob } from "./knob.ts";

export interface ControlErrorContext {
  op: "write" | "update";
}

export interface ControlOptions {
  presentation?: "segmented" | "pad";
  displayLabel?: string;
  /**
   * Канал ошибок контрола: запись параметра из UI и обновление из подписки.
   * Runtime подключает его к своему видимому каналу ошибок.
   */
  onError?: (error: unknown, context: ControlErrorContext) => void;
}

export interface ControlHandle {
  readonly el: HTMLElement;
  /** Синхронизировать DOM с каноническим состоянием реестра. */
  update(): void;
  dispose(): void;
}

interface ControlBody {
  update(): void;
  dispose(): void;
}

/** Попытка вернуть DOM к каноническому состоянию после неудачной записи. */
function restoreThenReport(sync: () => void, error: unknown, options: ControlOptions): void {
  let restoreError: unknown;
  let restoreFailed = false;
  try {
    sync();
  } catch (syncError) {
    restoreFailed = true;
    restoreError = syncError;
  }
  options.onError?.(error, { op: "write" });
  if (restoreFailed) {
    options.onError?.(restoreError, { op: "update" });
  }
}

function bindUpdates<S>(
  registry: ParameterRegistry<S>,
  el: HTMLElement,
  body: ControlBody,
  options: ControlOptions,
): ControlHandle {
  // Контролы синхронизируются с реестром (DOM не хранит состояние). Любое
  // изменение параметра может повлиять на доступность/видимость/опции других
  // контролов, поэтому подписка общая.
  //
  // Ошибка обновления из подписки уходит в канал ошибок контрола и НЕ
  // превращается в ошибку доставки реестра (это ошибка конкретного контрола;
  // ошибки других слушателей по-прежнему видны через AggregateError реестра).
  const unsubscribe = registry.subscribe(() => {
    try {
      body.update();
    } catch (error) {
      options.onError?.(error, { op: "update" });
    }
  });
  try {
    body.update();
  } catch (updateError) {
    // Инициализация упала — контрол не должен остаться подписанным/с живыми
    // слушателями. Чистим и пробрасываем (для createLab это ошибка монтирования);
    // если и очистка упала, объединяем.
    let cleanupError: unknown;
    let cleanupFailed = false;
    try {
      unsubscribe();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
    try {
      body.dispose();
    } catch (error) {
      if (cleanupFailed) {
        cleanupError = new AggregateError([cleanupError, error], "labkit: ошибки очистки контрола");
      } else {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
    if (cleanupFailed) {
      throw new AggregateError(
        [updateError, cleanupError],
        "labkit: ошибка инициализации контрола и его очистки",
        { cause: updateError },
      );
    }
    throw updateError;
  }
  return {
    el,
    update: body.update,
    dispose: () => {
      unsubscribe();
      body.dispose();
    },
  };
}

function createNumberControl<S>(
  spec: NumberParamSpec<S>,
  registry: ParameterRegistry<S>,
  origin: Origin,
  options: ControlOptions,
): ControlHandle {
  const field = document.createElement("div");
  field.className = "labkit-field labkit-control";
  const bindingKey = spec.bindingKey;
  const knob = createKnob(
    spec,
    () => spec.read(registry.state),
    (value) => {
      try {
        registry.set(spec.id, value, origin);
      } catch (error) {
        restoreThenReport(sync, error, options);
      }
    },
    bindingKey ? () => bindingKey(registry.state) : undefined,
  );
  if (options.displayLabel) knob.el.querySelector("label")!.textContent = options.displayLabel;
  const accessory = document.createElement("span");
  accessory.className = "labkit-control-accessory";
  accessory.dataset.labkitParamAccessory = spec.id;
  accessory.hidden = true;
  field.append(knob.el, accessory);

  const sync = (): void => {
    const available = spec.available ? spec.available(registry.state) : true;
    field.classList.toggle("is-disabled", !available);
    field.hidden = spec.visible ? !spec.visible(registry.state) : false;
    knob.update(available, !field.hidden);
  };

  return bindUpdates(registry, field, { update: sync, dispose: knob.dispose }, options);
}

function createBooleanControl<S>(
  spec: BooleanParamSpec<S>,
  registry: ParameterRegistry<S>,
  origin: Origin,
  options: ControlOptions,
): ControlHandle {
  // Неинтерактивная обёртка; checkbox в label, MIDI accessory — отдельно.
  const field = document.createElement("div");
  field.className = "labkit-check labkit-control";
  if (options.presentation === "pad") field.classList.add("labkit-pad");
  const main = document.createElement("label");
  main.className = "labkit-control-main";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.param = spec.id;
  input.setAttribute("aria-label", spec.label);
  const text = document.createElement("span");
  text.textContent = options.displayLabel ?? spec.label;
  main.append(input, text);
  const accessory = document.createElement("span");
  accessory.className = "labkit-control-accessory";
  accessory.dataset.labkitParamAccessory = spec.id;
  accessory.hidden = true;
  field.append(main, accessory);

  const sync = (): void => {
    input.checked = spec.read(registry.state);
    const available = spec.available ? spec.available(registry.state) : true;
    input.disabled = !available;
    field.hidden = spec.visible ? !spec.visible(registry.state) : false;
  };
  const onChange = (): void => {
    try {
      registry.set(spec.id, input.checked, origin);
    } catch (error) {
      restoreThenReport(sync, error, options);
    }
  };
  input.addEventListener("change", onChange);

  return bindUpdates(
    registry,
    field,
    { update: sync, dispose: () => input.removeEventListener("change", onChange) },
    options,
  );
}

function createEnumControl<S>(
  spec: EnumParamSpec<S>,
  registry: ParameterRegistry<S>,
  origin: Origin,
  options: ControlOptions,
): ControlHandle {
  if (options.presentation === "segmented")
    return createSegmentedControl(spec, registry, origin, options);
  const field = document.createElement("label");
  field.className = "labkit-field";
  const label = document.createElement("span");
  label.className = "labkit-field-label";
  label.textContent = options.displayLabel ?? spec.label;
  const select = document.createElement("select");
  select.dataset.param = spec.id;
  select.setAttribute("aria-label", spec.label);
  field.append(label, select);

  const sync = (): void => {
    const opts = typeof spec.options === "function" ? spec.options(registry.state) : spec.options;
    const signature = opts.map((o) => `${o.value}\u0000${o.label}`).join("\u0001");
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.replaceChildren(
        ...opts.map((option) => {
          const el = document.createElement("option");
          el.value = option.value;
          el.textContent = option.label;
          return el;
        }),
      );
    }
    const current = spec.read(registry.state);
    if (select.value !== current) {
      select.value = current;
    }
    const available = spec.available ? spec.available(registry.state) : true;
    select.disabled = !available;
    field.hidden = spec.visible ? !spec.visible(registry.state) : false;
  };
  const onChange = (): void => {
    try {
      registry.set(spec.id, select.value, origin);
    } catch (error) {
      restoreThenReport(sync, error, options);
    }
  };
  select.addEventListener("change", onChange);

  return bindUpdates(
    registry,
    field,
    { update: sync, dispose: () => select.removeEventListener("change", onChange) },
    options,
  );
}

function createSegmentedControl<S>(
  spec: EnumParamSpec<S>,
  registry: ParameterRegistry<S>,
  origin: Origin,
  options: ControlOptions,
): ControlHandle {
  const field = document.createElement("div");
  field.className = "labkit-field labkit-segmented";
  const label = document.createElement("span");
  label.className = "labkit-field-label";
  label.textContent = options.displayLabel ?? spec.label;
  const group = document.createElement("div");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", spec.label);
  field.append(label, group);
  let signature = "";
  const sync = (): void => {
    const opts = typeof spec.options === "function" ? spec.options(registry.state) : spec.options;
    const next = JSON.stringify(opts);
    if (signature !== next) {
      signature = next;
      group.replaceChildren(
        ...opts.map((option) => {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.value = option.value;
          button.dataset.param = spec.id;
          button.textContent = option.label;
          return button;
        }),
      );
    }
    for (const button of group.querySelectorAll("button")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.value === spec.read(registry.state)),
      );
      button.disabled = spec.available ? !spec.available(registry.state) : false;
    }
    field.hidden = spec.visible ? !spec.visible(registry.state) : false;
  };
  const click = (event: Event): void => {
    const target = event.target as HTMLElement;
    const value = target.closest("button")?.dataset.value;
    if (value === undefined) return;
    try {
      registry.set(spec.id, value, origin);
    } catch (error) {
      restoreThenReport(sync, error, options);
    }
  };
  group.addEventListener("click", click);
  return bindUpdates(
    registry,
    field,
    { update: sync, dispose: () => group.removeEventListener("click", click) },
    options,
  );
}

/** Создать контрол по спецификации параметра. origin по умолчанию — "ui". */
export function createControl<S>(
  spec: ParameterSpec<S>,
  registry: ParameterRegistry<S>,
  origin: Origin = "ui",
  options: ControlOptions = {},
): ControlHandle {
  switch (spec.kind) {
    case "number":
      return createNumberControl(spec, registry, origin, options);
    case "boolean":
      return createBooleanControl(spec, registry, origin, options);
    case "enum":
      return createEnumControl(spec, registry, origin, options);
  }
}

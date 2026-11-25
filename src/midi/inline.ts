// Inline-обучение MIDI: компактная кнопка рядом с каждым поддерживаемым
// параметром/действием вместо отдельного списка-дубля в панели.
//
// Binder НЕ владеет адаптером и не меняет его состояние (`training`/`learning`):
// он только отражает `training`/`learningTarget`/`learningMappingId`/summary и
// делегирует клик в `adapter.startLearn(targetId)` — это inline-обучение (первое
// назначение цели); строчное обучение остаётся в панели и адресует mapping.id.
//
// Слоты (`[data-labkit-param-accessory]` / `[data-labkit-action-accessory]`)
// находятся ОДИН раз: layout строится до hooks.setup и не пересобирается.
// Кнопка на слот стабильна и не пересоздаётся при refresh. Повторные цели в
// layout дают независимые кнопки. Появление/исчезновение назначений, смена
// обучения и метки целей подхватываются подпиской на адаптер.
import type { MidiAdapter } from "./adapter.ts";

export interface MidiLearnBinderOptions {
  root: HTMLElement;
  adapter: MidiAdapter;
}

export interface MidiLearnBinder {
  refresh(): void;
  dispose(): void;
}

interface LearnSlot {
  host: HTMLElement;
  targetId: string;
  button: HTMLButtonElement;
  onClick: () => void;
}

/**
 * Привязать inline-обучение к слотам внутри `root`. Возвращает идемпотентный
 * `dispose` (снимает подписку/обработчики, убирает созданные кнопки и снова
 * скрывает слоты; адаптер и его состояние не трогает).
 */
export function bindMidiLearn(options: MidiLearnBinderOptions): MidiLearnBinder {
  const { root, adapter } = options;
  const doc = root.ownerDocument;

  // Слоты обоих видов ищем один раз. data-атрибут несёт id цели; сверяем с
  // текущими целями адаптера (number/boolean/action), чтобы не завести кнопку
  // для неадресуемой цели (enum слот не получает).
  const hosts = [
    ...root.querySelectorAll<HTMLElement>("[data-labkit-param-accessory]"),
    ...root.querySelectorAll<HTMLElement>("[data-labkit-action-accessory]"),
  ];
  const addressable = new Set(adapter.targets().map((target) => target.id));

  const slots: LearnSlot[] = [];
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  const refresh = (): void => {
    if (disposed) return;
    const targets = new Map(adapter.targets().map((target) => [target.id, target]));
    const training = adapter.training;
    const mappings = adapter.mappings();
    for (const slot of slots) {
      const target = targets.get(slot.targetId);
      if (!target) {
        // Цель исчезла из реестра: кнопка не имеет смысла.
        slot.host.hidden = true;
        continue;
      }
      slot.host.hidden = !training;
      if (!training) continue;

      const waiting =
        adapter.learningTarget === slot.targetId && adapter.learningMappingId === null;
      const hasMapping = mappings.some((mapping) => mapping.target === slot.targetId);
      const summary = adapter.targetSummary(slot.targetId);
      const description = mappings
        .filter((mapping) => mapping.target === slot.targetId)
        .map(
          (mapping) =>
            `${mapping.source === "cc" ? "CC" : "Note"} ${mapping.number} · ch ${mapping.channel || "any"} · ${mapping.mode} · sensitivity ${mapping.sensitivity}${mapping.invert ? " · invert" : ""}`,
        )
        .join("; ");
      slot.button.textContent = waiting ? "Жду MIDI…" : summary;
      slot.button.setAttribute("aria-pressed", String(waiting));
      slot.button.dataset.state = waiting ? "waiting" : hasMapping ? "assigned" : "idle";
      slot.button.setAttribute(
        "aria-label",
        `${target.label}: ${
          waiting
            ? "ждёт MIDI, нажми для отмены"
            : hasMapping
              ? `назначено ${description}, нажми для переобучения`
              : "обучить MIDI"
        }`,
      );
      slot.button.title = waiting
        ? "Отменить обучение"
        : hasMapping
          ? `${target.label}: ${description} · Переобучить первое назначение цели`
          : "Обучить MIDI";
    }
  };

  try {
    for (const host of hosts) {
      const targetId =
        host.dataset.labkitParamAccessory ?? host.dataset.labkitActionAccessory ?? "";
      if (!targetId || !addressable.has(targetId)) {
        host.hidden = true;
        continue;
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "labkit-midi-learn";
      button.dataset.target = targetId;
      const onClick = (): void => {
        // Ссылка на кнопку, сохранённая до dispose, не должна обучать: проверка
        // флага + снятый обработчик.
        if (disposed) return;
        adapter.startLearn(targetId);
      };
      button.addEventListener("click", onClick);
      host.append(button);
      slots.push({ host, targetId, button, onClick });
    }
    if (slots.length > 0) {
      unsubscribe = adapter.subscribe(refresh);
      refresh();
    }
  } catch (error) {
    // Rollback начального построения/первого refresh: не оставляем ни кнопок,
    // ни подписки.
    for (const slot of slots) {
      slot.button.removeEventListener("click", slot.onClick);
      slot.button.remove();
      slot.host.hidden = true;
    }
    slots.length = 0;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    throw error;
  }

  return {
    refresh,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      for (const slot of slots) {
        slot.button.removeEventListener("click", slot.onClick);
        slot.button.remove();
        slot.host.hidden = true;
      }
      slots.length = 0;
    },
  };
}

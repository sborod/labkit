// Register each resource immediately; LIFO disposal also handles partial setup failures.
import type { RuntimeContext } from "../core/context.ts";
import type { Lifetime } from "../runtime/lifetime.ts";
import { MidiAdapter, type MidiAdapterOptions } from "./adapter.ts";
import { bindMidiLearn } from "./inline.ts";
import { createMidiPanel, type MidiPanelHandle } from "./panel.ts";
import { mountMidiWindow } from "./window.ts";

/** Готовые ресурсы MIDI-пульта: сессия адаптера и смонтированная панель. */
export interface AttachedMidi {
  midi: MidiAdapter;
  midiPanel: MidiPanelHandle;
}

/**
 * Создать адаптер и панель MIDI, зарегистрировать их освобождение и повесить
 * немодальное окно настроек экземпляра и кнопки в header (fallback: ctx.root).
 *
 * `environment`/`storage`/`defaultModes`/`inputMode` — узкие seam'ы тестов:
 * в production передаётся `realMidiEnvironment` (storage опущен → localStorage),
 * relative-режимы остаются решением лаборатории, а `inputMode: "all"` включает
 * прослушивание всех входов без клика в панели.
 */
export function attachMidi<S>(
  ctx: RuntimeContext<S>,
  lifetime: Lifetime,
  options: Pick<
    MidiAdapterOptions,
    "namespace" | "environment" | "storage" | "defaultModes" | "inputMode"
  >,
): AttachedMidi {
  const midi = new MidiAdapter({
    namespace: options.namespace,
    params: ctx.params,
    actions: ctx.actions,
    environment: options.environment,
    storage: options.storage,
    defaultModes: options.defaultModes,
    inputMode: options.inputMode,
    lifetime,
    onError: (error) => lifetime.reportError("hook", error),
    onChange: () => ctx.requestRender(),
  });
  // Освобождение регистрируется сразу: панель и вставка в DOM ниже могут упасть.
  lifetime.add(() => midi.dispose());

  const midiPanel = createMidiPanel({ adapter: midi, document: ctx.root.ownerDocument });
  lifetime.add(() => midiPanel.dispose());

  lifetime.add(mountMidiWindow(ctx.root, midi, midiPanel));

  // Слоты inline-обучения уже построены в layout ДО hooks.setup. Binder
  // регистрируется последним, поэтому LIFO Scope освобождает его первым:
  // кнопки/подписка убираются до панели и адаптера. Раздельные освободители:
  // падение одного не мешает остальным.
  const inlineLearn = bindMidiLearn({ root: ctx.root, adapter: midi });
  lifetime.add(() => inlineLearn.dispose());

  return { midi, midiPanel };
}

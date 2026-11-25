// Общий MIDI-пульт LabKit. Строит DOM из состояния адаптера; адресует реестр
// через адаптер (не через DOM-события). Один и тот же компонент используется
// production страницей и browser fixtures.
import type { MidiAdapter, MidiTargetInfo } from "./adapter.ts";
import { MIDI_MODE_LABELS, MIDI_MODE_ORDER } from "./labels.ts";
import type { MidiMapping, MidiMode } from "./types.ts";

export interface MidiPanelOptions {
  adapter: MidiAdapter;
  document?: Document;
  title?: string;
}

export interface MidiPanelHandle {
  readonly el: HTMLElement;
  refresh(): void;
  dispose(): void;
}

/** Значение пункта «Все входы» в select; не может совпасть с id устройства. */
const ALL_INPUTS_VALUE = "__labkit_all_inputs__";

function option(doc: Document, value: string, label: string): HTMLOptionElement {
  const el = doc.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}

export function createMidiPanel(options: MidiPanelOptions): MidiPanelHandle {
  const { adapter } = options;
  const doc = options.document ?? globalThis.document;
  if (!doc) throw new Error("labkit: createMidiPanel требует document");

  const root = doc.createElement("fieldset");
  root.className = "labkit-midi";
  const legend = doc.createElement("legend");
  legend.textContent = options.title ?? "MIDI — управление параметрами";
  root.append(legend);

  const connectRow = doc.createElement("div");
  connectRow.className = "labkit-midi-row";
  const connectButton = doc.createElement("button");
  connectButton.type = "button";
  connectButton.className = "labkit-btn labkit-btn--primary";
  connectButton.textContent = "Подключить MIDI";
  connectRow.append(connectButton);

  const statusLine = doc.createElement("div");
  statusLine.className = "labkit-midi-status";
  statusLine.setAttribute("role", "status");

  const deviceRow = doc.createElement("div");
  deviceRow.className = "labkit-midi-row";
  const deviceLabel = doc.createElement("label");
  deviceLabel.textContent = "Входы MIDI";
  const deviceSelect = doc.createElement("select");
  deviceLabel.append(deviceSelect);
  deviceRow.append(deviceLabel);

  const learnLine = doc.createElement("div");
  learnLine.className = "labkit-midi-status";
  learnLine.setAttribute("role", "status");
  const monitorLine = doc.createElement("div");
  monitorLine.className = "labkit-midi-monitor";
  const monitor = doc.createElement("details");
  const monitorSummary = doc.createElement("summary");
  monitorSummary.textContent = "Монитор сообщений";
  monitor.append(monitorSummary, monitorLine);

  const mappings = doc.createElement("div");
  mappings.className = "labkit-midi-mappings";
  const addButton = doc.createElement("button");
  addButton.type = "button";
  addButton.className = "labkit-btn";
  addButton.textContent = "+ Добавить назначение";
  const summaryLine = doc.createElement("div");
  summaryLine.className = "labkit-midi-summary";

  root.append(
    connectRow,
    statusLine,
    deviceRow,
    learnLine,
    mappings,
    addButton,
    monitor,
    summaryLine,
  );

  const rows = new Map<
    string,
    { el: HTMLElement; update(mapping: MidiMapping, map: Map<string, MidiTargetInfo>): void }
  >();
  let deviceSignature: string | undefined;
  const targets = () => adapter.targets();
  const targetMap = (): Map<string, MidiTargetInfo> => {
    const map = new Map<string, MidiTargetInfo>();
    for (const target of targets()) map.set(target.id, target);
    return map;
  };

  function mappingRow(mapping: MidiMapping, map: Map<string, MidiTargetInfo>) {
    const row = doc.createElement("div");
    row.className = "labkit-midi-mapping";
    const heading = doc.createElement("div");
    heading.className = "labkit-midi-mapping-heading";
    const summary = doc.createElement("span");
    const details = doc.createElement("details");
    const disclosure = doc.createElement("summary");
    disclosure.textContent = "Настроить";
    details.append(disclosure);

    const targetLabel = doc.createElement("label");
    targetLabel.textContent = "Параметр / действие";
    const targetSelect = doc.createElement("select");
    targetSelect.append(option(doc, "", "Выбери цель"));
    for (const target of map.values()) targetSelect.append(option(doc, target.id, target.label));
    targetSelect.value = mapping.target;
    targetSelect.addEventListener("change", () => {
      // Смена цели — удаление старой строки и создание новой (id не сохраняем).
      if (!targetSelect.value) {
        targetSelect.value = mapping.target;
        return;
      }
      const hadFocus = doc.activeElement === targetSelect;
      const next = adapter.addMapping({ ...mapping, target: targetSelect.value });
      if (next) {
        const replacement = rows.get(next.id);
        const nextDetails = replacement?.el.querySelector("details");
        if (nextDetails) nextDetails.open = details.open;
        adapter.removeMapping(mapping.id);
        if (hadFocus) replacement?.el.querySelector("select")?.focus();
      }
    });
    targetLabel.append(targetSelect);

    const controls = doc.createElement("div");
    controls.className = "labkit-midi-row";
    const sourceLabel = doc.createElement("label");
    sourceLabel.textContent = "Источник";
    const sourceSelect = doc.createElement("select");
    sourceSelect.append(option(doc, "cc", "CC — регулятор"), option(doc, "note", "Note — нажатие"));
    sourceSelect.value = mapping.source;
    sourceSelect.addEventListener("change", () =>
      adapter.updateMapping(mapping.id, { source: sourceSelect.value as "cc" | "note" }),
    );
    sourceLabel.append(sourceSelect);
    const numberLabel = doc.createElement("label");
    numberLabel.textContent = "Номер (0–127)";
    const numberInput = doc.createElement("input");
    numberInput.type = "number";
    numberInput.min = "0";
    numberInput.max = "127";
    numberInput.step = "1";
    numberInput.value = String(mapping.number);
    numberInput.addEventListener("change", () => {
      const value = Number(numberInput.value);
      if (Number.isInteger(value)) adapter.updateMapping(mapping.id, { number: value });
    });
    numberLabel.append(numberInput);
    // Канал принадлежит строке: 0 — «Любой», 1..16 — конкретный. Одинаковые
    // CC/Note на разных каналах управляют разными параметрами.
    const channelLabel = doc.createElement("label");
    channelLabel.textContent = "Канал";
    const channelSelect = doc.createElement("select");
    channelSelect.append(option(doc, "0", "Любой"));
    for (let ch = 1; ch <= 16; ch++) channelSelect.append(option(doc, String(ch), String(ch)));
    channelSelect.value = String(mapping.channel);
    channelSelect.addEventListener("change", () =>
      adapter.updateMapping(mapping.id, { channel: Number(channelSelect.value) }),
    );
    channelLabel.append(channelSelect);
    controls.append(sourceLabel, channelLabel, numberLabel);

    const tuning = doc.createElement("div");
    tuning.className = "labkit-midi-row";
    const modeLabel = doc.createElement("label");
    modeLabel.textContent = "Режим CC";
    const modeSelect = doc.createElement("select");
    for (const mode of MIDI_MODE_ORDER)
      modeSelect.append(option(doc, mode, MIDI_MODE_LABELS[mode]));
    modeSelect.value = mapping.mode;
    modeSelect.addEventListener("change", () =>
      adapter.updateMapping(mapping.id, { mode: modeSelect.value as MidiMode }),
    );
    modeLabel.append(modeSelect);
    const sensitivityLabel = doc.createElement("label");
    sensitivityLabel.textContent = "Чувствительность (× шаг)";
    const sensitivityInput = doc.createElement("input");
    sensitivityInput.type = "number";
    sensitivityInput.min = "1";
    sensitivityInput.max = "100";
    sensitivityInput.step = "1";
    sensitivityInput.value = String(mapping.sensitivity);
    sensitivityInput.addEventListener("change", () => {
      const value = Number(sensitivityInput.value);
      if (Number.isInteger(value)) adapter.updateMapping(mapping.id, { sensitivity: value });
    });
    sensitivityLabel.append(sensitivityInput);
    const invertLabel = doc.createElement("label");
    invertLabel.className = "labkit-check";
    const invertInput = doc.createElement("input");
    invertInput.type = "checkbox";
    invertInput.checked = mapping.invert;
    invertInput.addEventListener("change", () =>
      adapter.updateMapping(mapping.id, { invert: invertInput.checked }),
    );
    invertLabel.append(invertInput, doc.createTextNode("Обратное вращение"));
    tuning.append(modeLabel, sensitivityLabel, invertLabel);

    const buttons = doc.createElement("div");
    buttons.className = "labkit-midi-row";
    const learnButton = doc.createElement("button");
    learnButton.type = "button";
    learnButton.className = "labkit-btn";
    const waiting = adapter.learningMappingId === mapping.id;
    learnButton.textContent = waiting ? "Жду MIDI · отменить" : "Обучить";
    learnButton.setAttribute("aria-pressed", String(waiting));
    // Строчное обучение адресует ИМЕННО эту строку, а не первое назначение цели.
    learnButton.addEventListener("click", () => adapter.startLearn(mapping.target, mapping.id));
    const removeButton = doc.createElement("button");
    removeButton.type = "button";
    removeButton.className = "labkit-btn";
    removeButton.textContent = "Удалить";
    removeButton.addEventListener("click", () => adapter.removeMapping(mapping.id));
    buttons.append(removeButton);
    heading.append(summary, learnButton);
    details.append(targetLabel, controls, tuning, buttons);
    row.append(heading, details);
    // Only reconcile changed values. Focused inputs retain their uncommitted draft
    // even if another row learns or an unrelated MIDI message arrives.
    const sync = (el: HTMLInputElement | HTMLSelectElement, value: string): void => {
      if (doc.activeElement !== el && el.value !== value) el.value = value;
    };
    return {
      el: row,
      update(next: MidiMapping, targets: Map<string, MidiTargetInfo>): void {
        mapping = next;
        const isNumber = targets.get(mapping.target)?.kind === "number";
        const relative = isNumber && mapping.source === "cc" && mapping.mode !== "absolute";
        summary.textContent = `${targets.get(mapping.target)?.label ?? mapping.target} · ${mapping.source === "cc" ? "CC" : "Note"} ${mapping.number} · канал ${mapping.channel || "любой"}`;
        const available = new Set(["", ...targets.keys()]);
        for (const item of [...targetSelect.options]) if (!available.has(item.value)) item.remove();
        for (const target of targets.values()) {
          const item = [...targetSelect.options].find((item) => item.value === target.id);
          if (item) item.textContent = target.label;
          else targetSelect.append(option(doc, target.id, target.label));
        }
        sync(targetSelect, mapping.target);
        sync(sourceSelect, mapping.source);
        sync(numberInput, String(mapping.number));
        sync(channelSelect, String(mapping.channel));
        sync(modeSelect, mapping.mode);
        sync(sensitivityInput, String(mapping.sensitivity));
        if (doc.activeElement !== invertInput) invertInput.checked = mapping.invert;
        modeSelect.disabled = !isNumber || mapping.source !== "cc";
        sensitivityInput.disabled = !relative;
        invertInput.disabled = !relative;
        const waiting = adapter.learningMappingId === mapping.id;
        learnButton.textContent = waiting ? "Жду MIDI · отменить" : "Обучить";
        learnButton.setAttribute("aria-pressed", String(waiting));
      },
    };
  }

  function refresh(): void {
    const map = targetMap();
    const listening = adapter.listeningInputIds().length > 0;
    connectButton.textContent = listening ? "Обновить MIDI" : "Подключить MIDI";
    statusLine.textContent = [adapter.status.message, adapter.persistenceWarning]
      .filter(Boolean)
      .join(" · ");
    statusLine.dataset.kind = adapter.status.kind;
    learnLine.textContent = adapter.learnMessage;
    const last = adapter.lastMessage;
    const messageText = last
      ? `Канал ${last.channel} · ${
          last.source === "cc" ? "CC" : last.on ? "Note On" : "Note Off"
        } ${last.number} · ${last.source === "cc" ? "значение" : "velocity"} ${last.value}`
      : listening
        ? "Сообщений пока нет."
        : "";
    monitorLine.textContent = adapter.detail ? `${messageText} · ${adapter.detail}` : messageText;
    addButton.disabled = adapter.targets().length === 0;

    const devices = adapter.devices();
    const deviceSig = devices.map((d) => `${d.id}\u0000${d.name}`).join("\u0001");
    if (deviceSig !== deviceSignature) {
      deviceSignature = deviceSig;
      deviceSelect.replaceChildren();
      if (devices.length === 0) {
        deviceSelect.append(option(doc, "", "Нет устройств"));
      } else {
        deviceSelect.append(option(doc, "", "Выбери вход"));
        deviceSelect.append(option(doc, ALL_INPUTS_VALUE, "Все входы"));
        for (const device of devices)
          deviceSelect.append(option(doc, device.id, device.name || "MIDI вход"));
      }
    }
    deviceSelect.value = adapter.allInputs ? ALL_INPUTS_VALUE : adapter.inputId;
    deviceSelect.disabled = devices.length === 0;

    const ids = new Set(adapter.mappings().map((mapping) => mapping.id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    for (const mapping of adapter.mappings()) {
      let row = rows.get(mapping.id);
      if (!row) {
        row = mappingRow(mapping, map);
        rows.set(mapping.id, row);
        mappings.append(row.el);
      }
      row.update(mapping, map);
    }

    const counts = adapter.mappings().length;
    const warning = adapter.persistenceWarning ? ` · ${adapter.persistenceWarning}` : "";
    summaryLine.textContent = `${adapter.status.message} · назначений: ${counts}${
      adapter.training ? " · обучение включено" : ""
    }${warning}`;
  }

  connectButton.addEventListener("click", () => {
    void adapter.connect();
  });
  deviceSelect.addEventListener("change", () => {
    if (deviceSelect.value === ALL_INPUTS_VALUE) adapter.selectAllInputs();
    else adapter.selectInput(deviceSelect.value);
  });
  addButton.addEventListener("click", () => {
    adapter.addMapping({ source: "cc", number: 0 });
  });
  const unsubscribe = adapter.subscribe(refresh);
  // A focused field keeps its draft during external updates. On leaving it,
  // show the latest canonical value even if no further MIDI notification comes.
  root.addEventListener("focusout", refresh);
  refresh();

  return {
    el: root,
    refresh,
    dispose(): void {
      unsubscribe();
      root.removeEventListener("focusout", refresh);
      root.remove();
    },
  };
}

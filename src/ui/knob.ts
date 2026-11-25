import type { NumberParamSpec } from "../core/params.ts";

/** UI-only quantization; registry/API/MIDI semantics remain unchanged. */
export function knobValue(value: number, min: number, max: number, step: number | "any"): number {
  const clamped = Math.max(min, Math.min(max, value));
  if (step === "any") return clamped;
  if (clamped === min || clamped === max) return clamped;
  const stepped = min + Math.round((clamped - min) / step) * step;
  return Math.max(min, Math.min(max, Number(stepped.toPrecision(14))));
}

let nextId = 0;

/** The knob owns transient interaction only. All persistent values come from read(). */
export function createKnob<S>(
  spec: NumberParamSpec<S>,
  read: () => number,
  write: (value: number) => void,
  readBindingKey?: () => string | number,
) {
  const main = document.createElement("div");
  main.className = "labkit-control-main labkit-knob-main";
  const label = document.createElement("label");
  label.className = "labkit-field-label";
  label.textContent = spec.label;
  const knob = document.createElement("button");
  knob.type = "button";
  knob.id = `labkit-knob-${++nextId}`;
  label.htmlFor = knob.id;
  knob.className = "labkit-knob";
  knob.dataset.param = spec.id;
  knob.setAttribute("role", "slider");
  knob.setAttribute("aria-label", spec.label);
  knob.setAttribute("aria-orientation", "vertical");
  knob.setAttribute("aria-valuemin", String(spec.min));
  knob.setAttribute("aria-valuemax", String(spec.max));
  knob.innerHTML =
    '<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="labkit-knob-track" cx="26" cy="26" r="21" pathLength="100"/><circle class="labkit-knob-arc" cx="26" cy="26" r="21" pathLength="100"/><path class="labkit-knob-pointer" d="M26 13V20"/></svg>';
  const value = document.createElement("button");
  value.type = "button";
  value.className = "labkit-value labkit-knob-value";
  value.setAttribute("aria-label", `${spec.label}: edit numeric value`);
  const editor = document.createElement("input");
  editor.type = "text";
  editor.inputMode = "decimal";
  editor.className = "labkit-knob-editor labkit-value";
  editor.setAttribute(
    "aria-label",
    `${spec.label}: numeric value${spec.unit ? ` (${spec.unit})` : ""}`,
  );
  editor.hidden = true;
  main.append(label, knob, value, editor);

  const popup = document.createElement("div");
  popup.className = "labkit-knob-scale";
  popup.setAttribute("aria-hidden", "true");
  const high = document.createElement("span");
  high.className = "labkit-knob-scale-high";
  high.textContent = String(spec.max);
  const low = document.createElement("span");
  low.className = "labkit-knob-scale-low";
  low.textContent = String(spec.min);
  const track = document.createElement("div");
  track.className = "labkit-knob-scale-track";
  const thumb = document.createElement("div");
  thumb.className = "labkit-knob-scale-thumb";
  track.append(thumb);
  popup.append(high, track, low);
  const format =
    spec.format ?? ((v: number) => `${v.toFixed(2)}${spec.unit ? ` ${spec.unit}` : ""}`);
  let editing = false;
  let disposed = false;
  let enabled = true;
  let ownWrite = false;
  let lastCanonical: number | undefined;
  let drag:
    | { id: number; y: number; raw: number; bindingKey: string | number | undefined }
    | undefined;
  let editBindingKey: string | number | undefined;

  const currentBindingKey = (): string | number | undefined => readBindingKey?.();
  const bindingMatches = (expected: string | number | undefined): boolean =>
    !readBindingKey || currentBindingKey() === expected;
  // Expected key is the fresh identity captured when the interaction started.
  // It is checked immediately before every write, not only during update.
  const commit = (next: number, expectedBindingKey?: string | number): boolean => {
    if (readBindingKey && expectedBindingKey !== undefined && !bindingMatches(expectedBindingKey)) {
      return false;
    }
    ownWrite = true;
    try {
      write(knobValue(next, spec.min, spec.max, spec.step));
    } finally {
      ownWrite = false;
    }
    return true;
  };
  const stopDrag = (): void => {
    const id = drag?.id;
    drag = undefined;
    popup.remove();
    knob.classList.remove("is-dragging");
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    window.removeEventListener("blur", stopDrag);
    window.removeEventListener("resize", stopDrag);
    window.removeEventListener("scroll", stopDrag, true);
    if (id !== undefined && knob.hasPointerCapture?.(id)) knob.releasePointerCapture(id);
  };
  const finishEdit = (save: boolean, focus: boolean): void => {
    if (!editing) return;
    editing = false;
    editor.hidden = true;
    value.hidden = false;
    const raw = editor.value.trim();
    const bindingKey = editBindingKey;
    editBindingKey = undefined;
    if (save && enabled && raw !== "" && Number.isFinite(Number(raw)))
      commit(Number(raw), bindingKey);
    if (focus && enabled && !disposed) value.focus();
  };
  function move(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const dy = event.clientY - drag.y;
    if (dy === 0) return;
    // Incremental vertical deltas keep Shift changes continuous; up is more.
    // 240px = full span, Shift is 10× finer. Clamp the accumulator to avoid
    // edge dead zones. Horizontal motion is deliberately ignored.
    drag.raw = Math.max(
      spec.min,
      Math.min(
        spec.max,
        drag.raw - ((dy * (spec.max - spec.min)) / 240) * (event.shiftKey ? 0.1 : 1),
      ),
    );
    drag.y = event.clientY;
    if (!commit(drag.raw, drag.bindingKey)) stopDrag();
  }
  function end(event: PointerEvent): void {
    if (event.pointerId === drag?.id) stopDrag();
  }
  const down = (event: PointerEvent): void => {
    if (!enabled || disposed || drag || event.button !== 0) return;
    event.preventDefault();
    finishEdit(true, false);
    knob.focus();
    drag = { id: event.pointerId, y: event.clientY, raw: read(), bindingKey: currentBindingKey() };
    knob.classList.add("is-dragging");
    document.body.append(popup);
    // Fixed positioning avoids clipping by cards. The tall, narrow scale sits
    // beside the knob and flips to its left when the right edge is too close.
    // It is measured and clamped into the viewport, including small screens.
    const margin = 8;
    const gap = 8;
    const rect = knob.getBoundingClientRect();
    // Drop constraints from a previous (possibly smaller) viewport before
    // measuring the natural size for this gesture.
    popup.style.width = "";
    popup.style.height = "";
    const width = Math.min(popup.offsetWidth || 48, Math.max(0, window.innerWidth - margin * 2));
    const height = Math.min(
      popup.offsetHeight || 152,
      Math.max(0, window.innerHeight - margin * 2),
    );
    popup.style.width = `${width}px`;
    popup.style.height = `${height}px`;
    let left = rect.right + gap;
    if (left + width > window.innerWidth - margin) left = rect.left - width - gap;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
    const top = Math.max(
      margin,
      Math.min(window.innerHeight - height - margin, rect.top + rect.height / 2 - height / 2),
    );
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", stopDrag);
    window.addEventListener("resize", stopDrag);
    window.addEventListener("scroll", stopDrag, true);
    try {
      knob.setPointerCapture(event.pointerId);
    } catch {
      stopDrag();
    } // A detached/invalid pointer must not leak listeners.
  };
  const key = (event: KeyboardEvent): void => {
    if (!enabled || disposed) return;
    const step = spec.step === "any" ? (spec.max - spec.min) / 100 : spec.step;
    const bindingKey = currentBindingKey();
    let next: number;
    switch (event.key) {
      case "Home":
        next = spec.min;
        break;
      case "End":
        next = spec.max;
        break;
      case "ArrowUp":
      case "ArrowRight":
        next = read() + step;
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = read() - step;
        break;
      default:
        return;
    }
    event.preventDefault();
    commit(next, bindingKey);
  };
  const edit = (): void => {
    if (!enabled || disposed) return;
    stopDrag();
    editing = true;
    editBindingKey = currentBindingKey();
    editor.value = String(read());
    value.hidden = true;
    editor.hidden = false;
    editor.focus();
    editor.select();
  };
  const editKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      finishEdit(event.key === "Enter", true);
    }
  };
  const blur = (): void => finishEdit(true, false);
  knob.addEventListener("pointerdown", down);
  knob.addEventListener("lostpointercapture", stopDrag);
  knob.addEventListener("keydown", key);
  value.addEventListener("click", edit);
  editor.addEventListener("keydown", editKey);
  editor.addEventListener("blur", blur);

  return {
    el: main,
    update(available: boolean, visible: boolean): void {
      enabled = available && visible && !disposed;
      if (!enabled) {
        stopDrag();
        finishEdit(false, false);
      }
      // The model/selection may change before a render. A changed address
      // cancels unfinished interaction without carrying it to the new target;
      // writes already made through the old identity stay applied.
      if (drag && !bindingMatches(drag.bindingKey)) stopDrag();
      if (editing && !bindingMatches(editBindingKey)) finishEdit(false, false);
      knob.disabled = !available;
      value.disabled = !available;
      editor.disabled = !available;
      knob.setAttribute("aria-disabled", String(!available));
      const current = read();
      if (drag && !ownWrite && current !== lastCanonical) drag.raw = current;
      lastCanonical = current;
      knob.setAttribute("aria-valuenow", String(current));
      const fraction =
        spec.max === spec.min
          ? 0
          : Math.max(0, Math.min(1, (current - spec.min) / (spec.max - spec.min)));
      knob.style.setProperty("--knob-arc", String(fraction * 75));
      knob.style.setProperty("--knob-angle", `${-135 + fraction * 270}deg`);
      popup.style.setProperty("--knob-percent", `${fraction * 100}%`);
      const text = format(current);
      knob.setAttribute("aria-valuetext", text);
      value.textContent = text;
    },
    dispose(): void {
      disposed = true;
      enabled = false;
      stopDrag();
      finishEdit(false, false);
      knob.removeEventListener("pointerdown", down);
      knob.removeEventListener("lostpointercapture", stopDrag);
      knob.removeEventListener("keydown", key);
      value.removeEventListener("click", edit);
      editor.removeEventListener("keydown", editKey);
      editor.removeEventListener("blur", blur);
    },
  };
}

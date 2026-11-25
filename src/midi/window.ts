import type { MidiAdapter } from "./adapter.ts";
import type { MidiPanelHandle } from "./panel.ts";
import type { MidiStatusKind } from "./types.ts";

const STATUS_LABELS: Record<MidiStatusKind, string> = {
  idle: "не подключён",
  connecting: "подключение…",
  connected: "выберите вход",
  "no-inputs": "нет входов",
  "input-disconnected": "вход отключён",
  unsupported: "не поддерживается",
  insecure: "нужен HTTPS",
  denied: "доступ запрещён",
  error: "ошибка",
};

let nextId = 0;

/** One nonmodal settings surface per lab; visibility never owns MIDI lifetime. */
export function mountMidiWindow(
  root: HTMLElement,
  adapter: MidiAdapter,
  panel: MidiPanelHandle,
): () => void {
  const doc = root.ownerDocument;
  const toolbar = doc.createElement("div");
  toolbar.className = "labkit-midi-toolbar";
  const button = (text: string): HTMLButtonElement => {
    const el = doc.createElement("button");
    el.type = "button";
    el.className = "labkit-btn";
    el.textContent = text;
    return el;
  };
  const toggle = button("MIDI");
  const training = button("Обучение MIDI");
  const waiting = doc.createElement("span");
  waiting.className = "labkit-midi-waiting";
  waiting.setAttribute("role", "status");
  const cancel = button("Отменить ожидание MIDI");
  toolbar.append(toggle, training, waiting, cancel);

  const surface = doc.createElement("section");
  surface.className = "labkit-midi-window";
  surface.id = `labkit-midi-window-${++nextId}`;
  surface.hidden = true;
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-modal", "false");
  const heading = doc.createElement("div");
  heading.className = "labkit-midi-window-heading";
  const title = doc.createElement("h2");
  title.id = `${surface.id}-title`;
  title.textContent = "Настройки MIDI";
  surface.setAttribute("aria-labelledby", title.id);
  const close = button("×");
  close.setAttribute("aria-label", "Закрыть настройки MIDI");
  heading.append(title, close);
  surface.append(heading, panel.el);
  toggle.setAttribute("aria-controls", surface.id);
  toggle.setAttribute("aria-expanded", "false");
  try {
    (root.querySelector(".labkit-header-actions") ?? root).append(toolbar);
    root.append(surface);
  } catch (error) {
    toolbar.remove();
    surface.remove();
    throw error;
  }

  let returnFocus: HTMLElement | null = null;
  const win = doc.defaultView;
  const anchor = root.querySelector<HTMLElement>(".labkit-header") ?? toolbar;
  const position = (): void => {
    if (surface.hidden || !win) return;
    // Follow the actual header, including wrapping learn/waiting controls.
    // Once it scrolls away, keep the nonmodal surface inside the viewport.
    const top = Math.max(8, anchor.getBoundingClientRect().bottom + 8);
    surface.style.top = `${top}px`;
    surface.style.maxHeight = `${Math.max(0, win.innerHeight - top - 8)}px`;
  };
  const observer = win?.ResizeObserver ? new win.ResizeObserver(position) : null;
  observer?.observe(anchor);
  observer?.observe(toolbar);
  win?.addEventListener("resize", position);
  win?.addEventListener("scroll", position, true);
  const setOpen = (open: boolean): void => {
    if (open === !surface.hidden) return;
    const restore = surface.contains(doc.activeElement);
    if (open) returnFocus = doc.activeElement as HTMLElement | null;
    surface.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    position();
    if (open) close.focus({ preventScroll: true });
    else if (restore)
      (returnFocus?.isConnected ? returnFocus : toggle).focus({ preventScroll: true });
  };
  const onToggle = (): void => setOpen(surface.hidden);
  const onClose = (): void => setOpen(false);
  const onTraining = (): void => adapter.setTraining(!adapter.training);
  const onCancel = (): void => adapter.cancelLearn();
  // Bubble, not capture: numeric editors get first refusal of Escape. Only
  // this instance's subtree participates; another lab's editor is independent.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented || surface.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };
  toggle.addEventListener("click", onToggle);
  close.addEventListener("click", onClose);
  training.addEventListener("click", onTraining);
  cancel.addEventListener("click", onCancel);
  root.addEventListener("keydown", onKey);
  const refresh = (): void => {
    const listening = adapter.listeningInputIds().length;
    toggle.textContent = `MIDI · ${listening ? `подключён (${listening})` : STATUS_LABELS[adapter.status.kind]}${adapter.persistenceWarning ? " · не сохраняется" : ""}`;
    toggle.title = [adapter.status.message, adapter.persistenceWarning].filter(Boolean).join(" · ");
    toggle.dataset.kind = adapter.status.kind;
    training.textContent = adapter.training ? "Обучение MIDI · включено" : "Обучение MIDI";
    training.setAttribute("aria-pressed", String(adapter.training));
    const learning = adapter.learningTarget !== null;
    waiting.hidden = !learning;
    waiting.textContent = learning
      ? `Жду MIDI · ${adapter.targets().find((target) => target.id === adapter.learningTarget)?.label ?? adapter.learningTarget}`
      : "";
    cancel.hidden = !learning;
    position();
  };
  const unsubscribe = adapter.subscribe(refresh);
  refresh();
  return () => {
    unsubscribe();
    observer?.disconnect();
    win?.removeEventListener("resize", position);
    win?.removeEventListener("scroll", position, true);
    root.removeEventListener("keydown", onKey);
    toggle.removeEventListener("click", onToggle);
    close.removeEventListener("click", onClose);
    training.removeEventListener("click", onTraining);
    cancel.removeEventListener("click", onCancel);
    toolbar.remove();
    surface.remove();
  };
}

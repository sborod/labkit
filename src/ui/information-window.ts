/** A persistent, nonmodal information surface; no audio/model ownership. */
let nextId = 0;
export function createInformationWindow(doc: Document, title: string, invalidate: () => void) {
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "labkit-btn";
  trigger.textContent = title;
  trigger.setAttribute("aria-expanded", "false");
  const window = doc.createElement("section");
  window.className = "labkit-information-window";
  window.id = `labkit-information-${++nextId}`;
  trigger.setAttribute("aria-controls", window.id);
  window.setAttribute("role", "dialog");
  window.setAttribute("aria-modal", "false");
  window.setAttribute("aria-label", title);
  window.hidden = true;
  const header = doc.createElement("header");
  const heading = doc.createElement("h2");
  heading.textContent = title;
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "labkit-btn";
  close.textContent = "Закрыть";
  close.setAttribute("aria-label", `Закрыть: ${title}`);
  header.append(heading, close);
  const body = doc.createElement("div");
  body.className = "labkit-information-body";
  window.append(header, body);
  const hide = (): void => {
    const restore = window.contains(doc.activeElement);
    window.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restore) trigger.focus();
  };
  const toggle = (): void => {
    if (!window.hidden) {
      hide();
      return;
    }
    window.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    close.focus();
    invalidate();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      hide();
    }
  };
  trigger.addEventListener("click", toggle);
  close.addEventListener("click", hide);
  window.addEventListener("keydown", key);
  return {
    trigger,
    window,
    body,
    dispose() {
      trigger.removeEventListener("click", toggle);
      close.removeEventListener("click", hide);
      window.removeEventListener("keydown", key);
      window.remove();
    },
  };
}

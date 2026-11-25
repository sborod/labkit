export interface InlineErrorHandle {
  /** Element owned by the caller: place and remove it yourself. */
  readonly el: HTMLSpanElement;
  /** Shows a plain-text message; `null`, `""` or whitespace-only clears and hides. */
  set(message: string | null): void;
}

/**
 * Small inline error slot shared by local editors. It owns no timers, listeners
 * or DOM placement: the caller mounts `el` and removes it with its own UI.
 */
export function createInlineError(doc: Document): InlineErrorHandle {
  const el = doc.createElement("span");
  el.className = "labkit-inline-error";
  el.setAttribute("role", "alert");
  el.hidden = true;

  return {
    el,
    set(message: string | null): void {
      const text = message === null ? "" : message;
      el.textContent = text;
      el.hidden = text.trim() === "";
    },
  };
}

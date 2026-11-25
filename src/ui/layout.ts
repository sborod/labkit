// Декларативный layout. LayoutNode описывает композицию, не состояние.
// Мышь/тач/MIDI адресуют реестр, а не DOM.

export type ReadoutVariant = "eq" | "stat" | "small";

export type LayoutNode = { className?: string } & (
  | {
      kind: "group";
      title?: string;
      collapsible?: boolean;
      /** Только начальное состояние раскрываемой группы. */
      collapsed?: boolean;
      children: LayoutNode[];
    }
  | {
      kind: "row";
      columns?: number | "auto-fit";
      density?: "compact" | "normal";
      children: LayoutNode[];
    }
  | { kind: "control"; param: string; presentation?: "segmented" | "pad"; displayLabel?: string }
  | { kind: "window"; title: string; children: LayoutNode[] }
  | { kind: "action"; action: string }
  | { kind: "panel"; view: string; title?: string; aspect?: number }
  | { kind: "readout"; id: string; label?: string; variant?: ReadoutVariant }
  | { kind: "note"; title?: string; text?: string; html?: string }
);

/** По умолчанию две колонки; instrument: сетка controls над workspace. */
export interface LabLayout {
  /** Explicit header actions; built once with the normal node lifecycle. */
  header?: LayoutNode[];
  variant?: "instrument";
  /** Закреплённая панель действий/контролов, без привязки к конкретным id. */
  toolbar?: LayoutNode[];
  controls: LayoutNode[];
  workspace: LayoutNode[];
}

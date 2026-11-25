// Тема каркаса LabKit (внутренний модуль, не публичный API). Переключает
// data-labkit-theme на <html>; CSS-токены в labkit.css читают этот атрибут.
//
// Приоритет начальной темы: явный выбор в localStorage → системная настройка →
// светлая. Живой matchMedia-listener и синхронизация нескольких лаб на одной
// странице сознательно не делаются: основной сценарий — одна лаба на страницу.

export type LabTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "labkit.theme.v1";
export const THEME_ATTRIBUTE = "data-labkit-theme";

function readStoredTheme(doc: Document): LabTheme | null {
  try {
    const value = doc.defaultView?.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    // Хранилище недоступно (приватный режим, запрет) — выбор не читается.
    return null;
  }
}

function systemTheme(doc: Document): LabTheme {
  const view = doc.defaultView;
  if (!view || typeof view.matchMedia !== "function") {
    return "light";
  }
  try {
    return view.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Начальная тема для только что созданного экземпляра. */
export function initialTheme(doc: Document): LabTheme {
  return readStoredTheme(doc) ?? systemTheme(doc);
}

/** Выставить тему на документе (атрибут живёт до следующего переключения). */
export function applyTheme(doc: Document, theme: LabTheme): void {
  doc.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
}

/** Сохранить явный выбор. Недоступное хранилище — просто нет персистентности. */
export function saveTheme(doc: Document, theme: LabTheme): void {
  try {
    doc.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // см. readStoredTheme
  }
}

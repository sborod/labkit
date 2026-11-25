import { CapabilityError, formatCapabilityStatuses } from "../runtime/capabilities.ts";
import { LabDefinitionError } from "../runtime/validation.ts";

/** Явная ошибка возможности в UI — без тихой деградации (дополнение 1). */
export function renderCapabilityError(host: HTMLElement, error: CapabilityError): void {
  const doc = host.ownerDocument;
  const banner = doc.createElement("div");
  banner.className = "labkit-status labkit-status--error";
  banner.dataset.state = "capability-error";
  const title = doc.createElement("div");
  title.className = "labkit-status-title";
  title.textContent = `Лаборатория недоступна: ${error.message}`;
  const details = doc.createElement("pre");
  details.textContent = formatCapabilityStatuses(error.statuses);
  banner.append(title, details);
  host.replaceChildren(banner);
}

/** Явная ошибка описания лаборатории (валидация контракта). */
export function renderLabDefinitionError(host: HTMLElement, error: LabDefinitionError): void {
  const doc = host.ownerDocument;
  const banner = doc.createElement("div");
  banner.className = "labkit-status labkit-status--error";
  banner.dataset.state = "definition-error";
  const title = doc.createElement("div");
  title.className = "labkit-status-title";
  title.textContent = "Некорректное описание лаборатории";
  const details = doc.createElement("pre");
  details.textContent = error.issues.map((issue) => `• ${issue}`).join("\n");
  banner.append(title, details);
  host.replaceChildren(banner);
}

export function renderFatalStatus(host: HTMLElement, message: string): void {
  const banner = host.ownerDocument.createElement("div");
  banner.className = "labkit-status labkit-status--error";
  banner.dataset.state = "fatal";
  banner.textContent = message;
  host.replaceChildren(banner);
}

/** Единая точка: ошибка запуска лаборатории → видимый статус. */
export function renderError(host: HTMLElement, error: unknown): void {
  if (error instanceof CapabilityError) {
    renderCapabilityError(host, error);
    return;
  }
  if (error instanceof LabDefinitionError) {
    renderLabDefinitionError(host, error);
    return;
  }
  renderFatalStatus(host, `labkit: ошибка запуска: ${String(error)}`);
}

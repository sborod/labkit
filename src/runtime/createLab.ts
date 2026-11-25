import { ActionRegistry } from "../core/actions.ts";
import { ParameterRegistry } from "../core/registry.ts";
import type { RuntimeContext, TimelineControl } from "../core/context.ts";
import type { BatchChange } from "../core/events.ts";
import {
  THEME_ATTRIBUTE,
  applyTheme,
  initialTheme,
  saveTheme,
  type LabTheme,
} from "../ui/theme.ts";
import {
  CapabilityError,
  checkCapabilities,
  detectCapabilities,
  formatCapabilityStatuses,
  type CapabilityReport,
  type CapabilityStatus,
} from "./capabilities.ts";
import type { LabDefinition } from "./definition.ts";
import { createLayoutRenderer } from "./layout-renderer.ts";
import type { LabErrorEvent, LabErrorPhase, Lifetime } from "./lifetime.ts";
import { Scope } from "./scope.ts";
import { Timeline, type FrameCanceller, type FrameScheduler } from "./timeline.ts";
import { validateDefinitionStructure, validateInitialState } from "./validation.ts";

export type { LabErrorEvent, LabErrorPhase, Lifetime } from "./lifetime.ts";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}

export interface LabServices {
  /** Готовый отчёт о возможностях (тестовые адаптеры); иначе определяется из среды. */
  capabilities?: CapabilityReport;
  scheduleFrame?: FrameScheduler;
  cancelFrame?: FrameCanceller;
  document?: Document;
  log?: (message: string) => void;
  /** Единый канал ошибок выполнения (для host/bench). */
  onError?: (event: LabErrorEvent) => void;
}

export interface LabInstance<S> {
  readonly definition: LabDefinition<S>;
  readonly state: S;
  readonly params: ParameterRegistry<S>;
  readonly actions: ActionRegistry<S>;
  readonly timeline: TimelineControl;
  readonly capabilities: readonly CapabilityStatus[];
  readonly root: HTMLElement;
  readonly disposed: boolean;
  render(): void;
  /** Идемпотентный и awaitable. */
  dispose(): Promise<void>;
}

/**
 * Создать экземпляр лаборатории. LabDefinition используется как общее
 * декларативное описание; всё состояние и ресурсы принадлежат экземпляру.
 *
 * Функция синхронная: структурная валидация и валидация начального состояния
 * выполняются до создания ресурсов. При ошибке (в том числе на этапе монтирования
 * или первой отрисовки) частично созданные ресурсы освобождаются синхронно через
 * Scope.dispose(); синхронные освободители выполняются в том же вызове.
 */
export function createLab<S>(
  definition: LabDefinition<S>,
  mountEl: HTMLElement,
  services: LabServices = {},
): LabInstance<S> {
  validateDefinitionStructure(definition);

  const doc = services.document ?? mountEl.ownerDocument;
  const report = services.capabilities ?? detectCapabilities();
  const required = definition.capabilities?.required ?? [];
  const optional = definition.capabilities?.optional ?? [];
  const statuses = checkCapabilities(report, required, optional);
  const missing = statuses
    .filter((status) => status.required && !status.supported)
    .map((status) => status.id);
  if (missing.length > 0) {
    throw new CapabilityError(missing, statuses);
  }

  const state = definition.model.createState();
  validateInitialState(definition, state);

  const params = new ParameterRegistry(state, definition.parameters);
  const scope = new Scope();
  const log =
    services.log ?? ((message: string) => console.info(`[labkit:${definition.id}] ${message}`));

  const root = doc.createElement("div");
  root.className = "labkit";
  if (definition.layout.variant) {
    root.classList.add(`labkit--${definition.layout.variant}`);
  }
  root.dataset.lab = definition.id;
  scope.add(() => root.remove());

  // Единый видимый канал ошибок выполнения (не только консоль).
  const errorBanner = doc.createElement("div");
  errorBanner.className = "labkit-status labkit-status--error";
  errorBanner.setAttribute("role", "alert");
  errorBanner.hidden = true;
  root.append(errorBanner);

  const reportError = (phase: LabErrorPhase, error: unknown): void => {
    // После dispose UI уже отцеплён: поздние ошибки не должны трогать баннер,
    // перерисовку или хост-обработчик. Разрешён только диагностический лог.
    if (scope.disposed) {
      console.error(`[labkit:${definition.id}] поздняя ошибка (${phase}) после dispose`, error);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    errorBanner.textContent = `Ошибка выполнения (${phase}): ${detail}`;
    errorBanner.hidden = false;
    console.error(`[labkit:${definition.id}] ${phase}`, error);
    try {
      services.onError?.({ lab: definition.id, phase, error });
    } catch (handlerError) {
      // Исключение самого обработчика не должно превращаться во вторую ошибку
      // в safeRender; логируем отдельно.
      console.error(`[labkit:${definition.id}] ошибка обработчика onError`, handlerError);
    }
  };

  // Живой lifetime экземпляра: стабильный объект, `disposed` — getter (не
  // скопированное значение). Передаётся в hooks.setup() как есть; определение
  // не хранит ни singleton, ни WeakMap.
  const lifetime: Lifetime = {
    get disposed(): boolean {
      return scope.disposed;
    },
    add: (disposer) => scope.add(disposer),
    reportError,
  };

  const contextRef = (): RuntimeContext<S> => ctx;
  const actionRegistry = new ActionRegistry<S>(
    contextRef,
    definition.actions ?? {},
    () => scope.disposed,
  );

  let rendering = false;
  let scheduled = false;

  // Построение layout и UI-синхронизация вынесены во внутренний модуль. Он
  // использует тот же Scope, состояние и registry экземпляра; очередь
  // requestRender и канал ошибок остаются здесь.
  const renderer = createLayoutRenderer({
    document: doc,
    root,
    definition,
    state,
    params,
    actions: actionRegistry,
    scope,
    requestRender: () => requestRender(),
    reportError,
  });

  const renderOnce = (): void => {
    if (scope.disposed) {
      return;
    }
    renderer.render();
  };

  const safeRender = (): void => {
    if (scope.disposed) {
      return;
    }
    try {
      renderOnce();
    } catch (error) {
      reportError("render", error);
    }
  };

  const requestRender = (): void => {
    if (scope.disposed || scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (scope.disposed || rendering) {
        return;
      }
      rendering = true;
      try {
        safeRender();
      } finally {
        rendering = false;
      }
    });
  };

  const timeline = new Timeline(
    (dt: number) => {
      if (scope.disposed) {
        return;
      }
      try {
        definition.hooks?.animation?.step(ctx, dt);
      } catch (error) {
        // Ошибка анимации не продолжается молча: останавливаем таймлайн.
        timeline.stop();
        reportError("animation", error);
        return;
      }
      ctx.requestRender();
    },
    services.scheduleFrame,
    services.cancelFrame,
  );
  scope.add(() => timeline.dispose());

  const ctx: RuntimeContext<S> = {
    state,
    params,
    actions: actionRegistry,
    timeline,
    root,
    requestRender,
    log,
  };

  // Реакции на изменение параметров регистрируются сразу при создании.
  const unsubscribe = params.subscribe((change: BatchChange) => {
    if (scope.disposed) {
      return;
    }
    try {
      definition.hooks?.onChange?.(ctx, change);
    } catch (error) {
      reportError("hook", error);
    }
  });
  scope.add(unsubscribe);

  const header = doc.createElement("header");
  header.className = "labkit-header";
  const headerText = doc.createElement("div");
  headerText.className = "labkit-header-text";
  const heading = doc.createElement("h1");
  heading.textContent = definition.title;
  headerText.append(heading);
  if (definition.subtitle) {
    const subtitle = doc.createElement("p");
    subtitle.textContent = definition.subtitle;
    headerText.append(subtitle);
  }
  header.append(headerText);

  // Переключатель темы каркаса. Начальная тема — явный сохранённый выбор,
  // иначе системная, иначе светлая. Listener принадлежит scope и снимается при
  // dispose; атрибут на <html> document-wide и при dispose не снимается
  // (ownership нескольких лаб на одной странице сознательно не строится).
  let theme: LabTheme = initialTheme(doc);
  applyTheme(doc, theme);
  const themeToggle = doc.createElement("button");
  themeToggle.type = "button";
  themeToggle.className = "labkit-theme-toggle";
  themeToggle.textContent = "Тёмная тема";
  const syncThemeToggle = (): void => {
    themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  };
  syncThemeToggle();
  scope.listen(themeToggle, "click", () => {
    theme = theme === "dark" ? "light" : "dark";
    applyTheme(doc, theme);
    saveTheme(doc, theme);
    syncThemeToggle();
  });
  const headerActions = doc.createElement("div");
  headerActions.className = "labkit-header-actions";
  headerActions.append(themeToggle);
  header.append(headerActions);
  root.append(header);

  const capabilityIssues = statuses.filter((status) => !status.required && !status.supported);
  if (capabilityIssues.length > 0) {
    const banner = doc.createElement("div");
    banner.className = "labkit-status";
    banner.dataset.state = "optional-missing";
    banner.textContent = formatCapabilityStatuses(capabilityIssues);
    root.append(banner);
  }

  const grid = doc.createElement("div");
  grid.className = "labkit-grid";
  const controlsColumn = doc.createElement("div");
  controlsColumn.className = "labkit-column labkit-controls";
  const workspaceColumn = doc.createElement("div");
  workspaceColumn.className = "labkit-column labkit-workspace";
  grid.append(controlsColumn, workspaceColumn);
  root.append(grid);

  try {
    // Смена темы каркаса инвалидирует canvas экземпляра: конкретный view
    // по-прежнему владеет палитрой и решает, что рисовать. Наблюдается только
    // THEME_ATTRIBUTE на <html> (не весь DOM/class/style); первая установка
    // темы выше уже произошла, поэтому здесь нет лишней async-отрисовки.
    // Ресурс принадлежит общему Scope: disconnect до observe и до поздних
    // доставок после dispose; requestRender сам проверяет disposed и
    // коалесцирует серию mutation в одну перерисовку.
    const themeObserver = new MutationObserver(() => requestRender());
    scope.add(() => themeObserver.disconnect());
    themeObserver.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: [THEME_ATTRIBUTE],
    });

    if (definition.layout.header) renderer.buildNodes(definition.layout.header, headerActions);
    if (definition.layout.toolbar?.length) {
      const toolbar = doc.createElement("div");
      toolbar.className = "labkit-toolbar";
      toolbar.setAttribute("role", "region");
      toolbar.setAttribute("aria-label", "Транспорт и управление");
      renderer.buildNodes(definition.layout.toolbar, toolbar);
      root.insertBefore(toolbar, grid);
      const observer = new ResizeObserver(() => {
        root.style.setProperty(
          "--labkit-toolbar-height",
          `${toolbar.getBoundingClientRect().height}px`,
        );
      });
      scope.add(() => observer.disconnect());
      observer.observe(toolbar);
      scope.listen(root, "focusin", (event) => {
        const target = event.target as HTMLElement;
        if (toolbar.contains(target)) {
          return;
        }
        const toolbarRect = toolbar.getBoundingClientRect();
        if (toolbarRect.top > 0) {
          return;
        }
        const bottom = toolbarRect.bottom;
        const rect = target.getBoundingClientRect();
        if (rect.top < bottom && rect.bottom > 0) {
          doc.defaultView?.scrollBy({ top: rect.top - bottom - 8, behavior: "instant" });
        }
      });
    }
    renderer.buildNodes(definition.layout.controls, controlsColumn);
    renderer.buildNodes(definition.layout.workspace, workspaceColumn);
    mountEl.append(root);

    // После вставки в DOM у поверхностей появляются размеры.
    renderer.resize();

    // Синхронная per-instance инициализация до первой отрисовки. Ошибка setup —
    // ошибка монтирования: созданное (в т. ч. добавленное через lifetime.add)
    // освобождается в catch ниже.
    const setupHook = definition.hooks?.setup as
      | ((c: RuntimeContext<S>, l: Lifetime) => unknown)
      | undefined;
    const setupResult = setupHook?.(ctx, lifetime);
    if (setupResult !== undefined) {
      // Асинхронный setup не поддерживается. Наблюдаем возможное отклонение
      // thenable, чтобы не было unhandled rejection, и отклоняем монтирование.
      if (isThenable(setupResult)) {
        Promise.resolve(setupResult).catch(() => {});
      }
      throw new Error("labkit: hooks.setup должен быть синхронным и возвращать undefined");
    }

    // Первая отрисовка синхронна: её ошибка — ошибка монтирования.
    renderOnce();
  } catch (error) {
    // Сохраняем исходную ошибку монтирования, но не глотаем ошибку очистки:
    // синхронные освободители отработают здесь же, а async-отклонение
    // сообщается в сервис/консоль как AggregateError с cause = исходной ошибкой.
    const cleanup = scope.dispose();
    cleanup.catch((cleanupError) => {
      const aggregate = new AggregateError(
        [error, cleanupError],
        "labkit: ошибка монтирования и очистки",
        { cause: error },
      );
      console.error(`[labkit:${definition.id}] очистка после ошибки монтирования`, aggregate);
      try {
        services.onError?.({ lab: definition.id, phase: "cleanup", error: aggregate });
      } catch (handlerError) {
        console.error(`[labkit:${definition.id}] ошибка обработчика onError`, handlerError);
      }
    });
    throw error;
  }

  let disposal: Promise<void> | null = null;
  const instance: LabInstance<S> = {
    definition,
    state,
    params,
    actions: actionRegistry,
    timeline,
    capabilities: statuses,
    root,
    get disposed() {
      return scope.disposed;
    },
    render: safeRender,
    dispose(): Promise<void> {
      if (!disposal) {
        disposal = scope.dispose();
      }
      return disposal;
    },
  };
  return instance;
}

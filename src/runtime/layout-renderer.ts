// Внутренний построитель декларативного layout: создаёт DOM-узлы один раз и
// синхронизирует панели/readouts/кнопки/контролы с каноническим состоянием.
// Владельцем состояния, registry, Scope и очереди requestRender остаётся
// createLab; здесь нет второго lifetime и копий состояния.
import type { ActionRegistry } from "../core/actions.ts";
import type { ParameterRegistry } from "../core/registry.ts";
import { createControl, type ControlHandle } from "../ui/controls.ts";
import { createInformationWindow } from "../ui/information-window.ts";
import type { LayoutNode } from "../ui/layout.ts";
import type { LabDefinition, ViewSpec } from "./definition.ts";
import type { LabErrorPhase } from "./lifetime.ts";
import type { Scope } from "./scope.ts";
import { DisplaySurface } from "./surface.ts";

export interface LayoutRendererOptions<S> {
  document: Document;
  root: HTMLElement;
  definition: LabDefinition<S>;
  state: S;
  params: ParameterRegistry<S>;
  actions: ActionRegistry<S>;
  scope: Scope;
  requestRender(): void;
  reportError(phase: LabErrorPhase, error: unknown): void;
}

export interface LayoutRenderer {
  buildNodes(nodes: readonly LayoutNode[], parent: HTMLElement): void;
  /** Синхронизировать UI с состоянием; порядок panels → readouts → actions → controls. */
  render(): void;
  /** Пересчитать размеры всех поверхностей панелей. */
  resize(): void;
}

export function createLayoutRenderer<S>(options: LayoutRendererOptions<S>): LayoutRenderer {
  const {
    document: doc,
    root,
    definition,
    state,
    params,
    actions,
    scope,
    requestRender,
    reportError,
  } = options;

  const panels: Array<{ view: ViewSpec<S>; surface: DisplaySurface }> = [];
  const readouts: Array<{ el: HTMLElement; derive: (state: S) => string }> = [];
  const actionButtons: Array<{ el: HTMLButtonElement; id: string }> = [];
  const controls: ControlHandle[] = [];
  /** className-обёртки контролов: hidden обязан следовать visible синхронно. */
  const controlWrappers: Array<{ el: HTMLElement; param: string }> = [];

  /**
   * Прямые озаглавленные секции окна, собранные при build. Навигация не
   * сканирует DOM: className-обёртка прозрачна, а вложенные группы/окна и
   * группы без заголовка сюда не попадают.
   */
  interface BuiltSection {
    section: HTMLElement;
    heading: HTMLElement;
  }

  function buildNodes(
    nodes: readonly LayoutNode[],
    parent: HTMLElement,
    sections?: BuiltSection[],
  ): void {
    for (const node of nodes) {
      buildNode(node, parent, sections);
    }
  }

  function buildNode(
    node: LayoutNode,
    parent: HTMLElement,
    sections?: BuiltSection[],
    layoutWrapper?: HTMLElement,
  ): void {
    if (node.className) {
      const wrapper = doc.createElement("div");
      wrapper.className = node.className;
      parent.append(wrapper);
      // Обёртка прозрачна для навигации окна, но остаётся layout-владельцем
      // контрола: его hidden синхронизируется именно на ней.
      buildNode({ ...node, className: undefined }, wrapper, sections, wrapper);
      return;
    }
    switch (node.kind) {
      case "window": {
        const info = createInformationWindow(doc, node.title, () => {
          resize();
          requestRender();
        });
        scope.add(info.dispose);
        // Локальный collector: только прямые дети этого окна (className
        // прозрачен), не секции вложенных групп или вложенных окон.
        const windowSections: BuiltSection[] = [];
        buildNodes(node.children, info.body, windowSections);
        if (windowSections.length > 1) {
          const nav = doc.createElement("nav");
          nav.className = "labkit-information-nav";
          nav.setAttribute("aria-label", node.title);
          for (const { section, heading } of windowSections) {
            const button = doc.createElement("button");
            button.type = "button";
            button.className = "labkit-btn";
            button.textContent = heading.textContent;
            heading.tabIndex = -1;
            scope.listen(button, "click", () => {
              // Координата секции в scroll-контейнере не зависит от
              // offsetParent: className-обёртка может быть position:relative.
              const bodyRect = info.body.getBoundingClientRect();
              info.body.scrollTop +=
                section.getBoundingClientRect().top - bodyRect.top - info.body.clientTop;
              heading.focus({ preventScroll: true });
            });
            nav.append(button);
          }
          info.window.insertBefore(nav, info.body);
        }
        parent.append(info.trigger);
        root.append(info.window);
        break;
      }
      case "group": {
        const card = doc.createElement(node.collapsible ? "details" : "section");
        card.className = "labkit-card";
        if (node.collapsible) {
          (card as HTMLDetailsElement).open = !node.collapsed;
          scope.listen(card, "toggle", () => {
            if (scope.disposed) {
              return;
            }
            resize();
            requestRender();
          });
        }
        let heading: HTMLElement | undefined;
        if (node.title) {
          const title = doc.createElement(node.collapsible ? "summary" : "h2");
          title.className = "labkit-card-title";
          title.textContent = node.title;
          card.append(title);
          heading = title;
        }
        const body = doc.createElement("div");
        body.className = "labkit-card-body";
        // Вложенные группы не участвуют в навигации объемлющего окна.
        buildNodes(node.children, body);
        card.append(body);
        parent.append(card);
        // Как и раньше, навигацию получают только неколлапсируемые секции с
        // заголовком; collector приходит лишь для прямых детей окна.
        if (sections && !node.collapsible && heading) {
          sections.push({ section: card, heading });
        }
        break;
      }
      case "row": {
        const row = doc.createElement("div");
        row.className = "labkit-row";
        row.dataset.density = node.density ?? "normal";
        if (node.columns === "auto-fit") {
          row.classList.add("labkit-row--auto");
        } else if (node.columns !== undefined) {
          row.style.setProperty("--labkit-columns", String(node.columns));
        }
        buildNodes(node.children, row);
        parent.append(row);
        break;
      }
      case "control": {
        const handle = createControl(params.spec(node.param), params, "ui", {
          onError: (error) => reportError("control", error),
          presentation: node.presentation,
          displayLabel: node.displayLabel,
        });
        scope.add(() => handle.dispose());
        controls.push(handle);
        parent.append(handle.el);
        if (layoutWrapper) {
          const wrapper = layoutWrapper;
          const syncVisibility = (): void => {
            if (scope.disposed) {
              return;
            }
            try {
              wrapper.hidden = !params.isVisible(node.param);
            } catch (error) {
              reportError("control", error);
            }
          };
          // Сразу при создании (до setup) и синхронно на любое изменение
          // реестра, в том числе чужого параметра, от которого зависит visible.
          syncVisibility();
          const unsubscribe = params.subscribe(syncVisibility);
          scope.add(unsubscribe);
          controlWrappers.push({ el: wrapper, param: node.param });
        }
        break;
      }
      case "action": {
        // Основная кнопка остаётся в actionButtons (render переписывает её
        // textContent), а неинтерактивная обёртка .labkit-control держит
        // соседний слот inline-обучения MIDI (accessory) рядом с кнопкой.
        const wrapper = doc.createElement("div");
        wrapper.className = "labkit-action labkit-control";
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "labkit-btn";
        button.dataset.action = node.action;
        const onClick = (): void => {
          if (scope.disposed) {
            return;
          }
          void actions
            .execute(node.action, "ui")
            .catch((error: unknown) => reportError("action", error));
        };
        scope.listen(button, "click", onClick);
        const accessory = doc.createElement("span");
        accessory.className = "labkit-control-accessory";
        accessory.dataset.labkitActionAccessory = node.action;
        accessory.hidden = true;
        wrapper.append(button, accessory);
        actionButtons.push({ el: button, id: node.action });
        parent.append(wrapper);
        break;
      }
      case "panel": {
        const wrap = doc.createElement("div");
        wrap.className = "labkit-panel";
        wrap.style.aspectRatio = String(node.aspect ?? 16 / 9);
        if (node.title) {
          const title = doc.createElement("div");
          title.className = "labkit-panel-title";
          title.textContent = node.title;
          wrap.append(title);
        }
        const view = definition.views?.[node.view];
        if (!view) {
          throw new Error(`labkit: неизвестный view "${node.view}"`);
        }
        const surface = new DisplaySurface(doc, {
          maxDpr: 2,
          onInvalidate: () => requestRender(),
        });
        scope.add(() => surface.dispose());
        // Стабильный DOM-маркер вида выставляется ДО attach/первой отрисовки и
        // доступен уже в hooks.setup (он выполняется до first render). Сам
        // DisplaySurface view ID не знает — маркер ставит рантайм.
        surface.canvas.dataset.labkitView = node.view;
        surface.attach(wrap);
        panels.push({ view, surface });
        parent.append(wrap);
        break;
      }
      case "readout": {
        const derive = definition.readouts?.[node.id];
        if (!derive) {
          throw new Error(`labkit: неизвестный readout "${node.id}"`);
        }
        const wrap = doc.createElement("div");
        wrap.className = `labkit-readout labkit-readout--${node.variant ?? "stat"}`;
        if (node.label) {
          const label = doc.createElement("div");
          label.className = "labkit-readout-label";
          label.textContent = node.label;
          wrap.append(label);
        }
        const text = doc.createElement("div");
        text.className = "labkit-readout-text";
        wrap.append(text);
        readouts.push({ el: text, derive });
        parent.append(wrap);
        break;
      }
      case "note": {
        const wrap = doc.createElement("div");
        wrap.className = "labkit-note";
        if (node.title) {
          const title = doc.createElement("b");
          title.textContent = node.title;
          wrap.append(title);
        }
        if (node.html !== undefined) {
          // html допустим только для доверенных локальных определений (не ввод).
          const body = doc.createElement("div");
          body.innerHTML = node.html;
          wrap.append(body);
        } else if (node.text !== undefined) {
          const body = doc.createElement("div");
          body.textContent = node.text;
          wrap.append(body);
        }
        parent.append(wrap);
        break;
      }
    }
  }

  function render(): void {
    for (const { view, surface } of panels) {
      view.render({
        state,
        ctx: surface.ctx,
        width: surface.cssWidth,
        height: surface.cssHeight,
      });
    }
    for (const readout of readouts) {
      const text = readout.derive(state);
      if (readout.el.textContent !== text) {
        readout.el.textContent = text;
      }
    }
    for (const button of actionButtons) {
      const label = actions.label(button.id);
      if (button.el.textContent !== label) {
        button.el.textContent = label;
      }
      button.el.disabled = !actions.isAvailable(button.id);
    }
    // className-обёртка — часть layout-ячейки контрола, поэтому её hidden
    // пересчитывается и на явном render()/requestRender без registry-события.
    for (const wrapper of controlWrappers) {
      try {
        wrapper.el.hidden = !params.isVisible(wrapper.param);
      } catch (error) {
        reportError("control", error);
      }
    }
    // Контролы синхронизируются с каноническим состоянием на КАЖДОЙ отрисовке,
    // а не только по событию реестра: действие/preset может заменить источник
    // (напр. выбор точки), не вызывая registry.set (зеркальная запись и
    // синтетические события запрещены). Ошибка одного контрола не мешает
    // остальным и уходит в штатный канал ошибок контролов.
    for (const handle of controls) {
      try {
        handle.update();
      } catch (error) {
        reportError("control", error);
      }
    }
  }

  function resize(): void {
    for (const { surface } of panels) {
      surface.resize();
    }
  }

  return { buildNodes, render, resize };
}

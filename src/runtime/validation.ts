import { CONTRACT_VERSION, type LabDefinition } from "./definition.ts";

/**
 * Структурная валидация LabDefinition ДО создания состояния и ресурсов.
 * Отсутствующие/старые поля не угадываются — это явная ошибка с понятным
 * статусом (дополнение 1). Присутствующие опциональные поля проверяются на
 * корректность (а не молча игнорируются). Контракт остаётся черновиком.
 */
export class LabDefinitionError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`labkit: неверное описание лаборатории:\n- ${issues.join("\n- ")}`);
    this.name = "LabDefinitionError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_CAPABILITIES = new Set(["canvas", "audioContext", "audioWorklet", "worker", "midi"]);
const READOUT_VARIANTS = new Set(["eq", "stat", "small"]);

function checkOptionalFunction(issues: string[], value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "function") {
    issues.push(`${path}: функция`);
  }
}

function checkOptionalString(issues: string[], value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "string") {
    issues.push(`${path}: строка`);
  }
}

export function validateDefinitionStructure<S>(definition: LabDefinition<S>): void {
  const issues: string[] = [];
  if (!isRecord(definition)) {
    throw new LabDefinitionError(["definition: объект обязателен"]);
  }
  const def = definition as unknown as Record<string, unknown>;

  if (def.contractVersion !== CONTRACT_VERSION) {
    issues.push(
      `contractVersion: ожидается "${CONTRACT_VERSION}", получено ${JSON.stringify(def.contractVersion)}`,
    );
  }
  if (typeof def.id !== "string" || def.id.length === 0) {
    issues.push("id: непустая строка обязательна");
  }
  if (typeof def.title !== "string" || def.title.length === 0) {
    issues.push("title: непустая строка обязательна");
  }
  checkOptionalString(issues, def.subtitle, "subtitle");

  const model = def.model;
  if (!isRecord(model) || typeof model.createState !== "function") {
    issues.push("model.createState: функция обязательна");
  }

  if (def.capabilities !== undefined) {
    if (!isRecord(def.capabilities)) {
      issues.push("capabilities: объект");
    } else {
      for (const key of ["required", "optional"] as const) {
        const list = def.capabilities[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          issues.push(`capabilities.${key}: массив`);
          continue;
        }
        list.forEach((id, index) => {
          if (typeof id !== "string" || !KNOWN_CAPABILITIES.has(id)) {
            issues.push(`capabilities.${key}[${index}]: неизвестная возможность "${String(id)}"`);
          }
        });
      }
    }
  }

  if (def.hooks !== undefined) {
    if (!isRecord(def.hooks)) {
      issues.push("hooks: объект");
    } else {
      checkOptionalFunction(issues, def.hooks.setup, "hooks.setup");
      checkOptionalFunction(issues, def.hooks.onChange, "hooks.onChange");
      if (def.hooks.animation !== undefined) {
        if (!isRecord(def.hooks.animation)) {
          issues.push("hooks.animation: объект");
        } else if (typeof def.hooks.animation.step !== "function") {
          // animation присутствует → step обязателен (не «опциональное поле»).
          issues.push("hooks.animation.step: функция обязательна");
        }
      }
    }
  }

  const parameters = isRecord(def.parameters) ? def.parameters : undefined;
  if (!parameters) {
    issues.push("parameters: объект обязателен");
  }
  const paramIds = new Set<string>();
  if (parameters) {
    for (const [key, value] of Object.entries(parameters)) {
      if (!isRecord(value)) {
        issues.push(`parameters.${key}: спецификация обязательна`);
        continue;
      }
      const spec = value as Record<string, unknown>;
      if (spec.id !== key) {
        issues.push(`parameters.${key}.id: должен совпадать с ключом "${key}"`);
      }
      if (typeof spec.label !== "string" || spec.label.length === 0) {
        issues.push(`parameters.${key}.label: непустая строка`);
      }
      if (typeof spec.read !== "function") {
        issues.push(`parameters.${key}.read: функция`);
      }
      if (typeof spec.write !== "function") {
        issues.push(`parameters.${key}.write: функция`);
      }
      checkOptionalString(issues, spec.group, `parameters.${key}.group`);
      checkOptionalString(issues, spec.description, `parameters.${key}.description`);
      checkOptionalFunction(issues, spec.available, `parameters.${key}.available`);
      checkOptionalFunction(issues, spec.visible, `parameters.${key}.visible`);
      if (typeof spec.id === "string") {
        paramIds.add(spec.id);
      }
      switch (spec.kind) {
        case "number":
          if (typeof spec.min !== "number" || !Number.isFinite(spec.min)) {
            issues.push(`parameters.${key}.min: конечное число`);
          }
          if (typeof spec.max !== "number" || !Number.isFinite(spec.max)) {
            issues.push(`parameters.${key}.max: конечное число`);
          }
          if (
            typeof spec.min === "number" &&
            typeof spec.max === "number" &&
            !(spec.min <= spec.max)
          ) {
            issues.push(`parameters.${key}: min больше max`);
          }
          if (
            spec.step !== "any" &&
            (typeof spec.step !== "number" || !Number.isFinite(spec.step) || spec.step <= 0)
          ) {
            issues.push(`parameters.${key}.step: положительное число или "any"`);
          }
          checkOptionalString(issues, spec.unit, `parameters.${key}.unit`);
          checkOptionalFunction(issues, spec.format, `parameters.${key}.format`);
          break;
        case "boolean":
          break;
        case "enum":
          if (typeof spec.options === "function") {
            break;
          }
          if (!Array.isArray(spec.options)) {
            issues.push(`parameters.${key}.options: массив или функция`);
            break;
          }
          spec.options.forEach((option, index) => {
            if (
              !isRecord(option) ||
              typeof option.value !== "string" ||
              typeof option.label !== "string"
            ) {
              issues.push(`parameters.${key}.options[${index}]: { value: string, label: string }`);
            }
          });
          break;
        default:
          issues.push(`parameters.${key}.kind: ожидается number | boolean | enum`);
      }
    }
  }

  if (def.actions !== undefined && !isRecord(def.actions)) {
    issues.push("actions: объект");
  }
  const actions = isRecord(def.actions) ? def.actions : {};
  const actionIds = new Set<string>();
  for (const [key, value] of Object.entries(actions)) {
    if (!isRecord(value)) {
      issues.push(`actions.${key}: спецификация обязательна`);
      continue;
    }
    const spec = value as Record<string, unknown>;
    if (spec.id !== key) {
      issues.push(`actions.${key}.id: должен совпадать с ключом "${key}"`);
    }
    if (typeof spec.run !== "function") {
      issues.push(`actions.${key}.run: функция`);
    }
    if (!(typeof spec.label === "string" || typeof spec.label === "function")) {
      issues.push(`actions.${key}.label: строка или функция`);
    }
    checkOptionalString(issues, spec.description, `actions.${key}.description`);
    checkOptionalFunction(issues, spec.available, `actions.${key}.available`);
    if (typeof spec.id === "string") {
      actionIds.add(spec.id);
    }
  }

  if (def.views !== undefined && !isRecord(def.views)) {
    issues.push("views: объект");
  }
  const views = isRecord(def.views) ? def.views : {};
  const viewIds = new Set(Object.keys(views));
  for (const [key, value] of Object.entries(views)) {
    if (!isRecord(value) || typeof (value as { render?: unknown }).render !== "function") {
      issues.push(`views.${key}.render: функция`);
    }
  }

  if (def.readouts !== undefined && !isRecord(def.readouts)) {
    issues.push("readouts: объект");
  }
  const readouts = isRecord(def.readouts) ? def.readouts : {};
  const readoutIds = new Set(Object.keys(readouts));
  for (const [key, value] of Object.entries(readouts)) {
    if (typeof value !== "function") {
      issues.push(`readouts.${key}: функция`);
    }
  }

  const layout = isRecord(def.layout) ? def.layout : undefined;
  if (!layout || !Array.isArray(layout.controls) || !Array.isArray(layout.workspace)) {
    issues.push("layout: { controls: LayoutNode[], workspace: LayoutNode[] }");
  } else {
    if (layout.variant !== undefined && layout.variant !== "instrument") {
      issues.push("layout.variant: instrument");
    }
    if (layout.toolbar !== undefined && !Array.isArray(layout.toolbar)) {
      issues.push("layout.toolbar: массив");
    }
    if (layout.header !== undefined && !Array.isArray(layout.header))
      issues.push("layout.header: массив");
    const walk = (nodes: unknown[], path: string): void => {
      nodes.forEach((node, index) => {
        const at = `${path}[${index}]`;
        if (!isRecord(node)) {
          issues.push(`${at}: узел layout`);
          return;
        }
        checkOptionalString(issues, node.className, `${at}.className`);
        switch (node.kind) {
          case "window":
            if (typeof node.title !== "string" || !node.title.trim())
              issues.push(`${at}.title: непустая строка`);
            if (!Array.isArray(node.children)) issues.push(`${at}.children: массив`);
            else walk(node.children, `${at}.children`);
            break;
          case "group":
          case "row":
            checkOptionalString(issues, node.title, `${at}.title`);
            if (node.kind === "group") {
              for (const key of ["collapsible", "collapsed"] as const) {
                if (node[key] !== undefined && typeof node[key] !== "boolean") {
                  issues.push(`${at}.${key}: boolean`);
                }
              }
              if (
                node.collapsible === true &&
                (typeof node.title !== "string" || !node.title.trim())
              ) {
                issues.push(`${at}.title: непустая строка для collapsible`);
              }
              if (node.collapsed !== undefined && node.collapsible !== true) {
                issues.push(`${at}.collapsed: требуется collapsible: true`);
              }
            } else {
              if (
                node.columns !== undefined &&
                node.columns !== "auto-fit" &&
                !(
                  typeof node.columns === "number" &&
                  Number.isInteger(node.columns) &&
                  node.columns >= 1 &&
                  node.columns <= 12
                )
              ) {
                issues.push(`${at}.columns: целое число 1–12 или auto-fit`);
              }
              if (
                node.density !== undefined &&
                node.density !== "normal" &&
                node.density !== "compact"
              ) {
                issues.push(`${at}.density: normal | compact`);
              }
            }
            if (!Array.isArray(node.children)) {
              issues.push(`${at}.children: массив`);
            } else {
              walk(node.children, `${at}.children`);
            }
            break;
          case "control":
            checkOptionalString(issues, node.displayLabel, `${at}.displayLabel`);
            if (node.presentation !== undefined) {
              const spec = parameters?.[String(node.param)] as Record<string, unknown> | undefined;
              if (
                !(
                  (node.presentation === "pad" && spec?.kind === "boolean") ||
                  (node.presentation === "segmented" && spec?.kind === "enum")
                )
              )
                issues.push(`${at}.presentation: pad для boolean, segmented для enum`);
            }
            if (typeof node.param !== "string" || !paramIds.has(node.param)) {
              issues.push(`${at}.param: неизвестный параметр "${String(node.param)}"`);
            }
            break;
          case "action":
            if (typeof node.action !== "string" || !actionIds.has(node.action)) {
              issues.push(`${at}.action: неизвестное действие "${String(node.action)}"`);
            }
            break;
          case "panel":
            if (typeof node.view !== "string" || !viewIds.has(node.view)) {
              issues.push(`${at}.view: неизвестный view "${String(node.view)}"`);
            }
            checkOptionalString(issues, node.title, `${at}.title`);
            if (node.aspect !== undefined) {
              if (
                typeof node.aspect !== "number" ||
                !Number.isFinite(node.aspect) ||
                node.aspect <= 0
              ) {
                issues.push(`${at}.aspect: положительное число`);
              }
            }
            break;
          case "readout":
            if (typeof node.id !== "string" || !readoutIds.has(node.id)) {
              issues.push(`${at}.id: неизвестный readout "${String(node.id)}"`);
            }
            checkOptionalString(issues, node.label, `${at}.label`);
            if (node.variant !== undefined && !READOUT_VARIANTS.has(String(node.variant))) {
              issues.push(`${at}.variant: eq | stat | small`);
            }
            break;
          case "note":
            checkOptionalString(issues, node.title, `${at}.title`);
            checkOptionalString(issues, node.text, `${at}.text`);
            checkOptionalString(issues, node.html, `${at}.html`);
            break;
          default:
            issues.push(`${at}.kind: неизвестный узел layout "${String(node.kind)}"`);
        }
      });
    };
    walk(layout.controls, "layout.controls");
    walk(layout.workspace, "layout.workspace");
    if (Array.isArray(layout.toolbar)) walk(layout.toolbar, "layout.toolbar");
    if (Array.isArray(layout.header)) walk(layout.header, "layout.header");
  }

  if (issues.length > 0) {
    throw new LabDefinitionError(issues);
  }
}

/**
 * Проверка начальных значений экземпляра по каноническому состоянию: тип,
 * конечность и (для number) попадание в диапазон; для enum — членство в options.
 */
export function validateInitialState<S>(definition: LabDefinition<S>, state: S): void {
  const issues: string[] = [];
  for (const [key, spec] of Object.entries(definition.parameters)) {
    try {
      switch (spec.kind) {
        case "number": {
          const value = spec.read(state);
          if (typeof value !== "number" || !Number.isFinite(value)) {
            issues.push(
              `parameters.${key}: начальное значение не конечное число (${String(value)})`,
            );
          } else if (value < spec.min || value > spec.max) {
            issues.push(
              `parameters.${key}: начальное значение ${value} вне [${spec.min}, ${spec.max}]`,
            );
          }
          break;
        }
        case "boolean": {
          const value = spec.read(state);
          if (typeof value !== "boolean") {
            issues.push(`parameters.${key}: начальное значение не boolean (${String(value)})`);
          }
          break;
        }
        case "enum": {
          const value = spec.read(state);
          const options = typeof spec.options === "function" ? spec.options(state) : spec.options;
          if (typeof value !== "string" || !options.some((o) => o.value === value)) {
            issues.push(`parameters.${key}: начальное значение "${String(value)}" не из options`);
          }
          break;
        }
      }
    } catch (error) {
      issues.push(`parameters.${key}: ошибка чтения начального значения — ${String(error)}`);
    }
  }
  if (issues.length > 0) {
    throw new LabDefinitionError(issues);
  }
}

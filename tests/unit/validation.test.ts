import { describe, expect, it } from "vitest";
import type { LabDefinition } from "../../src/runtime/definition.ts";
import {
  LabDefinitionError,
  validateDefinitionStructure,
  validateInitialState,
} from "../../src/runtime/validation.ts";

interface Demo {
  n: number;
}

function valid(): LabDefinition<Demo> {
  return {
    contractVersion: "0.1",
    id: "demo",
    title: "Demo",
    model: { createState: () => ({ n: 1 }) },
    parameters: {
      n: {
        kind: "number",
        id: "n",
        label: "N",
        min: 0,
        max: 10,
        step: 1,
        read: (state) => state.n,
        write: (state, value) => {
          state.n = value;
        },
      },
    },
    actions: { ping: { id: "ping", label: "Ping", run: () => {} } },
    readouts: { value: (state) => `n=${state.n}` },
    views: { plot: { render: () => {} } },
    layout: {
      controls: [
        { kind: "control", param: "n" },
        { kind: "action", action: "ping" },
      ],
      workspace: [
        { kind: "panel", view: "plot" },
        { kind: "readout", id: "value" },
      ],
    },
  };
}

function expectIssues(definition: unknown, pattern: RegExp): void {
  let thrown: unknown;
  try {
    validateDefinitionStructure(definition as LabDefinition<Demo>);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LabDefinitionError);
  expect((thrown as LabDefinitionError).issues.join("\n")).toMatch(pattern);
}

describe("validateDefinitionStructure", () => {
  it("принимает instrument, toolbar, compact auto-fit и раскрываемые группы", () => {
    const def = valid();
    def.layout.variant = "instrument";
    def.layout.header = [
      { kind: "window", title: "About", children: [{ kind: "note", text: "Info" }] },
    ];
    def.layout.toolbar = [
      { kind: "row", columns: 3, children: [{ kind: "action", action: "ping" }] },
    ];
    def.layout.controls = [
      {
        kind: "group",
        title: "Advanced",
        collapsible: true,
        collapsed: true,
        children: [
          {
            kind: "row",
            columns: "auto-fit",
            density: "compact",
            children: [{ kind: "control", param: "n" }],
          },
        ],
      },
    ];
    expect(() => validateDefinitionStructure(def)).not.toThrow();
  });

  it.each([
    [{ variant: "unknown" }, /layout.variant/],
    [{ toolbar: {} }, /layout.toolbar/],
    [{ header: {} }, /layout.header/],
    [{ header: [{ kind: "action", action: "missing" }] }, /layout.header\[0\].action/],
    [{ toolbar: [{ kind: "action", action: "missing" }] }, /layout.toolbar\[0\].action/],
    ...[0, 13, 2.5, Infinity, "3", null].map((columns): [object, RegExp] => [
      { controls: [{ kind: "row", columns, children: [] }] },
      /columns/,
    ]),
    [{ controls: [{ kind: "row", density: "dense", children: [] }] }, /density/],
    [{ controls: [{ kind: "group", collapsible: "yes", children: [] }] }, /collapsible/],
    [{ controls: [{ kind: "group", collapsible: true, title: " ", children: [] }] }, /title/],
    [{ controls: [{ kind: "group", collapsed: false, children: [] }] }, /collapsed/],
    [
      { controls: [{ kind: "group", collapsible: true, title: "A", collapsed: 1, children: [] }] },
      /collapsed/,
    ],
  ])("отвергает неверные layout options: %j", (override, pattern) => {
    const def = valid();
    expectIssues({ ...def, layout: { ...def.layout, ...(override as object) } }, pattern as RegExp);
  });

  it("принимает валидное описание и валидное начальное состояние", () => {
    const def = valid();
    expect(() => validateDefinitionStructure(def)).not.toThrow();
    expect(() => validateInitialState(def, def.model.createState())).not.toThrow();
  });

  it("требует contractVersion (не угадывает старый формат)", () => {
    const def = { ...valid() } as Record<string, unknown>;
    delete def.contractVersion;
    expectIssues(def, /contractVersion/);
  });

  it("отвергает неподдерживаемую версию", () => {
    expectIssues({ ...valid(), contractVersion: "2.0" }, /contractVersion/);
  });

  it("требует id, title и model.createState", () => {
    expectIssues({ ...valid(), id: "" }, /id/);
    expectIssues({ ...valid(), title: "" }, /title/);
    expectIssues({ ...valid(), model: {} }, /model\.createState/);
  });

  it("id параметра должен совпадать с ключом", () => {
    const def = valid();
    expectIssues(
      { ...def, parameters: { n: { ...def.parameters.n, id: "other" } } },
      /parameters\.n\.id/,
    );
  });

  it('числовой step: положительный или "any"', () => {
    const def = valid();
    const numberSpec = {
      kind: "number" as const,
      id: "n",
      label: "N",
      min: 0,
      max: 10,
      step: 1,
      read: (state: Demo) => state.n,
      write: (state: Demo, value: number) => {
        state.n = value;
      },
    };
    expectIssues({ ...def, parameters: { n: { ...numberSpec, step: 0 } } }, /step/);
    expectIssues({ ...def, parameters: { n: { ...numberSpec, step: -1 } } }, /step/);
    expect(() =>
      validateDefinitionStructure({ ...def, parameters: { n: { ...numberSpec, step: "any" } } }),
    ).not.toThrow();
  });

  it("min больше max — ошибка", () => {
    const def = valid();
    expectIssues(
      { ...def, parameters: { n: { ...def.parameters.n, min: 5, max: 1 } } },
      /min больше max/,
    );
  });

  it("enum требует options", () => {
    const def = valid();
    expectIssues(
      {
        ...def,
        parameters: {
          n: {
            kind: "enum",
            id: "n",
            label: "N",
            read: (s: Demo) => String(s.n),
            write: (s: Demo) => {
              void s;
            },
          },
        },
      },
      /options/,
    );
  });

  it("layout: неизвестные ссылки на control/action/view/readout", () => {
    const def = valid();
    expectIssues(
      { ...def, layout: { ...def.layout, controls: [{ kind: "control", param: "ghost" }] } },
      /неизвестный параметр/,
    );
    expectIssues(
      { ...def, layout: { ...def.layout, controls: [{ kind: "action", action: "ghost" }] } },
      /неизвестное действие/,
    );
    expectIssues(
      { ...def, layout: { ...def.layout, workspace: [{ kind: "panel", view: "ghost" }] } },
      /неизвестный view/,
    );
    expectIssues(
      { ...def, layout: { ...def.layout, workspace: [{ kind: "readout", id: "ghost" }] } },
      /неизвестный readout/,
    );
  });
});

describe("validateInitialState", () => {
  it("отвергает число вне диапазона", () => {
    const def = valid();
    expect(() => validateInitialState(def, { n: 99 })).toThrow(LabDefinitionError);
  });

  it("отвергает неверный тип начального значения", () => {
    const def = valid();
    expect(() => validateInitialState(def, { n: "x" } as unknown as Demo)).toThrow(
      /не конечное число/,
    );
  });

  it("enum: начальное значение должно быть из options", () => {
    const enumDef: LabDefinition<{ mode: string }> = {
      contractVersion: "0.1",
      id: "demo-enum",
      title: "Demo enum",
      model: { createState: () => ({ mode: "a" }) },
      parameters: {
        mode: {
          kind: "enum",
          id: "mode",
          label: "Mode",
          options: [{ value: "a", label: "A" }],
          read: (s) => s.mode,
          write: (s, v) => {
            s.mode = v;
          },
        },
      },
      readouts: { value: () => "" },
      views: {},
      layout: { controls: [], workspace: [{ kind: "readout", id: "value" }] },
    };
    expect(() => validateInitialState(enumDef, { mode: "a" })).not.toThrow();
    expect(() => validateInitialState(enumDef, { mode: "z" })).toThrow(/не из options/);
  });
});

describe("validateDefinitionStructure: presentation контролов", () => {
  function presentationDefinition(): LabDefinition<Demo> {
    const def = valid();
    return {
      ...def,
      parameters: {
        ...def.parameters,
        flag: {
          kind: "boolean",
          id: "flag",
          label: "Flag",
          read: (state) => state.n > 0,
          write: (state, value) => {
            state.n = value ? 1 : 0;
          },
        },
        mode: {
          kind: "enum",
          id: "mode",
          label: "Mode",
          options: [{ value: "a", label: "A" }],
          read: () => "a",
          write: () => {},
        },
      },
    };
  }

  function withControl(node: unknown): LabDefinition<Demo> {
    return {
      ...presentationDefinition(),
      layout: { controls: [node], workspace: [] },
    } as unknown as LabDefinition<Demo>;
  }

  it("pad допустим только для boolean", () => {
    expect(() =>
      validateDefinitionStructure(
        withControl({ kind: "control", param: "flag", presentation: "pad" }),
      ),
    ).not.toThrow();
    expectIssues(
      withControl({ kind: "control", param: "mode", presentation: "pad" }),
      /presentation/,
    );
    expectIssues(withControl({ kind: "control", param: "n", presentation: "pad" }), /presentation/);
  });

  it("segmented допустим только для enum", () => {
    expect(() =>
      validateDefinitionStructure(
        withControl({ kind: "control", param: "mode", presentation: "segmented" }),
      ),
    ).not.toThrow();
    expectIssues(
      withControl({ kind: "control", param: "flag", presentation: "segmented" }),
      /presentation/,
    );
    expectIssues(
      withControl({ kind: "control", param: "n", presentation: "segmented" }),
      /presentation/,
    );
  });

  it("неизвестная presentation и нестроковый displayLabel отклоняются", () => {
    expectIssues(
      withControl({ kind: "control", param: "flag", presentation: "wheel" }),
      /presentation/,
    );
    expectIssues(
      withControl({ kind: "control", param: "flag", presentation: "pad", displayLabel: 42 }),
      /displayLabel/,
    );
  });

  it("валидные сочетания с displayLabel принимаются", () => {
    expect(() =>
      validateDefinitionStructure(
        withControl({
          kind: "control",
          param: "flag",
          presentation: "pad",
          displayLabel: "1",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateDefinitionStructure(
        withControl({
          kind: "control",
          param: "mode",
          presentation: "segmented",
          displayLabel: "M",
        }),
      ),
    ).not.toThrow();
  });
});

describe("validateDefinitionStructure: опциональные поля проверяются, а не игнорируются", () => {
  it("hooks.onChange / animation.step / hooks-объект", () => {
    expectIssues({ ...valid(), hooks: { onChange: 42 } }, /hooks\.onChange/);
    expectIssues({ ...valid(), hooks: { animation: { step: 42 } } }, /hooks\.animation\.step/);
    expectIssues({ ...valid(), hooks: { animation: {} } }, /hooks\.animation\.step/);
    expectIssues({ ...valid(), hooks: { animation: null } }, /hooks\.animation/);
    expectIssues({ ...valid(), hooks: { animation: 42 } }, /hooks\.animation/);
    expectIssues({ ...valid(), hooks: 42 }, /hooks/);
  });

  it("hooks.setup: только функция (не любой мусор)", () => {
    expectIssues({ ...valid(), hooks: { setup: 42 } }, /hooks\.setup/);
    expect(() =>
      validateDefinitionStructure({ ...valid(), hooks: { setup: () => {} } }),
    ).not.toThrow();
  });

  it("capabilities: только известные id, поля — массивы", () => {
    expectIssues(
      { ...valid(), capabilities: { required: ["canvas", "nope"] } },
      /capabilities\.required\[1\]/,
    );
    expectIssues({ ...valid(), capabilities: { optional: "canvas" } }, /capabilities\.optional/);
    expectIssues({ ...valid(), capabilities: 42 }, /capabilities/);
    expect(() =>
      validateDefinitionStructure({
        ...valid(),
        capabilities: { required: ["canvas", "worker"], optional: ["midi", "audioContext"] },
      }),
    ).not.toThrow();
    expect(() =>
      validateDefinitionStructure({ ...valid(), capabilities: { required: ["audioContext"] } }),
    ).not.toThrow();
  });

  it("parameters: available/visible/format/description и элементы enum options", () => {
    const def = valid();
    const n = def.parameters.n as unknown as Record<string, unknown>;
    expectIssues(
      { ...def, parameters: { n: { ...n, available: 42 } } },
      /parameters\.n\.available/,
    );
    expectIssues({ ...def, parameters: { n: { ...n, visible: 42 } } }, /parameters\.n\.visible/);
    expectIssues({ ...def, parameters: { n: { ...n, format: 42 } } }, /parameters\.n\.format/);
    expectIssues(
      { ...def, parameters: { n: { ...n, description: 42 } } },
      /parameters\.n\.description/,
    );
    const enumSpec = {
      kind: "enum",
      id: "n",
      label: "N",
      options: [{ value: "a" }],
      read: (s: Demo) => String(s.n),
      write: () => {},
    };
    expectIssues({ ...def, parameters: { n: enumSpec } }, /parameters\.n\.options\[0\]/);
  });

  it("actions: объект и опциональные поля", () => {
    expectIssues({ ...valid(), actions: 42 }, /actions: объект/);
    expectIssues({ ...valid(), actions: [] }, /actions: объект/);
    const def = valid();
    const ping = def.actions?.ping as unknown as Record<string, unknown>;
    expectIssues(
      { ...def, actions: { ping: { ...ping, available: 42 } } },
      /actions\.ping\.available/,
    );
    expectIssues(
      { ...def, actions: { ping: { ...ping, description: 42 } } },
      /actions\.ping\.description/,
    );
  });

  it("views/readouts должны быть объектами", () => {
    expectIssues({ ...valid(), views: [] }, /views: объект/);
    expectIssues({ ...valid(), readouts: [] }, /readouts: объект/);
  });

  it("layout: поля узлов", () => {
    const def = valid();
    expectIssues(
      { ...def, layout: { controls: [{ kind: "group", title: 42, children: [] }], workspace: [] } },
      /layout\.controls\[0\]\.title/,
    );
    expectIssues(
      {
        ...def,
        layout: { controls: [], workspace: [{ kind: "panel", view: "plot", aspect: "x" }] },
      },
      /aspect/,
    );
    expectIssues(
      {
        ...def,
        layout: { controls: [], workspace: [{ kind: "readout", id: "value", variant: "huge" }] },
      },
      /variant/,
    );
    expectIssues(
      { ...def, layout: { controls: [], workspace: [{ kind: "note", text: 42 }] } },
      /\.text/,
    );
  });

  it("subtitle", () => {
    expectIssues({ ...valid(), subtitle: 42 }, /subtitle/);
  });
});

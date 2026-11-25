import "../../../src/ui/labkit.css";
import {
  createLab,
  type LabDefinition,
  type LayoutNode,
  type ParameterSpec,
} from "../../../src/index.ts";

type State = { values: number[]; playing: boolean };
const parameters: Record<string, ParameterSpec<State>> = Object.fromEntries(
  Array.from({ length: 9 }, (_, i) => [
    `p${i}`,
    {
      kind: "number",
      id: `p${i}`,
      label: `Parameter ${i + 1}`,
      min: 0,
      max: 10,
      step: 1,
      read: (state: State) => state.values[i]!,
      write: (state: State, value: number) => {
        state.values[i] = value;
      },
    },
  ]),
);
const definition: LabDefinition<State> = {
  contractVersion: "0.1",
  id: "sdk-layout",
  title: "Instrument foundation",
  subtitle: "Transport · compact grids · native disclosure · light / graphite",
  model: { createState: () => ({ values: Array(9).fill(5), playing: false }) },
  parameters,
  actions: {
    play: {
      id: "play",
      label: (s) => (s.playing ? "Pause" : "Play"),
      run: (ctx) => {
        ctx.state.playing = !ctx.state.playing;
        ctx.requestRender();
      },
    },
    reset: {
      id: "reset",
      label: "Reset",
      run: (ctx) => {
        for (const id of Object.keys(parameters)) ctx.params.set(id, 5, ctx.origin);
      },
    },
    unavailable: { id: "unavailable", label: "Unavailable", available: () => false, run: () => {} },
  },
  hooks: { onChange: (ctx) => ctx.requestRender() },
  readouts: { transport: (state) => (state.playing ? "Running" : "Ready") },
  views: {
    plot: {
      render: ({ ctx, width, height }) => {
        ctx.fillStyle = "#386a90";
        ctx.fillRect(0, 0, width, height);
      },
    },
  },
  layout: {
    variant: "instrument",
    header: [
      {
        kind: "window",
        title: "О лаборатории",
        children: [
          {
            kind: "group",
            title: "Настройки",
            className: "layout-section layout-section--settings",
            children: [
              { kind: "note", text: "Раздел с общим контролом и прокручиваемым текстом." },
              { kind: "control", param: "p0" },
              {
                kind: "note",
                html: Array.from(
                  { length: 12 },
                  (_, i) =>
                    `<p>Справка: строка ${i + 1}. Проверка навигации и сохранения прокрутки.</p>`,
                ).join(""),
              },
              {
                kind: "group",
                title: "Вложенная группа",
                children: [{ kind: "note", text: "Не должна попадать в навигацию окна." }],
              },
              {
                kind: "group",
                children: [
                  { kind: "note", text: "Группа без заголовка не даёт пункта навигации." },
                ],
              },
            ],
          },
          {
            kind: "group",
            title: "Прямая секция",
            children: [
              { kind: "note", text: "Секция без className: проверка эквивалентности навигации." },
              {
                kind: "note",
                html: Array.from(
                  { length: 8 },
                  (_, i) =>
                    `<p>Прямая: строка ${i + 1}. Секция достаточно высокая для прокрутки.</p>`,
                ).join(""),
              },
            ],
          },
          {
            kind: "group",
            title: "График",
            className: "layout-section layout-section--plot",
            children: [
              { kind: "note", text: "Раздел с canvas; он скрыт вместе с окном." },
              { kind: "panel", view: "plot", aspect: 2 },
              {
                kind: "note",
                html: Array.from(
                  { length: 12 },
                  (_, i) =>
                    `<p>График: пояснение ${i + 1}. Секция достаточно высокая для прокрутки.</p>`,
                ).join(""),
              },
            ],
          },
          { kind: "group", children: [{ kind: "note", text: "Прямая группа без заголовка." }] },
        ],
      },
    ],
    toolbar: [
      {
        kind: "row",
        columns: 3,
        density: "compact",
        children: ["play", "reset", "unavailable"].map((action) => ({ kind: "action", action })),
      },
      { kind: "readout", id: "transport", variant: "small" },
    ],
    controls: [
      {
        kind: "group",
        title: "Nine parameters",
        children: [
          {
            kind: "row",
            columns: "auto-fit",
            density: "compact",
            children: Object.keys(parameters).map(
              (param): LayoutNode => ({ kind: "control", param }),
            ),
          },
        ],
      },
      {
        kind: "group",
        title: "Advanced",
        collapsible: true,
        collapsed: true,
        children: [
          { kind: "note", text: "Built once, including accessory slots." },
          { kind: "action", action: "reset" },
        ],
      },
    ],
    workspace: [
      {
        kind: "group",
        title: "Scope",
        collapsible: true,
        collapsed: true,
        children: [{ kind: "panel", view: "plot", aspect: 2 }],
      },
      ...Array.from(
        { length: 12 },
        (_, i): LayoutNode => ({
          kind: "group",
          title: `Section ${i + 1}`,
          children: [{ kind: "control", param: `p${i % 9}` }],
        }),
      ),
      {
        kind: "group",
        title: "Nested rows",
        children: [
          {
            kind: "row",
            columns: 3,
            children: [
              {
                kind: "row",
                children: [
                  { kind: "note", text: "Inner A" },
                  { kind: "note", text: "Inner B" },
                ],
              },
              { kind: "note", text: "Outer B" },
              { kind: "note", text: "Outer C" },
            ],
          },
        ],
      },
    ],
  },
};
createLab(definition, document.getElementById("app")!);
